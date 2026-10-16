#!/usr/bin/env bash
# The geometry module (crates/geometry-wasm): built twice with wasm-pack,
# like scripts/wasm-build.sh does for crates/wasm and scripts/wasm-text-build.sh for the text modules:
#   --target web    → src/design/wasm-geometry/     loaded by the editor when the switch runs geometry as wasm/both
#                                                   (src/design/engine/geometry-wasm.ts)
#   --target nodejs → server/design/wasm-geometry/  required on first use in Node (shared/design/geometry-wasm.ts;
#                                                   MORFA_WASM_GEOMETRY_PATH overrides the path)
# The workspace's release profile (opt-level "s": lane L1 measured its rows passing there) and wasm-opt -Os from the
# crate's metadata. MORFA_WASM_GEOMETRY_BUDGET_KIB (default 150) fails the build when the web module, .wasm and JS
# glue gzip -9, is above it; the main module keeps its own 700 KiB budget (scripts/wasm-build.sh).
# Both outputs are never committed: wasm-pack writes a `*` .gitignore into each, and this script checks it.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# From the repository root, so wasm-pack's own rustc and rustup calls get rust-toolchain.toml's toolchain too.
cd "$root"
budget_kib=${MORFA_WASM_GEOMETRY_BUDGET_KIB:-150}
[[ $budget_kib =~ ^[1-9][0-9]*$ ]] || {
  echo "wasm-geometry-build: MORFA_WASM_GEOMETRY_BUDGET_KIB must be a whole number of KiB, got '$budget_kib'" >&2
  exit 1
}
command -v wasm-pack >/dev/null || {
  echo 'wasm-geometry-build: wasm-pack is missing (scripts/cloud-setup.sh, or: cargo binstall -y wasm-pack)' >&2
  exit 1
}

name=morfa_geometry_wasm
outputs='web:src/design/wasm-geometry nodejs:server/design/wasm-geometry'

for output in $outputs; do
  target=${output%%:*} dir=${output#*:}
  echo "wasm-geometry-build: wasm-pack --target $target → $dir"
  wasm-pack build "$root/crates/geometry-wasm" --release --target "$target" --out-dir "$root/$dir" --out-name "$name"
  for file in "$dir/$name.js" "$dir/${name}_bg.wasm" "$dir/package.json"; do
    [[ -f $root/$file ]] || { echo "wasm-geometry-build: $file was not written" >&2; exit 1; }
  done
  if [[ $(cat "$root/$dir/.gitignore" 2>/dev/null) != '*' ]]; then
    echo "wasm-geometry-build: $dir/.gitignore does not contain exactly '*'; the build output could be committed" >&2
    exit 1
  fi
done

# The nodejs package must stay CommonJS: the root package.json says "type": "module", and only the package's
# own package.json (no "type" field) keeps the glue loadable with require().
if grep -q '"type": *"module"' "$root/server/design/wasm-geometry/package.json"; then
  echo 'wasm-geometry-build: server/design/wasm-geometry/package.json declares "type": "module"; require() would fail' >&2
  exit 1
fi

bytes() { echo $(($(wc -c <"$1"))); }
gzip_bytes() { echo $(($(gzip -9 -c "$1" | wc -c))); }
echo
echo 'wasm-geometry-build: sizes (bytes; KiB = 1024 bytes)'
printf '  %-52s %9s %9s %10s %9s\n' file raw KiB 'gzip -9' KiB
for output in $outputs; do
  dir=${output#*:}
  for file in "$dir/${name}_bg.wasm" "$dir/$name.js"; do
    raw=$(bytes "$root/$file") gz=$(gzip_bytes "$root/$file")
    printf '  %-52s %9d %9s %10d %9s\n' "$file" "$raw" "$(awk -v n="$raw" 'BEGIN { printf "%.1f", n / 1024 }')" \
      "$gz" "$(awk -v n="$gz" 'BEGIN { printf "%.1f", n / 1024 }')"
  done
done

# The budget: the web module is what the editor downloads (lazily: the first load carries none of it).
web=src/design/wasm-geometry
shipped=$(($(gzip_bytes "$root/$web/${name}_bg.wasm") + $(gzip_bytes "$root/$web/$name.js")))
budget=$((budget_kib * 1024))
shipped_kib=$(awk -v n="$shipped" 'BEGIN { printf "%.1f", n / 1024 }')
echo
if ((shipped > budget)); then
  echo "wasm-geometry-build: over budget: the geometry module ships $shipped_kib KiB gzip -9, the budget is $budget_kib KiB" \
    "(MORFA_WASM_GEOMETRY_BUDGET_KIB)" >&2
  exit 1
fi
echo "wasm-geometry-build: budget ok: the geometry module ships $shipped_kib KiB gzip -9 of $budget_kib KiB" \
  "($(awk -v n="$shipped" -v b="$budget" 'BEGIN { printf "%.1f", 100 * n / b }')%)"
