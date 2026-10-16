import {num} from './values';

// The code settings of the "Code" tab (Figma's Dev Mode has the same two): lengths in px or rem, and colours as hex,
// rgb or hsl. Applied when values are printed, so the CSS, the React files and the tokens agree.

export type CodeFormat = {
  unit: 'px' | 'rem';
  /** Pixels in one rem (the root font size). */
  remBase: number;
  color: 'hex' | 'rgb' | 'hsl';
};

export const DEFAULT_FORMAT: CodeFormat = {unit: 'px', remBase: 16, color: 'hex'};

/** Hairlines stay in pixels in rem mode: a 1px border or a shadow's offsets are not type-scaled. A corner's radius is not a
 *  hairline: it scales with the box. */
const PIXEL_PROPS = /^(border(?!(-[a-z]+)*-radius$)|outline|box-shadow|text-shadow|filter|backdrop-filter|-webkit-backdrop-filter|-webkit-text-stroke|outline-offset)/;

const isDefault = (format: CodeFormat) => format.unit === 'px' && format.color === 'hex';

/** A declaration's value in the chosen units and colour format. */
export function formatValue(prop: string, value: string, format: CodeFormat = DEFAULT_FORMAT): string {
  if (isDefault(format)) return value;
  let out = value;
  if (format.unit === 'rem' && !PIXEL_PROPS.test(prop)) out = remLengths(out, format.remBase);
  if (format.color !== 'hex') out = formatColors(out, format.color);
  return out;
}

/** `16px` → `1rem` outside `url(…)` and custom property names. */
export function remLengths(value: string, base: number): string {
  return mapOutsideUrls(value, part => part.replace(/(^|[^\w.-])(-?\d*\.?\d+)px\b/g, (_, before: string, n: string) => `${before}${Number(n) === 0 ? '0' : `${num(Number(n) / base, 4)}rem`}`));
}

export function formatColors(value: string, mode: 'rgb' | 'hsl'): string {
  return mapOutsideUrls(value, part => part
    .replace(/#([0-9A-Fa-f]{6})\b/g, (_, hex: string) => colorText(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1, mode))
    .replace(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g, (_, r: string, g: string, b: string, a: string) => colorText(Number(r), Number(g), Number(b), Number(a), mode)));
}

function colorText(r: number, g: number, b: number, a: number, mode: 'rgb' | 'hsl'): string {
  if (mode === 'rgb') return a >= 0.995 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${num(a)})`;
  const [h, s, l] = toHsl(r, g, b);
  return a >= 0.995 ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${num(a)})`;
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/** Applies `edit` to the parts of `value` outside `url(…)` (a picture's path is never rewritten). */
function mapOutsideUrls(value: string, edit: (part: string) => string): string {
  const parts = value.split(/(url\([^)]*\))/);
  return parts.map((part, i) => (i % 2 ? part : edit(part))).join('');
}
