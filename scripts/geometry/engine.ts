// Lane L1: the per-call switch the engine hooks (engine-hooks.mjs) put behind the wired geometry exports, until
// S2's shared/design/engine-switch.ts exists. MORFA_ENGINE_GEOMETRY:
//   ts    the TypeScript only (the hooks are not even installed);
//   wasm  the WASM build answers;
//   both  both answer and must agree (numbers to 1e-9 relative, areas to 1e-6 of their box), the TS answer is used.
// Counters per function are printed at exit (MORFA_ENGINE_REPORT=1), and a process that made no WASM call exits 1.
// Inputs the model cannot represent (a partial node object a test builds by hand,
// a document that does not parse) go to the TypeScript and are counted as `fallback`, never silently.

import polygonClipping from 'polygon-clipping';
import type {MultiPolygon} from 'polygon-clipping';
import * as W from './wasm-geometry';
import {engineCalls as switchCalls} from '../../shared/design/engine-switch';

type Mode = 'ts' | 'wasm' | 'both';
const mode = (process.env.MORFA_ENGINE_GEOMETRY ?? 'ts') as Mode;
// Documents are uploaded once per document object, as S2's shadow document keeps them; `both` mode would show a
// test that changes a document in place after a call (none of the wired files does).
W.setDocumentCaching(process.env.MORFA_ENGINE_UPLOAD !== 'always');

export const engineCalls = {wasm: 0, ts: 0, fallback: 0, both: 0, budget: 0};

/** boolean.ts gives a computation BOOLEAN_TIME_BUDGET_MS (1 500) shared by nested calls, then stacks instead of
 *  clipping: an answer near or past it depends on the clock, so `both` counts such calls instead of comparing them. */
const BUDGET_GUARD_MS = 1000;
let budgetDepth = 0;
let budgetStart = 0;
const perFunction = new Map<string, {wasm: number; fallback: number}>();

/** Thrown by an adapter when the input cannot cross into the model (the TS answers instead). */
export class Unrepresentable extends Error {}

const ADAPTERS: Record<string, (...args: never[]) => unknown> = W as unknown as Record<string, (...args: never[]) => unknown>;

/** Answers compared by area (vertex order may legitimately differ). */
const BY_AREA = new Set(['fillArea', 'combineAreas', 'strokeArea', 'combinePaths', 'combinePathsLive', 'polygonsToSmoothPaths', 'areaToPaths']);

function near(a: unknown, b: unknown, at = '$'): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return null;
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${at}: ${a} ≠ ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: length ${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = near(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined).sort();
    const kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined).sort();
    if (ka.join() !== kb.join()) return `${at}: keys ${ka} ≠ ${kb}`;
    for (const k of ka) {
      const d = near((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${at}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
}

const ringArea = (ring: number[][]) => {
  let s = 0;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) s += (ring[j][0] - ring[k][0]) * (ring[j][1] + ring[k][1]);
  return s / 2;
};
const areaOf = (mp: MultiPolygon) => mp.reduce((sum, p) => sum + p.reduce((s, ring, k) => s + (k ? -1 : 1) * Math.abs(ringArea(ring)), 0), 0);
function asArea(value: unknown): MultiPolygon {
  // Paths (VectorPath[]) are filled; multipolygons are cleaned under NONZERO the same way.
  const paths = Array.isArray(value) && value.length && 'commands' in (value[0] as object) ? (value as Parameters<typeof W.fillArea>[0]) : null;
  return paths ? W.fillArea(paths, 0.01) : (value as MultiPolygon).length ? W.fillArea(W.areaToPaths(value as MultiPolygon), 0.01) : [];
}
function areaDifference(a: unknown, b: unknown): string | null {
  const x = asArea(a), y = asArea(b);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const mp of [x, y]) for (const p of mp) for (const r of p) for (const [px, py] of r) {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const box = minX <= maxX ? (maxX - minX) * (maxY - minY) : 0;
  const diff = Math.abs(areaOf(polygonClipping.xor(x, y)));
  return diff <= 1e-6 * Math.max(box, 1e-12) ? null : `area △ ${diff} of box ${box}`;
}

export function __engine<F extends (...args: never[]) => unknown>(module: string, name: string, ts: F): F {
  // Called while the wired module evaluates, which may be before this module has (a module cycle through S2's
  // switch): nothing of this module's own bindings is read until the first call.
  if ((process.env.MORFA_ENGINE_GEOMETRY ?? 'ts') === 'ts') return ts;
  let adapter: (...args: never[]) => unknown;
  let stats: {wasm: number; fallback: number};
  return ((...args: never[]) => {
    if (!stats) {
      adapter = ADAPTERS[name];
      if (!adapter) throw new Error(`engine: no WASM adapter for ${module} ${name}`);
      stats = perFunction.get(name) ?? {wasm: 0, fallback: 0};
      perFunction.set(name, stats);
    }
    const timed = BY_AREA.has(name);
    if (timed && budgetDepth++ === 0) budgetStart = performance.now();
    try {
      return run(...args);
    } finally {
      if (timed) budgetDepth--;
    }
  }) as F;

  function run(...args: never[]): unknown {
    let wasm: unknown;
    try {
      wasm = adapter(...args);
    } catch (error) {
      if (!(error instanceof Unrepresentable) && !(error instanceof W.Unrepresentable)) throw error;
      stats.fallback++;
      engineCalls.fallback++;
      return ts(...args);
    }
    stats.wasm++;
    engineCalls.wasm++;
    if (mode === 'wasm') return wasm;
    const answer = ts(...args);
    engineCalls.both++;
    if (BY_AREA.has(name) && performance.now() - budgetStart > BUDGET_GUARD_MS) {
      engineCalls.budget++;
      return answer;
    }
    const d = BY_AREA.has(name) ? areaDifference(answer, wasm) : near(answer, wasm);
    if (d) throw new Error(`engine both: ${module} ${name} differs: ${d}`);
    return answer;
  }
}

process.on('exit', code => {
  if (mode === 'ts') return;
  if (process.env.MORFA_ENGINE_REPORT) {
    const rows = [...perFunction].filter(([, s]) => s.wasm || s.fallback).map(([n, s]) => `${n} ${s.wasm}${s.fallback ? `+${s.fallback} fallback` : ''}`);
    const s2 = switchCalls('geometry');
    console.error(`engine(geometry=${mode}): wasm ${engineCalls.wasm}, fallback ${engineCalls.fallback}, not compared (time budget) ${engineCalls.budget}; ${rows.join(', ')}; S2 switch (crates/wasm) wasm ${s2.wasm}, fallback ${s2.fallback}, diffs ${s2.diffs}`);
  }
  // `localMatrix`/`worldBox` are S2's own switch calls into crates/wasm (over this crate's matrix module): they count.
  if (engineCalls.wasm + switchCalls('geometry').wasm === 0 && code === 0) {
    console.error(`engine(geometry=${mode}): no WASM call was made`);
    process.exitCode = 1;
  }
});
