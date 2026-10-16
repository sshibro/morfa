import type {PathCommand, SceneNode, StrokeWidthProfile, VariableWidthPoint, VariableWidthStrokeProperties, Vec, VectorPath} from './types';
import {flattenPath, subpaths} from './paths';
import {nodeGeometry} from './shapes';

// "Width profile" (Figma's variable width strokes, `variableWidthStrokeProperties`; docs/design-tool.md §Drawing): the
// stroke of an open LINE or VECTOR whose width changes along the path. The width at a point is `strokeWeight` times the
// profile's value there; the profile is a list of points (position 0..1 along the path's length, width as a fraction of
// the weight) joined by a monotone cubic (Fritsch–Carlson), so two points give a straight taper and a peak gives a
// rounded swell without overshooting. The stroke becomes filled pieces — a trapezoid per step of the flattened path, a
// round wedge on the outer side of every turn, the caps at the ends — all wound the same way, so one non-zero fill of
// them is their union. The canvas, the exports (SVG, PDF, PNG) and "Outline stroke" all use these pieces: they agree
// exactly. A profile is centred; dashes and arrowheads are not drawn with it (the panel says so).

/** The presets, as Figma names them ("Uniform", "Wedge", "Taper", "Taper end", "Lens", "Taper both
 *  ends"). */
export const WIDTH_PROFILE_POINTS: Readonly<Record<Exclude<StrokeWidthProfile, 'CUSTOM'>, readonly VariableWidthPoint[]>> = {
  UNIFORM: [{position: 0, width: 1}, {position: 1, width: 1}],
  WEDGE: [{position: 0, width: 1}, {position: 1, width: 0}],
  TAPER: [{position: 0, width: 1}, {position: 1, width: 0.25}],
  QUARTER_TAPER: [{position: 0, width: 1}, {position: 0.75, width: 1}, {position: 1, width: 0}],
  EYE: [{position: 0, width: 0}, {position: 0.5, width: 1}, {position: 1, width: 0}],
  MIRRORED_TAPER: [{position: 0, width: 0}, {position: 0.25, width: 1}, {position: 0.75, width: 1}, {position: 1, width: 0}],
};

export const WIDTH_PROFILE_LABELS: Readonly<Record<StrokeWidthProfile, string>> = {
  UNIFORM: 'Uniform',
  WEDGE: 'Wedge',
  TAPER: 'Taper',
  QUARTER_TAPER: 'Taper end',
  EYE: 'Lens',
  MIRRORED_TAPER: 'Taper both ends',
  CUSTOM: 'Custom',
};

/** The profile's points, sorted, or null for a plain stroke (absent, UNIFORM, or a custom list that is flat at 1). */
export function widthPointsOf(properties: VariableWidthStrokeProperties | undefined): VariableWidthPoint[] | null {
  if (!properties || properties.widthProfile === 'UNIFORM') return null;
  const raw = properties.widthProfile === 'CUSTOM' ? properties.variableWidthPoints ?? [] : WIDTH_PROFILE_POINTS[properties.widthProfile];
  const points = raw
    .filter(p => Number.isFinite(p.position) && Number.isFinite(p.width))
    .map(p => ({position: Math.max(0, Math.min(1, p.position)), width: Math.max(0, p.width)}))
    .sort((a, b) => a.position - b.position);
  if (!points.length || points.every(p => Math.abs(p.width - 1) < 1e-9)) return null;
  return points;
}

/** The profile's width (a fraction of the weight) at `t` (0..1). */
export function widthAt(points: readonly VariableWidthPoint[], t: number): number {
  const n = points.length;
  if (!n) return 1;
  if (t <= points[0].position || n === 1) return points[0].width;
  if (t >= points[n - 1].position) return points[n - 1].width;
  let i = 0;
  while (i < n - 2 && points[i + 1].position <= t) i++;
  const a = points[i], b = points[i + 1];
  const h = b.position - a.position;
  if (!(h > 0)) return b.width;
  const m0 = tangentAt(points, i), m1 = tangentAt(points, i + 1);
  const s = (t - a.position) / h, s2 = s * s, s3 = s2 * s;
  return Math.max(0, (2 * s3 - 3 * s2 + 1) * a.width + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * b.width + (s3 - s2) * h * m1);
}

/** The monotone (PCHIP) tangent at point `i`: a weighted harmonic mean of the neighbouring slopes, zero at a peak or a
 *  flat, so the curve never overshoots its points; the end points take their interval's slope. */
function tangentAt(points: readonly VariableWidthPoint[], i: number): number {
  const span = (k: number) => points[k + 1].position - points[k].position;
  const slope = (k: number) => (span(k) > 0 ? (points[k + 1].width - points[k].width) / span(k) : 0);
  const n = points.length;
  if (i === 0) return slope(0);
  if (i === n - 1) return slope(n - 2);
  const before = slope(i - 1), after = slope(i);
  if (before * after <= 0) return 0;
  const w1 = 2 * span(i) + span(i - 1), w2 = span(i) + 2 * span(i - 1);
  return (w1 + w2) / (w1 / before + w2 / after);
}

/** A LINE, or a VECTOR whose every path is open: the layers a width profile applies to. */
export function takesWidthProfile(node: Pick<SceneNode, 'type' | 'vectorPaths'>): boolean {
  if (node.type === 'LINE') return true;
  if (node.type !== 'VECTOR') return false;
  const paths = node.vectorPaths ?? [];
  return paths.length > 0 && paths.every(path => subpaths(path.commands).every(part => part[part.length - 1]?.type !== 'Z'));
}

/** The node draws a variable width stroke: it takes a profile, has a stroke, and its profile is not flat. */
export function hasVariableWidth(node: SceneNode): boolean {
  return node.strokeWeight > 0 && !!widthPointsOf(node.variableWidthStrokeProperties) && takesWidthProfile(node);
}

/** The widest the stroke gets, as a fraction of the weight (for bounds). */
export function maxWidthFactor(properties: VariableWidthStrokeProperties | undefined): number {
  const points = widthPointsOf(properties);
  return points ? Math.max(0, ...points.map(p => p.width)) : 1;
}

type V = Vec;
const ring = (points: V[]): PathCommand[] => {
  // Every piece is wound clockwise on screen (positive signed area with y down), so their non-zero fill is their union.
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  const ordered = area < 0 ? [...points].reverse() : points;
  return [{type: 'M', x: ordered[0].x, y: ordered[0].y}, ...ordered.slice(1).map((p): PathCommand => ({type: 'L', x: p.x, y: p.y})), {type: 'Z'}];
};

const ARC_STEP = Math.PI / 16;

/** The points of an arc of radius `r` around `c` from direction `from` to `to` (radians), the short way. */
function arc(c: V, r: number, from: number, to: number): V[] {
  let sweep = to - from;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const out: V[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = from + (sweep * k) / steps;
    out.push({x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r});
  }
  return out;
}

const outlines = new WeakMap<SceneNode, VectorPath[]>();

/** The filled pieces of the node's variable width stroke in its local space (cached per node object), or [] when it has none. */
export function variableWidthOutline(node: SceneNode): VectorPath[] {
  const cached = outlines.get(node);
  if (cached) return cached;
  const commands: PathCommand[] = [];
  const points = hasVariableWidth(node) ? widthPointsOf(node.variableWidthStrokeProperties) : null;
  if (points) for (const path of nodeGeometry(node)) for (const part of subpaths(path.commands)) strokePart(part, points, node, commands);
  const out: VectorPath[] = commands.length ? [{windingRule: 'NONZERO', commands}] : [];
  outlines.set(node, out);
  return out;
}

function strokePart(part: PathCommand[], profile: readonly VariableWidthPoint[], node: SceneNode, out: PathCommand[]): void {
  const weight = node.strokeWeight;
  const hw = (weight * Math.max(...profile.map(p => p.width), 0)) / 2;
  const tolerance = Math.min(0.05, Math.max(0.004, weight * 0.005));
  const maxAngle = Math.min(0.35, Math.max(0.03, 2 * Math.acos(Math.max(-1, 1 - tolerance / Math.max(hw, tolerance)))));
  const line = flattenPath(part, tolerance, {maxAngle})[0];
  if (!line || line.points.length < 2) return;
  const pts = line.points;
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = lengths[lengths.length - 1];
  if (!(total > 0)) return;
  const half = lengths.map(s => (weight * widthAt(profile, s / total)) / 2);
  const dirs: V[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y, d = Math.hypot(dx, dy) || 1;
    dirs.push({x: dx / d, y: dy / d});
  }
  const normal = (d: V): V => ({x: -d.y, y: d.x});
  for (let i = 0; i < dirs.length; i++) {
    const a = pts[i], b = pts[i + 1], n = normal(dirs[i]), ha = half[i], hb = half[i + 1];
    if (ha <= 0 && hb <= 0) continue;
    const quad = [{x: a.x + n.x * ha, y: a.y + n.y * ha}, {x: b.x + n.x * hb, y: b.y + n.y * hb}, {x: b.x - n.x * hb, y: b.y - n.y * hb}, {x: a.x - n.x * ha, y: a.y - n.y * ha}];
    out.push(...ring(ha <= 0 ? [a, quad[1], quad[2]] : hb <= 0 ? [quad[0], b, quad[3]] : quad));
  }
  // Round wedges on the outer side of each turn close the gaps between the steps.
  for (let i = 1; i < dirs.length; i++) {
    const h = half[i];
    const before = dirs[i - 1], after = dirs[i];
    if (h <= 0 || Math.abs(before.x * after.y - before.y * after.x) < 1e-6 && before.x * after.x + before.y * after.y > 0) continue;
    const nb = normal(before), na = normal(after);
    const side = (na.x - nb.x) * before.x + (na.y - nb.y) * before.y > 0 ? 1 : -1;
    const from = Math.atan2(side * nb.y, side * nb.x), to = Math.atan2(side * na.y, side * na.x);
    out.push(...ring([pts[i], ...arc(pts[i], h, from, to)]));
  }
  // Caps.
  const cap = node.strokeCap;
  const ends: [V, V, number][] = [[pts[0], {x: -dirs[0].x, y: -dirs[0].y}, half[0]], [pts[pts.length - 1], dirs[dirs.length - 1], half[half.length - 1]]];
  for (const [p, outward, h] of ends) {
    if (h <= 0 || cap === 'NONE') continue;
    const n = normal(outward);
    if (cap === 'ROUND') {
      const from = Math.atan2(n.y, n.x);
      out.push(...ring([p, ...arc(p, h, from, from - Math.PI / 2), ...arc(p, h, from - Math.PI / 2, from - Math.PI).slice(1)]));
    } else {
      const e = {x: outward.x * h, y: outward.y * h};
      out.push(...ring([{x: p.x + n.x * h, y: p.y + n.y * h}, {x: p.x + n.x * h + e.x, y: p.y + n.y * h + e.y}, {x: p.x - n.x * h + e.x, y: p.y - n.y * h + e.y}, {x: p.x - n.x * h, y: p.y - n.y * h}]));
    }
  }
}
