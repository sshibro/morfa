// Puts a baseline together from runs of targets.ts (lanes/targets/baseline-legacy.md): the server rows' report (dev-4), the client
// rows' report (laptop), and a table of the same rows across several full runs from lanes/targets/history.jsonl, so the noise
// of the shared machine is in plain view.
//
//   tsx scripts/bench/baseline.ts --list
//   tsx scripts/bench/baseline.ts --server lanes/targets/baseline-legacy-dev4.md --client lanes/targets/baseline-legacy-laptop.md \
//     --compare 7,10,11 --out lanes/targets/baseline-legacy.md [--title "…"]
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {ROOT, formatActual, loadTargets, rowState, type RowResult} from './lib/targets';

type HistoryRow = {id: string; state: string; values?: Record<string, number | null>; pass?: boolean; na?: string; provisional?: string};
type HistoryEntry = {date: string; machine: string; hash: string; runs: number; quick?: boolean; load: {max: number}; rows: HistoryRow[]};

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const history = readFileSync(path.join(ROOT, 'lanes/targets/history.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as HistoryEntry);

if (process.argv.includes('--list')) {
  history.forEach((entry, i) => console.log(`${i}\t${entry.date}\t${entry.machine}\t${entry.hash}\t${entry.quick ? 'quick' : 'full'}\truns ${entry.runs}\tload ${entry.load.max.toFixed(1)}\t${entry.rows.length} rows`));
  process.exit(0);
}

const targets = loadTargets();
const compare = (arg('compare') ?? '').split(',').filter(Boolean).map(Number).map(i => history[i]);
const read = (file?: string) => (file ? readFileSync(path.resolve(ROOT, file), 'utf8') : '');
const demote = (markdown: string) => markdown.replace(/^# /m, '### ').replace(/^## /gm, '#### ');
const server = read(arg('server')), client = read(arg('client'));

const lines: string[] = [];
lines.push(`# ${arg('title') ?? 'Baseline — the legacy server (SSE + PATCH) and today\'s editor'}`, '');
lines.push('Every number below is the dev loop\'s (TARGETS §10): dev-4 is a 4-CPU Docker container on the shared Mac, the laptop is the', 'stand-in (this Mac, Chromium at 2× CPU throttle). The Mac\'s load average stayed above 4 all night (other lanes\' builds', 'ran beside these runs), so every measured row is provisional; closing numbers come from bench-ru and an M1-class laptop.', '');
if (compare.length) {
  lines.push('## The same rows across full runs', '');
  lines.push(`| id | ${compare.map(entry => `${entry.machine} ${entry.hash} (${entry.date.slice(11, 16)} UTC, load ≤ ${entry.load.max.toFixed(0)})`).join(' | ')} |`);
  lines.push(`|---|${compare.map(() => '---').join('|')}|`);
  const ids = targets.rows.map(row => row.id).filter(id => compare.some(entry => entry.rows.some(row => row.id === id && !row.na)));
  for (const id of ids) {
    const spec = targets.rows.find(row => row.id === id)!;
    const cells = compare.map(entry => {
      const found = entry.rows.find(row => row.id === id);
      if (!found) return '–';
      const result: RowResult = {id, values: found.values ? Object.fromEntries(Object.entries(found.values).map(([k, v]) => [k, v === null ? Infinity : v])) : undefined, pass: found.pass, na: found.na};
      const text = found.na ? 'n.a.' : found.pass !== undefined && !found.values ? (found.pass ? 'pass' : 'fail') : formatActual(spec, result);
      return `${text} (${rowState(spec, result)})`;
    });
    lines.push(`| ${id} | ${cells.join(' | ')} |`);
  }
  lines.push('', '`∞`/null: never happened in the run (C7: the file never opens).', '');
}
if (server) lines.push('## Server rows (dev-4)', '', demote(server).trim(), '');
if (client) lines.push('## Client rows (laptop stand-in)', '', demote(client).trim(), '');
const out = arg('out');
if (!out) {
  console.log(lines.join('\n'));
} else {
  writeFileSync(path.resolve(ROOT, out), lines.join('\n') + '\n');
  console.log(`wrote ${out}`);
}
