#!/usr/bin/env bash
# Lane L1's pass condition, part 1: the 12 geometry test files in `wasm` and `both` mode through the lane's engine hooks
# (scripts/geometry/engine-register.mjs) and S2's switch (shared/design/engine-switch.ts) together. Prints one row per
# file and mode: tests passed/failed, WASM calls answered by the lane's harness build, by crates/wasm through S2's
# switch (localMatrix, worldBox), fallbacks and diffs. Exits 1 when any file fails or makes no WASM call.
#
#   scripts/geometry/build.sh && scripts/wasm-build.sh && scripts/wasm-geometry-build.sh && scripts/geometry/gate.sh [wasm both]
set -uo pipefail
cd "$(dirname "$0")/../.."
modes=("$@")
[[ $# -eq 0 ]] && modes=(wasm both)
files=(bounds paths boolean boolean-commands flatten outline-stroke shapes hit-test snapping render-index stroke-profile perf)
status=0
printf '%-5s %-17s %6s %6s %10s %10s %9s %6s\n' mode file pass fail harness s2-switch fallback diffs
for mode in "${modes[@]}"; do
  for f in "${files[@]}"; do
    out=$(MORFA_ENGINE_GEOMETRY=$mode MORFA_ENGINE_REPORT=1 node --import ./scripts/geometry/engine-register.mjs --test "tests/design-$f.test.ts" 2>&1)
    # perl, not grep -P: macOS's grep has no Perl regexes.
    pass=$(perl -lne 'print $1 if /^# pass (\d+)/' <<<"$out" | tail -1)
    fail=$(perl -lne 'print $1 if /^# fail (\d+)/' <<<"$out" | tail -1)
    line=$(perl -lne 'print $1 if /engine\(geometry=\w+\): wasm (.*)/' <<<"$out" | tail -1)
    harness=$(perl -lne 'print $1 if /^(\d+)/' <<<"$line")
    fallback=$(perl -lne 'print $1 if /fallback (\d+)/' <<<"$line" | head -1)
    s2=$(perl -lne 'print $1 if /S2 switch \(crates\/wasm\) wasm (\d+)/' <<<"$line")
    diffs=$(perl -lne 'print $1 if /diffs (\d+)/' <<<"$line")
    printf '%-5s %-17s %6s %6s %10s %10s %9s %6s\n' "$mode" "$f" "${pass:-?}" "${fail:-?}" "${harness:-?}" "${s2:-?}" "${fallback:-?}" "${diffs:-?}"
    if [[ "${fail:-1}" != 0 || -z "${pass:-}" || $(( ${harness:-0} + ${s2:-0} )) -eq 0 ]]; then status=1; fi
  done
done
exit $status
