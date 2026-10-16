import type {Hyperlink, LineHeight, ListType, NodeId, TextProps, TextRun, TextStyle} from '../types';
import {defaultTextStyle} from '../defaults';
import {isSafeDesignUrl} from '../schema';
import {DESIGN_FIELD_LIMITS as L} from '../document-limits';
import type {FigmaNode, FigmaTypeStyle} from './rest-types';
import {matchFigmaFont, weightOfStyle} from './fonts';
import {clamp, coord, finite, paintsOf, size, type Note} from './values';

// TEXT nodes: the base style, `characterStyleOverrides` + `styleOverrideTable` → runs, line height
// units, letter spacing, paragraphs, lists, auto-resize and truncation. Indices are UTF-16 code
// units on both sides. Fonts go through the catalogue (fonts.ts); the families that stood in are
// returned so the node can keep the originals in `pluginData.figmaFont`.

export type TextContext = {
  note: Note;
  /** A Figma node id → its id in the new file (NODE hyperlinks), or undefined when it was not imported. */
  nodeRef: (figmaId: string) => NodeId | undefined;
  /** Called once per substituted family on this layer. */
  substituted: (from: string, to: string) => void;
};

const TEXT_CASES: Record<string, TextStyle['textCase']> = {ORIGINAL: 'ORIGINAL', UPPER: 'UPPER', LOWER: 'LOWER', TITLE: 'TITLE', SMALL_CAPS: 'SMALL_CAPS', SMALL_CAPS_FORCED: 'SMALL_CAPS'};
const DECORATIONS: Record<string, TextStyle['textDecoration']> = {NONE: 'NONE', UNDERLINE: 'UNDERLINE', STRIKETHROUGH: 'STRIKETHROUGH'};

function lineHeightOf(style: FigmaTypeStyle, fontSize: number | undefined): LineHeight | undefined {
  const px = finite(style.lineHeightPx, NaN);
  switch (style.lineHeightUnit) {
    case 'INTRINSIC_%':
      return {unit: 'AUTO'};
    case 'FONT_SIZE_%': {
      const percent = finite(style.lineHeightPercentFontSize, NaN);
      if (Number.isFinite(percent)) return {unit: 'PERCENT', value: size(percent)};
      if (Number.isFinite(px) && fontSize) return {unit: 'PERCENT', value: size((px / fontSize) * 100)};
      return undefined;
    }
    case 'PIXELS':
      return Number.isFinite(px) ? {unit: 'PIXELS', value: size(px)} : undefined;
    default:
      return Number.isFinite(px) ? {unit: 'PIXELS', value: size(px)} : undefined;
  }
}

function hyperlinkOf(link: FigmaTypeStyle['hyperlink'], context: TextContext): Hyperlink | null | undefined {
  if (link === null) return null;
  if (!link || typeof link !== 'object') return undefined;
  if (link.type === 'URL' && typeof link.url === 'string') {
    if (isSafeDesignUrl(link.url)) return {type: 'URL', url: link.url};
    context.note('link-unsafe', 'text', 'Links other than http(s) and mailto were removed from the text');
    return null;
  }
  if (link.type === 'NODE' && typeof link.nodeID === 'string') {
    const target = context.nodeRef(link.nodeID);
    if (target) return {type: 'NODE', nodeId: target};
    context.note('link-node', 'text', 'Links to layers that are not in the file were removed from the text');
    return null;
  }
  return undefined;
}

/** The fields a Figma type style sets, as a partial of ours. */
export function styleOf(style: FigmaTypeStyle | undefined, context: TextContext, baseSize?: number): Partial<TextStyle> {
  if (!style || typeof style !== 'object') return {};
  const out: Partial<TextStyle> = {};
  if (typeof style.fontFamily === 'string' && style.fontFamily.trim()) {
    const match = matchFigmaFont(style.fontFamily);
    out.fontFamily = match.family.slice(0, L.fontFamily);
    if (match.substituted) context.substituted(style.fontFamily.trim(), match.family);
  }
  const weight = finite(style.fontWeight, NaN);
  if (Number.isFinite(weight)) out.fontWeight = clamp(weight, 1, 1000);
  else {
    const named = weightOfStyle(style.fontStyle);
    if (named) out.fontWeight = named;
  }
  if (typeof style.italic === 'boolean') out.italic = style.italic;
  else if (typeof style.fontStyle === 'string' && /italic|oblique/i.test(style.fontStyle)) out.italic = true;
  const fontSize = finite(style.fontSize, NaN);
  if (Number.isFinite(fontSize)) out.fontSize = clamp(fontSize, 0, 100_000);
  const lineHeight = lineHeightOf(style, out.fontSize ?? baseSize);
  if (lineHeight) out.lineHeight = lineHeight;
  const spacing = finite(style.letterSpacing, NaN);
  if (Number.isFinite(spacing)) out.letterSpacing = {unit: 'PIXELS', value: coord(spacing)};
  if (typeof style.textDecoration === 'string' && DECORATIONS[style.textDecoration]) out.textDecoration = DECORATIONS[style.textDecoration];
  if (typeof style.textCase === 'string' && TEXT_CASES[style.textCase]) out.textCase = TEXT_CASES[style.textCase];
  const link = hyperlinkOf(style.hyperlink, context);
  if (link !== undefined) out.hyperlink = link;
  return out;
}

/** Runs from Figma's per-character override ids. */
function runsOf(node: FigmaNode, length: number, base: TextStyle, context: TextContext): TextRun[] {
  const ids = Array.isArray(node.characterStyleOverrides) ? node.characterStyleOverrides : [];
  const table = node.styleOverrideTable && typeof node.styleOverrideTable === 'object' ? node.styleOverrideTable : {};
  const mapped = new Map<number, {style: Partial<TextStyle>; fills?: TextRun['fills']}>();
  const entryOf = (id: number) => {
    let entry = mapped.get(id);
    if (entry) return entry;
    const source = Object.hasOwn(table, String(id)) ? table[String(id)] : undefined;
    const style = styleOf(source, context, base.fontSize);
    entry = {style};
    if (source && Array.isArray(source.fills)) entry.fills = paintsOf(source.fills, context.note);
    mapped.set(id, entry);
    return entry;
  };
  const runs: TextRun[] = [];
  const end = Math.min(ids.length, length);
  let start = 0;
  while (start < end) {
    const id = ids[start];
    let stop = start + 1;
    while (stop < end && ids[stop] === id) stop++;
    if (typeof id === 'number' && id !== 0) {
      const entry = entryOf(id);
      if (Object.keys(entry.style).length || entry.fills) {
        const run: TextRun = {start, end: stop, style: {...entry.style}};
        if (entry.fills) run.fills = entry.fills;
        runs.push(run);
      }
    }
    start = stop;
    if (runs.length >= L.textRuns) {
      context.note('text-runs', 'text', 'Not all style runs were kept in very mixed text');
      break;
    }
  }
  return runs;
}

function listTypesOf(node: FigmaNode, characters: string): ListType[] | undefined {
  if (!Array.isArray(node.lineTypes) || !node.lineTypes.some(type => type === 'ORDERED' || type === 'UNORDERED')) return undefined;
  const paragraphs = characters.split('\n').length;
  return node.lineTypes.slice(0, Math.min(paragraphs, L.listTypes)).map(type => (type === 'ORDERED' || type === 'UNORDERED' ? type : 'NONE'));
}

/** The text of a TEXT node, its fills come with the node. */
export function textPropsOf(node: FigmaNode, context: TextContext): TextProps {
  let characters = typeof node.characters === 'string' ? node.characters : '';
  if (characters.length > L.characters) {
    context.note('text-long', 'text', `Text longer than ${L.characters.toLocaleString('en-US')} characters was truncated`);
    characters = characters.slice(0, L.characters);
  }
  const figma = node.style ?? {};
  const base: TextStyle = {...defaultTextStyle(), ...styleOf(figma, context)};
  if (base.hyperlink === null) delete base.hyperlink;
  const horizontal = figma.textAlignHorizontal === 'CENTER' || figma.textAlignHorizontal === 'RIGHT' || figma.textAlignHorizontal === 'JUSTIFIED' ? figma.textAlignHorizontal : 'LEFT';
  const vertical = figma.textAlignVertical === 'CENTER' || figma.textAlignVertical === 'BOTTOM' ? figma.textAlignVertical : 'TOP';
  let autoResize: TextProps['textAutoResize'] = figma.textAutoResize === 'WIDTH_AND_HEIGHT' || figma.textAutoResize === 'HEIGHT' ? figma.textAutoResize : figma.textAutoResize === 'TRUNCATE' ? 'TRUNCATE' : 'NONE';
  let maxLines: number | null | undefined;
  if (figma.textTruncation === 'ENDING') {
    autoResize = 'TRUNCATE';
    const lines = finite(figma.maxLines, NaN);
    if (Number.isFinite(lines) && lines >= 1) maxLines = Math.min(100_000, Math.floor(lines));
  }
  const props: TextProps = {
    characters,
    style: base,
    runs: runsOf(node, characters.length, base, context),
    textAlignHorizontal: horizontal,
    textAlignVertical: vertical,
    textAutoResize: autoResize,
    paragraphSpacing: coord(figma.paragraphSpacing),
    paragraphIndent: coord(figma.paragraphIndent),
  };
  const lists = listTypesOf(node, characters);
  if (lists) {
    props.listTypes = lists;
    if (Array.isArray(node.lineIndentations) && node.lineIndentations.some(level => finite(level) > 1)) context.note('list-nesting', 'text', 'Nested list levels were aligned to the first level');
  }
  if (maxLines) props.maxLines = maxLines;
  if (figma.leadingTrim === 'CAP_HEIGHT') context.note('text-trim', 'text', 'Trimming line height to cap height is not imported');
  if (figma.opentypeFlags && Object.keys(figma.opentypeFlags).length) context.note('text-opentype', 'text', 'Special OpenType settings are not imported');
  return props;
}
