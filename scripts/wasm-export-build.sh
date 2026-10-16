#!/usr/bin/env bash
# The export module (crates/export-wasm: SVG and the vector PDF), a module of its own like crates/geometry-wasm
# (so the editor's first load carries none of it). Built twice:
#   --target web    → src/design/wasm-export/     loaded by the editor when something is exported with the switch's
#                                                 module `export` at wasm/both (src/design/engine/export-wasm.ts)
#   --target nodejs → server/design/wasm-export/  required on first use in Node (shared/design/export-wasm.ts;
#                                                 MORFA_WASM_EXPORT_PATH overrides the path)
# Features: the nodejs build has `pdf` (the vector PDF, and `fonts`: outline text and the PDF's embedded fonts, the
# text store, harfrust, skrifa, ≈ +520 KiB gzip), the web build none (SVG; MORFA_WASM_EXPORT_WEB_FEATURES / MORFA_WASM_EXPORT_NODE_FEATURES
# override). MORFA_WASM_EXPORT_BUDGET_KIB (default 600) fails the build when the web module, .wasm and JS glue gzip -9,
# is above it (lazily loaded). Outputs are never committed (wasm-pack's `*` .gitignore).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# From the repository root, so wasm-pack's own rustc and rustup calls get rust-toolchain.toml's toolchain too.
cd "$root"
budget_kib=${MORFA_WASM_EXPORT_BUDGET_KIB:-600}
web_features=${MORFA_WASM_EXPORT_WEB_FEATURES-}
node_features=${MORFA_WASM_EXPORT_NODE_FEATURES-pdf}
[[ $budget_kib =~ ^[1-9][0-9]*$ ]] || {
  echo "wasm-export-build: MORFA_WASM_EXPORT_BUDGET_KIB must be a whole number of KiB, got '$budget_kib'" >&2
  exit 1
}
command -v wasm-pack >/dev/null || {
  echo 'wasm-export-build: wasm-pack is missing (scripts/cloud-setup.sh, or: cargo binstall -y wasm-pack)' >&2
  exit 1
}

name=morfa_export_wasm
outputs='web:src/design/wasm-export nodejs:server/design/wasm-export'

for output in $outputs; do
  target=${output%%:*} dir=${output#*:}
  if [[ $target == web ]]; then features=$web_features; else features=$node_features; fi
  echo "wasm-export-build: wasm-pack --target $target → $dir (features: ${features:-none})"
  # The server's build is optimised for speed (opt-level 3), the editor's for size (the workspace's "s").
  if [[ $target == nodejs ]]; then opt=${MORFA_WASM_EXPORT_NODE_OPT:-3}; else opt=${MORFA_WASM_EXPORT_WEB_OPT:-s}; fi
  CARGO_PROFILE_RELEASE_OPT_LEVEL=$opt wasm-pack build "$root/crates/export-wasm" --release --target "$target" --out-dir "$root/$dir" --out-name "$name" -- ${features:+--features "$features"}
  for file in "$dir/$name.js" "$dir/${name}_bg.wasm" "$dir/package.json"; do
    [[ -f $root/$file ]] || { echo "wasm-export-build: $file was not written" >&2; exit 1; }
  done
  if [[ $(cat "$root/$dir/.gitignore" 2>/dev/null) != '*' ]]; then
    echo "wasm-export-build: $dir/.gitignore does not contain exactly '*'; the build output could be committed" >&2
    exit 1
  fi
done

# The nodejs package must stay CommonJS: the root package.json says "type": "module", and only the package's
# own package.json (no "type" field) keeps the glue loadable with require().
if grep -q '"type": *"module"' "$root/server/design/wasm-export/package.json"; then
  echo 'wasm-export-build: server/design/wasm-export/package.json declares "type": "module"; require() would fail' >&2
  exit 1
fi

bytes() { echo $(($(wc -c <"$1"))); }
gzip_bytes() { echo $(($(gzip -9 -c "$1" | wc -c))); }
echo
echo 'wasm-export-build: sizes (bytes; KiB = 1024 bytes)'
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
web=src/design/wasm-export
shipped=$(($(gzip_bytes "$root/$web/${name}_bg.wasm") + $(gzip_bytes "$root/$web/$name.js")))
budget=$((budget_kib * 1024))
shipped_kib=$(awk -v n="$shipped" 'BEGIN { printf "%.1f", n / 1024 }')
echo
if ((shipped > budget)); then
  echo "wasm-export-build: over budget: the export module ships $shipped_kib KiB gzip -9, the budget is $budget_kib KiB" \
    "(MORFA_WASM_EXPORT_BUDGET_KIB)" >&2
  exit 1
fi
echo "wasm-export-build: budget ok: the export module ships $shipped_kib KiB gzip -9 of $budget_kib KiB" \
  "($(awk -v n="$shipped" -v b="$budget" 'BEGIN { printf "%.1f", 100 * n / b }')%)"
