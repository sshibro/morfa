import type {MultiPolygon, Pair, Polygon, Ring} from 'polygon-clipping';
import type {DesignDocument, NodeId, PathCommand, SceneNode, StrokeAlign, StrokeCap, StrokeJoin, StrokeMarker, Vec, VectorPath} from './types';
import {localMatrix, transformRect, unionRects, type Rect} from './geometry';
import {appendLine, fitCubics, flattenPath, subpaths, type Polyline} from './paths';
import {cornerRadiiOf, markerGeometry, nodeGeometry, pathEnds, rectanglePath, type CornerRadii} from './shapes';
import {booleanGeometryExact, combineAreas, fillArea, vectorFromPaths} from './boolean';
import {createNode, newId} from './defaults';
import {hasVariableWidth, variableWidthOutline} from './stroke-profile';
import {engineTs} from './engine-switch';
import {geometryCall, wasmDashPolylines, wasmPolygonsToSmoothPaths, wasmStrokeArea} from './geometry-wasm';

// "Outline stroke" (⇧⌘O): the area a stroke paints, as filled paths. Each subpath is flattened
// with steps small enough for its offset (the turn per step is bounded by the stroke width),
// dashed, and swept into simple pieces: a ribbon along every run of gently turning points (the
// offsets meet at their miter points), the node's join at real corners (miter within the limit,
// bevel, round), caps or markers at open ends. polygon-clipping unions the pieces, which also
// resolves every overlap of a stroke with itself. INSIDE and OUTSIDE strokes are a doubled
// CENTER stroke clipped to, or cut by, the fill. The result's smooth runs are fitted back to
// cubics, so the vector stays editable; at normal zoom it is indistinguishable from the stroke.

export type StrokeStyle = {
  weight: number;
  align: StrokeAlign;
  cap: StrokeCap;
  join: StrokeJoin;
  miterLimit: number;
  dashPattern: readonly number[];
};

export const strokeStyleOf = (node: SceneNode): StrokeStyle => ({
  weight: node.strokeWeight, align: node.strokeAlign, cap: node.strokeCap, join: node.strokeJoin, miterLimit: node.strokeMiterLimit, dashPattern: node.dashPattern,
});

const MAX_DASHES = 50_000;

type V = Vec;
const sub = (a: V, b: V): V => ({x: a.x - b.x, y: a.y - b.y});
const addScaled = (a: V, b: V, s: number): V => ({x: a.x + b.x * s, y: a.y + b.y * s});
const len = (a: V) => Math.hypot(a.x, a.y);
const unit = (a: V): V => { const l = len(a); return l ? {x: a.x / l, y: a.y / l} : {x: 1, y: 0}; };
/** Left of the travel direction on screen (y down). */
const leftNormal = (d: V): V => ({x: d.y, y: -d.x});
const pair = (p: V): Pair => [p.x, p.y];

/** Polygon of a circle around `c`, steps no coarser than `maxAngle`. */
function disc(c: V, r: number, maxAngle: number): Ring {
  const steps = Math.max(8, Math.ceil((2 * Math.PI) / maxAngle));
  const ring: Ring = [];
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * 2 * Math.PI;
    ring.push([c.x + Math.cos(a) * r, c.y + Math.sin(a) * r]);
  }
  return ring;
}

/** Splits polylines into dashes (SVG semantics: an odd pattern repeats twice, each subpath
 *  starts the pattern afresh). Returns the input when the pattern draws everything or would make
 *  more dashes than are sensible to outline. */
export function dashPolylines(lines: readonly Polyline[], pattern: readonly number[]): Polyline[] {
  if (engineTs('geometry')) return dashPolylinesTs(lines, pattern);
  return geometryCall('dashPolylines', () => dashPolylinesTs(lines, pattern), wasm => wasmDashPolylines(wasm, lines, pattern), () => ({lines, pattern}));
}

function dashPolylinesTs(lines: readonly Polyline[], pattern: readonly number[]): Polyline[] {
  const clean = pattern.filter(v => Number.isFinite(v) && v >= 0);
  const dashes = clean.length % 2 ? [...clean, ...clean] : clean;
  const period = dashes.reduce((a, b) => a + b, 0);
  // No pattern, or no gaps: the stroke is solid.
  if (!dashes.length || period <= 0 || dashes.every((v, k) => k % 2 === 0 || v === 0)) return lines.slice();
  let total = 0;
  for (const line of lines) {
    const pts = line.closed ? [...line.points, line.points[0]] : line.points;
    for (let k = 1; k < pts.length; k++) total += len(sub(pts[k], pts[k - 1]));
  }
  if (total / period * (dashes.length / 2) > MAX_DASHES) return lines.slice();
  const out: Polyline[] = [];
  for (const line of lines) {
    const pts = line.closed ? [...line.points, line.points[0]] : line.points;
    let index = 0, remaining = dashes[0], on = true;
    let current: V[] | null = [pts[0]];
    const flush = () => { if (current && current.length) out.push({points: current, closed: false}); current = null; };
    for (let k = 1; k < pts.length; k++) {
      let a = pts[k - 1];
      const b = pts[k];
      let segment = len(sub(b, a));
      // ≥: a dash due exactly at a point (the path's end included) is still drawn, as in SVG.
      while (segment >= remaining) {
        const p = addScaled(a, unit(sub(b, a)), remaining);
        segment -= remaining;
        a = p;
        if (on) { current!.push(p); flush(); }
        else current = [p];
        on = !on;
        index = (index + 1) % dashes.length;
        remaining = dashes[index];
      }
      remaining -= segment;
      if (on) current!.push(b);
    }
    // A dash the path's end cut down to nothing is not drawn (dots of zero-length dashes were
    // already emitted where they fell).
    const rest = current as V[] | null;
    if (on && rest && rest.some(p => p.x !== rest[0].x || p.y !== rest[0].y)) flush();
  }
  return out;
}

/** Shortens an open polyline by `start` and `end` along its length (for markers). */
function trimPolyline(points: V[], start: number, end: number): V[] {
  const cut = (pts: V[], amount: number): V[] => {
    if (amount <= 0) return pts;
    for (let k = 1; k < pts.length; k++) {
      const l = len(sub(pts[k], pts[k - 1]));
      if (amount < l) return [addScaled(pts[k - 1], unit(sub(pts[k], pts[k - 1])), amount), ...pts.slice(k)];
      amount -= l;
    }
    return [pts[pts.length - 1]];
  };
  return cut(cut(points, start).reverse(), end).reverse();
}

type Caps = {start: StrokeCap; end: StrokeCap};

/** The pieces sweeping one polyline with a pen `weight` wide. */
function strokePieces(line: Polyline, style: StrokeStyle, weight: number, caps: Caps, maxAngle: number, out: Ring[]): void {
  const hw = weight / 2;
  if (!(hw > 0)) return;
  const pts: V[] = [];
  for (const p of line.points) if (!pts.length || len(sub(p, pts[pts.length - 1])) > 1e-9) pts.push(p);
  if (line.closed && pts.length > 1 && len(sub(pts[0], pts[pts.length - 1])) <= 1e-9) pts.pop();
  if (pts.length === 1) {
    // A zero-length subpath: round and square caps still paint a dot, as in SVG.
    const p = pts[0];
    const cap = caps.start === 'NONE' ? caps.end : caps.start;
    if (cap === 'ROUND') out.push(disc(p, hw, maxAngle));
    else if (cap === 'SQUARE') out.push([[p.x - hw, p.y - hw], [p.x + hw, p.y - hw], [p.x + hw, p.y + hw], [p.x - hw, p.y + hw]]);
    return;
  }
  if (!pts.length) return;
  const closed = line.closed && pts.length > 2;
  // Unroll a closed loop so it starts and ends at its sharpest vertex, which then gets a join.
  let chain = pts;
  if (closed) {
    let sharpest = 0, sharpestTurn = -1;
    for (let k = 0; k < pts.length; k++) {
      const turn = turnAt(pts[(k + pts.length - 1) % pts.length], pts[k], pts[(k + 1) % pts.length]);
      if (turn > sharpestTurn) { sharpestTurn = turn; sharpest = k; }
    }
    chain = [...pts.slice(sharpest), ...pts.slice(0, sharpest), pts[sharpest]];
  }
  const n = chain.length;
  const dirs: V[] = [];
  for (let k = 1; k < n; k++) dirs.push(unit(sub(chain[k], chain[k - 1])));
  const lengths: number[] = [];
  for (let k = 1; k < n; k++) lengths.push(len(sub(chain[k], chain[k - 1])));
  const smoothLimit = Math.max(maxAngle * 1.5, 0.05);
  // Interior vertex k (between dirs[k − 1] and dirs[k]) continues a ribbon when it turns gently
  // and the inner offset does not fold back past its neighbours.
  const smooth = (k: number) => {
    const din = dirs[k - 1], dout = dirs[k];
    const turn = Math.acos(Math.max(-1, Math.min(1, din.x * dout.x + din.y * dout.y)));
    if (turn > smoothLimit) return false;
    return hw * Math.tan(turn / 2) <= Math.min(lengths[k - 1], lengths[k]) * 0.5;
  };
  const gentle = (k: number) => {
    const din = dirs[k - 1], dout = dirs[k];
    return Math.acos(Math.max(-1, Math.min(1, din.x * dout.x + din.y * dout.y))) <= smoothLimit;
  };
  // A loop that is smooth even at its sharpest vertex closes its ribbon on itself: both ends take
  // the miter offset of the seam, so the union leaves no trace of where it started.
  let seam: V | undefined;
  if (closed) {
    const a = leftNormal(dirs[n - 2]), b = leftNormal(dirs[0]);
    const turn = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)));
    if (turn <= smoothLimit && hw * Math.tan(turn / 2) <= Math.min(lengths[n - 2], lengths[0]) * 0.5) {
      const s = hw / (1 + a.x * b.x + a.y * b.y);
      seam = {x: (a.x + b.x) * s, y: (a.y + b.y) * s};
    }
  }
  let runStart = 0;
  for (let k = 1; k < n; k++) {
    const last = k === n - 1;
    if (!last && smooth(k)) continue;
    out.push(ribbon(chain, dirs, runStart, k, hw, runStart === 0 ? seam : undefined, last ? seam : undefined));
    if (!last) join(chain[k], dirs[k - 1], dirs[k], gentle(k) ? 'ROUND' : style.join, style.miterLimit, hw, maxAngle, out);
    runStart = k;
  }
  if (closed) {
    if (!seam) join(chain[0], dirs[n - 2], dirs[0], style.join, style.miterLimit, hw, maxAngle, out);
  } else {
    cap(chain[0], dirs[0], -1, caps.start, hw, maxAngle, out);
    cap(chain[n - 1], dirs[n - 2], 1, caps.end, hw, maxAngle, out);
  }
}

function turnAt(a: V, b: V, c: V): number {
  const d1 = unit(sub(b, a)), d2 = unit(sub(c, b));
  return Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y)));
}

/** The strip along vertices from..to: left offsets forward, right offsets back; inner vertices
 *  sit at the miter points of their two segments. */
function ribbon(pts: V[], dirs: V[], from: number, to: number, hw: number, startOffset?: V, endOffset?: V): Ring {
  const left: Pair[] = [], right: Pair[] = [];
  for (let k = from; k <= to; k++) {
    let offset: V;
    if (k === from) offset = startOffset ?? addScaled({x: 0, y: 0}, leftNormal(dirs[k]), hw);
    else if (k === to) offset = endOffset ?? addScaled({x: 0, y: 0}, leftNormal(dirs[k - 1]), hw);
    else {
      const a = leftNormal(dirs[k - 1]), b = leftNormal(dirs[k]);
      const s = hw / (1 + a.x * b.x + a.y * b.y);
      offset = {x: (a.x + b.x) * s, y: (a.y + b.y) * s};
    }
    left.push([pts[k].x + offset.x, pts[k].y + offset.y]);
    right.push([pts[k].x - offset.x, pts[k].y - offset.y]);
  }
  return [...left, ...right.reverse()];
}

/** The outer wedge at a corner; the inner side is covered by the two ribbons overlapping. */
function join(v: V, din: V, dout: V, kind: StrokeJoin, miterLimit: number, hw: number, maxAngle: number, out: Ring[]): void {
  const turnCross = din.x * dout.y - din.y * dout.x;
  const cosTurn = din.x * dout.x + din.y * dout.y;
  if (Math.abs(turnCross) < 1e-12 && cosTurn > 0) return;
  const side = turnCross > 0 ? 1 : -1; // the outer side: left of travel for a clockwise turn
  const na = leftNormal(din), nb = leftNormal(dout);
  const a = addScaled(v, na, hw * side), b = addScaled(v, nb, hw * side);
  if (kind === 'ROUND') {
    // A full reversal has no outer side: the whole pen disc covers it.
    if (cosTurn < -1 + 1e-9) { out.push(disc(v, hw, maxAngle)); return; }
    const start = Math.atan2(a.y - v.y, a.x - v.x);
    let sweep = Math.atan2(b.y - v.y, b.x - v.x) - start;
    if (side < 0) { while (sweep > 0) sweep -= 2 * Math.PI; } else { while (sweep < 0) sweep += 2 * Math.PI; }
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / maxAngle));
    // Exact end points, so the wedge meets the ribbons' corners without slivers.
    const ring: Ring = [pair(v), pair(a)];
    for (let k = 1; k < steps; k++) {
      const angle = start + (sweep * k) / steps;
      ring.push([v.x + Math.cos(angle) * hw, v.y + Math.sin(angle) * hw]);
    }
    ring.push(pair(b));
    out.push(ring);
    return;
  }
  if (kind === 'MITER') {
    // Miter length over stroke width is 1 / sin(φ/2), φ the angle between the two segments.
    const halfInterior = (Math.PI - Math.acos(Math.max(-1, Math.min(1, cosTurn)))) / 2;
    if (Math.sin(halfInterior) > 1e-9 && 1 / Math.sin(halfInterior) <= miterLimit) {
      const s = hw / (1 + na.x * nb.x + na.y * nb.y);
      const tip = {x: v.x + (na.x + nb.x) * s * side, y: v.y + (na.y + nb.y) * s * side};
      out.push([pair(v), pair(a), pair(tip), pair(b)]);
      return;
    }
  }
  out.push([pair(v), pair(a), pair(b)]);
}

function cap(p: V, d: V, outward: 1 | -1, kind: StrokeCap, hw: number, maxAngle: number, out: Ring[]): void {
  if (kind === 'ROUND') {
    // Half a pen disc from one ribbon corner round the end to the other, corners exact.
    const n = leftNormal(d), e = {x: d.x * outward, y: d.y * outward};
    const steps = Math.max(4, Math.ceil(Math.PI / maxAngle));
    const ring: Ring = [pair(addScaled(p, n, hw))];
    for (let k = 1; k < steps; k++) {
      const angle = (Math.PI * k) / steps;
      ring.push([p.x + (n.x * Math.cos(angle) + e.x * Math.sin(angle)) * hw, p.y + (n.y * Math.cos(angle) + e.y * Math.sin(angle)) * hw]);
    }
    ring.push(pair(addScaled(p, n, -hw)));
    out.push(ring);
  } else if (kind === 'SQUARE') {
    const n = leftNormal(d), e = {x: d.x * outward * hw, y: d.y * outward * hw};
    out.push([pair(addScaled(p, n, hw)), pair(addScaled(addScaled(p, n, hw), e, 1)), pair(addScaled(addScaled(p, n, -hw), e, 1)), pair(addScaled(p, n, -hw))]);
  }
}

/** Stroke tolerance: finer for thin strokes, never coarser than 0.05 px. */
export const strokeTolerance = (weight: number) => Math.min(0.05, Math.max(0.004, weight * 0.005));

/** The area a CENTER stroke of `weight` paints along `paths` (no alignment, no individual weights). */
function centerArea(polylines: Polyline[], style: StrokeStyle, weight: number, caps: (k: number) => Caps, tolerance: number): MultiPolygon {
  const hw = weight / 2;
  const maxAngle = Math.min(0.35, Math.max(0.03, 2 * Math.acos(Math.max(-1, 1 - tolerance / Math.max(hw, tolerance)))));
  const rings: Ring[] = [];
  polylines.forEach((line, k) => strokePieces(line, style, weight, caps(k), maxAngle, rings));
  const pieces = rings.filter(r => r.length >= 3).map(r => [[r]] as MultiPolygon);
  return pieces.length ? combineAreas('UNION', pieces) : [];
}

/** Flattening steps for offsetting: chord error within tolerance and the turn per step small
 *  enough that the offset at half the weight stays within tolerance too. */
function strokeFlatten(commands: readonly PathCommand[], weight: number, tolerance: number): Polyline[] {
  const hw = Math.max(weight / 2, tolerance);
  const maxAngle = Math.min(0.35, Math.max(0.03, 2 * Math.acos(Math.max(-1, 1 - tolerance / hw))));
  return flattenPath(commands, tolerance, {maxAngle});
}

/** The stroke area of `paths` with `style`, as polygons. `ends` adds markers at open ends. Lane L1's port answers in
 *  `wasm` and `both` (shared/design/geometry-wasm.ts), as do dashPolylines and polygonsToSmoothPaths. */
export function strokeArea(paths: readonly VectorPath[], style: StrokeStyle, options: {tolerance?: number; startMarker?: StrokeMarker; endMarker?: StrokeMarker} = {}): MultiPolygon {
  if (engineTs('geometry')) return strokeAreaTs(paths, style, options);
  return geometryCall('strokeArea', () => strokeAreaTs(paths, style, options), wasm => wasmStrokeArea(wasm, paths, style, options), () => ({paths, style, options}));
}

function strokeAreaTs(paths: readonly VectorPath[], style: StrokeStyle, options: {tolerance?: number; startMarker?: StrokeMarker; endMarker?: StrokeMarker}): MultiPolygon {
  const weight = Math.max(0, style.weight);
  if (!(weight > 0)) return [];
  const tolerance = options.tolerance ?? strokeTolerance(weight);
  const startMarker = options.startMarker ?? 'NONE', endMarker = options.endMarker ?? 'NONE';
  const parts: MultiPolygon[] = [];
  for (const path of paths) {
    const pieces = subpaths(path.commands);
    const closedCommands: PathCommand[] = [];
    const openLines: Polyline[] = [], openCaps: Caps[] = [];
    const markerRings: Ring[] = [];
    const markerLines: Polyline[] = [];
    for (const piece of pieces) {
      const closed = piece[piece.length - 1].type === 'Z';
      if (closed) { closedCommands.push(...piece); continue; }
      const lines = strokeFlatten(piece, weight, tolerance);
      if (!lines.length) continue;
      let points = lines[0].points;
      // Markers sit on the curve's real ends and directions, not the flattened ones.
      const capAt = (marker: StrokeMarker): StrokeCap => (marker === 'ROUND' ? 'ROUND' : marker === 'SQUARE' ? 'SQUARE' : marker === 'NONE' ? style.cap : 'NONE');
      let trimStart = 0, trimEnd = 0;
      if (startMarker !== 'NONE' || endMarker !== 'NONE') {
        for (const end of pathEnds([{windingRule: 'NONZERO', commands: piece}], startMarker, endMarker)) {
          if (end.marker === 'NONE' || end.marker === 'ROUND' || end.marker === 'SQUARE') continue;
          const shape = markerGeometry(end.marker, end, weight);
          if (end.position === 'START') trimStart = shape.trim; else trimEnd = shape.trim;
          for (const line of flattenPath(shape.fill, tolerance)) if (line.points.length >= 3) markerRings.push(line.points.map(pair));
          for (const line of flattenPath(shape.stroke, tolerance)) markerLines.push(line);
        }
      }
      if (trimStart || trimEnd) points = trimPolyline(points, trimStart, trimEnd);
      const dashed = dashPolylines([{points, closed: false}], style.dashPattern);
      dashed.forEach((line, k) => {
        openLines.push(line);
        openCaps.push({start: k === 0 ? capAt(startMarker) : style.cap, end: k === dashed.length - 1 ? capAt(endMarker) : style.cap});
      });
    }
    if (openLines.length) parts.push(centerArea(openLines, style, weight, k => openCaps[k], tolerance));
    if (markerLines.length) parts.push(centerArea(markerLines, {...style, join: 'MITER', miterLimit: 10}, weight, () => ({start: style.cap, end: style.cap}), tolerance));
    if (markerRings.length) parts.push(combineAreas('UNION', markerRings.map(r => [[r]])));
    if (closedCommands.length) {
      const lines = dashPolylines(strokeFlatten(closedCommands, weight, tolerance), style.dashPattern);
      const aligned = style.align !== 'CENTER';
      const band = centerArea(lines, style, aligned ? weight * 2 : weight, () => ({start: style.cap, end: style.cap}), tolerance);
      if (!aligned) parts.push(band);
      else {
        const fill = fillArea([{windingRule: path.windingRule, commands: closedCommands}], tolerance);
        parts.push(combineAreas(style.align === 'INSIDE' ? 'INTERSECT' : 'SUBTRACT', [band, fill]));
      }
    }
  }
  const present = parts.filter(p => p.length);
  if (!present.length) return [];
  return present.length === 1 ? present[0] : combineAreas('UNION', present);
}

/** Rectangle strokes with a weight per side: the band between the box grown by the outer parts
 *  of the weights and shrunk by the inner parts (by alignment), corners following the radii. */
function individualStrokeArea(node: SceneNode, tolerance: number): MultiPolygon {
  const weights = node.individualStrokeWeights!;
  const sides = [weights.top, weights.right, weights.bottom, weights.left].map(v => Math.max(0, Number.isFinite(v) ? v : 0));
  const outerPart = node.strokeAlign === 'INSIDE' ? 0 : node.strokeAlign === 'CENTER' ? 0.5 : 1;
  const outer = sides.map(v => v * outerPart), inner = sides.map(v => v * (1 - outerPart));
  const radii = cornerRadiiOf(node);
  // Corner k touches sides k (top for TL…) and k − 1: TL = top/left, TR = top/right, BR = bottom/right, BL = bottom/left.
  const touching = [[0, 3], [0, 1], [2, 1], [2, 3]];
  const grow = (offsets: number[], sign: 1 | -1): CornerRadii => radii.map((r, k) => {
    const offset = Math.max(offsets[touching[k][0]], offsets[touching[k][1]]);
    if (sign > 0) return r > 0 ? r + offset : node.strokeJoin === 'ROUND' ? offset : 0;
    return Math.max(0, r - offset);
  }) as CornerRadii;
  const box = (x: number, y: number, w: number, h: number, r: CornerRadii): VectorPath[] =>
    w > 0 && h > 0 ? [{windingRule: 'NONZERO', commands: rectanglePath(w, h, r, node.cornerSmoothing ?? 0).map(c => (c.type === 'Z' ? c : shift(c, x, y)))}] : [];
  const outerBox = box(-outer[3], -outer[0], node.width + outer[1] + outer[3], node.height + outer[0] + outer[2], grow(outer, 1));
  const innerBox = box(inner[3], inner[0], node.width - inner[1] - inner[3], node.height - inner[0] - inner[2], grow(inner, -1));
  return combineAreas('SUBTRACT', [fillArea(outerBox, tolerance), fillArea(innerBox, tolerance)]);
}

function shift(c: PathCommand, x: number, y: number): PathCommand {
  switch (c.type) {
    case 'C': return {type: 'C', x1: c.x1 + x, y1: c.y1 + y, x2: c.x2 + x, y2: c.y2 + y, x: c.x + x, y: c.y + y};
    case 'Q': return {type: 'Q', x1: c.x1 + x, y1: c.y1 + y, x: c.x + x, y: c.y + y};
    case 'Z': return c;
    default: return {type: c.type, x: c.x + x, y: c.y + y};
  }
}

/** Polygons back to paths: straight runs stay lines, runs of gently turning points are fitted
 *  with cubics within `tolerance`, corners stay sharp. */
export function polygonsToSmoothPaths(area: MultiPolygon, tolerance: number): VectorPath[] {
  if (engineTs('geometry')) return polygonsToSmoothPathsTs(area, tolerance);
  return geometryCall('polygonsToSmoothPaths', () => polygonsToSmoothPathsTs(area, tolerance), wasm => wasmPolygonsToSmoothPaths(wasm, area, tolerance), () => ({area, tolerance}));
}

function polygonsToSmoothPathsTs(area: MultiPolygon, tolerance: number): VectorPath[] {
  const commands: PathCommand[] = [];
  const corner = 0.6; // radians: sampling never turns this much between two points
  for (const polygon of area) for (const ring of polygon) {
    const pts: V[] = [];
    for (const [x, y] of ring) if (!pts.length || Math.abs(pts[pts.length - 1].x - x) > 1e-9 || Math.abs(pts[pts.length - 1].y - y) > 1e-9) pts.push({x, y});
    if (pts.length > 1 && Math.abs(pts[0].x - pts[pts.length - 1].x) <= 1e-9 && Math.abs(pts[0].y - pts[pts.length - 1].y) <= 1e-9) pts.pop();
    const n = pts.length;
    if (n < 3) continue;
    // Breaks: sharp turns, and where a long straight edge meets short curve samples (so straight
    // parts stay lines and only the curved parts are fitted).
    const edge = (k: number) => len(sub(pts[(k + 1) % n], pts[k]));
    const corners: number[] = [];
    for (let k = 0; k < n; k++) {
      const before = edge((k + n - 1) % n), after = edge(k);
      const ratio = Math.max(before, after) / Math.max(1e-12, Math.min(before, after));
      if (turnAt(pts[(k + n - 1) % n], pts[k], pts[(k + 1) % n]) > corner || ratio > 6) corners.push(k);
    }
    const starts = corners.length ? corners : [0];
    commands.push({type: 'M', x: pts[starts[0]].x, y: pts[starts[0]].y});
    for (let c = 0; c < starts.length; c++) {
      const from = starts[c], to = c + 1 < starts.length ? starts[c + 1] : starts[0] + n;
      const run: V[] = [];
      for (let k = from; k <= to; k++) run.push(pts[k % n]);
      emitRun(run, tolerance, commands);
    }
    const last = commands[commands.length - 1];
    if (last.type === 'L' && last.x === pts[starts[0]].x && last.y === pts[starts[0]].y) commands.pop();
    commands.push({type: 'Z'});
  }
  return commands.length ? [{windingRule: 'NONZERO', commands}] : [];
}

function emitRun(run: V[], tolerance: number, out: PathCommand[]): void {
  const a = run[0], b = run[run.length - 1];
  const chord = sub(b, a), chordLength = len(chord);
  let straight = true;
  for (let k = 1; k < run.length - 1 && straight; k++) {
    const p = sub(run[k], a);
    const d = chordLength ? Math.abs(p.x * chord.y - p.y * chord.x) / chordLength : len(p);
    if (d > tolerance) straight = false;
  }
  if (straight || run.length < 4) {
    // Few points: keep them as lines (they are corners of joins or caps, not samples of a curve).
    if (straight) appendLine(out, b.x, b.y);
    else for (const p of run.slice(1)) appendLine(out, p.x, p.y);
    return;
  }
  for (const c of fitCubics(run, tolerance)) out.push({type: 'C', x1: c[1].x, y1: c[1].y, x2: c[2].x, y2: c[2].y, x: c[3].x, y: c[3].y});
}

/** The stroke of `node` as filled paths in its local space (empty when it has no stroke weight).
 *  `geometry` defaults to the node's own outline; pass a boolean's result for boolean nodes. */
export function outlineStroke(node: SceneNode, geometry: VectorPath[] = nodeGeometry(node), options: {tolerance?: number} = {}): VectorPath[] {
  const individual = node.individualStrokeWeights && (node.type === 'RECTANGLE' || node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'COMPONENT_SET');
  const heaviest = individual ? Math.max(...Object.values(node.individualStrokeWeights!)) : node.strokeWeight;
  if (!(heaviest > 0)) return [];
  const tolerance = options.tolerance ?? strokeTolerance(heaviest);
  if (hasVariableWidth(node)) {
    // "Width profile": the union of the pieces the canvas fills (shared/design/stroke-profile.ts).
    const rings: MultiPolygon[] = [];
    for (const path of variableWidthOutline(node)) for (const line of flattenPath(path.commands, tolerance)) if (line.points.length >= 3) rings.push([[line.points.map(pair)]]);
    return rings.length ? polygonsToSmoothPaths(combineAreas('UNION', rings), tolerance) : [];
  }
  const markers = node.type === 'LINE' || node.type === 'VECTOR';
  const area = individual
    ? individualStrokeArea(node, tolerance)
    : strokeArea(geometry, strokeStyleOf(node), {tolerance, startMarker: markers ? node.strokeStartMarker : 'NONE', endMarker: markers ? node.strokeEndMarker : 'NONE'});
  return polygonsToSmoothPaths(area, tolerance);
}

// ── The command ────────────────────────────────────────────────────────────────────────────────

/** What ⇧⌘O does to a document: remove `remove`, then create `nodes` in order (each names its
 *  parent; the first is the new top node, created in `parentId` at `index`). */
export type OutlineStrokeOutcome = {nodes: SceneNode[]; rootId: NodeId; parentId: NodeId; index: number; remove: NodeId[]};

const OUTLINABLE = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'VECTOR', 'BOOLEAN_OPERATION']);

/** "Outline stroke" for one node, as Figma does it: the stroke becomes a vector filled with the
 *  stroke's paints; a node that also has a visible fill becomes a group of the fill (the same
 *  shape without its stroke) under the outlined stroke. Null when there is nothing to outline
 *  (no visible stroke, or a node type whose outline is not available, such as text). */
export function outlineStrokeNode(doc: DesignDocument, id: NodeId): OutlineStrokeOutcome | null {
  const node = doc.nodes[id];
  if (!node || !node.parentId || !OUTLINABLE.has(node.type)) return null;
  if (!node.strokes.some(p => p.visible)) return null;
  const geometry = node.type === 'BOOLEAN_OPERATION' ? booleanGeometryExact(doc, id) : nodeGeometry(node);
  const paths = outlineStroke(node, geometry);
  if (!paths.length) return null;
  const parent = doc.nodes[node.parentId];
  const index = Math.max(0, parent?.children?.indexOf(id) ?? 0);
  const matrix = localMatrix(node);
  const hasFill = node.fills.some(p => p.visible);
  const stroke = vectorFromPaths(node, paths, matrix, node.parentId, {name: hasFill ? 'Stroke' : node.name, fills: node.strokes, strokes: []});
  stroke.strokeStartMarker = 'NONE';
  stroke.strokeEndMarker = 'NONE';
  if (!hasFill) return {nodes: [stroke], rootId: stroke.id, parentId: node.parentId, index, remove: [id]};
  // The fill keeps the original shape (a boolean is flattened, its children stay with it no longer).
  const fill = node.type === 'BOOLEAN_OPERATION'
    ? vectorFromPaths(node, geometry, matrix, node.parentId, {name: node.name, strokes: []})
    : {...structuredClone(node), id: newId(), strokes: [], strokeStyleId: undefined};
  if ('strokeStyleId' in fill && fill.strokeStyleId === undefined) delete fill.strokeStyleId;
  const group = createNode('GROUP', {id: newId(), parentId: node.parentId, name: node.name, opacity: node.opacity, blendMode: node.blendMode === 'NORMAL' ? 'PASS_THROUGH' : node.blendMode, effects: structuredClone(node.effects), visible: node.visible, locked: node.locked, constraints: {...node.constraints}});
  for (const child of [fill, stroke]) {
    child.opacity = 1;
    child.blendMode = 'NORMAL';
    child.effects = [];
    child.visible = true;
    child.locked = false;
  }
  // The group's box is the union of its children; they move into its space.
  const box = unionRects([fill, stroke].map(c => transformRect(localMatrix(c), {x: 0, y: 0, width: c.width, height: c.height}))) as Rect;
  Object.assign(group, {x: box.x, y: box.y, width: box.width, height: box.height, children: [fill.id, stroke.id]});
  for (const child of [fill, stroke]) {
    child.parentId = group.id;
    child.x -= box.x;
    child.y -= box.y;
  }
  return {nodes: [group, fill, stroke], rootId: group.id, parentId: node.parentId, index, remove: [id]};
}

export type {Polygon};
