// Geometry benches: the TypeScript geometry against the WASM build, in Node.
// The same entries run in Chrome on the Mac. Each row: median of `--runs` timed runs after warm-up,
// TS ms, WASM ms (adapters included: encoding in, decoding out), speed-up. Rows:
//   boolean   union of a 200-operand fuzzed set (combinePaths; and combinePathsLive, what the editor draws)
//   stroke    strokeArea of 1 000 dashed paths
//   flatten   flattenPath of every path in heavyPage() (per call, batched, and from the loaded document)
//   pick      pickAt × 10 000 on heavyPage() with the index (per call, and batched)
//
//   scripts/geometry/build.sh && npx tsx scripts/bench/geometry.ts [--runs 5] [--only boolean,stroke,flatten,pick] [--json]

import type {BooleanOperation, PathCommand, VectorPath} from '../../shared/design/types';
import * as P from '../../shared/design/paths';
import * as S from '../../shared/design/shapes';
import * as B from '../../shared/design/boolean';
import * as O from '../../shared/design/outline-stroke';
import * as G from '../../shared/design/geometry';
import * as H from '../../src/design/engine/hit-test';
import {SpatialIndex} from '../../src/design/engine/render/spatial-index';
import {heavyPage, testMeasurer} from '../../tests/helpers/design-big-files';
import * as W from '../geometry/wasm-geometry';
import {mulberry32, randomPathData} from '../geometry/fuzz-docs';
import {createNode} from '../../shared/design/defaults';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const RUNS = Number(opt('runs', '5'));
const ONLY = new Set(opt('only', 'boolean,stroke,flatten,pick').split(','));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function time(run: () => unknown, runs = RUNS): number {
  run(); // warm-up (JIT, WASM instantiation, caches the TS keeps across calls are rebuilt per run where they exist)
  const samples: number[] = [];
  for (let k = 0; k < runs; k++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

type Row = {row: string; ts: number; wasm: number; note: string};
const rows: Row[] = [];
const report = (row: string, ts: number, wasm: number, note = '') => {
  rows.push({row, ts, wasm, note});
  console.log(`${row.padEnd(34)} TS ${ts.toFixed(2).padStart(9)} ms   WASM ${wasm.toFixed(2).padStart(9)} ms   ×${(ts / wasm).toFixed(2)}  ${note}`);
};

// ── Inputs ────────────────────────────────────────────────────────────────────────────────────

/** 200 fuzzed operands in one space: rounded rectangles, ellipses and rings, stars, polygons, random vectors. */
function operands(seed: number, count: number): VectorPath[][] {
  const r = mulberry32(seed);
  const out: VectorPath[][] = [];
  for (let k = 0; k < count; k++) {
    const x = r() * 900, y = r() * 900, w = 20 + r() * 160, h = 20 + r() * 160;
    const kind = Math.floor(r() * 5);
    const node = createNode(['RECTANGLE', 'ELLIPSE', 'STAR', 'POLYGON', 'VECTOR'][kind] as 'RECTANGLE', {
      id: `o${k}`, x, y, width: w, height: h, rotation: r() * 360 - 180,
      cornerRadius: kind === 0 || kind === 3 ? r() * 30 : undefined, pointCount: kind === 2 || kind === 3 ? 3 + Math.floor(r() * 6) : undefined,
      arcData: kind === 1 && r() < 0.3 ? {startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0.5} : undefined,
      vectorPaths: kind === 4 ? [{windingRule: 'NONZERO', commands: closed(P.parsePathData(randomPathData(r, 80, false)))}] : undefined,
    });
    out.push(P.transformPaths(S.nodeGeometry(node), G.localMatrix(node)));
  }
  return out;
}
const closed = (commands: PathCommand[]): PathCommand[] => (commands.length && commands[commands.length - 1].type !== 'Z' ? [...commands, {type: 'Z'}] : commands);

/** 1 000 dashed open paths: curves and lines, several weights, caps and joins. */
function dashedPaths(seed: number, count: number): {paths: VectorPath[]; style: O.StrokeStyle}[] {
  const r = mulberry32(seed);
  const out: {paths: VectorPath[]; style: O.StrokeStyle}[] = [];
  for (let k = 0; k < count; k++) {
    const commands = P.parsePathData(randomPathData(r, 150, false)).filter(c => c.type !== 'Z');
    out.push({
      paths: [{windingRule: 'NONZERO', commands}],
      style: {
        weight: [1, 2, 4, 8][Math.floor(r() * 4)], align: 'CENTER', cap: (['NONE', 'ROUND', 'SQUARE'] as const)[Math.floor(r() * 3)],
        join: (['MITER', 'BEVEL', 'ROUND'] as const)[Math.floor(r() * 3)], miterLimit: 4, dashPattern: [[10, 5], [4, 4], [20, 8, 4, 8]][Math.floor(r() * 3)],
      },
    });
  }
  return out;
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────

if (ONLY.has('boolean')) {
  const ops = operands(7, 200);
  const op: BooleanOperation = 'UNION';
  const tol = 0.01;
  const ts = time(() => B.combinePaths(op, ops, tol));
  const wasm = time(() => W.combinePaths(op, ops, tol));
  report('boolean: union of 200 operands', ts, wasm, `${ops.reduce((s, o) => s + o.length, 0)} paths`);
  const live = time(() => W.combinePathsLive(op, ops, tol));
  report('boolean: union of 200, live (G)', ts, live, 'combinePathsLive: the same area, by area in both');
}

if (ONLY.has('stroke')) {
  const items = dashedPaths(11, 1000);
  const ts = time(() => { for (const it of items) O.strokeArea(it.paths, it.style); }, Math.max(1, Math.min(RUNS, 3)));
  const wasm = time(() => { for (const it of items) W.strokeArea(it.paths, it.style); }, Math.max(1, Math.min(RUNS, 3)));
  report('stroke: strokeArea × 1000 dashed', ts, wasm);
}

if (ONLY.has('flatten') || ONLY.has('pick')) {
  const doc = heavyPage();
  const nodes = Object.values(doc.nodes);
  if (ONLY.has('flatten')) {
    const geometries = nodes.map(n => S.nodeGeometry(n));
    const list = geometries.flat().map(p => p.commands);
    const ts = time(() => { for (const commands of list) P.flattenPath(commands); });
    const perCall = time(() => { for (const commands of list) W.flattenPath(commands); });
    report('flatten: heavyPage, per call', ts, perCall, `${list.length} paths`);
    const batched = time(() => W.flattenPaths(list));
    report('flatten: heavyPage, one batch', ts, batched);
    // With the document already in WASM (S2's shadow document): geometry and flattening both inside.
    W.documentHandle(doc);
    const tsWithGeometry = time(() => { for (const n of nodes) for (const p of S.nodeGeometry(n)) P.flattenPath(p.commands); });
    const fromDocument = time(() => W.flattenDocument(doc));
    report('flatten: heavyPage incl. nodeGeometry', tsWithGeometry, fromDocument, 'from the loaded document');
  }
  if (ONLY.has('pick')) {
    const index = new SpatialIndex();
    index.sync(doc, 'page', testMeasurer);
    const r = mulberry32(3);
    const bounds = G.unionRects(nodes.filter(n => n.type !== 'PAGE').map(n => G.worldBox(doc, n.id)))!;
    const points = Array.from({length: 10_000}, () => ({x: bounds.x + r() * bounds.width, y: bounds.y + r() * bounds.height}));
    // Same answers first.
    let same = 0;
    for (const p of points.slice(0, 500)) if (H.pickAt(doc, 'page', p, {index, tolerance: 1}) === W.pickAt(doc, 'page', p, {index: true, tolerance: 1})) same++;
    const ts = time(() => { for (const p of points) H.pickAt(doc, 'page', p, {index, tolerance: 1}); });
    W.pickAt(doc, 'page', points[0], {index: true});
    const perCall = time(() => { for (const p of points) W.pickAt(doc, 'page', p, {index: true, tolerance: 1}); });
    report('pick: pickAt × 10000, per call', ts, perCall, `${same}/500 same answers`);
    const batched = time(() => W.pickMany(doc, 'page', points, {indexed: true, tolerance: 1}));
    report('pick: pickAt × 10000, one batch', ts, batched);
  }
}

if (args.includes('--json')) console.log(JSON.stringify(rows));
