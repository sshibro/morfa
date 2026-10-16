import type {DesignDocument, Matrix, NodeId, Paint, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, multiply, transformRect, worldMatrix} from '../../../../shared/design/geometry';
import {caretAt as caretBox, selectionRects, type Affinity, type TextLayout} from '../../../../shared/design/text-layout';
import {clipsChildren, renderBounds} from '../../../../shared/design/bounds';
import {caretOnPath, textPathLayout, type TextPathLayout} from '../../../../shared/design/text-path';
import {OVERLAY_COLORS} from '../overlay';
import {shapeOf} from '../render/geometry-cache';
import {affineOf, canvasPool, paintNodeTree, worldOfNode} from '../render/painter';
import type {Viewport} from '../contracts';
import type {TextEditorDeps} from './registry';

// The text being edited, drawn on the canvas overlay: the selection highlight under the glyphs,
// the glyphs themselves through the renderer's own painter (`paintNodeTree`, the path tiles,
// exports and thumbnails use, with the same cached layout, so nothing moves when editing starts),
// the IME draft's underline, the caret, and the box outline. The scene leaves the node out while it
// is edited (CanvasView's `hidden`), so this is the only place it is drawn: that is what lets a
// TRUNCATE text show all its lines while it is typed into, as Figma does.

export const SELECTION_FILL = 'rgba(13, 153, 255, 0.3)';

export type EditorPicture = {
  doc: DesignDocument;
  /** The node as stored and as drawn (TRUNCATE laid out as NONE). */
  node: SceneNode;
  display: SceneNode;
  layout: TextLayout;
  selection: {start: number; end: number};
  /** Where the caret blinks, or null while it is hidden (off phase, or a range is selected). */
  caret: {offset: number; affinity: Affinity} | null;
  composition: {start: number; end: number} | null;
  viewport: Viewport;
  deps: TextEditorDeps;
};

/** The document with `node` standing in for the stored one (a TRUNCATE text drawn untruncated),
 *  without copying the node table: lookups fall through to the real one. */
export function documentWith(doc: DesignDocument, node: SceneNode): DesignDocument {
  if (doc.nodes[node.id] === node) return doc;
  const nodes = Object.create(doc.nodes) as Record<NodeId, SceneNode>;
  nodes[node.id] = node;
  return {...doc, nodes};
}

const setMatrix = (ctx: CanvasRenderingContext2D, m: Matrix) => ctx.setTransform(m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]);

/** The caret's colour: the colour of the text at the caret, opaque, so it reads as part of the text. */
export function caretColor(fills: readonly Paint[]): string {
  const paint = fills.find(fill => fill.visible && fill.type === 'SOLID');
  if (!paint || paint.type !== 'SOLID') return '#000000';
  const {r, g, b} = paint.color;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** Draws the edited text and its editing marks. The context comes in with the overlay's CSS-px
 *  transform (device pixel ratio applied); it is restored on return. */
export function drawTextEditing(ctx: CanvasRenderingContext2D, picture: EditorPicture, caretFill: string): void {
  const {doc, node, display, layout, selection, viewport} = picture;
  const dpr = ctx.getTransform().a || 1;
  const screen = dpr * viewport.zoom;
  // Whole device pixels, as the scene places its tiles and live layer.
  const base: Matrix = [[screen, 0, Math.round(-viewport.x * screen)], [0, screen, Math.round(-viewport.y * screen)]];
  const world = worldMatrix(doc, node.id);
  const toDevice = multiply(base, world);
  if (display.textPath) return drawPathEditing(ctx, picture, caretFill, base, screen, toDevice, textPathLayout(display, layout));
  ctx.save();

  if (selection.end > selection.start) {
    setMatrix(ctx, toDevice);
    ctx.fillStyle = SELECTION_FILL;
    for (const rect of selectionRects(layout, selection.start, selection.end)) ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  paintEdited(ctx, documentWith(doc, display), display, base, screen, picture.deps);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const toScreen = (p: Vec) => apply(toDevice, p);
  // The text box, as the selection outline shows it (under the caret, which may stand on its edge).
  const corners = [{x: 0, y: 0}, {x: node.width, y: 0}, {x: node.width, y: node.height}, {x: 0, y: node.height}].map(toScreen);
  ctx.strokeStyle = OVERLAY_COLORS.accent;
  ctx.lineWidth = dpr;
  ctx.beginPath();
  const crisp = (v: number) => Math.round(v - dpr / 2) + dpr / 2;
  corners.forEach((p, i) => (i ? ctx.lineTo(crisp(p.x), crisp(p.y)) : ctx.moveTo(crisp(p.x), crisp(p.y))));
  ctx.closePath();
  ctx.stroke();
  if (picture.composition && picture.composition.end > picture.composition.start) {
    ctx.strokeStyle = caretFill;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    for (const rect of selectionRects(layout, picture.composition.start, picture.composition.end)) {
      const line = layout.lines[rect.lineIndex];
      const y = line ? line.baseline + line.descent * 0.6 : rect.y + rect.height;
      const a = toScreen({x: rect.x, y}), b = toScreen({x: rect.x + rect.width, y});
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  if (picture.caret) {
    const box = caretBox(layout, picture.caret.offset, picture.caret.affinity);
    // A caret of one device-independent pixel at any zoom, on the pixel grid when upright.
    let top = toScreen({x: box.x, y: box.top}), bottom = toScreen({x: box.x, y: box.top + box.height});
    if (Math.abs(top.x - bottom.x) < 0.01) {
      const x = Math.round(top.x - dpr / 2) + dpr / 2;
      top = {x, y: top.y};
      bottom = {x, y: bottom.y};
    }
    ctx.strokeStyle = caretFill;
    ctx.lineWidth = dpr;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.stroke();
  }

  ctx.restore();
}

/** The node in its place, under its ancestors' clips and opacity, painted as the scene's live layer
 *  paints a dragged node: into a pooled offscreen layer the size of what it covers, then copied
 *  onto the overlay. The same kind of canvas rasterizes the same glyphs, so the text does not
 *  shift by a hair when editing starts or ends. */
function paintEdited(ctx: CanvasRenderingContext2D, doc: DesignDocument, node: SceneNode, base: Matrix, scale: number, deps: TextEditorDeps) {
  let opacity = 1;
  const clips: SceneNode[] = [];
  for (let p = node.parentId ? doc.nodes[node.parentId] : undefined; p && p.type !== 'PAGE'; p = p.parentId ? doc.nodes[p.parentId] : undefined) {
    opacity *= p.opacity;
    if (clipsChildren(p)) clips.push(p);
  }
  const bounds = renderBounds(doc, node.id, {measurer: deps.fonts.measurer});
  if (!bounds) return;
  const device = transformRect(base, bounds);
  const x0 = Math.max(0, Math.floor(device.x) - 1), y0 = Math.max(0, Math.floor(device.y) - 1);
  const x1 = Math.min(ctx.canvas.width, Math.ceil(device.x + device.width) + 1), y1 = Math.min(ctx.canvas.height, Math.ceil(device.y + device.height) + 1);
  if (!(x1 > x0 && y1 > y0)) return;
  const width = x1 - x0, height = y1 - y0;
  const shifted: Matrix = [[base[0][0], base[0][1], base[0][2] - x0], [base[1][0], base[1][1], base[1][2] - y0]];
  const layer = canvasPool.acquire(width, height);
  const target = layer.ctx;
  target.save();
  for (const clip of clips) {
    const shape = shapeOf(clip);
    if (!shape) continue;
    const t = affineOf(shifted, worldOfNode(doc, clip));
    target.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
    target.clip(shape.parts[0].path, shape.parts[0].rule);
  }
  paintNodeTree({ctx: target, transform: shifted, scale}, doc, [node.id], {fonts: deps.fonts, images: deps.images, rootOpacity: opacity, clip: {x: 0, y: 0, width, height}});
  target.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer.canvas, 0, 0, width, height, x0, y0, width, height);
  ctx.restore();
  canvasPool.release(layer);
}

/** "Text on path" being edited: the selection on the glyphs it covers, the text, the path itself as the box's
 *  outline, the IME draft's underline under its glyphs and the caret across the path. */
function drawPathEditing(ctx: CanvasRenderingContext2D, picture: EditorPicture, caretFill: string, base: Matrix, screen: number, toDevice: Matrix, placed: TextPathLayout): void {
  const {doc, display, layout, selection} = picture;
  const dpr = ctx.getTransform().a || 1;
  const toScreen = (p: Vec) => apply(toDevice, p);
  const glyphQuad = (glyph: TextPathLayout['glyphs'][number], from: number, to: number): Vec[] => {
    const cos = Math.cos(glyph.angle), sin = Math.sin(glyph.angle);
    const at = (gx: number, gy: number) => toScreen({x: glyph.origin.x + cos * gx - sin * gy, y: glyph.origin.y + sin * gx + cos * gy});
    return [at(0, from), at(glyph.advance, from), at(glyph.advance, to), at(0, to)];
  };
  const fillQuads = (quads: Vec[][]) => {
    ctx.beginPath();
    for (const quad of quads) quad.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.fill();
  };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (selection.end > selection.start) {
    ctx.fillStyle = SELECTION_FILL;
    fillQuads(placed.glyphs.filter(g => g.start >= selection.start && g.end <= selection.end).map(g => {
      const line = layout.lines[g.lineIndex];
      return glyphQuad(g, -(line?.ascent ?? 0), line?.descent ?? 0);
    }));
  }
  paintEdited(ctx, documentWith(doc, display), display, base, screen, picture.deps);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // The path, where the box outline would be.
  const sampler = placed.sampler;
  if (sampler) {
    ctx.strokeStyle = OVERLAY_COLORS.accent;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    sampler.points.forEach((p, i) => {
      const q = toScreen(p);
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    });
    if (sampler.closed) ctx.closePath();
    ctx.stroke();
  }
  const composition = picture.composition;
  if (composition && composition.end > composition.start) {
    ctx.fillStyle = caretFill;
    fillQuads(placed.glyphs.filter(g => g.start >= composition.start && g.end <= composition.end).map(g => {
      const line = layout.lines[g.lineIndex];
      const y = (line?.descent ?? 0) * 0.6;
      return glyphQuad(g, y, y + Math.max(1, dpr) / Math.max(screen, 1e-6));
    }));
  }
  if (picture.caret) {
    const box = caretBox(layout, picture.caret.offset, picture.caret.affinity);
    const ends = caretOnPath(placed, box);
    if (ends) {
      const top = toScreen(ends.top), bottom = toScreen(ends.bottom);
      ctx.strokeStyle = caretFill;
      ctx.lineWidth = dpr;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bottom.x, bottom.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}
