import type {DesignDocument, NodeId, Paint} from '../../../../../shared/design/types';
import type {Rect} from '../../../../../shared/design/geometry';
import type {RenderWasmDoc} from '../../../../../shared/design/render-engine';
import type {FontRegistry, ImageCache} from '../../contracts';
import {blendOperation, isNormalBlend} from '../blend';
import type {Ctx2D} from '../canvas';
import {context2d, createCanvas} from '../canvas';
import {checkerStyle, paintStyle, paintVisible} from '../paints';
import type {PaintContext} from '../paints';
import {CANVAS_CAPS, CANVAS_JOINS} from '../stroke-math';
import {drawText, textLayoutOf, textRegion} from '../text-draw';
import {GREEK_BELOW_PX} from '../text-math';

// Text for the GPU renderer: text drawing is lane L3's (glyph outlines or the browser's `fillText`,
// src/design/engine/render/text-draw.ts), so a text node is painted here, by Canvas2D at the tile's scale, into a
// sprite the renderer draws as a picture at the node's transform — the same pixels the Canvas2D tiles show. The
// sprite holds the text's body (fills, decorations, strokes); the node's effects, opacity and blend are the
// renderer's, which casts the shadows from the sprite's alpha. Sprites are kept by the renderer per scale and
// dropped when the node changes or a face loads (`revision`).

const MAX_SPRITE_SIDE = 4096;

// The canvases sprites are painted on, one per exact size, reused: a pan brings tiles of hundreds of texts, and making a
// canvas and a read-back context for each was most of a sprite's cost. A reused one is reset first (`reset()`: no
// pixels, the state of a new context) and keeps its size, so a sprite comes out as on a new canvas of that size.
const SPRITE_CANVASES_MAX = 64;
const spriteCanvases = new Map<string, {canvas: ReturnType<typeof createCanvas>; ctx: Ctx2D}>();

function spriteCanvas(width: number, height: number): {canvas: ReturnType<typeof createCanvas>; ctx: Ctx2D} {
  const key = `${width}x${height}`;
  const kept = spriteCanvases.get(key);
  if (kept && typeof (kept.ctx as {reset?: () => void}).reset === 'function') {
    spriteCanvases.delete(key);
    spriteCanvases.set(key, kept);
    (kept.ctx as unknown as {reset(): void}).reset();
    return kept;
  }
  const canvas = createCanvas(width, height);
  const made = {canvas, ctx: context2d(canvas, {willReadFrequently: true})};
  if (width * height <= 512 * 512) {
    spriteCanvases.set(key, made);
    for (const old of spriteCanvases.keys()) {
      if (spriteCanvases.size <= SPRITE_CANVASES_MAX) break;
      spriteCanvases.delete(old);
    }
  }
  return made;
}

/** Paints the sprites the renderer asks for (`sprites_needed`) at `scale` into `doc`. */
export function paintSprites(doc: RenderWasmDoc, document: DesignDocument, ids: readonly NodeId[], scale: number, revision: number, fonts: FontRegistry, images: ImageCache): number {
  let painted = 0;
  for (const id of ids) {
    const node = document.nodes[id];
    if (!node || node.type !== 'TEXT' || !node.text) continue;
    const layout = textLayoutOf(node, fonts);
    const region = textRegion(node, layout);
    const sprite = paintSprite(document, node, layout, region, scale, fonts, images);
    if (!sprite) continue;
    doc.set_text_sprite(id, scale, region.x, region.y, region.width, region.height, sprite.width, sprite.height, revision, sprite.rgba);
    painted++;
  }
  return painted;
}

/** One text's sprite (exported for scripts/bench/gpu-path's check that a reused canvas paints as a new one: `fresh`). */
export function paintSprite(document: DesignDocument, node: DesignDocument['nodes'][string], layout: ReturnType<typeof textLayoutOf>, region: Rect, scale: number, fonts: FontRegistry, images: ImageCache, fresh = false): {width: number; height: number; rgba: Uint8Array} | null {
  if (!layout.lines.length) return null;
  let width = Math.ceil(region.width * scale), height = Math.ceil(region.height * scale);
  if (!(width > 0 && height > 0)) return null;
  // A text larger than the biggest sprite is painted at a coarser scale and resampled.
  let s = scale;
  if (width > MAX_SPRITE_SIDE || height > MAX_SPRITE_SIDE) {
    s = scale * Math.min(MAX_SPRITE_SIDE / width, MAX_SPRITE_SIDE / height);
    width = Math.ceil(region.width * s);
    height = Math.ceil(region.height * s);
  }
  const {ctx} = fresh ? {ctx: context2d(createCanvas(width, height), {willReadFrequently: true})} : spriteCanvas(width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if ('textRendering' in ctx) (ctx as CanvasRenderingContext2D).textRendering = 'geometricPrecision';
  const pc: PaintContext = {doc: document, images, scale: s, width: node.width, height: node.height, region};
  const callbacks = {
    style(target: Ctx2D, paint: Paint, stroke: boolean): boolean {
      const style = paintStyle(target, paint, pc) ?? (paint.type === 'IMAGE' ? checkerStyle(target, pc.scale) : null);
      if (!style) return false;
      if (stroke) target.strokeStyle = style;
      else target.fillStyle = style;
      target.globalAlpha = paint.opacity;
      target.globalCompositeOperation = isNormalBlend(paint.blendMode) ? 'source-over' : blendOperation(paint.blendMode);
      return true;
    },
  };
  const options = {fonts, scale: s, greekBelow: GREEK_BELOW_PX, mode: 'fill' as const};
  ctx.setTransform(s, 0, 0, s, -region.x * s, -region.y * s);
  drawText(ctx, node, layout, options, callbacks);
  const strokes = node.strokeWeight > 0 ? node.strokes.filter(paintVisible) : [];
  if (strokes.length) {
    const weight = node.strokeWeight;
    const setStroke = (target: Ctx2D, lineWidth: number) => {
      target.lineWidth = lineWidth;
      target.lineCap = CANVAS_CAPS[node.strokeCap] ?? 'butt';
      target.lineJoin = CANVAS_JOINS[node.strokeJoin] ?? 'miter';
      target.miterLimit = node.strokeMiterLimit > 0 ? node.strokeMiterLimit : 4;
      target.setLineDash(node.dashPattern.length ? node.dashPattern : []);
    };
    if (node.strokeAlign === 'CENTER') {
      setStroke(ctx, weight);
      drawText(ctx, node, layout, {...options, mode: 'stroke', strokes}, callbacks);
    } else {
      // Inside/outside: stroke twice the weight in a layer, keep the half inside (or outside) the glyphs.
      const layer = createCanvas(width, height);
      const lctx = context2d(layer);
      lctx.setTransform(s, 0, 0, s, -region.x * s, -region.y * s);
      setStroke(lctx, weight * 2);
      drawText(lctx, node, layout, {...options, mode: 'stroke', strokes}, callbacks);
      lctx.globalAlpha = 1;
      lctx.globalCompositeOperation = node.strokeAlign === 'INSIDE' ? 'destination-in' : 'destination-out';
      lctx.fillStyle = '#000';
      drawText(lctx, node, layout, {...options, mode: 'mask'}, callbacks);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(layer, 0, 0);
    }
  }
  const data = ctx.getImageData(0, 0, width, height).data;
  return {width, height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)};
}
