import type {BlendMode, RGB, RGBA} from '../../../../shared/design/types';

// Blend modes and colours as Canvas2D wants them. Pure: no DOM, tested in node.

/** Every blend mode of the model → `globalCompositeOperation`. PASS_THROUGH only means something for
 *  groups (draw children straight into the parent); on a single paint it is plain source-over. */
export const BLEND_OPERATIONS: Readonly<Record<BlendMode, GlobalCompositeOperation>> = {
  PASS_THROUGH: 'source-over',
  NORMAL: 'source-over',
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

export const blendOperation = (mode: BlendMode | undefined): GlobalCompositeOperation => (mode && BLEND_OPERATIONS[mode]) || 'source-over';
/** True for modes that composite like normal painting. */
export const isNormalBlend = (mode: BlendMode | undefined) => !mode || mode === 'NORMAL' || mode === 'PASS_THROUGH';

const channel = (value: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 255);
const unit = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** CSS colour for canvas: `rgba(r, g, b, a)` with 0..255 channels. `alpha` multiplies the colour's own `a`. */
export function cssColor(color: RGB | RGBA, alpha = 1): string {
  const a = unit(('a' in color ? color.a : 1) * alpha);
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${Math.round(a * 1000) / 1000})`;
}

/** Relative luminance weights (Rec. 709) used by luminance masks and image saturation. */
export const LUMA = {r: 0.2126, g: 0.7152, b: 0.0722} as const;
