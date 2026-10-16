import type {Hyperlink, ListType, Paint, StyleId, TextProps, TextRun, TextStyle} from './types';
import {isLetterOrDigit, paragraphAt, paragraphRanges, startsWord} from './text-segment';

// Pure editing operations on a text node's `TextProps` (and, for colour, the node's `fills`, which
// are the base paint of its characters). The in-canvas editor, the design panel and paste build on
// these; each returns new objects and never mutates its input.
//
// Runs are sparse overrides of the base style. Every operation works on a dense view (segments
// covering every character, `null` = base style) and writes the runs back normalized: sorted,
// non-overlapping, inside `characters`, no empty runs, no field equal to the base style, and no
// two touching runs that say the same thing. That keeps documents small and lets the panel compare
// styles without resolving them twice.

/** A run's say about its characters, relative to the base style; also the caret's pending style
 *  (the editor holds one after ⌘B with nothing selected, and typing uses it). */
export type RunOverride = {style: Partial<TextStyle>; fills?: Paint[]; textStyleId?: StyleId};

export const MIXED = 'mixed' as const;
export type Mixed = typeof MIXED;

/** The style the design panel shows for a selection: each field's value, or 'mixed'. */
export type RangeStyle = {[K in keyof TextStyle]-?: Exclude<TextStyle[K], undefined> | Mixed} & {
  fills: Paint[] | Mixed;
  textStyleId: StyleId | null | Mixed;
  listType: ListType | Mixed;
};

export type CaseCommand = 'UPPER' | 'LOWER' | 'TITLE' | 'SENTENCE';

const STYLE_KEYS: readonly (keyof TextStyle)[] = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase', 'hyperlink'];

// ── Values ─────────────────────────────────────────────────────────────────────────────────────

/** Structural equality of JSON-like values; keys holding undefined count as absent. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x).filter(key => x[key] !== undefined);
  if (keys.length !== Object.keys(y).filter(key => y[key] !== undefined).length) return false;
  return keys.every(key => sameValue(x[key], y[key]));
}

/** A link field compares as null when absent. */
const fieldValue = (style: Partial<TextStyle>, key: keyof TextStyle) => (key === 'hyperlink' ? (style.hyperlink ?? null) : style[key]);

function definedFields(partial: Partial<TextStyle>): Partial<TextStyle> {
  const out: Partial<TextStyle> = {};
  for (const key of Object.keys(partial) as (keyof TextStyle)[]) if (partial[key] !== undefined) (out as Record<string, unknown>)[key] = partial[key];
  return out;
}

const resolve = (base: TextStyle, partial: Partial<TextStyle> | undefined): TextStyle => (partial ? {...base, ...definedFields(partial)} : base);

// ── Dense segments ─────────────────────────────────────────────────────────────────────────────

type Segment = {start: number; end: number; o: RunOverride | null};

const overrideOf = (run: TextRun): RunOverride => ({
  style: run.style ?? {},
  ...(run.fills ? {fills: run.fills} : {}),
  ...(run.textStyleId ? {textStyleId: run.textStyleId} : {}),
});

/** Segments covering [0, length). Runs are read defensively: sorted, clipped, and where two
 *  overlap the earlier one keeps the shared characters. */
function toSegments(text: TextProps): Segment[] {
  const length = text.characters.length;
  const runs = (text.runs ?? []).filter(run => run && run.end > run.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const segments: Segment[] = [];
  let pos = 0;
  for (const run of runs) {
    const start = Math.max(pos, run.start), end = Math.min(run.end, length);
    if (end <= start) continue;
    if (start > pos) segments.push({start: pos, end: start, o: null});
    segments.push({start, end, o: overrideOf(run)});
    pos = end;
  }
  if (pos < length) segments.push({start: pos, end: length, o: null});
  return segments;
}

/** The override without fields the base style already has (and fills equal to the node's). */
function cleanOverride(o: RunOverride | null, base: TextStyle, nodeFills?: Paint[]): RunOverride | null {
  if (!o) return null;
  const style: Partial<TextStyle> = {};
  let any = false;
  for (const key of Object.keys(o.style ?? {}) as (keyof TextStyle)[]) {
    const value = o.style[key];
    if (value === undefined || sameValue(fieldValue(o.style, key), fieldValue(base, key))) continue;
    (style as Record<string, unknown>)[key] = value;
    any = true;
  }
  const fills = o.fills && !(nodeFills && sameValue(o.fills, nodeFills)) ? o.fills : undefined;
  if (!any && !fills && !o.textStyleId) return null;
  return {style, ...(fills ? {fills} : {}), ...(o.textStyleId ? {textStyleId: o.textStyleId} : {})};
}

const sameOverride = (a: RunOverride, b: RunOverride) => sameValue(a.style, b.style) && sameValue(a.fills, b.fills) && (a.textStyleId ?? null) === (b.textStyleId ?? null);

function toRuns(segments: Segment[], base: TextStyle, nodeFills?: Paint[]): TextRun[] {
  const runs: TextRun[] = [];
  let last: {run: TextRun; o: RunOverride} | null = null;
  for (const segment of segments) {
    if (segment.end <= segment.start) continue;
    const o = cleanOverride(segment.o, base, nodeFills);
    if (!o) {
      last = null;
      continue;
    }
    if (last && last.run.end === segment.start && sameOverride(last.o, o)) {
      last.run.end = segment.end;
      continue;
    }
    const run: TextRun = {start: segment.start, end: segment.end, style: o.style};
    if (o.fills) run.fills = o.fills;
    if (o.textStyleId) run.textStyleId = o.textStyleId;
    runs.push(run);
    last = {run, o};
  }
  return runs;
}

/** The segments with [start, end) replaced by `length` characters carrying `o`. */
function replaceSegments(segments: Segment[], start: number, end: number, length: number, o: RunOverride | null): Segment[] {
  const delta = length - (end - start);
  const out: Segment[] = [];
  for (const segment of segments) if (segment.start < start) out.push({start: segment.start, end: Math.min(segment.end, start), o: segment.o});
  if (length > 0) out.push({start, end: start + length, o});
  for (const segment of segments) if (segment.end > end) out.push({start: Math.max(segment.start, end) + delta, end: segment.end + delta, o: segment.o});
  return out;
}

/** The segments with `change` applied to the overrides of [start, end), split at both ends. */
function mapSegments(segments: Segment[], start: number, end: number, change: (o: RunOverride | null) => RunOverride | null): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    if (segment.end <= start || segment.start >= end) {
      out.push(segment);
      continue;
    }
    if (segment.start < start) out.push({start: segment.start, end: start, o: segment.o});
    out.push({start: Math.max(segment.start, start), end: Math.min(segment.end, end), o: change(segment.o)});
    if (segment.end > end) out.push({start: end, end: segment.end, o: segment.o});
  }
  return out;
}

const overrideAt = (segments: Segment[], offset: number): RunOverride | null => {
  for (const segment of segments) if (segment.start <= offset && offset < segment.end) return segment.o;
  return null;
};

const clampRange = (text: TextProps, start: number, end: number): [number, number] => {
  const length = text.characters.length;
  const a = Math.max(0, Math.min(length, start)), b = Math.max(0, Math.min(length, end));
  return a <= b ? [a, b] : [b, a];
};

// ── Typing ─────────────────────────────────────────────────────────────────────────────────────

/** Which character's style typed text takes: over a selection, its first character's; at a
 *  caret, the character before it, except at a paragraph start, where the paragraph's own first
 *  character (or, in an empty paragraph, its line break) decides. -1 for the base style. */
function styleSource(chars: string, start: number, end: number): number {
  if (end > start) return start;
  if (start > 0 && chars[start - 1] !== '\n') return start - 1;
  if (start < chars.length) return start;
  return start - 1;
}

function caretOverride(text: TextProps, segments: Segment[], start: number, end: number): RunOverride | null {
  const source = styleSource(text.characters, start, end);
  if (source < 0) return null;
  const o = overrideAt(segments, source);
  // Typing right after a link does not extend it (as in every editor that has links).
  if (o?.style.hyperlink && source < start) {
    const after = start < text.characters.length ? overrideAt(segments, start) : null;
    if (!after || !sameValue(after.style.hyperlink, o.style.hyperlink)) return {...o, style: {...o.style, hyperlink: null}};
  }
  return o;
}

/** The style typed text gets at the caret or over the selection [start, end) — the seed of the
 *  editor's pending caret style (null: the base style). */
export function caretStyleAt(text: TextProps, start: number, end = start): RunOverride | null {
  const [a, b] = clampRange(text, start, end);
  return caretOverride(text, toSegments(text), a, b);
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) count++;
  return count;
}

/** `text` with `listTypes` set to `types`, trailing 'NONE's dropped and the field omitted when empty. */
function withListTypes(text: TextProps, types: ListType[]): TextProps {
  let length = types.length;
  while (length && types[length - 1] === 'NONE') length--;
  const {listTypes: _old, ...rest} = text;
  void _old;
  return length ? {...rest, listTypes: types.slice(0, length)} : rest;
}

/** Replaces [start, end) with `inserted` (typing, paste, delete). The new characters take
 *  `caretStyle` when given (null: the base style), otherwise the style `caretStyleAt` names. Runs
 *  shift, split and merge; line breaks typed into a list paragraph make more items of its kind,
 *  and paragraphs joined by a deletion keep the first one's list type. */
export function insertText(text: TextProps, start: number, end: number, inserted: string, caretStyle?: RunOverride | null): TextProps {
  const [a, b] = clampRange(text, start, end);
  const chars = text.characters;
  const segments = toSegments(text);
  const o = caretStyle !== undefined ? caretStyle : caretOverride(text, segments, a, b);
  const characters = chars.slice(0, a) + inserted + chars.slice(b);
  const next: TextProps = {...text, characters, runs: toRuns(replaceSegments(segments, a, b, inserted.length, o), text.style)};
  if (!text.listTypes) return next;
  const paragraphs = countNewlines(chars, 0, chars.length) + 1;
  const types: ListType[] = Array.from({length: paragraphs}, (_, i) => text.listTypes?.[i] ?? 'NONE');
  const at = countNewlines(chars, 0, a);
  types.splice(at + 1, countNewlines(chars, a, b), ...Array<ListType>(countNewlines(inserted, 0, inserted.length)).fill(types[at]));
  return withListTypes(next, types);
}

/** Removes [start, end). */
export const deleteRange = (text: TextProps, start: number, end: number): TextProps => insertText(text, start, end, '', null);

// ── Styling ────────────────────────────────────────────────────────────────────────────────────

const coversAll = (text: TextProps, a: number, b: number) => text.characters.length === 0 || (a === 0 && b === text.characters.length);

/** Sets style fields on [start, end). Over the whole text the base style changes and runs lose
 *  those fields; a collapsed range in non-empty text changes nothing (the editor keeps a pending
 *  caret style instead). */
export function applyStyleToRange(text: TextProps, start: number, end: number, partial: Partial<TextStyle>): TextProps {
  const [a, b] = clampRange(text, start, end);
  const fields = definedFields(partial);
  const keys = Object.keys(fields);
  if (!keys.length) return text;
  if (coversAll(text, a, b)) {
    const style = resolve(text.style, fields);
    const segments = toSegments(text).map(segment => {
      if (!segment.o) return segment;
      const kept: Partial<TextStyle> = {...segment.o.style};
      for (const key of keys) delete (kept as Record<string, unknown>)[key];
      return {...segment, o: {...segment.o, style: kept}};
    });
    return {...text, style, runs: toRuns(segments, style)};
  }
  if (a === b) return text;
  const segments = mapSegments(toSegments(text), a, b, o => ({...(o ?? {}), style: {...(o?.style ?? {}), ...fields}}));
  return {...text, runs: toRuns(segments, text.style)};
}

/** Paints [start, end). Over the whole text the node's fills change (returned as `fills`) and runs
 *  lose theirs; otherwise the runs carry the paints and `fills` is `nodeFills` unchanged. */
export function applyFillsToRange(text: TextProps, nodeFills: Paint[], start: number, end: number, fills: Paint[]): {text: TextProps; fills: Paint[]} {
  const [a, b] = clampRange(text, start, end);
  if (coversAll(text, a, b)) {
    const segments = toSegments(text).map(segment => {
      if (!segment.o?.fills) return segment;
      const {fills: _dropped, ...rest} = segment.o;
      void _dropped;
      return {...segment, o: rest};
    });
    return {text: {...text, runs: toRuns(segments, text.style, fills)}, fills};
  }
  if (a === b) return {text, fills: nodeFills};
  const segments = mapSegments(toSegments(text), a, b, o => ({...(o ?? {style: {}}), fills}));
  return {text: {...text, runs: toRuns(segments, text.style, nodeFills)}, fills: nodeFills};
}

/** The style of [start, end) for the panel: each field's common value or 'mixed'. A collapsed
 *  range reports what typing there would produce. */
export function styleAtRange(text: TextProps, start: number, end: number, nodeFills: Paint[] = []): RangeStyle {
  const [a, b] = clampRange(text, start, end);
  const segments = toSegments(text);
  const overrides = a === b ? [caretOverride(text, segments, a, a)] : segments.filter(segment => segment.end > a && segment.start < b).map(segment => segment.o);
  if (!overrides.length) overrides.push(null);
  const styles = overrides.map(o => resolve(text.style, o?.style));
  const pick = <T>(values: T[]): T | Mixed => (values.every(value => sameValue(value, values[0])) ? values[0] : MIXED);
  const out: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) out[key] = pick(styles.map(style => fieldValue(style, key)));
  out.fills = pick(overrides.map(o => o?.fills ?? nodeFills));
  out.textStyleId = pick(overrides.map(o => o?.textStyleId ?? null));
  const first = paragraphAt(text.characters, a).index;
  let last = paragraphAt(text.characters, b).index;
  if (b > a && text.characters[b - 1] === '\n') last = Math.max(first, last - 1);
  const types: ListType[] = [];
  for (let i = first; i <= last; i++) types.push(text.listTypes?.[i] ?? 'NONE');
  out.listType = pick(types);
  return out as RangeStyle;
}

/** Makes the paragraphs [start, end) touches a list of `type` ('NONE' ends the list). A range
 *  ending right after a line break leaves the next paragraph alone (triple-click selections). */
export function setListType(text: TextProps, start: number, end: number, type: ListType): TextProps {
  const [a, b] = clampRange(text, start, end);
  const chars = text.characters;
  const first = paragraphAt(chars, a).index;
  let last = paragraphAt(chars, b).index;
  if (b > a && chars[b - 1] === '\n') last = Math.max(first, last - 1);
  const types: ListType[] = paragraphRanges(chars).map((_, i) => text.listTypes?.[i] ?? 'NONE');
  for (let i = first; i <= last; i++) types[i] = type;
  return withListTypes(text, types);
}

/** Runs sorted, clipped to the text, non-overlapping, non-empty, without fields equal to the base
 *  style (or fills equal to `nodeFills`), and merged where they touch with equal styles. Returns
 *  `text` itself when it already was. */
export function normalizeRuns(text: TextProps, nodeFills?: Paint[]): TextProps {
  const runs = toRuns(toSegments(text), text.style, nodeFills);
  return sameValue(runs, text.runs) ? text : {...text, runs};
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────

const SENTENCE_END = new Set([0x2e, 0x21, 0x3f, 0x2026]);

/** Is `offset` where a sentence starts: the text or a paragraph starts, or only spaces, quotes and
 *  brackets stand between it and a full stop, "!", "?" or "…". */
function sentenceStartsAt(chars: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0; i--) {
    const cp = chars.charCodeAt(i);
    if (cp === 0x0a) return true;
    if (SENTENCE_END.has(cp)) return true;
    if (isLetterOrDigit(cp) || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    if (/[\s"'«»„“”‘’()[\]—–-]/.test(chars[i])) continue;
    return false;
  }
  return true;
}

/** Rewrites the letters of [start, end) ("Case": ALL UPPERCASE, all lowercase, Every Word
 *  Capitalized, Sentence case). Unlike `textCase`, which only changes how text is drawn, this
 *  changes `characters`; runs follow letters whose case form has another length (ß → SS). */
export function transformCase(text: TextProps, start: number, end: number, mode: CaseCommand): TextProps {
  const [a, b] = clampRange(text, start, end);
  if (a === b) return text;
  const chars = text.characters;
  const mapped: number[] = new Array(b - a + 1).fill(-1);
  let out = chars.slice(0, a);
  let sentence = mode === 'SENTENCE' && sentenceStartsAt(chars, a);
  for (let i = a; i < b;) {
    const cp = chars.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    const ch = chars.slice(i, i + size);
    mapped[i - a] = out.length;
    let next = ch;
    if (mode === 'UPPER') next = ch.toUpperCase();
    else if (mode === 'LOWER') next = ch.toLowerCase();
    else if (mode === 'TITLE') next = startsWord(chars, i) ? ch.toUpperCase() : ch;
    else if (isLetterOrDigit(cp)) {
      next = sentence ? ch.toUpperCase() : ch.toLowerCase();
      sentence = false;
    } else if (SENTENCE_END.has(cp) || cp === 0x0a) {
      sentence = true;
    }
    out += next;
    i += size;
  }
  mapped[b - a] = out.length;
  const delta = out.length - b;
  out += chars.slice(b);
  if (out === chars) return text;
  const remap = (offset: number) => {
    if (offset <= a) return offset;
    if (offset >= b) return offset + delta;
    let k = offset - a;
    while (mapped[k] < 0) k--;
    return mapped[k];
  };
  const segments = toSegments(text).map(segment => ({start: remap(segment.start), end: remap(segment.end), o: segment.o}));
  return {...text, characters: out, runs: toRuns(segments, text.style)};
}

/** The link at `offset` (the character after the caret, else the one before) and the extent of
 *  the characters sharing it. */
export function hyperlinkAt(text: TextProps, offset: number): {hyperlink: Hyperlink; start: number; end: number} | null {
  const segments = toSegments(text);
  const linkOf = (segment: Segment) => (segment.o && segment.o.style.hyperlink !== undefined ? segment.o.style.hyperlink : text.style.hyperlink) ?? null;
  const length = text.characters.length;
  for (const at of [offset, offset - 1]) {
    if (at < 0 || at >= length) continue;
    const index = segments.findIndex(segment => segment.start <= at && at < segment.end);
    if (index < 0) continue;
    const link = linkOf(segments[index]);
    if (!link) continue;
    let first = index, last = index;
    while (first > 0 && sameValue(linkOf(segments[first - 1]), link)) first--;
    while (last < segments.length - 1 && sameValue(linkOf(segments[last + 1]), link)) last++;
    return {hyperlink: link, start: segments[first].start, end: segments[last].end};
  }
  return null;
}
