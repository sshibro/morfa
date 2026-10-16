import type {
  BlendMode, ColorStop, ConstraintType, Effect, ExportSetting, GradientPaint, ImageFilters, ImagePaint, LayoutGrid, Matrix, Paint, RGB, RGBA, SolidPaint, StrokeCap, StrokeJoin,
  StrokeMarker, Vec,
} from '../types';
import {DESIGN_FIELD_LIMITS as L} from '../document-limits';
import type {FigmaColor, FigmaEffect, FigmaExportSetting, FigmaLayoutGrid, FigmaPaint, FigmaTransform, FigmaVector} from './rest-types';
import type {FigmaReportGroup} from './report';

// Figma REST values → Morfa values: paints, effects, blend modes, strokes, grids, constraints and
// export settings. Pure and total: anything malformed becomes the default, anything we cannot draw
// is noted through `Note` and left out or approximated, never passed through unchecked.

/** Reports one approximation on the layer being mapped. */
export type Note = (key: string, group: FigmaReportGroup, message: string) => void;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const finite = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const unit = (value: unknown, fallback = 0) => clamp(finite(value, fallback), 0, 1);
/** A coordinate inside the schema's bound. */
export const coord = (value: unknown, fallback = 0) => clamp(finite(value, fallback), -L.coordinate, L.coordinate);
export const size = (value: unknown, fallback = 0) => clamp(finite(value, fallback), 0, L.coordinate);
export const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
export const text = (value: unknown, max: number, fallback = '') => (typeof value === 'string' ? value.slice(0, max) : fallback);

export const rgb = (color: FigmaColor | undefined): RGB => ({r: unit(color?.r), g: unit(color?.g), b: unit(color?.b)});
export const rgba = (color: FigmaColor | undefined): RGBA => ({...rgb(color), a: unit(color?.a, 1)});
const vec = (value: FigmaVector | undefined, fallback: Vec = {x: 0, y: 0}): Vec => ({x: coord(value?.x, fallback.x), y: coord(value?.y, fallback.y)});

export function matrixOf(value: FigmaTransform | undefined): Matrix | undefined {
  if (!Array.isArray(value) || value.length < 2 || !Array.isArray(value[0]) || !Array.isArray(value[1])) return undefined;
  const [[a, c, e], [b, d, f]] = value;
  const all = [a, c, e, b, d, f];
  if (!all.every(n => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return [[a, c, e], [b, d, f]];
}

// ── Blend modes ────────────────────────────────────────────────────────────────────────────────

const BLEND_MODES = new Set<BlendMode>([
  'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION',
  'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
]);
const BLEND_NEAR: Record<string, BlendMode> = {LINEAR_BURN: 'COLOR_BURN', LINEAR_DODGE: 'COLOR_DODGE', PLUS_DARKER: 'COLOR_BURN', PLUS_LIGHTER: 'COLOR_DODGE'};

export function blendMode(value: unknown, fallback: BlendMode, note: Note, layer = true): BlendMode {
  if (typeof value !== 'string') return fallback;
  if (BLEND_MODES.has(value as BlendMode)) {
    // PASS_THROUGH belongs to layers that hold others; a paint or a leaf draws normally.
    return value === 'PASS_THROUGH' && !layer ? 'NORMAL' : (value as BlendMode);
  }
  const near = BLEND_NEAR[value];
  if (near) {
    note('blend-' + value, 'appearance', `Blend mode ${value === 'LINEAR_BURN' || value === 'PLUS_DARKER' ? '"Linear burn"' : '"Linear dodge"'} was replaced with the nearest one (${near === 'COLOR_BURN' ? '"Color burn"' : '"Color dodge"'})`);
    return near;
  }
  return fallback;
}

// ── Paints ─────────────────────────────────────────────────────────────────────────────────────

const GRADIENTS = new Set(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']);
const IMAGE_FILTERS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'] as const;

/** Figma's image hash: what the file's image-fills listing names. */
export const FIGMA_IMAGE_REF = /^[A-Za-z0-9]{1,128}$/;

function solidPaint(paint: FigmaPaint, note: Note): SolidPaint {
  // A solid keeps its alpha in the paint's opacity; Figma may put some in the colour too.
  return {type: 'SOLID', color: rgb(paint.color), opacity: unit(paint.opacity, 1) * unit(paint.color?.a, 1), visible: bool(paint.visible, true), blendMode: blendMode(paint.blendMode, 'NORMAL', note, false)};
}

function gradientPaint(paint: FigmaPaint, note: Note): GradientPaint | null {
  const stops: ColorStop[] = (Array.isArray(paint.gradientStops) ? paint.gradientStops : [])
    .slice(0, L.gradientStops)
    .filter(isObject)
    .map(stop => ({position: unit(stop.position), color: rgba(stop.color)}));
  if (!stops.length) return null;
  stops.sort((a, b) => a.position - b.position);
  const handles = Array.isArray(paint.gradientHandlePositions) ? paint.gradientHandlePositions : [];
  const start = vec(handles[0], {x: 0, y: 0.5});
  const end = vec(handles[1], {x: 1, y: 0.5});
  // The width handle defaults to the main axis turned a quarter, as Figma draws it.
  const width = handles[2] ? vec(handles[2]) : {x: start.x - (end.y - start.y), y: start.y + (end.x - start.x)};
  return {type: paint.type as GradientPaint['type'], gradientStops: stops, gradientHandlePositions: [start, end, width], opacity: unit(paint.opacity, 1), visible: bool(paint.visible, true), blendMode: blendMode(paint.blendMode, 'NORMAL', note, false)};
}

function imagePaint(paint: FigmaPaint, note: Note): ImagePaint | null {
  const ref = typeof paint.imageRef === 'string' && FIGMA_IMAGE_REF.test(paint.imageRef) ? paint.imageRef : '';
  if (!ref) {
    note('image-missing', 'images', 'Images without a file in Figma were skipped');
    return null;
  }
  if (paint.gifRef) note('image-gif', 'images', 'Animated GIFs were imported as still images');
  const mode = paint.scaleMode === 'STRETCH' || paint.scaleMode === 'CROP' ? 'CROP' : paint.scaleMode === 'FIT' ? 'FIT' : paint.scaleMode === 'TILE' ? 'TILE' : 'FILL';
  const out: ImagePaint = {type: 'IMAGE', imageRef: ref, scaleMode: mode, opacity: unit(paint.opacity, 1), visible: bool(paint.visible, true), blendMode: blendMode(paint.blendMode, 'NORMAL', note, false)};
  if (mode === 'CROP') {
    const transform = matrixOf(paint.imageTransform);
    if (transform) out.imageTransform = transform;
  }
  if (mode === 'TILE') {
    const factor = finite(paint.scalingFactor, 1);
    if (factor > 0 && factor <= 10_000 && factor !== 1) out.scalingFactor = factor;
  }
  const rotation = ((Math.round(finite(paint.rotation) / 90) * 90) % 360 + 360) % 360;
  if (rotation) out.rotation = rotation as 90 | 180 | 270;
  if (isObject(paint.filters)) {
    const filters: ImageFilters = {};
    for (const key of IMAGE_FILTERS) {
      const value = finite(paint.filters[key]);
      if (value) filters[key] = clamp(value, -1, 1);
    }
    if (Object.keys(filters).length) out.filters = filters;
  }
  return out;
}

/** A Figma paint, or null for kinds we cannot draw (noted). */
export function paintOf(paint: unknown, note: Note): Paint | null {
  if (!isObject(paint) || typeof paint.type !== 'string') return null;
  const value = paint as FigmaPaint;
  if (value.type === 'SOLID') return solidPaint(value, note);
  if (GRADIENTS.has(value.type)) return gradientPaint(value, note);
  if (value.type === 'IMAGE') return imagePaint(value, note);
  if (value.type === 'VIDEO') note('paint-video', 'appearance', 'Videos in fills are not imported');
  else if (value.type === 'EMOJI') note('paint-emoji', 'appearance', 'Emoji fills are not imported');
  else note('paint-' + value.type, 'appearance', 'Fills of this kind are not imported');
  return null;
}

export function paintsOf(list: unknown, note: Note): Paint[] {
  if (!Array.isArray(list)) return [];
  const out: Paint[] = [];
  for (const entry of list) {
    const paint = paintOf(entry, note);
    if (paint) out.push(paint);
    if (out.length >= L.paints) break;
  }
  return out;
}

// ── Effects ────────────────────────────────────────────────────────────────────────────────────

export function effectsOf(list: unknown, note: Note): Effect[] {
  if (!Array.isArray(list)) return [];
  const out: Effect[] = [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const effect = entry as FigmaEffect;
    const visible = bool(effect.visible, true);
    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      const shadow: Effect = {
        type: effect.type, color: rgba(effect.color), offset: vec(effect.offset), radius: size(effect.radius), spread: coord(effect.spread), visible,
        blendMode: blendMode(effect.blendMode, 'NORMAL', note, false),
      };
      if (effect.type === 'DROP_SHADOW' && effect.showShadowBehindNode) shadow.showShadowBehindNode = true;
      out.push(shadow);
    } else if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
      let radius = size(effect.radius);
      if (effect.blurType === 'PROGRESSIVE') {
        note('blur-progressive', 'appearance', 'Progressive blur was replaced with regular blur');
        radius = Math.max(radius, size(effect.startRadius));
      }
      out.push({type: effect.type, radius, visible});
    } else if (typeof effect.type === 'string') {
      note('effect-' + effect.type, 'appearance', effect.type === 'NOISE' ? 'The "Noise" effect is not imported' : effect.type === 'TEXTURE' ? 'The "Texture" effect is not imported' : effect.type === 'GLASS' ? 'The "Glass" effect is not imported' : 'Effects of this kind are not imported');
    }
    if (out.length >= L.effects) break;
  }
  return out;
}

// ── Strokes ────────────────────────────────────────────────────────────────────────────────────

export const strokeAlignOf = (value: unknown, fallback: 'INSIDE' | 'CENTER' | 'OUTSIDE') =>
  value === 'INSIDE' || value === 'CENTER' || value === 'OUTSIDE' ? value : fallback;

export const strokeJoinOf = (value: unknown): StrokeJoin => (value === 'BEVEL' || value === 'ROUND' ? value : 'MITER');

/** Figma's miter angle (degrees, default 28.96) → SVG's miter limit (default 4). */
export function miterLimitOf(angle: unknown): number {
  const degrees = finite(angle, 28.96);
  if (degrees <= 0 || degrees >= 180) return 4;
  return clamp(1 / Math.sin((degrees * Math.PI) / 360), 1, 1000);
}

const MARKERS: Record<string, StrokeMarker> = {
  LINE_ARROW: 'LINE_ARROW', ARROW_LINES: 'LINE_ARROW', TRIANGLE_ARROW: 'TRIANGLE_ARROW', ARROW_EQUILATERAL: 'TRIANGLE_ARROW',
  TRIANGLE_FILLED: 'REVERSED_TRIANGLE', CIRCLE_FILLED: 'CIRCLE', DIAMOND_FILLED: 'DIAMOND',
};

/** A node-level cap: the plain cap, or an end marker for arrows (lines and open vectors). */
export function capOf(value: unknown, note: Note): {cap: StrokeCap; marker: StrokeMarker | null} {
  if (value === 'ROUND' || value === 'SQUARE') return {cap: value, marker: null};
  if (typeof value === 'string' && MARKERS[value]) return {cap: 'NONE', marker: MARKERS[value]};
  if (typeof value === 'string' && value.startsWith('WASHI_TAPE')) note('cap-washi', 'vectors', '"Tape" line ends were replaced with regular ones');
  return {cap: 'NONE', marker: null};
}

export function dashesOf(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, L.dashPattern).map(n => size(n)).filter(n => n >= 0);
}

// ── Layout grids, constraints, exports ─────────────────────────────────────────────────────────

export function gridsOf(list: unknown): LayoutGrid[] {
  if (!Array.isArray(list)) return [];
  const out: LayoutGrid[] = [];
  for (const entry of list.slice(0, L.layoutGrids)) {
    if (!isObject(entry)) continue;
    const grid = entry as FigmaLayoutGrid;
    const visible = bool(grid.visible, true);
    const color = rgba(grid.color ?? {r: 1, g: 0, b: 0, a: 0.1});
    if (grid.pattern === 'GRID') out.push({pattern: 'GRID', sectionSize: size(grid.sectionSize, 10), visible, color});
    else if (grid.pattern === 'COLUMNS' || grid.pattern === 'ROWS') {
      const alignment = grid.alignment === 'MIN' || grid.alignment === 'MAX' || grid.alignment === 'CENTER' ? grid.alignment : 'STRETCH';
      out.push({pattern: grid.pattern, alignment, count: clamp(Math.round(finite(grid.count, 5)), 0, 10_000), gutterSize: coord(grid.gutterSize, 20), offset: coord(grid.offset), sectionSize: size(grid.sectionSize, 10), visible, color});
    }
  }
  return out;
}

const HORIZONTAL: Record<string, ConstraintType> = {LEFT: 'MIN', RIGHT: 'MAX', CENTER: 'CENTER', LEFT_RIGHT: 'STRETCH', SCALE: 'SCALE'};
const VERTICAL: Record<string, ConstraintType> = {TOP: 'MIN', BOTTOM: 'MAX', CENTER: 'CENTER', TOP_BOTTOM: 'STRETCH', SCALE: 'SCALE'};

export function constraintsOf(value: unknown): {horizontal: ConstraintType; vertical: ConstraintType} {
  const constraints = isObject(value) ? value : {};
  return {horizontal: HORIZONTAL[String(constraints.horizontal)] ?? 'MIN', vertical: VERTICAL[String(constraints.vertical)] ?? 'MIN'};
}

export function exportSettingsOf(list: unknown): ExportSetting[] {
  if (!Array.isArray(list)) return [];
  const out: ExportSetting[] = [];
  for (const entry of list.slice(0, L.exportSettings)) {
    if (!isObject(entry)) continue;
    const setting = entry as FigmaExportSetting;
    const format = setting.format === 'JPG' || setting.format === 'SVG' || setting.format === 'PDF' || setting.format === 'PNG' ? setting.format : null;
    if (!format) continue;
    const type = setting.constraint?.type === 'WIDTH' || setting.constraint?.type === 'HEIGHT' ? setting.constraint.type : 'SCALE';
    const value = finite(setting.constraint?.value, 1);
    out.push({format, suffix: text(setting.suffix, L.shortText), constraint: {type, value: value > 0 && value <= 100_000 ? value : 1}});
  }
  return out;
}
