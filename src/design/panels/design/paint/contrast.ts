import type {DesignDocument, NodeId, RGB, SceneNode} from '../../../../../shared/design/types';
import {defaultPageBackground} from '../../../../../shared/design/defaults';
import {pageIdOf} from '../../../../../shared/design/tree';
import {hsvToRgb, rgbToHsv} from './color';

// The colour picker's contrast check, as Figma's (help.figma.com "Update fills using the color picker"): the WCAG
// contrast ratio between the edited colour and the colour behind the layer, and whether it meets AA and AAA for the
// layer's kind of content — normal text 4.5 and 7, large text (24 px, or 18.66 px bold) and graphics 3 and 4.5.

export type ContrastCategory = 'normal-text' | 'large-text' | 'graphics';
export const CONTRAST_TARGETS: Record<ContrastCategory, {aa: number; aaa: number}> = {
  'normal-text': {aa: 4.5, aaa: 7},
  'large-text': {aa: 3, aaa: 4.5},
  graphics: {aa: 3, aaa: 4.5},
};

const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of an sRGB colour (channels 0..1). */
export const luminance = ({r, g, b}: RGB): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The ratio printed as Figma prints it: one decimal, "4,6 : 1". */
export const formatRatio = (ratio: number) => `${(Math.floor(ratio * 10) / 10).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1})} : 1`;

/** What a layer's colour is judged as: its text's size and weight, or a graphic. */
export function contrastCategory(node: SceneNode | undefined): ContrastCategory {
  const style = node?.type === 'TEXT' ? node.text?.style : undefined;
  if (!style) return 'graphics';
  const bold = (style.fontWeight ?? 400) >= 700;
  return style.fontSize >= 24 || (bold && style.fontSize >= 18.66) ? 'large-text' : 'normal-text';
}

/** The colour behind a layer: the nearest container above it with a visible, opaque-enough solid fill (its topmost such
 *  fill), else the page's background. */
export function colorBehind(doc: DesignDocument, id: NodeId, theme: 'light' | 'dark' = 'light'): RGB {
  for (let node = doc.nodes[doc.nodes[id]?.parentId ?? '']; node && node.type !== 'PAGE'; node = doc.nodes[node.parentId ?? '']) {
    const fill = [...node.fills].reverse().find(paint => paint.visible !== false && paint.type === 'SOLID' && paint.opacity >= 0.5);
    if (fill?.type === 'SOLID' && node.visible !== false) return fill.color;
  }
  const page = doc.nodes[pageIdOf(doc, id) ?? ''];
  return page?.backgroundColor ?? defaultPageBackground(theme);
}

/** The nearest colour to `color` (same hue and saturation, brightness moved) that reaches `target` against `behind`, or
 *  null when none does. */
export function nearestCompliant(color: RGB, behind: RGB, target: number): RGB | null {
  if (contrastRatio(color, behind) >= target) return color;
  const hsv = rgbToHsv(color);
  let best: RGB | null = null;
  let distance = Infinity;
  for (let step = 0; step <= 100; step++) {
    const candidate = hsvToRgb({...hsv, v: step / 100});
    if (contrastRatio(candidate, behind) < target) continue;
    const away = Math.abs(step / 100 - hsv.v);
    if (away < distance) {
      distance = away;
      best = candidate;
    }
  }
  return best;
}
