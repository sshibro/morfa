import type {MultiPolygon, Pair} from 'polygon-clipping';
import type {BooleanOperation, PathCommand, StrokeAlign, StrokeCap, StrokeJoin, StrokeMarker, Vec, VectorPath} from './types';
import type {Polyline} from './paths';
import type {StrokeStyle} from './outline-stroke';
import {EngineSkipped, EngineUnsupported, inTypeScript, lazyInputs, withEngine} from './engine-switch';

// The geometry as a wasm module of its own (crates/geometry-wasm, built by scripts/wasm-geometry-build.sh): the
// split, so the main module (crates/wasm) stays within its budget. Booleans and the outline
// stroke (shared/design/{boolean,outline-stroke}.ts) run through `withEngine('geometry', …)` here; the readers of the
// shadow document (worldMatrix, worldBox) stay crates/wasm's.
//
// Loading: Node requires the CommonJS build on first use (server/design/wasm-geometry, or MORFA_WASM_GEOMETRY_PATH);
// a build that is missing throws, never a silent fallback. The browser installs the web build through
// src/design/engine/geometry-wasm.ts when the switch runs geometry as wasm or both; until it has, a call throws
// EngineUnsupported, so the TypeScript answers and the switch counts a fallback (it never blocks).
//
// Values cross as Float64Arrays (crates/geometry-wasm/src/encode.rs): commands as a code (M 0, L 1, C 2, Q 3, Z 4)
// and their numbers; paths as count, then per path winding (0 NONZERO, 1 EVENODD), encoded length, commands;
// polylines as count, then per polyline closed (0/1), point count, x, y…; multipolygons as polygon count, then per
// polygon ring count, then per ring point count, x, y…

/** crates/geometry-wasm as wasm-bindgen exports it. */
export interface GeometryWasm {
  /** Date.now as the boolean time budget's clock; the loaders call it once. */
  installClock(): void;
  /** The last Rust panic's message ('' when none happened). */
  lastPanic(): string;
  /** A deliberate wrong answer for `geometry.combinePaths` or `geometry.strokeArea` ('' turns it off): tests. */
  debugFault(name: string): void;
  fillArea(paths: Float64Array, tolerance: number): Float64Array;
  combineAreas(operation: number, operands: Float64Array): Float64Array;
  areaToPaths(area: Float64Array): Float64Array;
  combinePaths(operation: number, operands: Float64Array, tolerance: number): Float64Array;
  /** combinePaths for live drawing (lane G): the same area through a faster overlay, other vertex lists. */
  combinePathsLive(operation: number, operands: Float64Array, tolerance: number): Float64Array;
  strokeArea(paths: Float64Array, style: Float64Array, tolerance: number, startMarker: number, endMarker: number): Float64Array;
  dashPolylines(lines: Float64Array, pattern: Float64Array): Float64Array;
  polygonsToSmoothPaths(area: Float64Array, tolerance: number): Float64Array;
}

// ── The module ──────────────────────────────────────────────────────────────────────────────────────────────────

type Runtime = {process?: {env?: Record<string, string | undefined>; versions?: {node?: string}; getBuiltinModule?: (name: string) => unknown}};
const runtime = globalThis as unknown as Runtime;

let installed: GeometryWasm | null = null;
/** Set once the module was installed, explicitly removed, or Node tried to load it: no second attempt. */
let settled = false;
let loadError: unknown = null;

/** Installs the geometry module (the browser loader after `init()`; tests may install a fake, or `null` to act as a
 *  page whose module has not arrived yet). */
export function setGeometryWasm(module: GeometryWasm | null): void {
  module?.installClock();
  installed = module;
  settled = true;
  loadError = null;
}

export const geometryWasmLoaded = (): boolean => installed !== null;

/** In Node the CommonJS build is loaded on first use, synchronously (process.getBuiltinModule keeps bundlers from
 *  seeing a Node import), as engine-switch.ts loads crates/wasm. */
function loadInNode(): GeometryWasm | null {
  const getBuiltin = runtime.process?.getBuiltinModule;
  if (!runtime.process?.versions?.node || !getBuiltin) return null;
  const {createRequire} = getBuiltin('node:module') as {createRequire(from: string): (id: string) => unknown};
  const path = runtime.process.env?.MORFA_WASM_GEOMETRY_PATH ?? new URL('../../server/design/wasm-geometry/morfa_geometry_wasm.js', import.meta.url).pathname;
  return createRequire(import.meta.url)(path) as GeometryWasm;
}

/** The geometry module: throws EngineUnsupported while the browser has not installed it, and a plain error when Node
 *  cannot load its build. */
export function geometryWasm(): GeometryWasm {
  if (installed) return installed;
  if (!settled) {
    settled = true;
    try {
      const module = loadInNode();
      module?.installClock();
      installed = module;
    } catch (error) {
      loadError = error;
    }
    if (installed) return installed;
  }
  if (loadError) {
    const why = loadError instanceof Error ? loadError.message : String(loadError);
    throw new Error(`geometry-wasm: the geometry module did not load (${why}); build it with scripts/wasm-geometry-build.sh`);
  }
  throw new EngineUnsupported('geometry-wasm: the geometry module is not loaded yet');
}

/** Either side of a `both` call running this long is not compared: boolean.ts gives a computation
 *  BOOLEAN_TIME_BUDGET_MS (1 500 ms), past which unions stack their parts instead of clipping, so such an answer
 *  depends on the clock (lane L1's harness drew the same line). Counted as `skipped`. */
const CLOCK_GUARD_MS = 1000;

/** One call of the geometry module through the switch. The TypeScript side runs with geometry held at `ts` (the
 *  calls its body makes, such as combinePaths → combineAreas, belong to this one call); the wasm side reads the
 *  module, so it falls back while the browser has not installed it. `equal` replaces the comparison for one call
 *  (`combinePathsLive`, by area). */
export function geometryCall<T>(call: string, ts: () => T, wasm: (module: GeometryWasm) => T, inputs: () => unknown, equal?: (ts: T, wasm: T) => string | null): T {
  let tsMs = -1;
  return withEngine(
    'geometry',
    call,
    () => {
      const started = performance.now();
      try {
        return inTypeScript('geometry', ts);
      } finally {
        tsMs = performance.now() - started;
      }
    },
    () => {
      const module = geometryWasm();
      const started = performance.now();
      let answer: T;
      try {
        answer = wasm(module);
      } catch (error) {
        // A Rust panic traps (`unreachable`); its message was kept by the panic hook.
        const panic = error instanceof WebAssembly.RuntimeError ? module.lastPanic() : '';
        throw panic ? new Error(`geometry-wasm ${call}: Rust panic: ${panic}`, {cause: error}) : error;
      }
      // `both` only (the TypeScript side ran first): an answer near the time budget is not compared.
      if (tsMs >= 0 && (tsMs > CLOCK_GUARD_MS || performance.now() - started > CLOCK_GUARD_MS)) throw new EngineSkipped(`geometry ${call}: over ${CLOCK_GUARD_MS} ms, near boolean.ts's time budget`);
      return answer;
    },
    // `equal`: a call compared otherwise than by the module's 1e-9 on every number (the live boolean, by area).
    equal ? {inputs: lazyInputs(inputs), equal} : {inputs: lazyInputs(inputs)},
  );
}

// ── Encoding ────────────────────────────────────────────────────────────────────────────────────────────────────

function writeCommands(out: number[], commands: readonly PathCommand[]): void {
  for (const c of commands) {
    switch (c.type) {
      case 'M': out.push(0, c.x, c.y); break;
      case 'L': out.push(1, c.x, c.y); break;
      case 'C': out.push(2, c.x1, c.y1, c.x2, c.y2, c.x, c.y); break;
      case 'Q': out.push(3, c.x1, c.y1, c.x, c.y); break;
      case 'Z': out.push(4); break;
      default: throw new EngineUnsupported(`geometry-wasm: a path command of type ${JSON.stringify((c as {type?: unknown}).type)}`);
    }
  }
}

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

function writePolylines(out: number[], lines: readonly Polyline[]): void {
  out.push(lines.length);
  for (const line of lines) {
    out.push(line.closed ? 1 : 0, line.points.length);
    for (const p of line.points) out.push(p.x, p.y);
  }
}

function encode(write: (out: number[]) => void): Float64Array {
  const out: number[] = [];
  write(out);
  return Float64Array.from(out);
}

class Reader {
  private at = 0;
  constructor(private readonly data: Float64Array) {}

  next(): number {
    return this.data[this.at++];
  }

  commands(end: number): PathCommand[] {
    const out: PathCommand[] = [];
    const d = this.data;
    while (this.at < end) {
      switch (d[this.at++]) {
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
    const out: VectorPath[] = [];
    for (let k = 0, n = this.next(); k < n; k++) {
      const windingRule = this.next() === 1 ? 'EVENODD' : 'NONZERO';
      const length = this.next();
      out.push({windingRule, commands: this.commands(this.at + length)});
    }
    return out;
  }

  polylines(): Polyline[] {
    const out: Polyline[] = [];
    for (let k = 0, n = this.next(); k < n; k++) {
      const closed = this.next() === 1;
      const count = this.next();
      const points: Vec[] = new Array(count);
      for (let i = 0; i < count; i++) points[i] = {x: this.next(), y: this.next()};
      out.push({points, closed});
    }
    return out;
  }

  area(): MultiPolygon {
    const out: MultiPolygon = [];
    for (let k = 0, n = this.next(); k < n; k++) {
      const polygon: Pair[][] = [];
      for (let r = 0, rings = this.next(); r < rings; r++) {
        const count = this.next();
        const ring: Pair[] = new Array(count);
        for (let i = 0; i < count; i++) ring[i] = [this.next(), this.next()];
        polygon.push(ring);
      }
      out.push(polygon);
    }
    return out;
  }
}

/** A value the wasm side has no code for: the TypeScript answers (counted as a fallback), never a guess. */
function code<K extends string>(table: Record<K, number>, value: K, what: string): number {
  const found = table[value];
  if (found === undefined) throw new EngineUnsupported(`geometry-wasm: ${what} ${JSON.stringify(value)}`);
  return found;
}

const OPERATIONS: Record<BooleanOperation, number> = {UNION: 0, SUBTRACT: 1, INTERSECT: 2, EXCLUDE: 3};
const MARKERS: Record<StrokeMarker, number> = {NONE: 0, LINE_ARROW: 1, TRIANGLE_ARROW: 2, REVERSED_TRIANGLE: 3, CIRCLE: 4, DIAMOND: 5, ROUND: 6, SQUARE: 7};
const ALIGNS: Record<StrokeAlign, number> = {CENTER: 0, INSIDE: 1, OUTSIDE: 2};
const CAPS: Record<StrokeCap, number> = {NONE: 0, ROUND: 1, SQUARE: 2};
const JOINS: Record<StrokeJoin, number> = {MITER: 0, BEVEL: 1, ROUND: 2};

// ── The entries, with the TypeScript functions' signatures (after their defaults) ───────────────────────────────

export const wasmFillArea = (w: GeometryWasm, paths: readonly VectorPath[], tolerance: number): MultiPolygon =>
  new Reader(w.fillArea(encode(out => writePaths(out, paths)), tolerance)).area();

export const wasmCombineAreas = (w: GeometryWasm, operation: BooleanOperation, operands: readonly MultiPolygon[]): MultiPolygon => {
  const op = code(OPERATIONS, operation, 'boolean operation');
  return new Reader(w.combineAreas(op, encode(out => {
    out.push(operands.length);
    for (const area of operands) writeArea(out, area);
  }))).area();
};

export const wasmAreaToPaths = (w: GeometryWasm, area: MultiPolygon): VectorPath[] => new Reader(w.areaToPaths(encode(out => writeArea(out, area)))).paths();

export const wasmCombinePaths = (w: GeometryWasm, operation: BooleanOperation, operands: readonly (readonly VectorPath[])[], tolerance: number, live = false): VectorPath[] => {
  const op = code(OPERATIONS, operation, 'boolean operation');
  return new Reader((live ? w.combinePathsLive : w.combinePaths).call(w, op, encode(out => {
    out.push(operands.length);
    for (const paths of operands) writePaths(out, paths);
  }), tolerance)).paths();
};

export const wasmStrokeArea = (w: GeometryWasm, paths: readonly VectorPath[], style: StrokeStyle, options: {tolerance?: number; startMarker?: StrokeMarker; endMarker?: StrokeMarker}): MultiPolygon => {
  const encodedStyle = Float64Array.from([style.weight, code(ALIGNS, style.align, 'stroke align'), code(CAPS, style.cap, 'stroke cap'), code(JOINS, style.join, 'stroke join'), style.miterLimit, ...style.dashPattern]);
  const start = code(MARKERS, options.startMarker ?? 'NONE', 'stroke marker'), end = code(MARKERS, options.endMarker ?? 'NONE', 'stroke marker');
  return new Reader(w.strokeArea(encode(out => writePaths(out, paths)), encodedStyle, options.tolerance ?? NaN, start, end)).area();
};

export const wasmDashPolylines = (w: GeometryWasm, lines: readonly Polyline[], pattern: readonly number[]): Polyline[] =>
  new Reader(w.dashPolylines(encode(out => writePolylines(out, lines)), Float64Array.from(pattern))).polylines();

export const wasmPolygonsToSmoothPaths = (w: GeometryWasm, area: MultiPolygon, tolerance: number): VectorPath[] =>
  new Reader(w.polygonsToSmoothPaths(encode(out => writeArea(out, area)), tolerance)).paths();
