import type {DesignDocument, Hyperlink, ListType, Paint, SceneNode, TextProps, TextRun, TextStyle} from '../../../../shared/design/types';
import {applyFillsToRange, applyStyleToRange, hyperlinkAt, normalizeRuns, sameValue, setListType} from '../../../../shared/design/text-edit';
import {editTextRange, TEXT_STYLE_KEYS} from '../../../../shared/design/styles';
import {sizingFixes} from '../../../../shared/design/layout';
import {nearestWeight} from '../fonts';
import {paragraphsOf} from './model';

// Text formatting as node patches, shared by the editor (a range of the text being edited), the
// commands (⌘B, ⌥⌘T…) and the "Text" section (whole selected texts). Pure: each returns the fields
// to hand to `userUpdate`, or null when nothing would change.
//
// Typing a value that a text style ("Text style") sets detaches it, as in Figma: over the whole
// text the node's `textStyleId` goes, over a range the runs of that range lose theirs. A link, the
// colour and paragraph settings are not part of a text style and leave it alone.

export type StyleChange = Partial<TextStyle> | ((style: TextStyle) => Partial<TextStyle> | null);

const STYLED = new Set<string>(TEXT_STYLE_KEYS);

const clampRange = (length: number, start: number, end: number): [number, number] => {
  const a = Math.max(0, Math.min(length, start)), b = Math.max(0, Math.min(length, end));
  return a <= b ? [a, b] : [b, a];
};

/** The range [start, end) cut at run edges, each piece with the style its characters show. An
 *  empty range (or text) gives the style at `start`. */
export function styledPieces(text: TextProps, start: number, end: number): {start: number; end: number; style: TextStyle; run: TextRun | null}[] {
  const length = text.characters.length;
  const [a, b] = clampRange(length, start, end);
  const runs = [...(text.runs ?? [])].filter(run => run.end > run.start).sort((x, y) => x.start - y.start);
  const resolved = (run: TextRun | null): TextStyle => (run ? {...text.style, ...definedOf(run.style)} : text.style);
  if (a === b) {
    const at = a > 0 && a === length ? a - 1 : a;
    const run = runs.find(r => r.start <= at && at < r.end) ?? null;
    return [{start: a, end: b, style: resolved(run), run}];
  }
  const pieces: {start: number; end: number; style: TextStyle; run: TextRun | null}[] = [];
  let at = a;
  for (const run of runs) {
    if (run.end <= at) continue;
    if (run.start >= b) break;
    if (run.start > at) pieces.push({start: at, end: run.start, style: text.style, run: null});
    const s = Math.max(at, run.start), e = Math.min(b, run.end);
    pieces.push({start: s, end: e, style: resolved(run), run});
    at = e;
  }
  if (at < b) pieces.push({start: at, end: b, style: text.style, run: null});
  return pieces;
}

function definedOf(style: Partial<TextStyle> | undefined): Partial<TextStyle> {
  const out: Partial<TextStyle> = {};
  if (!style) return out;
  for (const key of Object.keys(style) as (keyof TextStyle)[]) if (style[key] !== undefined) (out as Record<string, unknown>)[key] = style[key];
  return out;
}

const withoutStyleId = (run: TextRun): TextRun => {
  if (!run.textStyleId) return run;
  const next = {...run};
  delete next.textStyleId;
  return next;
};

/** Sets style fields over [start, end) of the node's text: `change` is the fields, or a function
 *  of each piece's current style (relative changes such as "size +1" or bold toggles on a
 *  selection of mixed weights). */
export function restyleRange(node: SceneNode, start: number, end: number, change: StyleChange): Partial<SceneNode> | null {
  const text = node.text;
  if (!text) return null;
  const length = text.characters.length;
  const [a, b] = clampRange(length, start, end);
  const whole = length === 0 || (a === 0 && b === length);
  if (a === b && !whole) return null;
  let next = text;
  const keys = new Set<string>();
  if (typeof change !== 'function') {
    const fields = definedOf(change);
    if (!Object.keys(fields).length) return null;
    Object.keys(fields).forEach(key => keys.add(key));
    next = applyStyleToRange(text, a, b, fields);
  } else {
    const pieces = styledPieces(text, a, b);
    const partials = pieces.map(piece => {
      const partial = change(piece.style);
      return partial ? definedOf(partial) : null;
    });
    if (partials.every(partial => !partial || !Object.keys(partial).length)) return null;
    partials.forEach(partial => partial && Object.keys(partial).forEach(key => keys.add(key)));
    if (whole && partials.every(partial => sameValue(partial, partials[0]))) next = applyStyleToRange(text, 0, length, partials[0]!);
    else pieces.forEach((piece, i) => {
      const partial = partials[i];
      if (partial && Object.keys(partial).length) next = applyStyleToRange(next, piece.start, piece.end, partial);
    });
  }
  const patch: Partial<SceneNode> = {};
  if ([...keys].some(key => STYLED.has(key))) {
    if (whole) {
      if (node.textStyleId) patch.textStyleId = undefined;
      if (next.runs.some(run => run.textStyleId)) next = normalizeRuns({...next, runs: next.runs.map(withoutStyleId)}, node.fills);
    } else if (next.runs.some(run => run.textStyleId && run.start < b && run.end > a)) {
      next = {...next, runs: editTextRange(next, a, b, withoutStyleId, node.fills)};
    }
  }
  if (next !== text) patch.text = next;
  return Object.keys(patch).length ? patch : null;
}

/** Paints [start, end); over the whole text the node's fills change (and range colours go). */
export function refillRange(node: SceneNode, start: number, end: number, fills: Paint[]): Partial<SceneNode> | null {
  if (!node.text) return null;
  const length = node.text.characters.length;
  const [a, b] = clampRange(length, start, end);
  const whole = length === 0 || (a === 0 && b === length);
  if (!whole && a === b) return null;
  const result = applyFillsToRange(node.text, node.fills, a, b, fills);
  const patch: Partial<SceneNode> = {};
  if (result.text !== node.text) patch.text = result.text;
  if (whole) patch.fills = fills;
  return Object.keys(patch).length ? patch : null;
}

/** Paragraph and box settings of the text (alignment, auto-resize, spacing, max lines). A new
 *  auto-resize mode brings the layout sizing fields in step (shared/design/layout.ts). */
export function setTextProps(doc: DesignDocument, node: SceneNode, partial: Partial<Pick<TextProps, 'textAlignHorizontal' | 'textAlignVertical' | 'textAutoResize' | 'paragraphSpacing' | 'paragraphIndent' | 'maxLines'>>): Partial<SceneNode> | null {
  const text = node.text;
  if (!text) return null;
  const keys = Object.keys(partial) as (keyof typeof partial)[];
  if (keys.every(key => sameValue(text[key] ?? null, partial[key] ?? null))) return null;
  const next: TextProps = {...text, ...partial};
  if (partial.maxLines === null) delete next.maxLines;
  const patch: Partial<SceneNode> = {text: next};
  if (partial.textAutoResize && partial.textAutoResize !== text.textAutoResize) {
    const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
    // Picking a mode that hugs stops the text filling its auto-layout parent on that side (Figma
    // does the same), otherwise the fill would turn the mode straight back.
    const mode = partial.textAutoResize;
    if (mode === 'WIDTH_AND_HEIGHT' && node.layoutSizingHorizontal === 'FILL') patch.layoutSizingHorizontal = 'HUG';
    if ((mode === 'WIDTH_AND_HEIGHT' || mode === 'HEIGHT') && node.layoutSizingVertical === 'FILL') patch.layoutSizingVertical = 'HUG';
    const fixes = sizingFixes({...node, ...patch, text: next}, parent);
    if (fixes) Object.assign(patch, fixes);
  }
  return patch;
}

/** Makes the paragraphs [start, end) touches a list of `type`, or ends the list when they all are
 *  one already and `toggle` is set (⇧⌘8, ⇧⌘7). */
export function listRange(node: SceneNode, start: number, end: number, type: ListType, toggle = false): Partial<SceneNode> | null {
  const text = node.text;
  if (!text) return null;
  const [a, b] = clampRange(text.characters.length, start, end);
  let target = type;
  if (toggle && type !== 'NONE') {
    const all = paragraphsOf(text.characters, a, b).every(index => (text.listTypes?.[index] ?? 'NONE') === type);
    if (all) target = 'NONE';
  }
  const next = setListType(text, a, b, target);
  return sameValue(next.listTypes ?? null, text.listTypes ?? null) ? null : {text: next};
}

/** The list type of the paragraphs [start, end) touches, or 'mixed'. */
export function listTypeOf(text: TextProps, start: number, end: number): ListType | 'mixed' {
  const types = paragraphsOf(text.characters, start, end).map(index => text.listTypes?.[index] ?? 'NONE');
  return types.every(type => type === types[0]) ? types[0] : 'mixed';
}

/** Links [start, end) to `link` (null removes it). With a caret inside a link the whole link
 *  changes, as link editors do; with a caret elsewhere nothing does. */
export function linkRange(node: SceneNode, start: number, end: number, link: Hyperlink | null): Partial<SceneNode> | null {
  const text = node.text;
  if (!text) return null;
  let [a, b] = clampRange(text.characters.length, start, end);
  if (a === b && text.characters.length) {
    const current = hyperlinkAt(text, a);
    if (!current) return null;
    a = current.start;
    b = current.end;
  }
  return restyleRange(node, a, b, {hyperlink: link});
}

/** http(s) only, as the brief and the player require; a bare domain gets https://. Returns the
 *  normalized URL or null when the value cannot be a web link. */
export function normalizeLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : /^[^\s/]+\.[^\s/]{2,}/.test(trimmed) ? `https://${trimmed}` : trimmed;
  if (candidate.length > 2048) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// ── Toggles ────────────────────────────────────────────────────────────────────────────────────

/** Weight a "Bold" toggle gives a family: its bold (700) or the nearest heavier face, and back
 *  to its regular (400) or the nearest face. Unknown families keep 700/400. */
export function boldWeight(weights: readonly number[] | null): number {
  if (!weights?.length) return 700;
  const heavy = weights.filter(w => w >= 600);
  return heavy.length ? nearestWeight(heavy, 700) : Math.max(...weights);
}
export function regularWeight(weights: readonly number[] | null): number {
  return weights?.length ? nearestWeight(weights, 400) : 400;
}
export const isBold = (style: TextStyle) => style.fontWeight >= 600;

/** ⌘B over pieces of mixed weight: everything bold unless everything already is. */
export function boldChange(pieces: readonly TextStyle[], weightsOf: (family: string) => readonly number[] | null): StyleChange {
  const makeBold = !pieces.every(isBold);
  return style => {
    const weight = makeBold ? (isBold(style) ? style.fontWeight : boldWeight(weightsOf(style.fontFamily))) : regularWeight(weightsOf(style.fontFamily));
    return weight === style.fontWeight ? null : {fontWeight: weight};
  };
}

export function italicChange(pieces: readonly TextStyle[]): StyleChange {
  const italic = !pieces.every(style => style.italic);
  return {italic};
}

export function decorationChange(pieces: readonly TextStyle[], decoration: 'UNDERLINE' | 'STRIKETHROUGH'): StyleChange {
  const all = pieces.every(style => style.textDecoration === decoration);
  return {textDecoration: all ? 'NONE' : decoration};
}

export function caseChange(pieces: readonly TextStyle[], textCase: 'UPPER' | 'LOWER'): StyleChange {
  const all = pieces.every(style => style.textCase === textCase);
  return {textCase: all ? 'ORIGINAL' : textCase};
}

/** ⇧⌘> and ⇧⌘<: every piece one pixel larger or smaller (whole pixels, at least 1). */
/** ⌥⌘> / ⌥⌘< (Figma's "Increase/decrease weight"): the next heavier or lighter face the
 *  family has (100-steps where the faces are unknown), staying within 100…900. */
export function weightStep(delta: 1 | -1, weightsOf: (family: string) => readonly number[] | null): StyleChange {
  return style => {
    const faces = [...(weightsOf(style.fontFamily) ?? [100, 200, 300, 400, 500, 600, 700, 800, 900])].sort((a, b) => a - b);
    const next = delta > 0 ? faces.find(w => w > style.fontWeight) : [...faces].reverse().find(w => w < style.fontWeight);
    return next === undefined || next === style.fontWeight ? null : {fontWeight: next};
  };
}

export function sizeStep(delta: number): StyleChange {
  return style => {
    const size = Math.max(1, Math.round(style.fontSize) + delta);
    return size === style.fontSize ? null : {fontSize: size};
  };
}

/** One step of the "Text" section's ↑/↓ for letter spacing and line height: 1 in the value's own unit. */
export const SPACING_STEP = 1;
const hundredths = (value: number) => Math.round(value * 100) / 100;

/** ⌥> / ⌥<: letter spacing by `delta` in its unit (0 % when unset). */
export function letterSpacingStep(delta: number): StyleChange {
  return style => {
    const current = style.letterSpacing ?? {unit: 'PERCENT' as const, value: 0};
    const value = hundredths(current.value + delta);
    return value === current.value ? null : {letterSpacing: {unit: current.unit, value}};
  };
}

/** ⌥⇧> / ⌥⇧<: line height by `delta` in its unit. "Auto" starts from the height it stands for, in px
 *  (`autoPixels`, from the font's ascent and descent), as a step of the panel's field does. */
export function lineHeightStep(delta: number, autoPixels: (style: TextStyle) => number): StyleChange {
  return style => {
    const current = style.lineHeight;
    const from = current.unit === 'AUTO' ? {unit: 'PIXELS' as const, value: hundredths(autoPixels(style))} : current;
    const value = Math.max(0, hundredths(from.value + delta));
    return current.unit !== 'AUTO' && value === current.value ? null : {lineHeight: {unit: from.unit, value}};
  };
}
