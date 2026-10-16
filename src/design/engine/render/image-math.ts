import type {ImageFilters, ImagePaint, Matrix} from '../../../../shared/design/types';
import {invert, multiply} from '../../../../shared/design/geometry';
import {LUMA} from './blend';

// Placing an image paint in a node and adjusting its colours. Pure, tested in node
// (tests/design-render-image.test.ts).

export type ImagePlacement = {
  /** Image pixel space → node local space. */
  matrix: Matrix;
  /** TILE repeats the image; every other mode draws it once. */
  repeat: boolean;
};

/** Quarter turns only, normalised to 0..3. */
export const quarterTurns = (rotation: number | undefined) => ((Math.round((rotation ?? 0) / 90) % 4) + 4) % 4;

/** Rotation by quarter turns clockwise on screen about the origin. */
function quarterMatrix(turns: number): Matrix {
  switch (turns) {
    case 1: return [[0, -1, 0], [1, 0, 0]];
    case 2: return [[-1, 0, 0], [0, -1, 0]];
    case 3: return [[0, 1, 0], [-1, 0, 0]];
    default: return [[1, 0, 0], [0, 1, 0]];
  }
}

/** Where the image's pixels land in a `width` × `height` box.
 *  FILL covers the box and crops the overflow (centred); FIT shows the whole image inside (centred);
 *  CROP follows `imageTransform` (node unit box → image unit box); TILE repeats the natural size
 *  times `scalingFactor` from the top-left corner. FILL, FIT and TILE turn by `rotation`. */
export function imagePlacement(paint: Pick<ImagePaint, 'scaleMode' | 'imageTransform' | 'scalingFactor' | 'rotation'>, width: number, height: number, imageWidth: number, imageHeight: number): ImagePlacement {
  const iw = Math.max(imageWidth, 1e-6), ih = Math.max(imageHeight, 1e-6);
  if (paint.scaleMode === 'CROP' && paint.imageTransform) {
    const toUnit: Matrix = [[1 / iw, 0, 0], [0, 1 / ih, 0]];
    const toLocal: Matrix = [[width, 0, 0], [0, height, 0]];
    return {matrix: multiply(toLocal, multiply(invert(paint.imageTransform), toUnit)), repeat: false};
  }
  const turns = quarterTurns(paint.rotation);
  const rotated = turns % 2 === 1;
  const rw = rotated ? ih : iw, rh = rotated ? iw : ih;
  // Rotate about the image centre, then scale and centre in the box.
  const centre: Matrix = [[1, 0, -iw / 2], [0, 1, -ih / 2]];
  const spin = multiply(quarterMatrix(turns), centre);
  if (paint.scaleMode === 'TILE') {
    const s = paint.scalingFactor && paint.scalingFactor > 0 ? paint.scalingFactor : 1;
    // Tiles start at the box's top-left corner: shift the rotated tile's corner there.
    return {matrix: multiply([[s, 0, (rw * s) / 2], [0, s, (rh * s) / 2]], spin), repeat: true};
  }
  const s = paint.scaleMode === 'FIT' ? Math.min(width / rw, height / rh) : Math.max(width / rw, height / rh);
  const scale = Number.isFinite(s) && s > 0 ? s : 0;
  return {matrix: multiply([[scale, 0, width / 2], [0, scale, height / 2]], spin), repeat: false};
}

/** The image's drawn scale: device px per image px under a device scale (for picking a mip). */
export function drawnScale(placement: ImagePlacement, deviceScale: number): number {
  const [[a, c], [b, d]] = placement.matrix;
  return Math.sqrt(Math.abs(a * d - b * c)) * deviceScale;
}

/** True when every filter is neutral (or absent), so the image is drawn as decoded. */
export function neutralFilters(filters: ImageFilters | undefined): boolean {
  if (!filters) return true;
  return !filters.exposure && !filters.contrast && !filters.saturation && !filters.temperature && !filters.tint && !filters.highlights && !filters.shadows;
}

/** Stable key of a filter set, for caching filtered copies. */
export const filtersKey = (filters: ImageFilters) =>
  [filters.exposure, filters.contrast, filters.saturation, filters.temperature, filters.tint, filters.highlights, filters.shadows].map(v => Math.round((v ?? 0) * 1000)).join(',');

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Adjusts RGBA pixels (straight alpha, 0..255) in place, the way the image panel's sliders do
 *  (each −1..1, 0 neutral): exposure scales light in stops, contrast pivots on mid grey, saturation
 *  mixes towards luma, temperature trades blue for amber, tint trades green for magenta, highlights
 *  and shadows lift or lower only the bright or dark tones. */
export function applyImageFilters(data: Uint8ClampedArray, filters: ImageFilters): void {
  const exposure = Math.pow(2, (filters.exposure ?? 0) * 2);
  const k = clamp01(((filters.contrast ?? 0) * 0.98 + 1) / 2);
  const contrast = Math.tan((k * Math.PI) / 2);
  const saturation = 1 + (filters.saturation ?? 0);
  const temperature = (filters.temperature ?? 0) * 0.2;
  const tint = (filters.tint ?? 0) * 0.2;
  const highlights = (filters.highlights ?? 0) * 0.35;
  const shadows = (filters.shadows ?? 0) * 0.35;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    r *= exposure; g *= exposure; b *= exposure;
    r = (r - 0.5) * contrast + 0.5; g = (g - 0.5) * contrast + 0.5; b = (b - 0.5) * contrast + 0.5;
    const luma = LUMA.r * r + LUMA.g * g + LUMA.b * b;
    r = luma + (r - luma) * saturation; g = luma + (g - luma) * saturation; b = luma + (b - luma) * saturation;
    r += temperature; b -= temperature;
    g -= tint; r += tint * 0.5; b += tint * 0.5;
    if (highlights || shadows) {
      const l = clamp01(LUMA.r * r + LUMA.g * g + LUMA.b * b);
      const lift = highlights * smoothstep(0.5, 1, l) + shadows * (1 - smoothstep(0, 0.5, l));
      r += lift; g += lift; b += lift;
    }
    data[i] = clamp01(r) * 255;
    data[i + 1] = clamp01(g) * 255;
    data[i + 2] = clamp01(b) * 255;
  }
}

/** Turns RGBA pixels into an alpha mask by luminance (luminance masks): alpha ← luma · alpha. */
export function luminanceToAlpha(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const luma = (LUMA.r * data[i] + LUMA.g * data[i + 1] + LUMA.b * data[i + 2]) / 255;
    data[i + 3] = luma * data[i + 3];
    data[i] = data[i + 1] = data[i + 2] = 0;
  }
}

/** Which half-size level of an image to draw when it lands at `scale` device px per image px:
 *  level k is 1/2^k of the natural size, used once the drawing is at most half of the level above. */
export function mipLevel(scale: number, width: number, height: number): number {
  if (!(scale > 0) || scale >= 0.5) return 0;
  let level = Math.floor(Math.log2(1 / scale));
  // Never shrink below a couple of pixels.
  while (level > 0 && (width >> level < 2 || height >> level < 2)) level--;
  return Math.max(0, level);
}
