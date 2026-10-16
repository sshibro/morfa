#!/usr/bin/env bash
# wasm32 release size of each candidate alone (the probe export keeps parse + shape + outline alive),
# after wasm-opt -Os, raw and gzip -9. Usage: wasm-sizes.sh [features…]
set -euo pipefail
cd "$(dirname "$0")"
opt=$(ls -d ~/Library/Caches/.wasm-pack/wasm-opt-*/bin/wasm-opt 2>/dev/null | head -1)
features=${*:-rb hr sw ct pl woff2 wuff}
printf '| Feature | raw bytes | wasm-opt -Os bytes | gzip -9 bytes | KiB gzip |\n|---|---|---|---|---|\n'
for f in $features; do
  cargo build --lib --release --target wasm32-unknown-unknown --features "$f" >/dev/null 2>"/tmp/bakeoff-$f.log" || { echo "| $f | build failed (see /tmp/bakeoff-$f.log) | | | |"; continue; }
  wasm="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/morfa_text_bakeoff.wasm"
  raw=$(wc -c <"$wasm")
  if [[ -n $opt ]]; then "$opt" -Os "$wasm" -o "/tmp/bakeoff-$f.wasm"; else cp "$wasm" "/tmp/bakeoff-$f.wasm"; fi
  o=$(wc -c <"/tmp/bakeoff-$f.wasm"); g=$(gzip -9 -c "/tmp/bakeoff-$f.wasm" | wc -c)
  printf '| %s | %d | %d | %d | %.1f |\n' "$f" "$raw" "$o" "$g" "$(awk -v n="$g" 'BEGIN{print n/1024}')"
done
