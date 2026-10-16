import type {ArcData, PathCommand, SceneNode, StrokeMarker, Vec, VectorPath} from './types';
import {ellipseArcCubics, cubicTangent, pathSegments, subpaths, type Cubic} from './paths';

// The outline of each node type as paths in its local box: what fills and strokes follow, what
// boolean operations, flattening, SVG export and hit testing read. The constructions follow
// Figma, so a file made there looks the same here:
//   - rectangles and frames: per-corner radii shared out along each side, bigger corners first,
//     and corner smoothing as Figma's squircle (a cubic, a shorter circular arc, a cubic);
//   - ellipses: arcs from `arcData` (clockwise from 3 o'clock), rings and donut slices;
//   - polygons and stars: inscribed in the box's ellipse with the first point at the top, each
//     vertex rounded by `cornerRadius` without the arcs overrunning half an edge;
//   - lines: from (0, 0) to (width, 0); vectors: their own paths.

const KAPPA = 0.5522847498307936; // cubic approximation of a quarter circle

const cubicCommand = (c: Cubic): PathCommand => ({type: 'C', x1: c[1].x, y1: c[1].y, x2: c[2].x, y2: c[2].y, x: c[3].x, y: c[3].y});
const finite = (value: number | undefined, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

// ── Rectangles ─────────────────────────────────────────────────────────────────────────────────

/** [top-left, top-right, bottom-right, bottom-left]. */
export type CornerRadii = [number, number, number, number];
/** A corner after clamping: the radius drawn and the length along each side it may use
 *  (radius plus smoothing stay within it). */
export type ResolvedCorner = {radius: number; budget: number};

/** The radii a rectangle-like node asks for (per corner when set, otherwise the single radius). */
export function cornerRadiiOf(node: Pick<SceneNode, 'cornerRadius' | 'rectangleCornerRadii'>): CornerRadii {
  const r = node.rectangleCornerRadii;
  if (r && r.length === 4) return [r[0], r[1], r[2], r[3]].map(v => Math.max(0, finite(v))) as CornerRadii;
  const single = Math.max(0, finite(node.cornerRadius));
  return [single, single, single, single];
}

// Corners in drawing order and the two sides each touches: [neighbour on the same horizontal side,
// neighbour on the same vertical side].
const NEIGHBOURS: [number, number][] = [[1, 3], [0, 2], [3, 1], [2, 0]];

/** Figma's sharing of the sides between corners: corners choose largest first; each takes, on
 *  each of its two sides, its share of the side in proportion to its radius against the
 *  neighbour's (or what the neighbour left, if it already chose), and keeps the smaller of the two.
 *  A uniform radius larger than the box therefore gives a pill, and one large corner next to
 *  sharp ones may use the whole side. */
export function resolveCornerRadii(width: number, height: number, radii: CornerRadii): ResolvedCorner[] {
  const w = Math.max(0, width), h = Math.max(0, height);
  const radius = radii.map(r => Math.max(0, finite(r)));
  const budget = [-1, -1, -1, -1];
  const order = [0, 1, 2, 3].sort((a, b) => radius[b] - radius[a] || a - b);
  for (const corner of order) {
    const r = radius[corner];
    let room = Infinity;
    NEIGHBOURS[corner].forEach((neighbour, k) => {
      const side = k === 0 ? w : h;
      const other = radius[neighbour];
      if (r === 0 && other === 0) { room = 0; return; }
      const share = budget[neighbour] >= 0 ? side - budget[neighbour] : (r / (r + other)) * side;
      room = Math.min(room, share);
    });
    budget[corner] = Math.max(0, room);
    radius[corner] = Math.min(r, budget[corner]);
  }
  return radius.map((r, k) => ({radius: r, budget: budget[k]}));
}

/** Figma's smoothed corner (as published in "Desperately seeking squircles" and reproduced by the
 *  figma-squircle package): the corner reaches `p` = (1 + smoothing)·radius along each side, made of
 *  a cubic easing in, a circular arc of 90°·(1 − smoothing) and a mirrored cubic. When the side
 *  cannot give that much room, Figma lowers the smoothing rather than the radius. */
export function smoothCornerParams(radius: number, smoothing: number, budget: number) {
  const s = Math.max(0, Math.min(smoothing, budget / radius - 1, 1));
  const p = Math.min((1 + s) * radius, budget);
  const arcMeasure = (Math.PI / 2) * (1 - s);
  const arcSection = Math.sin(arcMeasure / 2) * radius * Math.SQRT2;
  const angleAlpha = (Math.PI / 2 - arcMeasure) / 2;
  const p3ToP4 = radius * Math.tan(angleAlpha / 2);
  const angleBeta = (Math.PI / 4) * s;
  const c = p3ToP4 * Math.cos(angleBeta);
  const d = c * Math.tan(angleBeta);
  const b = (p - arcSection - c - d) / 3;
  const a = 2 * b;
  return {smoothing: s, p, a, b, c, d, arcMeasure};
}

/** A rectangle outline from its top edge, clockwise on screen, with per-corner radii (clamped as
 *  Figma clamps them) and corner smoothing 0..1. Sharp rectangles are four lines. */
export function rectanglePath(width: number, height: number, radii: CornerRadii = [0, 0, 0, 0], smoothing = 0): PathCommand[] {
  const w = Math.max(0, finite(width)), h = Math.max(0, finite(height));
  const corners = resolveCornerRadii(w, h, radii);
  smoothing = Math.max(0, Math.min(1, finite(smoothing)));
  // Each corner: its vertex, the direction travelled into it and the direction out of it.
  const frames: {v: Vec; u: Vec; o: Vec}[] = [
    {v: {x: 0, y: 0}, u: {x: 0, y: -1}, o: {x: 1, y: 0}},
    {v: {x: w, y: 0}, u: {x: 1, y: 0}, o: {x: 0, y: 1}},
    {v: {x: w, y: h}, u: {x: 0, y: 1}, o: {x: -1, y: 0}},
    {v: {x: 0, y: h}, u: {x: -1, y: 0}, o: {x: 0, y: -1}},
  ];
  // point(k, back, along): `back` before corner k on the side coming in, then `along` the side going out.
  const at = (k: number, back: number, along: number): Vec => {
    const {v, u, o} = frames[k];
    return {x: v.x - u.x * back + o.x * along, y: v.y - u.y * back + o.y * along};
  };
  const params = corners.map(({radius, budget}) => (radius > 0 ? smoothCornerParams(radius, smoothing, budget) : null));
  const reach = params.map(p => (p ? p.p : 0));
  const start = at(0, 0, reach[0]);
  const out: PathCommand[] = [{type: 'M', x: start.x, y: start.y}];
  let current = start;
  const lineTo = (p: Vec) => {
    if (Math.abs(p.x - current.x) > 1e-9 || Math.abs(p.y - current.y) > 1e-9) out.push({type: 'L', x: p.x, y: p.y});
    current = p;
  };
  const curveTo = (c1: Vec, c2: Vec, p: Vec) => {
    out.push({type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y});
    current = p;
  };
  for (const k of [1, 2, 3, 0]) {
    const param = params[k];
    if (!param) {
      if (k !== 0) lineTo(frames[k].v);
      continue;
    }
    const r = corners[k].radius;
    lineTo(at(k, param.p, 0));
    if (param.smoothing <= 1e-9) {
      curveTo(at(k, r * (1 - KAPPA), 0), at(k, 0, r * (1 - KAPPA)), at(k, 0, r));
      continue;
    }
    const {p, a, b, c, d, arcMeasure} = param;
    curveTo(at(k, p - a, 0), at(k, p - a - b, 0), at(k, p - a - b - c, d));
    if (arcMeasure > 1e-9) {
      // The arc around the corner's circle centre, turning the same way as the rectangle.
      const center = at(k, r, r);
      const from = at(k, p - a - b - c, d);
      const startAngle = Math.atan2(from.y - center.y, from.x - center.x);
      for (const piece of ellipseArcCubics(center, r, r, 0, startAngle, arcMeasure)) curveTo(piece[1], piece[2], piece[3]);
    }
    curveTo(at(k, 0, p - a - b), at(k, 0, p - a), at(k, 0, p));
  }
  // The last corner ends where the path started: Z closes without a line.
  const last = out[out.length - 1];
  if (last.type === 'L' && Math.abs(last.x - start.x) < 1e-9 && Math.abs(last.y - start.y) < 1e-9) out.pop();
  out.push({type: 'Z'});
  return out;
}

// ── Ellipses ───────────────────────────────────────────────────────────────────────────────────

const FULL_TURN = 2 * Math.PI;

/** An ellipse filling the box, or its arc: a pie slice from the centre, a ring (two subpaths,
 *  EVENODD) or a donut slice when `innerRadius` > 0. A sweep of a full turn or more, or of
 *  nothing, draws the whole ellipse. */
export function ellipsePaths(width: number, height: number, arc?: ArcData): VectorPath[] {
  const rx = Math.max(0, finite(width)) / 2, ry = Math.max(0, finite(height)) / 2;
  const center = {x: rx, y: ry};
  const start = finite(arc?.startingAngle);
  const sweep = finite(arc?.endingAngle, FULL_TURN) - start;
  const inner = Math.max(0, Math.min(1, finite(arc?.innerRadius)));
  const full = Math.abs(sweep) >= FULL_TURN - 1e-6 || Math.abs(sweep) < 1e-9;
  const pointAt = (sx: number, sy: number, angle: number): Vec => ({x: center.x + sx * Math.cos(angle), y: center.y + sy * Math.sin(angle)});
  const arcCommands = (sx: number, sy: number, from: number, by: number) => ellipseArcCubics(center, sx, sy, 0, from, by).map(cubicCommand);
  // A whole turn must end exactly where it began (cos 2π is not exactly 1 in floating point).
  const loop = (sx: number, sy: number, by: number): PathCommand[] => {
    const commands = arcCommands(sx, sy, 0, by);
    const last = commands[commands.length - 1];
    if (last?.type === 'C') { last.x = center.x + sx; last.y = center.y; }
    return [{type: 'M', x: center.x + sx, y: center.y}, ...commands, {type: 'Z'}];
  };
  if (full) {
    const outer = loop(rx, ry, FULL_TURN);
    if (inner <= 0) return [{windingRule: 'NONZERO', commands: outer}];
    // The hole runs the other way too, so the ring is right under either winding rule.
    const hole = loop(rx * inner, ry * inner, -FULL_TURN);
    return [{windingRule: 'EVENODD', commands: [...outer, ...hole]}];
  }
  const begin = pointAt(rx, ry, start);
  if (inner <= 0) {
    return [{windingRule: 'NONZERO', commands: [{type: 'M', x: center.x, y: center.y}, {type: 'L', x: begin.x, y: begin.y}, ...arcCommands(rx, ry, start, sweep), {type: 'Z'}]}];
  }
  const ix = rx * inner, iy = ry * inner;
  const innerEnd = pointAt(ix, iy, start + sweep);
  return [{windingRule: 'NONZERO', commands: [
    {type: 'M', x: begin.x, y: begin.y},
    ...arcCommands(rx, ry, start, sweep),
    {type: 'L', x: innerEnd.x, y: innerEnd.y},
    ...arcCommands(ix, iy, start + sweep, -sweep),
    {type: 'Z'},
  ]}];
}

// ── Polygons and stars ─────────────────────────────────────────────────────────────────────────

/** Vertices of a regular polygon (or a star, with `inner` as the ratio of the inner points)
 *  inscribed in the box's ellipse, first point at the top centre, going clockwise. */
export function polygonVertices(width: number, height: number, pointCount: number, inner: number | null = null): Vec[] {
  const count = Math.max(3, Math.min(1000, Math.round(finite(pointCount, 3))));
  const total = inner === null ? count : count * 2;
  const rx = Math.max(0, finite(width)) / 2, ry = Math.max(0, finite(height)) / 2;
  const out: Vec[] = [];
  for (let k = 0; k < total; k++) {
    const angle = -Math.PI / 2 + (k * 2 * Math.PI) / total;
    const s = inner !== null && k % 2 ? Math.max(0, Math.min(1, inner)) : 1;
    out.push({x: rx + Math.cos(angle) * rx * s, y: ry + Math.sin(angle) * ry * s});
  }
  return out;
}

/** A closed polygon through `points` with every vertex rounded by `radius` (a number, or one per
 *  vertex). Each arc is tangent to both edges, and its tangent points never pass the middle of an
 *  edge, so neighbouring arcs cannot overlap: a radius too large for its corner shrinks there
 *  only. Concave (star) vertices round the other way. Arcs over 90° are split. */
export function roundedPolygonPath(points: readonly Vec[], radius: number | readonly number[] = 0): PathCommand[] {
  const n = points.length;
  if (n < 2) return n ? [{type: 'M', x: points[0].x, y: points[0].y}, {type: 'Z'}] : [];
  const radiusAt = (k: number) => Math.max(0, finite(typeof radius === 'number' ? radius : radius[k]));
  const out: PathCommand[] = [];
  const push = (p: Vec, first: boolean) => out.push({type: first ? 'M' : 'L', x: p.x, y: p.y});
  for (let k = 0; k < n; k++) {
    const prev = points[(k + n - 1) % n], v = points[k], next = points[(k + 1) % n];
    const inLength = Math.hypot(v.x - prev.x, v.y - prev.y), outLength = Math.hypot(next.x - v.x, next.y - v.y);
    const r = radiusAt(k);
    if (!r || inLength < 1e-9 || outLength < 1e-9) { push(v, k === 0); continue; }
    const din = {x: (v.x - prev.x) / inLength, y: (v.y - prev.y) / inLength};
    const dout = {x: (next.x - v.x) / outLength, y: (next.y - v.y) / outLength};
    const turn = Math.atan2(din.x * dout.y - din.y * dout.x, din.x * dout.x + din.y * dout.y);
    const absTurn = Math.abs(turn);
    if (absTurn < 1e-6 || absTurn > Math.PI - 1e-6) { push(v, k === 0); continue; }
    const half = Math.tan(absTurn / 2);
    const tangent = Math.min(r * half, inLength / 2, outLength / 2);
    const effective = tangent / half;
    const a = {x: v.x - din.x * tangent, y: v.y - din.y * tangent};
    // The centre sits on the side the path turns towards.
    const side = turn > 0 ? 1 : -1;
    const center = {x: a.x - din.y * effective * side, y: a.y + din.x * effective * side};
    push(a, k === 0);
    const startAngle = Math.atan2(a.y - center.y, a.x - center.x);
    for (const piece of ellipseArcCubics(center, effective, effective, 0, startAngle, turn)) out.push(cubicCommand(piece));
  }
  out.push({type: 'Z'});
  return out;
}

export const polygonPath = (width: number, height: number, pointCount: number, cornerRadius = 0): PathCommand[] =>
  roundedPolygonPath(polygonVertices(width, height, pointCount), cornerRadius);

export const starPath = (width: number, height: number, pointCount: number, innerRadius: number, cornerRadius = 0): PathCommand[] =>
  roundedPolygonPath(polygonVertices(width, height, pointCount, innerRadius), cornerRadius);

// ── Nodes ──────────────────────────────────────────────────────────────────────────────────────

/** The node's fill outline in local coordinates. Empty for nodes that draw no geometry of their own
 *  (pages, groups, boolean operations, text, slices); boolean geometry lives in boolean.ts. */
export function nodeGeometry(node: SceneNode): VectorPath[] {
  const w = Math.max(0, finite(node.width)), h = Math.max(0, finite(node.height));
  switch (node.type) {
    case 'RECTANGLE': case 'FRAME': case 'COMPONENT': case 'COMPONENT_SET': case 'INSTANCE': case 'SECTION':
      return [{windingRule: 'NONZERO', commands: rectanglePath(w, h, cornerRadiiOf(node), node.cornerSmoothing ?? 0)}];
    case 'ELLIPSE':
      return ellipsePaths(w, h, node.arcData);
    case 'POLYGON':
      return [{windingRule: 'NONZERO', commands: polygonPath(w, h, node.pointCount ?? 3, node.cornerRadius ?? 0)}];
    case 'STAR':
      return [{windingRule: 'NONZERO', commands: starPath(w, h, node.pointCount ?? 5, node.innerRadius ?? 0.382, node.cornerRadius ?? 0)}];
    case 'LINE':
      return [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: w, y: 0}]}];
    case 'VECTOR':
      return node.vectorPaths ?? [];
    default:
      return [];
  }
}

// ── Stroke ends and markers ────────────────────────────────────────────────────────────────────

/** An end of an open subpath: where it is, which way an arrow there points (out of the path,
 *  unit length), and the marker the node asks for there. */
export type StrokeEnd = {point: Vec; direction: Vec; position: 'START' | 'END'; subpath: number; marker: StrokeMarker};
export type StrokeGeometry = {paths: VectorPath[]; ends: StrokeEnd[]};

/** What strokes follow, plus the ends of open subpaths (LINE and VECTOR) with their outward
 *  directions, so renderers and exporters can place markers and caps the same way. */
export function strokeGeometry(node: SceneNode): StrokeGeometry {
  const paths = nodeGeometry(node);
  if (node.type !== 'LINE' && node.type !== 'VECTOR') return {paths, ends: []};
  return {paths, ends: pathEnds(paths, node.strokeStartMarker ?? 'NONE', node.strokeEndMarker ?? 'NONE')};
}

/** Ends of every open subpath of `paths`, each with its outward direction and the marker given
 *  for starts and ends. Closed subpaths have no ends. */
export function pathEnds(paths: readonly VectorPath[], startMarker: StrokeMarker = 'NONE', endMarker: StrokeMarker = 'NONE'): StrokeEnd[] {
  const ends: StrokeEnd[] = [];
  let subpath = 0;
  for (const path of paths) {
    for (const part of subpaths(path.commands)) {
      const index = subpath++;
      if (part[part.length - 1].type === 'Z') continue;
      const segments = pathSegments(part);
      if (!segments.length) continue;
      const first = segments[0], last = segments[segments.length - 1];
      const startCubic: Cubic = first.kind === 'cubic' ? [first.p0, first.c1, first.c2, first.p1] : [first.p0, first.p0, first.p1, first.p1];
      const endCubic: Cubic = last.kind === 'cubic' ? [last.p0, last.c1, last.c2, last.p1] : [last.p0, last.p0, last.p1, last.p1];
      const startTangent = cubicTangent(startCubic, 0), endTangent = cubicTangent(endCubic, 1);
      ends.push({point: first.p0, direction: {x: -startTangent.x, y: -startTangent.y}, position: 'START', subpath: index, marker: startMarker});
      ends.push({point: last.p1, direction: endTangent, position: 'END', subpath: index, marker: endMarker});
    }
  }
  return ends;
}

/** Marker proportions, in stroke weights plus a fixed part so thin lines still get a readable
 *  arrow: the canvas's (src/design/engine/render/stroke-math.ts `markerShape`, sized by bounds.ts
 *  `markerSize`), so outline stroke, SVG export and the vector PDF draw what the canvas shows. */
export const MARKER_SIZE = {
  arrowLength: (weight: number) => weight * 3 + 2,
  arrowHalfWidth: (weight: number) => (weight * 3 + 2) / Math.sqrt(3),
  dotRadius: (weight: number) => (weight * 3 + 2) * 0.4,
  diamondRadius: (weight: number) => (weight * 3 + 2) * 0.55,
  chevronArm: (weight: number) => (weight * 3 + 2) * 0.75,
} as const;

/** The marker at a stroke end, in the node's local space. `fill` is drawn with the stroke's paint
 *  as a fill; `stroke` (the open chevron of LINE_ARROW) is stroked with the node's stroke
 *  settings; `trim` is how far the line should stop short of the end so its own cap does not
 *  poke out of the marker. ROUND and SQUARE replace the stroke cap at that end. */
export function markerGeometry(marker: StrokeMarker, end: Pick<StrokeEnd, 'point' | 'direction'>, weight: number): {fill: PathCommand[]; stroke: PathCommand[]; trim: number} {
  const w = Math.max(0, finite(weight));
  const {point: p, direction: d} = end;
  const n = {x: -d.y, y: d.x};
  const at = (forward: number, across: number): Vec => ({x: p.x + d.x * forward + n.x * across, y: p.y + d.y * forward + n.y * across});
  const polygon = (points: Vec[]): PathCommand[] => [...points.map((q, k) => ({type: k ? 'L' as const : 'M' as const, x: q.x, y: q.y})), {type: 'Z'}];
  const length = MARKER_SIZE.arrowLength(w), halfWidth = MARKER_SIZE.arrowHalfWidth(w);
  switch (marker) {
    case 'LINE_ARROW': {
      const arm = MARKER_SIZE.chevronArm(w);
      const a = at(-arm, arm), b = at(-arm, -arm);
      return {fill: [], stroke: [{type: 'M', x: a.x, y: a.y}, {type: 'L', x: p.x, y: p.y}, {type: 'L', x: b.x, y: b.y}], trim: 0};
    }
    case 'TRIANGLE_ARROW':
      return {fill: polygon([at(0, 0), at(-length, halfWidth), at(-length, -halfWidth)]), stroke: [], trim: Math.min(length * 0.6, w * 1.5)};
    case 'REVERSED_TRIANGLE':
      return {fill: polygon([at(-length, 0), at(0, -halfWidth), at(0, halfWidth)]), stroke: [], trim: 0};
    case 'CIRCLE': {
      const r = MARKER_SIZE.dotRadius(w);
      return {fill: [{type: 'M', x: p.x + r, y: p.y}, ...ellipseArcCubics(p, r, r, 0, 0, FULL_TURN).map(cubicCommand), {type: 'Z'}], stroke: [], trim: 0};
    }
    case 'DIAMOND': {
      const r = MARKER_SIZE.diamondRadius(w);
      return {fill: polygon([at(r, 0), at(0, r), at(-r, 0), at(0, -r)]), stroke: [], trim: 0};
    }
    case 'ROUND': {
      const r = w / 2;
      if (!r) return {fill: [], stroke: [], trim: 0};
      const startAngle = Math.atan2(n.y, n.x);
      return {fill: [{type: 'M', x: p.x + n.x * r, y: p.y + n.y * r}, ...ellipseArcCubics(p, r, r, 0, startAngle, -Math.PI).map(cubicCommand), {type: 'Z'}], stroke: [], trim: 0};
    }
    case 'SQUARE':
      return w ? {fill: polygon([at(0, w / 2), at(w / 2, w / 2), at(w / 2, -w / 2), at(0, -w / 2)]), stroke: [], trim: 0} : {fill: [], stroke: [], trim: 0};
    default:
      return {fill: [], stroke: [], trim: 0};
  }
}
