import type {Vec} from '../../../shared/design/types';
import type {Rect} from '../../../shared/design/geometry';

// The shape of a prototype connection on the canvas (screen px), pure so it is tested in node: a
// cubic curve leaving the source's side that faces the destination and arriving at the facing side
// of the destination, level with the source where it can.

export type Noodle = {start: Vec; c1: Vec; c2: Vec; end: Vec};

const INSET = 16;
const clamp = (value: number, low: number, high: number) => (low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value)));

export function noodleBetween(source: Rect, destination: Rect): Noodle {
  const sx = source.x + source.width / 2, sy = source.y + source.height / 2;
  const right = source.x + source.width, bottom = source.y + source.height;
  const dRight = destination.x + destination.width, dBottom = destination.y + destination.height;
  const levelY = clamp(sy, destination.y + Math.min(INSET, destination.height / 2), dBottom - Math.min(INSET, destination.height / 2));
  const levelX = clamp(sx, destination.x + Math.min(INSET, destination.width / 2), dRight - Math.min(INSET, destination.width / 2));
  const bend = (distance: number) => Math.max(40, Math.abs(distance) * 0.5);
  if (destination.x >= right) {
    const start = {x: right, y: sy}, end = {x: destination.x, y: levelY}, k = bend(end.x - start.x);
    return {start, c1: {x: start.x + k, y: start.y}, c2: {x: end.x - k, y: end.y}, end};
  }
  if (dRight <= source.x) {
    const start = {x: source.x, y: sy}, end = {x: dRight, y: levelY}, k = bend(end.x - start.x);
    return {start, c1: {x: start.x - k, y: start.y}, c2: {x: end.x + k, y: end.y}, end};
  }
  if (destination.y >= bottom) {
    const start = {x: sx, y: bottom}, end = {x: levelX, y: destination.y}, k = bend(end.y - start.y);
    return {start, c1: {x: start.x, y: start.y + k}, c2: {x: end.x, y: end.y - k}, end};
  }
  if (dBottom <= source.y) {
    const start = {x: sx, y: source.y}, end = {x: levelX, y: dBottom}, k = bend(end.y - start.y);
    return {start, c1: {x: start.x, y: start.y - k}, c2: {x: end.x, y: end.y + k}, end};
  }
  // Overlapping (a layer of the same frame, or the frame itself): a loop out of the right side
  // into the destination's right edge near its top.
  const start = {x: right, y: sy};
  const end = {x: dRight, y: clamp(destination.y + INSET, destination.y, dBottom)};
  const reach = Math.max(right, dRight) + 48;
  return {start, c1: {x: reach, y: start.y}, c2: {x: reach, y: end.y}, end};
}

export function pointOnNoodle(n: Noodle, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {x: a * n.start.x + b * n.c1.x + c * n.c2.x + d * n.end.x, y: a * n.start.y + b * n.c1.y + c * n.c2.y + d * n.end.y};
}

/** The curve as a polyline (hit testing). */
export function flattenNoodle(n: Noodle, segments = 24): Vec[] {
  const points: Vec[] = [];
  for (let i = 0; i <= segments; i++) points.push(pointOnNoodle(n, i / segments));
  return points;
}

/** Unit direction the curve arrives in (the arrowhead points along it). */
export function arrivalDirection(n: Noodle): Vec {
  let dx = n.end.x - n.c2.x, dy = n.end.y - n.c2.y;
  if (!dx && !dy) {
    dx = n.end.x - n.start.x;
    dy = n.end.y - n.start.y;
  }
  const length = Math.hypot(dx, dy) || 1;
  return {x: dx / length, y: dy / length};
}

export function distanceToPolyline(points: readonly Vec[], p: Vec): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** Bounds of the curve's control polygon (contains the curve): culling. */
export function noodleBounds(n: Noodle): Rect {
  const xs = [n.start.x, n.c1.x, n.c2.x, n.end.x], ys = [n.start.y, n.c1.y, n.c2.y, n.end.y];
  const x = Math.min(...xs), y = Math.min(...ys);
  return {x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y};
}
