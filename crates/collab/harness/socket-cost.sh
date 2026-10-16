#!/usr/bin/env bash
# MORFA_COLLAB_SOCKET_COST from a measurement (crates/collab/src/shard.rs): starts a release morfa-collab with
# shards, drives it with the load example, samples /healthz every 2 s and prints each run's shard-thread CPU per
# socket (‰ of a core: busy ÷ sockets at steady state).
#
#   cargo build --release -p morfa-collab --bins --examples
#   bash crates/collab/harness/socket-cost.sh            # the four standard rows
#   bash crates/collab/harness/socket-cost.sh <label> <shards> <load args with X for addr and pid>
set -u
target=${CARGO_TARGET_DIR:-target}
bin=$target/release/morfa-collab
ex=$target/release/examples/load
[[ -x $bin && -x $ex ]] || { echo "build first: cargo build --release -p morfa-collab --bins --examples" >&2; exit 2; }
out=$(mktemp -d)
[[ -f $out/seed.json ]] || "$ex" seed 2000 > "$out/seed.json"

run() {
  local label=$1 shards=$2
  shift 2
  local port=$((3600 + RANDOM % 300))
  MORFA_COLLAB_DEV_TICKETS=1 MORFA_COLLAB_SEED="$out/seed.json" MORFA_COLLAB_ADDR=127.0.0.1:$port MORFA_COLLAB_SHARDS=$shards RUST_LOG=warn \
    "$bin" serve > "$out/$label.server.log" 2>&1 &
  local pid=$!
  sleep 1
  (for _ in $(seq 1 300); do sleep 2; curl -s "127.0.0.1:$port/healthz"; echo; done) > "$out/$label.healthz" &
  local sampler=$!
  local args=("$@")
  args[1]=127.0.0.1:$port
  args[2]=$pid
  "$ex" "${args[@]}" > "$out/$label.load.log" 2>&1
  kill $sampler $pid 2> /dev/null
  wait $pid 2> /dev/null
  python3 - "$out/$label.healthz" "$label" << 'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith('{')]
rows = [r for r in rows if sum(s['conns'] for s in r['shards']) > 0]
steady = rows[3:-1] or rows  # the joins and the last sample left out
tot = sorted(sum(s['busy'] for s in r['shards']) / max(1, sum(s['conns'] for s in r['shards'])) for r in steady)
print(f"{sys.argv[2]}: per-socket shard CPU {tot[len(tot)//2]:.3f} ‰ (median of {len(tot)} samples, {tot[0]:.3f}..{tot[-1]:.3f}); sockets per shard {[s['conns'] for s in steady[-1]['shards']]}")
PY
  grep -E "^M[0-9]+ " "$out/$label.load.log" | head -2
}

if (($#)); then
  run "$@"
else
  run cursors-1-shard 1 cursors X X 200 5 30 40
  run cursors-shards 4 cursors X X 200 5 30 40
  run editors 4 edit X X 100 5 0 20 1 30 40
  run room-100-editors-400-viewers 4 edit X X 1 100 400 20 1 30 40
fi
echo "logs: $out"
