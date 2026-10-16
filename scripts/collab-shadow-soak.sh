#!/usr/bin/env bash
# The DESIGN_COLLAB=shadow soak (tests/soak/collab-shadow-soak.test.ts) in one command, for lane B5 on bench-ru:
#
#   bash scripts/collab-shadow-soak.sh [minutes=180] [seed=1]
#
# It needs Node and npm ci, Rust (cargo builds morfa-collab in release) and Docker or a local PostgreSQL 18 for the isolated
# test cluster (scripts/postgresql/test-cluster.mjs). It never touches another database: the cluster is its own, on port
# MORFA_SOAK_PG_PORT (5460), state in ~/.cache/morfa-pg/soak; it is left up for the next run (`npm run db:test-cluster -- down
# --state-dir ~/.cache/morfa-pg/soak` takes it down). A run prints a progress line per round and ends with the shadow report;
# the exit code is 0 only with 0 differences. Logs: output/soak/<time>/.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
minutes=${1:-180}
seed=${2:-1}
port=${MORFA_SOAK_PG_PORT:-5460}
state=${MORFA_SOAK_PG_STATE:-$HOME/.cache/morfa-pg/soak}
out=output/soak/$(date +%Y%m%d-%H%M%S)
mkdir -p "$out" "$state"
chmod 700 "$state"

if [[ -z ${MORFA_TEST_ENV_FILE:-} ]]; then
  npm run --silent db:test-cluster -- up --port "$port" --state-dir "$state" > "$out/cluster.json"
  export MORFA_TEST_ENV_FILE=$state/cluster.env
fi
# The suites read the cluster's settings from the environment (MORFA_TEST_*), as scripts/gate.sh loads them.
set -a
# shellcheck disable=SC1090
source "$MORFA_TEST_ENV_FILE"
set +a
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/soak}
cargo build --release -p morfa-collab --bin morfa-collab
[[ -f server/design/wasm/morfa_wasm.js ]] || bash scripts/wasm-build.sh

echo "collab shadow soak: $minutes minutes, seed $seed, logs in $out" >&2
MORFA_SOAK_MINUTES=$minutes MORFA_SOAK_SEED=$seed MORFA_SHADOW_REPORT_DIR=$out \
  node --import tsx --test --test-reporter=spec tests/soak/collab-shadow-soak.test.ts 2>&1 | tee "$out/soak.log"
exit "${PIPESTATUS[0]}"
