#!/usr/bin/env bash
# The closing run: one command that takes a commit, builds it, runs every server row of
# docs/TARGETS.md against it and writes lanes/targets/close-<hash>.md.
#
#   scripts/bench/close.sh <hash> [--machine dev-4|bench-ru] [--cores 4|8] [--path collab|legacy] [--quick] [--only M,D,S,A,K] [--dry-run]
#
# --machine dev-4 (the local stand-in, works today): the commit is exported with `git archive` into a scratch directory, its
#   server runs in the 4-CPU dev-4 container (scripts/bench/lib/server.ts) on the lane's PostgreSQL test cluster
#   (BENCH_PG_STATE, default ~/.cache/morfa-pg/B0; started here when it is down), loadgen runs on this machine.
# --machine bench-ru (the closing machine, TARGETS §0; lane B5 provisioned it, scripts/deploy/provision-bench.sh): the commit
#   and this checkout's committed harness (HEAD) go to the VM with `git archive`, are built there, and
#   scripts/deploy/remote/bench-close.sh runs every server row with loadgen on the ru-net VM. --cores 4 (default) pins the
#   whole Morfa stack to cores 0-3 (TARGETS' 4 vCPU shape) and writes lanes/targets/close-<hash>.md; --cores 8 uses every core
#   (headroom for an 8 vCPU production box) and writes close-<hash>.cores8.md. Hosts: scripts/deploy/bench-hosts.env
#   (BENCH_RU_HOST, BENCH_RU_NET). --dry-run prints the plan and writes close-<hash>.dry-run.md with every row n.a.
#   --path collab (default): the M/D/S/K rows on the Rust collab service (scripts/bench/collab-path.ts); --path legacy: today's
#   SSE + PATCH path, a separate report close-<hash>[.cores8].legacy.md for comparison.
# The harness (scripts/bench, crates/loadgen) is this checkout's; the system under test is <hash>.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"
export PATH="${HOME}/.nvm/versions/node/v22.23.2/bin:${HOME}/.cargo/bin:${PATH}"

if [ $# -lt 1 ]; then
  sed -n '2,15p' "$0"
  exit 2
fi
ref="$1"
shift
machine="dev-4"
only="M,D,S,A,K,W,X"
extra=()
cores=4
dry=0
measured=collab
while [ $# -gt 0 ]; do
  case "$1" in
    --machine) machine="$2"; shift 2 ;;
    --cores) cores="$2"; shift 2 ;;
    --path) measured="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    --only) only="$2"; shift 2 ;;
    --quick) extra+=("--quick"); shift ;;
    --runs) extra+=("--runs" "$2"); shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
hash="$(git rev-parse --short=9 "${ref}^{commit}")"
out="lanes/targets/close-${hash}.md"
if [ "$machine" = bench-ru ]; then
  name="close-${hash}"
  if [ "$cores" = 8 ]; then name="${name}.cores8"; fi
  if [ "$measured" = legacy ]; then name="${name}.legacy"; fi
  out="lanes/targets/${name}.md"
fi
echo "close.sh: ${hash} on ${machine}; rows ${only}; report ${out}"
echo "close.sh: $(uptime)"

if [ "$machine" = "bench-ru" ]; then
  # shellcheck disable=SC1091
  . scripts/deploy/bench-hosts.env
  host="root@${BENCH_RU_HOST:?scripts/deploy/bench-hosts.env}" net="bench@${BENCH_RU_NET:?}"
  case $cores in 4) suffix="" ;; 8) suffix=".cores8" ;; *) echo "--cores 4|8" >&2; exit 2 ;; esac
  case $measured in collab) ;; legacy) suffix="$suffix.legacy" ;; *) echo "--path collab|legacy" >&2; exit 2 ;; esac
  harness="$(git rev-parse --short=9 HEAD)"
  if ! git diff --quiet HEAD -- scripts/bench scripts/deploy crates/loadgen; then
    echo "close.sh: the harness is this checkout's HEAD ($harness); uncommitted changes in scripts/bench, scripts/deploy or crates/loadgen are NOT used." >&2
  fi
  remote_sut="/srv/morfa/bench/src-${hash}" remote_harness="/srv/morfa/bench/harness-${harness}"
  if [ "$dry" = 1 ]; then
    echo "close.sh (dry run) on bench-ru ${host#root@}, loadgen on ${net#bench@}, profile cores${cores}:"
    echo "  1. git archive ${hash} | ssh ${host} 'tar -x -C ${remote_sut}'; git archive ${harness} (this checkout's HEAD) → ${remote_harness}"
    echo "  2. ssh ${host} 'bash ${remote_harness}/scripts/deploy/remote/bench-close.sh --hash ${hash} --sut ${remote_sut} --harness ${remote_harness} --cores ${cores} --only ${only} --net ${net} --path ${measured}'"
    echo "     (morfa.slice pinned, the systemd stack stopped for the run, the commit and harness built there, loadgen copied to ru-net)"
    echo "  3. scp ${host}:${remote_harness}/lanes/targets/close-${hash}${suffix}.md → lanes/targets/; its history line appended to lanes/targets/history.jsonl"
    npx tsx scripts/bench/targets.ts --machine bench-ru --only "$only" --hash "$hash" --out "lanes/targets/close-${hash}.dry-run.md" ${extra[@]+"${extra[@]}"}
    exit 0
  fi
  SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 "$host")
  ship() { # ship <commit> <remote dir>: once per commit (a second run reuses the tree and its build)
    git archive --format=tar "$1" | "${SSH[@]}" "set -e; if [ ! -f $2/BUILD_COMMIT ]; then rm -rf $2.tmp && install -d -o morfa -g morfa $2.tmp && tar -x -C $2.tmp && echo $1 >$2.tmp/BUILD_COMMIT && chown -R morfa:morfa $2.tmp && mv $2.tmp $2; else cat >/dev/null; fi"
  }
  echo "close.sh: shipping ${hash} (system under test) and ${harness} (harness) to ${host#root@}"
  ship "$hash" "$remote_sut"
  ship "$harness" "$remote_harness"
  args=(--hash "$hash" --sut "$remote_sut" --harness "$remote_harness" --cores "$cores" --only "$only" --net "$net" --path "$measured")
  for flag in ${extra[@]+"${extra[@]}"}; do args+=("$flag"); done
  set +e
  "${SSH[@]}" "bash ${remote_harness}/scripts/deploy/remote/bench-close.sh ${args[*]}"
  status=$?
  set -e
  report="lanes/targets/close-${hash}${suffix}.md"
  if scp -q -o BatchMode=yes "${host}:${remote_harness}/${report}" "$report"; then
    "${SSH[@]}" "tail -n 1 ${remote_harness}/lanes/targets/history.jsonl" >>lanes/targets/history.jsonl
    echo "close.sh: wrote ${report} (bench-ru, cores${cores}); targets.ts exit ${status}"
  else
    echo "close.sh: no report came back (exit ${status})" >&2
    exit 1
  fi
  exit "$status"
fi
if [ "$machine" != "dev-4" ]; then
  echo "--machine dev-4|bench-ru" >&2
  exit 2
fi

# The commit, exported (no worktree bookkeeping), with the shared node_modules for the host-side tools.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/morfa-close-${hash}-XXXX")"
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT
git archive "$hash" | tar -x -C "$scratch"
# The harness is this checkout's: its bench server wraps the commit's server/ (a commit from before B0 has no scripts/bench).
rm -rf "$scratch/scripts/bench"
mkdir -p "$scratch/scripts"
cp -R scripts/bench "$scratch/scripts/bench"
ln -s "$(cd node_modules && pwd -P)" "$scratch/node_modules"
if ! cmp -s package-lock.json "$scratch/package-lock.json"; then
  echo "close.sh: ${hash} has another package-lock.json than this checkout: the dev-4 container installs its own (BENCH_LINUX_MODULES)." >&2
fi

# The lane's own PostgreSQL test cluster (docs/dev.md), started when it is down.
state="${BENCH_PG_STATE:-${HOME}/.cache/morfa-pg/B0}"
port="${BENCH_PG_PORT:-5450}"
if ! npm run --silent db:test-cluster -- status --state-dir "$state" 2>/dev/null | grep -q '"status":"ready"'; then
  mkdir -p "$state" && chmod 700 "$state"
  npm run --silent db:test-cluster -- up --port "$port" --state-dir "$state"
fi

# loadgen from this checkout (the harness), built when missing.
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${HOME}/.cache/morfa-target/B0}" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" \
  cargo build --release -p morfa-loadgen >/dev/null

npx tsx scripts/bench/targets.ts --machine dev-4 --only "$only" --hash "$hash" --source "$scratch" --out "$out" ${extra[@]+"${extra[@]}"}
echo "close.sh: wrote ${out}"
