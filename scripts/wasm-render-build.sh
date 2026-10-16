#!/usr/bin/env bash
# Lane L4: builds crates/render-wasm (the renderer's own module) twice with wasm-pack, like scripts/wasm-text-build.sh:
#   --target web    --features gpu --no-default-features → src/design/wasm-render/    vello on WebGPU, loaded by the
#                                                           editor when the render module runs on the GPU
#   --target nodejs (default: cpu)                       → server/design/wasm-render/ vello_cpu for exports,
#                                                           thumbnails and the goldens test (require()d lazily)
# Speed and size: opt-level s (the renderer encodes every tile; z cost it 20–60 % on the engine's other modules) and
# panic = abort through the profile environment, wasm-opt -Os from the crate's metadata. MORFA_WASM_RENDER_BUDGET_KIB
# (default 700, the rule every lazily loaded module has) fails the build above it; the editor's first load carries
# none of it (scripts/performance/budgets.mjs counts initial JS).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
export CARGO_PROFILE_RELEASE_OPT_LEVEL=${CARGO_PROFILE_RELEASE_OPT_LEVEL:-s} CARGO_PROFILE_RELEASE_PANIC=${CARGO_PROFILE_RELEASE_PANIC:-abort}
# vello_cpu's SIMD kernels need the wasm simd128 target feature at compile time (every browser since 2023 and Node 16+
# run it); without it the CPU path rasterizes with scalar code, 10× slower.
export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128"
budget_kib=${MORFA_WASM_RENDER_BUDGET_KIB:-700}
[[ $budget_kib =~ ^[1-9][0-9]*$ ]] || {
  echo "wasm-render-build: MORFA_WASM_RENDER_BUDGET_KIB must be a whole number of KiB, got '$budget_kib'" >&2
  exit 1
}
command -v wasm-pack >/dev/null || {
  echo 'wasm-render-build: wasm-pack is missing (scripts/cloud-setup.sh, or: cargo binstall -y wasm-pack)' >&2
  exit 1
}

name=morfa_render_wasm
crate=render-wasm
web=src/design/wasm-render
node=server/design/wasm-render

build() {
  local target=$1 dir=$2
  shift 2
  echo "wasm-render-build: $crate --target $target → $dir ($*)"
  wasm-pack build "$root/crates/$crate" --release --target "$target" --out-dir "$root/$dir" --out-name "$name" -- "$@"
  for file in "$dir/$name.js" "$dir/${name}_bg.wasm" "$dir/package.json"; do
    [[ -f $root/$file ]] || { echo "wasm-render-build: $file was not written" >&2; exit 1; }
  done
  if [[ $(cat "$root/$dir/.gitignore" 2>/dev/null) != '*' ]]; then
    echo "wasm-render-build: $dir/.gitignore does not contain exactly '*'; the build output could be committed" >&2
    exit 1
  fi
}

build web "$web" --no-default-features --features gpu
build nodejs "$node"

if grep -q '"type": *"module"' "$root/$node/package.json"; then
  echo "wasm-render-build: $node/package.json declares \"type\": \"module\"; require() would fail" >&2
  exit 1
fi

bytes() { echo $(($(wc -c <"$1"))); }
gzip_bytes() { echo $(($(gzip -9 -c "$1" | wc -c))); }
echo
echo 'wasm-render-build: sizes (bytes; KiB = 1024 bytes)'
printf '  %-46s %9s %9s %10s %9s\n' file raw KiB 'gzip -9' KiB
for dir in "$web" "$node"; do
  for file in "$dir/${name}_bg.wasm" "$dir/$name.js"; do
    raw=$(bytes "$root/$file") gz=$(gzip_bytes "$root/$file")
    printf '  %-46s %9d %9s %10d %9s\n' "$file" "$raw" "$(awk -v n="$raw" 'BEGIN { printf "%.1f", n / 1024 }')" \
      "$gz" "$(awk -v n="$gz" 'BEGIN { printf "%.1f", n / 1024 }')"
  done
done

budget=$((budget_kib * 1024))
shipped=$(($(gzip_bytes "$root/$web/${name}_bg.wasm") + $(gzip_bytes "$root/$web/$name.js")))
shipped_kib=$(awk -v n="$shipped" 'BEGIN { printf "%.1f", n / 1024 }')
echo
if ((shipped > budget)); then
  echo "wasm-render-build: over budget: the web build ships $shipped_kib KiB gzip -9, the budget is $budget_kib KiB (MORFA_WASM_RENDER_BUDGET_KIB)" >&2
  exit 1
fi
echo "wasm-render-build: budget ok: the web build ships $shipped_kib KiB gzip -9 of $budget_kib KiB ($(awk -v n="$shipped" -v b="$budget" 'BEGIN { printf "%.1f", 100 * n / b }')%)"
