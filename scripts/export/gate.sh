#!/usr/bin/env bash
# The export test gate: the five export test files in `wasm` and in `both`, each
# process writing the switch's exit report, then scripts/engine/report.ts over them: no diff, the module `export` made
# wasm calls, no fallback (--max-fallback-share 0). Needs scripts/wasm-export-build.sh first.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
out=${MORFA_EXPORT_GATE_DIR:-output/L5}
mkdir -p "$out"
files=(svg-export text-path-export pdf-export render-export panel-layout-export)
status=0
for mode in wasm both; do
  report="$out/gate-$mode.jsonl"
  rm -f "$report"
  for f in "${files[@]}"; do
    if MORFA_ENGINE_EXPORT=$mode MORFA_ENGINE_REPORT="$report" node --import tsx --test "tests/design-$f.test.ts" >"$out/gate-$mode-$f.log" 2>&1; then
      echo "export gate: $mode $f PASS ($(grep -E '^# pass' "$out/gate-$mode-$f.log" | awk '{print $3}') tests)"
    else
      echo "export gate: $mode $f FAIL (log $out/gate-$mode-$f.log)"
      status=1
    fi
  done
  echo "export gate: $mode report"
  npx tsx scripts/engine/report.ts "$report" --require export --max-fallback-share 0 || status=1
done
exit $status
