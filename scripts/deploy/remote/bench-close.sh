#!/usr/bin/env bash
# A closing run on bench-ru, run as root by scripts/bench/close.sh from the Mac.
#
#   bench-close.sh --hash <h> --sut <dir> --harness <dir> --cores 4|8 [--only M,D,S,A,K,W,X] [--runs N] [--quick] [--net bench@<ru-net>]
#
# The profile pins the system under test: morfa.slice (PostgreSQL clusters, Caddy, MinIO) gets AllowedCPUs 0-3 (TARGETS'
# 4 vCPU shape) or 0-7, and every server the harness starts (the bench api, collab nodes) runs under `taskset` on the same
# cores. In the 4-core profile the harness itself and the observability containers stay on cores 4-7; in the 8-core
# profile everything shares the 8 cores (said in the report). The systemd Morfa stack is stopped for the run and started
# again after it, so nothing idle competes. loadgen runs on the ru-net VM (bench@<ru-net>), with its CPU in every row.
set -euo pipefail
hash="" sut="" harness="" cores=4 only="M,D,S,A,K,W,X" runs=1 quick="" net="" collab_ws=1 measured=collab
while [ $# -gt 0 ]; do
  case $1 in
    --hash) hash=$2; shift 2 ;;
    --sut) sut=$2; shift 2 ;;
    --harness) harness=$2; shift 2 ;;
    --cores) cores=$2; shift 2 ;;
    --only) only=$2; shift 2 ;;
    --runs) runs=$2; shift 2 ;;
    --quick) quick=--quick; shift ;;
    --net) net=$2; shift 2 ;;
    --no-collab-ws) collab_ws=0; shift ;;
    --path) measured=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$hash" ] && [ -d "$sut" ] && [ -d "$harness" ] && [ -n "$net" ] || { sed -n '2,12p' "$0"; exit 2; }
case $cores in 4) server_cpus=0-3 harness_cpus=4-7 ;; 8) server_cpus=0-7 harness_cpus=0-7 ;; *) echo "--cores 4|8" >&2; exit 2 ;; esac
profile=cores$cores
suffix=""; [ "$cores" = 8 ] && suffix=.cores8
[ "$measured" = legacy ] && suffix="$suffix.legacy"
say() { printf '[bench-close %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
as_morfa() { sudo -u morfa -H env PATH="/srv/morfa/.cargo/bin:/usr/local/bin:/usr/bin:/bin" CARGO_TARGET_DIR=/srv/morfa/target "$@"; }
# shellcheck disable=SC1091
. /etc/morfa/s3.env 2>/dev/null || S3_KIND=unknown
bench_ip=$(sed -n 's/^MORFA_BENCH_IP=//p' /etc/morfa/caddy.env)
netem_note=$(ssh -o BatchMode=yes -i /srv/morfa/.ssh/id_ed25519 -o UserKnownHostsFile=/srv/morfa/.ssh/known_hosts "$net" 'cat /etc/morfa/netem.env' 2>/dev/null |
  awk -F= '/^BASE_RTT_MS/{b=$2} /^DELAY_MS/{d=$2} /^LOSS/{l=$2} END{printf "base RTT %s ms + netem %s ms = 30 ms RTT, %s loss, on ru-net'"'"'s egress to bench-ru", b, d, l}')

say "profile $profile: morfa.slice AllowedCPUs=$server_cpus, bench servers taskset $server_cpus, harness $harness_cpus"
systemctl set-property --runtime morfa.slice AllowedCPUs="$server_cpus"
stack=$(systemctl list-units --plain --no-legend --state=active 'morfa-api@*' 'morfa-collab@*' morfa-worker.service | awk '{print $1}')
restore() {
  if [ -n "$stack" ]; then say "starting the Morfa stack again: $(echo $stack)"; systemctl start $stack || true; fi
  [ -n "${ws_pid:-}" ] && kill "$ws_pid" 2>/dev/null || true
}
trap restore EXIT
if [ -n "$stack" ]; then say "stopping the Morfa stack for the run: $(echo $stack)"; systemctl stop $stack; fi

say "building the system under test ($hash) and the harness"
if [ "$(readlink -f "$sut")" = "$(readlink -f "$harness")" ]; then
  as_morfa bash "$harness/scripts/deploy/build.sh" --dir "$sut" --no-app --crates morfa-collab,morfa-loadgen
else
  as_morfa bash "$harness/scripts/deploy/build.sh" --dir "$sut" --no-app --crates morfa-collab
  as_morfa bash "$harness/scripts/deploy/build.sh" --dir "$harness" --no-app --crates morfa-loadgen
  # The harness measures the commit (close.sh's rule): its scripts/bench replaces the commit's own.
  as_morfa rsync -a --delete "$harness/scripts/bench/" "$sut/scripts/bench/"
fi
[ -x "$harness/bin/loadgen" ] || cp "$sut/bin/loadgen" "$harness/bin/loadgen" 2>/dev/null || true
say "bench files (scripts/bench/gen-file.ts)"
(cd "$harness" && as_morfa npm run --silent bench:files >/dev/null)
for f in "$harness"/fixtures/bench/*.json; do [ -e "$sut/fixtures/bench/$(basename "$f")" ] || as_morfa ln -sfn "$f" "$sut/fixtures/bench/$(basename "$f")"; done

say "loadgen → $net"
as_morfa ssh -o BatchMode=yes "$net" 'mkdir -p bin runs && rm -rf runs/*'
as_morfa scp -q "$harness/bin/loadgen" "$net:bin/loadgen.new"
as_morfa ssh -o BatchMode=yes "$net" 'mv bin/loadgen.new bin/loadgen && chmod +x bin/loadgen'

# collab's pair rows (M1, M1b, M3) over B1's socket: a node pinned like the servers, dev tickets, the f20k seed.
wrapper=/srv/morfa/bench/bin/morfa-collab
as_morfa install -d /srv/morfa/bench/bin
printf '#!/bin/sh\nexec taskset -c %s %s "$@"\n' "$server_cpus" "$sut/bin/morfa-collab" >"$wrapper"
chown morfa:morfa "$wrapper"; chmod 755 "$wrapper"
ws_env=()
# The legacy report's M1/M1b/M3 pair rows over B1's socket (in-memory journal) are B0's comparison; the collab path measures
# the real thing (scripts/bench/collab-path.ts), so the extra node is for the legacy report only.
[ "$measured" = collab ] && collab_ws=0
if [ $collab_ws = 1 ]; then
  sudo -u morfa env MORFA_COLLAB_ADDR=0.0.0.0:3420 MORFA_COLLAB_NODE=bench-ws MORFA_COLLAB_DEV_TICKETS=1 \
    MORFA_COLLAB_SEED="$harness/fixtures/bench/f20k.json" MORFA_COLLAB_SHARDS="$cores" RUST_LOG=warn \
    "$wrapper" serve >/srv/morfa/bench/collab-ws.log 2>&1 &
  ws_pid=$!
  for _ in $(seq 1 100); do curl -fs http://127.0.0.1:3420/healthz >/dev/null && break; sleep 0.2; done
  ws_env=(BENCH_COLLAB_WS=ws://127.0.0.1:3420)
fi

out="lanes/targets/close-$hash$suffix.md"
# The collab path's checkpoints go to the VM's S3 (MinIO stand-in until the Timeweb bucket): its keys from /etc/morfa/s3.env.
s3_env=()
if [ -f /etc/morfa/s3.env ]; then
  s3_env=(BENCH_S3_ENDPOINT="$(sed -n "s/^S3_ENDPOINT=//p" /etc/morfa/s3.env | tr -d "'")" BENCH_S3_REGION="$(sed -n "s/^S3_REGION=//p" /etc/morfa/s3.env | tr -d "'")"
    BENCH_S3_BUCKET="$(sed -n "s/^S3_BUCKET=//p" /etc/morfa/s3.env | tr -d "'")" BENCH_S3_ACCESS_KEY="$(sed -n "s/^S3_ACCESS_KEY=//p" /etc/morfa/s3.env | tr -d "'")"
    BENCH_S3_SECRET_KEY="$(sed -n "s/^S3_SECRET_KEY=//p" /etc/morfa/s3.env | tr -d "'")")
fi
say "targets.ts --machine bench-ru --only $only ($profile) → $out"
set +e
(cd "$harness" && as_morfa env BENCH_RU_LIVE=1 BENCH_PROFILE="$profile" \
  BENCH_PROFILE_NOTE="morfa.slice AllowedCPUs=$server_cpus (PostgreSQL, Caddy, MinIO), bench servers and collab nodes taskset $server_cpus, harness and observability on $harness_cpus, 8 vCPU AMD EPYC-Rome / 15 GiB VM" \
  BENCH_SERVER_CPUS="$server_cpus" BENCH_PG_STATE=/srv/morfa/bench/pg BENCH_PG_FREEZE="sudo -n /usr/local/sbin/morfa-pg-freeze" \
  BENCH_LOADGEN_SSH="$net" BENCH_LOADGEN_REMOTE=bin/loadgen BENCH_LOADGEN_CORES=2 BENCH_LOADGEN="$harness/bin/loadgen" \
  BENCH_PUBLIC_HOST="$bench_ip" BENCH_NETEM_SSH="$net" BENCH_NETEM_NOTE="$netem_note" BENCH_S3_KIND="${S3_KIND:-unknown}" \
  BENCH_PROVISIONAL_LOAD=16 MORFA_COLLAB_BIN="$wrapper" "${ws_env[@]}" "${s3_env[@]}" \
  taskset -c "$harness_cpus" node --import tsx scripts/bench/targets.ts --machine bench-ru --only "$only" --hash "$hash" \
  --source "$sut" --runs "$runs" $quick --path "$measured" --out "$out")
status=$?
set -e
results=$(ls -td "$harness"/output/bench/targets-bench-ru-*/ 2>/dev/null | head -n 1)
if [ -f "$results/results.json" ]; then
  (cd "$harness" && as_morfa node --import tsx scripts/deploy/targets-prom.ts --results "$results/results.json" --profile "$profile" \
    --hash "$hash" --out "/srv/morfa/bench/morfa_targets_$profile.prom")
  install -m 644 "/srv/morfa/bench/morfa_targets_$profile.prom" "/var/lib/morfa/textfile/morfa_targets_$profile.prom"
fi
say "done (targets.ts exit $status): $harness/$out"
exit $status
