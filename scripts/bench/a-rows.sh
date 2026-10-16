#!/usr/bin/env bash
# The A rows of docs/TARGETS.md §7 (lane A7) in one command: for each api process count, scripts/bench/api.ts --only A1,A2,A4,A5
# `--runs` times, then lanes/targets/a-rows-<hash>[-<label>].md with every run's values, the medians, the load average and the
# shape. For lane B5 on bench-ru (run there as the bench user, like scripts/deploy/remote/bench-close.sh), and for any machine
# with the lane's PostgreSQL test cluster (BENCH_PG_STATE, docs/dev.md) and morfa-collab built (MORFA_COLLAB_BIN or
# CARGO_TARGET_DIR; without it A2/A4 fall back to B0's legacy analogs).
#
#   scripts/bench/a-rows.sh [--runs 3] [--processes "1 2"] [--machine bench-ru] [--server-cpus 0-3] [--harness-cpus 4-7]
#                           [--label cores4] [--quick] [--legacy]
#
# --processes: BENCH_API_PROCESSES per pass. 1 is B0's single api process; 2 is production's shape (deploy/systemd/morfa-api@,
#   MORFA_API_UPSTREAMS of deploy/env/caddy.env.example), node:cluster on one port instead of Caddy in front.
# --server-cpus / --harness-cpus: bench-close.sh's cores4 profile (server and PostgreSQL on 0-3, the harness on 4-7). The
#   harness runs under taskset; the server's pin is BENCH_SERVER_CPUS, which scripts/bench/lib/server.ts applies for
#   --machine bench-ru once lane B5's harness is merged (before that the server inherits the harness's cores: say so).
# Numbers are provisional unless the machine is bench-ru and the 1-minute load stayed under 4 (TARGETS §10).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"
runs=3 processes="1 2" machine=bench-ru server_cpus="" harness_cpus="" label="" extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) runs="$2"; shift 2 ;;
    --processes) processes="$2"; shift 2 ;;
    --machine) machine="$2"; shift 2 ;;
    --server-cpus) server_cpus="$2"; shift 2 ;;
    --harness-cpus) harness_cpus="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --quick) extra+=(--quick); shift ;;
    --legacy) extra+=(--legacy); shift ;;
    *) sed -n '2,20p' "$0" >&2; exit 2 ;;
  esac
done
hash="$(git rev-parse --short=9 HEAD)"
dirty=""; git diff --quiet HEAD -- server scripts shared || dirty=" (uncommitted changes in server/, scripts/ or shared/)"
out="lanes/targets/a-rows-${hash}${label:+-$label}.md"
work="$(mktemp -d "${TMPDIR:-/tmp}/morfa-a-rows-XXXX")"
trap 'rm -rf "$work"' EXIT
pin=(); [ -n "$harness_cpus" ] && pin=(taskset -c "$harness_cpus")
echo "a-rows: ${hash}${dirty} on ${machine}; processes ${processes}; ${runs} runs; $(uptime)" >&2
for n in $processes; do
  for r in $(seq 1 "$runs"); do
    before="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || uptime | sed 's/.*averages*: *//; s/,.*//')"
    echo "a-rows: ${n} process(es), run ${r}/${runs} (load ${before})" >&2
    BENCH_API_PROCESSES="$n" BENCH_SERVER_CPUS="$server_cpus" ${pin[@]+"${pin[@]}"} \
      npx tsx scripts/bench/api.ts --machine "$machine" --only A1,A2,A4,A5 ${extra[@]+"${extra[@]}"} >"$work/p${n}-r${r}.out" 2>"$work/p${n}-r${r}.log" ||
      { echo "a-rows: api.ts failed, see below" >&2; tail -30 "$work/p${n}-r${r}.log" >&2; exit 1; }
    after="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo "?")"
    echo "${before} ${after}" >"$work/p${n}-r${r}.load"
  done
done
node - "$work" "$out" "$hash$dirty" "$machine on $(hostname)" "$processes" "$runs" "${server_cpus:-unpinned}" "${harness_cpus:-unpinned}" <<'EOF'
const fs = require('node:fs');
const [work, out, hash, machine, processes, runs, serverCpus, harnessCpus] = process.argv.slice(2);
const targets = {A1: 'p95 ≤ 80 / p99 ≤ 150 ms (ceiling 150 / 300)', A2: 'p95 ≤ 20 ms (ceiling 50)', A4: '≤ 2 s (ceiling 20 s)', A5: 'p95 ≤ 100 ms (ceiling 250)'};
const target = {A1: {p95: [80, 150], p99: [150, 300]}, A2: {p95: [20, 50]}, A4: {wall: [2000, 20000]}, A5: {p95: [100, 250]}};
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const lines = [`# A rows — --machine ${machine}, ${hash}`, '', `${new Date().toISOString()}; server cores ${serverCpus}, harness cores ${harnessCpus}; ${runs} runs per process count (scripts/bench/a-rows.sh).`,
  'A row is green at its target, yellow up to its ceiling, red past it; numbers off bench-ru, or with a load above 4, are provisional (TARGETS §10).', ''];
for (const n of processes.split(/\s+/).filter(Boolean)) {
  const results = [], loads = [];
  for (let r = 1; r <= Number(runs); r++) {
    const text = fs.readFileSync(`${work}/p${n}-r${r}.out`, 'utf8');
    results.push(JSON.parse(text.slice(text.indexOf('['))));
    loads.push(fs.readFileSync(`${work}/p${n}-r${r}.load`, 'utf8').trim().split(' ').map(Number));
  }
  const maxLoad = Math.max(...loads.flat().filter(Number.isFinite));
  lines.push(`## ${n} api process${n === '1' ? '' : 'es'} (load average up to ${maxLoad.toFixed(1)}${maxLoad > 4 ? ': provisional' : ''})`, '', '| Row | Target | Runs | Median | State |', '|---|---|---|---|---|');
  for (const id of ['A1', 'A2', 'A4', 'A5']) {
    const rows = results.map(result => result.find(row => row.id === id)).filter(Boolean);
    if (!rows.length) continue;
    if (rows.some(row => !row.values)) { lines.push(`| ${id} | ${targets[id]} | ${rows.map(row => row.na ?? 'n.a.').join('; ')} | n.a. | n.a. |`); continue; }
    const keys = Object.keys(rows[0].values);
    const med = Object.fromEntries(keys.map(key => [key, median(rows.map(row => row.values[key]))]));
    const state = keys.every(key => !target[id][key] || med[key] <= target[id][key][0]) ? 'green' : keys.every(key => !target[id][key] || med[key] <= target[id][key][1]) ? 'yellow' : 'red';
    const fmt = values => keys.map(key => `${key} ${values[key].toFixed(1)}`).join(' / ');
    lines.push(`| ${id} | ${targets[id]} | ${rows.map(row => fmt(row.values)).join(' · ')} | ${fmt(med)} | ${state} |`);
  }
  lines.push('', ...results.flatMap(result => result.flatMap(row => row.notes ?? [])).filter((note, i, all) => all.indexOf(note) === i).slice(0, 8).map(note => `- ${note}`), '');
}
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.error(`a-rows: wrote ${out}`);
EOF
