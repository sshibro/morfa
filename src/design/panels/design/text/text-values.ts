import type {Hyperlink, LetterSpacing, LineHeight, ListType, NodeId, SceneNode, StyleId, TextCase, TextDecoration, TextProps} from '../../../../../shared/design/types';
import {sameValue, styleAtRange, MIXED, type RunOverride} from '../../../../../shared/design/text-edit';
import {listTypeOf, styledPieces} from '../../../engine/text-editor/style-ops';
import type {TextEditingSnapshot} from '../../../engine/text-editor/registry';

// What the "Text" section shows: each property's value over the editor's selection (or at its
// caret, with a pending caret style on top) or over the selected texts whole; 'mixed' ("Mixed")
// where they differ. Pure, so node tests cover it.

export type Mixed<T> = T | typeof MIXED;

export type TextPanelValues = {
  ids: NodeId[];
  /** The values describe the editor's selection, not whole layers. */
  editing: boolean;
  fontFamily: Mixed<string>;
  fontWeight: Mixed<number>;
  italic: Mixed<boolean>;
  fontSize: Mixed<number>;
  lineHeight: Mixed<LineHeight>;
  letterSpacing: Mixed<LetterSpacing>;
  textDecoration: Mixed<TextDecoration>;
  textCase: Mixed<TextCase>;
  hyperlink: Mixed<Hyperlink | null>;
  listType: Mixed<ListType>;
  textAlignHorizontal: Mixed<TextProps['textAlignHorizontal']>;
  textAlignVertical: Mixed<TextProps['textAlignVertical']>;
  textAutoResize: Mixed<TextProps['textAutoResize']>;
  paragraphSpacing: Mixed<number>;
  paragraphIndent: Mixed<number>;
  maxLines: Mixed<number | null>;
  /** The text style of the selection (a range's own, else the layer's), null for none. */
  textStyleId: Mixed<StyleId | null>;
  /** Every family the targeted texts use (missing-font warnings look at these). */
  families: string[];
};

const merge = <T>(values: readonly T[]): Mixed<T> => (values.length && values.every(value => sameValue(value, values[0])) ? values[0] : MIXED);

/** The style keys of a pending caret style laid over a range style. */
function withPending(range: ReturnType<typeof styleAtRange>, pending: RunOverride | null | undefined, base: TextProps['style']) {
  if (pending === undefined) return range;
  const next = {...range} as Record<string, unknown>;
  const style = {...base, ...(pending?.style ?? {})} as Record<string, unknown>;
  for (const key of ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase']) next[key] = style[key];
  next.hyperlink = (pending?.style?.hyperlink ?? base.hyperlink) ?? null;
  next.textStyleId = pending?.textStyleId ?? null;
  return next as ReturnType<typeof styleAtRange>;
}

type Range = {style: ReturnType<typeof styleAtRange>; textStyleId: Mixed<StyleId | null>; listType: ListType | 'mixed'};

/** A whole text's range values, kept per text (texts are replaced, never changed in place) with the fills and style id
 *  they also depend on: a drag or a nudge of hundreds of selected texts re-reads them instead of working them out
 *  again on every frame. */
const wholeTexts = new WeakMap<TextProps, {fills: SceneNode['fills']; textStyleId: StyleId | undefined; range: Range; families: readonly string[]}>();
function wholeText(node: SceneNode): {range: Range; families: readonly string[]} {
  const text = node.text!;
  const known = wholeTexts.get(text);
  if (known && known.fills === node.fills && known.textStyleId === node.textStyleId) return known;
  const length = text.characters.length;
  const style = styleAtRange(text, 0, length, node.fills);
  const range: Range = {style, textStyleId: style.textStyleId === MIXED ? MIXED : style.textStyleId ?? node.textStyleId ?? null, listType: listTypeOf(text, 0, length)};
  const families = [...new Set(styledPieces(text, 0, length).map(piece => piece.style.fontFamily))];
  const value = {fills: node.fills, textStyleId: node.textStyleId, range, families};
  wholeTexts.set(text, value);
  return value;
}

/** The values over `selected` (the section's nodes); while one of them is edited, over the
 *  editor's selection in it. */
export function textPanelValues(selected: readonly SceneNode[], editing: TextEditingSnapshot): TextPanelValues | null {
  const nodes = selected.filter(node => node.type === 'TEXT' && !!node.text);
  if (!nodes.length) return null;
  const edited = (editing && nodes.find(node => node.id === editing.id)) || null;
  const targets = edited ? [edited] : nodes;
  const ranges: Range[] = targets.map(node => {
    if (!edited) return wholeText(node).range;
    const text = node.text!;
    const length = text.characters.length;
    const start = Math.min(editing!.start, length);
    const end = Math.min(editing!.end, length);
    let style = styleAtRange(text, start, end, node.fills);
    if (start === end) style = withPending(style, editing!.pending, text.style);
    const own = style.textStyleId === MIXED ? MIXED : style.textStyleId ?? (start === 0 && end === length || start === end ? node.textStyleId ?? null : null);
    return {style, textStyleId: own, listType: listTypeOf(text, start, end)};
  });
  const pick = <K extends keyof ReturnType<typeof styleAtRange>>(key: K) => {
    const values = ranges.map(range => range.style[key]);
    return values.some(value => value === MIXED) ? MIXED : merge(values);
  };
  const families = new Set<string>();
  for (const node of nodes) for (const family of wholeText(node).families) families.add(family);
  return {
    ids: nodes.map(node => node.id),
    editing: !!edited,
    fontFamily: pick('fontFamily') as Mixed<string>,
    fontWeight: pick('fontWeight') as Mixed<number>,
    italic: pick('italic') as Mixed<boolean>,
    fontSize: pick('fontSize') as Mixed<number>,
    lineHeight: pick('lineHeight') as Mixed<LineHeight>,
    letterSpacing: pick('letterSpacing') as Mixed<LetterSpacing>,
    textDecoration: pick('textDecoration') as Mixed<TextDecoration>,
    textCase: pick('textCase') as Mixed<TextCase>,
    hyperlink: (() => {
      const values = ranges.map(range => (range.style.hyperlink === MIXED ? MIXED : range.style.hyperlink ?? null));
      return values.some(value => value === MIXED) ? MIXED : merge(values);
    })(),
    listType: ranges.some(range => range.listType === 'mixed') ? MIXED : merge(ranges.map(range => range.listType as ListType)),
    textAlignHorizontal: merge(targets.map(node => node.text!.textAlignHorizontal)),
    textAlignVertical: merge(targets.map(node => node.text!.textAlignVertical)),
    textAutoResize: merge(targets.map(node => node.text!.textAutoResize)),
    paragraphSpacing: merge(targets.map(node => node.text!.paragraphSpacing ?? 0)),
    paragraphIndent: merge(targets.map(node => node.text!.paragraphIndent ?? 0)),
    maxLines: merge(targets.map(node => node.text!.maxLines ?? null)),
    textStyleId: ranges.some(range => range.textStyleId === MIXED) ? MIXED : merge(ranges.map(range => range.textStyleId as StyleId | null)),
    families: [...families],
  };
}

/** Line height or letter spacing as the field shows it: "Auto", "120%", "24". */
export function formatUnitValue(value: Mixed<LineHeight | LetterSpacing> | undefined): string {
  if (value === undefined || value === MIXED) return '';
  if (value.unit === 'AUTO') return 'Auto';
  const number = Math.round(value.value * 100) / 100;
  return value.unit === 'PERCENT' ? `${number}%` : String(number);
}

/** What the user typed into the line-height or letter-spacing field: "auto" (line height only),
 *  "120%", "24", "24px", arithmetic on the number. Null when it is not a value. */
export function parseUnitValue(input: string, kind: 'lineHeight' | 'letterSpacing', current: Mixed<LineHeight | LetterSpacing>, evaluate: (text: string, base: number | null) => number | null): LineHeight | LetterSpacing | null {
  const text = input.trim().toLowerCase();
  if (kind === 'lineHeight' && (text === '' || text === 'auto')) return {unit: 'AUTO'};
  const percent = /%\s*$/.test(text);
  const pixels = /(px)\s*$/.test(text);
  const number = text.replace(/(%|px)\s*$/, '').trim();
  const base = current !== MIXED && current.unit !== 'AUTO' ? current.value : null;
  const value = evaluate(number, base);
  if (value === null || !Number.isFinite(value)) return null;
  // A bare number is pixels for line height (as Figma reads it) and keeps the unit for letter spacing.
  const unit = percent ? 'PERCENT' : pixels ? 'PIXELS' : kind === 'lineHeight' ? 'PIXELS' : current !== MIXED && current.unit !== 'AUTO' ? current.unit : 'PERCENT';
  if (kind === 'lineHeight' && value < 0) return null;
  return {unit, value: Math.round(value * 100) / 100};
}
