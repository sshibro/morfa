// Lane L1: the differential harness. Generates seeded documents (fuzz-docs.ts) and calls the TypeScript geometry and
// the WASM build (wasm-geometry.ts) on the same inputs:
//   matrices, bounds, flattened points: equal to 1e-9 relative (|a − b| ≤ 1e-9 · max(1, |a|, |b|));
//   parsePathData / serializePathData: byte-equal (the serialized text, and the commands parsed back);
//   booleans and outline strokes: by area, |A △ B| ≤ 1e-6 · bbox area (vertex order may differ legitimately);
//   hit testing (scan and indexed), pickAt and marquees: the same ids.
//
//   npx tsx scripts/geometry/diff.ts [--docs 10000] [--seed 1] [--only paths,shapes,boolean,outline,hit] [--verbose]
//                                    [--generator l1|s2] [--nodes 120] [--tame] [--exact]
//
// Exits 1 on any mismatch and prints the worst cases. Build the WASM first: scripts/geometry/build.sh.

import polygonClipping from 'polygon-clipping';
import type {MultiPolygon} from 'polygon-clipping';
import type {DesignDocument, Matrix, NodeId, PathCommand, SceneNode, VectorPath} from '../../shared/design/types';
import * as G from '../../shared/design/geometry';
import * as P from '../../shared/design/paths';
import * as S from '../../shared/design/shapes';
import * as B from '../../shared/design/boolean';
import * as O from '../../shared/design/outline-stroke';
import * as H from '../../src/design/engine/hit-test';
import {SpatialIndex} from '../../src/design/engine/render/spatial-index';
import {hasVariableWidth} from '../../shared/design/stroke-profile';
import {testMeasurer} from '../../tests/helpers/design-big-files';
import * as W from './wasm-geometry';
import {mulberry32, randomDocument, randomPathData, setWild} from './fuzz-docs';
import {fuzzDocument} from '../../tests/helpers/design-fuzz';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DOCS = Number(opt('docs', '1000'));
const SEED = Number(opt('seed', '1'));
const ONLY = new Set(opt('only', 'paths,shapes,boolean,outline,hit').split(','));
const VERBOSE = args.includes('--verbose');
/** `--tame`: documents without far-out coordinates (see fuzz-docs.ts `setWild`). */
if (args.includes('--tame')) setWild(false);
/** `--exact`: numbers must be equal to the bit (−0 aside), not only to 1e-9 relative. */
const RELATIVE = args.includes('--exact') ? 0 : 1e-9;
/** `--generator s2`: S2's tests/helpers/design-fuzz.ts `fuzzDocument` (`--nodes`, default 120) instead of fuzz-docs.ts. */
const GENERATOR = opt('generator', 'l1');
const NODES = Number(opt('nodes', '120'));

// ── Comparison ──────────────────────────────────────────────────────────────────────────────────

type Failure = {kind: string; seed: number; detail: string};
const failures: Failure[] = [];
const counts: Record<string, number> = {};
const worst: Record<string, {value: number; seed: number; detail: string}> = {};
const count = (kind: string) => (counts[kind] = (counts[kind] ?? 0) + 1);
const fail = (kind: string, seed: number, detail: string) => {
  failures.push({kind, seed, detail});
  if (VERBOSE || failures.length <= 20) console.log(`MISMATCH ${kind} seed=${seed}: ${detail.slice(0, 600)}`);
};
const record = (kind: string, value: number, seed: number, detail: string) => {
  if (!worst[kind] || value > worst[kind].value) worst[kind] = {value, seed, detail};
};

/** Deep comparison of numbers (1e-9 relative), strings, booleans, arrays, objects. Returns the first difference. */
function near(a: unknown, b: unknown, path = '$', relative = RELATIVE): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Object.is(a, b) || a === b) return null;
    if (Number.isNaN(a) && Number.isNaN(b)) return null;
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= relative * scale ? null : `${path}: ${a} ≠ ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = near(a[i], b[i], `${path}[${i}]`, relative);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined).sort();
    const kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka} ≠ ${kb}`;
    for (const k of ka) {
      const d = near((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, relative);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
}

function check(kind: string, seed: number, ts: unknown, wasm: unknown, context = ''): boolean {
  count(kind);
  const d = near(ts, wasm);
  if (d) fail(kind, seed, `${d}${context ? ` (${context})` : ''}`);
  return !d;
}

// Areas: the symmetric difference of two fills, against the bounding box of both.
const ringArea = (ring: [number, number][]) => {
  let s = 0;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) s += (ring[j][0] - ring[k][0]) * (ring[j][1] + ring[k][1]);
  return s / 2;
};
const areaOf = (mp: MultiPolygon) => mp.reduce((sum, polygon) => sum + polygon.reduce((s, ring, k) => s + (k === 0 ? 1 : -1) * Math.abs(ringArea(ring as [number, number][])), 0), 0);
function bboxOf(...areas: MultiPolygon[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const mp of areas) for (const polygon of mp) for (const ring of polygon) for (const [x, y] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return minX <= maxX ? (maxX - minX) * (maxY - minY) : 0;
}
/** NONZERO stacks of outlines and holes (what a stacked union or a boolean path paints) as one clean area. */
function normalizeArea(mp: MultiPolygon): MultiPolygon {
  if (!mp.length) return [];
  // Every ring as M/L…/Z of one NONZERO path (built by a loop: areaToPaths spreads rings into push()).
  const commands: PathCommand[] = [];
  for (const polygon of mp) for (const ring of polygon) {
    ring.forEach(([x, y], k) => commands.push({type: k ? 'L' : 'M', x, y}));
    commands.push({type: 'Z'});
  }
  return B.fillArea([{windingRule: 'NONZERO', commands}], 0.01);
}

/** Time-budgeted answers (BOOLEAN_TIME_BUDGET_MS) depend on the clock: such cases are counted, not compared. */
const BUDGETED = 1000;
/** combinePathsLive against TypeScript's combinePaths, by boolean.ts's own check. */
function liveCheck(seed: number, id: string, ts: VectorPath[], wasm: VectorPath[], tol: number) {
  count('combinePathsLive');
  if (JSON.stringify(ts) === JSON.stringify(wasm)) return;
  const d = B.liveAreaDifference(ts, wasm, tol);
  const ratio = d.boxArea > 0 ? d.symmetric / d.boxArea : d.symmetric > 0 ? Infinity : 0;
  record('combinePathsLive', ratio, seed, id);
  if (ratio > B.LIVE_AREA_TOLERANCE) fail('combinePathsLive', seed, `area ratio ${ratio.toExponential(3)} (|△| ${d.symmetric.toExponential(3)}, box ${d.boxArea.toExponential(3)}, areas ${d.areaA} / ${d.areaB}) ${id}`);
}

function timedAreas(kind: string, seed: number, ts: () => MultiPolygon, wasm: () => MultiPolygon, context: string, raw?: [() => unknown, () => unknown]): MultiPolygon | null {
  let t = performance.now();
  const a = ts();
  const tsMs = performance.now() - t;
  t = performance.now();
  const b = wasm();
  const wasmMs = performance.now() - t;
  if (tsMs > BUDGETED || wasmMs > BUDGETED) {
    count(`${kind} (time budget, not compared)`);
    return null;
  }
  // Beyond the area metric: how often the two answers are the same numbers (vertex order included). Identical
  // answers have no area difference to measure.
  if (near(raw ? raw[0]() : a, raw ? raw[1]() : b, '$', 0) === null) {
    count(`${kind} (bit-identical)`);
    count(kind);
    record(kind, 0, seed, context);
    return a;
  }
  compareAreas(kind, seed, a, b, context);
  return a;
}

function compareAreas(kind: string, seed: number, ts: MultiPolygon, wasm: MultiPolygon, context: string): void {
  count(kind);
  const a = normalizeArea(ts), b = normalizeArea(wasm);
  let diff = 0;
  try {
    diff = Math.abs(areaOf(polygonClipping.xor(a, b)));
  } catch {
    diff = Math.abs(areaOf(a) - areaOf(b));
  }
  const box = Math.max(bboxOf(a, b), 1e-12);
  const ratio = diff / box;
  record(kind, ratio, seed, context);
  if (ratio > 1e-6) fail(kind, seed, `area ratio ${ratio.toExponential(3)} (|△| ${diff.toExponential(3)}, box ${box.toExponential(3)}) ${context}`);
}
const pathsArea = (paths: readonly VectorPath[]): MultiPolygon => (paths.length ? B.fillArea(paths, 0.01) : []);

// ── The checks ────────────────────────────────────────────────────────────────────────────────

function checkPaths(seed: number, commands: PathCommand[], context: string): void {
  const r = mulberry32(seed ^ 0x9e3779b9);
  // Serialize / parse back: byte-equal.
  const text = P.serializePathData(commands);
  check('serializePathData', seed, text, W.serializePathData(commands), context);
  check('serializePathData(1)', seed, P.serializePathData(commands, 1), W.serializePathData(commands, 1), context);
  check('parsePathData(serialized)', seed, P.parsePathData(text), W.parsePathData(text), context);
  check('pathBounds', seed, P.pathBounds(commands), W.pathBounds(commands), context);
  check('flattenPath', seed, P.flattenPath(commands), W.flattenPath(commands), context);
  const tol = [0.01, 0.05, 0.25, 1][Math.floor(r() * 4)], maxAngle = [0, 0.1, 0.35][Math.floor(r() * 3)];
  check('flattenPath(tol,maxAngle)', seed, P.flattenPath(commands, tol, {maxAngle}), W.flattenPath(commands, tol, {maxAngle}), `${context} tol=${tol} maxAngle=${maxAngle}`);
  check('flattenPath(maxPoints)', seed, P.flattenPath(commands, 0.01, {maxPoints: 10}), W.flattenPath(commands, 0.01, {maxPoints: 10}), context);
  check('pathSegments', seed, P.pathSegments(commands), W.pathSegments(commands), context);
  check('pathSegments(closeOpen)', seed, P.pathSegments(commands, {closeOpen: true}), W.pathSegments(commands, {closeOpen: true}), context);
  check('reversePath', seed, P.reversePath(commands), W.reversePath(commands), context);
  const m: Matrix = [[r() * 4 - 2, r() * 4 - 2, r() * 100], [r() * 4 - 2, r() * 4 - 2, r() * 100]];
  check('transformPath', seed, P.transformPath(commands, m), W.transformPath(commands, m), context);
  const point = {x: r() * 400 - 200, y: r() * 400 - 200};
  check('windingNumber', seed, P.windingNumber(commands, point), W.windingNumber(commands, point), context);
  check('distanceToPath', seed, P.distanceToPath(commands, point), W.distanceToPath(commands, point), context);
  check('pathLength', seed, P.pathLength(commands), W.pathLength(commands), context);
  for (const s of P.pathSegments(commands)) {
    if (s.kind !== 'cubic') continue;
    const c: P.Cubic = [s.p0, s.c1, s.c2, s.p1];
    const t = r();
    check('cubicSteps', seed, P.cubicSteps(c, tol, maxAngle), W.cubicSteps(c, tol, maxAngle), context);
    check('splitCubicAt', seed, P.splitCubicAt(c, t), W.splitCubicAt(c, t), context);
    const t1 = r();
    check('subCubic', seed, P.subCubic(c, t, t1), W.subCubic(c, t, t1), context);
    break;
  }
  const flat = P.flattenPath(commands, 0.5)[0];
  if (flat && flat.points.length > 2) check('fitCubics', seed, P.fitCubics(flat.points, 0.5), W.fitCubics(flat.points, 0.5), context);
}

function checkArcs(seed: number): void {
  const r = mulberry32(seed ^ 0x51ed27);
  for (let k = 0; k < 3; k++) {
    const from = {x: r() * 200 - 100, y: r() * 200 - 100}, to = {x: r() * 200 - 100, y: r() * 200 - 100};
    const rx = r() < 0.1 ? 0 : r() * 150, ry = r() * 150, rot = r() * 360 - 180, large = r() < 0.5, sweep = r() < 0.5;
    check('svgArcToCubics', seed, P.svgArcToCubics(from, rx, ry, rot, large, sweep, to), W.svgArcToCubics(from, rx, ry, rot, large, sweep, to));
    const start = r() * 7 - 3.5, by = r() * 14 - 7;
    check('ellipseArcCubics', seed, P.ellipseArcCubics(from, rx, ry, rot, start, by), W.ellipseArcCubics(from, rx, ry, rot, start, by));
  }
  // Raw path data straight into both parsers (the grammar, not only our own serialization).
  const d = randomPathData(r);
  check('parsePathData(raw)', seed, P.parsePathData(d), W.parsePathData(d), d);
}

function checkDocument(seed: number, doc: DesignDocument): void {
  const nodes = Object.values(doc.nodes).filter(n => n.type !== 'PAGE');
  if (ONLY.has('shapes')) {
    for (const node of nodes) {
      check('localMatrix', seed, G.localMatrix(node), W.localMatrix(node), node.id);
      check('worldMatrix', seed, G.worldMatrix(doc, node.id), W.worldMatrix(doc, node.id), node.id);
      check('worldBox', seed, G.worldBox(doc, node.id), W.worldBox(doc, node.id), node.id);
      check('decompose', seed, G.decompose(G.worldMatrix(doc, node.id)), W.decompose(G.worldMatrix(doc, node.id)), node.id);
      check('nodeGeometry', seed, S.nodeGeometry(node), W.nodeGeometry(node), `${node.id} ${node.type}`);
      check('nodeOutline', seed, H.nodeOutline(node), W.nodeOutline(node), `${node.id} ${node.type}`);
      const box = {x: 0, y: 0, width: node.width, height: node.height};
      const m = G.worldMatrix(doc, node.id);
      check('transformRect', seed, G.transformRect(m, box), W.transformRect(m, box), node.id);
    }
    const rects = nodes.map(n => G.worldBox(doc, n.id));
    check('unionRects', seed, G.unionRects(rects), W.unionRects(rects));
    check('pathsBounds', seed, P.pathsBounds(nodes.flatMap(n => S.nodeGeometry(n))), W.pathsBounds(nodes.flatMap(n => S.nodeGeometry(n))));
  }
  if (ONLY.has('paths')) {
    for (const node of nodes) for (const path of S.nodeGeometry(node)) checkPaths(seed, path.commands, `${node.id} ${node.type}`);
    checkArcs(seed);
  }
  if (ONLY.has('boolean')) {
    for (const node of nodes) {
      if (node.type !== 'BOOLEAN_OPERATION') continue;
      timedAreas('booleanGeometry', seed, () => pathsArea(B.booleanGeometry(doc, node.id)), () => pathsArea(W.booleanGeometry(doc, node.id)), `${node.id} ${node.booleanOperation}`,
        [() => B.booleanGeometry(doc, node.id), () => W.booleanGeometry(doc, node.id)]);
      // The pieces too: one fill and the combination of areas.
      const operands = (node.children ?? []).map(id => doc.nodes[id]).filter(c => c && c.visible && c.type !== 'BOOLEAN_OPERATION' && c.type !== 'GROUP')
        .map(c => P.transformPaths(S.nodeGeometry(c), G.localMatrix(c)));
      if (operands.length >= 2) {
        const tol = B.booleanTolerance(node.width, node.height);
        const areas = operands.map(paths => B.fillArea(paths, tol));
        timedAreas('fillArea', seed, () => areas[0], () => W.fillArea(operands[0], tol), node.id);
        timedAreas('combineAreas', seed, () => B.combineAreas(node.booleanOperation ?? 'UNION', areas), () => W.combineAreas(node.booleanOperation ?? 'UNION', areas), node.id);
        timedAreas('combinePaths', seed, () => pathsArea(B.combinePaths(node.booleanOperation ?? 'UNION', operands, tol)), () => pathsArea(W.combinePaths(node.booleanOperation ?? 'UNION', operands, tol)), node.id);
        // Lane G: what the editor draws, TypeScript's polygon-clipping against the Rust overlay, by area at the
        // boolean's tolerance, as the engine switch's `both` compares them (boolean.ts liveAreaDifference).
        liveCheck(seed, node.id, B.combinePaths(node.booleanOperation ?? 'UNION', operands, tol), W.combinePathsLive(node.booleanOperation ?? 'UNION', operands, tol), tol);
      }
    }
  }
  if (ONLY.has('outline')) {
    for (const node of nodes) {
      if (!(node.strokeWeight > 0) || !node.strokes.length || hasVariableWidth(node)) continue;
      if (node.type === 'TEXT' || node.type === 'GROUP' || node.type === 'SLICE' || node.type === 'SECTION') continue;
      const geometry = node.type === 'BOOLEAN_OPERATION' ? B.booleanGeometry(doc, node.id) : S.nodeGeometry(node);
      const style = O.strokeStyleOf(node);
      const markers = node.type === 'LINE' || node.type === 'VECTOR';
      const options = {startMarker: markers ? node.strokeStartMarker : undefined, endMarker: markers ? node.strokeEndMarker : undefined};
      if (node.individualStrokeWeights && ['RECTANGLE', 'FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(node.type)) {
        check('outlineStroke(per-side weights)', seed, O.outlineStroke(node), W.outlineStroke(node), node.id);
        continue;
      }
      const area = timedAreas('strokeArea', seed, () => O.strokeArea(geometry, style, options), () => W.strokeArea(geometry, style, options), `${node.id} ${node.type} ${JSON.stringify(style)}`);
      const lines = P.flattenPath(geometry[0]?.commands ?? [], 0.05);
      if (style.dashPattern.length) check('dashPolylines', seed, O.dashPolylines(lines, style.dashPattern), W.dashPolylines(lines, style.dashPattern), node.id);
      if (!area) continue;
      const tol = O.strokeTolerance(style.weight);
      const smoothTs = O.polygonsToSmoothPaths(area, tol), smoothWasm = W.polygonsToSmoothPaths(area, tol);
      if (near(smoothTs, smoothWasm, '$', 0) === null) {
        count('polygonsToSmoothPaths (bit-identical)');
        count('polygonsToSmoothPaths');
      } else compareAreas('polygonsToSmoothPaths', seed, pathsArea(smoothTs), pathsArea(smoothWasm), node.id);
    }
  }
  if (ONLY.has('hit')) {
    // Every page (S2's documents have several; L1's own have one, `page`), with the points near its own nodes.
    for (const page of Object.values(doc.nodes).filter(n => n.type === 'PAGE').map(n => n.id)) {
      const onPage = nodes.filter(n => G.pageOf(doc, n.id)?.id === page);
      const r = mulberry32(seed ^ 0x7f4a7c15);
      const index = new SpatialIndex();
      index.sync(doc, page, testMeasurer);
      for (let k = 0; k < 30; k++) {
        // Points near nodes, so most of them hit something.
        const near = onPage[Math.floor(r() * onPage.length)];
        const box = near ? G.worldBox(doc, near.id) : {x: 0, y: 0, width: 100, height: 100};
        const point = {x: box.x + (r() * 1.4 - 0.2) * box.width, y: box.y + (r() * 1.4 - 0.2) * box.height};
        const tolerance = [0, 0, 1, 4][Math.floor(r() * 4)];
        const scan = H.hitTest(doc, page, point, {tolerance});
        check('hitTest', seed, scan, W.hitTest(doc, page, point, {tolerance}), JSON.stringify(point));
        check('hitTest(index)', seed, H.hitTest(doc, page, point, {tolerance, index}), W.hitTest(doc, page, point, {tolerance, index}), JSON.stringify(point));
        const context = r() < 0.2 && near?.parentId !== page ? near?.parentId ?? null : null;
        const shallow = r() < 0.7;
        check('pickAt', seed, H.pickAt(doc, page, point, {tolerance, context, deep: !shallow}), W.pickAt(doc, page, point, {tolerance, context, deep: !shallow}), JSON.stringify({point, context}));
        const deep = r() < 0.3;
        check('pickAt(deep,context,index)', seed, H.pickAt(doc, page, point, {tolerance, context, deep, index}), W.pickAt(doc, page, point, {tolerance, context, deep, index}), JSON.stringify({point, context, deep}));
        if (near) check('hitsNode', seed, H.hitsNode(doc, near.id, point, tolerance), W.hitsNode(doc, near.id, point, tolerance), near.id);
      }
      for (let k = 0; k < 6; k++) {
        const a = {x: r() * 2000 - 1000, y: r() * 2000 - 1000};
        const rect = {x: a.x, y: a.y, width: r() * 1500, height: r() * 1500};
        check('nodesInRect', seed, H.nodesInRect(doc, page, rect), W.nodesInRect(doc, page, rect), JSON.stringify(rect));
        check('nodesInRect(index)', seed, H.nodesInRect(doc, page, rect, {index}), W.nodesInRect(doc, page, rect, {index}), JSON.stringify(rect));
        const frame = onPage.find(n => n.type === 'FRAME');
        if (frame) check('nodesInRect(scope)', seed, H.nodesInRect(doc, page, rect, {scope: frame.id}), W.nodesInRect(doc, page, rect, {scope: frame.id}), frame.id);
      }
    }
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

const started = Date.now();
let crashed = 0;
/** `--skip 12,40`: seeds left out (diff-run.mjs passes the ones where the TypeScript never returns). */
const SKIP = new Set(opt('skip', '').split(',').filter(Boolean).map(Number));
for (let k = 0; k < DOCS; k++) {
  const seed = SEED + k;
  if (SKIP.has(seed)) continue;
  let doc: DesignDocument;
  try {
    doc = GENERATOR === 's2' ? fuzzDocument(seed, {nodes: NODES, parsePathData: d => P.parsePathData(d)}) : randomDocument(seed, d => P.parsePathData(d));
  } catch (error) {
    console.log(`seed ${seed}: generator failed: ${error}`);
    continue;
  }
  try {
    checkDocument(seed, doc);
  } catch (error) {
    crashed++;
    fail('crash', seed, String((error as Error).stack ?? error));
  }
  if ((k + 1) % (ONLY.has('outline') ? 20 : 500) === 0) {
    const m = process.memoryUsage();
    console.log(`… ${k + 1}/${DOCS} documents, ${failures.length} mismatches, ${((Date.now() - started) / 1000).toFixed(0)} s, rss ${(m.rss / 2 ** 20).toFixed(0)} MiB (JS heap ${(m.heapUsed / 2 ** 20).toFixed(0)}, WASM ${(W.memoryBytes() / 2 ** 20).toFixed(0)})`);
  }
}

console.log(`\n${DOCS} documents (seeds ${SEED}..${SEED + DOCS - 1}), ${((Date.now() - started) / 1000).toFixed(1)} s, WASM calls ${W.calls.wasm}`);
const byKind: Record<string, number> = {};
for (const f of failures) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
for (const kind of Object.keys(counts).sort()) console.log(`  ${kind.padEnd(30)} ${String(counts[kind]).padStart(8)} checks  ${String(byKind[kind] ?? 0).padStart(6)} mismatches${worst[kind] ? `  worst area ratio ${worst[kind].value.toExponential(2)} (seed ${worst[kind].seed} ${worst[kind].detail.slice(0, 60)})` : ''}`);
if (crashed) console.log(`  crashes: ${crashed}`);
console.log(failures.length ? `FAIL: ${failures.length} mismatches` : 'PASS');
const jsonOut = opt('json', '');
if (jsonOut) {
  const {writeFileSync} = await import('node:fs');
  writeFileSync(jsonOut, JSON.stringify({docs: DOCS - SKIP.size, seed: SEED, counts, byKind, worst, wasmCalls: W.calls.wasm, crashed, failures: failures.slice(0, 50)}));
}
if (W.calls.wasm === 0) {
  console.log('FAIL: no WASM call was made');
  process.exit(1);
}
process.exit(failures.length ? 1 : 0);

export type {NodeId, SceneNode};
