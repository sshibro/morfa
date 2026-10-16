import type {PathCommand, SceneNode, TextPathData, Vec} from './types';
import type {Rect} from './geometry';
import {flattenPath, reversePath, subpaths} from './paths';
import type {GlyphRun, TextLayout, TextLine} from './text-layout';
import {graphemeBoundaries} from './text-segment';

// "Text on path" (Figma's Text on path; docs/design-tool.md §Text on a path): where each glyph of a TEXT layer with
// `textPath` stands. The text is laid out as usual (shared/design/text-layout.ts, unwrapped), then every grapheme is
// carried along the path: its middle sits at its distance along the path, its baseline turns with the path's direction
// there (SVG's text-on-a-path rule). The canvas, PNG/JPG/WEBP export, SVG and PDF all draw from this one placement, so
// they agree to the glyph.
//
// Along the path: `startOffset` (0..1 of the length) is the anchor; LEFT (and JUSTIFIED) text starts there, CENTER is
// centred on it, RIGHT ends there. Each line is aligned on its own. A closed path carries text round its start; on an
// open one glyphs whose middle falls off an end are not drawn (as SVG does).
// Across it: BOTTOM stands the last line's baseline on the path (the text sits on it), TOP hangs the first line's top
// from it, CENTER centres the lines on it. `side: 'RIGHT'` reads the path backwards, which puts the text on its other
// side.

/** Path samples: a polyline within a twentieth of a pixel of the path, with the length up to each point. */
export type PathSampler = {
  points: Vec[];
  /** Length of the polyline up to points[i]; `lengths[points.length]` closes a closed path. */
  lengths: number[];
  length: number;
  closed: boolean;
};

/** One drawn grapheme. */
export type PathGlyph = {
  text: string;
  /** Source offsets in `characters`, end exclusive. */
  start: number;
  end: number;
  lineIndex: number;
  run: GlyphRun;
  /** Its left edge on the unwrapped line and its advance (letter spacing excluded). */
  x: number;
  advance: number;
  /** The left end of its baseline in the layer's local space, and the baseline's direction (radians, clockwise on screen). */
  origin: Vec;
  angle: number;
};

/** Where line `i` goes: the distance along the path its straight x = 0 maps to, and how far its baseline stands off the path. */
export type PathLine = {start: number; shift: number};

export type TextPathLayout = {
  sampler: PathSampler | null;
  lines: PathLine[];
  glyphs: PathGlyph[];
  /** Local box of every glyph's ink box (line ascent to descent), null when nothing is drawn. */
  bounds: Rect | null;
};

const FLATTEN_TOLERANCE = 0.05;
const FLATTEN_ANGLE = Math.PI / 90;

const samplers = new WeakMap<TextPathData, PathSampler | null>();

/** The path the text runs along: the first subpath, read backwards for `side: 'RIGHT'`. */
export function textPathCommands(path: TextPathData): PathCommand[] {
  const first = subpaths(path.commands)[0] ?? [];
  return path.side === 'RIGHT' ? reversePath(first) : first;
}

/** Samples of the path (cached per path object). Null when it has no length. */
export function textPathSampler(path: TextPathData): PathSampler | null {
  if (samplers.has(path)) return samplers.get(path)!;
  const line = flattenPath(textPathCommands(path), FLATTEN_TOLERANCE, {maxAngle: FLATTEN_ANGLE})[0];
  let sampler: PathSampler | null = null;
  if (line && line.points.length > 1) {
    const points = line.points;
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    const last = points[points.length - 1];
    if (line.closed) lengths.push(lengths[points.length - 1] + Math.hypot(points[0].x - last.x, points[0].y - last.y));
    const length = lengths[lengths.length - 1];
    if (length > 1e-9) sampler = {points, lengths, length, closed: line.closed};
  }
  samplers.set(path, sampler);
  return sampler;
}

/** The point at distance `s` along the path and the direction there. A closed path wraps; an open one answers null
 *  past its ends (`clamp`: the end point instead). */
export function pointAlong(sampler: PathSampler, s: number, clamp = false): {point: Vec; tangent: Vec} | null {
  const {points, lengths, length, closed} = sampler;
  if (closed) s = ((s % length) + length) % length;
  else if (s < -1e-9 || s > length + 1e-9) {
    if (!clamp) return null;
    s = Math.max(0, Math.min(length, s));
  }
  const segments = closed ? points.length : points.length - 1;
  let lo = 0, hi = segments - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lengths[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const a = points[lo], b = points[lo + 1 === points.length ? 0 : lo + 1];
  const span = lengths[lo + 1] - lengths[lo];
  const t = span > 0 ? Math.max(0, Math.min(1, (s - lengths[lo]) / span)) : 0;
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  return {point: {x: a.x + dx * t, y: a.y + dy * t}, tangent: {x: dx / d, y: dy / d}};
}

/** The nearest point of the path to `p`: its distance along the path and how far `p` stands off it, positive on the
 *  side glyphs hang towards (below the baseline). */
export function projectOnPath(sampler: PathSampler, p: Vec): {s: number; offset: number; distance: number} {
  const {points, lengths, closed} = sampler;
  const segments = closed ? points.length : points.length - 1;
  let best = {s: 0, offset: 0, distance: Infinity};
  for (let i = 0; i < segments; i++) {
    const a = points[i], b = points[i + 1 === points.length ? 0 : i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const qx = a.x + dx * t, qy = a.y + dy * t;
    const distance = Math.hypot(p.x - qx, p.y - qy);
    if (distance < best.distance) {
      const len = Math.sqrt(len2) || 1;
      // The normal (−ty, tx) points to where a glyph's descent goes.
      best = {s: lengths[i] + t * len, offset: ((p.x - qx) * -dy + (p.y - qy) * dx) / len, distance};
    }
  }
  return best;
}

// ── Placement ──────────────────────────────────────────────────────────────────────────────────

const lineAscent = (line: TextLine) => line.ascent || line.height * 0.8;
const lineDescent = (line: TextLine) => line.descent || line.height * 0.2;

/** Where each line goes along and across the path. */
export function pathLines(node: Pick<SceneNode, 'text' | 'textPath'>, layout: TextLayout, sampler: PathSampler | null): PathLine[] {
  const text = node.text, path = node.textPath;
  if (!text || !path || !sampler || !layout.lines.length) return [];
  const lines = layout.lines;
  const first = lines[0], last = lines[lines.length - 1];
  const top = first.top, height = last.top + last.height - top;
  const anchor = Math.max(0, Math.min(1, path.startOffset)) * sampler.length;
  return lines.map(line => {
    const align = text.textAlignHorizontal;
    const start = anchor - (align === 'CENTER' ? line.width / 2 : align === 'RIGHT' ? line.width : 0) - line.x;
    const vertical = text.textAlignVertical;
    const shift = vertical === 'TOP' ? line.baseline - top : vertical === 'CENTER' ? line.baseline - top - height / 2 : line.baseline - last.baseline;
    return {start, shift};
  });
}

/** Where a point of line `lineIndex` at straight `x` lands: the baseline point there and the direction. Null past the
 *  ends of an open path (`clamp`: at the nearest end). */
export function placeOnPath(placement: TextPathLayout, lineIndex: number, x: number, clamp = false): {point: Vec; angle: number} | null {
  const sampler = placement.sampler, line = placement.lines[lineIndex];
  if (!sampler || !line) return null;
  const at = pointAlong(sampler, line.start + x, clamp);
  if (!at) return null;
  const {point, tangent} = at;
  return {point: {x: point.x - tangent.y * line.shift, y: point.y + tangent.x * line.shift}, angle: Math.atan2(tangent.y, tangent.x)};
}

const cache = new WeakMap<TextPathData, {layout: TextLayout; text: unknown; placement: TextPathLayout}>();

/** Every glyph of a text on a path, placed (cached on the path object and the layout). `layout` is the node's own
 *  (`layoutText(node, measurer)`, which lays a text on a path out unwrapped). */
export function textPathLayout(node: Pick<SceneNode, 'text' | 'textPath'>, layout: TextLayout): TextPathLayout {
  const path = node.textPath;
  if (!path) return {sampler: null, lines: [], glyphs: [], bounds: null};
  const hit = cache.get(path);
  if (hit && hit.layout === layout && hit.text === node.text) return hit.placement;
  const sampler = textPathSampler(path);
  const lines = pathLines(node, layout, sampler);
  const placement: TextPathLayout = {sampler, lines, glyphs: [], bounds: null};
  if (sampler) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    layout.lines.forEach((line, lineIndex) => {
      const ascent = lineAscent(line), descent = lineDescent(line);
      for (const run of line.runs) {
        if (!run.text || run.ellipsis) continue;
        for (const piece of piecesOf(run)) {
          const middle = placeOnPath(placement, lineIndex, piece.x + piece.advance / 2);
          if (!middle) continue;
          const cos = Math.cos(middle.angle), sin = Math.sin(middle.angle);
          const origin = {x: middle.point.x - cos * piece.advance / 2, y: middle.point.y - sin * piece.advance / 2};
          placement.glyphs.push({...piece, lineIndex, run, origin, angle: middle.angle});
          for (const [gx, gy] of [[0, -ascent], [piece.advance, -ascent], [piece.advance, descent], [0, descent]]) {
            const px = origin.x + cos * gx - sin * gy, py = origin.y + sin * gx + cos * gy;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
        }
      }
    });
    if (Number.isFinite(minX)) placement.bounds = {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
  }
  cache.set(path, {layout, text: node.text, placement});
  return placement;
}

/** The graphemes of a run with their straight x and advance. A run whose letters do not match its caret stops one to
 *  one (a text case that turns ß into SS) goes as one piece. */
function piecesOf(run: GlyphRun): {text: string; start: number; end: number; x: number; advance: number}[] {
  const stops = run.xs.length - 1;
  const bounds = graphemeBoundaries(run.text);
  if (bounds.length - 1 !== stops || stops < 1) {
    return [{text: run.text, start: run.start, end: run.end, x: run.x, advance: Math.max(0, run.width - run.letterSpacing)}];
  }
  const out = [];
  for (let i = 0; i < stops; i++) {
    const text = run.text.slice(bounds[i], bounds[i + 1]);
    out.push({text, start: run.offsets[i], end: run.offsets[i + 1], x: run.xs[i], advance: Math.max(0, run.xs[i + 1] - run.xs[i] - run.letterSpacing)});
  }
  return out;
}

// ── Editing and picking ────────────────────────────────────────────────────────────────────────

/** A local point (near the text) as a point of the unwrapped layout, for caret placement: the line whose band across
 *  the path is nearest, and the straight x of the nearest point of the path. Null without a path. */
export function straightPoint(placement: TextPathLayout, layout: TextLayout, local: Vec): {x: number; y: number; lineIndex: number} | null {
  const sampler = placement.sampler;
  if (!sampler || !layout.lines.length) return null;
  const projected = projectOnPath(sampler, local);
  let lineIndex = 0, nearest = Infinity;
  layout.lines.forEach((line, i) => {
    const shift = placement.lines[i]?.shift ?? 0;
    const top = shift - lineAscent(line), bottom = shift + lineDescent(line);
    const gap = projected.offset < top ? top - projected.offset : projected.offset > bottom ? projected.offset - bottom : 0;
    if (gap < nearest) {
      nearest = gap;
      lineIndex = i;
    }
  });
  const line = layout.lines[lineIndex];
  const start = placement.lines[lineIndex].start;
  let x = projected.s - start;
  if (sampler.closed) {
    // The turn of the loop nearest the line's own span.
    const middle = line.x + line.width / 2;
    x += Math.round((middle - x) / sampler.length) * sampler.length;
  }
  return {x, y: line.baseline, lineIndex};
}

/** The two ends of the caret (top and bottom, local space) of a text on a path: across the path where the caret's
 *  straight x lands on its line (clamped to the ends of an open path). */
export function caretOnPath(placement: TextPathLayout, caret: {x: number; top: number; height: number; baseline: number; lineIndex: number}): {top: Vec; bottom: Vec} | null {
  const at = placeOnPath(placement, Math.max(0, caret.lineIndex), caret.x, true);
  if (!at) return null;
  const nx = -Math.sin(at.angle), ny = Math.cos(at.angle);
  const up = caret.baseline - caret.top, down = caret.top + caret.height - caret.baseline;
  return {top: {x: at.point.x - nx * up, y: at.point.y - ny * up}, bottom: {x: at.point.x + nx * down, y: at.point.y + ny * down}};
}

/** Whether a local point is on the text: inside a glyph's box (grown by `tolerance`) or within `tolerance` of the path. */
export function hitsTextPath(placement: TextPathLayout, layout: TextLayout, local: Vec, tolerance: number): boolean {
  if (placement.sampler && projectOnPath(placement.sampler, local).distance <= tolerance) return true;
  for (const glyph of placement.glyphs) {
    const line = layout.lines[glyph.lineIndex];
    if (!line) continue;
    const dx = local.x - glyph.origin.x, dy = local.y - glyph.origin.y;
    const cos = Math.cos(glyph.angle), sin = Math.sin(glyph.angle);
    const gx = dx * cos + dy * sin, gy = -dx * sin + dy * cos;
    if (gx >= -tolerance && gx <= glyph.advance + tolerance && gy >= -lineAscent(line) - tolerance && gy <= lineDescent(line) + tolerance) return true;
  }
  return false;
}

/** The commands of a layer's outline (its path's first subpath), for a text that leaves its path: its box. */
export const textPathOutline = (path: TextPathData): PathCommand[] => subpaths(path.commands)[0] ?? [];
