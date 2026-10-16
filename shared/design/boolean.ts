import polygonClipping from 'polygon-clipping';
import type {MultiPolygon, Pair, Polygon, Ring} from 'polygon-clipping';
import type {BooleanOperation, DesignDocument, Matrix, NodeId, Paint, PathCommand, SceneNode, Vec, VectorPath, WindingRule} from './types';
import {apply, decompose, invert, localMatrix, multiply, scaling, translation} from './geometry';
import {appendLine, cubicPoint, cubicSteps, pathSegments, pathsBounds, subCubic, transformPath, transformPaths, type Cubic} from './paths';
import {nodeGeometry} from './shapes';
import {createNode, newId} from './defaults';
import {engineTs, firstDifference} from './engine-switch';
import {geometryCall, wasmAreaToPaths, wasmCombineAreas, wasmCombinePaths, wasmFillArea} from './geometry-wasm';

// Boolean geometry (Union, Subtract, Intersect, Exclude) and "Flatten" for boolean
// groups. Children's fill outlines are brought into the boolean's space, flattened finely,
// combined by polygon-clipping (Martinez–Rueda–Feito, robust to touching and overlapping
// edges), then turned back into curves. The flattening remembers, for every point it makes, the
// curve and parameter it came from; an output edge that runs along a curve is replaced by the
// exact piece of that curve, its ends pinned to the clipped vertices. A circle minus a square
// therefore stays a true circular arc with four editable points, not hundreds of segments.
//
// Fill rules: EVENODD paths are the XOR of their rings; NONZERO paths nest rings by containment
// and add each ring's direction (exact for rings that do not cross each other, which is what
// drawing tools and SVG icons produce). Hidden children, text (no glyph outlines here) and
// slices take no part, as in Figma.

/** A flattened point's origin: curve `curve` of the registry at parameter `t`. */
type Tag = {curve: number; t: number};
type Chord = {a: Vec; b: Vec; curve: number; t0: number; t1: number};

const key = (x: number, y: number) => `${x},${y}`;

/** Remembers where flattened points came from, so curves can be rebuilt after clipping. */
class Provenance {
  readonly curves: Cubic[] = [];
  private readonly tags = new Map<string, Tag[]>();
  private readonly chords: Chord[] = [];
  private grid: Map<string, number[]> | null = null;
  private cell = 1;

  addCurve(c: Cubic): number {
    this.curves.push(c);
    return this.curves.length - 1;
  }

  tag(p: Vec, curve: number, t: number) {
    const k = key(p.x, p.y);
    const list = this.tags.get(k);
    if (list) list.push({curve, t});
    else this.tags.set(k, [{curve, t}]);
  }

  chord(a: Vec, b: Vec, curve: number, t0: number, t1: number) {
    this.chords.push({a, b, curve, t0, t1});
    this.grid = null;
  }

  /** Curves through a point: exact for points the flattening made, by the chord it lies on for
   *  intersections polygon-clipping added. */
  lookup(p: Vec, eps: number, exactOnly = false): Tag[] {
    const exact = this.tags.get(key(p.x, p.y));
    if (exact) return exact;
    if (!this.chords.length || exactOnly) return [];
    const grid = this.buildGrid();
    const cx = Math.floor(p.x / this.cell), cy = Math.floor(p.y / this.cell);
    const out: Tag[] = [];
    const seen = new Set<number>();
    // Real geometry has a handful of chords near a point; piles of coincident curves (hostile
    // files) are cut short, and the vertex then simply stays a corner.
    let budget = 512;
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (const index of grid.get(`${gx},${gy}`) ?? []) {
        if (--budget < 0) return out;
        if (seen.has(index)) continue;
        seen.add(index);
        const chord = this.chords[index];
        const dx = chord.b.x - chord.a.x, dy = chord.b.y - chord.a.y;
        const len2 = dx * dx + dy * dy;
        const s = len2 ? Math.max(0, Math.min(1, ((p.x - chord.a.x) * dx + (p.y - chord.a.y) * dy) / len2)) : 0;
        const qx = chord.a.x + dx * s, qy = chord.a.y + dy * s;
        if (Math.hypot(p.x - qx, p.y - qy) <= eps) out.push({curve: chord.curve, t: chord.t0 + (chord.t1 - chord.t0) * s});
      }
    }
    return out;
  }

  private buildGrid(): Map<string, number[]> {
    if (this.grid) return this.grid;
    let total = 0;
    for (const c of this.chords) total += Math.abs(c.b.x - c.a.x) + Math.abs(c.b.y - c.a.y);
    this.cell = Math.max(1e-6, (total / this.chords.length) * 2);
    const grid = new Map<string, number[]>();
    this.chords.forEach((c, index) => {
      const x0 = Math.floor(Math.min(c.a.x, c.b.x) / this.cell), x1 = Math.floor(Math.max(c.a.x, c.b.x) / this.cell);
      const y0 = Math.floor(Math.min(c.a.y, c.b.y) / this.cell), y1 = Math.floor(Math.max(c.a.y, c.b.y) / this.cell);
      for (let gx = x0; gx <= x1 && gx - x0 < 64; gx++) for (let gy = y0; gy <= y1 && gy - y0 < 64; gy++) {
        const k = `${gx},${gy}`;
        const list = grid.get(k);
        if (list) list.push(index);
        else grid.set(k, [index]);
      }
    });
    return this.grid = grid;
  }
}

// ── Paths → polygons ───────────────────────────────────────────────────────────────────────────

const signedArea = (ring: Ring) => {
  let area = 0;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) area += (ring[j][0] - ring[k][0]) * (ring[j][1] + ring[k][1]);
  return area / 2;
};

function insideRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
    const [xi, yi] = ring[k], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Rings of each subpath, closed as a fill closes them, with provenance recorded when given. */
function flattenRings(commands: readonly PathCommand[], tolerance: number, provenance: Provenance | null): Ring[] {
  const rings: Ring[] = [];
  let ring: Pair[] = [];
  let subpath = -1;
  const push = (p: Vec) => {
    // Non-finite coordinates (a broken file) never reach the sweep line.
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const last = ring[ring.length - 1];
    if (!last || last[0] !== p.x || last[1] !== p.y) ring.push([p.x, p.y]);
  };
  for (const s of pathSegments(commands, {closeOpen: true})) {
    if (s.subpath !== subpath) {
      subpath = s.subpath;
      ring = [];
      rings.push(ring);
      push(s.p0);
    }
    if (s.kind === 'line') { push(s.p1); continue; }
    const c: Cubic = [s.p0, s.c1, s.c2, s.p1];
    const steps = cubicSteps(c, tolerance);
    const id = provenance ? provenance.addCurve(c) : -1;
    let previous = s.p0, previousT = 0;
    provenance?.tag(s.p0, id, 0);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const p = k === steps ? s.p1 : cubicPoint(c, t);
      if (provenance) {
        provenance.tag(p, id, t);
        provenance.chord(previous, p, id, previousT, t);
      }
      push(p);
      previous = p;
      previousT = t;
    }
  }
  return rings.map(r => {
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    return r;
  }).filter(r => r.length >= 3 && Math.abs(signedArea(r)) > 1e-12);
}

const MAX_NESTED_RINGS = 400;

/** The fill of one path as a MultiPolygon under its winding rule. */
function ringsToArea(rings: Ring[], rule: WindingRule): MultiPolygon {
  if (!rings.length) return [];
  if (rings.length === 1) return [[rings[0]]];
  if (rule === 'EVENODD' || rings.length > MAX_NESTED_RINGS) return cascade('xor', rings.map(r => [[r]]));
  // NONZERO: nest rings by containment; the region inside a ring and outside its children
  // winds as its parent's region plus the ring's own direction.
  const areas = rings.map(signedArea);
  const order = rings.map((_, k) => k).sort((a, b) => Math.abs(areas[b]) - Math.abs(areas[a]));
  const parent = new Array<number>(rings.length).fill(-1);
  const winding = new Array<number>(rings.length).fill(0);
  const placed: number[] = [];
  for (const k of order) {
    const [px, py] = probePoint(rings[k]);
    for (let j = placed.length - 1; j >= 0; j--) {
      if (insideRing(rings[placed[j]], px, py)) { parent[k] = placed[j]; break; }
    }
    winding[k] = (parent[k] >= 0 ? winding[parent[k]] : 0) + Math.sign(areas[k]);
    placed.push(k);
  }
  const polygons: MultiPolygon = [];
  rings.forEach((ring, k) => {
    if (!winding[k]) return;
    polygons.push([ring, ...rings.filter((_, j) => parent[j] === k)]);
  });
  return polygons.length ? cascade('union', polygons.map(polygon => [polygon])) : [];
}

/** A point just inside the ring's first edge, for containment tests of nested rings. */
function probePoint(ring: Ring): Pair {
  const [x0, y0] = ring[0], [x1, y1] = ring[1];
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/** The filled area of paths (each with its own winding rule) as one MultiPolygon. Lane L1's port answers in `wasm`
 *  and `both` (shared/design/geometry-wasm.ts), as do combineAreas, areaToPaths and combinePaths. */
export const fillArea = (paths: readonly VectorPath[], tolerance: number): MultiPolygon => {
  if (engineTs('geometry')) return fillAreaTs(paths, tolerance);
  return geometryCall('fillArea', () => fillAreaTs(paths, tolerance), wasm => wasmFillArea(wasm, paths, tolerance), () => ({paths, tolerance}));
};

const fillAreaTs = (paths: readonly VectorPath[], tolerance: number): MultiPolygon => budgeted(() => areaOf(paths, tolerance, null));

function areaOf(paths: readonly VectorPath[], tolerance: number, provenance: Provenance | null): MultiPolygon {
  const parts = paths.map(path => ringsToArea(flattenRings(path.commands, tolerance, provenance), path.windingRule)).filter(p => p.length);
  if (!parts.length) return [];
  return parts.length === 1 ? parts[0] : cascade('union', parts);
}

// ── Clipping ───────────────────────────────────────────────────────────────────────────────────

type ClipOperation = 'union' | 'intersection' | 'xor' | 'difference';

/** Vertices one union may sweep at once; designs stay far below, hostile files do not. */
const CLIP_VERTEX_LIMIT = 150_000;
const vertexCount = (geoms: readonly MultiPolygon[]) => {
  let n = 0;
  for (const g of geoms) for (const polygon of g) for (const ring of polygon) n += ring.length;
  return n;
};

/** polygon-clipping with a second try on a snapped grid: its sweep line rarely gives up on
 *  near-degenerate input, and snapping by a hair resolves it. */
function clip(operation: ClipOperation, geoms: MultiPolygon[]): MultiPolygon {
  // Out of time, or too big for one uninterruptible sweep, a union stacks its parts instead
  // (see BOOLEAN_TIME_BUDGET_MS): the paint is the same, only the outlines stay unmerged.
  if (operation === 'union' && (Date.now() > deadline || vertexCount(geoms) > CLIP_VERTEX_LIMIT)) return geoms.flatMap(orient);
  const run = (input: MultiPolygon[]) => polygonClipping[operation](input[0], ...input.slice(1));
  try {
    return run(geoms);
  } catch {
    const snap = (v: number) => Math.round(v * 1e6) / 1e6;
    try {
      return run(geoms.map(g => g.map(polygon => polygon.map(ring => ring.map(([x, y]) => [snap(x), snap(y)] as Pair)))));
    } catch {
      return [];
    }
  }
}

/** Wall-clock budget of one boolean computation. Past it, unions stop clipping and stack their
 *  remaining parts: polygon-clipping winds outlines one way and holes the other, so under
 *  NONZERO the stack still paints exactly the union (only the outline is not merged). */
export const BOOLEAN_TIME_BUDGET_MS = 1500;
let deadline = Infinity;

function budgeted<T>(run: () => T): T {
  if (deadline !== Infinity) return run(); // nested calls share the outer budget
  deadline = Date.now() + BOOLEAN_TIME_BUDGET_MS;
  try {
    return run();
  } finally {
    deadline = Infinity;
  }
}

/** Every outline wound one way and every hole the other, for stacking without clipping. */
function orient(area: MultiPolygon): MultiPolygon {
  return area.map(polygon => polygon.map((ring, k) => ((signedArea(ring) > 0) === (k === 0) ? ring : [...ring].reverse())));
}

/** An associative operation over many geometries, combined pairwise in a balanced tree: when
 *  inputs overlap heavily this meets far fewer crossings than one sweep over everything. */
function cascade(operation: 'union' | 'xor' | 'intersection', geoms: MultiPolygon[]): MultiPolygon {
  if (!geoms.length) return [];
  if (geoms.length === 1) return clip('union', geoms);
  let list = geoms;
  while (list.length > 1) {
    const next: MultiPolygon[] = [];
    for (let k = 0; k < list.length; k += 2) {
      if (k + 1 >= list.length) next.push(list[k]);
      // Out of time: the rest is stacked, which NONZERO still paints as the union.
      else if (operation === 'union' && Date.now() > deadline) next.push([...orient(list[k]), ...orient(list[k + 1])]);
      else next.push(clip(operation, [list[k], list[k + 1]]));
    }
    if (operation === 'intersection' && next.some(g => !g.length)) return [];
    list = next;
  }
  return list[0];
}

/** Combines operand areas: UNION, SUBTRACT (the first minus the rest), INTERSECT, EXCLUDE (XOR). */
export function combineAreas(operation: BooleanOperation, operands: readonly MultiPolygon[]): MultiPolygon {
  if (engineTs('geometry')) return combineAreasTs(operation, operands);
  return geometryCall('combineAreas', () => combineAreasTs(operation, operands), wasm => wasmCombineAreas(wasm, operation, operands), () => ({operation, operands}));
}

function combineAreasTs(operation: BooleanOperation, operands: readonly MultiPolygon[]): MultiPolygon {
  return budgeted(() => {
    const present = operands.filter(g => g.length);
    switch (operation) {
      case 'UNION': return cascade('union', present);
      case 'EXCLUDE': return cascade('xor', present);
      case 'INTERSECT': return operands.length && present.length === operands.length ? cascade('intersection', present) : [];
      case 'SUBTRACT': {
        if (!operands[0]?.length) return [];
        const rest = operands.slice(1).filter(g => g.length);
        return rest.length ? clip('difference', [operands[0], cascade('union', rest)]) : clip('union', [operands[0]]);
      }
    }
  });
}

// ── Polygons → paths ───────────────────────────────────────────────────────────────────────────

type Edge = {curve: number; t0: number; t1: number} | null;

/** Commands for one clipped ring: lines where the ring runs along straight input, and exact
 *  pieces of the input curves where it runs along them. */
function ringToCommands(ring: Ring, provenance: Provenance | null, tolerance: number, eps: number): PathCommand[] {
  // Vertices closer than float noise (a curve ending 1e-14 off its start) are one vertex.
  const points: Vec[] = [];
  for (const [x, y] of ring) {
    const last = points[points.length - 1];
    if (!last || Math.abs(last.x - x) > eps || Math.abs(last.y - y) > eps) points.push({x, y});
  }
  while (points.length > 1 && Math.abs(points[0].x - points[points.length - 1].x) <= eps && Math.abs(points[0].y - points[points.length - 1].y) <= eps) points.pop();
  const n = points.length;
  if (n < 3) return [];
  const edges: Edge[] = new Array(n).fill(null);
  if (provenance) {
    const tags = points.map(p => provenance.lookup(p, eps, Date.now() > deadline));
    for (let k = 0; k < n; k++) {
      const a = points[k], b = points[(k + 1) % n];
      const previous = edges[(k + n - 1) % n];
      let best: Edge = null;
      for (const ta of tags[k]) for (const tb of tags[(k + 1) % n]) {
        if (ta.curve !== tb.curve || ta.t === tb.t) continue;
        // Follow the curve only if it really runs along this edge (a straight cut between two
        // points of one curve must stay straight).
        const mid = cubicPoint(provenance.curves[ta.curve], (ta.t + tb.t) / 2);
        if (distanceToSegment(mid, a, b) > tolerance * 2 + eps) continue;
        const candidate = {curve: ta.curve, t0: ta.t, t1: tb.t};
        const continues = previous && previous.curve === candidate.curve && previous.t1 === candidate.t0;
        if (!best || continues) best = candidate;
        if (continues) break;
      }
      edges[k] = best;
    }
  }
  const continuesFrom = (prev: Edge, next: Edge) =>
    !!prev && !!next && prev.curve === next.curve && prev.t1 === next.t0 && Math.sign(prev.t1 - prev.t0) === Math.sign(next.t1 - next.t0);
  // Start where a run begins, so no run wraps around the ring's start.
  let start = 0;
  for (let k = 0; k < n; k++) {
    if (!continuesFrom(edges[(k + n - 1) % n], edges[k])) { start = k; break; }
  }
  const out: PathCommand[] = [{type: 'M', x: points[start].x, y: points[start].y}];
  let k = 0;
  while (k < n) {
    const index = (start + k) % n;
    const edge = edges[index];
    if (!edge || !provenance) {
      const p = points[(index + 1) % n];
      appendLine(out, p.x, p.y, eps * 10);
      k++;
      continue;
    }
    let last = k;
    while (last + 1 < n && continuesFrom(edges[(start + last) % n], edges[(start + last + 1) % n])) last++;
    const from = points[index], to = points[(start + last + 1) % n];
    const t1 = edges[(start + last) % n]!.t1;
    const piece = subCubic(provenance.curves[edge.curve], edge.t0, t1);
    // Pin the piece to the exact clipped vertices; the handles move with their ends.
    const d0 = {x: from.x - piece[0].x, y: from.y - piece[0].y}, d1 = {x: to.x - piece[3].x, y: to.y - piece[3].y};
    out.push({type: 'C', x1: piece[1].x + d0.x, y1: piece[1].y + d0.y, x2: piece[2].x + d1.x, y2: piece[2].y + d1.y, x: to.x, y: to.y});
    k = last + 1;
  }
  // The last line back to the start is the Z.
  const tail = out[out.length - 1];
  if (tail.type === 'L' && tail.x === points[start].x && tail.y === points[start].y) out.pop();
  out.push({type: 'Z'});
  return out;
}

function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const s = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * s), p.y - (a.y + dy * s));
}

/** A MultiPolygon as one NONZERO path of straight segments (polygon-clipping winds holes
 *  against their outlines, so the rule holds them). */
export const areaToPaths = (area: MultiPolygon): VectorPath[] => {
  if (engineTs('geometry')) return pathsOfArea(area, null, 0);
  return geometryCall('areaToPaths', () => pathsOfArea(area, null, 0), wasm => wasmAreaToPaths(wasm, area), () => ({area}));
};

function pathsOfArea(area: MultiPolygon, provenance: Provenance | null, tolerance: number): VectorPath[] {
  let extent = 1;
  for (const polygon of area) for (const ring of polygon) for (const [x, y] of ring) extent = Math.max(extent, Math.abs(x), Math.abs(y));
  const eps = extent * 1e-9 + 1e-9;
  const commands: PathCommand[] = [];
  for (const polygon of area) for (const ring of polygon) commands.push(...ringToCommands(ring, provenance, tolerance, eps));
  return commands.length ? [{windingRule: 'NONZERO', commands}] : [];
}

/** Flattening tolerance for a shape of this size: fine enough that intersections land within a
 *  hundredth of a pixel at normal sizes, coarse enough that huge shapes stay quick. */
export const booleanTolerance = (width: number, height: number) => Math.min(0.05, Math.max(0.002, Math.max(width, height, 1) * 1e-4));

/** Points a boolean may flatten its curves into; past it the tolerance grows, so a hostile or
 *  enormous document stays responsive (the renderer computes booleans while drawing). */
export const BOOLEAN_POINT_BUDGET = 50_000;

/** How many points flattening the curves of `operands` at `tolerance` would make. */
function curvePoints(operands: readonly (readonly VectorPath[])[], tolerance: number): number {
  let total = 0;
  for (const paths of operands) for (const path of paths) for (const s of pathSegments(path.commands)) {
    if (s.kind === 'cubic') total += cubicSteps([s.p0, s.c1, s.c2, s.p1], tolerance);
  }
  return total;
}

/** Combines operands (each a list of paths in one shared space) and returns curves. */
export function combinePaths(operation: BooleanOperation, operands: readonly (readonly VectorPath[])[], tolerance = 0.01): VectorPath[] {
  if (engineTs('geometry')) return combinePathsTs(operation, operands, tolerance);
  return geometryCall('combinePaths', () => combinePathsTs(operation, operands, tolerance), wasm => wasmCombinePaths(wasm, operation, operands, tolerance), () => ({operation, operands, tolerance}));
}

function combinePathsTs(operation: BooleanOperation, operands: readonly (readonly VectorPath[])[], tolerance: number): VectorPath[] {
  // Steps grow as 1/√tolerance until each curve's cap: coarsen until the estimate fits.
  for (let points = curvePoints(operands, tolerance), tries = 0; points > BOOLEAN_POINT_BUDGET && tries < 24; tries++) {
    tolerance *= Math.max(4, (points / BOOLEAN_POINT_BUDGET) ** 2);
    points = curvePoints(operands, tolerance);
  }
  return budgeted(() => {
    const provenance = new Provenance();
    const areas = operands.map(paths => areaOf(paths, tolerance, provenance));
    return pathsOfArea(combineAreas(operation, areas), provenance, tolerance);
  });
}

/** combinePaths for what the editor draws live (boolean groups' rendering, hit areas, bounds).
 *  TypeScript answers as combinePaths does; the Rust side (`combine_paths_live`) gives
 *  the same area through a faster overlay with other vertex lists, so `both` compares the two by area
 *  (`liveAreaDifference`). Anything written into a document (flatten, outline stroke, export) uses combinePaths,
 *  exact on both sides. */
export function combinePathsLive(operation: BooleanOperation, operands: readonly (readonly VectorPath[])[], tolerance = 0.01): VectorPath[] {
  if (engineTs('geometry')) return combinePathsTs(operation, operands, tolerance);
  return geometryCall('combinePathsLive', () => combinePathsTs(operation, operands, tolerance), wasm => wasmCombinePaths(wasm, operation, operands, tolerance, true), () => ({operation, operands, tolerance}), liveAreaEqual(tolerance));
}

/** The live check's bound: the symmetric difference of two answers' areas over their bounding box's area. */
export const LIVE_AREA_TOLERANCE = 1e-6;

/** How far apart two boolean answers are as areas: both filled at `tolerance` (the boolean's own: the exact
 *  answer's straight runs are the flattened points of that tolerance), the area of their symmetric difference, the
 *  bounding box's area, and each one's area. */
export function liveAreaDifference(a: readonly VectorPath[], b: readonly VectorPath[], tolerance: number): {symmetric: number; boxArea: number; areaA: number; areaB: number} {
  const box = pathsBounds([...a, ...b]);
  const boxArea = box ? box.width * box.height : 0;
  return budgeted(() => {
    const fa = areaOf(a, tolerance, null), fb = areaOf(b, tolerance, null);
    return {symmetric: areaOfMultiPolygon(clip('xor', [fa, fb])), boxArea, areaA: areaOfMultiPolygon(fa), areaB: areaOfMultiPolygon(fb)};
  });
}

/** `both`'s comparison for combinePathsLive at the boolean's tolerance: equal when the answers agree to 1e-9 on
 *  every number, or when their symmetric difference is at most LIVE_AREA_TOLERANCE of their bounding box's area. */
const liveAreaEqual = (tolerance: number) => (ts: VectorPath[], wasm: VectorPath[]): string | null => {
  if (firstDifference(ts, wasm, 1e-9) === null) return null;
  const {symmetric, boxArea} = liveAreaDifference(ts, wasm, tolerance);
  return symmetric <= LIVE_AREA_TOLERANCE * boxArea ? null : '';
};

/** A MultiPolygon's area: outer rings count, holes take away. */
function areaOfMultiPolygon(area: MultiPolygon): number {
  let total = 0;
  for (const polygon of area) polygon.forEach((ring, k) => { total += k === 0 ? Math.abs(signedArea(ring)) : -Math.abs(signedArea(ring)); });
  return total;
}

// ── Documents ──────────────────────────────────────────────────────────────────────────────────

type Computed = {paths: VectorPath[]; deps: SceneNode[]};
// Keyed by the boolean node object: documents are immutable, so an unchanged node with unchanged
// descendants (checked by identity) has unchanged geometry. Live drawing and writes keep their own.
const liveCache = new WeakMap<SceneNode, Computed>();
const exactCache = new WeakMap<SceneNode, Computed>();

/** The node's fill outline (and its descendants', for groups and booleans) mapped by `matrix`,
 *  or null when it takes no part in a boolean. */
function operandPaths(doc: DesignDocument, node: SceneNode, matrix: Matrix, deps: SceneNode[], visiting: Set<NodeId>, live: boolean): VectorPath[] | null {
  deps.push(node);
  if (!node.visible) return null;
  switch (node.type) {
    case 'BOOLEAN_OPERATION': {
      if (visiting.has(node.id)) return null;
      const inner = computeBoolean(doc, node, visiting, live);
      deps.push(...inner.deps);
      return transformPaths(inner.paths, matrix);
    }
    case 'GROUP': {
      const out: VectorPath[] = [];
      let any = false;
      for (const id of node.children ?? []) {
        const child = doc.nodes[id];
        if (!child) continue;
        const paths = operandPaths(doc, child, multiply(matrix, localMatrix(child)), deps, visiting, live);
        if (paths) { any = true; out.push(...paths); }
      }
      return any ? out : null;
    }
    case 'TEXT': case 'SLICE': case 'PAGE':
      return null;
    default:
      return transformPaths(nodeGeometry(node), matrix);
  }
}

function computeBoolean(doc: DesignDocument, node: SceneNode, visiting: Set<NodeId>, live: boolean): Computed {
  const cache = live ? liveCache : exactCache;
  const hit = cache.get(node);
  if (hit && hit.deps.every(dep => doc.nodes[dep.id] === dep)) return hit;
  visiting.add(node.id);
  const deps: SceneNode[] = [];
  const operands: VectorPath[][] = [];
  for (const id of node.children ?? []) {
    const child = doc.nodes[id];
    if (!child) continue;
    const paths = operandPaths(doc, child, localMatrix(child), deps, visiting, live);
    if (paths) operands.push(paths);
  }
  visiting.delete(node.id);
  const paths = (live ? combinePathsLive : combinePaths)(node.booleanOperation ?? 'UNION', operands, booleanTolerance(node.width, node.height));
  const computed = {paths, deps};
  cache.set(node, computed);
  return computed;
}

/** The result of a BOOLEAN_OPERATION as paths in its own local space, as the editor draws it live (what the
 *  renderer fills and strokes, hit areas, bounds: combinePathsLive). Children are read recursively, nested booleans
 *  and groups included. Cached per node identity. What is written (a document, an export file) reads
 *  booleanGeometryExact. */
export function booleanGeometry(doc: DesignDocument, boolId: NodeId): VectorPath[] {
  const node = doc.nodes[boolId];
  if (!node || node.type !== 'BOOLEAN_OPERATION') return [];
  return computeBoolean(doc, node, new Set(), true).paths;
}

/** booleanGeometry through combinePaths, the same bytes on every engine: "Flatten", outline stroke, export. */
export function booleanGeometryExact(doc: DesignDocument, boolId: NodeId): VectorPath[] {
  const node = doc.nodes[boolId];
  if (!node || node.type !== 'BOOLEAN_OPERATION') return [];
  return computeBoolean(doc, node, new Set(), false).paths;
}

// ── Flattening a boolean ("Flatten", ⌘E) ─────────────────────────────────────────────────────

/** A VECTOR that replaces nodes: remove `remove`, then create `node` in `parentId` at `index`
 *  (an index into the children left after the removal). */
export type FlattenOutcome = {node: SceneNode; parentId: NodeId; index: number; remove: NodeId[]; skipped: {id: NodeId; reason: string}[]};

/** Node fields (x, y, rotation, flipX) that place a box of the given size so its local space maps
 *  to the parent by `matrix` (a rotation, optional mirror and translation). */
export function placementOf(matrix: Matrix, width: number, height: number): Pick<SceneNode, 'x' | 'y' | 'rotation'> & {flipX?: boolean} {
  const {rotation, flipX} = decompose(matrix);
  const base = localMatrix({x: 0, y: 0, width, height, rotation, flipX});
  const out: Pick<SceneNode, 'x' | 'y' | 'rotation'> & {flipX?: boolean} = {x: matrix[0][2] - base[0][2], y: matrix[1][2] - base[1][2], rotation};
  if (flipX) out.flipX = true;
  return out;
}

/** Paints moved from one box to another: gradient handles (and crop transforms) are in a node's
 *  unit box, so a vector whose box differs from its source's needs them re-expressed to keep
 *  every colour where it was. `from`/`to` map each unit box to one shared space. */
export function remapPaints(paints: readonly Paint[], from: Matrix, to: Matrix): Paint[] {
  const det = to[0][0] * to[1][1] - to[0][1] * to[1][0];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return structuredClone(paints as Paint[]);
  const map = multiply(invert(to), from);
  return paints.map(paint => {
    const copy = structuredClone(paint);
    if (copy.type === 'IMAGE') {
      // imageTransform maps the node's unit box into the image's: compose with the box change.
      if (copy.scaleMode === 'CROP' && copy.imageTransform) copy.imageTransform = multiply(copy.imageTransform, invert(map));
      return copy;
    }
    if (copy.type !== 'SOLID') copy.gradientHandlePositions = copy.gradientHandlePositions.map(p => apply(map, p)) as [Vec, Vec, Vec];
    return copy;
  });
}

/** Unit box of a node → the space its local matrix (or `matrix`) maps into. */
export const unitBoxMatrix = (node: Pick<SceneNode, 'width' | 'height'>, matrix: Matrix): Matrix => multiply(matrix, scaling(node.width, node.height));

export type VectorFromPathsOptions = {
  name?: string;
  /** The source's local space → the target parent's space (default: its own local matrix). */
  sourceMatrix?: Matrix;
  /** Paints to use instead of the source's (outline stroke fills with the strokes). */
  fills?: Paint[];
  strokes?: Paint[];
};

/** A VECTOR with the look of `source` (paints, stroke settings, effects, layer settings) whose
 *  paths are `paths` given in a space that maps to `parentId`'s by `matrix`. Its box is the
 *  paths' bounds, as Figma fits a vector's box to its network; paints are re-expressed in it. */
export function vectorFromPaths(source: SceneNode, paths: VectorPath[], matrix: Matrix, parentId: NodeId, options: VectorFromPathsOptions = {}): SceneNode {
  const bounds = pathsBounds(paths) ?? {x: 0, y: 0, width: 0, height: 0};
  const local = paths.map(p => ({windingRule: p.windingRule, commands: transformPath(p.commands, translation(-bounds.x, -bounds.y))}));
  const placed = multiply(matrix, translation(bounds.x, bounds.y));
  const placement = placementOf(placed, bounds.width, bounds.height);
  const from = unitBoxMatrix(source, options.sourceMatrix ?? localMatrix(source));
  const to = unitBoxMatrix(bounds, placed);
  const node = createNode('VECTOR', {
    id: newId(),
    parentId,
    name: options.name ?? source.name,
    ...placement,
    width: bounds.width,
    height: bounds.height,
    vectorPaths: local,
    visible: source.visible,
    locked: source.locked,
    opacity: source.opacity,
    blendMode: source.blendMode === 'PASS_THROUGH' ? 'NORMAL' : source.blendMode,
    isMask: source.isMask,
    fills: remapPaints(options.fills ?? source.fills, from, to),
    strokes: remapPaints(options.strokes ?? source.strokes, from, to),
    strokeWeight: source.strokeWeight,
    strokeAlign: source.strokeAlign,
    strokeCap: source.strokeCap,
    strokeJoin: source.strokeJoin,
    strokeMiterLimit: source.strokeMiterLimit,
    dashPattern: [...source.dashPattern],
    effects: structuredClone(source.effects),
    constraints: {...source.constraints},
    layoutPositioning: source.layoutPositioning,
    // A vector cannot hug; it keeps fixed or fill sizing in an auto-layout parent.
    layoutSizingHorizontal: source.layoutSizingHorizontal === 'FILL' ? 'FILL' : 'FIXED',
    layoutSizingVertical: source.layoutSizingVertical === 'FILL' ? 'FILL' : 'FIXED',
    exportSettings: structuredClone(source.exportSettings),
    reactions: structuredClone(source.reactions),
  });
  if (source.maskType) node.maskType = source.maskType;
  if (source.fillStyleId && !options.fills) node.fillStyleId = source.fillStyleId;
  if (source.strokeStyleId && !options.strokes) node.strokeStyleId = source.strokeStyleId;
  if (source.effectStyleId) node.effectStyleId = source.effectStyleId;
  if (source.strokeStartMarker) node.strokeStartMarker = source.strokeStartMarker;
  if (source.strokeEndMarker) node.strokeEndMarker = source.strokeEndMarker;
  return node;
}

/** "Flatten" for one boolean: a VECTOR with the boolean's result, look and place. Null when the
 *  node is not a boolean or its result is empty (nothing would be left to edit). */
export function flattenBoolean(doc: DesignDocument, boolId: NodeId): FlattenOutcome | null {
  const node = doc.nodes[boolId];
  if (!node || node.type !== 'BOOLEAN_OPERATION' || !node.parentId) return null;
  const paths = booleanGeometryExact(doc, boolId);
  if (!paths.length) return null;
  const parent = doc.nodes[node.parentId];
  const index = Math.max(0, parent?.children?.indexOf(boolId) ?? 0);
  return {node: vectorFromPaths(node, paths, localMatrix(node), node.parentId), parentId: node.parentId, index, remove: [boolId], skipped: []};
}

// ── Arrangements (the shape builder) ───────────────────────────────────────────────────────────

/** The operands' areas, flattened once with their curves remembered, and `toPaths` turning any area cut from them
 *  back into curves (an arc stays an arc). Plain TypeScript: a tool that picks pieces of the areas
 *  (shared/design/shape-builder.ts) clips them itself with polygon-clipping, so the curves can be found again. */
export function curvedArrangement(operands: readonly (readonly VectorPath[])[], tolerance: number): {areas: MultiPolygon[]; toPaths: (area: MultiPolygon) => VectorPath[]} {
  const provenance = new Provenance();
  const areas = budgeted(() => operands.map(paths => areaOf(paths, tolerance, provenance)));
  return {areas, toPaths: area => budgeted(() => pathsOfArea(area, provenance, tolerance))};
}

export type {Polygon, MultiPolygon};
