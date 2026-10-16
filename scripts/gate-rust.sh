#!/usr/bin/env bash
# The Rust half of Morfa's gate (docs/dev.md §Rust). scripts/gate.sh (the TypeScript half) calls it; it also runs alone, from any directory: scripts/gate-rust.sh
#
# Steps: cargo fmt --check, clippy with warnings denied, both wasm builds (scripts/wasm-build.sh), Node loads the
# nodejs build and must print the workspace version, then cargo test. Each step prints a header and its
# time; the first failing step stops the gate with its exit code.
#
# MORFA_CLOUD=1 (cloud containers) means: skip whatever needs e2e browsers or PostgreSQL. The Rust
# half needs neither, so every step runs either way; the browser smoke of the web build is a separate script
# (scripts/wasm-smoke.mjs). CARGO_TARGET_DIR and CARGO_BUILD_JOBS are used as set: this script picks neither.
#
# Written for bash 3.2 as well (macOS /bin/bash): no associative arrays, integer $SECONDS for timing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

steps=5 current=0 gate_start=$SECONDS

step() {
  local title=$1 start=$SECONDS status=0
  shift
  current=$((current + 1))
  printf '\n=== [%d/%d] %s\n$ %s\n' "$current" "$steps" "$title" "$*"
  "$@" || status=$?
  if ((status != 0)); then
    printf '=== FAILED [%d/%d] %s after %ds (exit %d)\n' "$current" "$steps" "$title" $((SECONDS - start)) "$status"
    exit "$status"
  fi
  printf '=== ok [%d/%d] %s (%ds)\n' "$current" "$steps" "$title" $((SECONDS - start))
}

# Node loads the CommonJS build exactly as the server and the unit tests will, from the repository root.
node_loads_wasm() {
  local id want got
  id=$(cargo pkgid -p morfa-wasm) || return 1
  want=${id##*[#@]}
  got=$(node -e "console.log(require('./server/design/wasm').version())") || return 1
  echo "require('./server/design/wasm').version() = $got (morfa-wasm $want, node $(node --version))"
  if [[ $got != "$want" ]]; then
    echo "expected $want" >&2
    return 1
  fi
}

echo "gate-rust: $(pwd)"
echo "  $(rustc --version); $(cargo --version)"
echo "  $(wasm-pack --version 2>/dev/null || echo 'wasm-pack missing'); node $(node --version 2>/dev/null || echo missing)"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<unset: ./target>} CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-<unset>}" \
  "MORFA_CLOUD=${MORFA_CLOUD:-<unset>} (nothing in the Rust half needs e2e or PostgreSQL)"

step 'cargo fmt' cargo fmt --all --check
# The server-only exports of crates/wasm (feature `server`, scripts/wasm-build.sh's nodejs build) are linted too.
step 'cargo clippy' cargo clippy --workspace --all-targets --features morfa-wasm/server -- -D warnings
# The wasm builds come before the tests: a failing test stops the gate, and the TypeScript steps after it must
# never run against a wasm left from an older build.
step 'wasm build (web + nodejs)' scripts/wasm-build.sh
step 'node loads server/design/wasm' node_loads_wasm
step 'cargo test' cargo test --workspace

printf '\n=== gate-rust: all %d steps ok (%ds)\n' "$steps" $((SECONDS - gate_start))
