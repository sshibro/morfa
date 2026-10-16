#!/usr/bin/env bash
# Lane L3: builds crates/text-wasm (the text engine's own module) twice with wasm-pack, like
# scripts/wasm-build.sh does for crates/wasm:
#   --target web    → src/design/wasm-text/     loaded by the editor when a document with text opens
#   --target nodejs → server/design/wasm-text/  require('./server/design/wasm-text') for the unit tests
# Size first: opt-level z and panic = abort through the profile environment (the workspace profile stays
# the coordinator's), wasm-opt -Oz from the crate's metadata. MORFA_WASM_TEXT_BUDGET_KIB (default 700)
# fails the build above it. MORFA_WASM_TEXT_FEATURES passes extra wasm-pack flags (e.g. --no-default-features).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# From the repository root, so wasm-pack's own rustc and rustup calls get rust-toolchain.toml's toolchain too.
cd "$root"
export CARGO_PROFILE_RELEASE_OPT_LEVEL=${CARGO_PROFILE_RELEASE_OPT_LEVEL:-z} CARGO_PROFILE_RELEASE_PANIC=${CARGO_PROFILE_RELEASE_PANIC:-abort}
budget_kib=${MORFA_WASM_TEXT_BUDGET_KIB:-700}
[[ $budget_kib =~ ^[1-9][0-9]*$ ]] || {
  echo "wasm-text-build: MORFA_WASM_TEXT_BUDGET_KIB must be a whole number of KiB, got '$budget_kib'" >&2
  exit 1
}
command -v wasm-pack >/dev/null || {
  echo 'wasm-text-build: wasm-pack is missing (scripts/cloud-setup.sh, or: cargo binstall -y wasm-pack)' >&2
  exit 1
}

# crate:name:web dir:nodejs dir
modules='text-wasm:morfa_text_wasm:src/design/wasm-text:server/design/wasm-text text-fonts-wasm:morfa_text_fonts_wasm:src/design/wasm-fonts:server/design/wasm-fonts'

for module in $modules; do
  IFS=: read -r crate name web node <<<"$module"
  for output in "web:$web" "nodejs:$node"; do
    target=${output%%:*} dir=${output#*:}
    echo "wasm-text-build: $crate --target $target → $dir"
    wasm-pack build "$root/crates/$crate" --release --target "$target" --out-dir "$root/$dir" --out-name "$name" ${MORFA_WASM_TEXT_FEATURES:-}
    for file in "$dir/$name.js" "$dir/${name}_bg.wasm" "$dir/package.json"; do
      [[ -f $root/$file ]] || { echo "wasm-text-build: $file was not written" >&2; exit 1; }
    done
    if [[ $(cat "$root/$dir/.gitignore" 2>/dev/null) != '*' ]]; then
      echo "wasm-text-build: $dir/.gitignore does not contain exactly '*'; the build output could be committed" >&2
      exit 1
    fi
  done
done

# The nodejs package must stay CommonJS: the root package.json says "type": "module", and only the package's
# own package.json (no "type" field) keeps morfa_wasm.js loadable with require().
for dir in server/design/wasm-text server/design/wasm-fonts; do
  if grep -q '"type": *"module"' "$root/$dir/package.json"; then
    echo "wasm-text-build: $dir/package.json declares \"type\": \"module\"; require() would fail" >&2
    exit 1
  fi
done

bytes() { echo $(($(wc -c <"$1"))); }
gzip_bytes() { echo $(($(gzip -9 -c "$1" | wc -c))); }
echo
echo 'wasm-text-build: sizes (bytes; KiB = 1024 bytes)'
printf '  %-46s %9s %9s %10s %9s\n' file raw KiB 'gzip -9' KiB
for module in $modules; do
  IFS=: read -r crate name web node <<<"$module"
  for dir in "$web" "$node"; do
    for file in "$dir/${name}_bg.wasm" "$dir/$name.js"; do
      raw=$(bytes "$root/$file") gz=$(gzip_bytes "$root/$file")
      printf '  %-46s %9d %9s %10d %9s\n' "$file" "$raw" "$(awk -v n="$raw" 'BEGIN { printf "%.1f", n / 1024 }')" \
        "$gz" "$(awk -v n="$gz" 'BEGIN { printf "%.1f", n / 1024 }')"
    done
  done
done

# The budget applies to each lazily loaded module on its own; the editor's first load carries neither.
budget=$((budget_kib * 1024))
echo
for module in $modules; do
  IFS=: read -r crate name web node <<<"$module"
  shipped=$(($(gzip_bytes "$root/$web/${name}_bg.wasm") + $(gzip_bytes "$root/$web/$name.js")))
  shipped_kib=$(awk -v n="$shipped" 'BEGIN { printf "%.1f", n / 1024 }')
  if ((shipped > budget)); then
    echo "wasm-text-build: over budget: $crate ships $shipped_kib KiB gzip -9, the budget is $budget_kib KiB (MORFA_WASM_TEXT_BUDGET_KIB)" >&2
    exit 1
  fi
  echo "wasm-text-build: budget ok: $crate ships $shipped_kib KiB gzip -9 of $budget_kib KiB ($(awk -v n="$shipped" -v b="$budget" 'BEGIN { printf "%.1f", 100 * n / b }')%)"
done
