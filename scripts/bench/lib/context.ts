// What every bench gets from the runner (scripts/bench/targets.ts) and how it runs on its own.
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT, loadTargets, parseOnly, type BenchName, type Machine, type RowResult, type TargetRow} from './targets';
import type {ServerTarget} from './server';

export type BenchContext = {
  machine: Machine;
  /** The rows of this bench that were asked for. */
  rows: TargetRow[];
  /** Short windows (smoke runs, the close.sh dry run). */
  quick: boolean;
  /** Where the server rows run: the dev-4 container, or this machine. */
  target: ServerTarget;
  /** The checkout the servers run from (close.sh: a clean checkout of the hash). */
  source: string;
  /** Raw outputs of this invocation (loadgen reports, server metrics, traces). */
  outDir: string;
  log: (line: string) => void;
  /** Results shared between benches of one invocation (the M5 run feeds D1 and K1–K3). */
  shared: Map<string, unknown>;
  /** ru-net stand-in: tc netem in the dev-4 container. */
  netem: boolean;
};
export type Bench = (ctx: BenchContext) => Promise<RowResult[]>;

export const wants = (ctx: BenchContext, ...ids: string[]) => ids.some(id => ctx.rows.some(row => row.id === id));

/** n.a. for every requested row not in `results`, with `reason`. */
export function fillNa(ctx: BenchContext, results: RowResult[], reason: string): RowResult[] {
  const have = new Set(results.map(result => result.id));
  return [...results, ...ctx.rows.filter(row => !have.has(row.id)).map(row => ({id: row.id, na: reason}))];
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : process.env[`npm_config_${name.replace(/-/g, '_')}`];
}

/** A bench file run directly (`tsx scripts/bench/api.ts --machine dev-4 [--only A1]`): its rows printed as JSON. */
export async function runStandalone(bench: BenchName, run: Bench, moduleUrl: string) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return;
  const machine = (arg('machine') ?? 'dev-4') as Machine;
  const rows = parseOnly(arg('only'), loadTargets().rows.filter(row => row.bench === bench));
  const outDir = path.join(ROOT, 'output/bench', `${bench}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(outDir, {recursive: true});
  const ctx: BenchContext = {
    machine, rows, quick: process.argv.includes('--quick'), target: machine === 'dev-4' ? 'dev-4' : machine === 'bench-ru' ? 'bench-ru' : 'local', source: arg('source') ?? ROOT, outDir,
    log: line => console.error(line), shared: new Map(), netem: !process.argv.includes('--no-netem'),
  };
  const results = await run(ctx);
  console.log(JSON.stringify(results, null, 2));
}
