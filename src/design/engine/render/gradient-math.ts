import type {ColorStop, GradientPaint, Matrix, Vec} from '../../../../shared/design/types';

// Gradient handles → canvas geometry. Pure, tested in node (tests/design-render-gradient.test.ts).
//
// Handles live in the node's unit box ([0] start or centre, [1] end of the main axis, [2] end of the
// perpendicular axis), as in Figma's REST API. "Gradient space" (u, v) is the frame they span:
// local = S · (h0 + u·(h1 − h0) + v·(h2 − h0)) with S = diag(width, height). A linear gradient's
// colour depends on u alone, a radial one on |(u, v)|, an angular one on the angle from +u towards
// +v, and a diamond one on |u| + |v|. On a box that is not square these shapes are skewed and
// stretched, which is exactly what designers see in Figma.

export type GradientFrame = {
  /** Gradient space → node local space. */
  matrix: Matrix;
  /** Origin and axes in local space: origin = S·h0, a = S·(h1 − h0), b = S·(h2 − h0). */
  origin: Vec;
  a: Vec;
  b: Vec;
};

/** Zero-height lines and zero-width boxes still need a non-singular frame; 1 px stands in. */
const extent = (value: number) => (value > 0 && Number.isFinite(value) ? value : 1);

export function gradientFrame(handles: readonly [Vec, Vec, Vec], width: number, height: number): GradientFrame {
  const w = extent(width), h = extent(height);
  const [h0, h1, h2] = handles;
  const origin = {x: h0.x * w, y: h0.y * h};
  const a = {x: (h1.x - h0.x) * w, y: (h1.y - h0.y) * h};
  const b = {x: (h2.x - h0.x) * w, y: (h2.y - h0.y) * h};
  return {matrix: [[a.x, b.x, origin.x], [a.y, b.y, origin.y]], origin, a, b};
}

const EPSILON = 1e-9;
const dot = (p: Vec, q: Vec) => p.x * q.x + p.y * q.y;

/** Start and end points of a canvas linear gradient in local space that reproduces the handles
 *  exactly: colour 0 on the line through h0 and colour 1 on the line through h1, both parallel to the
 *  perpendicular handle (h2 − h0) after the box scaling. */
export function linearGradientPoints(handles: readonly [Vec, Vec, Vec], width: number, height: number): {x0: number; y0: number; x1: number; y1: number} {
  const {origin, a, b} = gradientFrame(handles, width, height);
  // Normal of the iso-colour lines: perpendicular to b, or along a when b is degenerate or parallel to a.
  let n = {x: b.y, y: -b.x};
  if (dot(n, n) < EPSILON || Math.abs(dot(n, a)) < EPSILON) n = a;
  const na = dot(n, a), nn = dot(n, n);
  if (Math.abs(na) < EPSILON || nn < EPSILON) return {x0: origin.x, y0: origin.y, x1: origin.x + 1, y1: origin.y};
  const k = na / nn;
  return {x0: origin.x, y0: origin.y, x1: origin.x + n.x * k, y1: origin.y + n.y * k};
}

/** True when the frame maps circles to circles (equal, perpendicular axes): a radial or angular
 *  gradient can then use the canvas's own circular gradients in local space. */
export function isSimilarity(frame: GradientFrame, tolerance = 1e-3): boolean {
  const la = Math.hypot(frame.a.x, frame.a.y), lb = Math.hypot(frame.b.x, frame.b.y);
  if (la < EPSILON || lb < EPSILON) return false;
  return Math.abs(la - lb) <= tolerance * Math.max(la, lb) && Math.abs(dot(frame.a, frame.b)) <= tolerance * la * lb;
}

/** Canvas conic gradients turn clockwise on screen (from +x towards +y). Gradient space turns from
 *  +u towards +v, which is the same sense when the frame keeps orientation (det > 0). */
export const keepsOrientation = (frame: GradientFrame) => frame.a.x * frame.b.y - frame.a.y * frame.b.x > 0;

/** Start angle (radians, canvas convention) of an angular gradient drawn natively in local space. */
export const conicStartAngle = (frame: GradientFrame) => Math.atan2(frame.a.y, frame.a.x);

/** Stops sorted by position and clamped to 0..1, as `addColorStop` needs them. */
export function normalizedStops(stops: readonly ColorStop[]): ColorStop[] {
  return stops
    .map((stop, index) => ({stop, index}))
    .sort((p, q) => p.stop.position - q.stop.position || p.index - q.index)
    .map(({stop}) => ({position: Math.min(1, Math.max(0, Number.isFinite(stop.position) ? stop.position : 0)), color: stop.color}));
}

/** The colour of a gradient at `t` (0..1), interpolating linearly between stops in sRGB. */
export function colorAt(stops: readonly ColorStop[], t: number) {
  const sorted = normalizedStops(stops);
  if (!sorted.length) return {r: 0, g: 0, b: 0, a: 0};
  if (t <= sorted[0].position) return sorted[0].color;
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1], q = sorted[i];
    if (t <= q.position) {
      const span = q.position - p.position;
      const f = span > EPSILON ? (t - p.position) / span : 1;
      return {r: p.color.r + (q.color.r - p.color.r) * f, g: p.color.g + (q.color.g - p.color.g) * f, b: p.color.b + (q.color.b - p.color.b) * f, a: p.color.a + (q.color.a - p.color.a) * f};
    }
  }
  return sorted[sorted.length - 1].color;
}

/** The gradient value t (before stops) at gradient-space point (u, v) for each gradient type.
 *  Angular t runs 0..1 clockwise from +u. Used by tests and by the per-pixel fallback. */
export function gradientParameter(type: GradientPaint['type'], u: number, v: number): number {
  switch (type) {
    case 'GRADIENT_LINEAR': return u;
    case 'GRADIENT_RADIAL': return Math.hypot(u, v);
    case 'GRADIENT_DIAMOND': return Math.abs(u) + Math.abs(v);
    case 'GRADIENT_ANGULAR': {
      const angle = Math.atan2(v, u);
      return (angle < 0 ? angle + 2 * Math.PI : angle) / (2 * Math.PI);
    }
  }
}
