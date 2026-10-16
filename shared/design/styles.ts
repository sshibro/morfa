import type {DesignDocument, NodeId, Paint, SceneNode, Style, StyleId, StyleType, TextProps, TextRun, TextStyle} from './types';
import {FRAME_LIKE_TYPES} from './types';
import {newId} from './defaults';
import {applyFillsToRange, applyStyleToRange, normalizeRuns} from './text-edit';
import type {NodeUpdates} from './constraints';

// Local styles ("Styles"): named fills, type, effects and layout grids. A node keeps the concrete
// values and the id of the style they came from, so renderers and exporters never resolve styles;
// editing a style rewrites every node that uses it. Text styles apply to a whole text or to a range
// of it (runs carry their own `textStyleId`). Editing a styled value by hand detaches the style
// (`clearsStyle`), as in Figma.

/** Where a style is used on a node. A FILL style can colour fills or strokes. */
export type StyleKind = 'fill' | 'stroke' | 'text' | 'effect' | 'grid';
export type StyleIdField = 'fillStyleId' | 'strokeStyleId' | 'textStyleId' | 'effectStyleId' | 'gridStyleId';

export const STYLE_ID_FIELD: Record<StyleKind, StyleIdField> = {
  fill: 'fillStyleId', stroke: 'strokeStyleId', text: 'textStyleId', effect: 'effectStyleId', grid: 'gridStyleId',
};

/** The properties a text style carries: everything in `TextStyle` but the link. */
export const TEXT_STYLE_KEYS = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase'] as const;
type StyledText = Omit<TextStyle, 'hyperlink'>;

const clone = <T>(value: T): T => structuredClone(value);

function pickTextStyle(style: Partial<TextStyle>): Partial<StyledText> {
  const out: Partial<StyledText> = {};
  for (const key of TEXT_STYLE_KEYS) if (style[key] !== undefined) (out as Record<string, unknown>)[key] = clone(style[key]);
  return out;
}

/** The style a text shows at its first character (base style under the first run's overrides). */
function textStyleAtStart(text: TextProps): StyledText {
  const run = text.runs.find(r => r.start === 0 && r.end > 0);
  return {...pickTextStyle(text.style), ...(run ? pickTextStyle(run.style) : {})} as StyledText;
}

/** A new style made from the node's current values, or null when the node has nothing of that
 *  type (a text style from a rectangle, a grid style from a group). */
export function createStyleFromNode(doc: DesignDocument, nodeId: NodeId, type: StyleType, name: string, id: StyleId = newId()): Style | null {
  const node = doc.nodes[nodeId];
  if (!node) return null;
  const style: Style = {id, type, name: name.trim() || defaultStyleName(type), description: ''};
  switch (type) {
    case 'FILL':
      if (!node.fills.length) return null;
      style.paints = clone(node.fills);
      return style;
    case 'TEXT':
      if (!node.text) return null;
      style.text = textStyleAtStart(node.text);
      return style;
    case 'EFFECT':
      if (!node.effects.length) return null;
      style.effects = clone(node.effects);
      return style;
    case 'GRID':
      if (!node.layoutGrids?.length) return null;
      style.grids = clone(node.layoutGrids);
      return style;
  }
}

const DEFAULT_NAMES: Record<StyleType, string> = {FILL: 'Color', TEXT: 'Text', EFFECT: 'Effect', GRID: 'Grid'};
export const defaultStyleName = (type: StyleType) => DEFAULT_NAMES[type];

// ── Text runs ──────────────────────────────────────────────────────────────────────────────────

/** Runs in the text module's normal form (sorted, minimal, nothing equal to the base style or
 *  the node's fills), so the panel and the editor compare them as they compare their own. */
const tidy = (text: TextProps, runs: TextRun[], nodeFills?: Paint[]): TextRun[] => normalizeRuns({...text, runs}, nodeFills).runs;

/** Runs with `edit` applied to every character in [start, end): existing runs are split at the
 *  range's edges and the gaps between them become runs of their own. */
export function editTextRange(text: TextProps, start: number, end: number, edit: (run: TextRun) => TextRun, nodeFills?: Paint[]): TextRun[] {
  const out: TextRun[] = [];
  let cursor = start;
  for (const run of text.runs) {
    if (run.end <= start || run.start >= end) {
      out.push(run);
      continue;
    }
    if (run.start < start) out.push({...run, style: {...run.style}, end: start});
    const from = Math.max(run.start, start), to = Math.min(run.end, end);
    if (from > cursor) out.push(edit({start: cursor, end: from, style: {}}));
    out.push(edit({...run, style: {...run.style}, start: from, end: to}));
    cursor = to;
    if (run.end > end) out.push({...run, style: {...run.style}, start: end});
  }
  if (cursor < end) out.push(edit({start: cursor, end, style: {}}));
  return tidy(text, out, nodeFills);
}

/** A run without the properties a text style sets (what applying a style to the whole text resets). */
function stripStyled(run: TextRun): TextRun {
  const style = {...run.style};
  for (const key of TEXT_STYLE_KEYS) delete style[key];
  const next: TextRun = {...run, style};
  delete next.textStyleId;
  return next;
}

// ── Applying ───────────────────────────────────────────────────────────────────────────────────

export type ApplyStyleOptions = {
  /** FILL styles: colour the strokes instead of the fills. */
  target?: 'fills' | 'strokes';
  /** TEXT styles: only these characters (UTF-16, end exclusive). */
  range?: {start: number; end: number};
};

function applyTo(node: SceneNode, style: Style, options: ApplyStyleOptions): Partial<SceneNode> | null {
  switch (style.type) {
    case 'FILL': {
      if (!style.paints || node.type === 'PAGE') return null;
      if (options.target === 'strokes') return {strokes: clone(style.paints), strokeStyleId: style.id};
      const patch: Partial<SceneNode> = {fills: clone(style.paints), fillStyleId: style.id};
      // A colour for the whole text replaces colours set on ranges of it.
      if (node.text?.runs.some(run => run.fills)) patch.text = applyFillsToRange(node.text, node.fills, 0, node.text.characters.length, patch.fills!).text;
      return patch;
    }
    case 'TEXT': {
      if (!style.text || !node.text) return null;
      const text = node.text, length = text.characters.length;
      const range = options.range;
      const values = pickTextStyle(style.text);
      if (range && (range.start > 0 || range.end < length)) {
        const start = Math.max(0, Math.min(length, range.start)), end = Math.max(start, Math.min(length, range.end));
        if (start === end) return null;
        return {text: {...text, runs: editTextRange(text, start, end, run => ({...run, style: {...run.style, ...clone(values)}, textStyleId: style.id}), node.fills)}};
      }
      return {
        textStyleId: style.id,
        text: applyStyleToRange({...text, runs: text.runs.map(stripStyled)}, 0, length, values),
      };
    }
    case 'EFFECT':
      return style.effects ? {effects: clone(style.effects), effectStyleId: style.id} : null;
    case 'GRID':
      return style.grids && FRAME_LIKE_TYPES.includes(node.type) ? {layoutGrids: clone(style.grids), gridStyleId: style.id} : null;
  }
}

/** Updates that give the nodes the style's values and its id. Nodes the style does not apply to
 *  are skipped. */
export function applyStyle(doc: DesignDocument, nodeIds: readonly NodeId[], styleId: StyleId, options: ApplyStyleOptions = {}): NodeUpdates {
  const updates: NodeUpdates = new Map();
  const style = doc.styles[styleId];
  if (!style) return updates;
  for (const id of nodeIds) {
    const node = doc.nodes[id];
    const patch = node && applyTo(node, style, options);
    if (patch) updates.set(id, patch);
  }
  return updates;
}

/** Updates that rewrite every user of `style` (its new version) with its values: nodes through
 *  their style ids, text ranges through their runs. Local overrides inside a styled text stay. */
export function updateStyleUpdates(doc: DesignDocument, style: Style): NodeUpdates {
  const updates: NodeUpdates = new Map();
  const values = style.text ? pickTextStyle(style.text) : null;
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    const patch: Partial<SceneNode> = {};
    if (style.paints && node.fillStyleId === style.id) patch.fills = clone(style.paints);
    if (style.paints && node.strokeStyleId === style.id) patch.strokes = clone(style.paints);
    if (style.effects && node.effectStyleId === style.id) patch.effects = clone(style.effects);
    if (style.grids && node.gridStyleId === style.id) patch.layoutGrids = clone(style.grids);
    if (values && node.text) {
      const whole = node.textStyleId === style.id;
      const ranged = node.text.runs.some(run => run.textStyleId === style.id);
      if (whole || ranged) {
        const text = whole ? {...node.text, style: {...node.text.style, ...clone(values)}} : node.text;
        const runs = ranged ? text.runs.map(run => (run.textStyleId === style.id ? {...run, style: {...run.style, ...clone(values)}} : run)) : text.runs;
        patch.text = {...text, runs: tidy(text, runs, node.fills)};
      }
    }
    if (Object.keys(patch).length) updates.set(id, patch);
  }
  return updates;
}

/** The fields that detach the node from its styles of `kind` (only `styleId` when given), keeping
 *  the values. For text this includes ranges styled on their own. */
export function detachStyle(node: SceneNode, kind: StyleKind, styleId?: StyleId): Partial<SceneNode> {
  const field = STYLE_ID_FIELD[kind];
  const patch: Partial<SceneNode> = {};
  if (node[field] && (!styleId || node[field] === styleId)) patch[field] = undefined;
  if (kind === 'text' && node.text?.runs.some(run => run.textStyleId && (!styleId || run.textStyleId === styleId))) {
    const runs = node.text.runs.map(run => {
      if (!run.textStyleId || (styleId && run.textStyleId !== styleId)) return run;
      const next = {...run};
      delete next.textStyleId;
      return next;
    });
    patch.text = {...node.text, runs: tidy(node.text, runs, node.fills)};
  }
  return patch;
}

function usesStyle(node: SceneNode, styleId: StyleId): boolean {
  return node.fillStyleId === styleId || node.strokeStyleId === styleId || node.effectStyleId === styleId || node.gridStyleId === styleId
    || node.textStyleId === styleId || !!node.text?.runs.some(run => run.textStyleId === styleId);
}

/** Every node that uses the style, on any page. */
export function styleUsages(doc: DesignDocument, styleId: StyleId): NodeId[] {
  const ids: NodeId[] = [];
  for (const id in doc.nodes) if (usesStyle(doc.nodes[id], styleId)) ids.push(id);
  return ids;
}

/** Updates that detach every user of a style that is being deleted; the nodes keep its values. */
export function removeStyleUpdates(doc: DesignDocument, styleId: StyleId): NodeUpdates {
  const updates: NodeUpdates = new Map();
  for (const id of styleUsages(doc, styleId)) {
    const node = doc.nodes[id];
    const patch: Partial<SceneNode> = {};
    for (const kind of Object.keys(STYLE_ID_FIELD) as StyleKind[]) Object.assign(patch, detachStyle({...node, ...patch}, kind, styleId));
    if (Object.keys(patch).length) updates.set(id, patch);
  }
  return updates;
}

// ── Editing by hand ────────────────────────────────────────────────────────────────────────────

const CLEARS: Record<string, StyleIdField> = {
  fills: 'fillStyleId', strokes: 'strokeStyleId', effects: 'effectStyleId', layoutGrids: 'gridStyleId',
  ...Object.fromEntries(TEXT_STYLE_KEYS.map(key => [key, 'textStyleId'])),
};

/** The style id that editing `field` by hand detaches: a node field (`fills`, `strokes`, `effects`,
 *  `layoutGrids`) or a type property (`fontSize`, `lineHeight`...). Null when the field is not
 *  styled (`characters`, `opacity`...). */
export function clearsStyle(field: string): StyleIdField | null {
  return CLEARS[field] ?? null;
}

/** The patch with the style ids its fields detach cleared, unless the patch sets them itself
 *  (applying a style sets both). */
export function withStylesCleared(patch: Partial<SceneNode>): Partial<SceneNode> {
  const out: Partial<SceneNode> = {...patch};
  for (const key of Object.keys(patch)) {
    const field = clearsStyle(key);
    if (field && !(field in patch)) out[field] = undefined;
  }
  return out;
}

// ── The assets panel ───────────────────────────────────────────────────────────────────────────

/** A folder of styles: "Brand/Primary" sits in "Brand". `path` is the folder's full name. */
export type StyleGroup = {name: string; path: string; groups: StyleGroup[]; styles: Style[]};

/** The folders of a style name, as Figma reads it: "/" separates, spaces around it do not count. */
export const stylePath = (name: string): string[] => name.split('/').map(part => part.trim()).filter(Boolean);
/** The style's own name without its folders. */
export const styleDisplayName = (style: Pick<Style, 'name'>): string => stylePath(style.name).pop() ?? style.name;

/** Styles arranged in folders by their names, in the order given (Figma keeps the order styles
 *  were made in). Pass one type at a time for the panel's sections. */
export function groupStyles(styles: Iterable<Style> | Record<StyleId, Style>): StyleGroup {
  const list = Symbol.iterator in Object(styles) ? [...(styles as Iterable<Style>)] : Object.values(styles as Record<StyleId, Style>);
  const root: StyleGroup = {name: '', path: '', groups: [], styles: []};
  for (const style of list) {
    let group = root;
    for (const part of stylePath(style.name).slice(0, -1)) {
      let next = group.groups.find(child => child.name === part);
      if (!next) {
        next = {name: part, path: group.path ? `${group.path}/${part}` : part, groups: [], styles: []};
        group.groups.push(next);
      }
      group = next;
    }
    group.styles.push(style);
  }
  return root;
}
