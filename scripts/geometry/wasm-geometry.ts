// Lane L1: the WASM geometry behind the same signatures as the TypeScript (shared/design/{geometry,paths,boolean,
// outline-stroke,shapes}.ts, src/design/engine/hit-test.ts). The differential harness (diff.ts), the test hooks
// (engine-hooks.mjs) and the Node benches call these; the coordinator's engine switch (S2) will call the same
// entry points from crates/wasm. Values cross as Float64Arrays (encodings: crates/geometry-wasm/src/encode.rs).

import {createRequire} from 'node:module';
import type {BooleanOperation, DesignDocument, Matrix, NodeId, PathCommand, SceneNode, StrokeMarker, Vec, VectorPath} from '../../shared/design/types';
import type {Rect} from '../../shared/design/geometry';
import type {Cubic, PathSegment, Polyline} from '../../shared/design/paths';
import type {MultiPolygon} from 'polygon-clipping';
import type {StrokeStyle} from '../../shared/design/outline-stroke';

type Wasm = Record<string, (...args: never[]) => unknown>;
const require = createRequire(import.meta.url);
let wasm: Wasm | null = null;
function w(): Wasm {
  if (!wasm) {
    wasm = require('./pkg/morfa_geometry.js') as Wasm;
    (wasm.installClock as () => void)();
  }
  return wasm;
}
const call = <T>(name: string, ...args: unknown[]): T => {
  calls.wasm++;
  try {
    return (w()[name] as (...a: unknown[]) => T)(...args);
  } catch (error) {
    const panic = (w().lastPanic as () => string)();
    if (panic) throw new Error(`wasm-geometry ${name}: Rust panic: ${panic}`);
    throw error;
  }
};

/** The input cannot cross into the model (a partial node built by hand, a document that does not parse). */
export class Unrepresentable extends Error {}
const checked = (d: Float64Array, what: string): Float64Array => {
  if (d.length === 1 && d[0] === -1) throw new Unrepresentable(`wasm-geometry: ${what} does not parse as a model node`);
  return d;
};

/** How many WASM entry points were called (the harness asserts it is above zero). */
export const calls = {wasm: 0};

// ── Encoding ──────────────────────────────────────────────────────────────────────────────────

function writeCommands(out: number[], commands: readonly PathCommand[]): void {
  for (const c of commands) {
    switch (c.type) {
      case 'M': out.push(0, c.x, c.y); break;
      case 'L': out.push(1, c.x, c.y); break;
      case 'C': out.push(2, c.x1, c.y1, c.x2, c.y2, c.x, c.y); break;
      case 'Q': out.push(3, c.x1, c.y1, c.x, c.y); break;
      default: out.push(4);
    }
  }
}
export const encodeCommands = (commands: readonly PathCommand[]): Float64Array => {
  const out: number[] = [];
  writeCommands(out, commands);
  return Float64Array.from(out);
};
function writePaths(out: number[], paths: readonly VectorPath[]): void {
  out.push(paths.length);
  for (const p of paths) {
    out.push(p.windingRule === 'EVENODD' ? 1 : 0);
    const at = out.length;
    out.push(0);
    writeCommands(out, p.commands);
    out[at] = out.length - at - 1;
  }
}
export const encodePaths = (paths: readonly VectorPath[]): Float64Array => {
  const out: number[] = [];
  writePaths(out, paths);
  return Float64Array.from(out);
};
function writeArea(out: number[], area: MultiPolygon): void {
  out.push(area.length);
  for (const polygon of area) {
    out.push(polygon.length);
    for (const ring of polygon) {
      out.push(ring.length);
      for (const [x, y] of ring) out.push(x, y);
    }
  }
}

class Reader {
  at = 0;
  constructor(readonly data: Float64Array) {}
  next() { return this.data[this.at++]; }
  commands(end: number): PathCommand[] {
    const out: PathCommand[] = [];
    const d = this.data;
    while (this.at < end) {
      const code = d[this.at++];
      switch (code) {
        case 0: out.push({type: 'M', x: d[this.at++], y: d[this.at++]}); break;
        case 1: out.push({type: 'L', x: d[this.at++], y: d[this.at++]}); break;
        case 2: out.push({type: 'C', x1: d[this.at++], y1: d[this.at++], x2: d[this.at++], y2: d[this.at++], x: d[this.at++], y: d[this.at++]}); break;
        case 3: out.push({type: 'Q', x1: d[this.at++], y1: d[this.at++], x: d[this.at++], y: d[this.at++]}); break;
        default: out.push({type: 'Z'});
      }
    }
    return out;
  }
  paths(): VectorPath[] {
    const n = this.next();
    const out: VectorPath[] = [];
    for (let k = 0; k < n; k++) {
      const windingRule = this.next() === 1 ? 'EVENODD' : 'NONZERO';
      const len = this.next();
      out.push({windingRule, commands: this.commands(this.at + len)});
    }
    return out;
  }
  polylines(): Polyline[] {
    const n = this.next();
    const out: Polyline[] = [];
    for (let k = 0; k < n; k++) {
      const closed = this.next() === 1;
      const count = this.next();
      const points: Vec[] = new Array(count);
      for (let i = 0; i < count; i++) points[i] = {x: this.next(), y: this.next()};
      out.push({points, closed});
    }
    return out;
  }
  area(): MultiPolygon {
    const n = this.next();
    const out: MultiPolygon = [];
    for (let k = 0; k < n; k++) {
      const rings = this.next();
      const polygon: [number, number][][] = [];
      for (let r = 0; r < rings; r++) {
        const count = this.next();
        const ring: [number, number][] = new Array(count);
        for (let i = 0; i < count; i++) ring[i] = [this.next(), this.next()];
        polygon.push(ring);
      }
      out.push(polygon);
    }
    return out;
  }
}

const decodeCommands = (d: Float64Array) => new Reader(d).commands(d.length);
const decodePaths = (d: Float64Array) => new Reader(d).paths();
const rect = (d: Float64Array): Rect | null => (d.length ? {x: d[0], y: d[1], width: d[2], height: d[3]} : null);
const mat = (m: Matrix) => Float64Array.of(m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2]);
const unmat = (d: Float64Array): Matrix => [[d[0], d[1], d[2]], [d[3], d[4], d[5]]];
const cubicArray = (c: Cubic) => Float64Array.of(c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y);
function cubicsOf(d: Float64Array): Cubic[] {
  const out: Cubic[] = [];
  for (let i = 0; i + 8 <= d.length; i += 8) out.push([{x: d[i], y: d[i + 1]}, {x: d[i + 2], y: d[i + 3]}, {x: d[i + 4], y: d[i + 5]}, {x: d[i + 6], y: d[i + 7]}]);
  return out;
}
const OPERATIONS: Record<BooleanOperation, number> = {UNION: 0, SUBTRACT: 1, INTERSECT: 2, EXCLUDE: 3};
const MARKERS: Record<StrokeMarker, number> = {NONE: 0, LINE_ARROW: 1, TRIANGLE_ARROW: 2, REVERSED_TRIANGLE: 3, CIRCLE: 4, DIAMOND: 5, ROUND: 6, SQUARE: 7};
const ALIGN = {CENTER: 0, INSIDE: 1, OUTSIDE: 2} as const;
const CAP = {NONE: 0, ROUND: 1, SQUARE: 2} as const;
const JOIN = {MITER: 0, BEVEL: 1, ROUND: 2} as const;

// ── geometry.ts ───────────────────────────────────────────────────────────────────────────────

export const multiply = (m: Matrix, n: Matrix): Matrix => unmat(call('multiply', mat(m), mat(n)));
export const invert = (m: Matrix): Matrix => unmat(call('invert', mat(m)));
export const localMatrix = (node: Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY'>): Matrix =>
  unmat(call('localMatrix', node.x, node.y, node.width, node.height, node.rotation || 0, !!node.flipX, !!node.flipY));
export const transformRect = (m: Matrix, r: Rect): Rect => rect(call('transformRect', mat(m), Float64Array.of(r.x, r.y, r.width, r.height)))!;
export function boundsOfPoints(points: readonly Vec[]): Rect {
  const xy = new Float64Array(points.length * 2);
  points.forEach((p, i) => { xy[2 * i] = p.x; xy[2 * i + 1] = p.y; });
  return rect(call('boundsOfPoints', xy))!;
}
export function unionRects(rects: readonly Rect[]): Rect | null {
  const d = new Float64Array(rects.length * 4);
  rects.forEach((r, i) => d.set([r.x, r.y, r.width, r.height], i * 4));
  return rect(call('unionRects', d));
}
export function decompose(m: Matrix) {
  const d = call<Float64Array>('decompose', mat(m));
  return {x: d[0], y: d[1], rotation: d[2], scaleX: d[3], scaleY: d[4], flipX: d[5] === 1};
}

// ── paths.ts ──────────────────────────────────────────────────────────────────────────────────

export const parsePathData = (d: string, options: {maxCommands?: number} = {}): PathCommand[] => decodeCommands(call('parsePathData', d, options.maxCommands ?? NaN));
export const serializePathData = (commands: readonly PathCommand[], precision = 3): string => call('serializePathData', encodeCommands(commands), precision);
export const formatNumber = (value: number, precision = 3): string => call('formatNumber', value, precision);
export const transformPath = (commands: readonly PathCommand[], matrix: Matrix): PathCommand[] => decodeCommands(call('transformPath', encodeCommands(commands), mat(matrix)));
export const pathBounds = (commands: readonly PathCommand[]): Rect | null => rect(call('pathBounds', encodeCommands(commands)));
export const pathsBounds = (paths: readonly VectorPath[]): Rect | null => rect(call('pathsBounds', encodePaths(paths)));
export const flattenPath = (commands: readonly PathCommand[], tolerance = 0.25, options: {maxAngle?: number; maxPoints?: number} = {}): Polyline[] =>
  new Reader(call('flattenPath', encodeCommands(commands), tolerance, options.maxAngle ?? 0, options.maxPoints ?? NaN)).polylines();
/** `flattenPath` of many command lists in one WASM call. */
export function flattenPaths(list: readonly (readonly PathCommand[])[], tolerance = 0.25, options: {maxAngle?: number} = {}): Polyline[][] {
  const out: number[] = [list.length];
  for (const commands of list) {
    out.push(0);
    const at = out.length;
    out.push(0);
    writeCommands(out, commands);
    out[at] = out.length - at - 1;
  }
  const reader = new Reader(call('flattenPaths', Float64Array.from(out), tolerance, options.maxAngle ?? 0));
  const n = reader.next();
  const result: Polyline[][] = [];
  for (let k = 0; k < n; k++) result.push(reader.polylines());
  return result;
}
export function svgArcToCubics(from: Vec, rx: number, ry: number, rotationDegrees: number, largeArc: boolean, sweep: boolean, to: Vec): (Cubic | [Vec, Vec])[] {
  const d = call<Float64Array>('svgArcToCubics', from.x, from.y, rx, ry, rotationDegrees, largeArc, sweep, to.x, to.y);
  const out: (Cubic | [Vec, Vec])[] = [];
  let at = 1;
  for (let k = 0; k < d[0]; k++) {
    const count = d[at++];
    const points: Vec[] = [];
    for (let i = 0; i < count; i++) points.push({x: d[at++], y: d[at++]});
    out.push(points as Cubic | [Vec, Vec]);
  }
  return out;
}
export const ellipseArcCubics = (center: Vec, rx: number, ry: number, rotation: number, start: number, sweep: number): Cubic[] =>
  cubicsOf(call('ellipseArcCubics', center.x, center.y, rx, ry, rotation, start, sweep));
export function splitCubicAt(c: Cubic, t: number): [Cubic, Cubic] {
  const [a, b] = cubicsOf(call('splitCubicAt', cubicArray(c), t));
  return [a, b];
}
export const subCubic = (c: Cubic, t0: number, t1: number): Cubic => cubicsOf(call('subCubic', cubicArray(c), t0, t1))[0];
export const cubicSteps = (c: Cubic, tolerance: number, maxAngle = 0): number => call('cubicSteps', cubicArray(c), tolerance, maxAngle);
export function pathSegments(commands: readonly PathCommand[], options: {closeOpen?: boolean} = {}): PathSegment[] {
  const d = call<Float64Array>('pathSegments', encodeCommands(commands), !!options.closeOpen);
  const out: PathSegment[] = [];
  for (let k = 0, at = 1; k < d[0]; k++, at += 11) {
    const index = d[at], subpath = d[at + 1];
    const p0 = {x: d[at + 3], y: d[at + 4]}, p1 = {x: d[at + 9], y: d[at + 10]};
    if (d[at + 2] === 1) out.push({index, subpath, kind: 'cubic', p0, c1: {x: d[at + 5], y: d[at + 6]}, c2: {x: d[at + 7], y: d[at + 8]}, p1});
    else out.push({index, subpath, kind: 'line', p0, p1});
  }
  return out;
}
export const reversePath = (commands: readonly PathCommand[]): PathCommand[] => decodeCommands(call('reversePath', encodeCommands(commands)));
export const windingNumber = (commands: readonly PathCommand[], point: Vec): number => call('windingNumber', encodeCommands(commands), point.x, point.y);
export function distanceToPath(commands: readonly PathCommand[], point: Vec) {
  const d = call<Float64Array>('distanceToPath', encodeCommands(commands), point.x, point.y);
  return d.length ? {distance: d[0], index: d[1], t: d[2], point: {x: d[3], y: d[4]}} : null;
}
export const pathLength = (commands: readonly PathCommand[]): number => call('pathLength', encodeCommands(commands));
export function fitCubics(points: readonly Vec[], tolerance: number): Cubic[] {
  const xy = new Float64Array(points.length * 2);
  points.forEach((p, i) => { xy[2 * i] = p.x; xy[2 * i + 1] = p.y; });
  return cubicsOf(call('fitCubics', xy, tolerance));
}

// ── shapes.ts ─────────────────────────────────────────────────────────────────────────────────

export const nodeGeometry = (node: SceneNode): VectorPath[] => decodePaths(checked(call('nodeGeometry', nodeJson(node)), 'nodeGeometry'));
export const rectanglePath = (width: number, height: number, radii: [number, number, number, number] = [0, 0, 0, 0], smoothing = 0): PathCommand[] =>
  decodeCommands(call('rectanglePath', width, height, Float64Array.from(radii), smoothing));
export const ellipsePaths = (width: number, height: number, arc?: {startingAngle: number; endingAngle: number; innerRadius: number}): VectorPath[] =>
  decodePaths(call('ellipsePaths', width, height, arc ? Float64Array.of(arc.startingAngle, arc.endingAngle, arc.innerRadius) : new Float64Array(0)));
export const polygonPath = (width: number, height: number, pointCount: number, cornerRadius = 0): PathCommand[] => decodeCommands(call('polygonPath', width, height, pointCount, cornerRadius));
export const starPath = (width: number, height: number, pointCount: number, innerRadius: number, cornerRadius = 0): PathCommand[] =>
  decodeCommands(call('starPath', width, height, pointCount, innerRadius, cornerRadius));

// ── boolean.ts ────────────────────────────────────────────────────────────────────────────────

export const fillArea = (paths: readonly VectorPath[], tolerance: number): MultiPolygon => new Reader(call('fillArea', encodePaths(paths), tolerance)).area();
export function combineAreas(operation: BooleanOperation, operands: readonly MultiPolygon[]): MultiPolygon {
  const out: number[] = [operands.length];
  for (const area of operands) writeArea(out, area);
  return new Reader(call('combineAreas', OPERATIONS[operation], Float64Array.from(out))).area();
}
export function areaToPaths(area: MultiPolygon): VectorPath[] {
  const out: number[] = [];
  writeArea(out, area);
  return decodePaths(call('areaToPaths', Float64Array.from(out)));
}
export function combinePaths(operation: BooleanOperation, operands: readonly (readonly VectorPath[])[], tolerance = 0.01): VectorPath[] {
  const out: number[] = [operands.length];
  for (const paths of operands) writePaths(out, paths);
  return decodePaths(call('combinePaths', OPERATIONS[operation], Float64Array.from(out), tolerance));
}
export function combinePathsLive(operation: BooleanOperation, operands: readonly (readonly VectorPath[])[], tolerance = 0.01): VectorPath[] {
  const out: number[] = [operands.length];
  for (const paths of operands) writePaths(out, paths);
  return decodePaths(call('combinePathsLive', OPERATIONS[operation], Float64Array.from(out), tolerance));
}
export const booleanTolerance = (width: number, height: number): number => call('booleanTolerance', width, height);

// ── outline-stroke.ts ─────────────────────────────────────────────────────────────────────────

export function strokeArea(paths: readonly VectorPath[], style: StrokeStyle, options: {tolerance?: number; startMarker?: StrokeMarker; endMarker?: StrokeMarker} = {}): MultiPolygon {
  const s = Float64Array.from([style.weight, ALIGN[style.align], CAP[style.cap], JOIN[style.join], style.miterLimit, ...style.dashPattern]);
  return new Reader(call('strokeArea', encodePaths(paths), s, options.tolerance ?? NaN, MARKERS[options.startMarker ?? 'NONE'], MARKERS[options.endMarker ?? 'NONE'])).area();
}
export function dashPolylines(lines: readonly Polyline[], pattern: readonly number[]): Polyline[] {
  const out: number[] = [lines.length];
  for (const l of lines) {
    out.push(l.closed ? 1 : 0, l.points.length);
    for (const p of l.points) out.push(p.x, p.y);
  }
  return new Reader(call('dashPolylines', Float64Array.from(out), Float64Array.from(pattern))).polylines();
}
export const strokeTolerance = (weight: number): number => call('strokeTolerance', weight);
/** `outlineStroke(node, geometry?)` (variable-width strokes stay in TS: they are not sent here). */
export const outlineStroke = (node: SceneNode, geometry?: VectorPath[], options: {tolerance?: number} = {}): VectorPath[] =>
  decodePaths(checked(call('outlineStroke', nodeJson(node), geometry ? encodePaths(geometry) : new Float64Array(0), options.tolerance ?? NaN), 'outlineStroke'));
export function polygonsToSmoothPaths(area: MultiPolygon, tolerance: number): VectorPath[] {
  const out: number[] = [];
  writeArea(out, area);
  return decodePaths(call('polygonsToSmoothPaths', Float64Array.from(out), tolerance));
}

/** One node as the model reads it: a lone UTF-16 surrogate (S2's generator puts them in names and text) cannot cross
 *  into a Rust string, so it becomes U+FFFD first, as crates/model's document reader does (json.rs
 *  `replace_lone_surrogates`). Geometry reads no string a surrogate can be in. */
const nodeJson = (node: SceneNode): string => JSON.stringify(node, (_, value) => (typeof value === 'string' ? (value as string & {toWellFormed(): string}).toWellFormed() : value));

// ── Documents (hit-test.ts, worldMatrix, booleanGeometry): one upload per document object ─────

const handles = new WeakMap<DesignDocument, number>();
const release = new FinalizationRegistry<number>(handle => (w().freeDocument as (h: number) => void)(handle));
let caching = true;
let uncached = -1;
/** Off: every call uploads the document again (tests change documents in place between calls). */
export const setDocumentCaching = (on: boolean) => { caching = on; };
export function documentHandle(doc: DesignDocument): number {
  if (!caching) {
    if (uncached >= 0) (w().freeDocument as (h: number) => void)(uncached);
    uncached = call<number>('loadDocument', JSON.stringify(doc));
    if (uncached < 0) throw new Unrepresentable('wasm-geometry: the document does not load');
    return uncached;
  }
  let handle = handles.get(doc);
  if (handle === undefined) {
    handle = call<number>('loadDocument', JSON.stringify(doc));
    if (handle < 0) throw new Unrepresentable('wasm-geometry: the document does not load');
    handles.set(doc, handle);
    release.register(doc, handle);
  }
  return handle;
}

export const worldMatrix = (doc: DesignDocument, id: NodeId): Matrix => unmat(call('worldMatrix', documentHandle(doc), id));
export const worldBox = (doc: DesignDocument, id: NodeId): Rect => rect(call('worldBox', documentHandle(doc), id))!;
export const booleanGeometry = (doc: DesignDocument, id: NodeId): VectorPath[] => decodePaths(call('booleanGeometry', documentHandle(doc), id));
/** Every node's geometry flattened inside the WASM document: per node, per path, its polylines. */
export function flattenDocument(doc: DesignDocument, tolerance = 0.25): Polyline[][][] {
  const reader = new Reader(call('flattenDocument', documentHandle(doc), tolerance));
  const n = reader.next();
  const out: Polyline[][][] = [];
  for (let k = 0; k < n; k++) {
    const paths = reader.next();
    const node: Polyline[][] = [];
    for (let p = 0; p < paths; p++) node.push(reader.polylines());
    out.push(node);
  }
  return out;
}
type Measurer = {width(text: string, font: {family: string; weight: number; italic: boolean; size: number}): number; metrics(font: {family: string; weight: number; italic: boolean; size: number}): {ascent: number; descent: number}};
const fixedMeasurers = new WeakMap<object, boolean>();
/** Whether a measurer behaves as `testMeasurer` (tests/helpers/design-big-files.ts: half an em per UTF-16 unit, ascent
 *  0.8 em, descent 0.2 em), L3's `FixedMeasurer`. Probed rather than imported: that module imports the geometry this
 *  harness hooks, and importing it here would close an import cycle through engine.ts. */
function isTestMeasurer(measurer: unknown): boolean {
  if (!measurer || typeof measurer !== 'object') return false;
  let fixed = fixedMeasurers.get(measurer);
  if (fixed === undefined) {
    const m = measurer as Measurer;
    const font = (size: number) => ({family: 'Inter', weight: 400, italic: false, size});
    try {
      // 'Ж' (Cyrillic) and an emoji: multi-byte characters through the wasm measurer.
      fixed = m.width('ab', font(10)) === 10 && m.width('Ж😀x', font(13)) === 26 && m.width('', font(7)) === 0;
      const metrics = m.metrics(font(10)), odd = m.metrics(font(13));
      fixed &&= metrics.ascent === 8 && metrics.descent === 2 && odd.ascent === 13 * 0.8 && odd.descent === 13 * 0.2;
    } catch {
      fixed = false;
    }
    fixedMeasurers.set(measurer, fixed);
  }
  return fixed;
}

/** The index a hit-test call names (`options.index`, a TypeScript `SpatialIndex` or `true`) → whether to index, after
 *  telling the document which text measurer the TypeScript index was synced with (its painted bounds include text
 *  that overflows its box when it has one). A measurer other than `testMeasurer` cannot cross: the TS answers. */
function indexed(handle: number, index: unknown): boolean {
  if (!index) return false;
  const measurer = typeof index === 'object' ? (index as {measurer?: unknown}).measurer : undefined;
  if (measurer !== undefined && !isTestMeasurer(measurer)) throw new Unrepresentable('wasm-geometry: the index measures text with a measurer the model has no twin of');
  call('setTextMeasurer', handle, measurer === undefined ? 0 : 1);
  return true;
}
/** Throws when the index built for the call met a node it cannot bound as the TypeScript does (a text on a path). */
function supported<T>(handle: number, answer: T): T {
  if (call<boolean>('indexUnsupported', handle)) throw new Unrepresentable('wasm-geometry: the index holds a text on a path (text-path.ts bounds stay in TS)');
  return answer;
}
export function hitTest(doc: DesignDocument, pageId: NodeId, point: Vec, options: {tolerance?: number; index?: unknown} = {}): NodeId | null {
  const handle = documentHandle(doc), index = indexed(handle, options.index);
  return supported(handle, call<string | undefined>('hitTest', handle, pageId, point.x, point.y, options.tolerance ?? 0, index) ?? null);
}
export function pickAt(doc: DesignDocument, pageId: NodeId, point: Vec, options: {tolerance?: number; index?: unknown; context?: NodeId | null; deep?: boolean} = {}): NodeId | null {
  const handle = documentHandle(doc), index = indexed(handle, options.index);
  return supported(handle, call<string | undefined>('pickAt', handle, pageId, point.x, point.y, options.tolerance ?? 0, index, options.context ?? undefined, !!options.deep) ?? null);
}
export function pickMany(doc: DesignDocument, pageId: NodeId, points: readonly Vec[], options: {tolerance?: number; indexed?: boolean} = {}): (NodeId | null)[] {
  const xy = new Float64Array(points.length * 2);
  points.forEach((p, i) => { xy[2 * i] = p.x; xy[2 * i + 1] = p.y; });
  const handle = documentHandle(doc), index = indexed(handle, options.indexed);
  return supported(handle, call<string[]>('pickMany', handle, pageId, xy, options.tolerance ?? 0, index, undefined, false).map(id => id || null));
}
export function nodesInRect(doc: DesignDocument, pageId: NodeId, r: Rect, options: {context?: NodeId | null; scope?: NodeId | null; index?: unknown} = {}): NodeId[] {
  const handle = documentHandle(doc), index = indexed(handle, options.index);
  return supported(handle, call('nodesInRect', handle, pageId, Float64Array.of(r.x, r.y, r.width, r.height), options.context ?? undefined, options.scope ?? undefined, index));
}
export const hitsNode = (doc: DesignDocument, id: NodeId, point: Vec, tolerance = 0): boolean => call('hitsNode', documentHandle(doc), id, point.x, point.y, tolerance);
function flatLines(d: Float64Array): {points: number[]; closed: boolean}[] {
  const out: {points: number[]; closed: boolean}[] = [];
  for (let k = 0, at = 1; k < d[0]; k++) {
    const closed = d[at++] === 1, len = d[at++];
    out.push({points: Array.from(d.subarray(at, at + len)), closed});
    at += len;
  }
  return out;
}
export const flattenCommands = (commands: readonly PathCommand[]) => flatLines(call('flattenCommands', encodeCommands(commands)));
export const nodeOutline = (node: SceneNode) => flatLines(checked(call('nodeOutline', nodeJson(node)), 'nodeOutline'));
export const boxIntersectsRect = (m: Matrix, width: number, height: number, r: Rect): boolean =>
  call('boxIntersectsRect', mat(m), width, height, Float64Array.of(r.x, r.y, r.width, r.height));

// geometry.ts keeps S2's switch on `localMatrix`/`worldBox` and its TypeScript halves as `localMatrixTs`/`worldBoxTs`:
// the harness wires the halves (engine-hooks.mjs), so the same adapters answer under those names.
export const localMatrixTs = localMatrix;
export const worldBoxTs = worldBox;

/** Bytes of the WASM linear memory (it grows, never shrinks): the fuzz reports it beside the JS heap. */
export const memoryBytes = (): number => (w().memoryBytes as () => number)();
