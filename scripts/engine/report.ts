// Sums the engine switch's exit reports (MORFA_ENGINE_REPORT=<file>, shared/design/engine-switch.ts) of one test run
// and checks them: no diff anywhere, and every module the gate names in --require made wasm calls (the fake-green
// guard for the whole suite: a module wired into the switch that never reached wasm fails here).
//
//   npx tsx scripts/engine/report.ts <report.jsonl> [--require geometry,ops] [--max-fallback-share 0.05]
//
// Prints a table per module and per call (ts / wasm / both / fallback / diffs / skipped) the lanes paste into their
// STATUS. `skipped`: calls `both` declined to compare (EngineSkipped), not counted against the fallback share.
import fs from 'node:fs';

type Counts = {ts: number; wasm: number; both: number; fallback: number; diffs: number; skipped?: number};
type Line = {pid: number; modes: Record<string, string>; modules: Record<string, Counts>; calls: Record<string, Counts>; shadow: Record<string, number>};

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: report.ts <report.jsonl> [--require m1,m2] [--max-fallback-share 0.05]');
  process.exit(2);
}
const option = (name: string) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};
const required = (option('--require') ?? '').split(',').filter(Boolean);
const maxFallbackShare = Number(option('--max-fallback-share') ?? '0.05');

const lines: Line[] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Line) : [];
const add = (into: Record<string, Counts>, from: Record<string, Counts>) => {
  for (const [key, counts] of Object.entries(from)) {
    const sum = (into[key] ??= {ts: 0, wasm: 0, both: 0, fallback: 0, diffs: 0, skipped: 0});
    for (const field of Object.keys(sum) as (keyof Counts)[]) sum[field] = (sum[field] ?? 0) + (counts[field] ?? 0);
  }
};
const modules: Record<string, Counts> = {}, calls: Record<string, Counts> = {}, shadow: Record<string, number> = {};
const modes = new Set<string>();
for (const line of lines) {
  add(modules, line.modules);
  add(calls, line.calls);
  for (const [key, value] of Object.entries(line.shadow)) shadow[key] = (shadow[key] ?? 0) + value;
  modes.add(Object.entries(line.modes).map(([module, mode]) => `${module}=${mode}`).join(' '));
}

const row = (name: string, c: Counts) => `  ${name.padEnd(34)} ${String(c.ts).padStart(10)} ${String(c.wasm).padStart(10)} ${String(c.both).padStart(10)} ${String(c.fallback).padStart(9)} ${String(c.diffs).padStart(6)} ${String(c.skipped ?? 0).padStart(8)}`;
const header = `  ${''.padEnd(34)} ${'ts'.padStart(10)} ${'wasm'.padStart(10)} ${'both'.padStart(10)} ${'fallback'.padStart(9)} ${'diffs'.padStart(6)} ${'skipped'.padStart(8)}`;
console.log(`engine report: ${lines.length} processes; modes: ${[...modes].join(' | ') || 'none'}`);
console.log(header);
for (const [name, counts] of Object.entries(modules)) if (counts.ts + counts.wasm) console.log(row(name, counts));
console.log('  per call:');
for (const [name, counts] of Object.entries(calls).sort()) console.log(row(name, counts));
const ms = (key: string) => (shadow[key] ?? 0).toFixed(1);
console.log(`  shadow: ${shadow.loads ?? 0} loads (${ms('loadMs')} ms), ${shadow.patches ?? 0} patches of ${shadow.entries ?? 0} entries (${ms('patchMs')} ms), ${shadow.fullDiffs ?? 0} full comparisons (${ms('diffMs')} ms)`);

const failures: string[] = [];
if (!lines.length) failures.push(`no reports in ${file}: did the run set MORFA_ENGINE_REPORT?`);
for (const [name, counts] of Object.entries(modules)) if (counts.diffs) failures.push(`${name}: ${counts.diffs} diffs`);
for (const name of required) {
  const counts = modules[name];
  if (!counts?.wasm) failures.push(`${name}: no wasm calls (the switch never reached the Rust side)`);
  else if (counts.fallback / (counts.wasm + counts.fallback) > maxFallbackShare)
    failures.push(`${name}: ${counts.fallback} of ${counts.wasm + counts.fallback} calls fell back to TypeScript (over ${maxFallbackShare * 100} %)`);
}
for (const failure of failures) console.error(`engine report: FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
