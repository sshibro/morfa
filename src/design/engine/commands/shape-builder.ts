import type {NodeId} from '../../../../shared/design/types';
import {shapeBuilder, type BuilderPlan} from '../../../../shared/design/shape-builder';
import {editableStructure} from '../selection';
import type {DesignStore} from '../store';
import {editedVectorId, notify} from '../vector-edit/session';
import type {Command} from './registry';

// "Shape builder" (Figma's Shape builder; shared/design/shape-builder.ts): the command opens the tool for the selected
// shapes, or says why it cannot; `applyShapeBuilder` writes one merge or take-away as one undo step.

export const SHAPE_BUILDER_TOOL = 'shape-builder';
export const SHAPE_BUILDER_LABEL = 'Shape builder';
/** Undo labels: a merge (a click extracts one region, a drag merges several) and a take-away (⌥-click). */
export const SHAPE_BUILDER_STEPS = {merge: 'Merge areas', subtract: 'Remove area'} as const;

/** Opens the shape builder for the selection; false (with a message) when the selection cannot take it. */
export function startShapeBuilder(store: DesignStore): boolean {
  const {doc, selection} = store.getState();
  const builder = shapeBuilder(doc, editableStructure(doc, selection));
  if ('error' in builder) {
    notify(store, builder.error);
    return false;
  }
  store.setTool(SHAPE_BUILDER_TOOL);
  return true;
}

/** One shape builder step in the document; the shapes it leaves (and the new layer) become the selection. */
export function applyShapeBuilder(store: DesignStore, parentId: NodeId, operands: readonly NodeId[], plan: BuilderPlan, mode: 'merge' | 'subtract'): NodeId[] {
  const removed = new Set(plan.remove);
  const replaced = new Map(plan.replace.map(each => [each.id, each.node.id]));
  const selection = operands.filter(id => !removed.has(id)).map(id => replaced.get(id) ?? id);
  if (plan.create) selection.push(plan.create.node.id);
  store.transact(SHAPE_BUILDER_STEPS[mode], tx => {
    const children = () => tx.get(parentId)?.children ?? [];
    for (const {id, node} of plan.replace) {
      const index = children().indexOf(id);
      tx.remove(id);
      tx.create(node, parentId, Math.max(0, index));
    }
    if (plan.create) {
      // Above the shape it was taken from (its vector, when that shape kept a part).
      const anchor = replaced.get(plan.create.above) ?? plan.create.above;
      tx.create(plan.create.node, parentId, children().indexOf(anchor) + 1);
    }
    for (const id of plan.remove) tx.remove(id);
  }, {select: selection});
  return selection;
}

export const SHAPE_BUILDER_COMMAND: Command = {
  id: 'object.shape-builder',
  label: SHAPE_BUILDER_LABEL,
  group: 'boolean',
  enabled: ctx => !editedVectorId(ctx.store.getState()) && editableStructure(ctx.store.getState().doc, ctx.store.getState().selection).length > 0,
  run: ctx => void startShapeBuilder(ctx.store),
};
