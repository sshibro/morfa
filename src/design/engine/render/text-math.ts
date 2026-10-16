import type {LetterSpacing, TextDecoration} from '../../../../shared/design/types';

// Text drawing details that do not need a canvas. Pure, tested in node (tests/design-render-text.test.ts).
// The layout (shared/design/text-layout.ts) has already applied the text case, letter spacing and
// small capitals; drawing only places what it measured.

/** Letter spacing in px for a font size (PERCENT is of the font size, as in Figma). */
export const letterSpacingPx = (spacing: LetterSpacing | undefined, fontSize: number) =>
  !spacing ? 0 : spacing.unit === 'PIXELS' ? spacing.value : (spacing.value / 100) * fontSize;

/** Underline and strike-through as a filled rectangle under or through a run, in local px. Fonts
 *  carry their own positions in tables canvas cannot read, so these follow the line's metrics (the
 *  layout's largest ascent and descent, so one line's decorations stay level across sizes): an
 *  underline a quarter of the descent below the baseline, a strike 0.3 of the ascent above it,
 *  both 1/15 of the font size thick. */
export function decorationRect(decoration: TextDecoration, run: {x: number; width: number}, line: {baseline: number; ascent: number; descent: number}, fontSize: number): {x: number; y: number; width: number; height: number} | null {
  if (decoration === 'NONE' || !(run.width > 0) || !(fontSize > 0)) return null;
  const thickness = Math.max(fontSize / 15, 0.5);
  const centre = decoration === 'UNDERLINE' ? line.baseline + line.descent * 0.25 + thickness / 2 : line.baseline - line.ascent * 0.3;
  return {x: run.x, y: centre - thickness / 2, width: run.width, height: thickness};
}

type Segmenter = {segment(text: string): Iterable<{segment: string}>};
let segmenter: Segmenter | null | undefined;

/** Grapheme clusters of a string (manual letter spacing draws one cluster at a time). */
export function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    const Ctor = (Intl as unknown as {Segmenter?: new (locale: string | undefined, options: {granularity: 'grapheme'}) => Segmenter}).Segmenter;
    segmenter = Ctor ? new Ctor(undefined, {granularity: 'grapheme'}) : null;
  }
  return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text);
}

/** Text whose glyphs would be this small on screen (device px of the font size) is drawn as soft
 *  bars instead: it is unreadable, and real glyphs at that size cost as much as large ones. */
export const GREEK_BELOW_PX = 4;

/** The bar that stands for one run of tiny text: the run's width, half the font size tall, sitting
 *  on the baseline. */
export function greekBar(run: {x: number; width: number}, baseline: number, fontSize: number): {x: number; y: number; width: number; height: number} {
  const height = fontSize * 0.5;
  return {x: run.x, y: baseline - height, width: run.width, height};
}
