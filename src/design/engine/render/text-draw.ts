import type {Paint, SceneNode} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import type {FontSpec, GlyphRun, TextLayout} from '../../../../shared/design/text-layout';
import {layoutText} from '../../../../shared/design/text-layout';
import {strokeOutsets, textLayoutBounds, unionRect} from '../../../../shared/design/bounds';
import {textPathLayout} from '../../../../shared/design/text-path';
import type {FontRegistry} from '../contracts';
import type {Ctx2D} from './canvas';
import {context2d, createCanvas} from './canvas';
import {decorationRect, graphemes, greekBar} from './text-math';
import {drawOutlines, outlinesAvailable, shapedText} from './text-glyphs';

// Drawing laid-out text (shared/design/text-layout.ts). The layout decides every glyph's place;
// this only sets the font and letter spacing of each run and paints it. Layouts are cached by the
// layout module on the identity of `node.text` and the measurer's revision, which the font
// registry bumps when a face arrives.

export const textLayoutOf = (node: SceneNode, fonts: FontRegistry): TextLayout => layoutText(node, fonts.measurer);

/** Local region text paints cover (box, overflowing lines and the stroke), for gradient shaders. */
export function textRegion(node: SceneNode, layout: TextLayout): Rect {
  let rect: Rect = {x: 0, y: 0, width: Math.max(node.width, 0), height: Math.max(node.height, 0)};
  const lines = node.textPath ? textPathLayout(node, layout).bounds : textLayoutBounds(layout);
  if (lines) rect = unionRect(rect, lines);
  const out = strokeOutsets(node);
  return {x: rect.x - out.left, y: rect.y - out.top, width: rect.width + out.left + out.right, height: rect.height + out.top + out.bottom};
}

const cssFonts = new WeakMap<FontSpec, string>();
function cssFontOf(font: FontSpec, fonts: FontRegistry): string {
  let css = cssFonts.get(font);
  if (css === undefined) cssFonts.set(font, (css = fonts.cssFont(font)));
  return css;
}

const nativeSpacing = (ctx: Ctx2D) => 'letterSpacing' in ctx;

/** Draws a run with its letter spacing: natively where canvas supports it, otherwise one grapheme at
 *  a time at the positions the layout measured (`xs`). */
function drawRun(ctx: Ctx2D, run: GlyphRun, baseline: number, mode: 'fill' | 'stroke'): void {
  // The engine's outlines (lane L3): the glyphs the layout measured, as Path2D; characters no loaded face
  // covers (emoji, other scripts) keep Canvas2D, whose fallback fonts draw them.
  if (outlinesAvailable()) {
    const shaped = shapedText(run.text, run.font);
    if (shaped && !shaped.missing) {
      drawOutlines(ctx, shaped, run.font, run.x, baseline, run.letterSpacing, mode);
      return;
    }
  }
  if (!run.letterSpacing || nativeSpacing(ctx)) {
    if (mode === 'fill') ctx.fillText(run.text, run.x, baseline);
    else ctx.strokeText(run.text, run.x, baseline);
    return;
  }
  const parts = graphemes(run.text);
  const aligned = parts.length === run.xs.length - 1;
  let x = run.x;
  for (let i = 0; i < parts.length; i++) {
    const at = aligned ? run.xs[i] : x;
    if (mode === 'fill') ctx.fillText(parts[i], at, baseline);
    else ctx.strokeText(parts[i], at, baseline);
    if (!aligned) x += ctx.measureText(parts[i]).width + run.letterSpacing;
  }
}

export type TextPaintCallbacks = {
  /** Sets fillStyle/strokeStyle, globalAlpha and the composite operation for one paint; false skips it. */
  style(ctx: Ctx2D, paint: Paint, stroke: boolean): boolean;
};

export type DrawTextOptions = {
  fonts: FontRegistry;
  /** Device px per local px. */
  scale: number;
  /** Draw runs smaller than this many device px as bars. */
  greekBelow: number;
  /** 'fill': glyph fills and decorations. 'stroke': glyph outlines with the stroke paints at the
   *  context's current line width. 'mask': opaque glyphs (silhouettes for strokes and shadows). */
  mode: 'fill' | 'stroke' | 'mask';
  strokes?: readonly Paint[];
  onFont?: (family: string) => void;
};

/** Draws a laid-out text node in its local space (the context's transform must already be set). */
export function drawText(ctx: Ctx2D, node: SceneNode, layout: TextLayout, options: DrawTextOptions, paint: TextPaintCallbacks): void {
  if (node.textPath) return drawTextOnPath(ctx, node, layout, options, paint);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let lastFont = '', lastSpacing = 0;
  const setFont = (font: FontSpec, family: string) => {
    options.onFont?.(family);
    if (!options.fonts.isLoaded(font)) void options.fonts.ensure(font);
    const css = cssFontOf(font, options.fonts);
    if (css !== lastFont) ctx.font = lastFont = css;
  };
  const setSpacing = (spacing: number) => {
    if (spacing !== lastSpacing && nativeSpacing(ctx)) {
      (ctx as CanvasRenderingContext2D).letterSpacing = `${spacing}px`;
      lastSpacing = spacing;
    }
  };
  for (const line of layout.lines) {
    for (const run of line.runs) {
      const size = run.font.size;
      const fills = run.fills ?? node.fills;
      if (size * options.scale < options.greekBelow) {
        if (options.mode === 'stroke' || !run.text.trim()) continue;
        const bar = greekBar(run, line.baseline, size);
        for (const fill of fills) {
          if (options.mode === 'fill' && !paint.style(ctx, fill, false)) continue;
          // Soft: a bar is a hint of text, not a block of ink.
          if (options.mode === 'fill') ctx.globalAlpha *= 0.45;
          ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
          if (options.mode === 'mask') break;
        }
        continue;
      }
      const decoration = options.mode !== 'stroke' && run.style.textDecoration && run.style.textDecoration !== 'NONE' && !run.ellipsis
        ? decorationRect(run.style.textDecoration, run, line, size)
        : null;
      if (!run.text && !decoration) continue;
      if (run.text) {
        setFont(run.font, run.style.fontFamily);
        setSpacing(run.letterSpacing);
      }
      if (options.mode === 'stroke') {
        for (const stroke of options.strokes ?? []) if (paint.style(ctx, stroke, true)) drawRun(ctx, run, line.baseline, 'stroke');
        continue;
      }
      for (const fill of fills) {
        if (options.mode === 'fill' && !paint.style(ctx, fill, false)) continue;
        if (run.text) drawRun(ctx, run, line.baseline, 'fill');
        if (decoration) ctx.fillRect(decoration.x, decoration.y, decoration.width, decoration.height);
        if (options.mode === 'mask') break;
      }
    }
    const marker = line.marker;
    if (marker && options.mode !== 'stroke' && marker.font.size * options.scale >= options.greekBelow) {
      setFont(marker.font, marker.style.fontFamily);
      setSpacing(0);
      const shapedMarker = outlinesAvailable() ? shapedText(marker.text, marker.font) : null;
      for (const fill of marker.fills ?? node.fills) {
        if (options.mode === 'fill' && !paint.style(ctx, fill, false)) continue;
        if (shapedMarker && !shapedMarker.missing) drawOutlines(ctx, shapedMarker, marker.font, marker.x, line.baseline, 0, 'fill');
        else ctx.fillText(marker.text, marker.x, line.baseline);
        if (options.mode === 'mask') break;
      }
    }
  }
  if (lastSpacing) setSpacing(0);
}

// ── Text on a path ─────────────────────────────────────────────────────────────────────────────

type Transform = {a: number; b: number; c: number; d: number; e: number; f: number};

/** "Text on path": each grapheme drawn where shared/design/text-path.ts places it, turned with the path. A solid paint
 *  draws straight onto the context; a gradient or a picture is a style in the layer's own space, so the glyphs are drawn
 *  as a mask on a layer the paint then fills (the paint stays where the box puts it, not turned with each glyph). */
function drawTextOnPath(ctx: Ctx2D, node: SceneNode, layout: TextLayout, options: DrawTextOptions, paint: TextPaintCallbacks): void {
  const placed = textPathLayout(node, layout);
  if (!placed.glyphs.length) return;
  const base = ctx.getTransform();
  const t: Transform = {a: base.a, b: base.b, c: base.c, d: base.d, e: base.e, f: base.f};
  if (options.mode === 'mask') {
    glyphPass(ctx, layout, placed.glyphs, t, options, null);
  } else {
    const paints = options.mode === 'stroke' ? options.strokes ?? [] : null;
    // Per glyph run, the paints it is drawn in (its own fills or the node's); every distinct list draws in one pass.
    const lists = new Set(paints ? [paints] : placed.glyphs.map(glyph => glyph.run.fills ?? node.fills));
    for (const list of lists) {
      const glyphs = paints ? placed.glyphs : placed.glyphs.filter(glyph => (glyph.run.fills ?? node.fills) === list);
      for (const each of list) {
        if (each.type === 'SOLID') {
          if (paint.style(ctx, each, options.mode === 'stroke')) glyphPass(ctx, layout, glyphs, t, options, options.mode);
          continue;
        }
        paintedPass(ctx, node, layout, glyphs, t, options, paint, each, placed.bounds);
      }
    }
  }
  ctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f);
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = '0px';
}

type PlacedGlyph = ReturnType<typeof textPathLayout>['glyphs'][number];

/** Draws `glyphs` with the context's current fill or stroke style (`draw` null: as an opaque mask). */
function glyphPass(ctx: Ctx2D, layout: TextLayout, glyphs: readonly PlacedGlyph[], t: Transform, options: DrawTextOptions, draw: 'fill' | 'stroke' | null): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = '0px';
  let lastFont = '';
  for (const glyph of glyphs) {
    const run = glyph.run, size = run.font.size;
    const cos = Math.cos(glyph.angle), sin = Math.sin(glyph.angle);
    const ox = glyph.origin.x, oy = glyph.origin.y;
    ctx.setTransform(t.a * cos + t.c * sin, t.b * cos + t.d * sin, -t.a * sin + t.c * cos, -t.b * sin + t.d * cos, t.a * ox + t.c * oy + t.e, t.b * ox + t.d * oy + t.f);
    if (size * options.scale < options.greekBelow) {
      if (draw === 'stroke' || !glyph.text.trim()) continue;
      const bar = greekBar({x: 0, width: glyph.advance}, 0, size);
      // Soft, as straight text's bars: a hint of text, not a block of ink.
      const alpha = ctx.globalAlpha;
      if (draw === 'fill') ctx.globalAlpha = alpha * 0.45;
      ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      ctx.globalAlpha = alpha;
      continue;
    }
    options.onFont?.(run.style.fontFamily);
    if (!options.fonts.isLoaded(run.font)) void options.fonts.ensure(run.font);
    const css = cssFontOf(run.font, options.fonts);
    if (css !== lastFont) ctx.font = lastFont = css;
    const shaped = outlinesAvailable() ? shapedText(glyph.text, run.font) : null;
    if (shaped && !shaped.missing) drawOutlines(ctx, shaped, run.font, 0, 0, 0, draw === 'stroke' ? 'stroke' : 'fill');
    else if (draw === 'stroke') ctx.strokeText(glyph.text, 0, 0);
    else ctx.fillText(glyph.text, 0, 0);
    if (draw !== 'stroke' && run.style.textDecoration && run.style.textDecoration !== 'NONE') {
      const line = layout.lines[glyph.lineIndex];
      const rect = line ? decorationRect(run.style.textDecoration, {x: 0, width: glyph.advance + run.letterSpacing}, {baseline: 0, ascent: line.ascent, descent: line.descent}, size) : null;
      if (rect) ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
  }
}

/** One gradient or picture paint over `glyphs`: the glyphs as a mask on a layer the size of what they cover on the
 *  device, the paint filled into it in the layer's space, the layer composited with the paint's opacity and blend. */
function paintedPass(ctx: Ctx2D, node: SceneNode, layout: TextLayout, glyphs: readonly PlacedGlyph[], t: Transform, options: DrawTextOptions, paint: TextPaintCallbacks, each: Paint, bounds: Rect | null): void {
  if (!bounds) return;
  const pad = Math.max(2, node.strokeWeight * 2);
  const local = {x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad};
  const corners = [[local.x, local.y], [local.x + local.width, local.y], [local.x, local.y + local.height], [local.x + local.width, local.y + local.height]]
    .map(([x, y]) => ({x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f}));
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x)))), y0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(...corners.map(p => p.x)))), y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(...corners.map(p => p.y))));
  if (!(x1 > x0 && y1 > y0)) return;
  const layer = context2d(createCanvas(x1 - x0, y1 - y0));
  const shifted: Transform = {...t, e: t.e - x0, f: t.f - y0};
  layer.fillStyle = layer.strokeStyle = '#000';
  layer.lineWidth = ctx.lineWidth;
  layer.lineJoin = ctx.lineJoin;
  layer.miterLimit = ctx.miterLimit;
  glyphPass(layer, layout, glyphs, shifted, options, options.mode === 'stroke' ? 'stroke' : 'fill');
  layer.setTransform(shifted.a, shifted.b, shifted.c, shifted.d, shifted.e, shifted.f);
  if (!paint.style(layer, each, false)) return;
  layer.globalAlpha = 1;
  layer.globalCompositeOperation = 'source-in';
  layer.fillRect(local.x, local.y, local.width, local.height);
  // The paint's opacity and blend apply when the layer lands.
  if (!paint.style(ctx, each, false)) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer.canvas, x0, y0);
}
