import type {DesignDocument, GradientPaint, ImagePaint, Matrix, Paint, SolidPaint} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import {invert, multiply} from '../../../../shared/design/geometry';
import type {ImageCache} from '../contracts';
import {isDesignImageCache} from '../images';
import {cssColor} from './blend';
import {conicStartAngle, gradientFrame, gradientParameter, colorAt, isSimilarity, keepsOrientation, linearGradientPoints, normalizedStops} from './gradient-math';
import {drawnScale, imagePlacement} from './image-math';
import type {AnyCanvas, Ctx2D} from './canvas';
import {context2d, createCanvas} from './canvas';

// Every paint becomes one canvas fill style in the node's local space: a colour, a native gradient,
// or a pattern whose transform maps it into the box. Fills, strokes, glyphs and markers then all
// paint the same way (`ctx.fillStyle = style; ctx.fill(path)`), whatever the paint is.
//
// Linear gradients are always native (their handles reduce to two points). Radial and angular
// ones are native when the box keeps circles round; otherwise, and for diamond gradients, the
// gradient is rendered once into a "shader" canvas over the node's paint region and used as a
// pattern, cached per paint and resolution so panning never re-renders it.

export type PaintStyle = string | CanvasGradient | CanvasPattern;

export type PaintContext = {
  doc: DesignDocument;
  images: ImageCache;
  /** Device px per local px. */
  scale: number;
  /** Local-space region the style must cover (box plus strokes, overflowing text). */
  region: Rect;
  width: number;
  height: number;
  /** Told about every picture drawn, and whether it was ready (else a placeholder was drawn). */
  onImage?: (ref: string, ready: boolean) => void;
};

const solidStyles = new WeakMap<SolidPaint, string>();

function solidStyle(paint: SolidPaint): string {
  let style = solidStyles.get(paint);
  if (!style) solidStyles.set(paint, (style = cssColor(paint.color)));
  return style;
}

function addStops(gradient: CanvasGradient, paint: GradientPaint): CanvasGradient {
  const stops = normalizedStops(paint.gradientStops);
  if (!stops.length) gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  for (const stop of stops) gradient.addColorStop(stop.position, cssColor(stop.color));
  return gradient;
}

const hasConic = (ctx: Ctx2D) => typeof (ctx as CanvasRenderingContext2D).createConicGradient === 'function';

/** Native gradient in local space, or null when it needs a shader. */
function nativeGradient(ctx: Ctx2D, paint: GradientPaint, width: number, height: number): CanvasGradient | null {
  if (paint.type === 'GRADIENT_LINEAR') {
    const p = linearGradientPoints(paint.gradientHandlePositions, width, height);
    return addStops(ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1), paint);
  }
  if (paint.type === 'GRADIENT_DIAMOND') return null;
  const frame = gradientFrame(paint.gradientHandlePositions, width, height);
  if (!isSimilarity(frame)) return null;
  const {origin} = frame;
  if (paint.type === 'GRADIENT_RADIAL') {
    return addStops(ctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, Math.hypot(frame.a.x, frame.a.y)), paint);
  }
  if (!keepsOrientation(frame) || !hasConic(ctx)) return null;
  return addStops((ctx as CanvasRenderingContext2D).createConicGradient(conicStartAngle(frame), origin.x, origin.y), paint);
}

type Shader = {key: string; pattern: CanvasPattern; canvas: AnyCanvas};
const shaders = new WeakMap<GradientPaint, Shader>();
const SHADER_MAX = 1024;

/** Resolution bucket: a power of two at or above the scale, capped so the shader stays small.
 *  Gradients are smooth, so a shader drawn at a lower resolution and scaled up looks the same. */
function shaderResolution(scale: number, region: Rect): number {
  const bucket = Math.pow(2, Math.ceil(Math.log2(Math.max(scale, 1 / 64))));
  return Math.min(bucket, SHADER_MAX / Math.max(region.width, region.height, 1));
}

function renderShader(paint: GradientPaint, width: number, height: number, region: Rect, resolution: number): {canvas: AnyCanvas; transform: Matrix} {
  const cw = Math.max(2, Math.ceil(region.width * resolution)), ch = Math.max(2, Math.ceil(region.height * resolution));
  const canvas = createCanvas(cw, ch);
  const ctx = context2d(canvas);
  const frame = gradientFrame(paint.gradientHandlePositions, width, height);
  // Shader pixels ← local ← gradient space.
  const toPixels: Matrix = [[resolution, 0, -region.x * resolution], [0, resolution, -region.y * resolution]];
  const m = multiply(toPixels, frame.matrix);
  const det = m[0][0] * m[1][1] - m[1][0] * m[0][1];
  const stops = normalizedStops(paint.gradientStops);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    // A collapsed frame: Figma shows the last stop.
    const last = stops[stops.length - 1];
    ctx.fillStyle = last ? cssColor(last.color) : 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, cw, ch);
  } else {
    ctx.setTransform(m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]);
    // The shader canvas's corners in gradient space bound what must be filled.
    const inv = invert(m);
    const corners = [[0, 0], [cw, 0], [cw, ch], [0, ch]].map(([x, y]) => ({x: inv[0][0] * x + inv[0][1] * y + inv[0][2], y: inv[1][0] * x + inv[1][1] * y + inv[1][2]}));
    const minX = Math.min(...corners.map(p => p.x)) - 1, maxX = Math.max(...corners.map(p => p.x)) + 1;
    const minY = Math.min(...corners.map(p => p.y)) - 1, maxY = Math.max(...corners.map(p => p.y)) + 1;
    const fill = (style: PaintStyle) => {
      ctx.fillStyle = style;
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    };
    if (paint.type === 'GRADIENT_RADIAL') fill(addStops(ctx.createRadialGradient(0, 0, 0, 0, 0, 1), paint));
    else if (paint.type === 'GRADIENT_LINEAR') fill(addStops(ctx.createLinearGradient(0, 0, 1, 0), paint));
    else if (paint.type === 'GRADIENT_ANGULAR' && hasConic(ctx)) fill(addStops((ctx as CanvasRenderingContext2D).createConicGradient(0, 0, 0), paint));
    else if (paint.type === 'GRADIENT_DIAMOND') {
      // |u| + |v|: one linear gradient per quadrant. The first fills everything; the others replace
      // their quadrant with 'copy' inside a clip, so the anti-aliased seams blend equal colours and
      // never show a line.
      const quadrants: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
      quadrants.forEach(([sx, sy], i) => {
        const gradient = addStops(ctx.createLinearGradient(0, 0, sx * 0.5, sy * 0.5), paint);
        if (i === 0) return fill(gradient);
        ctx.save();
        ctx.beginPath();
        const big = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY)) + 1;
        ctx.rect(sx > 0 ? 0 : -big, sy > 0 ? 0 : -big, big, big);
        ctx.clip();
        ctx.globalCompositeOperation = 'copy';
        fill(gradient);
        ctx.restore();
      });
    } else {
      // Angular without createConicGradient (old Safari): per pixel.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const image = ctx.createImageData(cw, ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const u = inv[0][0] * (x + 0.5) + inv[0][1] * (y + 0.5) + inv[0][2], v = inv[1][0] * (x + 0.5) + inv[1][1] * (y + 0.5) + inv[1][2];
          const c = colorAt(stops, gradientParameter(paint.type, u, v));
          const i = (y * cw + x) * 4;
          image.data[i] = c.r * 255; image.data[i + 1] = c.g * 255; image.data[i + 2] = c.b * 255; image.data[i + 3] = c.a * 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    }
  }
  // Pattern pixels → local space.
  return {canvas, transform: [[1 / resolution, 0, region.x], [0, 1 / resolution, region.y]]};
}

const toDOMMatrix = (m: Matrix) => new DOMMatrix([m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]]);

function shaderStyle(ctx: Ctx2D, paint: GradientPaint, pc: PaintContext): PaintStyle | null {
  const resolution = shaderResolution(pc.scale, pc.region);
  const key = `${pc.width},${pc.height},${pc.region.x},${pc.region.y},${pc.region.width},${pc.region.height},${resolution}`;
  const cached = shaders.get(paint);
  if (cached?.key === key) return cached.pattern;
  const {canvas, transform} = renderShader(paint, pc.width, pc.height, pc.region, resolution);
  const pattern = ctx.createPattern(canvas, 'no-repeat');
  if (!pattern) return null;
  pattern.setTransform(toDOMMatrix(transform));
  shaders.set(paint, {key, pattern, canvas});
  return pattern;
}

type ImageStyle = {key: string; source: CanvasImageSource; pattern: CanvasPattern};
const imageStyles = new WeakMap<ImagePaint, ImageStyle>();

function imageStyle(ctx: Ctx2D, paint: ImagePaint, pc: PaintContext): PaintStyle | null {
  if (!paint.imageRef) return null;
  const natural = pc.images.size(paint.imageRef, pc.doc);
  let source: CanvasImageSource | null, factor = 1, iw: number, ih: number;
  if (isDesignImageCache(pc.images)) {
    const size = natural ?? {width: 1, height: 1};
    const placement = imagePlacement(paint, pc.width, pc.height, size.width, size.height);
    const found = pc.images.source(paint.imageRef, pc.doc, drawnScale(placement, pc.scale), paint.filters);
    // An interim level is drawn, and drawn again once the full-size picture is back.
    pc.onImage?.(paint.imageRef, !!found && !found.interim);
    if (!found) return null;
    source = found.source;
    factor = found.factor;
    iw = found.width * factor;
    ih = found.height * factor;
  } else {
    source = pc.images.get(paint.imageRef, pc.doc);
    pc.onImage?.(paint.imageRef, !!source);
    if (!source) return null;
    iw = natural?.width ?? (source as {width: number}).width;
    ih = natural?.height ?? (source as {height: number}).height;
  }
  const placement = imagePlacement(paint, pc.width, pc.height, iw, ih);
  const key = `${pc.width},${pc.height},${factor}`;
  const cached = imageStyles.get(paint);
  if (cached && cached.key === key && cached.source === source) return cached.pattern;
  const pattern = ctx.createPattern(source, placement.repeat ? 'repeat' : 'no-repeat');
  if (!pattern) return null;
  pattern.setTransform(toDOMMatrix(multiply(placement.matrix, [[factor, 0, 0], [0, factor, 0]])));
  imageStyles.set(paint, {key, source, pattern});
  return pattern;
}

/** The fill style of one paint in local space, or null when it cannot draw yet (a picture still
 *  loading: draw `checkerStyle` instead) or never (an empty upload). */
export function paintStyle(ctx: Ctx2D, paint: Paint, pc: PaintContext): PaintStyle | null {
  switch (paint.type) {
    case 'SOLID': return solidStyle(paint);
    case 'IMAGE': return imageStyle(ctx, paint, pc);
    default: return nativeGradient(ctx, paint, pc.width, pc.height) ?? shaderStyle(ctx, paint, pc);
  }
}

/** True when the paint draws something at all. */
export const paintVisible = (paint: Paint) => paint.visible !== false && paint.opacity > 0;

let checker: {canvas: AnyCanvas; pattern: CanvasPattern | null} | null = null;
/** The grey checkerboard shown where a picture is still loading or could not be read; its squares
 *  keep about 8 screen px whatever the zoom. */
export function checkerStyle(ctx: Ctx2D, scale: number): PaintStyle {
  if (!checker) {
    const canvas = createCanvas(16, 16);
    const c = context2d(canvas);
    c.fillStyle = '#E6E6E6';
    c.fillRect(0, 0, 16, 16);
    c.fillStyle = '#F5F5F5';
    c.fillRect(0, 0, 8, 8);
    c.fillRect(8, 8, 8, 8);
    checker = {canvas, pattern: null};
  }
  const pattern = ctx.createPattern(checker.canvas, 'repeat');
  if (!pattern) return '#EEEEEE';
  const cell = 1 / Math.max(scale, 1e-6);
  pattern.setTransform(new DOMMatrix([cell, 0, 0, cell, 0, 0]));
  return pattern;
}
