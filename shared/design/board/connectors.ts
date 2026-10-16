import type {Matrix, PathCommand, SceneNode, Vec} from '../types';
import {apply} from '../geometry';
import type {ConnectorLine, ConnectorMagnet} from './types';

// "Board": where a connector runs (docs/board.md §Connectors). Pure geometry in page space: an end on an object sits on the middle
// of one of its sides (or its centre) and leaves it along that side's outward direction; a free end is a point. The route is a
// straight line, an elbow (right angles, rounded corners) or a curve. normalize.ts calls this whenever an end's object moved.

export type Side = 'top' | 'right' | 'bottom' | 'left';
/** One end, resolved in page space: the point, the direction the line leaves in (null for a free end), and the object's centre. */
export type ResolvedEnd = {point: Vec; normal: Vec | null; side: Side | null};

/** An object as an end sees it: its local box and its world matrix (rotation included). */
export type EndObject = {node: Pick<SceneNode, 'width' | 'height'>; world: Matrix};

const SIDE_POINT: Record<Side | 'center', (w: number, h: number) => Vec> = {
  top: (w) => ({x: w / 2, y: 0}),
  right: (w, h) => ({x: w, y: h / 2}),
  bottom: (w, h) => ({x: w / 2, y: h}),
  left: (_w, h) => ({x: 0, y: h / 2}),
  center: (w, h) => ({x: w / 2, y: h / 2}),
};

const unit = (v: Vec): Vec => {
  const length = Math.hypot(v.x, v.y);
  return length > 1e-9 ? {x: v.x / length, y: v.y / length} : {x: 0, y: 0};
};

export function centreOf(object: EndObject): Vec {
  return apply(object.world, {x: object.node.width / 2, y: object.node.height / 2});
}

/** The side of the object that faces `toward` (a page point), weighing the box's proportions, as FigJam's auto magnet does. */
export function facingSide(object: EndObject, toward: Vec): Side {
  const {width: w, height: h} = object.node;
  // `toward` in the object's own box: rotation is taken into account.
  const m = object.world;
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0] || 1;
  const dx = toward.x - m[0][2], dy = toward.y - m[1][2];
  const local = {x: (m[1][1] * dx - m[0][1] * dy) / det, y: (-m[1][0] * dx + m[0][0] * dy) / det};
  const rx = local.x - w / 2, ry = local.y - h / 2;
  if (Math.abs(rx) * Math.max(h, 1) >= Math.abs(ry) * Math.max(w, 1)) return rx >= 0 ? 'right' : 'left';
  return ry >= 0 ? 'bottom' : 'top';
}

/** An end on an object: the middle of `magnet`'s side (the side facing `toward` for 'auto'). */
export function endOnObject(object: EndObject, magnet: ConnectorMagnet, toward: Vec): ResolvedEnd {
  const {width: w, height: h} = object.node;
  const side: Side | 'center' = magnet === 'auto' ? facingSide(object, toward) : magnet;
  const point = apply(object.world, SIDE_POINT[side](w, h));
  if (side === 'center') return {point, normal: null, side: null};
  const centre = centreOf(object);
  return {point, normal: unit({x: point.x - centre.x, y: point.y - centre.y}), side};
}

/** An end anywhere on an object (`at`: a point of its box in fractions of its width and height): it leaves along the outward
 *  normal of the side it is nearest to (the side by the box's proportions, as the magnets have it), none from the very centre. */
export function endAtPoint(object: EndObject, at: Vec): ResolvedEnd {
  const {width: w, height: h} = object.node;
  const point = apply(object.world, {x: at.x * w, y: at.y * h});
  const rx = at.x - 0.5, ry = at.y - 0.5;
  if (Math.abs(rx) < 1e-9 && Math.abs(ry) < 1e-9) return {point, normal: null, side: null};
  const side: Side = Math.abs(rx) >= Math.abs(ry) ? (rx >= 0 ? 'right' : 'left') : ry >= 0 ? 'bottom' : 'top';
  const centre = centreOf(object);
  const middle = apply(object.world, SIDE_POINT[side](w, h));
  return {point, normal: unit({x: middle.x - centre.x, y: middle.y - centre.y}), side};
}

/** The nearest magnet of an object to a page point (for snapping an end while it is dragged), and its distance. */
export function nearestMagnet(object: EndObject, point: Vec): {magnet: Exclude<ConnectorMagnet, 'auto'>; at: Vec; distance: number} {
  let best: {magnet: Exclude<ConnectorMagnet, 'auto'>; at: Vec; distance: number} | null = null;
  for (const magnet of ['top', 'right', 'bottom', 'left'] as const) {
    const at = apply(object.world, SIDE_POINT[magnet](object.node.width, object.node.height));
    const distance = Math.hypot(at.x - point.x, at.y - point.y);
    if (!best || distance < best.distance) best = {magnet, at, distance};
  }
  return best!;
}

/** The axis-aligned direction from `from` toward `to` (a free end leaves toward the other end). */
function axisToward(from: Vec, to: Vec): Vec {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return {x: Math.sign(dx) || 1, y: 0};
  return {x: 0, y: Math.sign(dy) || 1};
}

/** Snaps a direction to the nearest axis (elbows run on the axes even from a turned object). */
function axisOf(v: Vec): Vec {
  return Math.abs(v.x) >= Math.abs(v.y) ? {x: Math.sign(v.x) || 1, y: 0} : {x: 0, y: Math.sign(v.y) || 1};
}

/** Elbow corners are rounded with this radius (page units), less where a segment is short. */
export const ELBOW_RADIUS = 12;
/** An elbow leaves an object straight for at least this long before it turns. */
const STUB = 24;

/** The elbow's corner points from `a` to `b`, leaving along `na` and arriving along `nb` (both axis directions, pointing out of
 *  their objects). */
export function elbowPoints(a: Vec, na: Vec, b: Vec, nb: Vec): Vec[] {
  const startStub = {x: a.x + na.x * STUB, y: a.y + na.y * STUB};
  const endStub = {x: b.x + nb.x * STUB, y: b.y + nb.y * STUB};
  const horizontalA = na.x !== 0, horizontalB = nb.x !== 0;
  const points: Vec[] = [a];
  if (horizontalA && horizontalB) {
    // Both leave sideways: across at the middle (or past both stubs when they face away from each other).
    let mx = (startStub.x + endStub.x) / 2;
    if (na.x > 0 && nb.x > 0) mx = Math.max(startStub.x, endStub.x);
    else if (na.x < 0 && nb.x < 0) mx = Math.min(startStub.x, endStub.x);
    else if ((na.x > 0 && mx < startStub.x) || (na.x < 0 && mx > startStub.x)) {
      // They face away: go round through the middle height.
      const my = (a.y + b.y) / 2;
      points.push(startStub, {x: startStub.x, y: my}, {x: endStub.x, y: my}, endStub);
      points.push(b);
      return simplify(points);
    }
    points.push({x: mx, y: a.y}, {x: mx, y: b.y});
  } else if (!horizontalA && !horizontalB) {
    let my = (startStub.y + endStub.y) / 2;
    if (na.y > 0 && nb.y > 0) my = Math.max(startStub.y, endStub.y);
    else if (na.y < 0 && nb.y < 0) my = Math.min(startStub.y, endStub.y);
    else if ((na.y > 0 && my < startStub.y) || (na.y < 0 && my > startStub.y)) {
      const mx = (a.x + b.x) / 2;
      points.push(startStub, {x: mx, y: startStub.y}, {x: mx, y: endStub.y}, endStub);
      points.push(b);
      return simplify(points);
    }
    points.push({x: a.x, y: my}, {x: b.x, y: my});
  } else if (horizontalA) {
    // Sideways, then down or up into the other: one corner where it can, else two.
    const corner = {x: b.x, y: a.y};
    const ahead = (corner.x - a.x) * na.x >= STUB / 2 && (a.y - b.y) * nb.y >= STUB / 2;
    if (ahead) points.push(corner);
    else points.push(startStub, {x: startStub.x, y: endStub.y}, endStub);
  } else {
    const corner = {x: a.x, y: b.y};
    const ahead = (corner.y - a.y) * na.y >= STUB / 2 && (a.x - b.x) * nb.x >= STUB / 2;
    if (ahead) points.push(corner);
    else points.push(startStub, {x: endStub.x, y: startStub.y}, endStub);
  }
  points.push(b);
  return simplify(points);
}

/** Drops repeated and collinear points. */
function simplify(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-6 && Math.abs(last.y - point.y) < 1e-6) continue;
    out.push(point);
    while (out.length >= 3) {
      const [p, q, r] = out.slice(-3);
      const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
      if (Math.abs(cross) > 1e-6) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/** A polyline with its inner corners rounded (quadratic curves of radius up to `radius`). */
export function roundedPolyline(points: readonly Vec[], radius = ELBOW_RADIUS): PathCommand[] {
  if (points.length < 2) return points.length ? [{type: 'M', x: points[0].x, y: points[0].y}] : [];
  const commands: PathCommand[] = [{type: 'M', x: points[0].x, y: points[0].y}];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1], q = points[i], r = points[i + 1];
    const inLength = Math.hypot(q.x - p.x, q.y - p.y), outLength = Math.hypot(r.x - q.x, r.y - q.y);
    const k = Math.min(radius, inLength / 2, outLength / 2);
    if (k < 0.5) {
      commands.push({type: 'L', x: q.x, y: q.y});
      continue;
    }
    const before = {x: q.x - ((q.x - p.x) / inLength) * k, y: q.y - ((q.y - p.y) / inLength) * k};
    const after = {x: q.x + ((r.x - q.x) / outLength) * k, y: q.y + ((r.y - q.y) / outLength) * k};
    commands.push({type: 'L', x: before.x, y: before.y}, {type: 'Q', x1: q.x, y1: q.y, x: after.x, y: after.y});
  }
  const last = points[points.length - 1];
  commands.push({type: 'L', x: last.x, y: last.y});
  return commands;
}

/** The connector's path in page space. `points`: waypoints (page space) it passes through in order, a reshaped connector's: a
 *  straight connector runs from point to point, an elbow turns at each (corners rounded), a curve goes smoothly through them. */
export function routeConnector(start: ResolvedEnd, end: ResolvedEnd, line: ConnectorLine, points: readonly Vec[] = []): PathCommand[] {
  const a = start.point, b = end.point;
  if (points.length) return throughPoints(start, end, line, points);
  if (line === 'straight') return [{type: 'M', x: a.x, y: a.y}, {type: 'L', x: b.x, y: b.y}];
  if (line === 'curved') {
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const reach = Math.max(32, Math.min(240, distance * 0.45));
    const na = start.normal ?? unit({x: b.x - a.x, y: b.y - a.y});
    const nb = end.normal ?? unit({x: a.x - b.x, y: a.y - b.y});
    return [{type: 'M', x: a.x, y: a.y}, {type: 'C', x1: a.x + na.x * reach, y1: a.y + na.y * reach, x2: b.x + nb.x * reach, y2: b.y + nb.y * reach, x: b.x, y: b.y}];
  }
  const na = start.normal ? axisOf(start.normal) : axisToward(a, b);
  const nb = end.normal ? axisOf(end.normal) : axisToward(b, a);
  return roundedPolyline(elbowPoints(a, na, b, nb));
}

/** A route through waypoints. A curve is a Catmull-Rom spline through the ends and the waypoints (as cubics); at an end on an
 *  object it leaves along the side's normal. */
function throughPoints(start: ResolvedEnd, end: ResolvedEnd, line: ConnectorLine, points: readonly Vec[]): PathCommand[] {
  const all = [start.point, ...points, end.point];
  if (line === 'straight') return all.map((p, i) => ({type: i ? 'L' : 'M', x: p.x, y: p.y}) as PathCommand);
  if (line === 'elbow') return roundedPolyline(simplify(all));
  const n = all.length;
  // Phantom points beyond the ends: along an end's normal when it has one, else the first segment mirrored.
  const beyond = (p: Vec, next: Vec, normal: Vec | null): Vec => {
    if (!normal) return {x: 2 * p.x - next.x, y: 2 * p.y - next.y};
    const length = Math.hypot(next.x - p.x, next.y - p.y);
    // The tangent at p is (next - phantom) / 2: make it point along the normal, as long as the segment.
    return {x: next.x - 2 * normal.x * length, y: next.y - 2 * normal.y * length};
  };
  const at = (i: number): Vec => (i < 0 ? beyond(all[0], all[1], start.normal) : i >= n ? beyond(all[n - 1], all[n - 2], end.normal) : all[i]);
  const commands: PathCommand[] = [{type: 'M', x: all[0].x, y: all[0].y}];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = all[i], p2 = all[i + 1], p3 = at(i + 2);
    commands.push({
      type: 'C',
      x1: p1.x + (p2.x - p0.x) / 6, y1: p1.y + (p2.y - p0.y) / 6,
      x2: p2.x - (p3.x - p1.x) / 6, y2: p2.y - (p3.y - p1.y) / 6,
      x: p2.x, y: p2.y,
    });
  }
  return commands;
}

/** Points along a path (curves sampled), for its length, its middle and hit tests. */
export function samplePath(commands: readonly PathCommand[], steps = 12): Vec[] {
  const points: Vec[] = [];
  let at: Vec = {x: 0, y: 0};
  for (const command of commands) {
    if (command.type === 'M' || command.type === 'L') {
      at = {x: command.x, y: command.y};
      points.push(at);
    } else if (command.type === 'Q') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        points.push({x: u * u * at.x + 2 * u * t * command.x1 + t * t * command.x, y: u * u * at.y + 2 * u * t * command.y1 + t * t * command.y});
      }
      at = {x: command.x, y: command.y};
    } else if (command.type === 'C') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        points.push({
          x: u * u * u * at.x + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t * t * t * command.x,
          y: u * u * u * at.y + 3 * u * u * t * command.y1 + 3 * u * t * t * command.y2 + t * t * t * command.y,
        });
      }
      at = {x: command.x, y: command.y};
    }
  }
  return points;
}

/** The point halfway along the path (where a label sits by default). */
export function pathMidpoint(commands: readonly PathCommand[]): Vec {
  return pathPointAt(commands, 0.5);
}

/** The point at `fraction` (0…1) of the path's length (a connector's label at `labelAt`). */
export function pathPointAt(commands: readonly PathCommand[], fraction: number): Vec {
  const points = samplePath(commands);
  if (points.length < 2) return points[0] ?? {x: 0, y: 0};
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  const target = total * Math.min(1, Math.max(0, fraction));
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const step = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (walked + step >= target && step > 0) {
      const t = (target - walked) / step;
      return {x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t};
    }
    walked += step;
  }
  return points[points.length - 1];
}

/** Moves every point of a path by `dx, dy` (page → a box's own space). */
export function translatePath(commands: readonly PathCommand[], dx: number, dy: number): PathCommand[] {
  return commands.map(command => {
    switch (command.type) {
      case 'M':
      case 'L':
        return {type: command.type, x: command.x + dx, y: command.y + dy};
      case 'Q':
        return {type: 'Q', x1: command.x1 + dx, y1: command.y1 + dy, x: command.x + dx, y: command.y + dy};
      case 'C':
        return {type: 'C', x1: command.x1 + dx, y1: command.y1 + dy, x2: command.x2 + dx, y2: command.y2 + dy, x: command.x + dx, y: command.y + dy};
      case 'Z':
        return command;
    }
  });
}

/** Applies a matrix to every point of a path (page space → a parent's space). */
export function transformCommands(commands: readonly PathCommand[], m: Matrix): PathCommand[] {
  const p = (x: number, y: number) => apply(m, {x, y});
  return commands.map(command => {
    switch (command.type) {
      case 'M':
      case 'L': {
        const q = p(command.x, command.y);
        return {type: command.type, x: q.x, y: q.y};
      }
      case 'Q': {
        const c = p(command.x1, command.y1), q = p(command.x, command.y);
        return {type: 'Q', x1: c.x, y1: c.y, x: q.x, y: q.y};
      }
      case 'C': {
        const c1 = p(command.x1, command.y1), c2 = p(command.x2, command.y2), q = p(command.x, command.y);
        return {type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: q.x, y: q.y};
      }
      case 'Z':
        return command;
    }
  });
}

/** The bounding box of a path's points and control points (enough for a line's box: the curve stays inside its hull). */
export function commandBounds(commands: readonly PathCommand[]): {x: number; y: number; width: number; height: number} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const point of samplePath(commands)) add(point.x, point.y);
  if (minX === Infinity) return {x: 0, y: 0, width: 0, height: 0};
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}
