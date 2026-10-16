// Graphemes, words, paragraphs and line-break classes of text, shared by the text layout
// (shared/design/text-layout.ts) and the pure editing operations (shared/design/text-edit.ts).
// Offsets are UTF-16 code units, as in `TextProps.characters`. Russian text comes first: Cyrillic
// letters are word characters, "ёлочки" and dashes follow Russian typography, and the no-break
// spaces designers type between a number and its unit or before a dash hold words together.

import {codeUnits, fromCodeUnits, viaEngine} from './text-engine';

export type TextRange = {start: number; end: number};

// ── Graphemes ──────────────────────────────────────────────────────────────────────────────────

/** Code units that are a grapheme of their own whatever surrounds them: Latin, Cyrillic, Greek,
 *  punctuation and symbols — not combining marks, joiners, variation selectors, surrogates or CR.
 *  Almost every Russian or English text consists of nothing else, and then no segmenter runs. */
const isSimpleCode = (c: number) =>
  (c < 0x300 && c !== 0x0d) || (c >= 0x370 && c <= 0x482) || (c >= 0x48a && c <= 0x52f) || (c >= 0x1e00 && c <= 0x200b) ||
  (c >= 0x200e && c <= 0x20cf) || (c >= 0x2100 && c <= 0x2bff) || (c >= 0x3000 && c <= 0x303f);

/** True when every code unit of text[from, to) is a grapheme of its own. */
export function isSimpleRange(text: string, from = 0, to = text.length): boolean {
  for (let i = from; i < to; i++) if (!isSimpleCode(text.charCodeAt(i))) return false;
  return true;
}

type GraphemeSegmenter = {segment(input: string): Iterable<{index: number}>};
let segmenter: GraphemeSegmenter | null | undefined;

/** Intl.Segmenter where the runtime has it (every current browser and Node); null otherwise. */
function graphemeSegmenter(): GraphemeSegmenter | null {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', {granularity: 'grapheme'}) : null;
  }
  return segmenter;
}

const isExtender = (cp: number) =>
  /\p{M}/u.test(String.fromCodePoint(cp)) || cp === 0x200c || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0020 && cp <= 0xe007f) || cp === 0x20e3;
const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

/** Clusters by code points when no segmenter exists: a base with its combining marks, joiners,
 *  variation selectors and skin tones, ZWJ sequences, flag pairs and CR LF stay together. */
function fallbackBoundaries(text: string, from: number, to: number, out: number[]) {
  let i = from;
  while (i < to) {
    out.push(i);
    const cp = text.codePointAt(i)!;
    let j = i + (cp > 0xffff ? 2 : 1);
    if (cp === 0x0d && text.charCodeAt(j) === 0x0a && j < to) j++;
    else if (isRegionalIndicator(cp) && j < to && isRegionalIndicator(text.codePointAt(j)!)) j += 2;
    while (j < to) {
      const next = text.codePointAt(j)!;
      if (!isExtender(next)) break;
      j += next > 0xffff ? 2 : 1;
      if (next === 0x200d && j < to) {
        const joined = text.codePointAt(j)!;
        j += joined > 0xffff ? 2 : 1;
      }
    }
    i = Math.min(j, to);
  }
  out.push(to);
}

/** Grapheme boundaries of `text` in [from, to], both ends included, ascending. Clusters never
 *  cross a "\n", so callers segment one paragraph at a time. */
function graphemeBoundariesTs(text: string, from = 0, to = text.length): number[] {
  const out: number[] = [];
  if (isSimpleRange(text, from, to)) {
    for (let i = from; i <= to; i++) out.push(i);
    return out;
  }
  const slice = from === 0 && to === text.length ? text : text.slice(from, to);
  const native = graphemeSegmenter();
  if (!native) {
    fallbackBoundaries(text, from, to, out);
    return out;
  }
  for (const {index} of native.segment(slice)) out.push(from + index);
  out.push(to);
  return out;
}

function paragraphBounds(text: string, offset: number): TextRange {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const newline = text.indexOf('\n', offset);
  return {start, end: newline < 0 ? text.length : newline};
}

/** The grapheme boundary after `offset` (one step of → or Delete). */
function nextGraphemeBoundaryTs(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  if (offset < 0) return 0;
  const here = text.charCodeAt(offset);
  if (isSimpleCode(here) && (offset + 1 >= text.length || isSimpleCode(text.charCodeAt(offset + 1)))) return offset + 1;
  const {start, end} = paragraphBounds(text, offset);
  if (offset >= end) return Math.min(text.length, end + 1);
  for (const b of graphemeBoundariesTs(text, start, end)) if (b > offset) return b;
  return end;
}

/** The grapheme boundary before `offset` (one step of ← or Backspace). */
function prevGraphemeBoundaryTs(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset > text.length) return text.length;
  if (isSimpleCode(text.charCodeAt(offset - 1))) return offset - 1;
  const {start, end} = paragraphBounds(text, offset);
  if (offset <= start) return start - 1;
  const bounds = graphemeBoundariesTs(text, start, end);
  for (let i = bounds.length - 1; i >= 0; i--) if (bounds[i] < offset) return bounds[i];
  return start;
}

/** `offset` moved onto a grapheme boundary (backwards, or forwards with `forward`). Offsets that
 *  come from outside (a pasted selection, a stale caret) never split a cluster this way. */
function snapToGraphemeTs(text: string, offset: number, forward = false): number {
  const o = Math.max(0, Math.min(text.length, Math.round(offset)));
  if (o === 0 || o === text.length) return o;
  if (isSimpleCode(text.charCodeAt(o - 1)) && isSimpleCode(text.charCodeAt(o))) return o;
  const {start, end} = paragraphBounds(text, o);
  if (o === start || o === end) return o;
  const bounds = graphemeBoundariesTs(text, start, end);
  let prev = start;
  for (const b of bounds) {
    if (b === o) return o;
    if (b > o) return forward ? b : prev;
    prev = b;
  }
  return o;
}

// ── Words and paragraphs ───────────────────────────────────────────────────────────────────────

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const WORD_PART = /[\p{L}\p{N}\p{M}]/u;
const APOSTROPHES = new Set([0x27, 0x2019, 0x2bc]);

type CharClass = 'word' | 'space' | 'newline' | 'other';

const codeAt = (text: string, i: number) => (i >= 0 && i < text.length ? text.codePointAt(i)! : -1);
/** Start of the code point that ends at `i` (steps over a surrogate pair). */
const cpBefore = (text: string, i: number) => (i >= 2 && /[\udc00-\udfff]/.test(text[i - 1]) && /[\ud800-\udbff]/.test(text[i - 2]) ? i - 2 : i - 1);
const cpAfter = (text: string, i: number) => i + (codeAt(text, i) > 0xffff ? 2 : 1);

const isLetterOrDigitTs = (cp: number) => cp >= 0 && (cp < 0x80 ? (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a) : LETTER_OR_DIGIT.test(String.fromCodePoint(cp)));
const isWordPart = (cp: number) => cp >= 0 && (cp < 0x80 ? isLetterOrDigitTs(cp) : WORD_PART.test(String.fromCodePoint(cp)));

/** A letter, digit or combining mark, or an apostrophe inside a word ("д’Артаньян", "don't"). */
function classAt(text: string, i: number): CharClass {
  const cp = codeAt(text, i);
  if (cp === 0x0a || cp === 0x2028 || cp === 0x2029) return 'newline';
  if (isWordPart(cp)) return 'word';
  if (APOSTROPHES.has(cp) && isLetterOrDigitTs(codeAt(text, cpBefore(text, i))) && isLetterOrDigitTs(codeAt(text, i + 1))) return 'word';
  if (isBreakingSpace(cp) || isGlueSpace(cp)) return 'space';
  return 'other';
}

/** The word around `offset` (double-click): letters and digits of any script, a run of spaces
 *  when the caret stands in one, otherwise the single grapheme next to the caret. Prefers what
 *  follows the caret, then what precedes it. */
function wordAtTs(text: string, offset: number): TextRange {
  const o = Math.max(0, Math.min(text.length, offset));
  const after = o < text.length ? classAt(text, o) : null;
  const beforeIndex = o > 0 ? cpBefore(text, o) : -1;
  const before = beforeIndex >= 0 ? classAt(text, beforeIndex) : null;
  const expand = (from: number, kind: CharClass): TextRange => {
    let start = from, end = from;
    while (start > 0 && classAt(text, cpBefore(text, start)) === kind) start = cpBefore(text, start);
    while (end < text.length && classAt(text, end) === kind) end = cpAfter(text, end);
    return {start, end};
  };
  if (after === 'word') return expand(o, 'word');
  if (before === 'word') return expand(o, 'word');
  if (after === 'space') return expand(o, 'space');
  if (after === 'other') return {start: o, end: nextGraphemeBoundaryTs(text, o)};
  if (before === 'space') return expand(o, 'space');
  if (before === 'other') return {start: prevGraphemeBoundaryTs(text, o), end: o};
  return {start: o, end: o};
}

/** ⌥← (macOS) / Ctrl+← : the start of the word before `offset`, skipping spaces and punctuation. */
function wordStartBeforeTs(text: string, offset: number): number {
  let i = Math.max(0, Math.min(text.length, offset));
  while (i > 0 && classAt(text, cpBefore(text, i)) !== 'word') i = cpBefore(text, i);
  while (i > 0 && classAt(text, cpBefore(text, i)) === 'word') i = cpBefore(text, i);
  return i;
}

/** ⌥→ (macOS) / Ctrl+→ : the end of the word after `offset`, skipping spaces and punctuation. */
function wordEndAfterTs(text: string, offset: number): number {
  let i = Math.max(0, Math.min(text.length, offset));
  while (i < text.length && classAt(text, i) !== 'word') i = cpAfter(text, i);
  while (i < text.length && classAt(text, i) === 'word') i = cpAfter(text, i);
  return i;
}

/** True when a letter at `i` starts a word: nothing before it in the text continues one. */
function startsWordTs(text: string, i: number): boolean {
  return i <= 0 || classAt(text, cpBefore(text, i)) !== 'word';
}

/** The paragraph ("\n"-separated, the newline excluded) holding `offset`, and its index. */
function paragraphAtTs(text: string, offset: number): TextRange & {index: number} {
  const o = Math.max(0, Math.min(text.length, offset));
  const {start, end} = paragraphBounds(text, o);
  let index = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < start; i = text.indexOf('\n', i + 1)) index++;
  return {start, end, index};
}

/** Every paragraph of `text`; an empty text has one empty paragraph. */
function paragraphRangesTs(text: string): TextRange[] {
  if (text.indexOf('\n') < 0) return [{start: 0, end: text.length}];
  const out: TextRange[] = [];
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
    out.push({start, end: i});
    start = i + 1;
  }
  out.push({start, end: text.length});
  return out;
}

// ── Line-break classes ─────────────────────────────────────────────────────────────────────────

export const SOFT_HYPHEN = 0xad;
export const ZERO_WIDTH_SPACE = 0x200b;
export const WORD_JOINER = 0x2060;
export const ZERO_WIDTH_NO_BREAK_SPACE = 0xfeff;
/** Shift+Enter: a line break inside the paragraph (the list item and its marker continue). */
export const LINE_SEPARATOR = 0x2028;

/** Spaces a line may break after; they hang past the line end and stretch in justified lines. */
export const isBreakingSpace = (cp: number) =>
  cp === 0x20 || cp === 0x09 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a && cp !== 0x2007) || cp === 0x205f || cp === 0x3000;
/** No-break spaces (U+00A0, narrow U+202F, figure U+2007): they keep the words on both sides together. */
export const isGlueSpace = (cp: number) => cp === 0xa0 || cp === 0x202f || cp === 0x2007;
/** En and em dashes and the horizontal bar. */
export const isDash = (cp: number) => cp === 0x2013 || cp === 0x2014 || cp === 0x2015;
const isHyphen = (cp: number) => cp === 0x2d || cp === 0x2010;
const isDigit = (cp: number) => (cp >= 0x30 && cp <= 0x39) || (cp > 0x7f && /\p{Nd}/u.test(String.fromCodePoint(cp)));
const isLetter = (cp: number) => cp >= 0 && (cp < 0x80 ? (cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a : /\p{L}/u.test(String.fromCodePoint(cp)));
const CLOSING = new Set([...')]}»”’.,;:!?…、。，．」』）〕】'].map(c => c.codePointAt(0)!));
const OPENING = new Set([...'([{«„“‘「『（〔【'].map(c => c.codePointAt(0)!));
const isIdeographic = (cp: number) =>
  (cp >= 0x2e80 && cp <= 0x9fff && !(cp >= 0x3000 && cp <= 0x303f)) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x3ffff);

/** May a line break after a run of breaking spaces followed by `next`? Not before a dash: in
 *  Russian typography a dash never starts a line, so "слово — слово" keeps the dash with the word
 *  before it even when the designer typed a plain space. */
const canBreakAfterSpacesTs = (next: number) => next !== WORD_JOINER && next !== ZERO_WIDTH_NO_BREAK_SPACE && !isDash(next);

/** May a line break between the grapheme starting with `cp` (a visible character, not a space)
 *  and the next one starting with `next`, given the grapheme before starting with `prev`? A
 *  simplified UAX #14 for the scripts designers set: after hyphens inside words ("северо-запад",
 *  not "2-3" or "-5"), after dashes and slashes, after zero-width spaces and soft hyphens, and
 *  between CJK ideographs. Never at no-break spaces or word joiners. */
function canBreakBetweenTs(prev: number, cp: number, next: number): boolean {
  if (next < 0 || next === WORD_JOINER || next === ZERO_WIDTH_NO_BREAK_SPACE || cp === WORD_JOINER || cp === ZERO_WIDTH_NO_BREAK_SPACE) return false;
  if (isBreakingSpace(next) || isGlueSpace(next) || isGlueSpace(cp)) return false;
  if (cp === ZERO_WIDTH_SPACE || cp === SOFT_HYPHEN) return true;
  if (isHyphen(cp)) return isLetterOrDigitTs(prev) && isLetter(next);
  if (isDash(cp)) return !isDash(next) && !CLOSING.has(next);
  if (cp === 0x2f) return next !== 0x2f && !isDigit(next) && !CLOSING.has(next);
  if (isIdeographic(cp) || isIdeographic(next)) return !CLOSING.has(next) && !OPENING.has(cp);
  return false;
}

// ── Case ───────────────────────────────────────────────────────────────────────────────────────

/** The display form of one grapheme under a text case. TITLE upper-cases the first letter of
 *  every word and leaves the rest as typed (as CSS `capitalize`). Locale-independent, so the
 *  same file lays out the same everywhere; Cyrillic needs no locale rules. */
function caseGraphemeTs(grapheme: string, mode: 'UPPER' | 'LOWER' | 'TITLE', wordStart: boolean): string {
  if (mode === 'UPPER') return grapheme.toUpperCase();
  if (mode === 'LOWER') return grapheme.toLowerCase();
  return wordStart ? grapheme.toUpperCase() : grapheme;
}

/** True when the grapheme changes under upper-casing (SMALL_CAPS draws those smaller). */
const hasLowercaseTs = (grapheme: string) => grapheme.toUpperCase() !== grapheme;

// ── The engine switch ──────────────────────────────────────────────────────────────────────────
// Each export runs the TypeScript above, the Rust twin in crates/text (through the wasm build), or both
// with the results compared (shared/design/text-engine.ts). The functions above stay the oracle.

const pair = (units: ArrayLike<number>): TextRange => ({start: units[0], end: units[1]});
const CASE_MODES = {UPPER: 0, LOWER: 1, TITLE: 2} as const;

export function graphemeBoundaries(text: string, from = 0, to = text.length): number[] {
  return viaEngine('graphemeBoundaries', () => graphemeBoundariesTs(text, from, to), mod => Array.from(mod.text_grapheme_boundaries(codeUnits(text), from, to)));
}
export function nextGraphemeBoundary(text: string, offset: number): number {
  return viaEngine('nextGraphemeBoundary', () => nextGraphemeBoundaryTs(text, offset), mod => mod.text_next_grapheme_boundary(codeUnits(text), offset));
}
export function prevGraphemeBoundary(text: string, offset: number): number {
  return viaEngine('prevGraphemeBoundary', () => prevGraphemeBoundaryTs(text, offset), mod => mod.text_prev_grapheme_boundary(codeUnits(text), offset));
}
export function snapToGrapheme(text: string, offset: number, forward = false): number {
  return viaEngine('snapToGrapheme', () => snapToGraphemeTs(text, offset, forward), mod => mod.text_snap_to_grapheme(codeUnits(text), offset, forward));
}
export const isLetterOrDigit = (cp: number): boolean => viaEngine('isLetterOrDigit', () => isLetterOrDigitTs(cp), mod => mod.text_is_letter_or_digit(cp));
export function wordAt(text: string, offset: number): TextRange {
  return viaEngine('wordAt', () => wordAtTs(text, offset), mod => pair(mod.text_word_at(codeUnits(text), offset)));
}
export function wordStartBefore(text: string, offset: number): number {
  return viaEngine('wordStartBefore', () => wordStartBeforeTs(text, offset), mod => mod.text_word_start_before(codeUnits(text), offset));
}
export function wordEndAfter(text: string, offset: number): number {
  return viaEngine('wordEndAfter', () => wordEndAfterTs(text, offset), mod => mod.text_word_end_after(codeUnits(text), offset));
}
export function startsWord(text: string, i: number): boolean {
  return viaEngine('startsWord', () => startsWordTs(text, i), mod => mod.text_starts_word(codeUnits(text), i));
}
export function paragraphAt(text: string, offset: number): TextRange & {index: number} {
  return viaEngine('paragraphAt', () => paragraphAtTs(text, offset), mod => {
    const [start, end, index] = mod.text_paragraph_at(codeUnits(text), offset);
    return {start, end, index};
  });
}
export function paragraphRanges(text: string): TextRange[] {
  return viaEngine('paragraphRanges', () => paragraphRangesTs(text), mod => {
    const flat = mod.text_paragraph_ranges(codeUnits(text));
    const out: TextRange[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push({start: flat[i], end: flat[i + 1]});
    return out;
  });
}
export const canBreakAfterSpaces = (next: number): boolean => viaEngine('canBreakAfterSpaces', () => canBreakAfterSpacesTs(next), mod => mod.text_can_break_after_spaces(next));
export function canBreakBetween(prev: number, cp: number, next: number): boolean {
  return viaEngine('canBreakBetween', () => canBreakBetweenTs(prev, cp, next), mod => mod.text_can_break_between(prev, cp, next));
}
export function caseGrapheme(grapheme: string, mode: 'UPPER' | 'LOWER' | 'TITLE', wordStart: boolean): string {
  return viaEngine('caseGrapheme', () => caseGraphemeTs(grapheme, mode, wordStart), mod => fromCodeUnits(mod.text_case_grapheme(codeUnits(grapheme), CASE_MODES[mode], wordStart)));
}
export const hasLowercase = (grapheme: string): boolean => viaEngine('hasLowercase', () => hasLowercaseTs(grapheme), mod => mod.text_has_lowercase(codeUnits(grapheme)));
