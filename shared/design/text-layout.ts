import type {Paint, SceneNode, TextCase, TextProps, TextRun, TextStyle} from './types';
import {
  canBreakAfterSpaces, canBreakBetween, caseGrapheme, graphemeBoundaries, hasLowercase, isBreakingSpace, isSimpleRange, LINE_SEPARATOR, nextGraphemeBoundary,
  paragraphRanges, prevGraphemeBoundary, SOFT_HYPHEN, startsWord, WORD_JOINER, wordEndAfter, wordStartBefore, ZERO_WIDTH_NO_BREAK_SPACE, ZERO_WIDTH_SPACE,
} from './text-segment';

import {engineFor, lazyInputs, withEngine} from './engine-switch';
import {codeUnits, textFonts, textWasm, viaEngine, type TextWasm} from './text-engine';

export {paragraphAt, wordAt} from './text-segment';

// Text layout of TEXT nodes: one implementation for drawing, hit testing, caret placement,
// auto-resize and export, so what the editor measures is what it paints. Measuring is injected
// (`TextMeasurer`): the browser measures with a 2D canvas context, tests with a fixed-width fake.
//
// The pipeline, per paragraph ("\n"): graphemes in the style of their run (textCase applied to
// what is displayed, each grapheme remembering its source offsets) → widths, measured a word at a
// time so kerning inside words matches a canvas `fillText` of the whole run → greedy line breaking
// at spaces, after hyphens/dashes/slashes and inside a word only when it alone is wider than the
// box → line heights and baselines (Figma's half-leading split) → paragraph spacing, indents and
// list markers → TRUNCATE's ellipsis → alignment and justification → vertical alignment.
//
// Results are cached on the identity of `node.text` (documents are immutable), and widths are
// cached per measurer, so re-rendering an unchanged canvas measures nothing.

export type FontSpec = {family: string; weight: number; italic: boolean; size: number};

export interface TextMeasurer {
  /** Advance width in px of `text` set in `font`, without letter spacing. */
  width(text: string, font: FontSpec): number;
  /** Ascent above and descent below the baseline in px, both positive. */
  metrics(font: FontSpec): {ascent: number; descent: number};
  /** Optional: changes whenever the same call would now measure differently (a face finished loading
   *  and replaced its fallback). Widths and layouts cached under another revision are dropped.
   *  A measurer without it can call `forgetMeasurements` instead. */
  readonly revision?: number;
}

/** A piece of one line in one style. `x` is from the node's left edge. Draw `text` as it is at
 *  (`x`, line baseline) with `font` and `letterSpacing`: the text case is already applied, zero-width
 *  format characters and tabs are left out (a tab is a run of its own with empty text), a soft
 *  hyphen the line broke at shows as "-", and TRUNCATE's "…" is a run of its own. In justified
 *  lines a run ends after every widened space, so each run still draws with plain spacing. */
export type GlyphRun = {
  text: string;
  /** Source offsets in `characters`, end exclusive. Equal for the ellipsis. */
  start: number;
  end: number;
  x: number;
  width: number;
  /** The resolved style (base style + run). SMALL_CAPS letters carry the reduced size they are drawn at. */
  style: TextStyle;
  fills: Paint[];
  /** The face to draw with (`fontSpecOf(style)`). */
  font: FontSpec;
  /** Px added after every grapheme; included in `width` and `xs`. */
  letterSpacing: number;
  /** Caret stops of the run: the source offsets of its grapheme boundaries, `start` … `end`, and the
   *  x of each from the node's left edge. A grapheme that displays as several letters (ß → SS) is one stop. */
  offsets: number[];
  xs: number[];
  /** TRUNCATE's "…" (start === end). */
  ellipsis?: boolean;
};

/** The marker of a list paragraph's first line, drawn on that line's baseline. */
export type ListMarker = {text: string; x: number; width: number; style: TextStyle; fills: Paint[]; font: FontSpec};

export type TextLine = {
  runs: GlyphRun[];
  /** Character offsets of the line in `characters`, end exclusive (the trailing newline is outside). */
  start: number;
  end: number;
  /** Left edge after alignment and indent, from the node's left edge. */
  x: number;
  /** Top of the line box and the baseline, from the node's top edge (vertical alignment applied). */
  top: number;
  baseline: number;
  /** Width of the ink, without the spaces that hang at a wrapped line's end. */
  width: number;
  height: number;
  paragraphIndex: number;
  /** "1." or "•" on the first line of a list paragraph. */
  listMarker?: string;
  marker?: ListMarker;
  /** Largest font ascent above and descent below the baseline (without leading): decorations, the caret. */
  ascent: number;
  descent: number;
  /** The box wrapped the line: the next line starts at this line's `end`. */
  wrapped: boolean;
};

export type TextLayout = {
  /** The width lines were aligned in: the given box width, or the natural width when unconstrained. */
  width: number;
  /** Height of the laid-out lines with paragraph spacing (TRUNCATE: the kept lines). */
  height: number;
  lines: TextLine[];
  truncated: boolean;
  /** The widest line with its indent: the box width of WIDTH_AND_HEIGHT text and of hugging text. */
  naturalWidth: number;
  /** `characters.length`, for clamping offsets. */
  length: number;
};

export const fontSpecOf = (style: TextStyle): FontSpec => ({family: style.fontFamily, weight: style.fontWeight, italic: style.italic, size: style.fontSize});

// ── Measuring ──────────────────────────────────────────────────────────────────────────────────

type FontEntry = {
  spec: FontSpec;
  /** Advance widths by string, and of single UTF-16 code units by code (no string needed). */
  widths: Map<string, number>;
  codes: Map<number, number>;
  ascent: number;
  descent: number;
};
/** Faces by family → size → weight·2 + italic: no key strings are built per lookup. */
type FontTable = Map<string, Map<number, Map<number, FontEntry>>>;
type MeasureCache = {revision: number | undefined; generation: number; fonts: FontTable};

const measureCaches = new WeakMap<TextMeasurer, MeasureCache>();
/** Distinct strings remembered per face before the face's table starts over. */
const MAX_CACHED_WIDTHS = 50_000;

function measureCache(measurer: TextMeasurer): MeasureCache {
  let cache = measureCaches.get(measurer);
  if (!cache) {
    cache = {revision: measurer.revision, generation: 0, fonts: new Map()};
    measureCaches.set(measurer, cache);
  } else if (cache.revision !== measurer.revision) {
    cache.revision = measurer.revision;
    cache.generation++;
    cache.fonts = new Map();
  }
  return cache;
}

/** How many times the widths cached for `measurer` were dropped (its revision changed, or `forgetMeasurements`): what
 *  a cache kept elsewhere for the same measurer (Rust normalize's, lane E1) compares to know it must start over. */
export const measurementEpoch = (measurer: TextMeasurer): number => measureCache(measurer).generation;

/** Drops every width, metric and layout cached for `measurer` (a font finished loading). */
export function forgetMeasurements(measurer: TextMeasurer): void {
  const cache = measureCaches.get(measurer);
  if (!cache) return;
  cache.generation++;
  cache.fonts = new Map();
}

function fontEntry(cache: MeasureCache, measurer: TextMeasurer, style: TextStyle): FontEntry {
  const size = style.fontSize;
  let bySize = cache.fonts.get(style.fontFamily);
  if (!bySize) cache.fonts.set(style.fontFamily, (bySize = new Map()));
  let byFace = bySize.get(size);
  if (!byFace) bySize.set(size, (byFace = new Map()));
  const face = style.fontWeight * 2 + (style.italic ? 1 : 0);
  let entry = byFace.get(face);
  if (!entry) {
    const spec: FontSpec = {family: style.fontFamily, weight: style.fontWeight, italic: style.italic, size};
    const metrics = measurer.metrics(spec);
    entry = {spec, widths: new Map(), codes: new Map(), ascent: finite(metrics.ascent), descent: finite(metrics.descent)};
    byFace.set(face, entry);
  }
  return entry;
}

function measure(measurer: TextMeasurer, font: FontEntry, text: string): number {
  if (!text) return 0;
  let width = font.widths.get(text);
  if (width === undefined) {
    width = finite(measurer.width(text, font.spec));
    if (font.widths.size >= MAX_CACHED_WIDTHS) font.widths.clear();
    font.widths.set(text, width);
  }
  return width;
}

function measureCode(measurer: TextMeasurer, font: FontEntry, code: number): number {
  let width = font.codes.get(code);
  if (width === undefined) {
    width = finite(measurer.width(String.fromCharCode(code), font.spec));
    font.codes.set(code, width);
  }
  return width;
}

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

// ── Styles of the text ─────────────────────────────────────────────────────────────────────────

/** One resolved style of the text, with what layout needs from it computed once. */
type Slot = {
  style: TextStyle;
  fills: Paint[];
  font: FontEntry;
  /** SMALL_CAPS: the reduced face for letters typed in lower case. */
  small: FontEntry | null;
  smallStyle: TextStyle | null;
  textCase: TextCase;
  letterSpacing: number;
  lineHeight: number;
  /** Line box above / below the baseline: ascent or descent plus half the leading. */
  above: number;
  below: number;
  ascent: number;
  descent: number;
};

/** SMALL_CAPS draws lower-case letters as capitals at this fraction of the size. */
const SMALL_CAPS_SCALE = 0.8;
/** Without font metrics (a face still loading in a fake measurer) AUTO line height is ≈1.2 em,
 *  split like Inter's ascender and descender. */
const FALLBACK_ASCENT = 0.96, FALLBACK_DESCENT = 0.24;
/** Rounding slack: a line laid out again at its own measured width must not wrap. */
const EPS = 0.01;

function resolveStyle(base: TextStyle, partial: Partial<TextStyle>): TextStyle {
  const style = {...base};
  for (const key of Object.keys(partial) as (keyof TextStyle)[]) {
    const value = partial[key];
    if (value !== undefined) (style as Record<string, unknown>)[key] = value;
  }
  return style;
}

function makeSlot(style: TextStyle, fills: Paint[], cache: MeasureCache, measurer: TextMeasurer): Slot {
  const size = Math.max(0, finite(style.fontSize));
  const font = fontEntry(cache, measurer, style);
  let ascent = font.ascent, descent = font.descent;
  if (!(ascent + descent > 0)) {
    ascent = size * FALLBACK_ASCENT;
    descent = size * FALLBACK_DESCENT;
  }
  const lh = style.lineHeight;
  const lineHeight = Math.max(0, lh.unit === 'PIXELS' ? finite(lh.value) : lh.unit === 'PERCENT' ? (finite(lh.value) / 100) * size : ascent + descent);
  const halfLeading = (lineHeight - ascent - descent) / 2;
  const ls = style.letterSpacing;
  const letterSpacing = ls ? (ls.unit === 'PIXELS' ? finite(ls.value) : (finite(ls.value) / 100) * size) : 0;
  const smallCaps = style.textCase === 'SMALL_CAPS';
  const smallStyle = smallCaps ? {...style, fontSize: size * SMALL_CAPS_SCALE} : null;
  return {
    style, fills, font, small: smallStyle ? fontEntry(cache, measurer, smallStyle) : null, smallStyle,
    textCase: style.textCase ?? 'ORIGINAL', letterSpacing, lineHeight, above: ascent + halfLeading, below: descent + halfLeading, ascent, descent,
  };
}

// ── Units: one grapheme each ───────────────────────────────────────────────────────────────────

const INK = 0, SPACE = 1, TAB = 2, HIDDEN = 3, SEPARATOR = 4;
type UnitKind = typeof INK | typeof SPACE | typeof TAB | typeof HIDDEN | typeof SEPARATOR;

type Unit = {
  /** Source offsets in `characters`. */
  start: number;
  end: number;
  /** The first code point. */
  cp: number;
  /** What is drawn when it differs from the characters as typed (text case applied, empty for
   *  invisible characters, "-" for a soft hyphen the line breaks at); null: `characters[start, end)`. */
  text: string | null;
  slot: number;
  /** A SMALL_CAPS letter drawn with the reduced face. */
  small: boolean;
  kind: UnitKind;
  width: number;
  /** Break opportunity after this unit: 0 none, 1 allowed, 2 forced (U+2028). */
  brk: 0 | 1 | 2;
  /** A soft hyphen: shows "-" when the line breaks at it. */
  shy: boolean;
  /** Justification stretches it (breaking spaces and U+00A0, as CSS word separators). */
  stretch: boolean;
  /** Pen position from the line's left edge, set when the line is placed. */
  x: number;
};

/** Zero-width format characters: never drawn, never measured. */
const isHiddenCode = (cp: number) =>
  cp === SOFT_HYPHEN || cp === ZERO_WIDTH_SPACE || cp === WORD_JOINER || cp === ZERO_WIDTH_NO_BREAK_SPACE || cp === 0x200c || cp === 0x200d || cp === 0x200e || cp === 0x200f;

type Ctx = {
  chars: string;
  measurer: TextMeasurer;
  slots: Slot[];
  /** Slot index of every code unit; null when the text has no runs (everything is slot 0). */
  slotOf: Uint16Array | Uint32Array | null;
};

function makeUnit(ctx: Ctx, start: number, end: number): Unit {
  const {chars} = ctx;
  const slotIndex = ctx.slotOf ? ctx.slotOf[start] : 0;
  const slot = ctx.slots[slotIndex];
  const cp = chars.codePointAt(start)!;
  let text: string | null = null;
  let kind: UnitKind = INK, small = false;
  if (isBreakingSpace(cp)) {
    kind = cp === 0x09 ? TAB : SPACE;
    if (kind === TAB) text = '';
  } else if (cp === LINE_SEPARATOR) {
    kind = SEPARATOR;
    text = '';
  } else if (isHiddenCode(cp)) {
    kind = HIDDEN;
    text = '';
  } else if (slot.textCase !== 'ORIGINAL') {
    const typed = chars.slice(start, end);
    if (slot.textCase === 'SMALL_CAPS') {
      if (hasLowercase(typed)) {
        small = true;
        text = typed.toUpperCase();
      }
    } else {
      text = caseGrapheme(typed, slot.textCase, slot.textCase === 'TITLE' && startsWord(chars, start));
    }
    if (text === typed) text = null;
  }
  return {start, end, cp, text, slot: slotIndex, small, kind, width: 0, brk: 0, shy: cp === SOFT_HYPHEN, stretch: kind === SPACE || cp === 0xa0, x: 0};
}

function buildUnits(ctx: Ctx, from: number, to: number): Unit[] {
  const units: Unit[] = [];
  if (isSimpleRange(ctx.chars, from, to)) {
    for (let i = from; i < to; i++) units.push(makeUnit(ctx, i, i + 1));
  } else {
    const bounds = graphemeBoundaries(ctx.chars, from, to);
    for (let g = 0; g < bounds.length - 1; g++) units.push(makeUnit(ctx, bounds[g], bounds[g + 1]));
  }
  for (let g = 0; g < units.length; g++) {
    const unit = units[g], next = units[g + 1];
    if (unit.kind === SEPARATOR) unit.brk = 2;
    else if (!next || next.kind === SEPARATOR) unit.brk = 0;
    else if (unit.kind === SPACE || unit.kind === TAB) unit.brk = next.kind !== SPACE && next.kind !== TAB && canBreakAfterSpaces(next.cp) ? 1 : 0;
    else if (next.kind === SPACE || next.kind === TAB) unit.brk = 0;
    else unit.brk = canBreakBetween(g > 0 ? units[g - 1].cp : -1, unit.cp, next.cp) ? 1 : 0;
  }
  return units;
}

const fontOf = (slot: Slot, unit: Unit) => (unit.small && slot.small ? slot.small : slot.font);
const displayOf = (chars: string, unit: Unit) => unit.text ?? chars.slice(unit.start, unit.end);

/** Advance of one unit alone, without letter spacing. */
const advanceOf = (ctx: Ctx, font: FontEntry, unit: Unit) =>
  unit.text === null && unit.end - unit.start === 1 ? measureCode(ctx.measurer, font, unit.cp) : measure(ctx.measurer, font, displayOf(ctx.chars, unit));

/** Widths of the units. A word in one face is measured whole (its kerning is what `fillText`
 *  draws) and its graphemes share that width in proportion to their own advances, so caret stops
 *  inside the word land where the letters are. */
function measureUnits(ctx: Ctx, units: Unit[]) {
  const {measurer, slots} = ctx;
  let i = 0;
  while (i < units.length) {
    const unit = units[i];
    const slot = slots[unit.slot];
    if (unit.kind === HIDDEN || unit.kind === SEPARATOR) {
      unit.width = 0;
      i++;
      continue;
    }
    const font = fontOf(slot, unit);
    if (unit.kind === TAB) {
      unit.width = 4 * measure(measurer, font, ' ') + slot.letterSpacing;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < units.length && units[j - 1].brk === 0 && units[j].slot === unit.slot && units[j].small === unit.small && units[j].kind === unit.kind) j++;
    if (j === i + 1) {
      unit.width = advanceOf(ctx, font, unit) + slot.letterSpacing;
    } else {
      let sum = 0, typed = true;
      for (let k = i; k < j; k++) {
        units[k].width = advanceOf(ctx, font, units[k]);
        sum += units[k].width;
        typed &&= units[k].text === null;
      }
      let piece = '';
      if (typed) piece = ctx.chars.slice(unit.start, units[j - 1].end);
      else for (let k = i; k < j; k++) piece += displayOf(ctx.chars, units[k]);
      const whole = measure(measurer, font, piece);
      const scale = sum > 0 ? whole / sum : 0;
      for (let k = i; k < j; k++) units[k].width = units[k].width * scale + slot.letterSpacing;
    }
    i = j;
  }
}

const hyphenWidth = (ctx: Ctx, unit: Unit) => {
  const slot = ctx.slots[unit.slot];
  return measure(ctx.measurer, slot.font, '-') + slot.letterSpacing;
};

// ── Line breaking ──────────────────────────────────────────────────────────────────────────────

/** Units [from, to) of one line; `next` is where the following line starts (past a U+2028). */
type Span = {from: number; to: number; next: number; forced: boolean; hyphen: boolean};

/** Greedy breaking, as Figma and browsers do: a line takes words while they fit; spaces never
 *  push a word down (they hang past the edge); a word alone on a line that is still too wide is
 *  broken between graphemes. `avail` is Infinity when the width is unconstrained. */
function breakLines(ctx: Ctx, units: Unit[], firstAvail: number, restAvail: number): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (;;) {
    const avail = spans.length ? restAvail : firstAvail;
    let x = 0, candidate = -1, candidateHyphen = false, ink = false;
    let to = -1, next = -1, forced = false, hyphen = false;
    for (let i = from; i < units.length; i++) {
      const unit = units[i];
      if (unit.kind === SEPARATOR) {
        to = i;
        next = i + 1;
        forced = true;
        break;
      }
      if (unit.kind !== SPACE && unit.width > 0 && x + unit.width > avail + EPS && (ink || candidate >= from)) {
        if (candidate >= from) {
          to = next = candidate + 1;
          hyphen = candidateHyphen;
        } else {
          to = next = i;
        }
        break;
      }
      x += unit.width;
      if (unit.kind === INK || unit.kind === TAB) ink = true;
      if (unit.brk === 1) {
        if (!unit.shy) {
          candidate = i;
          candidateHyphen = false;
        } else if (x + hyphenWidth(ctx, unit) <= avail + EPS) {
          candidate = i;
          candidateHyphen = true;
        }
      }
    }
    if (to < 0) to = next = units.length;
    spans.push({from, to, next, forced, hyphen});
    if (next >= units.length) {
      if (forced) spans.push({from: next, to: next, next, forced: false, hyphen: false});
      return spans;
    }
    from = next;
  }
}

// ── Lines ──────────────────────────────────────────────────────────────────────────────────────

type Draft = {
  units: Unit[];
  span: Span;
  paragraphIndex: number;
  /** Units [from, to) drawn on the line (TRUNCATE may shorten `to`). */
  to: number;
  start: number;
  end: number;
  /** Left inset of the line's box (paragraph indent on a first line, a list's hanging indent). */
  inset: number;
  /** Ink width: up to the last unit that is not a hanging space. */
  ink: number;
  height: number;
  above: number;
  ascent: number;
  descent: number;
  lastInParagraph: boolean;
  wrapped: boolean;
  top: number;
  marker: {text: string; slot: number; width: number; indent: number} | null;
  ellipsis: {slot: number; width: number} | null;
};

/** Pen positions of the units of a line from its left edge; returns the ink width. */
function placeUnits(units: Unit[], from: number, to: number): number {
  let x = 0, ink = 0;
  for (let i = from; i < to; i++) {
    const unit = units[i];
    unit.x = x;
    x += unit.width;
    if (unit.kind === INK || unit.kind === TAB || (unit.kind === HIDDEN && unit.text)) ink = x;
  }
  return ink;
}

/** Height and baseline of a line from every style on it. An empty line takes the style of where
 *  it stands (`fallbackSlot`); a paragraph's last line also counts its line break (`breakSlot`,
 *  -1 for none), as in Figma, where a large invisible return keeps its line tall. */
function lineMetrics(ctx: Ctx, draft: Draft, units: Unit[], from: number, to: number, fallbackSlot: number, breakSlot: number) {
  let height = 0, above = -Infinity, ascent = 0, descent = 0, last = -1;
  for (let i = from; i <= to + 1; i++) {
    const index = i < to ? units[i].slot : i === to ? (last < 0 ? fallbackSlot : -1) : breakSlot;
    if (index < 0 || index === last) continue;
    last = index;
    const slot = ctx.slots[index];
    if (slot.lineHeight > height) height = slot.lineHeight;
    if (slot.above > above) above = slot.above;
    if (slot.ascent > ascent) ascent = slot.ascent;
    if (slot.descent > descent) descent = slot.descent;
  }
  draft.height = height;
  draft.above = above;
  draft.ascent = ascent;
  draft.descent = descent;
}

const markerText = (type: 'ORDERED' | 'UNORDERED', number: number) => (type === 'ORDERED' ? `${number}.` : '•');

/** `textPath`: a text on a path ("Text on path") is laid out as unwrapped lines (shared/design/text-path.ts bends them). */
type LayoutNode = Pick<SceneNode, 'width' | 'height' | 'fills'> & {text?: TextProps; textPath?: unknown};

/** `onPath`: neither truncated nor aligned in a box (a text on a path). */
function computeLayout(text: TextProps, fills: Paint[], measurer: TextMeasurer, cache: MeasureCache, width: number | null, boxHeight: number, onPath = false): TextLayout {
  const chars = text.characters ?? '';
  const length = chars.length;

  // Styles: slot 0 is the base; each run resolves once.
  const slots: Slot[] = [makeSlot(text.style, fills, cache, measurer)];
  const runs = text.runs ?? [];
  const slotOf = !runs.length ? null : runs.length < 0xfffe ? new Uint16Array(length) : new Uint32Array(length);
  for (const run of runs) {
    const start = Math.max(0, run.start), end = Math.min(length, run.end);
    if (!(end > start)) continue;
    const index = slots.length;
    slots.push(makeSlot(resolveStyle(text.style, run.style ?? {}), run.fills ?? fills, cache, measurer));
    slotOf!.fill(index, start, end);
  }
  const ctx: Ctx = {chars, measurer, slots, slotOf};
  const slotAt = (offset: number) => (length && slotOf ? slotOf[Math.max(0, Math.min(length - 1, offset))] : 0);

  const constrained = width !== null && Number.isFinite(width);
  const boxWidth = constrained ? Math.max(0, width) : Infinity;
  const paragraphs = paragraphRanges(chars);
  const listTypes = text.listTypes ?? [];
  const indent = Math.max(0, finite(text.paragraphIndent ?? 0));

  // List markers: numbering runs over consecutive ORDERED paragraphs; every paragraph of a list
  // block shares the block's hanging indent, so the texts of "9." and "10." line up.
  const markers: Draft['marker'][] = [];
  for (let p = 0; p < paragraphs.length;) {
    const type = listTypes[p];
    if (type !== 'ORDERED' && type !== 'UNORDERED') {
      p++;
      continue;
    }
    let q = p, widest = 0;
    for (; q < paragraphs.length && listTypes[q] === type; q++) {
      const slot = slotAt(paragraphs[q].start);
      const label = markerText(type, q - p + 1);
      const width = measure(measurer, slots[slot].font, label);
      widest = Math.max(widest, width);
      markers[q] = {text: label, slot, width, indent: 0};
    }
    for (let k = p; k < q; k++) {
      const marker = markers[k]!;
      const size = slots[marker.slot].style.fontSize;
      marker.indent = Math.max(size * 1.5, widest + size * 0.5);
    }
    p = q;
  }

  const drafts: Draft[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const units = buildUnits(ctx, paragraph.start, paragraph.end);
    measureUnits(ctx, units);
    const marker = markers[paragraphIndex] ?? null;
    const firstInset = marker ? marker.indent : indent;
    const restInset = marker ? marker.indent : 0;
    const spans = breakLines(ctx, units, boxWidth - firstInset, boxWidth - restInset);
    const emptySlot = units.length ? units[units.length - 1].slot : slotAt(paragraph.start < length ? paragraph.start : paragraph.start - 1);
    spans.forEach((span, index) => {
      if (span.hyphen) {
        const shy = units[span.to - 1];
        shy.text = '-';
        shy.width = hyphenWidth(ctx, shy);
      }
      const start = span.from < span.to ? units[span.from].start : span.from < units.length ? units[span.from].start : units.length ? units[units.length - 1].end : paragraph.start;
      const end = span.from < span.to ? units[span.to - 1].end : start;
      const draft: Draft = {
        units, span, paragraphIndex, to: span.to, start, end, inset: index === 0 ? firstInset : restInset, ink: placeUnits(units, span.from, span.to),
        height: 0, above: 0, ascent: 0, descent: 0, lastInParagraph: index === spans.length - 1, wrapped: !span.forced && index < spans.length - 1,
        top: 0, marker: index === 0 ? marker : null, ellipsis: null,
      };
      const breakSlot = index === spans.length - 1 && paragraph.end < length ? slotAt(paragraph.end) : -1;
      lineMetrics(ctx, draft, units, span.from, span.to, span.from < units.length ? units[span.from].slot : emptySlot, breakSlot);
      drafts.push(draft);
    });
  });

  // Stack the lines: paragraph spacing goes between paragraphs.
  const spacing = finite(text.paragraphSpacing ?? 0);
  let y = 0;
  drafts.forEach((draft, i) => {
    if (i > 0 && draft.paragraphIndex !== drafts[i - 1].paragraphIndex) y += spacing;
    draft.top = y;
    y += draft.height;
  });
  let naturalWidth = 0;
  for (const draft of drafts) naturalWidth = Math.max(naturalWidth, draft.inset + draft.ink);

  // TRUNCATE: keep the lines that fit the box (at least one) and at most `maxLines`.
  let kept = drafts.length, truncated = false;
  if (text.textAutoResize === 'TRUNCATE' && !onPath) {
    const maxLines = text.maxLines && text.maxLines > 0 ? Math.floor(text.maxLines) : Infinity;
    let fit = 0;
    while (fit < drafts.length && fit < maxLines && drafts[fit].top + drafts[fit].height <= boxHeight + EPS) fit++;
    kept = Math.max(1, fit);
    if (kept < drafts.length) {
      truncated = true;
      truncateLine(ctx, drafts[kept - 1], boxWidth - drafts[kept - 1].inset);
    }
  }
  const lines = kept === drafts.length ? drafts : drafts.slice(0, kept);
  const contentHeight = lines.length ? lines[lines.length - 1].top + lines[lines.length - 1].height : 0;

  const alignWidth = constrained ? boxWidth : naturalWidth;
  const fixedHeight = !onPath && (text.textAutoResize === 'NONE' || text.textAutoResize === 'TRUNCATE');
  const free = fixedHeight ? finite(boxHeight) - contentHeight : 0;
  const shift = text.textAlignVertical === 'CENTER' ? free / 2 : text.textAlignVertical === 'BOTTOM' ? free : 0;

  return {
    width: alignWidth,
    height: contentHeight,
    lines: lines.map(draft => finishLine(ctx, draft, alignWidth, text.textAlignHorizontal, shift)),
    truncated,
    naturalWidth,
    length,
  };
}

/** Shortens the last kept line of a truncated text so its ink and a "…" fit `avail`; the spaces
 *  before the ellipsis go. The ellipsis takes the style of the last character kept. */
function truncateLine(ctx: Ctx, draft: Draft, avail: number) {
  const {units} = draft;
  const from = draft.span.from;
  // A soft hyphen no longer ends the line.
  if (draft.span.hyphen) {
    const shy = units[draft.span.to - 1];
    shy.text = '';
    shy.width = 0;
  }
  const ellipsisFor = (slotIndex: number) => {
    const slot = ctx.slots[slotIndex];
    return measure(ctx.measurer, slot.font, '…') + slot.letterSpacing;
  };
  let to = draft.to;
  for (;;) {
    while (to > from && units[to - 1].kind !== INK && units[to - 1].kind !== TAB) to--;
    const slot = to > from ? units[to - 1].slot : from < units.length ? units[from].slot : 0;
    const ink = placeUnits(units, from, to);
    const width = ellipsisFor(slot);
    if (to === from || ink + width <= avail + EPS) {
      draft.to = to;
      draft.end = to > from ? units[to - 1].end : draft.start;
      draft.ink = ink + width;
      draft.ellipsis = {slot, width};
      draft.wrapped = false;
      return;
    }
    to--;
  }
}

function finishLine(ctx: Ctx, draft: Draft, alignWidth: number, align: TextProps['textAlignHorizontal'], shift: number): TextLine {
  const {units, span} = draft;
  const from = span.from, to = draft.to;
  const avail = alignWidth - draft.inset;
  let x = draft.inset, inkWidth = draft.ink, justified = false;
  // Justify every line but a paragraph's last (and one a U+2028 ends) by widening its inner spaces.
  if (align === 'JUSTIFIED' && !draft.lastInParagraph && !span.forced && !draft.ellipsis && avail > inkWidth && Number.isFinite(avail)) {
    let lastInk = to - 1;
    while (lastInk >= from && units[lastInk].kind === SPACE) lastInk--;
    let count = 0;
    for (let i = from; i < lastInk; i++) if (units[i].stretch) count++;
    if (count) {
      const extra = (avail - inkWidth) / count;
      for (let i = from; i < lastInk; i++) if (units[i].stretch) units[i].width += extra;
      placeUnits(units, from, to);
      inkWidth = avail;
      justified = true;
    }
  } else if (align === 'CENTER') {
    x += Math.max(0, (avail - inkWidth) / 2);
  } else if (align === 'RIGHT') {
    x += Math.max(0, avail - inkWidth);
  }
  if (!Number.isFinite(x)) x = draft.inset;

  const runs: GlyphRun[] = [];
  let run: GlyphRun | null = null;
  let prev: Unit | null = null;
  // A run drawn as typed takes its text as one slice of `characters`; others join their units.
  let first = from, typed = true;
  const close = (end: number) => {
    if (!run) return;
    if (typed) run.text = ctx.chars.slice(run.start, run.end);
    else for (let k = first; k < end; k++) run.text += displayOf(ctx.chars, units[k]);
  };
  for (let i = from; i < to; i++) {
    const unit = units[i];
    const slot = ctx.slots[unit.slot];
    const pen = x + unit.x;
    if (!run || !prev || unit.slot !== prev.slot || unit.small !== prev.small || unit.kind === TAB || prev.kind === TAB || (justified && prev.stretch)) {
      close(i);
      run = {
        text: '', start: unit.start, end: unit.start, x: pen, width: 0, style: unit.small && slot.smallStyle ? slot.smallStyle : slot.style, fills: slot.fills,
        font: fontOf(slot, unit).spec, letterSpacing: slot.letterSpacing, offsets: [unit.start], xs: [pen],
      };
      runs.push(run);
      first = i;
      typed = true;
    }
    if (unit.text !== null) typed = false;
    run.end = unit.end;
    run.width = pen + unit.width - run.x;
    run.offsets.push(unit.end);
    run.xs.push(pen + unit.width);
    prev = unit;
  }
  close(to);
  if (draft.ellipsis) {
    const slot = ctx.slots[draft.ellipsis.slot];
    const ex = x + (to > from ? units[to - 1].x + units[to - 1].width : 0);
    runs.push({
      text: '…', start: draft.end, end: draft.end, x: ex, width: draft.ellipsis.width, style: slot.style, fills: slot.fills, font: slot.font.spec,
      letterSpacing: slot.letterSpacing, offsets: [draft.end], xs: [ex], ellipsis: true,
    });
  }

  const top = draft.top + shift;
  const line: TextLine = {
    runs, start: draft.start, end: draft.end, x, top, baseline: top + draft.above, width: inkWidth, height: draft.height,
    paragraphIndex: draft.paragraphIndex, ascent: draft.ascent, descent: draft.descent, wrapped: draft.wrapped,
  };
  if (draft.marker) {
    const slot = ctx.slots[draft.marker.slot];
    line.listMarker = draft.marker.text;
    line.marker = {text: draft.marker.text, x: x - draft.marker.indent, width: draft.marker.width, style: slot.style, fills: slot.fills, font: slot.font.spec};
  }
  return line;
}

// ── Entry points ───────────────────────────────────────────────────────────────────────────────

type CacheEntry = {measurer: TextMeasurer; generation: number; fills: Paint[]; width: number | null; height: number; onPath: boolean; layout: TextLayout};
const layoutCache = new WeakMap<TextProps, CacheEntry[]>();
/** Layouts remembered per text object: the canvas, an auto-layout measure pass and an export at once. */
const CACHED_LAYOUTS = 4;

/** Lays out `node.text` in a box `width` wide (null: no wrapping, as WIDTH_AND_HEIGHT). The result is
 *  shared between callers for the same text object, fills, width and measurer: never mutate it. A text on a path is
 *  always laid out unwrapped and untruncated, whatever `width` says. */
export function layoutText(node: LayoutNode, measurer: TextMeasurer, width: number | null = node.text?.textAutoResize === 'WIDTH_AND_HEIGHT' ? null : node.width): TextLayout {
  const text = node.text;
  if (!text) return {width: 0, height: 0, lines: [], truncated: false, naturalWidth: 0, length: 0};
  const cache = measureCache(measurer);
  const fills = node.fills ?? [];
  const onPath = !!node.textPath;
  if (onPath) width = null;
  const fixedHeight = !onPath && (text.textAutoResize === 'NONE' || text.textAutoResize === 'TRUNCATE');
  const height = fixedHeight ? node.height : 0;
  let entries = layoutCache.get(text);
  if (entries) {
    for (const entry of entries) {
      if (entry.measurer === measurer && entry.generation === cache.generation && entry.fills === fills && entry.width === width && entry.height === height && entry.onPath === onPath) return entry.layout;
    }
  } else {
    entries = [];
    layoutCache.set(text, entries);
  }
  const layout = layoutSwitched(text, fills, measurer, cache, width, height, onPath);
  entries.unshift({measurer, generation: cache.generation, fills, width, height, onPath, layout});
  if (entries.length > CACHED_LAYOUTS) entries.length = CACHED_LAYOUTS;
  return layout;
}

/** Sizes in hundredths of a pixel, rounded up so the text fits its box again (no float noise). */
const roundUp = (value: number) => Math.ceil(value * 100 - 1e-6) / 100 || 0;

/** The size the node takes under its auto-resize mode: WIDTH_AND_HEIGHT → both from the text,
 *  HEIGHT → height from the text at the node's width, NONE/TRUNCATE → the node's own box. */
export function textBoxSize(node: LayoutNode, measurer: TextMeasurer): {width: number; height: number} {
  const mode = node.text?.textAutoResize ?? 'NONE';
  // A text on a path keeps the box of its path.
  if (!node.text || node.textPath || mode === 'NONE' || mode === 'TRUNCATE') return {width: node.width, height: node.height};
  const layout = layoutText(node, measurer, mode === 'WIDTH_AND_HEIGHT' ? null : node.width);
  return mode === 'WIDTH_AND_HEIGHT' ? {width: roundUp(layout.naturalWidth), height: roundUp(layout.height)} : {width: node.width, height: roundUp(layout.height)};
}

// ── Caret and selection geometry ───────────────────────────────────────────────────────────────

/** Which line an offset at a soft wrap belongs to: the end of the upper line (upstream) or the
 *  start of the lower one (downstream, the default, where typed text appears). */
export type Affinity = 'upstream' | 'downstream';
export type Caret = {x: number; top: number; height: number; baseline: number; lineIndex: number};
export type CaretDirection = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd' | 'wordLeft' | 'wordRight' | 'docStart' | 'docEnd';
export type CaretMove = {offset: number; goalX: number | undefined; affinity: Affinity};
export type SelectionRect = {x: number; y: number; width: number; height: number; lineIndex: number};

const clampOffset = (layout: TextLayout, offset: number) => Math.max(0, Math.min(layout.length, Number.isFinite(offset) ? offset : 0));

/** Index of the line holding `offset` (offsets hidden by truncation belong to the last line). */
function lineIndexAtTs(layout: TextLayout, offset: number, affinity: Affinity = 'downstream'): number {
  const {lines} = layout;
  if (!lines.length) return -1;
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  if (affinity === 'upstream' && lo > 0 && lines[lo].start === offset && lines[lo - 1].wrapped && lines[lo - 1].end === offset) return lo - 1;
  return lo;
}

/** x of a caret at `offset` on `line`; offsets past the visible end stick to it. */
function xOnLine(line: TextLine, offset: number): number {
  let last: GlyphRun | null = null;
  for (const run of line.runs) {
    if (run.ellipsis) continue;
    if (offset <= run.end) {
      const {offsets, xs} = run;
      let lo = 0, hi = offsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return xs[lo];
    }
    last = run;
  }
  return last ? last.xs[last.xs.length - 1] : line.x;
}

/** The caret box at `offset`: the full height of its line box, as in Figma. */
function caretAtTs(layout: TextLayout, offset: number, affinity: Affinity = 'downstream'): Caret {
  const index = lineIndexAtTs(layout, clampOffset(layout, offset), affinity);
  if (index < 0) return {x: 0, top: 0, height: 0, baseline: 0, lineIndex: -1};
  const line = layout.lines[index];
  return {x: xOnLine(line, clampOffset(layout, offset)), top: line.top, height: line.height, baseline: line.baseline, lineIndex: index};
}

/** The offset nearest to `x` on one line. */
function offsetOnLine(line: TextLine, x: number): number {
  let best = line.start, bestDistance = Infinity;
  for (const run of line.runs) {
    if (run.ellipsis) continue;
    const {offsets, xs} = run;
    for (let k = 0; k < offsets.length; k++) {
      const distance = Math.abs(xs[k] - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = offsets[k];
      }
    }
  }
  return best;
}

/** The caret position a click at `point` (node-local px) lands on. Above the text → its first
 *  line, below → its last; in the gap between paragraphs → the nearer line. */
function offsetAtTs(layout: TextLayout, point: {x: number; y: number}): {offset: number; affinity: Affinity; lineIndex: number} {
  const {lines} = layout;
  if (!lines.length) return {offset: 0, affinity: 'downstream', lineIndex: -1};
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].top <= point.y) lo = mid;
    else hi = mid - 1;
  }
  let index = lo;
  const line = lines[index];
  if (point.y > line.top + line.height && index + 1 < lines.length && lines[index + 1].top - point.y < point.y - (line.top + line.height)) index++;
  const target = lines[index];
  const offset = offsetOnLine(target, point.x);
  return {offset, affinity: target.wrapped && offset === target.end ? 'upstream' : 'downstream', lineIndex: index};
}

/** Highlight rectangles of the selection [start, end), one per line it touches. A selected line
 *  break shows as a sliver past the line end, so selected empty lines stay visible. */
function selectionRectsTs(layout: TextLayout, start: number, end: number): SelectionRect[] {
  const from = clampOffset(layout, Math.min(start, end)), to = clampOffset(layout, Math.max(start, end));
  const rects: SelectionRect[] = [];
  if (from === to) return rects;
  layout.lines.forEach((line, lineIndex) => {
    if (line.start > to || (line.start === to && to > from)) return;
    const breakSelected = !line.wrapped && lineIndex < layout.lines.length - 1 && from <= line.end && to > line.end;
    const a = Math.max(from, line.start), b = Math.min(to, line.end);
    if (!(b > a) && !breakSelected) return;
    const x1 = xOnLine(line, a);
    let x2 = b > a ? xOnLine(line, b) : x1;
    if (breakSelected) x2 += Math.max(1, line.height * 0.25);
    rects.push({x: x1, y: line.top, width: Math.max(0, x2 - x1), height: line.height, lineIndex});
  });
  return rects;
}

/** The visual line holding `offset`: Home/End and the line highlight. */
function lineRangeTs(layout: TextLayout, offset: number, affinity: Affinity = 'downstream'): {start: number; end: number; lineIndex: number} {
  const index = lineIndexAtTs(layout, clampOffset(layout, offset), affinity);
  if (index < 0) return {start: 0, end: 0, lineIndex: -1};
  return {start: layout.lines[index].start, end: layout.lines[index].end, lineIndex: index};
}

/** Where a caret key moves the caret. ←/→ step over whole graphemes (an emoji, a letter with its
 *  accents); ↑/↓ keep the column the caret started from (`goalX`, returned for the next press);
 *  word moves follow macOS ⌥←/⌥→. Collapsing a selection is the caller's choice. */
function moveCaretTs(layout: TextLayout, text: string, offset: number, direction: CaretDirection, goalX?: number, affinity: Affinity = 'downstream'): CaretMove {
  const o = Math.max(0, Math.min(text.length, offset));
  const plain = (to: number): CaretMove => ({offset: to, goalX: undefined, affinity: 'downstream'});
  switch (direction) {
    case 'left': return plain(prevGraphemeBoundary(text, o));
    case 'right': return plain(nextGraphemeBoundary(text, o));
    case 'wordLeft': return plain(wordStartBefore(text, o));
    case 'wordRight': return plain(wordEndAfter(text, o));
    case 'docStart': return plain(0);
    case 'docEnd': return plain(text.length);
    case 'lineStart': {
      const index = lineIndexAtTs(layout, o, affinity);
      return plain(index < 0 ? 0 : layout.lines[index].start);
    }
    case 'lineEnd': {
      const index = lineIndexAtTs(layout, o, affinity);
      if (index < 0) return plain(text.length);
      const line = layout.lines[index];
      return {offset: line.end, goalX: undefined, affinity: line.wrapped ? 'upstream' : 'downstream'};
    }
    case 'up':
    case 'down': {
      const index = lineIndexAtTs(layout, o, affinity);
      if (index < 0) return plain(o);
      const x = goalX ?? xOnLine(layout.lines[index], o);
      const target = index + (direction === 'up' ? -1 : 1);
      if (target < 0) return {offset: 0, goalX: x, affinity: 'downstream'};
      if (target >= layout.lines.length) return {offset: text.length, goalX: x, affinity: 'downstream'};
      const line = layout.lines[target];
      const to = offsetOnLine(line, x);
      return {offset: to, goalX: x, affinity: line.wrapped && to === line.end ? 'upstream' : 'downstream'};
    }
  }
}

// ── The engine switch (shared/design/engine-switch.ts, module 'text') ──────────────────────────
// `computeLayout` and the caret functions above are the oracle; the Rust twins in crates/text run
// through the wasm build when the switch says `wasm`, and both run and must agree under `both`
// (`withEngine` compares exactly and throws `EngineDiffError`). A layout the wasm side produced remembers
// its id (not enumerable, so the comparison ignores it); under `both` the TypeScript layout borrows it, so
// the caret calls compare too; a layout the wasm side no longer holds falls back to the TypeScript.

const WASM_ID = Symbol('morfa.text.wasmLayout');
const measurerIds = new WeakMap<TextMeasurer, number>();
const measurerGenerations = new WeakMap<TextMeasurer, number>();
let nextMeasurerId = 1;
/** One FontSpec object per face for the measurer callbacks, as `fontEntry` gives the TypeScript layout. */
const specPool = new Map<string, FontSpec>();
/** The encoded props per text object (documents are immutable), and the id the wasm side keeps it under. */
const propsStreams = new WeakMap<TextProps, Float64Array>();
const textIds = new WeakMap<TextProps, number>();
let nextTextId = 1;
const dropKept =
  typeof FinalizationRegistry === 'undefined'
    ? null
    : new FinalizationRegistry<number>(id => {
        try {
          textWasm().text_drop(id);
        } catch {
          // The module is gone with the text.
        }
      });

function pooledSpec(family: string, weight: number, italic: boolean, size: number): FontSpec {
  const key = `${family}\u0000${weight}\u0000${italic ? 1 : 0}\u0000${size}`;
  let spec = specPool.get(key);
  if (!spec) specPool.set(key, (spec = {family, weight, italic, size}));
  return spec;
}

const ALIGN_H = {LEFT: 0, CENTER: 1, RIGHT: 2, JUSTIFIED: 3} as const;
const ALIGN_V = {TOP: 0, CENTER: 1, BOTTOM: 2} as const;
const RESIZE = {NONE: 0, WIDTH_AND_HEIGHT: 1, HEIGHT: 2, TRUNCATE: 3} as const;
const LIST = {NONE: 0, ORDERED: 1, UNORDERED: 2} as const;
const CASES = {ORIGINAL: 0, UPPER: 1, LOWER: 2, TITLE: 3, SMALL_CAPS: 4} as const;
const LH_UNIT = {AUTO: 0, PIXELS: 1, PERCENT: 2} as const;

/** `TextProps` as the f64 stream of crates/text/src/request.rs (its twin documents the format). */
function encodeProps(text: TextProps): Float64Array {
  const out: number[] = [];
  const pushString = (value: string) => {
    out.push(value.length);
    for (let i = 0; i < value.length; i++) out.push(value.charCodeAt(i));
  };
  const pushLineHeight = (lh: TextStyle['lineHeight']) => out.push(LH_UNIT[lh.unit] ?? 0, lh.unit === 'AUTO' ? 0 : lh.value);
  const pushLetterSpacing = (ls: TextStyle['letterSpacing'] | undefined) => out.push(ls ? LH_UNIT[ls.unit] ?? 0 : 0, ls ? ls.value : 0);
  const pushCase = (textCase: TextCase | undefined) => out.push(textCase === undefined ? -1 : CASES[textCase] ?? 0);
  const optional = (value: number | undefined | null) => (value === undefined || value === null ? NaN : value);
  out.push(ALIGN_H[text.textAlignHorizontal] ?? 0, ALIGN_V[text.textAlignVertical] ?? 0, RESIZE[text.textAutoResize] ?? 0);
  out.push(optional(text.paragraphSpacing), optional(text.paragraphIndent), optional(text.maxLines));
  const lists = text.listTypes ?? [];
  out.push(lists.length);
  for (const type of lists) out.push(LIST[type] ?? 0);
  const style = text.style;
  pushString(style.fontFamily);
  out.push(style.fontWeight, style.italic ? 1 : 0, style.fontSize);
  pushLineHeight(style.lineHeight);
  pushLetterSpacing(style.letterSpacing);
  pushCase(style.textCase);
  const runs = text.runs ?? [];
  out.push(runs.length);
  for (const run of runs) {
    const partial = run.style ?? {};
    let mask = 0;
    if (partial.fontFamily !== undefined) mask |= 1;
    if (partial.fontWeight !== undefined) mask |= 2;
    if (partial.italic !== undefined) mask |= 4;
    if (partial.fontSize !== undefined) mask |= 8;
    if (partial.lineHeight !== undefined) mask |= 16;
    if (partial.letterSpacing !== undefined) mask |= 32;
    if (partial.textCase !== undefined) mask |= 64;
    out.push(run.start, run.end, run.fills ? 1 : 0, mask);
    if (mask & 1) pushString(partial.fontFamily!);
    if (mask & 2) out.push(partial.fontWeight!);
    if (mask & 4) out.push(partial.italic ? 1 : 0);
    if (mask & 8) out.push(partial.fontSize!);
    if (mask & 16) pushLineHeight(partial.lineHeight!);
    if (mask & 32) pushLetterSpacing(partial.letterSpacing);
    if (mask & 64) pushCase(partial.textCase);
  }
  return Float64Array.from(out);
}

function propsOf(text: TextProps): Float64Array {
  let stream = propsStreams.get(text);
  if (!stream) propsStreams.set(text, (stream = encodeProps(text)));
  return stream;
}

type JsWidth = (...args: unknown[]) => number;
type JsMetrics = (...args: unknown[]) => {ascent: number; descent: number};

/** The measurer the wasm layout calls back: faces the fonts module holds measure there (harfrust),
 *  everything else asks `measurer` (the canvas, a fake). Also keeps the Rust width cache in step with
 *  `cache.generation`. */
function wasmMeasurer(mod: TextWasm, measurer: TextMeasurer, cache: MeasureCache): {id: number; width: JsWidth; metrics: JsMetrics} {
  let id = measurerIds.get(measurer);
  if (!id) measurerIds.set(measurer, (id = nextMeasurerId++));
  if (measurerGenerations.get(measurer) !== cache.generation) {
    mod.text_forget(id);
    measurerGenerations.set(measurer, cache.generation);
  }
  const engineFonts = textFonts();
  const width = ((piece: string, family: string, weight: number, italic: boolean, size: number) => {
    if (engineFonts) {
      const shaped = engineFonts.text_width(family, weight, italic, size, codeUnits(piece));
      if (!Number.isNaN(shaped)) return shaped;
    }
    return measurer.width(piece, pooledSpec(family, weight, italic, size));
  }) as JsWidth;
  const metrics = ((family: string, weight: number, italic: boolean, size: number) => {
    if (engineFonts) {
      const m = engineFonts.text_metrics(family, weight, italic, size);
      if (m.length) return {ascent: m[0], descent: m[1]};
    }
    return measurer.metrics(pooledSpec(family, weight, italic, size));
  }) as JsMetrics;
  return {id, width, metrics};
}

function layoutSwitched(text: TextProps, fills: Paint[], measurer: TextMeasurer, cache: MeasureCache, width: number | null, boxHeight: number, onPath: boolean): TextLayout {
  let wasmId: number | undefined;
  const layout = withEngine(
    'text',
    'layoutText',
    () => computeLayout(text, fills, measurer, cache, width, boxHeight, onPath),
    () => {
      const actual = wasmLayout(textWasm(), text, fills, measurer, cache, width, boxHeight, onPath);
      wasmId = wasmIdOf(actual);
      return actual;
    },
    {inputs: lazyInputs(() => ({characters: text.characters, width, boxHeight, onPath}))},
  );
  // Under `both` the TypeScript layout is returned: it borrows the kept wasm layout's id for the caret calls.
  if (wasmId !== undefined && wasmIdOf(layout) === undefined) Object.defineProperty(layout, WASM_ID, {value: wasmId, enumerable: false});
  return layout;
}

const params = (width: number | null, boxHeight: number, onPath: boolean) => Float64Array.of(width !== null && Number.isFinite(width) ? width : NaN, boxHeight, onPath ? 1 : 0);

function wasmLayout(mod: TextWasm, text: TextProps, fills: Paint[], measurer: TextMeasurer, cache: MeasureCache, width: number | null, boxHeight: number, onPath: boolean): TextLayout {
  const js = wasmMeasurer(mod, measurer, cache);
  const stream = mod.text_layout(codeUnits(text.characters ?? ''), params(width, boxHeight, onPath), propsOf(text), js.id, js.width, js.metrics);
  return decodeLayout(stream, 0, text, fills, text.runs ?? []).layout;
}

/** The id the wasm side keeps `text` under, sending it over once. */
function keptTextId(mod: TextWasm, text: TextProps): number {
  let id = textIds.get(text);
  if (id === undefined) {
    textIds.set(text, (id = nextTextId++));
    mod.text_put(id, codeUnits(text.characters ?? ''), propsOf(text));
    dropKept?.register(text, id);
  }
  return id;
}

/** `layoutText` for many nodes at once: one boundary crossing for every layout the cache misses (the
 *  wasm side keeps each text object after its first visit). Same results and cache as `layoutText`. */
export function layoutTextMany(nodes: readonly LayoutNode[], measurer: TextMeasurer, widths?: readonly (number | null | undefined)[]): TextLayout[] {
  const oneByOne = () => nodes.map((node, i) => (widths && widths[i] !== undefined ? layoutText(node, measurer, widths[i]) : layoutText(node, measurer)));
  if (engineFor('text') !== 'wasm') return oneByOne();
  return withEngine('text', 'layoutTextMany', oneByOne, () => batchedLayout(textWasm(), nodes, measurer, widths));
}

function batchedLayout(mod: TextWasm, nodes: readonly LayoutNode[], measurer: TextMeasurer, widths?: readonly (number | null | undefined)[]): TextLayout[] {
  const out: TextLayout[] = new Array(nodes.length);
  const cache = measureCache(measurer);
  const pending: {index: number; text: TextProps; fills: Paint[]; width: number | null; height: number; onPath: boolean}[] = [];
  nodes.forEach((node, i) => {
    const text = node.text;
    if (!text) {
      out[i] = {width: 0, height: 0, lines: [], truncated: false, naturalWidth: 0, length: 0};
      return;
    }
    const given = widths?.[i];
    let width = given !== undefined ? given : text.textAutoResize === 'WIDTH_AND_HEIGHT' ? null : node.width;
    const fills = node.fills ?? [];
    const onPath = !!node.textPath;
    if (onPath) width = null;
    const fixedHeight = !onPath && (text.textAutoResize === 'NONE' || text.textAutoResize === 'TRUNCATE');
    const height = fixedHeight ? node.height : 0;
    const hit = layoutCache.get(text)?.find(entry => entry.measurer === measurer && entry.generation === cache.generation && entry.fills === fills && entry.width === width && entry.height === height && entry.onPath === onPath);
    if (hit) out[i] = hit.layout;
    else pending.push({index: i, text, fills, width, height, onPath});
  });
  if (pending.length) {
    const js = wasmMeasurer(mod, measurer, cache);
    const ids = new Uint32Array(pending.length);
    const all = new Float64Array(pending.length * 3);
    pending.forEach((p, k) => {
      ids[k] = keptTextId(mod, p.text);
      all.set(params(p.width, p.height, p.onPath), k * 3);
    });
    const stream = mod.text_layout_many(ids, all, js.id, js.width, js.metrics);
    let at = 0;
    for (const p of pending) {
      const length = stream[at++];
      const layout = length ? decodeLayout(stream, at, p.text, p.fills, p.text.runs ?? []).layout : computeLayout(p.text, p.fills, measurer, cache, p.width, p.height, p.onPath);
      at += length;
      let entries = layoutCache.get(p.text);
      if (!entries) layoutCache.set(p.text, (entries = []));
      entries.unshift({measurer, generation: cache.generation, fills: p.fills, width: p.width, height: p.height, onPath: p.onPath, layout});
      if (entries.length > CACHED_LAYOUTS) entries.length = CACHED_LAYOUTS;
      out[p.index] = layout;
    }
  }
  return out;
}

/** The slot table of a layout: the base style, then every valid run's resolved style, as `computeLayout`
 *  builds them, with the SMALL_CAPS reduced copies and the FontSpec objects shared by every run of a slot. */
type SlotObjects = {style: TextStyle; small: TextStyle; font: FontSpec; smallFont: FontSpec; fills: Paint[]};

function slotObjects(style: TextStyle, slotFills: Paint[]): SlotObjects {
  const size = Math.max(0, finite(style.fontSize));
  const small = {...style, fontSize: size * SMALL_CAPS_SCALE};
  return {style, small, font: fontSpecOf(style), smallFont: fontSpecOf(small), fills: slotFills};
}

/** Reads one layout stream (`crates/text/src/encode.rs`) starting at `from`; returns where it ended. */
function decodeLayout(s: Float64Array, from: number, text: TextProps, fills: Paint[], runs: TextRun[]): {layout: TextLayout; end: number} {
  let i = from;
  const layoutId = s[i++];
  const width = s[i++], height = s[i++], truncated = s[i++] === 1, naturalWidth = s[i++], length = s[i++];
  const slotCount = s[i++];
  const slots: SlotObjects[] = [];
  for (let k = 0; k < slotCount; k++) {
    const runIndex = s[i++];
    if (runIndex < 0) slots.push(slotObjects(text.style, fills));
    else {
      const run = runs[runIndex];
      slots.push(slotObjects(resolveStyle(text.style, run.style ?? {}), run.fills ?? fills));
    }
  }
  const readText = (): string => {
    const count = s[i++];
    let out = '';
    for (let k = 0; k < count; k += 4096) out += String.fromCharCode.apply(null, Array.from(s.subarray(i + k, i + Math.min(count, k + 4096))));
    i += count;
    return out;
  };
  const lineCount = s[i++];
  const lines: TextLine[] = [];
  for (let l = 0; l < lineCount; l++) {
    const runCount = s[i++];
    const line: TextLine = {
      runs: [], start: s[i++], end: s[i++], x: s[i++], top: s[i++], baseline: s[i++], width: s[i++], height: s[i++], paragraphIndex: s[i++], ascent: s[i++], descent: s[i++], wrapped: s[i++] === 1,
    };
    if (s[i++] === 1) {
      const slot = slots[s[i++]];
      const x = s[i++], markerWidth = s[i++];
      const markerText = readText();
      line.listMarker = markerText;
      line.marker = {text: markerText, x, width: markerWidth, style: slot.style, fills: slot.fills, font: slot.font};
    }
    for (let r = 0; r < runCount; r++) {
      const slot = slots[s[i++]];
      const small = s[i++] === 1, ellipsis = s[i++] === 1;
      const run: GlyphRun = {
        text: '', start: s[i++], end: s[i++], x: s[i++], width: s[i++], style: small ? slot.small : slot.style, fills: slot.fills, font: small ? slot.smallFont : slot.font, letterSpacing: s[i++], offsets: [], xs: [],
      };
      const stops = s[i++];
      run.text = readText();
      run.offsets = Array.from(s.subarray(i, i + stops));
      i += stops;
      run.xs = Array.from(s.subarray(i, i + stops));
      i += stops;
      if (ellipsis) run.ellipsis = true;
      line.runs.push(run);
    }
    lines.push(line);
  }
  const layout: TextLayout = {width, height, lines, truncated, naturalWidth, length};
  Object.defineProperty(layout, WASM_ID, {value: layoutId, enumerable: false});
  return {layout, end: i};
}

const wasmIdOf = (layout: TextLayout): number | undefined => (layout as unknown as {[WASM_ID]?: number})[WASM_ID];

/** A caret call: through the wasm layout when this layout came from there, else the TypeScript. */
function caretCall<T>(what: string, layout: TextLayout, ts: () => T, wasm: (mod: TextWasm, id: number) => T | undefined): T {
  const id = wasmIdOf(layout);
  if (id === undefined) return ts();
  return viaEngine(what, ts, mod => wasm(mod, id));
}

const DIRECTIONS: Record<CaretDirection, number> = {left: 0, right: 1, up: 2, down: 3, lineStart: 4, lineEnd: 5, wordLeft: 6, wordRight: 7, docStart: 8, docEnd: 9};
const affinityOf = (flag: number): Affinity => (flag === 1 ? 'upstream' : 'downstream');

export function lineIndexAt(layout: TextLayout, offset: number, affinity: Affinity = 'downstream'): number {
  return caretCall('lineIndexAt', layout, () => lineIndexAtTs(layout, offset, affinity), (mod, id) => mod.text_line_index_at(id, offset, affinity === 'upstream'));
}

export function caretAt(layout: TextLayout, offset: number, affinity: Affinity = 'downstream'): Caret {
  return caretCall('caretAt', layout, () => caretAtTs(layout, offset, affinity), (mod, id) => {
    const c = mod.text_caret_at(id, offset, affinity === 'upstream');
    return c && {x: c[0], top: c[1], height: c[2], baseline: c[3], lineIndex: c[4]};
  });
}

export function offsetAt(layout: TextLayout, point: {x: number; y: number}): {offset: number; affinity: Affinity; lineIndex: number} {
  return caretCall('offsetAt', layout, () => offsetAtTs(layout, point), (mod, id) => {
    const h = mod.text_offset_at(id, point.x, point.y);
    return h && {offset: h[0], affinity: affinityOf(h[1]), lineIndex: h[2]};
  });
}

export function selectionRects(layout: TextLayout, start: number, end: number): SelectionRect[] {
  return caretCall('selectionRects', layout, () => selectionRectsTs(layout, start, end), (mod, id) => {
    const flat = mod.text_selection_rects(id, start, end);
    if (!flat) return undefined;
    const rects: SelectionRect[] = [];
    for (let k = 0; k < flat.length; k += 5) rects.push({x: flat[k], y: flat[k + 1], width: flat[k + 2], height: flat[k + 3], lineIndex: flat[k + 4]});
    return rects;
  });
}

export function lineRange(layout: TextLayout, offset: number, affinity: Affinity = 'downstream'): {start: number; end: number; lineIndex: number} {
  return caretCall('lineRange', layout, () => lineRangeTs(layout, offset, affinity), (mod, id) => {
    const r = mod.text_line_range(id, offset, affinity === 'upstream');
    return r && {start: r[0], end: r[1], lineIndex: r[2]};
  });
}

export function moveCaret(layout: TextLayout, text: string, offset: number, direction: CaretDirection, goalX?: number, affinity: Affinity = 'downstream'): CaretMove {
  return caretCall('moveCaret', layout, () => moveCaretTs(layout, text, offset, direction, goalX, affinity), (mod, id) => {
    const m = mod.text_move_caret(id, codeUnits(text), offset, DIRECTIONS[direction], goalX, affinity === 'upstream');
    // The TypeScript result always carries the key.
    return m && {offset: m[0], goalX: m[1] === 1 ? m[2] : undefined, affinity: affinityOf(m[3])};
  });
}
