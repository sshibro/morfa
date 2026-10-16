#!/usr/bin/env bash
# The renderer's real-GPU numbers in one command, on a machine with a GPU (Chrome/Chromium with WebGPU — the cloud
# containers have no GPU): TARGETS C1–C4 and C10 through the whole editor (scripts/bench/canvas.ts, the bench on the
# laptop stand-in, Canvas2D then the GPU renderer behind ?engine=render:wasm) and C1–C4 + C11 from the renderer's own
# side (scripts/goldens/gpu-bench.ts: the real scene renderer on generated pages of 20k / 100k / 500k layers).
#
#   scripts/bench/l4-gpu.sh                 everything (≈ 25 min: two canvas.ts passes of ~8 min, gpu-bench ~6 min)
#   scripts/bench/l4-gpu.sh --quick         shorter pans (canvas.ts --quick, gpu-bench 4 s a row)
#   scripts/bench/l4-gpu.sh --only C1,C2    canvas.ts rows (default C1,C2,C4,C10); gpu-bench always runs its five
#   scripts/bench/l4-gpu.sh --skip-editor   gpu-bench only (no editor build, no bench files)
#
# Writes output/l4-gpu/canvas-{canvas2d,gpu}-<time>.json (canvas.ts rows, notes name the scene renderer that drew) and
# output/l4-gpu/gpu-bench-<time>.json (output/ is gitignored), and prints both. Rules (docs/TARGETS.md §10): a quiet machine (load under 2),
# three runs to close a row; the laptop is the stand-in, so these are dev-loop numbers unless MORFA_BENCH_CLOSING=1.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
export PATH="${HOME}/.nvm/versions/node/v22.23.2/bin:${HOME}/.cargo/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/morfa-target/L4}"

quick='' only='C1,C2,C4,C10' editor=1
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) quick=1 ;;
    --only) only="$2"; shift ;;
    --only=*) only="${1#--only=}" ;;
    --skip-editor) editor='' ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "l4-gpu: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n== l4-gpu: %s\n' "$*"; }
for tool in node npx cargo wasm-pack; do
  command -v "$tool" >/dev/null || { echo "l4-gpu: $tool is missing (docs/dev.md §Rust)" >&2; exit 1; }
done
load=$(uptime | sed -n 's/.*load averages*: *\([0-9.,]*\).*/\1/p' | tr ',' '.' | cut -d' ' -f1)
echo "l4-gpu: $(uname -m) $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -s), load ${load:-?} (TARGETS §10 wants a quiet machine)"
stamp=$(date -u +%Y-%m-%dT%H-%M-%S)
out="$root/output/l4-gpu"
mkdir -p "$out"

say 'the renderer module (scripts/wasm-render-build.sh)'
bash scripts/wasm-render-build.sh

if [ -n "$editor" ]; then
  say 'bench files (fixtures/bench: f20k, f100k, …)'
  [ -f fixtures/bench/f100k.json ] && [ -f fixtures/bench/f20k.json ] || npm run bench:files
  say "canvas.ts rows $only with Canvas2D (the default scene renderer)"
  npx tsx scripts/bench/canvas.ts --machine laptop --only "$only" ${quick:+--quick} | tee "$out/canvas-canvas2d-$stamp.json"
  say "canvas.ts rows $only with the GPU renderer (?engine=render:wasm)"
  BENCH_ENGINE=render:wasm npx tsx scripts/bench/canvas.ts --machine laptop --only "$only" ${quick:+--quick} | tee "$out/canvas-gpu-$stamp.json"
fi

say 'gpu-bench.ts: the scene renderer alone on 20k / 100k / 500k layers (C1–C4, C3 and C11 from the renderer side)'
npx tsx scripts/goldens/gpu-bench.ts ${quick:+--ms 4000}

say "done — results in output/l4-gpu/*-$stamp.json and gpu-bench-*.json"
