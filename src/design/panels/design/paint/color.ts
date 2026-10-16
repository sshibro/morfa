import type {RGB, RGBA} from '../../../../../shared/design/types';

// Colour maths for the paint panel and the colour picker: conversions between RGB (0..1 channels,
// as the model stores them), HSB/HSV, HSL, hex and CSS text, with alpha. Pure, tested in node
// (tests/design-paint-color.test.ts).

/** Hue in degrees 0..360, saturation and brightness 0..1. */
export type HSV = {h: number; s: number; v: number};
/** Hue in degrees 0..360, saturation and lightness 0..1. */
export type HSL = {h: number; s: number; l: number};
export type ColorFormat = 'HEX' | 'RGB' | 'CSS' | 'HSL' | 'HSB';
export type ParsedColor = {color: RGB; alpha: number | null};

export const COLOR_FORMATS: readonly {value: ColorFormat; label: string}[] = [
  {value: 'HEX', label: 'Hex'}, {value: 'RGB', label: 'RGB'}, {value: 'CSS', label: 'CSS'}, {value: 'HSL', label: 'HSL'}, {value: 'HSB', label: 'HSB'},
];

export const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
/** A 0..1 channel as 0..255. */
export const to255 = (value: number) => Math.round(clamp01(value) * 255);
const wrapHue = (h: number) => (Number.isFinite(h) ? ((h % 360) + 360) % 360 : 0);

export function rgbToHsv({r, g, b}: RGB, previousHue = 0): HSV {
  r = clamp01(r); g = clamp01(g); b = clamp01(b);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  return {h: d === 0 ? previousHue : hueOf(r, g, b, max, d), s, v};
}

function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return wrapHue(h * 60);
}

export function hsvToRgb({h, s, v}: HSV): RGB {
  h = wrapHue(h); s = clamp01(s); v = clamp01(v);
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return {r: r + m, g: g + m, b: b + m};
}

export function rgbToHsl({r, g, b}: RGB, previousHue = 0): HSL {
  r = clamp01(r); g = clamp01(g); b = clamp01(b);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return {h: d === 0 ? previousHue : hueOf(r, g, b, max, d), s: clamp01(s), l};
}

export function hslToRgb({h, s, l}: HSL): RGB {
  h = wrapHue(h); s = clamp01(s); l = clamp01(l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  return hsvToRgb({h, s: l + c / 2 === 0 ? 0 : c / (l + c / 2), v: l + c / 2});
}

const hex2 = (value: number) => to255(value).toString(16).padStart(2, '0').toUpperCase();

/** "D9D9D9", without the "#". */
export const toHex = (color: RGB): string => hex2(color.r) + hex2(color.g) + hex2(color.b);
/** "D9D9D980": the alpha byte only when it is not opaque. */
export const toHex8 = (color: RGB, alpha = 1): string => toHex(color) + (to255(alpha) === 255 ? '' : hex2(alpha));

/**
 * Reads what a designer types into a hex field, as Figma does: "#" optional, 1 digit repeats six
 * times (F → FFFFFF), 2 digits three times (AB → ABABAB), 3 and 4 are CSS shorthands (with alpha
 * for 4), 6 is the colour and 8 carries alpha. Null for anything else.
 */
export function parseHex(text: string): ParsedColor | null {
  const raw = text.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(raw)) return null;
  let digits: string;
  switch (raw.length) {
    case 1: digits = raw.repeat(6); break;
    case 2: digits = raw.repeat(3); break;
    case 3: case 4: digits = [...raw].map(digit => digit + digit).join(''); break;
    case 6: case 8: digits = raw; break;
    default: return null;
  }
  const byte = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
  return {color: {r: byte(0), g: byte(2), b: byte(4)}, alpha: digits.length === 8 ? byte(6) : null};
}

const number = (text: string) => {
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

/** An alpha written as 0..1 or as a percentage. */
function alphaOf(text: string | undefined): number | null | undefined {
  if (text === undefined) return undefined;
  const percent = text.trim().endsWith('%');
  const value = number(text.trim().replace('%', ''));
  if (value === null) return null;
  return clamp01(percent ? value / 100 : value);
}

/** A channel written as 0..255 or as a percentage. */
function channelOf(text: string): number | null {
  const percent = text.trim().endsWith('%');
  const value = number(text.trim().replace('%', ''));
  if (value === null) return null;
  return clamp01(percent ? value / 100 : value / 255);
}

function percentOf(text: string): number | null {
  const value = number(text.trim().replace('%', ''));
  return value === null ? null : clamp01(value / 100);
}

/** Hex, rgb()/rgba() and hsl()/hsla() in either comma or space syntax, or null. */
export function parseCssColor(text: string): ParsedColor | null {
  const source = text.trim().toLowerCase();
  if (!source) return null;
  if (source.startsWith('#') || /^[0-9a-f]{3,8}$/.test(source)) return parseHex(source);
  const call = /^(rgba?|hsla?|hsb|hsv)\(([^)]*)\)$/.exec(source);
  if (!call) return null;
  const [args, slashAlpha] = call[2].split('/');
  const parts = args.split(/[\s,]+/).filter(Boolean);
  let alphaText: string | undefined = slashAlpha;
  if (parts.length === 4 && alphaText === undefined) alphaText = parts.pop();
  if (parts.length !== 3) return null;
  const alpha = alphaOf(alphaText);
  if (alpha === null) return null;
  let color: RGB | null = null;
  if (call[1].startsWith('rgb')) {
    const [r, g, b] = parts.map(channelOf);
    if (r !== null && g !== null && b !== null) color = {r, g, b};
  } else {
    const h = number(parts[0].replace(/deg$/, ''));
    const s = percentOf(parts[1]), l = percentOf(parts[2]);
    if (h !== null && s !== null && l !== null) color = call[1].startsWith('hs') && (call[1] === 'hsb' || call[1] === 'hsv') ? hsvToRgb({h, s, v: l}) : hslToRgb({h, s, l});
  }
  return color ? {color, alpha: alpha ?? null} : null;
}

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** The CSS a developer would paste: rgb(…) when opaque, rgba(…) otherwise. */
export function formatCss(color: RGB, alpha = 1): string {
  const channels = `${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}`;
  return to255(alpha) === 255 ? `rgb(${channels})` : `rgba(${channels}, ${round(clamp01(alpha))})`;
}

/** Whole-number HSB/HSL fields as the picker shows them. */
export const hsvFields = (hsv: HSV) => ({h: Math.round(wrapHue(hsv.h)) % 360, s: Math.round(hsv.s * 100), v: Math.round(hsv.v * 100)});
export const hslFields = (hsl: HSL) => ({h: Math.round(wrapHue(hsl.h)) % 360, s: Math.round(hsl.s * 100), l: Math.round(hsl.l * 100)});

/** Equal as the panel shows them (0..255 per channel). */
export const sameRgb = (a: RGB, b: RGB) => to255(a.r) === to255(b.r) && to255(a.g) === to255(b.g) && to255(a.b) === to255(b.b);

/** A key that tells colours apart as the panel shows them: hex plus the opacity in whole percent. */
export const colorKey = (color: RGB, opacity: number) => `${toHex(color)}:${Math.round(clamp01(opacity) * 100)}`;

export const rgbaOf = (color: RGB, alpha: number): RGBA => ({r: color.r, g: color.g, b: color.b, a: alpha});
export const rgbOf = (color: RGB | RGBA): RGB => ({r: color.r, g: color.g, b: color.b});

/** Opacity as the panels print it: "100 %" → 100. */
export const percent = (opacity: number) => Math.round(clamp01(opacity) * 100);

/** Black or white text on a colour, by its relative luminance (WCAG). */
export function readableOn(color: RGB): 'dark' | 'light' {
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(clamp01(color.r)) + 0.7152 * linear(clamp01(color.g)) + 0.0722 * linear(clamp01(color.b));
  return luminance > 0.4 ? 'dark' : 'light';
}
