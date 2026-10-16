import type {BlendMode, ColorStop, GradientPaint, LetterSpacing, LineHeight, Paint, RGB, ShadowEffect, Vec} from '../types';

// CSS values from model values: numbers, colours, gradients, shadows, blend modes, fonts. Pure
// formatting, shared by the dev-mode CSS, the React emitters and the tokens.

/** A number as CSS writes it: at most `digits` decimals, no trailing zeros, never "-0". */
export function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0';
  const factor = 10 ** digits;
  let rounded = Math.round(value * factor) / factor;
  if (Object.is(rounded, -0)) rounded = 0;
  return String(rounded);
}

/** "12px", or "0" for zero. */
export const px = (value: number) => (Math.abs(value) < 0.005 ? '0' : `${num(value)}px`);

const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);

/** "#0D99FF" when opaque, else "rgba(13, 153, 255, 0.5)". */
export function color(rgb: RGB, alpha = 1): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (a >= 0.995) return '#' + [rgb.r, rgb.g, rgb.b].map(c => channel(c).toString(16).padStart(2, '0')).join('').toUpperCase();
  return `rgba(${channel(rgb.r)}, ${channel(rgb.g)}, ${channel(rgb.b)}, ${num(a)})`;
}

export const hex = (rgb: RGB) => color(rgb, 1);

export const BLEND_CSS: Partial<Record<BlendMode, string>> = {
  DARKEN: 'darken', MULTIPLY: 'multiply', COLOR_BURN: 'color-burn', LIGHTEN: 'lighten', SCREEN: 'screen', COLOR_DODGE: 'color-dodge', OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light', HARD_LIGHT: 'hard-light', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity',
};

export const isVisiblePaint = (paint: Paint) => paint.visible !== false && paint.opacity > 0;

// ── Gradients ──────────────────────────────────────────────────────────────────────────────────

const stopColor = (stop: ColorStop, opacity: number) => color(stop.color, stop.color.a * opacity);
const percent = (value: number) => `${num(value * 100)}%`;
const degrees = (radians: number) => {
  let deg = (radians * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return num(deg);
};

/** A CSS gradient for a gradient paint on a `width` × `height` box. Linear gradients are exact: the
 *  handle line is projected onto the gradient line CSS draws for that angle. Radial and angular use
 *  the handles' centre and axes; a diamond has no CSS form and is approximated by a radial one. */
export function gradientCss(paint: GradientPaint, width: number, height: number): string {
  const w = Math.max(width, 1e-6), h = Math.max(height, 1e-6);
  const [h0, h1, h2] = paint.gradientHandlePositions;
  const start: Vec = {x: h0.x * w, y: h0.y * h};
  const end: Vec = {x: h1.x * w, y: h1.y * h};
  const stops = [...paint.gradientStops].sort((a, b) => a.position - b.position);
  if (paint.type === 'GRADIENT_LINEAR') {
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    // CSS: 0deg points up, angles turn clockwise.
    const angle = Math.atan2(dx, -dy);
    const ux = dx / length, uy = dy / length;
    const lineLength = Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle)) || 1;
    const cssStart = {x: w / 2 - (ux * lineLength) / 2, y: h / 2 - (uy * lineLength) / 2};
    const at = (s: number) => {
      const p = {x: start.x + dx * s, y: start.y + dy * s};
      return ((p.x - cssStart.x) * ux + (p.y - cssStart.y) * uy) / lineLength;
    };
    return `linear-gradient(${degrees(angle)}deg, ${stops.map(stop => `${stopColor(stop, paint.opacity)} ${percent(at(stop.position))}`).join(', ')})`;
  }
  if (paint.type === 'GRADIENT_ANGULAR') {
    const from = Math.atan2(end.x - start.x, -(end.y - start.y));
    return `conic-gradient(from ${degrees(from)}deg at ${percent(h0.x)} ${percent(h0.y)}, ${stops.map(stop => `${stopColor(stop, paint.opacity)} ${percent(stop.position)}`).join(', ')})`;
  }
  const rx = Math.hypot(end.x - start.x, end.y - start.y);
  const ry = h2 ? Math.hypot(h2.x * w - start.x, h2.y * h - start.y) : rx;
  return `radial-gradient(${percent(rx / w)} ${percent(ry / h)} at ${percent(h0.x)} ${percent(h0.y)}, ${stops.map(stop => `${stopColor(stop, paint.opacity)} ${percent(stop.position)}`).join(', ')})`;
}

// ── Shadows and blurs ──────────────────────────────────────────────────────────────────────────

/** One box-shadow (or text-shadow without spread) entry. */
export function shadowCss(effect: ShadowEffect, options: {spread?: boolean} = {}): string {
  const parts = [effect.type === 'INNER_SHADOW' ? 'inset' : '', px(effect.offset.x), px(effect.offset.y), px(effect.radius)];
  if (options.spread !== false && effect.spread) parts.push(px(effect.spread));
  parts.push(color(effect.color, effect.color.a));
  return parts.filter(Boolean).join(' ');
}

/** CSS blur for a blur radius: CSS's standard deviation is half of a design tool's radius. */
export const blurCss = (radius: number) => `blur(${px(radius / 2)})`;

// ── Text ───────────────────────────────────────────────────────────────────────────────────────

export function lineHeightCss(lineHeight: LineHeight): string | null {
  if (lineHeight.unit === 'AUTO') return null;
  return lineHeight.unit === 'PIXELS' ? px(lineHeight.value) : `${num(lineHeight.value)}%`;
}

export function letterSpacingCss(spacing: LetterSpacing): string | null {
  if (!spacing.value) return null;
  return spacing.unit === 'PIXELS' ? px(spacing.value) : `${num(spacing.value / 100, 3)}em`;
}

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+)$/;

/** "'Inter', sans-serif": the family quoted, then a fallback stack. */
export function fontFamilyCss(family: string, fallback: string): string {
  const quoted = `'${family.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const rest = fallback.split(',').map(part => part.trim()).filter(part => part && part.replace(/['"]/g, '') !== family);
  return [quoted, ...rest.map(part => (GENERIC.test(part) || /^['"]/.test(part) ? part : /\s/.test(part) ? `'${part}'` : part))].join(', ');
}

/** A fallback stack for a family the caller knows nothing about, guessed from its name. */
export function guessFallback(family: string): string {
  if (/mono|code|consol|courier/i.test(family)) return 'ui-monospace, monospace';
  if (/serif|garamond|georgia|times|playfair|lora|merriweather|baskerville|bodoni|didot|antiqua|антиква/i.test(family) && !/sans/i.test(family)) return 'Georgia, serif';
  if (/script|hand|caveat|marck|pacifico|lobster|brush/i.test(family)) return 'cursive';
  return 'sans-serif';
}
