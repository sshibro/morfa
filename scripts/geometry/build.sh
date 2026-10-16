#!/usr/bin/env bash
# Builds crates/geometry-wasm with its feature `harness` (every entry: per-function paths/shapes/matrix, documents,
# hit testing) with wasm-pack into scripts/geometry/pkg (nodejs target): lane L1's differential harness and the Node
# benches load it. The editor's own module is the same crate without the feature (scripts/wasm-geometry-build.sh).
# The output is never committed (wasm-pack writes a `*` .gitignore into it). `--dev` builds unoptimised.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
profile=--release
[[ ${1:-} == --dev ]] && profile=--dev
CARGO_PROFILE_RELEASE_OPT_LEVEL=${GEOMETRY_OPT_LEVEL:-s} wasm-pack build "$root/crates/geometry-wasm" $profile --target nodejs --out-dir "$root/scripts/geometry/pkg" \
  --out-name morfa_geometry -- --features harness >&2
[[ $(cat "$root/scripts/geometry/pkg/.gitignore" 2>/dev/null) == '*' ]] || { echo 'build: pkg/.gitignore is not "*"' >&2; exit 1; }
wasm=$root/scripts/geometry/pkg/morfa_geometry_bg.wasm
echo "geometry wasm: $(wc -c <"$wasm") bytes, gzip -9 $(gzip -9 -c "$wasm" | wc -c) bytes" >&2
