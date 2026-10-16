#!/usr/bin/env bash
# The desktop shell's own check (docs/desktop.md): rustfmt, clippy -D warnings and the shell's tests, in its own
# workspace (desktop/src-tauri). Needs the system libraries Tauri builds against; without them it says so and exits 3
# (scripts/gate.sh records that as SKIP, not as a pass).
#
#   desktop/scripts/check.sh            fmt, clippy, tests
#   MORFA_DESKTOP_FMT_FIX=1 …           formats instead of checking
set -u
cd "$(dirname "$0")/../src-tauri" || exit 2
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/desktop}"

missing=()
if [ "$(uname -s)" = Linux ]; then
  for lib in webkit2gtk-4.1 gtk+-3.0 libsoup-3.0; do pkg-config --exists "$lib" 2>/dev/null || missing+=("$lib"); done
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "desktop check: SKIP — missing system libraries: ${missing[*]}"
  echo "  Ubuntu/Debian: sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev"
  exit 3
fi

status=0
run() { echo "--- desktop: $*"; "$@" || status=1; }
if [ "${MORFA_DESKTOP_FMT_FIX:-0}" = 1 ]; then run cargo fmt --all; else run cargo fmt --all -- --check; fi
run cargo clippy --locked --all-targets -- -D warnings
run cargo clippy --locked --all-targets --features smoke -- -D warnings
run cargo test --locked
exit $status
