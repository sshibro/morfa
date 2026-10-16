#!/usr/bin/env bash
# The collab-path rows of docs/TARGETS.md (§3 multiplayer, §4 D1/D3, §8 K1/K3) against `morfa-collab` itself (lane
# B7): one command for a dev box or bench-ru (lane B5 runs the closing numbers there).
#
#   scripts/bench/collab-rows.sh [--rows M1,M4,M5,M6,M8,M10,M12,K1,D1,D3] [--quick] [--out FILE]
#
# Each scenario starts its own `morfa-collab` (release build of this checkout, dev tickets) and drives it with
# `crates/collab/examples/load.rs`; the PostgreSQL scenarios get a fresh migrated database of seeded files each
# (`load pg-seed`). The server's CPU and memory are read from /proc here, its latencies from its /metrics, the
# clients' from the driver. Rows print target / actual / colour; the report goes to FILE (default
# lanes/targets/collab-rows-<hash>-<host>.md).
#
# Environment:
#   MORFA_B2_PG_URL     a PostgreSQL role that may create databases (postgresql://…/postgres). Without it the
#                       scenarios run on the in-memory journal and D1, D3, K3 are n.a.
#   BENCH_CORES         CPU list for the server (taskset -c), e.g. 0-3 for B5's 4-core profile
#   BENCH_DRIVER_CORES  CPU list for a local driver, e.g. 4-7
#   BENCH_PG_CGROUP     PostgreSQL's cgroup cpu.stat (e.g. /sys/fs/cgroup/system.slice/postgresql@18-main.service/cpu.stat):
#                       K2 then prices PostgreSQL's cores at K1 too
#   BENCH_KEEP          set: keep the work directory (servers' logs, the drivers' full output)
#   BENCH_LOAD_SSH      user@host: run the driver there (ru-net); then M2/M3/M11 are over that network. Needs
#   BENCH_PUBLIC_HOST   the address the driver reaches this host at; the server listens on 0.0.0.0 then
#                       (dev tickets: only behind a firewall that admits the driver host, as bench-ru's ufw does)
#   BENCH_PG_FREEZE     D3: a command that makes PostgreSQL unavailable (e.g. `docker stop -t 1 morfa-b2-pg`,
#   BENCH_PG_THAW         B5's `sudo -n /usr/local/sbin/morfa-pg-freeze`) and the one that brings it back
#   BENCH_PORT          first port (3490); BENCH_SECONDS measured window per scenario (30; --quick 10)
#
# Numbers from a box where the driver shares the server's cores are provisional (TARGETS §0): the report says so
# with the load average.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"
export PATH="${HOME}/.cargo/bin:${PATH}"
export RUST_BACKTRACE=0

rows="M1,M4,M5,M6,M8,M10,M12,K1,D1,D3"  # M2, M3, M11 and K3 come with M1, M10 and D1
quick=0
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rows) rows="$2"; shift 2 ;;
    --quick) quick=1; shift ;;
    --out) out="$2"; shift 2 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "collab-rows: unknown option $1" >&2; exit 2 ;;
  esac
done
want() { [[ ",$rows," == *",$1,"* ]]; }

hash="$(git rev-parse --short=9 HEAD)"
host="$(hostname -s 2>/dev/null || echo host)"
out="${out:-lanes/targets/collab-rows-${hash}-${host}.md}"
secs="${BENCH_SECONDS:-$([ "$quick" = 1 ] && echo 10 || echo 30)}"
port="${BENCH_PORT:-3490}"
work="$(mktemp -d "${TMPDIR:-/tmp}/collab-rows-XXXX")"
pg="${MORFA_B2_PG_URL:-}"
listen="127.0.0.1"
reach="127.0.0.1"
if [ -n "${BENCH_LOAD_SSH:-}" ]; then
  : "${BENCH_PUBLIC_HOST:?BENCH_LOAD_SSH needs BENCH_PUBLIC_HOST}"
  listen="0.0.0.0"
  reach="$BENCH_PUBLIC_HOST"
fi
net="$([ -n "${BENCH_LOAD_SSH:-}" ] && echo "over ${BENCH_LOAD_SSH#*@}" || echo "loopback")"
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  [ -n "${BENCH_PG_THAW:-}" ] && [ -f "$work/frozen" ] && eval "$BENCH_PG_THAW" || true
  if [ -n "${BENCH_KEEP:-}" ]; then echo "collab-rows: kept $work" >&2; else rm -rf "$work"; fi
}
trap cleanup EXIT

echo "collab-rows: ${hash} on ${host}; rows ${rows}; ${secs} s windows; report ${out}"
echo "collab-rows: $(uptime)"
cargo build --release --locked -p morfa-collab --bin morfa-collab --example load >"$work/build.log" 2>&1 || {
  tail -20 "$work/build.log"
  exit 1
}
target="${CARGO_TARGET_DIR:-target}/release"
bin="$target/morfa-collab"
load="$target/examples/load"
"$load" seed 19200 >"$work/f20k.json"
"$load" seed 2000 >"$work/f2k.json"
if [ -n "${BENCH_LOAD_SSH:-}" ]; then
  scp -q "$load" "${BENCH_LOAD_SSH}:/tmp/morfa-b7-load"
fi

# ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

pin() { if [ -n "${1:-}" ]; then echo "taskset -c $1"; fi; }

# start <seed file|-> [files layers kind]: the server, on a fresh seeded database when MORFA_B2_PG_URL is set
# (else on the in-memory journal with the seed for every file). Sets server_pid, addr, db.
start() {
  local seed="$1" files="${2:-}" layers="${3:-}" kind="${4:-edit}"
  port=$((port + 1))
  addr="${reach}:${port}"
  db=""
  local env=(MORFA_COLLAB_DEV_TICKETS=1 MORFA_COLLAB_ADDR="${listen}:${port}" RUST_LOG=warn
    MORFA_COLLAB_CHECKPOINT_DIR="$work/ckpt-${port}")
  if [ -n "$pg" ] && [ -n "$files" ]; then
    db="$("$load" pg-seed "$files" "$layers" "$kind" 2>"$work/seed.err")" || { cat "$work/seed.err"; exit 1; }
    env+=(MORFA_COLLAB_PG_URL="$db")
  elif [ "$seed" != "-" ]; then
    env+=(MORFA_COLLAB_SEED="$seed")
  fi
  env "${env[@]}" $(pin "${BENCH_CORES:-}") "$bin" >"$work/server-${port}.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 100); do
    curl -sf "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "collab-rows: the server did not start:" >&2
  cat "$work/server-${port}.log" >&2
  exit 1
}

stop() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  server_pid=""
  # Each scenario's database goes with it (an f20k run leaves gigabytes behind).
  [ -n "${db:-}" ] && "$load" pg-drop "$db" >/dev/null 2>&1 || true
}

# drive <mode> <args…>: the load driver (here or on BENCH_LOAD_SSH) against the current server.
drive() {
  local mode="$1"
  shift
  local env=(LOAD_UUID_FILES=$([ -n "$db" ] && echo 1 || echo 0) LOAD_SINCE=$([ -n "$db" ] && echo 1 || echo 0) RUST_BACKTRACE=0)
  if [ -n "${BENCH_LOAD_SSH:-}" ]; then
    ssh "$BENCH_LOAD_SSH" env "${env[@]}" /tmp/morfa-b7-load "$mode" "$addr" 0 "$@"
  else
    env "${env[@]}" $(pin "${BENCH_DRIVER_CORES:-}") "$load" "$mode" "$addr" "$server_pid" "$@"
  fi
}

# The server's CPU seconds (utime + stime) and resident MB.
cpu() { awk '{print ($14 + $15) / 100}' "/proc/$server_pid/stat"; }
rss() { awk '/VmRSS/ {printf "%.0f", $2 / 1024}' "/proc/$server_pid/status"; }

# run <name> <seconds to wait before sampling> <mode> <args…>: the driver in the background, the server's CPU over
# the driver's measured window (it measures `secs` after a 2 s warm-up), RSS at its end.
# PostgreSQL's CPU seconds so far, from BENCH_PG_CGROUP (its cgroup's cpu.stat); empty without it.
pgcpu() {
  [ -n "${BENCH_PG_CGROUP:-}" ] && awk '$1 == "usage_usec" {printf "%.3f", $2 / 1e6}' "$BENCH_PG_CGROUP" || true
}
run() {
  local name="$1" lead="$2"
  shift 2
  drive "$@" >"$work/$name.out" 2>"$work/$name.err" &
  local driver=$!
  sleep $((2 + lead))
  local c0 t0 c1 t1
  c0="$(cpu)"; p0="$(pgcpu)"; t0="$(date +%s.%N)"
  sleep "$((secs > lead ? secs - lead : 1))"
  c1="$(cpu)"; p1="$(pgcpu)"; t1="$(date +%s.%N)"
  echo "$(awk -v a="$c0" -v b="$c1" -v s="$t0" -v e="$t1" 'BEGIN {printf "%.3f", (b - a) / (e - s)}')" >"$work/$name.cpu"
  if [ -n "$p0" ]; then
    awk -v a="$p0" -v b="$p1" -v s="$t0" -v e="$t1" 'BEGIN {printf "%.3f", (b - a) / (e - s)}' >"$work/$name.pgcpu"
  fi
  rss >"$work/$name.rss"
  wait "$driver" || { echo "collab-rows: $name: the driver failed:" >&2; tail -5 "$work/$name.err" >&2; return 1; }
}

# summary <name> <metric> <field>: a field (p50, p95, p99, max, n) of a server histogram, in ms.
# summary <name> <histogram> <p50|p95|p99>: the server's quantile over the measured window (`# STEADY`, without the
# warm-up) when the driver printed one, else since the server started.
summary() {
  { grep "# STEADY collab_$2_seconds" "$work/$1.out"; grep "# SUMMARY collab_$2_seconds" "$work/$1.out"; } |
    sed -n "s/.* $3=\([0-9.]*\).*/\1/p" | head -1
}
counter() { awk -v n="collab_$2" '$1 == n {print $2}' "$work/$1.out" | head -1; }
# client <name> <line prefix> <p50|p95|p99>: a quantile the driver printed.
client() { grep -F "$2" "$work/$1.out" | sed -n "s/.*$3 \([0-9.]*\).*/\1/p" | head -1; }

report=()
add() { report+=("| $1 | $2 | $3 | $4 | $5 |"); printf '%-4s %-46s %-34s %s\n' "$1" "$3" "$4" "$5"; }
# colour <actual> <target> <ceiling>: green ≤ target, yellow ≤ ceiling, else red (numbers; lower is better).
colour() {
  awk -v a="$1" -v t="$2" -v c="$3" 'BEGIN {if (a == "") print "n.a."; else if (a + 0 <= t + 0) print "green"; else if (a + 0 <= c + 0) print "yellow"; else print "red"}'
}
worst() {
  local w="green" c
  for c in "$@"; do
    case "$c" in red) w="red" ;; yellow) [ "$w" = green ] && w="yellow" ;; n.a.) [ "$w" = green ] && w="n.a." ;; esac
  done
  echo "$w"
}
na() { add "$1" "$2" "$3" "n.a.: $4" "n.a."; }

# ── Scenarios ────────────────────────────────────────────────────────────────────────────────────

# M1, M1b, M2, M3, M11: 5 editors on f20k, 20-layer ops at 1/s, cursors at 30 Hz.
if want M1; then
  start "$work/f20k.json" 1 19200
  run pair 0 edit 1 5 0 20 1 30 "$secs"
  stop
  m1=("$(summary pair op_fanout p50)" "$(summary pair op_fanout p95)" "$(summary pair op_fanout p99)")
  m1b=("$(summary pair op_ack p50)" "$(summary pair op_ack p95)" "$(summary pair op_ack p99)")
  add M1 "op → change queued, 5 editors, f20k" "≤ 0.5 / 2 / 5 ms (1 / 5 / 20)" "${m1[0]} / ${m1[1]} / ${m1[2]} ms" \
    "$(worst "$(colour "${m1[0]}" 0.5 1)" "$(colour "${m1[1]}" 2 5)" "$(colour "${m1[2]}" 5 20)")"
  add M1b "op → ack after the journal commit" "≤ 3 / 8 / 15 ms (6 / 15 / 30)" "${m1b[0]} / ${m1b[1]} / ${m1b[2]} ms$([ -z "$pg" ] && echo ' (in-memory journal)')" \
    "$(worst "$(colour "${m1b[0]}" 3 6)" "$(colour "${m1b[1]}" 8 15)" "$(colour "${m1b[2]}" 15 30)")"
  ack=("$(client pair 'ack (client RTT)' p50)" "$(client pair 'ack (client RTT)' p95)" "$(client pair 'ack (client RTT)' p99)")
  peer=("$(client pair 'op → change at a peer' p95)" "$(client pair 'op → change at a peer' p99)")
  add M2 "op → ack at the client ($net)" "≤ 35 / 45 / 60 ms (50 / 80 / 150)" "${ack[0]} / ${ack[1]} / ${ack[2]} ms" \
    "$( [ -n "${BENCH_LOAD_SSH:-}" ] && worst "$(colour "${ack[0]}" 35 50)" "$(colour "${ack[1]}" 45 80)" "$(colour "${ack[2]}" 60 150)" || echo "n.a. (loopback)")"
  add M3 "op → applied at a peer ($net)" "p95 / p99 ≤ 45 / 60 ms (80 / 100)" "${peer[0]} / ${peer[1]} ms" \
    "$(worst "$(colour "${peer[0]}" 45 80)" "$(colour "${peer[1]}" 60 100)")"
fi

# M4: one f20k file, 100 editors + 400 viewers; "≤ 2× M1 / ≤ 2× M3" read as twice those rows' targets (p99 10 ms,
# p95 90 ms; ceiling 4×), as lane B1 did; the ratio to this run's own pair is printed too.
if want M4; then
  start "$work/f20k.json" 1 19200
  run crowd 0 edit 1 100 400 20 1 30 "$secs"
  stop
  c99="$(summary crowd op_fanout p99)"
  cp95="$(client crowd 'op → change at a peer' p95)"
  r1="$(awk -v a="$c99" 'BEGIN {printf "%.1f", a / 5}')"
  r3="$(awk -v a="$cp95" 'BEGIN {printf "%.1f", a / 45}')"
  pair="$( [ -n "${m1[2]:-}" ] && awk -v a="$c99" -v b="${m1[2]}" 'BEGIN {printf "; %.0f× this run'"'"'s pair p99", a / (b > 0 ? b : 1)}')"
  add M4 "1 file: 100 editors + 400 viewers" "M1 p99 ≤ 2× 5 ms / M3 p95 ≤ 2× 45 ms (4×)" "${c99} ms = ${r1}× / ${cp95} ms = ${r3}× (CPU $(cat "$work/crowd.cpu") cores${pair})" \
    "$(worst "$(colour "$r1" 2 4)" "$(colour "$r3" 2 4)")"
fi

# M5 and D1: 2 000 editors across 400 f2k files (400 × f20k does not fit 16 GB), cursors at 30 Hz.
if want M5 || want D1; then
  start "$work/f2k.json" 400 2000
  wal0="$([ -n "$db" ] && "$load" pg-wal "$db" || echo "")"
  run many 3 edit 400 5 0 20 1 30 "$secs"
  wal1="$([ -n "$db" ] && "$load" pg-wal "$db" || echo "")"
  stop
  m5="$(summary many op_fanout p99)"; m5cpu="$(cat "$work/many.cpu")"
  want M5 && add M5 "2 000 editors / 400 files (f2k)" "M1 p99 ≤ 20 ms / ≤ 3 cores (50 / 4)" "${m5} ms / ${m5cpu} cores" \
    "$(worst "$(colour "$m5" 20 50)" "$(colour "$m5cpu" 3 4)")"
  if want D1; then
    if [ -n "$pg" ]; then
      d1=("$(summary many journal_commit p50)" "$(summary many journal_commit p99)")
      add D1 "journal commit at 2 000 editors" "p50 / p99 ≤ 2 / 10 ms (5 / 20)" "${d1[0]} / ${d1[1]} ms" \
        "$(worst "$(colour "${d1[0]}" 2 5)" "$(colour "${d1[1]}" 10 20)")"
      ops="$(counter many ops_total)"
      k3="$(awk -v a="$wal0" -v b="$wal1" -v n="$ops" 'BEGIN {if (n > 0) printf "%.2f", (b - a) / n / 1024}')"
      add K3 "WAL per op (20-layer moves, M5 run)" "≤ 4 KB (16)" "${k3} KB ($ops ops)" "$(colour "$k3" 4 16)"
    else
      na D1 "journal commit at 2 000 editors" "p50 / p99 ≤ 2 / 10 ms" "set MORFA_B2_PG_URL"
    fi
  fi
fi

# M6/M7: resident memory per open f20k document (20 files, one viewer each, idle).
if want M6; then
  start "$work/f20k.json" 20 19200
  base="$(rss)"
  run idle 0 edit 20 0 1 20 1 0 "$secs"
  stop
  per="$(awk -v a="$(cat "$work/idle.rss")" -v b="$base" 'BEGIN {printf "%.1f", (a - b) / 20}')"
  json="$(awk -v b="$(wc -c <"$work/f20k.json")" 'BEGIN {printf "%.1f", b / 1e6}')"
  ratio="$(awk -v p="$per" -v j="$json" 'BEGIN {printf "%.2f", p / j}')"
  add M6 "resident memory per open f20k" "≤ 2.5× JSON (4×)" "${per} MB = ${ratio}× of ${json} MB" "$(colour "$ratio" 2.5 4)"
  add M7 "open f20k documents per GB" "≥ 25 (15)" "$(awk -v p="$per" 'BEGIN {printf "%.1f", 1024 / p}')" \
    "$(awk -v p="$per" 'BEGIN {n = 1024 / p; print (n >= 25 ? "green" : n >= 15 ? "yellow" : "red")}')"
fi

# M8: a reader misses 1 000 ops (2-layer edits), then catches up.
if want M8; then
  start "$work/f2k.json"
  db=""
  run catchup 0 catchup 1000 2
  stop
  m8s="$(summary catchup catchup max)"
  m8c="$(sed -n 's/.*converged in \([0-9.]*\) ms.*/\1/p' "$work/catchup.out")"
  add M8 "catch-up of 1 000 missed ops" "server ≤ 100 ms / converged ≤ 500 ms (300 / 2 000)" "${m8s} ms / ${m8c} ms ($([ -n "${BENCH_LOAD_SSH:-}" ] && echo remote || echo loopback))" \
    "$(worst "$(colour "$m8s" 100 300)" "$(colour "$m8c" 500 2000)")"
fi

# M10 and M11: 1 000 users in 200 files of 5, cursors at 30 Hz, no ops.
if want M10; then
  "$load" seed 20 >"$work/small.json"
  start "$work/small.json" 200 20 m10
  run cursors 0 cursors 200 5 30 "$secs"
  stop
  m10="$(cat "$work/cursors.cpu")"
  rate="$(sed -n 's/.*frames per receiver \([0-9.]*\).*/\1/p' "$work/cursors.out")"
  add M10 "1 000 cursor users at 30 Hz" "≤ 0.25 core, ≤ 30 Hz per peer (0.5)" "${m10} cores, ${rate} frames/s per receiver" \
    "$(worst "$(colour "$m10" 0.25 0.5)" "$(colour "$rate" 30 30)")"
  m11=("$(client cursors 'M11 presence delivery' p50)" "$(client cursors 'M11 presence delivery' p95)")
  add M11 "presence delivery, all 1 000 moving ($net)" "p95 ≤ 50 ms (100)" "p50 ${m11[0]} / p95 ${m11[1]} ms" \
    "$( [ -n "${BENCH_LOAD_SSH:-}" ] && colour "${m11[1]}" 50 100 || echo "n.a. (loopback)")"
fi

# M12: 5 editors + 2 viewers reading at 64 kbit/s on f20k: the editors' M1/M3 against the pair run.
if want M12; then
  start "$work/f20k.json" 1 19200
  run slow 0 edit 1 5 0 20 1 30 "$secs" 2
  stop
  s99="$(summary slow op_fanout p99)"; s95="$(client slow 'op → change at a peer' p95)"
  closed="$(counter slow slow_closed_total)"
  add M12 "two 64 kbit/s viewers on a busy f20k" "no effect on the others' M1/M3" "M1 p99 ${s99} ms (pair ${m1[2]:-?}), M3 p95 ${s95} ms (pair ${peer[0]:-?}); slow closed ${closed:-0}" \
    "$(worst "$(colour "$s99" "$(awk -v b="${m1[2]:-5}" 'BEGIN {print b * 1.2 + 0.5}')" 20)")"
fi

# K1: 1 000 editors in 200 f20k files (1 op/s, cursors 30 Hz): cores and resident memory, after the files opened.
if want K1; then
  start "$work/f20k.json" 200 19200
  # Open every file first (cold loads are S1's row), with all five of its sockets: shards place a file when it opens
  # and keep it there, so files opened by one socket each pack onto one shard that the editors then saturate.
  drive edit 200 0 5 20 1 0 1 >/dev/null 2>&1 || true
  run k1 5 edit 200 5 0 20 1 30 "$secs"
  stop
  k1cpu="$(cat "$work/k1.cpu")"; k1mem="$(awk -v m="$(cat "$work/k1.rss")" 'BEGIN {printf "%.1f", m / 1024}')"
  add K1 "1 000 editors on 200 f20k files" "≤ 2 cores / ≤ 10 GB (4 / 16)" "${k1cpu} cores / ${k1mem} GB; M1 p99 $(summary k1 op_fanout p99) ms" \
    "$(worst "$(colour "$k1cpu" 2 4)" "$(colour "$k1mem" 10 16)")"
  # K2: on the VM size of TARGETS §9 (8 vCPU / 16 GB, BENCH_RUB_PER_VM a month), filled to 75 % of its cores or its
  # memory, whichever runs out first. Collab's share, and with BENCH_PG_CGROUP PostgreSQL's cores too (its memory
  # is a fixed pool, not per editor); api and S3 are not in it.
  rub="${BENCH_RUB_PER_VM:-4300}"
  k2cost() {
    awk -v c="$1" -v m="$k1mem" -v r="$rub" 'BEGIN {
      by_cpu = 8 * 0.75 / (c / 1000); by_mem = 16 * 0.75 / (m / 1000);
      n = by_cpu < by_mem ? by_cpu : by_mem; printf "%.2f", r / n }'
  }
  k2="$(k2cost "$k1cpu")"
  if [ -f "$work/k1.pgcpu" ]; then
    k1pg="$(cat "$work/k1.pgcpu")"
    k2pg="$(k2cost "$(awk -v a="$k1cpu" -v b="$k1pg" 'BEGIN {print a + b}')")"
    add K2 "₽ per editor-month (collab + PostgreSQL ${k1pg} cores, 8 vCPU/16 GB at ${rub} ₽)" "≤ 10 ₽ (25)" \
      "${k2pg} ₽ (collab alone ${k2} ₽)" "$(colour "$k2pg" 10 25)"
  else
    add K2 "₽ per editor-month (collab only, 8 vCPU/16 GB at ${rub} ₽)" "≤ 10 ₽ (25)" "${k2} ₽" "$(colour "$k2" 10 25)"
  fi
fi

# D3: PostgreSQL unavailable 30 s under 200 files × 5 editors (f2k): acks pause, no rollback, no 409 storm.
if want D3; then
  if [ -n "$pg" ] && [ -n "${BENCH_PG_FREEZE:-}" ] && [ -n "${BENCH_PG_THAW:-}" ]; then
    start "$work/f2k.json" 200 2000
    secs_d3=$((secs < 50 ? 50 : secs))
    (sleep 12; touch "$work/frozen"; eval "$BENCH_PG_FREEZE"; sleep 30; eval "$BENCH_PG_THAW"; rm -f "$work/frozen") &
    outage=$!
    saved="$secs"; secs="$secs_d3"
    run outage 0 edit 200 5 0 20 1 0 "$secs"
    secs="$saved"
    wait "$outage" || true
    stop
    rolled="$(counter outage rollback_total)"; deferred="$(counter outage ops_deferred_total)"
    conflicts="$(grep -c '"code":"version_conflict"' "$work/outage.err" || true)"
    unavailable="$(grep -c '"code":"design_unavailable"' "$work/outage.err" || true)"
    ackmax="$(summary outage op_ack max)"
    add D3 "PostgreSQL unavailable 30 s, 1 000 editors" "acks pause; no rollback, no 409 storm" \
      "ack max ${ackmax} ms; rollbacks ${rolled:-0}; refused: ${deferred:-0} busy (deferred), ${unavailable} unavailable, ${conflicts} conflicts" \
      "$([ "${rolled:-0}" = 0 ] && [ "$conflicts" = 0 ] && [ "$unavailable" = 0 ] && echo green || echo red)"
  else
    na D3 "PostgreSQL unavailable 30 s" "acks pause, no 409 storm" "set MORFA_B2_PG_URL, BENCH_PG_FREEZE and BENCH_PG_THAW"
  fi
fi

# ── Report ───────────────────────────────────────────────────────────────────────────────────────

mkdir -p "$(dirname "$out")"
{
  echo "# Collab rows — ${host}, ${hash}"
  echo
  echo "scripts/bench/collab-rows.sh --rows ${rows}$([ "$quick" = 1 ] && echo ' --quick'); ${secs} s windows; $(date -u +%FT%TZ)"
  echo
  echo "- Machine: $(nproc) CPUs, $(awk '/MemTotal/ {printf "%.0f GB", $2 / 1048576}' /proc/meminfo), $(uname -sr); load average at the end: $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "- Server cores: ${BENCH_CORES:-all}; driver: ${BENCH_LOAD_SSH:-this host, cores ${BENCH_DRIVER_CORES:-all}}; journal: $([ -n "$pg" ] && echo PostgreSQL || echo 'in memory')"
  [ -z "${BENCH_LOAD_SSH:-}" ] && echo "- Provisional: the driver runs on the server's host (TARGETS §0); M2 and M11 need a network (BENCH_LOAD_SSH)."
  echo
  echo "| id | scenario | target (ceiling) | actual | state |"
  echo "|---|---|---|---|---|"
  printf '%s\n' "${report[@]}"
} >"$out"
echo "collab-rows: wrote ${out}"
