import type {DesignDocument, Effect, NodeId, Paint, SceneNode, Style, StyleId, VariableId} from '../../../../../shared/design/types';
import type {Transaction} from '../../../../../shared/design/transaction';
import {newId, solid} from '../../../../../shared/design/defaults';
import {bindPaintVariable, resolveVariable} from '../../../../../shared/design/variables';
import {applyStyle, defaultStyleName, detachStyle, removeStyleUpdates, styleUsages, updateStyleUpdates, type StyleKind} from '../../../../../shared/design/styles';
import {userUpdate} from '../../../engine/user-edit';
import {convertPaint, replaceAt, type PaintField} from './paints';

// Colour and effect styles from the "Design" tab: made from the selection's paints or effects,
// applied, edited (every user follows), renamed, deleted (users keep the values) and detached.
// Everything runs inside a transaction the caller opens, so each action is one undo step.

export type StyleTarget = PaintField | 'effects';

export const STYLE_KIND: Record<StyleTarget, StyleKind> = {fills: 'fill', strokes: 'stroke', effects: 'effect'};
export const STYLE_FIELD = {fills: 'fillStyleId', strokes: 'strokeStyleId', effects: 'effectStyleId'} as const;
export const styleTypeOf = (target: StyleTarget) => (target === 'effects' ? 'EFFECT' : 'FILL');

const clone = <T>(value: T): T => structuredClone(value);

/** Local styles of one type in the order they were made. */
export function stylesOfType(doc: DesignDocument, type: Style['type']): Style[] {
  return Object.values(doc.styles).filter(style => style.type === type);
}

/** Makes a style from the first node's paints (or effects) and gives it to every node in `ids`.
 *  Returns the new style's id, or null when there is nothing to make it from. */
export function createStyleFrom(tx: Transaction, ids: readonly NodeId[], target: StyleTarget, name: string, id: StyleId = newId()): StyleId | null {
  const source = ids.map(each => tx.get(each)).find((node): node is SceneNode => !!node && node[target].length > 0);
  if (!source) return null;
  const type = styleTypeOf(target);
  const style: Style = {id, type, name: name.trim() || nextStyleName(tx.doc, type), description: ''};
  if (target === 'effects') style.effects = clone(source.effects);
  else style.paints = clone(source[target]);
  tx.setStyle(style);
  applyStyleTo(tx, ids, id, target);
  return id;
}

/** "Color 1", "Color 2"… — the first free default name. */
export function nextStyleName(doc: DesignDocument, type: Style['type']): string {
  const base = defaultStyleName(type);
  const taken = new Set(Object.values(doc.styles).map(style => style.name));
  for (let i = 1; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Gives the nodes the style's values and id (fills, strokes or effects). */
export function applyStyleTo(tx: Transaction, ids: readonly NodeId[], styleId: StyleId, target: StyleTarget): void {
  const updates = applyStyle(tx.doc, ids, styleId, target === 'strokes' ? {target: 'strokes'} : {});
  for (const [id, patch] of updates) userUpdate(tx, id, patch);
}

/** Detaches the nodes from their style of that target, keeping the values. */
export function detachStyleFrom(tx: Transaction, ids: readonly NodeId[], target: StyleTarget): void {
  for (const id of ids) {
    const node = tx.get(id);
    if (!node) continue;
    const patch = detachStyle(node, STYLE_KIND[target]);
    if (Object.keys(patch).length) userUpdate(tx, id, patch);
  }
}

/** The nodes that use a style; a style editor computes them once per drag. */
export const usersOf = (doc: DesignDocument, styleId: StyleId) => styleUsages(doc, styleId);

/** Writes a new version of a style and rewrites every user with it (shared/design/styles.ts
 *  `updateStyleUpdates`). A drag in the style editor passes the `users` it found when it opened, so
 *  each frame rewrites only them instead of scanning the file. */
export function updateStyle(tx: Transaction, style: Style, users?: readonly NodeId[]): void {
  tx.setStyle(style);
  // Style propagation is not a hand edit: the users keep their style ids (tx.update, not userUpdate).
  if (!users) {
    for (const [id, patch] of updateStyleUpdates(tx.doc, style)) tx.update(id, patch);
    return;
  }
  for (const id of users) {
    const node = tx.get(id);
    if (!node) continue;
    const patch: Partial<SceneNode> = {};
    if (style.paints && node.fillStyleId === style.id) patch.fills = clone(style.paints);
    if (style.paints && node.strokeStyleId === style.id) patch.strokes = clone(style.paints);
    if (style.effects && node.effectStyleId === style.id) patch.effects = clone(style.effects);
    if (Object.keys(patch).length) tx.update(id, patch);
  }
}

export function setStylePaints(tx: Transaction, styleId: StyleId, paints: Paint[], users?: readonly NodeId[]): void {
  const style = tx.doc.styles[styleId];
  if (style) updateStyle(tx, {...style, paints}, users);
}

export function setStyleEffects(tx: Transaction, styleId: StyleId, effects: Effect[], users?: readonly NodeId[]): void {
  const style = tx.doc.styles[styleId];
  if (style) updateStyle(tx, {...style, effects}, users);
}

export function renameStyle(tx: Transaction, styleId: StyleId, name: string): void {
  const style = tx.doc.styles[styleId];
  const trimmed = name.trim();
  if (style && trimmed && trimmed !== style.name) tx.setStyle({...style, name: trimmed});
}

/** Deletes a style; its users keep the values. */
export function deleteStyle(tx: Transaction, styleId: StyleId): void {
  if (!tx.doc.styles[styleId]) return;
  for (const [id, patch] of removeStyleUpdates(tx.doc, styleId)) tx.update(id, patch);
  tx.removeStyle(styleId);
}

/** Binds paint `index` of every target to a colour variable (a picture or gradient becomes a solid first). */
export function bindPaint(tx: Transaction, targets: readonly NodeId[], field: PaintField, index: number | 'all', variableId: VariableId): void {
  for (const id of targets) {
    const node = tx.get(id);
    if (!node) continue;
    let list = node[field];
    let at = index === 'all' ? 0 : index;
    if (index === 'all') {
      const value = resolveVariable(tx.doc, variableId, undefined, id);
      const color = value && typeof value === 'object' && 'r' in value ? value : {r: 0, g: 0, b: 0, a: 1};
      list = [solid({r: color.r, g: color.g, b: color.b}, color.a)];
      at = 0;
    } else if (list[at] && list[at].type !== 'SOLID') {
      list = replaceAt(list, at, convertPaint(list[at], 'SOLID'));
    }
    if (!list[at]) continue;
    const doc = list === node[field] ? tx.doc : {...tx.doc, nodes: {...tx.doc.nodes, [id]: {...node, [field]: list}}};
    const bound = bindPaintVariable(doc, id, field, at, variableId).doc.nodes[id];
    userUpdate(tx, id, {[field]: bound[field]});
  }
}

