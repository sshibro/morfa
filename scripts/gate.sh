#!/usr/bin/env bash
# Morfa's local gate. There is no CI: this script is the gate, run on the Mac before
# every push to main. The Rust half (scripts/gate-rust.sh) runs first: the TypeScript steps may load its wasm.
#
#   scripts/gate.sh                  fonts, type check, design unit tests (engine ts, then both + its report), PostgreSQL
#                                    tests, build, e2e
#   MORFA_CLOUD=1 scripts/gate.sh    the same without PostgreSQL and e2e (cloud sessions have no Docker or Chromium)
#
# PostgreSQL and e2e run against the isolated test cluster: load its env file first (set -a; . <state>/cluster.env;
# set +a) or point MORFA_TEST_ENV_FILE at it. How to start one: docs/dev.md. Every step runs even after a failure, so
# one run shows everything that is red; logs go to output/gate/<time>/. Exit status 0 only if every step that ran passed.
set -u
cd "$(dirname "$0")/.." || exit 2
ROOT=$(pwd)
RUN_DIR="$ROOT/output/gate/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_DIR"
CLOUD="${MORFA_CLOUD:-0}"

# x64 Node on an arm64 Mac breaks esbuild (Vite, tsx): refuse before anything runs.
if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] && [ "$(node -p process.arch 2>/dev/null)" != arm64 ]; then
  echo "gate: node on PATH is not arm64 ($(command -v node)); use the arm64 Node 22 (docs/dev.md)." >&2
  exit 2
fi
if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major === 22 && (minor > 23 || (minor === 23 && patch >= 2)) ? 0 : 1)'; then
  echo "gate: Node $(node -v 2>/dev/null) does not match package.json engines (>=22.23.2 <23)." >&2
  exit 2
fi

if [ "$CLOUD" != 1 ] && [ -n "${MORFA_TEST_ENV_FILE:-}" ]; then
  # shellcheck disable=SC1090
  set -a; . "$MORFA_TEST_ENV_FILE"; set +a
fi
export E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-$RUN_DIR/e2e}"

NAMES=()
RESULTS=()
SECONDS_TAKEN=()
NOTES=()
FAILED=0

record() { NAMES+=("$1"); RESULTS+=("$2"); SECONDS_TAKEN+=("$3"); NOTES+=("$4"); }

# step <name> <command…>: runs the command, shows and logs its output, records the result and the time it took.
step() {
  local name=$1; shift
  local log="$RUN_DIR/${name//:/-}.log" started=$SECONDS status
  echo
  echo "=== gate: $name ($*) ==="
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ $status -eq 0 ]; then record "$name" PASS $((SECONDS - started)) ""
  else record "$name" FAIL $((SECONDS - started)) "exit $status, log: ${log#"$ROOT"/}"; FAILED=1; fi
}

skip() { record "$1" SKIP - "$2"; }

needs_cluster() {
  [ -n "${MORFA_TEST_DATABASE_URL:-}" ] && return 0
  record "$1" FAIL - "no test cluster env: load <state>/cluster.env or set MORFA_TEST_ENV_FILE (docs/dev.md)"
  FAILED=1
  return 1
}

build() { npm run build:app && npm run performance:budgets; }

step fonts npm run fonts
# Rust half (lane S0): cargo fmt, clippy, tests and the wasm builds. The root ./target is not ignored, so the gate
# builds into a cache folder unless the caller chose one.
step rust env CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/gate}" bash scripts/gate-rust.sh
# The text engine's own two modules (lane L3): the both-mode suite and the editor load them lazily.
step rust:text env CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/gate}" bash scripts/wasm-text-build.sh
# The renderer's own module (lane L4): the web build (vello on WebGPU) the editor loads lazily behind the render engine
# switch, the nodejs build (vello_cpu) the goldens test and the server's exports load; each within its own budget.
step rust:render env CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/gate}" bash scripts/wasm-render-build.sh
# The geometry module (lane L1, crates/geometry-wasm): the both-mode suite requires it on first use, the editor
# loads it lazily.
step rust:geometry env CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/gate}" bash scripts/wasm-geometry-build.sh
# The export module (lane L5, crates/export-wasm: SVG and the vector PDF): the both-mode suite requires it on first use,
# the editor loads it lazily when something is exported.
step rust:export env CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/gate}" bash scripts/wasm-export-build.sh
# The desktop shell (lane D1, desktop/: its own Cargo workspace): fmt, clippy and its tests. Skipped with a note when the
# system libraries Tauri builds against (webkit2gtk on Linux) are missing — desktop/scripts/check.sh exits 3 then.
desktop_check() {
  local log="$RUN_DIR/desktop.log" started=$SECONDS status
  echo
  echo "=== gate: desktop (desktop/scripts/check.sh) ==="
  CARGO_TARGET_DIR="$HOME/.cache/morfa-target/desktop" bash desktop/scripts/check.sh 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ $status -eq 0 ]; then record desktop PASS $((SECONDS - started)) ""
  elif [ $status -eq 3 ]; then record desktop SKIP - "$(grep -m1 'SKIP' "$log" | sed 's/^desktop check: SKIP — //')"
  else record desktop FAIL $((SECONDS - started)) "exit $status, log: ${log#"$ROOT"/}"; FAILED=1; fi
}
desktop_check
step check npm run check
step test:design env MORFA_ENGINE=ts npm run test:design
# The engine switch's differential run (shared/design/engine-switch.ts): every ported module runs
# TypeScript and wasm and fails on any difference; the report sums every process's counters and fails on a diff or on
# a wired module (MORFA_GATE_ENGINE_REQUIRE) that never reached wasm.
ENGINE_REPORT="$RUN_DIR/engine-both.jsonl"
step test:design:both env MORFA_ENGINE=both MORFA_ENGINE_REPORT="$ENGINE_REPORT" npm run test:design
step engine:report npx tsx scripts/engine/report.ts "$ENGINE_REPORT" --require "${MORFA_GATE_ENGINE_REQUIRE:-geometry,ops,normalize}"
# The suite as the editor runs it (lane E1): the modules EDITOR_DEFAULTS (shared/design/engine-switch.ts) flips to wasm
# answer alone, and the report proves their wasm side ran.
EDITOR_REPORT="$RUN_DIR/engine-editor.jsonl"
step test:design:editor env MORFA_ENGINE=editor MORFA_ENGINE_REPORT="$EDITOR_REPORT" npm run test:design
step engine:editor npx tsx scripts/engine/report.ts "$EDITOR_REPORT" --require "${MORFA_GATE_EDITOR_REQUIRE:-geometry,normalize}"
if [ "$CLOUD" = 1 ]; then skip test:pg "MORFA_CLOUD=1"
elif needs_cluster test:pg; then step test:pg npm run test:pg; fi
# npm run build is fonts + check + this; both ran above.
step build build
if [ "$CLOUD" = 1 ]; then skip test:e2e "MORFA_CLOUD=1"
elif needs_cluster test:e2e; then step test:e2e npm run test:e2e; fi
# The co-editing specs once more with the API as production runs it: two processes behind a least-connections balancer, their
# live events through PostgreSQL (scripts/e2e-server.ts E2E_API_PROCESSES). A request reaching the process without the browser's
# stream is a case one process never meets (avatars blinking, 2026-10-12).
E2E_TWO_PROCESSES=(tests/e2e/design-multiplayer-steady.spec.ts tests/e2e/design-multiplayer.spec.ts tests/e2e/design-share-link.spec.ts
  tests/e2e/design-teams.spec.ts tests/e2e/design-comments.spec.ts tests/e2e/design-meeting.spec.ts tests/e2e/design-board-together.spec.ts)
if [ "$CLOUD" = 1 ]; then skip test:e2e:two-processes "MORFA_CLOUD=1"
elif needs_cluster test:e2e:two-processes; then
  step test:e2e:two-processes env E2E_API_PROCESSES=2 E2E_OUTPUT_DIR="$E2E_OUTPUT_DIR-two-processes" npx playwright test "${E2E_TWO_PROCESSES[@]}"
fi


TOTAL=0
for seconds in "${SECONDS_TAKEN[@]}"; do [ "$seconds" != - ] && TOTAL=$((TOTAL + seconds)); done
SUMMARY="$RUN_DIR/summary.txt"
{
  echo
  echo "gate $(date '+%Y-%m-%d %H:%M') · $(git rev-parse --short HEAD 2>/dev/null)$(git diff --quiet HEAD 2>/dev/null || echo ' +uncommitted') · MORFA_CLOUD=$CLOUD"
  printf '%-17s %-6s %8s  %s\n' step result seconds note
  for i in "${!NAMES[@]}"; do printf '%-17s %-6s %8s  %s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${SECONDS_TAKEN[$i]}" "${NOTES[$i]}"; done
  printf '%-17s %-6s %8s\n' total "$([ $FAILED = 0 ] && echo PASS || echo FAIL)" "$TOTAL"
} | tee "$SUMMARY"
exit $FAILED
