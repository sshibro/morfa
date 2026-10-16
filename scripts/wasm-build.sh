#!/usr/bin/env bash
# Builds crates/wasm twice with wasm-pack (docs/dev.md §Rust):
#   --target web    → src/design/wasm/     ES module + .wasm for the editor (Vite)
#   --target nodejs → server/design/wasm/  CommonJS package for the server and the unit tests,
#                                          require('./server/design/wasm') from the repository root
# Both are build outputs, never committed: wasm-pack writes a `.gitignore` containing `*` into each directory,
# and this script fails if that file is missing. Prints the size of each .wasm and JS glue, raw and gzip -9.
# Size budget: what the editor ships of the engine (the web .wasm and its JS glue, gzip -9) must fit
# MORFA_WASM_BUDGET_KIB, by default the editor's whole 700 KiB ceiling (`designEditor` in
# scripts/performance/budgets.mjs); the build fails above it.
# Uses CARGO_TARGET_DIR when set; runs from any directory.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# From the repository root, so wasm-pack's own rustc and rustup calls get rust-toolchain.toml's toolchain too.
cd "$root"
budget_kib=${MORFA_WASM_BUDGET_KIB:-700}
[[ $budget_kib =~ ^[1-9][0-9]*$ ]] || {
  echo "wasm-build: MORFA_WASM_BUDGET_KIB must be a whole number of KiB, got '$budget_kib'" >&2
  exit 1
}
command -v wasm-pack >/dev/null || {
  echo 'wasm-build: wasm-pack is missing (scripts/cloud-setup.sh, or: cargo binstall -y wasm-pack)' >&2
  exit 1
}

name=morfa_wasm
outputs='web:src/design/wasm nodejs:server/design/wasm'

for output in $outputs; do
  target=${output%%:*} dir=${output#*:}
  echo "wasm-build: wasm-pack --target $target → $dir"
  # The server's build adds what only api calls (crates/wasm feature `server`: the store journal entries of collab's rows),
  # which the editor's build does not ship.
  features=()
  [[ $target == nodejs ]] && features=(-- --features server)
  # The server's build at opt-level 3 (the workspace's release profile is `s` for the browser's size budget): the api's
  # whole-document fast path (TARGETS S5, crates/wasm/src/server_document.rs) reads 80 MB 26 % faster (1.69 → 1.25 s).
  opt=()
  [[ $target == nodejs ]] && opt=(env CARGO_PROFILE_RELEASE_OPT_LEVEL=3)
  # wasm-pack resolves --out-dir against the crate, so it gets an absolute path. The `${a[@]+…}` form is for macOS's bash 3.2,
  # where an empty array under `set -u` is an unbound variable.
  ${opt[@]+"${opt[@]}"} wasm-pack build "$root/crates/wasm" --release --target "$target" --out-dir "$root/$dir" --out-name "$name" ${features[@]+"${features[@]}"}
  for file in "$dir/$name.js" "$dir/${name}_bg.wasm" "$dir/package.json"; do
    [[ -f $root/$file ]] || { echo "wasm-build: $file was not written" >&2; exit 1; }
  done
  # The outputs stay out of git through wasm-pack's own `*` ignore file (the root .gitignore is P1d's).
  if [[ $(cat "$root/$dir/.gitignore" 2>/dev/null) != '*' ]]; then
    echo "wasm-build: $dir/.gitignore does not contain exactly '*'; the build output could be committed" >&2
    exit 1
  fi
done

# The nodejs package must stay CommonJS: the root package.json says "type": "module", and only the package's
# own package.json (no "type" field) keeps morfa_wasm.js loadable with require().
if grep -q '"type": *"module"' "$root/server/design/wasm/package.json"; then
  echo 'wasm-build: server/design/wasm/package.json declares "type": "module"; require() would fail' >&2
  exit 1
fi

bytes() { echo $(($(wc -c <"$1"))); }
gzip_bytes() { echo $(($(gzip -9 -c "$1" | wc -c))); }
echo
echo 'wasm-build: sizes (bytes; KiB = 1024 bytes)'
printf '  %-38s %9s %9s %10s %9s\n' file raw KiB 'gzip -9' KiB
for output in $outputs; do
  dir=${output#*:}
  for file in "$dir/${name}_bg.wasm" "$dir/$name.js"; do
    raw=$(bytes "$root/$file") gz=$(gzip_bytes "$root/$file")
    printf '  %-38s %9d %9s %10d %9s\n' "$file" "$raw" "$(awk -v n="$raw" 'BEGIN { printf "%.1f", n / 1024 }')" \
      "$gz" "$(awk -v n="$gz" 'BEGIN { printf "%.1f", n / 1024 }')"
  done
done

# The budget: the web build is what the editor downloads.
shipped=$(($(gzip_bytes "$root/src/design/wasm/${name}_bg.wasm") + $(gzip_bytes "$root/src/design/wasm/$name.js")))
budget=$((budget_kib * 1024))
shipped_kib=$(awk -v n="$shipped" 'BEGIN { printf "%.1f", n / 1024 }')
echo
if ((shipped > budget)); then
  echo "wasm-build: over budget: the web build ships $shipped_kib KiB gzip -9, the budget is $budget_kib KiB" \
    "(MORFA_WASM_BUDGET_KIB)" >&2
  exit 1
fi
echo "wasm-build: budget ok: the web build ships $shipped_kib KiB gzip -9 of $budget_kib KiB" \
  "($(awk -v n="$shipped" -v b="$budget" 'BEGIN { printf "%.1f", 100 * n / b }')%)"
