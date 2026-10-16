// Spec Lint's text contrast (docs/marketplaces.md §Spec Lint): how well each text of a card stands out from what is behind it, as
// WCAG measures it. The editor renders the card twice at a low resolution, with its texts and without them. A text of known solid
// colours is compared with every background pixel under its box; any other text (a gradient, a picture) is read off the picture
// with the text, at the pixels that changed — its glyphs. A low percentile of those ratios is the answer, not the mean: a headline
// that is readable on most of a photo and lost on its bright corner fails. Pure, so the tests feed it hand-made pixels.

import type {NodeId, RGB} from '../types';
import type {Box} from './lint';

const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of an sRGB colour (channels 0..1). */
export const relativeLuminance = ({r, g, b}: RGB): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** RGBA pixels, 8 bits a channel, row by row (a decoded PNG or ImageData). */
export type Pixels = {width: number; height: number; rgba: ArrayLike<number>};

export type ContrastTarget = {
  id: NodeId;
  /** The text's box in the pictures' pixels. */
  box: Box;
  /** The text's solid colours (its fill and its runs'); null reads the colour off the picture with the text. */
  colors: readonly RGB[] | null;
  /** How opaque those colours are painted (the fill's and the layer's opacity), 0..1. */
  opacity?: number;
};

/** Which of the ratios under a text is its answer: the tenth percentile. */
export const CONTRAST_PERCENTILE = 0.1;
/** A pixel whose colour moved less than this (sum of channels, 0..765) between the two pictures is not a glyph. */
const GLYPH_MIN_DIFF = 24;
/** Glyph pixels are those that moved at least this share of the most any pixel of the text moved: the glyphs' cores, not
 *  their antialiased edges, which are half background. */
const GLYPH_CORE = 0.5;
/** Pixels read per text at most; a larger box is sampled on a grid. */
const MAX_SAMPLES = 40_000;

/** The pixel at `index` (its first byte) composited over white, as a marketplace shows a transparent picture. */
function pixel(image: Pixels, index: number): RGB {
  const a = image.rgba[index + 3] / 255;
  return {
    r: (image.rgba[index] / 255) * a + (1 - a),
    g: (image.rgba[index + 1] / 255) * a + (1 - a),
    b: (image.rgba[index + 2] / 255) * a + (1 - a),
  };
}

const distance = (a: RGB, b: RGB) => (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) * 255;
const over = (top: RGB, alpha: number, below: RGB): RGB => ({r: top.r * alpha + below.r * (1 - alpha), g: top.g * alpha + below.g * (1 - alpha), b: top.b * alpha + below.b * (1 - alpha)});

/** The value at share `p` (0..1) of the sorted values; NaN for none. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Text layer → its contrast ratio, from two pictures of the same card at the same size: `withText` and `withoutText` (every text
 * layer hidden). A text that changes no pixel (lost in its background, or too small for the picture) is judged on its whole box. A
 * text outside the pictures gets no answer.
 */
export function measureTextContrast(withText: Pixels, withoutText: Pixels, targets: readonly ContrastTarget[], p = CONTRAST_PERCENTILE): Record<NodeId, number> {
  const out: Record<NodeId, number> = {};
  if (withText.width !== withoutText.width || withText.height !== withoutText.height) return out;
  const {width, height} = withText;
  for (const target of targets) {
    const x0 = Math.max(0, Math.floor(target.box.x)), y0 = Math.max(0, Math.floor(target.box.y));
    const x1 = Math.min(width, Math.ceil(target.box.x + target.box.width)), y1 = Math.min(height, Math.ceil(target.box.y + target.box.height));
    if (x1 <= x0 || y1 <= y0) continue;
    const step = Math.max(1, Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_SAMPLES)));
    const samples: {index: number; moved: number}[] = [];
    let most = 0;
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const index = (y * width + x) * 4;
        const moved = distance(pixel(withText, index), pixel(withoutText, index));
        samples.push({index, moved});
        if (moved > most) most = moved;
      }
    }
    const ratios: number[] = [];
    if (target.colors?.length) {
      // Known colours: against everything under the box, so a part of the text lost in its background (which changes no pixel)
      // still counts; the worst of the colours at each pixel.
      for (const {index} of samples) {
        const behind = pixel(withoutText, index);
        let worst = Infinity;
        for (const color of target.colors) worst = Math.min(worst, contrastRatio(over(color, target.opacity ?? 1, behind), behind));
        ratios.push(worst);
      }
    } else {
      // Read off the picture: the glyphs' cores; a text that changed nothing is the background itself, ratio 1.
      const glyphs = most < GLYPH_MIN_DIFF ? samples : samples.filter(sample => sample.moved >= Math.max(GLYPH_MIN_DIFF, most * GLYPH_CORE));
      for (const {index} of glyphs) ratios.push(contrastRatio(pixel(withText, index), pixel(withoutText, index)));
    }
    const value = percentile(ratios, p);
    if (Number.isFinite(value)) out[target.id] = Math.round(value * 100) / 100;
  }
  return out;
}
