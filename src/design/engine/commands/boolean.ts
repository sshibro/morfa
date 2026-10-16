import type {BooleanOperation, DesignDocument, NodeId, Paint, SceneNode} from '../../../../shared/design/types';
import {TYPE_NAMES} from '../../../../shared/design/defaults';
import {invert, localMatrix, multiply, worldMatrix} from '../../../../shared/design/geometry';
import {remapPaints, unitBoxMatrix} from '../../../../shared/design/boolean';
import {sortByPaintOrder} from '../../../../shared/design/tree';
import {editableStructure} from '../selection';
import type {DesignStore} from '../store';
import {userUpdate} from '../user-edit';
import {notify} from '../vector-edit/session';
import type {Command} from './registry';
import {wrapNodes} from './structure';

// Boolean operations: Union (⌥⇧U), Subtract (⌥⇧S), Intersect (⌥⇧I), Exclude (⌥⇧X).
// Two or more layers go into a BOOLEAN_OPERATION placed where the top-most of them was (layers from
// other parents move in and keep their place on screen); the result is painted with the look of
// the top layer, or of the bottom one for "Subtract", whose result is the bottom shape with holes,
// as in Figma. With one boolean selected, the command changes its operation. Text takes no part
// (its glyph outlines are not available here) and is left where it is, with a message.

export const BOOLEAN_OPERATIONS: readonly BooleanOperation[] = ['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'];
export const BOOLEAN_LABELS: Record<BooleanOperation, string> = {UNION: 'Union', SUBTRACT: 'Subtract', INTERSECT: 'Intersect', EXCLUDE: 'Exclude'};
export const BOOLEAN_COMMAND_IDS: Record<BooleanOperation, string> = {
  UNION: 'object.boolean-union', SUBTRACT: 'object.boolean-subtract', INTERSECT: 'object.boolean-intersect', EXCLUDE: 'object.boolean-exclude',
};
/** shortcuts.ts strings, for menus built outside the registry. */
export const BOOLEAN_SHORTCUTS: Record<BooleanOperation, string> = {UNION: 'Alt+Shift+KeyU', SUBTRACT: 'Alt+Shift+KeyS', INTERSECT: 'Alt+Shift+KeyI', EXCLUDE: 'Alt+Shift+KeyX'};

const KEYS: Record<BooleanOperation, string> = {UNION: 'KeyU', SUBTRACT: 'KeyS', INTERSECT: 'KeyI', EXCLUDE: 'KeyX'};
/** Layers without an outline of their own here. */
const NO_OUTLINE = new Set<SceneNode['type']>(['TEXT', 'SLICE']);

export const BOOLEAN_MESSAGES = {
  tooFew: 'Select at least two layers for a boolean operation',
  text: 'Text cannot take part in boolean operations: the letter outlines are unavailable',
  textSkipped: 'Text was skipped: only shapes take part in a boolean operation',
} as const;

export type BooleanPlan =
  | {kind: 'change'; id: NodeId; operation: BooleanOperation | undefined}
  | {kind: 'create'; ids: NodeId[]; skipped: NodeId[]}
  | {kind: 'none'; reason: string};

/** What a boolean command would do with this selection. */
export function planBoolean(doc: DesignDocument, selection: readonly NodeId[]): BooleanPlan {
  const ids = editableStructure(doc, selection);
  if (ids.length === 1 && doc.nodes[ids[0]]?.type === 'BOOLEAN_OPERATION') return {kind: 'change', id: ids[0], operation: doc.nodes[ids[0]].booleanOperation};
  const kept = ids.filter(id => !NO_OUTLINE.has(doc.nodes[id].type));
  const skipped = ids.filter(id => NO_OUTLINE.has(doc.nodes[id].type) && doc.nodes[id].type === 'TEXT');
  if (kept.length < 2) return {kind: 'none', reason: skipped.length ? BOOLEAN_MESSAGES.text : BOOLEAN_MESSAGES.tooFew};
  return {kind: 'create', ids: kept, skipped};
}

/** The operation the selection shows: a single boolean's own one. */
export const selectedOperation = (doc: DesignDocument, selection: readonly NodeId[]): BooleanOperation | null => {
  const plan = planBoolean(doc, selection);
  return plan.kind === 'change' ? plan.operation ?? 'UNION' : null;
};

const isDefaultName = (name: string) => name === TYPE_NAMES.BOOLEAN_OPERATION || Object.values(BOOLEAN_LABELS).includes(name);
const needsRemap = (paints: readonly Paint[]) => paints.some(paint => paint.type !== 'SOLID');

/** The paint and stroke settings a boolean takes from the layer that gives it its look. Gradients
 *  are re-expressed in the boolean's box so every colour stays where it was. */
function lookOf(doc: DesignDocument, source: SceneNode, parentId: NodeId, box: Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY'>): Partial<SceneNode> {
  const from = unitBoxMatrix(source, multiply(invert(worldMatrix(doc, parentId)), worldMatrix(doc, source.id)));
  const to = unitBoxMatrix(box, localMatrix(box));
  const paints = (paints: Paint[], styled: boolean) => (!styled && needsRemap(paints) ? remapPaints(paints, from, to) : structuredClone(paints));
  const look: Partial<SceneNode> = {
    fills: paints(source.fills, !!source.fillStyleId),
    strokes: paints(source.strokes, !!source.strokeStyleId),
    strokeWeight: source.strokeWeight,
    strokeAlign: source.strokeAlign,
    strokeCap: source.strokeCap,
    strokeJoin: source.strokeJoin,
    strokeMiterLimit: source.strokeMiterLimit,
    dashPattern: [...source.dashPattern],
    effects: structuredClone(source.effects),
  };
  if (source.fillStyleId) look.fillStyleId = source.fillStyleId;
  if (source.strokeStyleId) look.strokeStyleId = source.strokeStyleId;
  if (source.effectStyleId) look.effectStyleId = source.effectStyleId;
  return look;
}

/**
 * Runs a boolean operation on the selection: wraps the layers in a new boolean (selected after), or
 * changes the operation of the one selected boolean. Returns the boolean's id, or null with a
 * message when the selection cannot take part.
 */
export function applyBoolean(store: DesignStore, operation: BooleanOperation): NodeId | null {
  const {doc, selection} = store.getState();
  const plan = planBoolean(doc, selection);
  const label = BOOLEAN_LABELS[operation];
  if (plan.kind === 'none') {
    notify(store, plan.reason);
    return null;
  }
  if (plan.kind === 'change') {
    if (plan.operation === operation) return plan.id;
    store.transact(label, tx => {
      const node = tx.get(plan.id)!;
      userUpdate(tx, plan.id, isDefaultName(node.name) ? {booleanOperation: operation, name: label} : {booleanOperation: operation});
    });
    return plan.id;
  }
  const ordered = sortByPaintOrder(doc, plan.ids);
  const source = doc.nodes[operation === 'SUBTRACT' ? ordered[0] : ordered[ordered.length - 1]];
  let created: NodeId | null = null;
  store.transact(label, tx => {
    const id = wrapNodes(tx, doc, ordered, 'GROUP');
    if (!id) return;
    created = id;
    const group = tx.get(id)!;
    tx.update(id, {type: 'BOOLEAN_OPERATION', booleanOperation: operation, name: label, ...lookOf(doc, source, group.parentId!, group)});
    return {select: [id]};
  });
  if (created && plan.skipped.length) notify(store, BOOLEAN_MESSAGES.textSkipped);
  return created;
}

const canRun = (store: DesignStore) => {
  const {doc, selection} = store.getState();
  const plan = planBoolean(doc, selection);
  // A selection with text stays enabled so the command can say why it skips the text.
  return plan.kind !== 'none' || plan.reason === BOOLEAN_MESSAGES.text;
};

export const BOOLEAN_COMMANDS: Command[] = BOOLEAN_OPERATIONS.map(operation => ({
  id: BOOLEAN_COMMAND_IDS[operation],
  label: BOOLEAN_LABELS[operation],
  group: 'boolean',
  shortcut: {code: KEYS[operation], alt: true, shift: true},
  enabled: ctx => canRun(ctx.store),
  run: ctx => void applyBoolean(ctx.store, operation),
}));
