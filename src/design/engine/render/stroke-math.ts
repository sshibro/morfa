import type {IndividualStrokeWeights, PathCommand, StrokeAlign, StrokeMarker, Vec} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import {markerSize} from '../../../../shared/design/bounds';

// Stroke strategies, arrowheads and per-side stroke bands. Pure, tested in node
// (tests/design-render-stroke.test.ts).

export type StrokePlan = {
  /** INSIDE clips to the shape, OUTSIDE clips the shape out; both stroke twice the weight so the
   *  kept half is exactly the weight. Open paths have no inside, so they always stroke centred. */
  clip: 'inside' | 'outside' | null;
  lineWidth: number;
};

export function strokePlan(align: StrokeAlign, weight: number, open: boolean): StrokePlan {
  if (open || align === 'CENTER') return {clip: null, lineWidth: weight};
  return {clip: align === 'INSIDE' ? 'inside' : 'outside', lineWidth: weight * 2};
}

export const CANVAS_CAPS = {NONE: 'butt', ROUND: 'round', SQUARE: 'square'} as const;
export const CANVAS_JOINS = {MITER: 'miter', BEVEL: 'bevel', ROUND: 'round'} as const;

// ── Path ends ─────────────────────────────────────────────────────────────────────────────────

export type PathEnd = {point: Vec; /** Unit vector pointing out of the path at this end. */ direction: Vec};

const sub = (p: Vec, q: Vec): Vec => ({x: p.x - q.x, y: p.y - q.y});
const unitOf = (v: Vec): Vec | null => {
  const length = Math.hypot(v.x, v.y);
  return length > 1e-9 ? {x: v.x / length, y: v.y / length} : null;
};

type Subpath = {commands: PathCommand[]; closed: boolean};

function subpaths(commands: readonly PathCommand[]): Subpath[] {
  const out: Subpath[] = [];
  let current: Subpath | null = null;
  for (const command of commands) {
    if (command.type === 'M') {
      current = {commands: [command], closed: false};
      out.push(current);
    } else if (current) {
      current.commands.push(command);
      if (command.type === 'Z') current.closed = true;
    }
  }
  return out;
}

/** Points that leave or enter each segment's end, in order, for tangent estimates. */
function controlPoints(commands: readonly PathCommand[]): Vec[] {
  const points: Vec[] = [];
  for (const command of commands) {
    if (command.type === 'M' || command.type === 'L') points.push({x: command.x, y: command.y});
    else if (command.type === 'C') points.push({x: command.x1, y: command.y1}, {x: command.x2, y: command.y2}, {x: command.x, y: command.y});
    else if (command.type === 'Q') points.push({x: command.x1, y: command.y1}, {x: command.x, y: command.y});
  }
  return points;
}

/** The free ends of the first and last open subpaths, where start and end markers go. */
export function pathEnds(commands: readonly PathCommand[]): {start: PathEnd; end: PathEnd} | null {
  const open = subpaths(commands).filter(path => !path.closed && path.commands.length > 1);
  if (!open.length) return null;
  const first = controlPoints(open[0].commands), last = controlPoints(open[open.length - 1].commands);
  if (first.length < 2 || last.length < 2) return null;
  const startPoint = first[0], endPoint = last[last.length - 1];
  let startDir: Vec | null = null, endDir: Vec | null = null;
  for (let i = 1; i < first.length && !startDir; i++) startDir = unitOf(sub(startPoint, first[i]));
  for (let i = last.length - 2; i >= 0 && !endDir; i--) endDir = unitOf(sub(endPoint, last[i]));
  return {start: {point: startPoint, direction: startDir ?? {x: -1, y: 0}}, end: {point: endPoint, direction: endDir ?? {x: 1, y: 0}}};
}

// ── Markers ───────────────────────────────────────────────────────────────────────────────────

export type MarkerShape = {
  /** Filled outline in local px. */
  fill: PathCommand[] | null;
  /** Polyline stroked with the path's weight (the open arrow). */
  stroke: PathCommand[] | null;
  /** How far the path's own stroke must stop short of the end so its butt hides under the marker. */
  inset: number;
};

const at = (end: PathEnd, along: number, across: number): Vec => ({
  x: end.point.x + end.direction.x * along - end.direction.y * across,
  y: end.point.y + end.direction.y * along + end.direction.x * across,
});
const polygon = (points: Vec[]): PathCommand[] => [...points.map((p, i): PathCommand => ({type: i ? 'L' : 'M', x: p.x, y: p.y})), {type: 'Z'}];
const K = 0.5522847498307936;
function circle(c: Vec, r: number): PathCommand[] {
  return [
    {type: 'M', x: c.x + r, y: c.y},
    {type: 'C', x1: c.x + r, y1: c.y + r * K, x2: c.x + r * K, y2: c.y + r, x: c.x, y: c.y + r},
    {type: 'C', x1: c.x - r * K, y1: c.y + r, x2: c.x - r, y2: c.y + r * K, x: c.x - r, y: c.y},
    {type: 'C', x1: c.x - r, y1: c.y - r * K, x2: c.x - r * K, y2: c.y - r, x: c.x, y: c.y - r},
    {type: 'C', x1: c.x + r * K, y1: c.y - r, x2: c.x + r, y2: c.y - r * K, x: c.x + r, y: c.y},
    {type: 'Z'},
  ];
}

/** The shape drawn at one end of an open path, scaled by the stroke weight. Triangles put their tip
 *  on the end point; circles and diamonds centre on it; ROUND and SQUARE add a cap to that end only. */
export function markerShape(marker: StrokeMarker, end: PathEnd, weight: number): MarkerShape | null {
  const size = markerSize(weight);
  switch (marker) {
    case 'TRIANGLE_ARROW': {
      const half = size / Math.sqrt(3);
      return {fill: polygon([at(end, 0, 0), at(end, -size, half), at(end, -size, -half)]), stroke: null, inset: Math.min(size * 0.6, weight * 1.5)};
    }
    case 'REVERSED_TRIANGLE': {
      const half = size / Math.sqrt(3);
      return {fill: polygon([at(end, -size, 0), at(end, 0, half), at(end, 0, -half)]), stroke: null, inset: 0};
    }
    case 'LINE_ARROW': {
      const arm = size * 0.75;
      const a = at(end, -arm, arm), b = at(end, 0, 0), c = at(end, -arm, -arm);
      return {fill: null, stroke: [{type: 'M', x: a.x, y: a.y}, {type: 'L', x: b.x, y: b.y}, {type: 'L', x: c.x, y: c.y}], inset: 0};
    }
    case 'CIRCLE':
      return {fill: circle(end.point, size * 0.4), stroke: null, inset: 0};
    case 'DIAMOND': {
      const r = size * 0.55;
      return {fill: polygon([at(end, r, 0), at(end, 0, r), at(end, -r, 0), at(end, 0, -r)]), stroke: null, inset: 0};
    }
    case 'ROUND':
      return {fill: circle(end.point, weight / 2), stroke: null, inset: 0};
    case 'SQUARE': {
      const h = weight / 2;
      return {fill: polygon([at(end, h, h), at(end, h, -h), at(end, -h, -h), at(end, -h, h)]), stroke: null, inset: 0};
    }
    default:
      return null;
  }
}

/** Moves the free ends of the first/last open subpaths inwards by `startInset`/`endInset`, keeping
 *  their tangents, so a thick line ends under its arrowhead instead of poking out of the tip. */
export function shortenPath(commands: readonly PathCommand[], startInset: number, endInset: number): PathCommand[] {
  if (!(startInset > 0) && !(endInset > 0)) return commands as PathCommand[];
  const out = commands.map(command => ({...command})) as PathCommand[];
  const starts: number[] = [], ends: number[] = [];
  let open = -1;
  out.forEach((command, i) => {
    if (command.type === 'M') {
      if (open >= 0) ends.push(i - 1);
      open = i;
      starts.push(i);
    } else if (command.type === 'Z') {
      starts.pop();
      open = -1;
    }
  });
  if (open >= 0) ends.push(out.length - 1);
  else if (starts.length > ends.length) starts.pop();
  if (!starts.length || !ends.length) return out;
  const move = (index: number, inset: number, towardsIndex: number) => {
    const command = out[index], next = out[towardsIndex];
    if (!command || !next || command.type === 'Z' || next.type === 'Z' || !(inset > 0)) return;
    const point = {x: command.x, y: command.y};
    const toward = next.type === 'C' && towardsIndex > index ? {x: next.x1, y: next.y1}
      : command.type === 'C' && towardsIndex < index ? {x: command.x2, y: command.y2}
      : {x: next.x, y: next.y};
    const length = Math.hypot(toward.x - point.x, toward.y - point.y);
    if (length < 1e-9) return;
    const shift = Math.min(inset, length * 0.9) / length;
    const dx = (toward.x - point.x) * shift, dy = (toward.y - point.y) * shift;
    command.x += dx; command.y += dy;
    if (command.type === 'C' && towardsIndex < index) { command.x2 += dx; command.y2 += dy; }
    if (next.type === 'C' && towardsIndex > index) { next.x1 += dx; next.y1 += dy; }
  };
  move(starts[0], startInset, starts[0] + 1);
  const last = ends[ends.length - 1];
  move(last, endInset, last - 1);
  return out;
}

// ── Per-side stroke weights ───────────────────────────────────────────────────────────────────

export type RoundedRect = {rect: Rect; radii: [number, number, number, number]};

/** The stroke of a rectangle with different weights per side, as the region between two rounded
 *  rectangles (filled even-odd). Radii are [top-left, top-right, bottom-right, bottom-left]; the outer
 *  corner grows by its larger neighbouring side, the inner one shrinks by it. */
export function individualStrokeBand(width: number, height: number, weights: IndividualStrokeWeights, align: StrokeAlign, radii: readonly [number, number, number, number]): {outer: RoundedRect; inner: RoundedRect | null} {
  const out = align === 'OUTSIDE' ? 1 : align === 'CENTER' ? 0.5 : 0;
  const inn = 1 - out;
  const o = {l: weights.left * out, t: weights.top * out, r: weights.right * out, b: weights.bottom * out};
  const i = {l: weights.left * inn, t: weights.top * inn, r: weights.right * inn, b: weights.bottom * inn};
  const grow = [Math.max(o.t, o.l), Math.max(o.t, o.r), Math.max(o.b, o.r), Math.max(o.b, o.l)];
  const shrink = [Math.max(i.t, i.l), Math.max(i.t, i.r), Math.max(i.b, i.r), Math.max(i.b, i.l)];
  const outer: RoundedRect = {
    rect: {x: -o.l, y: -o.t, width: width + o.l + o.r, height: height + o.t + o.b},
    radii: radii.map((r, k) => (r > 0 ? r + grow[k] : 0)) as [number, number, number, number],
  };
  const innerWidth = width - i.l - i.r, innerHeight = height - i.t - i.b;
  const inner: RoundedRect | null = innerWidth > 0 && innerHeight > 0
    ? {rect: {x: i.l, y: i.t, width: innerWidth, height: innerHeight}, radii: radii.map((r, k) => Math.max(0, r - shrink[k])) as [number, number, number, number]}
    : null;
  return {outer, inner};
}

/** Rounded rectangle outline with per-corner radii, clamped so neighbouring corners never overlap. */
export function roundedRectCommands({x, y, width: w, height: h}: Rect, radii: readonly [number, number, number, number]): PathCommand[] {
  const scale = Math.min(1, ...[[0, 1, w], [1, 2, h], [2, 3, w], [3, 0, h]].map(([p, q, side]) => {
    const sum = radii[p] + radii[q];
    return sum > side && sum > 0 ? side / sum : 1;
  }));
  const [tl, tr, br, bl] = radii.map(r => Math.max(0, r * scale));
  const c = (r: number) => r * (1 - K);
  const out: PathCommand[] = [{type: 'M', x: x + tl, y}, {type: 'L', x: x + w - tr, y}];
  if (tr) out.push({type: 'C', x1: x + w - c(tr), y1: y, x2: x + w, y2: y + c(tr), x: x + w, y: y + tr});
  out.push({type: 'L', x: x + w, y: y + h - br});
  if (br) out.push({type: 'C', x1: x + w, y1: y + h - c(br), x2: x + w - c(br), y2: y + h, x: x + w - br, y: y + h});
  out.push({type: 'L', x: x + bl, y: y + h});
  if (bl) out.push({type: 'C', x1: x + c(bl), y1: y + h, x2: x, y2: y + h - c(bl), x, y: y + h - bl});
  out.push({type: 'L', x, y: y + tl});
  if (tl) out.push({type: 'C', x1: x, y1: y + c(tl), x2: x + c(tl), y2: y, x: x + tl, y});
  out.push({type: 'Z'});
  return out;
}
