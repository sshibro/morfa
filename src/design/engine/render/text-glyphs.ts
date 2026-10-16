import type {FontSpec} from '../../../../shared/design/text-layout';
import {codeUnits, textFonts, textGlyphMode, type TextFontsWasm} from '../../../../shared/design/text-engine';
import {createCanvas} from './canvas';
import type {Ctx2D} from './canvas';

// Glyph drawing from the text engine: a run's text shaped by crates/text
// into glyph ids and positions, each glyph's outline fetched once and kept as a Path2D in em units, drawn
// with the context's transform scaled by the font size. Shaping and drawing share one engine, so what the
// layout measured is what lands on the canvas. Skia flattens a Path2D after the
// transform, so one path per glyph serves every size and zoom (no size buckets needed).

/** A shaped text: `glyphs` holds `count` records of (face, glyph, x, y, cluster) in px, y up. */
export type ShapedText = {missing: boolean; advance: number; count: number; glyphs: Float64Array; key: string};

const shapeCache = new Map<string, ShapedText | null>();
const pathCache = new Map<string, Path2D | null>();
const MAX_SHAPES = 20_000;
const MAX_PATHS = 50_000;
const RECORD = 5;

/** Outline drawing needs the engine, the mode and a browser with Path2D. */
export const outlinesAvailable = (): boolean => textGlyphMode() === 'outline' && typeof Path2D !== 'undefined' && textFonts() !== null;

/** Shapes `text` in `font`; null when the engine holds no face of the family (Canvas2D draws it). */
export function shapedText(text: string, font: FontSpec): ShapedText | null {
  const mod = textFonts();
  if (!mod || !text) return null;
  const key = `${font.family}\u0000${font.weight}\u0000${font.italic ? 1 : 0}\u0000${font.size}\u0000${text}`;
  let hit = shapeCache.get(key);
  if (hit === undefined) {
    const stream = mod.text_shape(font.family, font.weight, font.italic, font.size, codeUnits(text));
    hit = stream.length ? {missing: stream[0] === 1, advance: stream[1], count: stream[2], glyphs: stream.subarray(3), key} : null;
    if (shapeCache.size >= MAX_SHAPES) shapeCache.clear();
    shapeCache.set(key, hit);
  }
  return hit;
}

function glyphPath(mod: TextFontsWasm, face: number, weight: number, glyph: number): Path2D | null {
  const key = `${face}|${weight}|${glyph}`;
  let path = pathCache.get(key);
  if (path === undefined) {
    const cmds = mod.text_glyph_path(face, weight, glyph);
    if (!cmds.length) path = null;
    else {
      path = new Path2D();
      let i = 0;
      while (i < cmds.length) {
        switch (cmds[i++]) {
          case 0: path.moveTo(cmds[i++], cmds[i++]); break;
          case 1: path.lineTo(cmds[i++], cmds[i++]); break;
          case 2: path.quadraticCurveTo(cmds[i++], cmds[i++], cmds[i++], cmds[i++]); break;
          case 3: path.bezierCurveTo(cmds[i++], cmds[i++], cmds[i++], cmds[i++], cmds[i++], cmds[i++]); break;
          default: path.closePath();
        }
      }
    }
    if (pathCache.size >= MAX_PATHS) pathCache.clear();
    pathCache.set(key, path);
  }
  return path;
}

const runPaths = new Map<string, Path2D | null>();
const MAX_RUN_PATHS = 20_000;

/** All glyphs of a shaped text as one path in px, origin on the baseline: one `fill` per run instead of one
 *  per glyph. Needs DOMMatrix for `addPath`; null where it is missing (then glyphs draw one by one). */
function runPath(mod: TextFontsWasm, shaped: ShapedText, font: FontSpec, key: string, letterSpacing: number): Path2D | null {
  let path = runPaths.get(key);
  if (path !== undefined) return path;
  if (typeof DOMMatrix === 'undefined') path = null;
  else {
    path = new Path2D();
    const size = font.size;
    const g = shaped.glyphs;
    let ordinal = -1, lastCluster = -1;
    for (let k = 0; k < shaped.count; k++) {
      const at = k * RECORD;
      const cluster = g[at + 4];
      if (cluster !== lastCluster) {
        ordinal++;
        lastCluster = cluster;
      }
      const glyph = glyphPath(mod, g[at], font.weight, g[at + 1]);
      if (!glyph) continue;
      path.addPath(glyph, new DOMMatrix([size, 0, 0, size, g[at + 2] + letterSpacing * ordinal, -g[at + 3]]));
    }
  }
  if (runPaths.size >= MAX_RUN_PATHS) runPaths.clear();
  runPaths.set(key, path);
  return path;
}

/** Draws `shaped` with its origin at (`x`, `baseline`) in the context's current space, `letterSpacing` px
 *  added after every cluster as Canvas2D's `letterSpacing` does, filled or stroked with the current style. */
export function drawOutlines(ctx: Ctx2D, shaped: ShapedText, font: FontSpec, x: number, baseline: number, letterSpacing: number, mode: 'fill' | 'stroke'): void {
  const mod = textFonts();
  if (!mod) return;
  const size = font.size;
  if (!(size > 0)) return;
  if (mode === 'fill' && drawSprites(ctx, mod, shaped, font, x, baseline, letterSpacing)) return;
  const whole = runPath(mod, shaped, font, letterSpacing ? `${shaped.key}\u0000${letterSpacing}` : shaped.key, letterSpacing);
  if (whole) {
    ctx.translate(x, baseline);
    if (mode === 'fill') ctx.fill(whole);
    else ctx.stroke(whole);
    ctx.translate(-x, -baseline);
    return;
  }
  const {a, b, c, d, e, f} = ctx.getTransform();
  const lineWidth = ctx.lineWidth;
  // The glyph path is in em units: the stroke must stay the caller's px.
  if (mode === 'stroke') ctx.lineWidth = lineWidth / size;
  const g = shaped.glyphs;
  let ordinal = -1, lastCluster = -1;
  for (let k = 0; k < shaped.count; k++) {
    const at = k * RECORD;
    const cluster = g[at + 4];
    if (cluster !== lastCluster) {
      ordinal++;
      lastCluster = cluster;
    }
    const path = glyphPath(mod, g[at], font.weight, g[at + 1]);
    if (!path) continue;
    const gx = x + g[at + 2] + letterSpacing * ordinal, gy = baseline - g[at + 3];
    ctx.setTransform(a * size, b * size, c * size, d * size, a * gx + c * gy + e, b * gx + d * gy + f);
    if (mode === 'fill') ctx.fill(path);
    else ctx.stroke(path);
  }
  ctx.setTransform(a, b, c, d, e, f);
  if (mode === 'stroke') ctx.lineWidth = lineWidth;
}

// ── Small text as sprites ──────────────────────────────────────────────────────────────────────
// Canvas2D's glyph masks get Skia's text gamma (dark text on light ground reads bolder than a plain
// coverage fill), which is what T4's small-text regions miss. Below `SPRITE_MAX_PX` device px a glyph is
// rasterized once from its path into a sprite at a ¼-px x phase, its coverage pushed through a curve, and
// drawn with `drawImage` — also fewer path fills a frame. Off by default until the curve is judged (T4).

export type SpriteCurve = {gamma: number; contrast: number} | null;
let spriteCurve: SpriteCurve = null;
/** Enables the sprite path for small text with a coverage curve: `c' = c^(1/gamma) + contrast · c'(1 − c')`. */
export function setTextSpriteCurve(curve: SpriteCurve): void {
  spriteCurve = curve;
  sprites.clear();
}
export const textSpriteCurve = (): SpriteCurve => spriteCurve;

const SPRITE_MAX_PX = 64;
const PHASES = 4;
const PAD = 2;
type Sprite = {canvas: ReturnType<typeof createCanvas>; left: number; top: number} | null;
const sprites = new Map<string, Sprite>();
const MAX_SPRITES = 20_000;
let curveTable: Uint8Array | null = null;
let curveFor: SpriteCurve = null;

function coverageTable(curve: {gamma: number; contrast: number}): Uint8Array {
  if (curveTable && curveFor === curve) return curveTable;
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    let v = Math.pow(c, 1 / curve.gamma);
    v += curve.contrast * v * (1 - v);
    table[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  curveTable = table;
  curveFor = curve;
  return table;
}

/** A glyph's sprite in `color` at device size `px` and x phase `phase`/PHASES; null for an empty glyph. */
function sprite(mod: TextFontsWasm, face: number, weight: number, glyph: number, px: number, phase: number, color: string, curve: {gamma: number; contrast: number}): Sprite {
  const key = `${face}|${weight}|${glyph}|${px}|${phase}|${color}`;
  let hit = sprites.get(key);
  if (hit !== undefined) return hit;
  const path = glyphPath(mod, face, weight, glyph);
  if (!path) hit = null;
  else {
    // Bounds from the command stream in em units.
    const cmds = mod.text_glyph_path(face, weight, glyph);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let i = 0;
    while (i < cmds.length) {
      const op = cmds[i++];
      const n = op === 0 || op === 1 ? 1 : op === 2 ? 2 : op === 3 ? 3 : 0;
      for (let k = 0; k < n; k++) {
        const x = cmds[i++] * px, y = cmds[i++] * px;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!(maxX > minX) || !(maxY > minY)) hit = null;
    else {
      const left = Math.floor(minX) - PAD, top = Math.floor(minY) - PAD;
      const width = Math.ceil(maxX) - left + PAD + 1, height = Math.ceil(maxY) - top + PAD + 1;
      const canvas = createCanvas(width, height);
      const c = canvas.getContext('2d') as CanvasRenderingContext2D;
      c.setTransform(px, 0, 0, px, -left + phase / PHASES, -top);
      c.fillStyle = '#000';
      c.fill(path);
      const image = c.getImageData(0, 0, width, height);
      const table = coverageTable(curve);
      const [r, g, b] = colorBytes(color);
      const data = image.data;
      for (let p = 0; p < data.length; p += 4) {
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = table[data[p + 3]];
      }
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.putImageData(image, 0, 0);
      hit = {canvas, left, top};
    }
  }
  if (sprites.size >= MAX_SPRITES) sprites.clear();
  sprites.set(key, hit);
  return hit;
}

const colorCache = new Map<string, [number, number, number]>();
function colorBytes(color: string): [number, number, number] {
  let rgb = colorCache.get(color);
  if (!rgb) {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
    rgb = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : hex ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)] : [0, 0, 0];
    colorCache.set(color, rgb);
  }
  return rgb;
}

/** Draws small filled text as sprites when the curve is on and the transform is an axis-aligned scale with a
 *  solid fill; returns false when the caller should fill paths instead. */
function drawSprites(ctx: Ctx2D, mod: TextFontsWasm, shaped: ShapedText, font: FontSpec, x: number, baseline: number, letterSpacing: number): boolean {
  const curve = spriteCurve;
  if (!curve) return false;
  const {a, b, c, d, e, f} = ctx.getTransform();
  if (b !== 0 || c !== 0 || a !== d || a <= 0) return false;
  const px = Math.round(font.size * a * 4) / 4;
  if (!(px > 0) || px > SPRITE_MAX_PX) return false;
  const color = ctx.fillStyle;
  if (typeof color !== 'string') return false;
  const alpha = ctx.globalAlpha;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = shaped.glyphs;
  let ordinal = -1, lastCluster = -1;
  for (let k = 0; k < shaped.count; k++) {
    const at = k * RECORD;
    const cluster = g[at + 4];
    if (cluster !== lastCluster) {
      ordinal++;
      lastCluster = cluster;
    }
    const gx = x + g[at + 2] + letterSpacing * ordinal, gy = baseline - g[at + 3];
    const devX = a * gx + e, devY = a * gy + f;
    const ix = Math.floor(devX), phase = Math.min(PHASES - 1, Math.floor((devX - ix) * PHASES));
    const image = sprite(mod, g[at], font.weight, g[at + 1], px, phase, color, curve);
    if (!image) continue;
    ctx.globalAlpha = alpha;
    ctx.drawImage(image.canvas as CanvasImageSource, ix + image.left, Math.round(devY) + image.top);
  }
  ctx.setTransform(a, b, c, d, e, f);
  return true;
}

/** Drops every cached shape and path (fonts changed under the engine). */
export function forgetGlyphs(): void {
  shapeCache.clear();
  pathCache.clear();
  runPaths.clear();
  sprites.clear();
}
