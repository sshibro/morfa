import type {ListType, Paint, SolidPaint, TextProps, TextStyle} from '../../../../shared/design/types';
import {applyFillsToRange, applyStyleToRange, insertText, sameValue, type RunOverride} from '../../../../shared/design/text-edit';
import {DESIGN_FIELD_LIMITS} from '../../../../shared/design/document-limits';
import {cleanPlainText, MAX_CHARACTERS} from './model';
import {styledPieces, normalizeLink} from './style-ops';

// Copying and pasting inside the text editor. The plain text always goes on the clipboard; next to
// it a private type carries the styled pieces, so a copy from one text pasted into another keeps
// its fonts, sizes and colours. What arrives under that type is untrusted (any page can put it on
// the clipboard): it is read field by field, numbers clamped, links checked, and only solid
// colours kept. Pasted plain text takes the style at the caret.

export const RICH_TEXT_MIME = 'application/x-morfa-design-text';

/** The styled pieces of a copy, each with its full style and paints. */
export type RichClip = {
  v: 1;
  characters: string;
  pieces: {start: number; end: number; style: TextStyle; fills: Paint[]}[];
  listTypes?: ListType[];
};

/** What a copy of [start, end) puts on the clipboard. U+2028 line breaks copy as "\n". */
export function copyRange(text: TextProps, nodeFills: Paint[], start: number, end: number): {plain: string; rich: RichClip} | null {
  const a = Math.max(0, Math.min(start, end)), b = Math.min(text.characters.length, Math.max(start, end));
  if (b <= a) return null;
  const characters = text.characters.slice(a, b);
  const pieces = styledPieces(text, a, b).map(piece => ({
    start: piece.start - a,
    end: piece.end - a,
    style: piece.style,
    fills: piece.run?.fills ?? nodeFills,
  }));
  const rich: RichClip = {v: 1, characters, pieces};
  if (text.listTypes?.some(type => type !== 'NONE')) {
    const first = text.characters.slice(0, a).split('\n').length - 1;
    const count = characters.split('\n').length;
    rich.listTypes = Array.from({length: count}, (_, i) => text.listTypes?.[first + i] ?? 'NONE');
  }
  return {plain: characters.replace(/\u2028/g, '\n'), rich};
}

export const serializeClip = (clip: RichClip) => JSON.stringify(clip);

// ── Reading a clip ─────────────────────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown, min: number, max: number): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : null);
const unit = (value: unknown) => num(value, 0, 1);
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | null => (typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : null);

function readStyle(value: unknown): TextStyle | null {
  if (!isObject(value)) return null;
  const family = typeof value.fontFamily === 'string' && value.fontFamily.trim() ? value.fontFamily.slice(0, DESIGN_FIELD_LIMITS.fontFamily) : null;
  const weight = num(value.fontWeight, 1, 1000);
  const size = num(value.fontSize, 0, 100_000);
  if (!family || weight === null || size === null) return null;
  const lh = value.lineHeight;
  const lineHeight: TextStyle['lineHeight'] = isObject(lh) && (lh.unit === 'PIXELS' || lh.unit === 'PERCENT') && num(lh.value, 0, 100_000) !== null
    ? {unit: lh.unit, value: num(lh.value, 0, 100_000)!}
    : {unit: 'AUTO'};
  const ls = value.letterSpacing;
  const letterSpacing: TextStyle['letterSpacing'] = isObject(ls) && (ls.unit === 'PIXELS' || ls.unit === 'PERCENT') && num(ls.value, -100_000, 100_000) !== null
    ? {unit: ls.unit, value: num(ls.value, -100_000, 100_000)!}
    : {unit: 'PERCENT', value: 0};
  const style: TextStyle = {
    fontFamily: family,
    fontWeight: Math.round(weight),
    italic: value.italic === true,
    fontSize: size,
    lineHeight,
    letterSpacing,
    textDecoration: oneOf(value.textDecoration, ['NONE', 'UNDERLINE', 'STRIKETHROUGH'] as const) ?? 'NONE',
    textCase: oneOf(value.textCase, ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS'] as const) ?? 'ORIGINAL',
  };
  const link = value.hyperlink;
  if (isObject(link) && link.type === 'URL' && typeof link.url === 'string') {
    const url = normalizeLink(link.url);
    if (url) style.hyperlink = {type: 'URL', url};
  }
  return style;
}

/** Solid colours only: gradients and pictures of another file do not travel inside a text paste. */
function readFills(value: unknown): Paint[] | null {
  if (!Array.isArray(value) || value.length > DESIGN_FIELD_LIMITS.paints) return null;
  const out: SolidPaint[] = [];
  for (const paint of value) {
    if (!isObject(paint) || paint.type !== 'SOLID' || !isObject(paint.color)) continue;
    const r = unit(paint.color.r), g = unit(paint.color.g), b = unit(paint.color.b);
    if (r === null || g === null || b === null) continue;
    out.push({type: 'SOLID', color: {r, g, b}, opacity: unit(paint.opacity) ?? 1, visible: paint.visible !== false, blendMode: 'NORMAL'});
  }
  return out;
}

/** The clip under the private type, if it is well formed and describes the same characters as the
 *  plain text beside it (another app may have replaced only the plain text). */
export function parseClip(json: string | null | undefined, plain: string | null | undefined): RichClip | null {
  if (!json || json.length > 20_000_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(value) || value.v !== 1 || typeof value.characters !== 'string' || !Array.isArray(value.pieces)) return null;
  const characters = cleanPlainText(value.characters);
  if (!characters || characters.length > MAX_CHARACTERS || characters.length !== value.characters.length) return null;
  if (plain !== undefined && plain !== null && cleanPlainText(plain) !== characters.replace(/\u2028/g, '\n')) return null;
  const pieces: RichClip['pieces'] = [];
  let at = 0;
  for (const raw of value.pieces.slice(0, DESIGN_FIELD_LIMITS.textRuns)) {
    if (!isObject(raw)) return null;
    const start = num(raw.start, 0, characters.length), end = num(raw.end, 0, characters.length);
    const style = readStyle(raw.style);
    const fills = readFills(raw.fills);
    if (start === null || end === null || start !== at || end <= start || !style || !fills) return null;
    pieces.push({start, end, style, fills});
    at = end;
  }
  if (at !== characters.length) return null;
  const clip: RichClip = {v: 1, characters, pieces};
  if (Array.isArray(value.listTypes)) {
    const count = characters.split('\n').length;
    clip.listTypes = value.listTypes.slice(0, count).map(type => oneOf(type, ['NONE', 'ORDERED', 'UNORDERED'] as const) ?? 'NONE');
  }
  return clip;
}

// ── Pasting ────────────────────────────────────────────────────────────────────────────────────

/** Replaces [start, end) with the clip's characters in their own styles and colours. Null when the
 *  text would grow past the document's limit. */
export function pasteClip(text: TextProps, nodeFills: Paint[], start: number, end: number, clip: RichClip): {text: TextProps; fills: Paint[]; caret: number} | null {
  const a = Math.max(0, Math.min(start, end)), b = Math.min(text.characters.length, Math.max(start, end));
  if (text.characters.length - (b - a) + clip.characters.length > MAX_CHARACTERS) return null;
  // Into an empty text the first piece becomes the base style (and its colour the node's), so the
  // text does not carry a run over all of itself.
  const empty = text.characters.length === 0 || (a === 0 && b === text.characters.length);
  let next = insertText(text, a, b, clip.characters, null);
  let fills = nodeFills;
  if (empty && clip.pieces.length) {
    next = {...next, style: {...clip.pieces[0].style}};
    fills = clip.pieces[0].fills;
  }
  for (const piece of clip.pieces) {
    const from = a + piece.start, to = a + piece.end;
    next = applyStyleToRange(next, from, to, {...piece.style, hyperlink: piece.style.hyperlink ?? null});
    if (!sameValue(piece.fills, fills)) next = applyFillsToRange(next, fills, from, to, piece.fills).text;
  }
  if (clip.listTypes?.some(type => type !== 'NONE')) {
    const paragraphsBefore = next.characters.slice(0, a).split('\n').length - 1;
    const total = next.characters.split('\n').length;
    const types: ListType[] = Array.from({length: total}, (_, i) => next.listTypes?.[i] ?? 'NONE');
    clip.listTypes.forEach((type, i) => {
      if (paragraphsBefore + i < total) types[paragraphsBefore + i] = type;
    });
    let length = types.length;
    while (length && types[length - 1] === 'NONE') length--;
    if (length) next = {...next, listTypes: types.slice(0, length)};
    else {
      next = {...next};
      delete next.listTypes;
    }
  }
  return {text: next, fills, caret: a + clip.characters.length};
}

/** Plain text in the style at the caret (`pending` when a caret style is set). */
export function pastePlain(text: TextProps, start: number, end: number, plain: string, pending?: RunOverride | null): {text: TextProps; caret: number} | null {
  const value = cleanPlainText(plain);
  const a = Math.max(0, Math.min(start, end)), b = Math.min(text.characters.length, Math.max(start, end));
  if (!value && a === b) return null;
  if (text.characters.length - (b - a) + value.length > MAX_CHARACTERS) return null;
  return {text: insertText(text, a, b, value, pending === undefined ? undefined : pending), caret: a + value.length};
}
