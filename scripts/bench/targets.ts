// `npm run targets`: every benchmark of docs/TARGETS.md that has code to measure, one table.
//
//   npm run targets -- --machine dev-4 --only M,D,S,A [--runs 3] [--quick] [--no-netem] [--out lanes/targets/baseline-legacy.md]
//   npm run targets --machine laptop --only C,E          (npm passes these as npm_config_*; both spellings work)
//
// Prints `id | scenario | target | ceiling | actual | state | hash` for the rows asked (all by default), writes it to
// lanes/targets/latest.md (and --out), appends the run to lanes/targets/history.jsonl. A row is green at its target, yellow up
// to its ceiling, red past it, n.a. with the reason when nothing can measure it on this code or machine. With --runs N each
// bench runs N times and a number is the median of the runs; the spread (max − min) / median is kept per metric (TARGETS §10:
// 20 % noise margin). A run taken while the 1-minute load average was above 4 is marked provisional.
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {BenchContext, Bench} from './lib/context';
import {gitHash, LoadWatch, machineInfo, PROVISIONAL_LOAD} from './lib/machine';
import {LOADGEN_BOUND_SHARE, LOADGEN_HOST_CORES, loadgenRuns} from './lib/loadgen';
import {median, round, spread} from './lib/stats';
import {ROOT, formatActual, loadTargets, parseOnly, rowState, type BenchName, type Machine, type RowResult, type State, type TargetRow} from './lib/targets';

/** The path a row measured when its bench does not say (lane B5's `--path`). */
function pathOf(bench: BenchName, id: string, measured: 'collab' | 'legacy'): string {
  if (bench === 'api') return ['A2', 'A4'].includes(id) ? 'collab (/session, socket)' : id === 'A3' ? 'collab' : 'api (either path)';
  if (bench === 'codec') return 'Rust codec (S1)';
  if (bench === 'export') return 'render (B4)';
  if (bench === 'canvas' || bench === 'edit-ops') return 'browser';
  return measured === 'collab' ? 'collab' : 'legacy (SSE + PATCH)';
}

const ORDER: BenchName[] = ['collab-load', 'durability', 'open-save', 'api', 'cost', 'codec', 'export', 'canvas', 'edit-ops'];
const MODULES: Record<BenchName, () => Promise<{default: Bench}>> = {
  'collab-load': () => import('./collab-load'),
  durability: () => import('./durability'),
  'open-save': () => import('./open-save'),
  api: () => import('./api'),
  cost: () => import('./cost'),
  codec: () => import('./codec'),
  export: () => import('./export'),
  canvas: () => import('./canvas'),
  'edit-ops': () => import('./edit-ops'),
};

/**
 * Flags come after `--` (`npm run targets -- --machine dev-4 --only M,D`). Without it npm 10 keeps unknown flags as `true`,
 * hands their values over as bare arguments and swallows `--only` (an old npm option) with its value: then a bare machine
 * name is taken, and a run that cannot know its rows refuses to start rather than run all of them.
 */
const positional = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && !['--quick', '--no-netem'].includes(all[i - 1])));
function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  const inline = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const env = process.env[`npm_config_${name.replace(/-/g, '_')}`];
  if (env && env !== 'true') return env;
  if (env === 'true' && name === 'machine') return positional.find(arg => ['laptop', 'dev-4', 'bench-ru'].includes(arg));
  if (env === 'true' && name === 'runs') return positional.find(arg => /^\d+$/.test(arg));
  return undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`) || process.env[`npm_config_${name.replace(/-/g, '_')}`] === 'true';
if (process.env.npm_lifecycle_event === 'targets' && process.env.npm_config_machine === 'true' && !process.argv.includes('--only')) {
  console.error('npm drops `--only <rows>` without `--`: run `npm run targets -- --machine <m> --only <rows>` (or without --only for every row: `npm run targets -- --machine <m>`).');
  process.exit(2);
}

export type MergedRow = RowResult & {runs: RowResult[]; spread: Record<string, number>};

/** Several runs of one row: the median of each metric, a rule row passes when most runs pass. */
export function mergeRuns(row: TargetRow, runs: RowResult[]): MergedRow {
  const measured = runs.filter(run => !run.na);
  if (!measured.length) return {...runs[0], runs, spread: {}};
  const values: Record<string, number> = {};
  const spreads: Record<string, number> = {};
  for (const spec of row.metrics) {
    // Infinity is a measurement (the thing never happened, e.g. a file that never opens); NaN and undefined are not.
    const series = measured.map(run => run.values?.[spec.key]).filter((value): value is number => typeof value === 'number' && !Number.isNaN(value));
    if (!series.length) continue;
    values[spec.key] = median(series);
    if (series.length > 1) spreads[spec.key] = spread(series);
  }
  const passes = measured.filter(run => run.pass !== undefined);
  const provisional = [...new Set(measured.map(run => run.provisional).filter(Boolean))].join('; ') || undefined;
  return {
    id: row.id,
    values: Object.keys(values).length ? values : undefined,
    pass: passes.length ? passes.filter(run => run.pass).length * 2 > passes.length : undefined,
    text: measured[measured.length - 1].text,
    provisional,
    notes: measured[0].notes,
    path: measured[0].path,
    extra: measured.length === 1 ? measured[0].extra : {runs: measured.map(run => run.extra)},
    runs,
    spread: spreads,
  };
}

const escape = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderTable(rows: TargetRow[], merged: Map<string, MergedRow>, hash: string): string {
  // A run that says which path each row measured (lane B5, `--path`) gets a column for it.
  const withPath = rows.some(row => merged.get(row.id)?.path);
  const lines = withPath
    ? ['| id | scenario | path | target | ceiling | actual | state | hash |', '|---|---|---|---|---|---|---|---|']
    : ['| id | scenario | target | ceiling | actual | state | hash |', '|---|---|---|---|---|---|---|'];
  for (const row of rows) {
    const result = merged.get(row.id);
    const state = rowState(row, result);
    const provisional = result && !result.na && result.provisional ? ' (provisional)' : '';
    const noise = result && Object.keys(result.spread ?? {}).length ? ` ±${Object.values(result.spread).map(value => Math.round(value * 100) + '%').join('/')}` : '';
    const pathCell = withPath ? ` ${escape(result?.path ?? '—')} |` : '';
    lines.push(`| ${row.id} | ${escape(row.cells[1])} — ${escape(row.cells[2])} |${pathCell} ${escape(row.cells[3])} | ${escape(row.cells[4])} | ${escape(formatActual(row, result))}${noise} | ${state}${provisional} | ${hash} |`);
  }
  return lines.join('\n');
}

async function main() {
  const targets = loadTargets();
  const machine = (option('machine') ?? 'dev-4') as Machine;
  if (!['laptop', 'dev-4', 'bench-ru'].includes(machine)) throw Error('--machine laptop|dev-4|bench-ru');
  const rows = parseOnly(option('only'), targets.rows);
  const runs = Math.max(1, Number(option('runs') ?? 1));
  const quick = flag('quick');
  const hash = option('hash') ?? gitHash();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(ROOT, 'output/bench', `targets-${machine}-${stamp}`);
  mkdirSync(outDir, {recursive: true});
  const log = (line: string) => console.error(line);
  // On bench-ru itself (scripts/deploy/bench-run.sh sets BENCH_RU_LIVE=1) the rows are measured; anywhere else it is a dry run.
  const live = machine === 'bench-ru' && process.env.BENCH_RU_LIVE === '1';
  // Which path the server rows measure (lane B5): `collab` runs scripts/bench/collab-path.ts for the rows the Rust collab service
  // serves; `legacy` is today's SSE + PATCH. Unset (the dev loop) keeps B0's benches and prints no path column.
  const measuredPath = option('path') as 'collab' | 'legacy' | undefined;
  if (measuredPath && !['collab', 'legacy'].includes(measuredPath)) throw Error('--path collab|legacy');
  const collabBenches = measuredPath === 'collab' ? (await import('./collab-path')).benches : {};
  const profile = process.env.BENCH_PROFILE || '';
  if (machine === 'bench-ru' && !live) {
    log('bench-ru dry run: nothing is measured here. scripts/bench/close.sh <hash> --machine bench-ru deploys and runs on the VM.');
  }
  const benches = ORDER.filter(bench => rows.some(row => row.bench === bench));
  const perRow = new Map<string, RowResult[]>();
  const loads: ReturnType<LoadWatch['result']>[] = [];
  for (let run = 1; run <= runs; run++) {
    const shared = new Map<string, unknown>();
    for (const bench of benches) {
      const benchRows = rows.filter(row => row.bench === bench);
      const ctx: BenchContext = {
        machine, rows: benchRows, quick, target: machine === 'laptop' ? 'local' : machine === 'bench-ru' ? 'bench-ru' : 'dev-4', source: option('source') ?? ROOT,
        outDir: path.join(outDir, `run${run}`), log, shared, netem: !flag('no-netem'),
      };
      mkdirSync(ctx.outDir, {recursive: true});
      log(`── ${bench} (run ${run}/${runs}, ${benchRows.map(row => row.id).join(' ')}) ──`);
      const watch = new LoadWatch();
      const loadgenFrom = loadgenRuns.length;
      let results: RowResult[];
      if (machine === 'bench-ru' && !live) results = benchRows.map(row => ({id: row.id, na: 'dry run (close.sh runs it on bench-ru)'}));
      else {
        try {
          const collabBench = collabBenches[bench];
          results = collabBench ? await collabBench(ctx) : await (await MODULES[bench]()).default(ctx);
          if (measuredPath) results = results.map(result => ({...result, path: result.path ?? pathOf(bench, result.id, measuredPath)}));
        } catch (error) {
          log(`${bench} failed: ${String((error as Error).stack ?? error)}`);
          results = benchRows.map(row => ({id: row.id, na: `bench failed: ${String((error as Error).message ?? error).slice(0, 160)}`}));
        }
      }
      const load = watch.stop();
      loads.push(load);
      // loadgen's own CPU in every run (lane B5): above 70 % of its host's cores the row measures loadgen, not the server.
      const runsOfBench = loadgenRuns.slice(loadgenFrom);
      const busiest = runsOfBench.reduce((max, run) => (run.share > max.share ? run : max), {name: '', cores: 0, share: 0, host: ''});
      // Once per bench (under its first measured row): every loadgen run of the bench and its CPU.
      const first = results.find(result => !result.na);
      if (first && runsOfBench.length) first.notes = [...(first.notes ?? []), `loadgen CPU (${bench}): ${runsOfBench.map(run => `${run.name.replace(/\.json$/, '')} ${run.cores.toFixed(2)}`).join(', ')} cores of ${LOADGEN_HOST_CORES} on ${busiest.host || 'local'}${busiest.share > LOADGEN_BOUND_SHARE ? ' — LOADGEN-BOUND' : ''}`];
      for (const result of results) {
        if (result.na) continue;
        if (busiest.share > LOADGEN_BOUND_SHARE && !(result.extra as {loadgenMarked?: boolean} | undefined)?.loadgenMarked) result.provisional = [result.provisional, `loadgen-bound (${busiest.name}: ${busiest.cores.toFixed(2)} of ${LOADGEN_HOST_CORES} cores)`].filter(Boolean).join('; ');
        // D and S rows on bench-ru measure the MinIO stand-in until a real S3 bucket exists.
        if (live && process.env.BENCH_S3_KIND === 'minio' && /^[DS]\d/.test(result.id)) result.provisional = [result.provisional, 'MinIO stand-in'].filter(Boolean).join('; ');
      }
      for (const result of results) {
        if (!result.na && load.provisional && !result.provisional) result.provisional = `load average up to ${load.max.toFixed(1)}`;
        perRow.set(result.id, [...(perRow.get(result.id) ?? []), result]);
      }
    }
  }
  const merged = new Map<string, MergedRow>();
  for (const row of rows) merged.set(row.id, mergeRuns(row, perRow.get(row.id) ?? [{id: row.id, na: 'no bench result'}]));
  const states = rows.map(row => rowState(row, merged.get(row.id)));
  const count = (state: State) => states.filter(s => s === state).length;
  const info = machineInfo();
  const maxLoad = Math.max(...loads.map(load => load.max));
  const header = [
    `# Targets — ${machine}${profile ? ` (${profile})` : ''}${measuredPath ? `, ${measuredPath} path` : ''}, ${hash}`,
    '',
    ...(measuredPath === 'collab' ? ['Path: the Rust collab service (DESIGN_COLLAB=rust: api\'s /session tickets, the node\'s WebSocket with JSON frames, B2\'s journal in PostgreSQL, checkpoints in S3) for every M/D/S/K row it serves; rows it cannot do yet stay n.a. and say what refuses them. The legacy SSE + PATCH numbers are a separate report (`close.sh --path legacy`).', ''] : []),
    ...(measuredPath === 'legacy' ? ['Path: LEGACY — today\'s Node SSE + PATCH (DESIGN_COLLAB unset) for the M/D/S/K rows, kept for comparison; the closing table is the collab report.', ''] : []),
    ...(live ? [`Profile ${profile || '?'}: ${process.env.BENCH_PROFILE_NOTE || ''}; loadgen on ${process.env.BENCH_LOADGEN_SSH || 'this machine'}; S3: ${process.env.BENCH_S3_KIND || '?'}.`, ''] : []),
    `${new Date().toISOString()} · ${runs} run(s)${quick ? ' (quick windows)' : ''} · ${info.platform}, ${info.cpus} CPUs, ${info.memoryGb} GB, Node ${info.node}`,
    `Load average (1 min) during the benches: max ${maxLoad.toFixed(1)}${maxLoad > PROVISIONAL_LOAD ? ` — above ${PROVISIONAL_LOAD}: numbers are PROVISIONAL` : ''}; first: ${loads[0]?.start ?? '–'}`,
    `Rows: ${count('green')} green, ${count('yellow')} yellow, ${count('red')} red, ${count('n.a.')} n.a. (of ${rows.length}).`,
    '',
  ].join('\n');
  const notes = rows.flatMap(row => merged.get(row.id)?.notes ?? []).map(note => `- ${note}`);
  const provisional = rows.filter(row => merged.get(row.id)?.provisional).map(row => `- ${row.id}: ${merged.get(row.id)!.provisional}`);
  const table = renderTable(rows, merged, hash);
  const markdown = [header, table, '', notes.length ? '## Notes\n\n' + notes.join('\n') : '', provisional.length ? '\n## Provisional\n\n' + provisional.join('\n') : '', ''].join('\n');
  console.log(table);
  console.log(`\n${count('green')} green, ${count('yellow')} yellow, ${count('red')} red, ${count('n.a.')} n.a.; raw outputs in ${path.relative(ROOT, outDir)}`);
  const dir = path.join(ROOT, 'lanes/targets');
  mkdirSync(dir, {recursive: true});
  const out = option('out');
  if (out) writeFileSync(path.resolve(ROOT, out), markdown);
  // A dry run (bench-ru before B5) measures nothing: it leaves latest.md and the history alone.
  const record = (machine !== 'bench-ru' || live) && !flag('no-record');
  if (record) writeFileSync(path.join(dir, 'latest.md'), markdown);
  if (record) appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify({
    date: new Date().toISOString(), machine, ...(profile ? {profile} : {}), hash, runs, quick, load: {max: maxLoad, runs: loads.map(load => load.max)},
    rows: rows.map(row => {
      const result = merged.get(row.id)!;
      return {id: row.id, state: rowState(row, result), values: result.values, pass: result.pass, na: result.na, provisional: result.provisional, spread: result.spread, runs: result.runs.map(r => r.values ?? r.na ?? r.pass)};
    }),
  }) + '\n');
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(Object.fromEntries(merged), null, 1));
  // Rounded numbers for a quick read of the noise.
  for (const row of rows) {
    const result = merged.get(row.id);
    if (result?.spread && Object.keys(result.spread).length) log(`${row.id} spread: ${Object.entries(result.spread).map(([k, v]) => `${k} ${round(v * 100)}%`).join(', ')}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'scripts/bench/targets.ts')) await main();
