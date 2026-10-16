import assert from 'node:assert/strict';
import {ENGINE_MODULES, engineFor} from '../../shared/design/engine-switch';

// Time budgets of the design tests, scaled by how fast this machine runs a fixed piece of work right now, so a slower or
// busy machine (CI, a laptop running other suites) gets proportionally more time instead of a flaky failure. The budgets
// themselves are those of the reference machine; work counts, where a test has them, stay exact.

/** This loop takes about REFERENCE_MS on the machine the budgets were set on, when it is not busy. */
const REFERENCE_MS = 15;

function referenceLoop(): number {
  const started = performance.now();
  const table: Record<string, {id: string; x: number; y: number}> = {};
  for (let i = 0; i < 20000; i++) table[`k${i}`] = {id: `k${i}`, x: i, y: i / 2};
  const keys = Object.keys(table);
  const copy: typeof table = {};
  for (const key of keys) copy[key] = table[key];
  const moved = new Map<string, {id: string; x: number; y: number}>();
  for (const key of keys) moved.set(key, {...copy[key], x: copy[key].x + 1});
  let sum = 0;
  for (let i = 0; i < 300000; i++) sum += Math.sqrt(i) * Math.sin(i);
  assert.ok(moved.size && Number.isFinite(sum));
  return performance.now() - started;
}

/** How much slower than the reference this machine is right now (at least 1). Measured afresh on every call: a shared
 *  machine slows down and recovers while a suite runs, so the factor is taken next to the work it excuses. */
export function speedFactor(runs = 3): number {
  let best = Infinity;
  for (let run = 0; run < runs; run++) best = Math.min(best, referenceLoop());
  return Math.max(1, best / REFERENCE_MS);
}

/** In the engine switch's `both` mode (shared/design/engine-switch.ts) every ported call runs twice and is compared:
 *  the oracle's time is not the product's, so budgets stretch by this much (the wasm engine's own speed is measured by
 *  scripts/bench, in `wasm` mode). 5 since the normalize pipeline flips as one unit: `both` runs the
 *  whole pipeline in TypeScript and in Rust and compares every written entry, and the Rust pipeline is still slower
 *  end to end. The `ts` budgets are unchanged. */
export const BOTH_MODE_FACTOR = 5;
const engineFactor = () => (ENGINE_MODULES.some(module => engineFor(module) === 'both') ? BOTH_MODE_FACTOR : 1);

/** `ms` on the reference machine, scaled to this machine as it runs now. */
export const budget = (ms: number) => ms * speedFactor() * engineFactor();
