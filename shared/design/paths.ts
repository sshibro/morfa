import type {Matrix, PathCommand, Vec, VectorPath, WindingRule} from './types';
import type {Rect} from './geometry';

// Path maths of "Morfa" vectors: reading and writing SVG path data, transforms, exact
// bounds, flattening, hit testing, lengths, curve fitting and the anchor model the pen and
// vector-edit tools work on.
//
// Paths are absolute M/L/C/Q/Z commands (types.ts `PathCommand`). Every subpath starts with M:
// the parser writes an explicit M after a Z that is followed by drawing, so no helper has to
// guess where a segment begins. Quadratic segments stay quadratic in documents; algorithms
// that need one curve kind raise them to cubics, which is exact.

/** Four control points of a cubic Bézier. */
export type Cubic = [Vec, Vec, Vec, Vec];

/** A flattened subpath. Closed polylines do not repeat their first point at the end. */
export type Polyline = {points: Vec[]; closed: boolean};

/** One drawn piece of a path. `index` is the command that draws it (a Z for a closing line,
 *  −1 for the implicit closing line a fill adds to an open subpath). Quadratics come raised to cubics. */
export type PathSegment =
  | {index: number; subpath: number; kind: 'line'; p0: Vec; p1: Vec}
  | {index: number; subpath: number; kind: 'cubic'; p0: Vec; c1: Vec; c2: Vec; p1: Vec};

export const PATH_LIMITS = {
  /** Commands one `d` attribute may produce; the rest is dropped, as after a syntax error. */
  maxCommands: 200_000,
  /** Points one flattening may produce; past it, curves are replaced by their chords. */
  maxPoints: 2_000_000,
  /** Steps one curve may be cut into when flattening. */
  maxCurveSteps: 1024,
} as const;

const EPSILON = 1e-9;

// ── Small vector helpers ───────────────────────────────────────────────────────────────────────

const sub = (a: Vec, b: Vec): Vec => ({x: a.x - b.x, y: a.y - b.y});
const add = (a: Vec, b: Vec): Vec => ({x: a.x + b.x, y: a.y + b.y});
const scale = (a: Vec, s: number): Vec => ({x: a.x * s, y: a.y * s});
const lerp = (a: Vec, b: Vec, t: number): Vec => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
const length = (a: Vec) => Math.hypot(a.x, a.y);
const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const samePoint = (a: Vec, b: Vec, eps = EPSILON) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
function normalize(a: Vec): Vec {
  const l = length(a);
  return l > 0 ? {x: a.x / l, y: a.y / l} : {x: 0, y: 0};
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────

const ARG_COUNT: Record<string, number> = {M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0};

/** Reads SVG path data (the full grammar: M L H V C S Q T A Z, absolute and relative, implicit
 *  repeats, numbers like "1e-3.5.5" or "-.5-.5", arc flags written without separators) into
 *  absolute commands. Arcs become cubics; H/V become lines; S/T get their reflected control point.
 *  As SVG renderers do, a syntax error ends the path and everything before it is kept. */
export function parsePathData(d: string, options: {maxCommands?: number} = {}): PathCommand[] {
  const max = options.maxCommands ?? PATH_LIMITS.maxCommands;
  const out: PathCommand[] = [];
  const n = d.length;
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let started = false, closed = false;
  // Control points S and T reflect: the last cubic's second one, the last quadratic's.
  let lastCubic: Vec | null = null, lastQuad: Vec | null = null;

  const skip = () => {
    while (i < n) {
      const c = d.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) i++;
      else break;
    }
  };
  const startsNumber = () => {
    const c = d.charCodeAt(i);
    return (c >= 48 && c <= 57) || c === 46 || c === 43 || c === 45;
  };
  const readNumber = (): number => {
    skip();
    const start = i;
    let c = d.charCodeAt(i);
    if (c === 43 || c === 45) c = d.charCodeAt(++i);
    let digits = 0;
    while (c >= 48 && c <= 57) { c = d.charCodeAt(++i); digits++; }
    if (c === 46) {
      c = d.charCodeAt(++i);
      while (c >= 48 && c <= 57) { c = d.charCodeAt(++i); digits++; }
    }
    if (!digits) { i = start; return NaN; }
    if (c === 101 || c === 69) {
      // An exponent only counts when digits follow; "1e" leaves the "e" for the next token.
      const mark = i;
      c = d.charCodeAt(++i);
      if (c === 43 || c === 45) c = d.charCodeAt(++i);
      if (c >= 48 && c <= 57) while (c >= 48 && c <= 57) c = d.charCodeAt(++i);
      else i = mark;
    }
    const value = Number(d.slice(start, i));
    return Number.isFinite(value) ? value : NaN;
  };
  const readFlag = (): number => {
    skip();
    const c = d.charCodeAt(i);
    if (c === 48 || c === 49) { i++; return c - 48; }
    return NaN;
  };
  const beginDrawing = () => {
    // After a Z the next drawing command starts a new subpath at the old start point.
    if (closed) {
      out.push({type: 'M', x: sx, y: sy});
      closed = false;
    }
  };

  parse: while (out.length < max) {
    skip();
    if (i >= n) break;
    const letter = d[i];
    const upper = letter.toUpperCase();
    if (!(upper in ARG_COUNT)) break;
    i++;
    const relative = letter !== upper;
    if (!started && upper !== 'M') break;
    if (upper === 'Z') {
      // "M x y Z" is kept: a dot under round caps, and its point counts for bounds.
      if (out.length && out[out.length - 1].type !== 'Z') out.push({type: 'Z'});
      cx = sx; cy = sy;
      closed = true;
      lastCubic = lastQuad = null;
      continue;
    }
    let command = upper;
    let first = true;
    while (out.length < max) {
      if (!first) {
        skip();
        if (i >= n || !startsNumber()) break;
      }
      const ox = relative ? cx : 0, oy = relative ? cy : 0;
      switch (command) {
        case 'M': {
          const x = readNumber(), y = readNumber();
          if (Number.isNaN(x) || Number.isNaN(y)) break parse;
          const last = out[out.length - 1];
          if (last && last.type === 'M') out.pop(); // consecutive movetos: only the last one counts
          out.push({type: 'M', x: x + ox, y: y + oy});
          cx = sx = x + ox; cy = sy = y + oy;
          started = true; closed = false;
          lastCubic = lastQuad = null;
          command = 'L'; // further pairs are linetos
          break;
        }
        case 'L': case 'H': case 'V': {
          let x = cx, y = cy;
          if (command === 'L') {
            x = readNumber() + ox; y = readNumber() + oy;
          } else if (command === 'H') x = readNumber() + ox;
          else y = readNumber() + oy;
          if (Number.isNaN(x) || Number.isNaN(y)) break parse;
          beginDrawing();
          out.push({type: 'L', x, y});
          cx = x; cy = y;
          lastCubic = lastQuad = null;
          break;
        }
        case 'C': case 'S': {
          let x1: number, y1: number;
          if (command === 'C') {
            x1 = readNumber() + ox; y1 = readNumber() + oy;
          } else {
            x1 = lastCubic ? 2 * cx - lastCubic.x : cx;
            y1 = lastCubic ? 2 * cy - lastCubic.y : cy;
          }
          const x2 = readNumber() + ox, y2 = readNumber() + oy, x = readNumber() + ox, y = readNumber() + oy;
          if ([x1, y1, x2, y2, x, y].some(Number.isNaN)) break parse;
          beginDrawing();
          out.push({type: 'C', x1, y1, x2, y2, x, y});
          cx = x; cy = y;
          lastCubic = {x: x2, y: y2};
          lastQuad = null;
          break;
        }
        case 'Q': case 'T': {
          let x1: number, y1: number;
          if (command === 'Q') {
            x1 = readNumber() + ox; y1 = readNumber() + oy;
          } else {
            x1 = lastQuad ? 2 * cx - lastQuad.x : cx;
            y1 = lastQuad ? 2 * cy - lastQuad.y : cy;
          }
          const x = readNumber() + ox, y = readNumber() + oy;
          if ([x1, y1, x, y].some(Number.isNaN)) break parse;
          beginDrawing();
          out.push({type: 'Q', x1, y1, x, y});
          cx = x; cy = y;
          lastQuad = {x: x1, y: y1};
          lastCubic = null;
          break;
        }
        case 'A': {
          const rx = readNumber(), ry = readNumber(), rotation = readNumber(), large = readFlag(), sweep = readFlag();
          const x = readNumber() + ox, y = readNumber() + oy;
          if ([rx, ry, rotation, large, sweep, x, y].some(Number.isNaN)) break parse;
          beginDrawing();
          for (const c of svgArcToCubics({x: cx, y: cy}, rx, ry, rotation, large === 1, sweep === 1, {x, y})) {
            out.push(c.length === 2 ? {type: 'L', x: c[1].x, y: c[1].y} : {type: 'C', x1: c[1].x, y1: c[1].y, x2: c[2].x, y2: c[2].y, x: c[3].x, y: c[3].y});
          }
          cx = x; cy = y;
          lastCubic = lastQuad = null;
          break;
        }
      }
      first = false;
    }
  }
  // A trailing moveto draws nothing.
  if (out.length && out[out.length - 1].type === 'M') out.pop();
  return out;
}

/** An SVG endpoint arc (the A command) as cubics, each piece at most a quarter turn (SVG 1.1
 *  implementation notes F.6.5–F.6.6, radii scaled up when too small). A zero radius gives the
 *  straight line, returned as a two-point piece; equal endpoints give nothing. */
export function svgArcToCubics(from: Vec, rx: number, ry: number, rotationDegrees: number, largeArc: boolean, sweep: boolean, to: Vec): (Cubic | [Vec, Vec])[] {
  if (samePoint(from, to, 0)) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [[from, to]];
  const phi = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx2 = (from.x - to.x) / 2, dy2 = (from.y - to.y) / 2;
  const x1p = cos * dx2 + sin * dy2, y1p = -sin * dx2 + cos * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
  }
  const rx2 = rx * rx, ry2 = ry * ry;
  const numerator = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const center = {x: cos * cxp - sin * cyp + (from.x + to.x) / 2, y: sin * cxp + cos * cyp + (from.y + to.y) / 2};
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry, vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const pieces = ellipseArcCubics(center, rx, ry, phi, theta1, delta);
  // Pin the ends exactly, so the next command starts where this one stopped.
  if (pieces.length) {
    pieces[0][0] = {...from};
    pieces[pieces.length - 1][3] = {...to};
  }
  return pieces;
}

/** An elliptical arc around `center` as cubics of at most a quarter turn each. Angles are radians
 *  clockwise on screen (y down) from the ellipse's x axis, which is turned by `rotation`. */
export function ellipseArcCubics(center: Vec, rx: number, ry: number, rotation: number, start: number, sweep: number): Cubic[] {
  if (!sweep || !Number.isFinite(sweep)) return [];
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / count;
  const k = (4 / 3) * Math.tan(step / 4);
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const map = (u: number, v: number): Vec => ({x: center.x + rx * u * cos - ry * v * sin, y: center.y + rx * u * sin + ry * v * cos});
  const out: Cubic[] = [];
  for (let s = 0; s < count; s++) {
    const a = start + s * step, b = a + step;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    out.push([map(ca, sa), map(ca - k * sa, sa + k * ca), map(cb + k * sb, sb - k * cb), map(cb, sb)]);
  }
  return out;
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────

/** A number for SVG or CSS output: rounded to `precision` decimals, no "-0", no exponent for small values. */
export function formatNumber(value: number, precision = 3): string {
  if (!Number.isFinite(value)) return '0';
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  if (rounded === 0) return '0';
  const text = String(rounded);
  return text.includes('e-') ? rounded.toFixed(precision).replace(/\.?0+$/, '') : text;
}

/** Compact SVG path data ("M0 0L10 0C…Z") with `precision` decimals. */
export function serializePathData(commands: readonly PathCommand[], precision = 3): string {
  const f = (v: number) => formatNumber(v, precision);
  let out = '';
  for (const c of commands) {
    switch (c.type) {
      case 'M': case 'L': out += `${c.type}${f(c.x)} ${f(c.y)}`; break;
      case 'C': out += `C${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)}`; break;
      case 'Q': out += `Q${f(c.x1)} ${f(c.y1)} ${f(c.x)} ${f(c.y)}`; break;
      case 'Z': out += 'Z'; break;
    }
  }
  return out;
}

// ── Transforms and structure ───────────────────────────────────────────────────────────────────

const applyMatrix = (m: Matrix, x: number, y: number): Vec => ({x: m[0][0] * x + m[0][1] * y + m[0][2], y: m[1][0] * x + m[1][1] * y + m[1][2]});

/** Every point of the path mapped by `matrix` (affine maps keep Béziers Béziers, so this is exact). */
export function transformPath(commands: readonly PathCommand[], matrix: Matrix): PathCommand[] {
  return commands.map(c => {
    switch (c.type) {
      case 'M': case 'L': { const p = applyMatrix(matrix, c.x, c.y); return {type: c.type, x: p.x, y: p.y}; }
      case 'C': {
        const p1 = applyMatrix(matrix, c.x1, c.y1), p2 = applyMatrix(matrix, c.x2, c.y2), p = applyMatrix(matrix, c.x, c.y);
        return {type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y};
      }
      case 'Q': {
        const p1 = applyMatrix(matrix, c.x1, c.y1), p = applyMatrix(matrix, c.x, c.y);
        return {type: 'Q', x1: p1.x, y1: p1.y, x: p.x, y: p.y};
      }
      default: return {type: 'Z'};
    }
  });
}

export const transformPaths = (paths: readonly VectorPath[], matrix: Matrix): VectorPath[] =>
  paths.map(path => ({windingRule: path.windingRule, commands: transformPath(path.commands, matrix)}));

/** The path split at its movetos; each piece starts with M. Drawing before the first M is dropped. */
export function subpaths(commands: readonly PathCommand[]): PathCommand[][] {
  const out: PathCommand[][] = [];
  let current: PathCommand[] | null = null;
  for (const c of commands) {
    if (c.type === 'M') {
      current = [c];
      out.push(current);
    } else if (current) current.push(c);
  }
  return out;
}

/** True when the path has at least one subpath and every subpath ends with Z. */
export function isClosed(commands: readonly PathCommand[]): boolean {
  const parts = subpaths(commands);
  return parts.length > 0 && parts.every(part => part[part.length - 1].type === 'Z');
}

const quadToCubic = (p0: Vec, q: Vec, p1: Vec): Cubic => [p0, lerp(p0, q, 2 / 3), lerp(p1, q, 2 / 3), p1];

/** The drawn segments in order. With `closeOpen`, open subpaths get the closing line a fill adds. */
export function pathSegments(commands: readonly PathCommand[], options: {closeOpen?: boolean} = {}): PathSegment[] {
  const out: PathSegment[] = [];
  let current: Vec | null = null, start: Vec | null = null;
  let subpath = -1, drawn = false, open = false;
  const closeImplicitly = () => {
    if (options.closeOpen && open && current && start && !samePoint(current, start, 0)) out.push({index: -1, subpath, kind: 'line', p0: current, p1: start});
  };
  commands.forEach((c, index) => {
    if (c.type === 'M') {
      closeImplicitly();
      current = start = {x: c.x, y: c.y};
      subpath++;
      drawn = false;
      open = true;
      return;
    }
    if (!current || !start) return;
    switch (c.type) {
      case 'L': out.push({index, subpath, kind: 'line', p0: current, p1: current = {x: c.x, y: c.y}}); break;
      case 'C': out.push({index, subpath, kind: 'cubic', p0: current, c1: {x: c.x1, y: c.y1}, c2: {x: c.x2, y: c.y2}, p1: current = {x: c.x, y: c.y}}); break;
      case 'Q': {
        const [p0, c1, c2, p1] = quadToCubic(current, {x: c.x1, y: c.y1}, {x: c.x, y: c.y});
        out.push({index, subpath, kind: 'cubic', p0, c1, c2, p1});
        current = p1;
        break;
      }
      case 'Z':
        if (!samePoint(current, start, 0) || !drawn) out.push({index, subpath, kind: 'line', p0: current, p1: start});
        current = start;
        open = false;
        break;
    }
    drawn = true;
  });
  closeImplicitly();
  return out;
}

const segmentCubic = (s: PathSegment): Cubic => (s.kind === 'cubic' ? [s.p0, s.c1, s.c2, s.p1] : [s.p0, lerp(s.p0, s.p1, 1 / 3), lerp(s.p0, s.p1, 2 / 3), s.p1]);

/** Each subpath drawn the other way round; closed subpaths stay closed and keep their start point. */
export function reversePath(commands: readonly PathCommand[]): PathCommand[] {
  const out: PathCommand[] = [];
  for (const part of subpaths(commands)) {
    const closed = part[part.length - 1].type === 'Z';
    const start = part[0] as {x: number; y: number};
    type Piece = {from: Vec; command: PathCommand};
    const pieces: Piece[] = [];
    let current: Vec = {x: start.x, y: start.y};
    for (const c of part.slice(1)) {
      if (c.type === 'Z') break;
      pieces.push({from: current, command: c});
      current = {x: (c as {x: number}).x, y: (c as {y: number}).y};
    }
    const reversed: PathCommand[] = [];
    for (let k = pieces.length - 1; k >= 0; k--) {
      const {from, command} = pieces[k];
      if (command.type === 'C') reversed.push({type: 'C', x1: command.x2, y1: command.y2, x2: command.x1, y2: command.y1, x: from.x, y: from.y});
      else if (command.type === 'Q') reversed.push({type: 'Q', x1: command.x1, y1: command.y1, x: from.x, y: from.y});
      else reversed.push({type: 'L', x: from.x, y: from.y});
    }
    if (closed) {
      out.push({type: 'M', x: start.x, y: start.y});
      // The implicit closing line becomes the first segment of the reversed loop.
      if (!samePoint(current, start, 0)) out.push({type: 'L', x: current.x, y: current.y});
      out.push(...reversed, {type: 'Z'});
    } else {
      out.push({type: 'M', x: current.x, y: current.y}, ...reversed);
    }
  }
  return out;
}

// ── Curve evaluation ───────────────────────────────────────────────────────────────────────────

export function cubicPoint(c: Cubic, t: number): Vec {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
  return {x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y};
}

export function cubicDerivative(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  const a = 3 * mt * mt, b = 6 * mt * t, d = 3 * t * t;
  return {
    x: a * (c[1].x - c[0].x) + b * (c[2].x - c[1].x) + d * (c[3].x - c[2].x),
    y: a * (c[1].y - c[0].y) + b * (c[2].y - c[1].y) + d * (c[3].y - c[2].y),
  };
}

/** De Casteljau split of a cubic at `t`. */
export function splitCubicAt(c: Cubic, t: number): [Cubic, Cubic] {
  const p01 = lerp(c[0], c[1], t), p12 = lerp(c[1], c[2], t), p23 = lerp(c[2], c[3], t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
  const mid = lerp(p012, p123, t);
  return [[c[0], p01, p012, mid], [mid, p123, p23, c[3]]];
}

/** The piece of a cubic between t0 and t1 (reversed when t1 < t0). */
export function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  if (t1 < t0) {
    const r = subCubic(c, t1, t0);
    return [r[3], r[2], r[1], r[0]];
  }
  if (t0 <= 0 && t1 >= 1) return c;
  let right = t0 > 0 ? splitCubicAt(c, t0)[1] : c;
  if (t1 < 1) right = splitCubicAt(right, t0 >= 1 ? 0 : (t1 - t0) / (1 - t0))[0];
  return right;
}

/** Roots of a·t² + b·t + c in the open interval (0, 1). */
function unitQuadraticRoots(a: number, b: number, c: number): number[] {
  const roots: number[] = [];
  const keep = (t: number) => { if (t > 1e-12 && t < 1 - 1e-12) roots.push(t); };
  const scaleOf = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (!scaleOf) return roots;
  if (Math.abs(a) < scaleOf * 1e-12) {
    if (b) keep(-c / b);
    return roots;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return roots;
  const sq = Math.sqrt(disc);
  // The numerically stable pair of roots.
  const q = -0.5 * (b + (b < 0 ? -sq : sq));
  keep(q / a);
  if (q) keep(c / q);
  return roots.sort((x, y) => x - y);
}

/** Parameters in (0, 1) where the cubic's x (axis 'x') or y turns. */
function cubicExtrema(c: Cubic, axis: 'x' | 'y'): number[] {
  const p0 = c[0][axis], p1 = c[1][axis], p2 = c[2][axis], p3 = c[3][axis];
  return unitQuadraticRoots(3 * (-p0 + 3 * p1 - 3 * p2 + p3), 6 * (p0 - 2 * p1 + p2), 3 * (p1 - p0));
}

// ── Bounds ─────────────────────────────────────────────────────────────────────────────────────

/** Exact bounds of what the path draws (curve extrema included, control points not), or null
 *  when it draws nothing. A lone moveto adds nothing; "M x y Z" adds its point. */
export function pathBounds(commands: readonly PathCommand[]): Rect | null {
  // Allocation-free: the renderer and importers call this on paths of 10⁵ commands.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cx = 0, cy = 0, sx = 0, sy = 0, pending = false, started = false;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const flush = () => {
    if (pending) { add(cx, cy); pending = false; }
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M': cx = sx = c.x; cy = sy = c.y; pending = started = true; break;
      case 'L': if (!started) break; flush(); add(c.x, c.y); cx = c.x; cy = c.y; break;
      case 'Q': case 'C': {
        if (!started) break;
        flush();
        // Raised to a cubic (exact), then the extrema of each axis.
        const x1 = c.type === 'C' ? c.x1 : cx + (2 / 3) * (c.x1 - cx), y1 = c.type === 'C' ? c.y1 : cy + (2 / 3) * (c.y1 - cy);
        const x2 = c.type === 'C' ? c.x2 : c.x + (2 / 3) * (c.x1 - c.x), y2 = c.type === 'C' ? c.y2 : c.y + (2 / 3) * (c.y1 - c.y);
        add(c.x, c.y);
        if (x1 < minX || x1 > maxX || x2 < minX || x2 > maxX) axisExtrema(cx, x1, x2, c.x, x => add(x, cy));
        if (y1 < minY || y1 > maxY || y2 < minY || y2 > maxY) axisExtrema(cy, y1, y2, c.y, y => add(cx, y));
        cx = c.x; cy = c.y;
        break;
      }
      case 'Z': if (!started) break; flush(); cx = sx; cy = sy; break;
    }
  }
  return minX <= maxX ? {x: minX, y: minY, width: maxX - minX, height: maxY - minY} : null;
}

/** Calls `visit` with the values a cubic's coordinate takes at its interior turning points.
 *  (Only one axis is reported; the other coordinate passed to `add` is already inside the box
 *  from the segment's start point, so it never widens the other axis.) */
function axisExtrema(p0: number, p1: number, p2: number, p3: number, visit: (value: number) => void): void {
  for (const t of unitQuadraticRoots(3 * (-p0 + 3 * p1 - 3 * p2 + p3), 6 * (p0 - 2 * p1 + p2), 3 * (p1 - p0))) {
    const mt = 1 - t;
    visit(mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3);
  }
}

/** Bounds of several paths together, or null when none draws anything. */
export function pathsBounds(paths: readonly VectorPath[]): Rect | null {
  let out: Rect | null = null;
  for (const path of paths) {
    const b = pathBounds(path.commands);
    if (!b) continue;
    if (!out) out = b;
    else {
      const x = Math.min(out.x, b.x), y = Math.min(out.y, b.y);
      out = {x, y, width: Math.max(out.x + out.width, b.x + b.width) - x, height: Math.max(out.y + out.height, b.y + b.height) - y};
    }
  }
  return out;
}

// ── Flattening ─────────────────────────────────────────────────────────────────────────────────

/** Total turning of the control polygon: an upper bound of how far the curve turns. */
function controlTurn(c: Cubic): number {
  let total = 0;
  let previous: Vec | null = null;
  for (let k = 1; k < 4; k++) {
    const leg = sub(c[k], c[k - 1]);
    if (length(leg) < EPSILON) continue;
    if (previous) total += Math.abs(Math.atan2(cross(previous, leg), dot(previous, leg)));
    previous = leg;
  }
  return total;
}

/** How many equal parameter steps keep the chords of a cubic within `tolerance` of the curve
 *  (the chord error of a uniform split is at most ¾·max|second difference|/n²), and with
 *  `maxAngle`, also keep each step's turn under it (offsetting a stroke needs that). */
export function cubicSteps(c: Cubic, tolerance: number, maxAngle = 0): number {
  const d1 = Math.hypot(c[0].x - 2 * c[1].x + c[2].x, c[0].y - 2 * c[1].y + c[2].y);
  const d2 = Math.hypot(c[1].x - 2 * c[2].x + c[3].x, c[1].y - 2 * c[2].y + c[3].y);
  let steps = Math.ceil(Math.sqrt((0.75 * Math.max(d1, d2)) / Math.max(tolerance, 1e-9)));
  if (maxAngle > 0) steps = Math.max(steps, Math.ceil(controlTurn(c) / maxAngle));
  return Math.min(Math.max(steps, 1), PATH_LIMITS.maxCurveSteps);
}

/** Polylines within `tolerance` of the path, one per subpath. `maxAngle` (radians) also bounds
 *  how much the curve may turn between two points. */
export function flattenPath(commands: readonly PathCommand[], tolerance = 0.25, options: {maxAngle?: number; maxPoints?: number} = {}): Polyline[] {
  const budget = options.maxPoints ?? PATH_LIMITS.maxPoints;
  const out: Polyline[] = [];
  let line: Polyline | null = null;
  let total = 0;
  let last: Vec = {x: 0, y: 0};
  const push = (p: Vec) => {
    if (!line) return;
    const points = line.points;
    if (points.length && samePoint(points[points.length - 1], p, 0)) return;
    points.push(p);
    total++;
  };
  for (const c of commands) {
    if (c.type === 'M') {
      line = {points: [], closed: false};
      out.push(line);
      push(last = {x: c.x, y: c.y});
      continue;
    }
    if (!line) continue;
    if (c.type === 'Z') {
      line.closed = true;
      last = line.points[0];
      continue;
    }
    if (line.closed) {
      // Drawing after Z without a moveto (not produced by the parser): continue from the start.
      line = {points: [], closed: false};
      out.push(line);
      push(last);
    }
    if (c.type === 'L') {
      push(last = {x: c.x, y: c.y});
      continue;
    }
    const cubic: Cubic = c.type === 'C' ? [last, {x: c.x1, y: c.y1}, {x: c.x2, y: c.y2}, {x: c.x, y: c.y}] : quadToCubic(last, {x: c.x1, y: c.y1}, {x: c.x, y: c.y});
    const steps = total > budget ? 1 : cubicSteps(cubic, tolerance, options.maxAngle);
    for (let k = 1; k < steps; k++) push(cubicPoint(cubic, k / steps));
    push(last = cubic[3]);
  }
  for (const polyline of out) {
    const points = polyline.points;
    if (polyline.closed && points.length > 1 && samePoint(points[0], points[points.length - 1], 0)) points.pop();
  }
  return out.filter(p => p.points.length > 0);
}

// ── Hit testing ────────────────────────────────────────────────────────────────────────────────

/** Winding number of the path around `point`. Open subpaths are closed as a fill closes them.
 *  Curves are split where y turns and each monotonic piece is solved exactly, so tangent and
 *  vertex cases follow one half-open rule and never count twice. */
export function windingNumber(commands: readonly PathCommand[], point: Vec): number {
  let winding = 0;
  const {x: px, y: py} = point;
  const crossLine = (a: Vec, b: Vec) => {
    if (a.y <= py) {
      if (b.y > py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) > 0) winding++;
    } else if (b.y <= py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) < 0) winding--;
  };
  for (const s of pathSegments(commands, {closeOpen: true})) {
    if (s.kind === 'line') { crossLine(s.p0, s.p1); continue; }
    const c: Cubic = [s.p0, s.c1, s.c2, s.p1];
    const minY = Math.min(c[0].y, c[1].y, c[2].y, c[3].y), maxY = Math.max(c[0].y, c[1].y, c[2].y, c[3].y);
    // Entirely on one side of the ray, or entirely to its left: no crossing.
    if (py < minY || py >= maxY) continue;
    if (Math.max(c[0].x, c[1].x, c[2].x, c[3].x) < px) continue;
    const cuts = [0, ...cubicExtrema(c, 'y'), 1];
    for (let k = 1; k < cuts.length; k++) {
      let t0 = cuts[k - 1], t1 = cuts[k];
      const y0 = cubicPoint(c, t0).y, y1 = cubicPoint(c, t1).y;
      const upward = y0 <= py && y1 > py, downward = y1 <= py && y0 > py;
      if (!upward && !downward) continue;
      // Bisection on the monotonic piece for the crossing.
      for (let iteration = 0; iteration < 60 && t1 - t0 > 1e-13; iteration++) {
        const mid = (t0 + t1) / 2;
        const y = cubicPoint(c, mid).y;
        if ((y <= py) === upward) t0 = mid; else t1 = mid;
      }
      if (cubicPoint(c, (t0 + t1) / 2).x > px) winding += upward ? 1 : -1;
    }
  }
  return winding;
}

/** Whether the fill of `commands` under `windingRule` covers `point`. */
export function pointInPath(commands: readonly PathCommand[], point: Vec, windingRule: WindingRule = 'NONZERO'): boolean {
  const w = windingNumber(commands, point);
  return windingRule === 'EVENODD' ? (w & 1) === 1 : w !== 0;
}

/** Whether any of the paths, each with its own winding rule, covers `point`. */
export const pointInPaths = (paths: readonly VectorPath[], point: Vec): boolean => paths.some(p => pointInPath(p.commands, point, p.windingRule));

/** The nearest point of the drawn outline: its distance, the command drawing it, and the curve parameter there. */
export type PathHit = {distance: number; index: number; t: number; point: Vec};

/** Nearest point on what the path strokes (closing lines of Z included, implicit fill closings not). */
export function distanceToPath(commands: readonly PathCommand[], point: Vec): PathHit | null {
  let best: PathHit | null = null;
  const consider = (index: number, t: number, p: Vec) => {
    const d = distance(p, point);
    if (!best || d < best.distance) best = {distance: d, index, t, point: p};
  };
  for (const s of pathSegments(commands)) {
    if (s.kind === 'line') {
      const d = sub(s.p1, s.p0);
      const len2 = dot(d, d);
      const t = len2 ? Math.max(0, Math.min(1, dot(sub(point, s.p0), d) / len2)) : 0;
      consider(s.index, t, lerp(s.p0, s.p1, t));
      continue;
    }
    const c: Cubic = [s.p0, s.c1, s.c2, s.p1];
    const samples = 16;
    let bestT = 0, bestD = Infinity;
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      const d = distance(cubicPoint(c, t), point);
      if (d < bestD) { bestD = d; bestT = t; }
    }
    // Golden-section refinement around the best sample.
    let lo = Math.max(0, bestT - 1 / samples), hi = Math.min(1, bestT + 1 / samples);
    const ratio = (Math.sqrt(5) - 1) / 2;
    let a = hi - ratio * (hi - lo), b = lo + ratio * (hi - lo);
    let fa = distance(cubicPoint(c, a), point), fb = distance(cubicPoint(c, b), point);
    for (let iteration = 0; iteration < 40; iteration++) {
      if (fa < fb) { hi = b; b = a; fb = fa; a = hi - ratio * (hi - lo); fa = distance(cubicPoint(c, a), point); }
      else { lo = a; a = b; fa = fb; b = lo + ratio * (hi - lo); fb = distance(cubicPoint(c, b), point); }
    }
    const t = (lo + hi) / 2;
    const p = cubicPoint(c, t);
    if (distance(p, point) <= bestD) consider(s.index, t, p);
    else consider(s.index, bestT, cubicPoint(c, bestT));
  }
  return best;
}

// ── Lengths ────────────────────────────────────────────────────────────────────────────────────

const GAUSS_NODES = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664];
const GAUSS_WEIGHTS = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];

/** Arc length of a cubic between two parameters: 5-point Gauss–Legendre on 8 pieces, accurate
 *  to well under a thousandth of a pixel for the curves designers draw. */
export function cubicLength(c: Cubic, t0 = 0, t1 = 1): number {
  const pieces = 8;
  const h = (t1 - t0) / pieces;
  let total = 0;
  for (let piece = 0; piece < pieces; piece++) {
    const a = t0 + piece * h;
    for (let k = 0; k < 5; k++) total += GAUSS_WEIGHTS[k] * length(cubicDerivative(c, a + (h * (GAUSS_NODES[k] + 1)) / 2));
  }
  return (total * h) / 2;
}

const segmentLength = (s: PathSegment) => (s.kind === 'line' ? distance(s.p0, s.p1) : cubicLength([s.p0, s.c1, s.c2, s.p1]));

/** Length of everything the path strokes. */
export const pathLength = (commands: readonly PathCommand[]): number => pathSegments(commands).reduce((sum, s) => sum + segmentLength(s), 0);

/** The point `distanceAlong` from the start of the stroked outline, with the unit tangent there;
 *  clamped to the ends. Null for a path that draws nothing. */
export function pointAtLength(commands: readonly PathCommand[], distanceAlong: number): {point: Vec; tangent: Vec; index: number; t: number} | null {
  const segments = pathSegments(commands);
  if (!segments.length) return null;
  let remaining = Math.max(0, distanceAlong);
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k];
    const len = segmentLength(s);
    if (remaining > len && k < segments.length - 1) {
      remaining -= len;
      continue;
    }
    if (s.kind === 'line') {
      const t = len ? Math.min(1, remaining / len) : 1;
      return {point: lerp(s.p0, s.p1, t), tangent: normalize(sub(s.p1, s.p0)), index: s.index, t};
    }
    const c: Cubic = [s.p0, s.c1, s.c2, s.p1];
    let lo = 0, hi = 1;
    if (remaining >= len) lo = hi = 1;
    else for (let iteration = 0; iteration < 40; iteration++) {
      const mid = (lo + hi) / 2;
      if (cubicLength(c, 0, mid) < remaining) lo = mid; else hi = mid;
    }
    const t = (lo + hi) / 2;
    return {point: cubicPoint(c, t), tangent: cubicTangent(c, t), index: s.index, t};
  }
  return null;
}

/** Unit tangent of a cubic at t, falling back to the control polygon where the derivative vanishes. */
export function cubicTangent(c: Cubic, t: number): Vec {
  const d = cubicDerivative(c, t);
  if (length(d) > EPSILON) return normalize(d);
  if (t < 0.5) {
    for (const p of [c[1], c[2], c[3]]) if (!samePoint(p, c[0])) return normalize(sub(p, c[0]));
  } else {
    for (const p of [c[2], c[1], c[0]]) if (!samePoint(p, c[3])) return normalize(sub(c[3], p));
  }
  return {x: 1, y: 0};
}

// ── Anchors (pen and vector editing) ───────────────────────────────────────────────────────────

/** corner: handles independent (or missing); smooth: handles on one line, lengths free;
 *  mirrored: on one line and of equal length (Figma's "Mirrored"). */
export type AnchorKind = 'corner' | 'smooth' | 'mirrored';
/** An editable point. Handles are absolute positions; null means no handle (the segment leaves straight). */
export type Anchor = {x: number; y: number; in: Vec | null; out: Vec | null; kind: AnchorKind};
export type AnchorPath = {anchors: Anchor[]; closed: boolean};

/** The kind the handles of an anchor describe. */
export function anchorKind(a: Pick<Anchor, 'x' | 'y' | 'in' | 'out'>): AnchorKind {
  if (!a.in || !a.out) return 'corner';
  const u = sub(a.in, a), v = sub(a.out, a);
  const lu = length(u), lv = length(v);
  if (lu < EPSILON || lv < EPSILON) return 'corner';
  const sine = cross(u, v) / (lu * lv);
  if (Math.abs(sine) > 1e-3 || dot(u, v) > 0) return 'corner';
  return Math.abs(lu - lv) <= Math.max(1e-6, 1e-4 * Math.max(lu, lv)) ? 'mirrored' : 'smooth';
}

/** The path as anchors with handles, one list per subpath. A closed subpath whose last segment
 *  returns to its start shares that point with the first anchor; quadratics become cubic handles. */
export function pathToAnchors(commands: readonly PathCommand[]): AnchorPath[] {
  const out: AnchorPath[] = [];
  for (const part of subpaths(commands)) {
    const m = part[0] as {x: number; y: number};
    const anchors: Anchor[] = [{x: m.x, y: m.y, in: null, out: null, kind: 'corner'}];
    let closed = false;
    for (const c of part.slice(1)) {
      const last = anchors[anchors.length - 1];
      if (c.type === 'Z') { closed = true; break; }
      if (c.type === 'M') continue;
      let c1: Vec | null = null, c2: Vec | null = null;
      if (c.type === 'C') { c1 = {x: c.x1, y: c.y1}; c2 = {x: c.x2, y: c.y2}; }
      else if (c.type === 'Q') {
        const cubic = quadToCubic(last, {x: c.x1, y: c.y1}, {x: c.x, y: c.y});
        c1 = cubic[1]; c2 = cubic[2];
      }
      if (c1 && !samePoint(c1, last)) last.out = c1;
      anchors.push({x: c.x, y: c.y, in: c2 && !samePoint(c2, c) ? c2 : null, out: null, kind: 'corner'});
    }
    if (closed && anchors.length > 1 && samePoint(anchors[0], anchors[anchors.length - 1], 1e-7)) {
      anchors[0].in = anchors.pop()!.in;
    }
    for (const a of anchors) a.kind = anchorKind(a);
    out.push({anchors, closed});
  }
  return out;
}

/** Path commands for anchor lists: a segment is a line when neither end has a handle on it. */
export function anchorsToPath(paths: readonly AnchorPath[]): PathCommand[] {
  const out: PathCommand[] = [];
  const segment = (a: Anchor, b: Anchor) => {
    if (!a.out && !b.in) out.push({type: 'L', x: b.x, y: b.y});
    else {
      const c1 = a.out ?? a, c2 = b.in ?? b;
      out.push({type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: b.x, y: b.y});
    }
  };
  for (const {anchors, closed} of paths) {
    if (!anchors.length) continue;
    out.push({type: 'M', x: anchors[0].x, y: anchors[0].y});
    for (let k = 1; k < anchors.length; k++) segment(anchors[k - 1], anchors[k]);
    if (closed) {
      const last = anchors[anchors.length - 1];
      // A straight closing segment is the Z itself.
      if (anchors.length > 1 && (last.out || anchors[0].in)) segment(last, anchors[0]);
      out.push({type: 'Z'});
    }
  }
  return out;
}

/** Splits the segment drawn by `commands[segmentIndex]` (an L, C, Q, or a Z with a closing line)
 *  at parameter `t`, without changing the shape. In the result the new anchor is the end point of
 *  `commands[segmentIndex]`. Out-of-range indexes and M return a copy. */
export function insertAnchorAt(commands: readonly PathCommand[], segmentIndex: number, t: number): PathCommand[] {
  const out = commands.slice();
  const target = commands[segmentIndex];
  if (!target || target.type === 'M') return out;
  t = Math.max(0, Math.min(1, t));
  let current: Vec = {x: 0, y: 0}, start: Vec = {x: 0, y: 0};
  for (let k = 0; k < segmentIndex; k++) {
    const c = commands[k];
    if (c.type === 'Z') current = start;
    else {
      current = {x: c.x, y: c.y};
      if (c.type === 'M') start = current;
    }
  }
  switch (target.type) {
    case 'L': {
      const p = lerp(current, target, t);
      out.splice(segmentIndex, 1, {type: 'L', x: p.x, y: p.y}, target);
      break;
    }
    case 'C': {
      const [left, right] = splitCubicAt([current, {x: target.x1, y: target.y1}, {x: target.x2, y: target.y2}, {x: target.x, y: target.y}], t);
      out.splice(segmentIndex, 1,
        {type: 'C', x1: left[1].x, y1: left[1].y, x2: left[2].x, y2: left[2].y, x: left[3].x, y: left[3].y},
        {type: 'C', x1: right[1].x, y1: right[1].y, x2: right[2].x, y2: right[2].y, x: right[3].x, y: right[3].y});
      break;
    }
    case 'Q': {
      const control = {x: target.x1, y: target.y1}, end = {x: target.x, y: target.y};
      const a = lerp(current, control, t), b = lerp(control, end, t), p = lerp(a, b, t);
      out.splice(segmentIndex, 1, {type: 'Q', x1: a.x, y1: a.y, x: p.x, y: p.y}, {type: 'Q', x1: b.x, y1: b.y, x: end.x, y: end.y});
      break;
    }
    case 'Z': {
      if (samePoint(current, start)) break;
      const p = lerp(current, start, t);
      out.splice(segmentIndex, 0, {type: 'L', x: p.x, y: p.y});
      break;
    }
  }
  return out;
}

// ── Curve fitting ──────────────────────────────────────────────────────────────────────────────

/** Fits cubics through sampled points within `tolerance` (Schneider, "An Algorithm for
 *  Automatically Fitting Digitized Curves", Graphics Gems 1990): least-squares handles along the
 *  end tangents, Newton reparameterisation, and a split at the worst point when that is not
 *  enough. Neighbouring cubics share tangents, so the result is smooth where the points are.
 *  Used by the pencil, outline stroke, and wherever a polyline should become an editable curve. */
export function fitCubics(points: readonly Vec[], tolerance: number): Cubic[] {
  const pts: Vec[] = [];
  for (const p of points) if (!pts.length || !samePoint(pts[pts.length - 1], p, 1e-12)) pts.push(p);
  if (pts.length < 2) return [];
  const out: Cubic[] = [];
  const startTangent = endTangentOf(pts[0], pts[1], pts[2]);
  const endTangent = endTangentOf(pts[pts.length - 1], pts[pts.length - 2], pts[pts.length - 3]);
  fitRange(pts, 0, pts.length - 1, startTangent, endTangent, Math.max(tolerance, 1e-6), out, 0);
  return out;
}

/** Direction leaving `p0` towards `p1`, second-order accurate when a third point is known (the
 *  one-sided difference of the parabola through the three points, by chord length), so sampled
 *  arcs fit with as few cubics as the curve really needs. */
function endTangentOf(p0: Vec, p1: Vec, p2: Vec | undefined): Vec {
  const secant = normalize(sub(p1, p0));
  if (!p2) return secant;
  const h1 = distance(p0, p1), h2 = distance(p1, p2);
  if (h1 < EPSILON || h2 < EPSILON) return secant;
  const a = -(2 * h1 + h2) / (h1 * (h1 + h2)), b = (h1 + h2) / (h1 * h2), c = -h1 / (h2 * (h1 + h2));
  const d = normalize({x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y});
  // Keep the estimate only when it agrees with the secant (no corner hiding at the end).
  return dot(d, secant) > 0.9 ? d : secant;
}

function fitRange(pts: Vec[], first: number, last: number, tan1: Vec, tan2: Vec, error: number, out: Cubic[], depth: number): void {
  const p0 = pts[first], p3 = pts[last];
  if (last - first === 1 || depth > 32) {
    const dist = distance(p0, p3) / 3;
    out.push([p0, add(p0, scale(tan1, dist)), add(p3, scale(tan2, dist)), p3]);
    return;
  }
  let u = chordParameters(pts, first, last);
  let bezier = generateBezier(pts, first, last, u, tan1, tan2);
  let [maxError, split] = maxFitError(pts, first, last, bezier, u);
  if (maxError <= error) { out.push(bezier); return; }
  if (maxError <= error * 32) {
    for (let iteration = 0; iteration < 24; iteration++) {
      u = reparameterize(pts, first, last, u, bezier);
      bezier = generateBezier(pts, first, last, u, tan1, tan2);
      [maxError, split] = maxFitError(pts, first, last, bezier, u);
      if (maxError <= error) { out.push(bezier); return; }
    }
  }
  // Far from fitting: halve by length so symmetric shapes get symmetric, fewer pieces.
  // Close: cut at the worst point, as Schneider does.
  if (maxError > error * 32) {
    const half = u.findIndex(t => t >= 0.5);
    if (half > 0) split = first + half;
  }
  split = Math.max(first + 1, Math.min(last - 1, split));
  let center = normalize(sub(pts[split - 1], pts[split + 1]));
  if (!length(center)) center = normalize({x: -(pts[split].y - pts[split - 1].y), y: pts[split].x - pts[split - 1].x});
  fitRange(pts, first, split, tan1, center, error, out, depth + 1);
  fitRange(pts, split, last, scale(center, -1), tan2, error, out, depth + 1);
}

function chordParameters(pts: Vec[], first: number, last: number): number[] {
  const u = [0];
  for (let k = first + 1; k <= last; k++) u.push(u[u.length - 1] + distance(pts[k], pts[k - 1]));
  const total = u[u.length - 1] || 1;
  return u.map(v => v / total);
}

function generateBezier(pts: Vec[], first: number, last: number, u: number[], tan1: Vec, tan2: Vec): Cubic {
  const p0 = pts[first], p3 = pts[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let k = 0; k <= last - first; k++) {
    const t = u[k], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * t * mt * mt, b2 = 3 * t * t * mt, b3 = t * t * t;
    const a1 = scale(tan1, b1), a2 = scale(tan2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[first + k], add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = 0, alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x0 * c11 - x1 * c01) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
  }
  const segLength = distance(p0, p3);
  const eps = 1e-6 * segLength;
  if (alpha1 < eps || alpha2 < eps) {
    // The least-squares answer is degenerate: fall back to Wu–Barsky's heuristic.
    alpha1 = alpha2 = segLength / 3;
  }
  return [p0, add(p0, scale(tan1, alpha1)), add(p3, scale(tan2, alpha2)), p3];
}

function maxFitError(pts: Vec[], first: number, last: number, bezier: Cubic, u: number[]): [number, number] {
  let max = 0, split = Math.floor((last + first) / 2);
  for (let k = first + 1; k < last; k++) {
    const d = distance(cubicPoint(bezier, u[k - first]), pts[k]);
    if (d >= max) { max = d; split = k; }
  }
  return [max, split];
}

function reparameterize(pts: Vec[], first: number, last: number, u: number[], bezier: Cubic): number[] {
  return u.map((t, k) => {
    const p = pts[first + k];
    const d = sub(cubicPoint(bezier, t), p);
    const d1 = cubicDerivative(bezier, t);
    const mt = 1 - t;
    const d2 = {
      x: 6 * mt * (bezier[2].x - 2 * bezier[1].x + bezier[0].x) + 6 * t * (bezier[3].x - 2 * bezier[2].x + bezier[1].x),
      y: 6 * mt * (bezier[2].y - 2 * bezier[1].y + bezier[0].y) + 6 * t * (bezier[3].y - 2 * bezier[2].y + bezier[1].y),
    };
    const denominator = dot(d1, d1) + dot(d, d2);
    if (Math.abs(denominator) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - dot(d, d1) / denominator));
  });
}

/** Commands for a chain of cubics (a moveto to the first point, no Z). */
export function cubicsToCommands(cubics: readonly Cubic[], moveTo = true): PathCommand[] {
  const out: PathCommand[] = [];
  if (moveTo && cubics.length) out.push({type: 'M', x: cubics[0][0].x, y: cubics[0][0].y});
  for (const c of cubics) out.push({type: 'C', x1: c[1].x, y1: c[1].y, x2: c[2].x, y2: c[2].y, x: c[3].x, y: c[3].y});
  return out;
}

/** Appends a line to (x, y) to commands being built, or extends the previous line when the three
 *  points lie on one line within `eps` and the path keeps going forward (no superfluous anchors). */
export function appendLine(out: PathCommand[], x: number, y: number, eps = 1e-6): void {
  const last = out[out.length - 1], before = out[out.length - 2];
  if (last?.type === 'L' && before && before.type !== 'Z') {
    const dx = x - before.x, dy = y - before.y, l = Math.hypot(dx, dy);
    const mx = last.x - before.x, my = last.y - before.y;
    if (l > 0 && Math.abs(mx * dy - my * dx) / l <= eps && mx * dx + my * dy > 0 && (x - last.x) * dx + (y - last.y) * dy > 0) {
      last.x = x;
      last.y = y;
      return;
    }
  }
  out.push({type: 'L', x, y});
}

/** A closed or open polyline as M/L(/Z) commands. */
export function polylineToCommands(points: readonly Vec[], closed: boolean): PathCommand[] {
  if (!points.length) return [];
  const out: PathCommand[] = [{type: 'M', x: points[0].x, y: points[0].y}];
  for (let k = 1; k < points.length; k++) out.push({type: 'L', x: points[k].x, y: points[k].y});
  if (closed) out.push({type: 'Z'});
  return out;
}

export {segmentCubic};
