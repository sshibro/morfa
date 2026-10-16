#!/usr/bin/env bash
# The desktop app's smoke run on Linux (docs/desktop.md §Smoke run): the shell's smoke build under tauri-driver on a
# virtual display (xvfb) with a session D-Bus (single instance, deep links), against the isolated e2e server.
#
# Needs: the libraries check.sh names, xvfb, dbus, webkit2gtk-driver (WebKitWebDriver), `cargo install tauri-driver`,
# and the PostgreSQL test cluster env (MORFA_TEST_ENV_FILE=<state>/cluster.env, docs/dev.md).
#
#   SMOKE_OFFLINE=1 SMOKE_BINARY=<release binary> desktop/scripts/smoke.sh
#     a built app whose server cannot be reached (production before it exists): checks only the offline page.
set -euo pipefail
cd "$(dirname "$0")/../.."
OFFLINE=${SMOKE_OFFLINE:-0}
if [ "$OFFLINE" != 1 ]; then
  : "${MORFA_TEST_ENV_FILE:?point MORFA_TEST_ENV_FILE at the test cluster env (docs/dev.md)}"
  set -a; . "$MORFA_TEST_ENV_FILE"; set +a
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/desktop}"
WORK=$(mktemp -d)
PORT=${SMOKE_PORT:-4410}
cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${DRIVER_PID:-}" ] && kill "$DRIVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

for tool in xvfb-run dbus-run-session WebKitWebDriver tauri-driver; do
  command -v "$tool" >/dev/null || { echo "smoke: missing $tool (docs/desktop.md §Smoke run)"; exit 3; }
done

if [ "$OFFLINE" = 1 ]; then
  : "${SMOKE_BINARY:?the built app to check, e.g. desktop/src-tauri/target/release/morfa}"
  export SMOKE_OFFLINE=1 MORFA_DESKTOP_SMOKE_SAVE=/dev/null
  BINARY=$(realpath "$SMOKE_BINARY")
else
echo "smoke: building the shell with the smoke feature"
(cd desktop/src-tauri && cargo build --locked --features smoke)
BINARY="$CARGO_TARGET_DIR/debug/morfa-desktop"

echo "smoke: starting the e2e server on $PORT"
export MORFA_E2E_RUN_KEY="smoke-$RANDOM$RANDOM"
E2E_PORT=$PORT E2E_API_PORT=$((PORT + 1)) MORFA_E2E_WARMUP=0 node --import tsx scripts/e2e-server.ts > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 180); do curl -fsS "http://127.0.0.1:$PORT/__e2e/ready" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/__e2e/ready" >/dev/null || { cat "$WORK/server.log"; exit 1; }

export MORFA_APP_ORIGIN="http://127.0.0.1:$PORT" MORFA_DESKTOP_SMOKE_SAVE="$WORK/saved.rdesign"
fi
export SMOKE_BINARY="$BINARY"
# Each run starts signed out with fresh app data.
export XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache"
dbus-run-session -- xvfb-run -a -s "-screen 0 1600x1000x24" bash -c '
  tauri-driver --port 4444 --native-driver "$(command -v WebKitWebDriver)" > "'"$WORK"'/driver.log" 2>&1 &
  for _ in $(seq 1 50); do curl -fsS http://127.0.0.1:4444/status >/dev/null 2>&1 && break; sleep 0.2; done
  npx tsx desktop/scripts/smoke.ts; status=$?
  kill %1 2>/dev/null
  [ $status -eq 0 ] || tail -50 "'"$WORK"'/driver.log"
  exit $status'
