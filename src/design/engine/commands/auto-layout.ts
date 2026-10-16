import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {suggestAutoLayout} from '../../../../shared/design/auto-layout-suggest';
import {isAutoLayout} from '../../../../shared/design/constraints';
import {isFrameLikeNode, isInsideInstance} from '../../../../shared/design/tree';
import {editableStructure} from '../selection';
import type {DesignStore} from '../store';
import {userUpdate} from '../user-edit';
import type {Command, CommandContext} from './registry';
import {wrapNodes} from './structure';
import {SUGGEST_LAYOUT_COMMAND} from './suggest-layout';

// "Add auto layout" (⇧A), "Remove auto layout" (⌥⇧A) and "Remove all auto layout" (the frames inside too). On a frame without auto layout ⇧A turns
// it on with what its content suggests (direction, gap, padding, alignment: shared/design/
// auto-layout-suggest.ts); on anything else it wraps the selection in a new auto-layout frame whose
// order is the layers' order on screen. Removing auto layout leaves every layer where it is.

/** Adds auto layout to the selection (or wraps it). Returns the frame that has it, or null. */
export function addAutoLayout(store: DesignStore): NodeId | null {
  const {doc, selection} = store.getState();
  const ids = editableStructure(doc, selection);
  const suggestion = suggestAutoLayout(doc, ids);
  if (!suggestion) return null;
  let frameId: NodeId | null = null;
  store.transact('Auto layout', tx => {
    const id = suggestion.frameId ?? wrapNodes(tx, doc, suggestion.order, 'FRAME');
    if (!id) return;
    frameId = id;
    userUpdate(tx, id, {
      autoLayout: suggestion.autoLayout,
      layoutSizingHorizontal: suggestion.sizing.horizontal,
      layoutSizingVertical: suggestion.sizing.vertical,
    });
    // The flow follows the children's order: the first item becomes the bottom child.
    suggestion.order.forEach((child, index) => {
      if (tx.get(child)?.parentId === id) tx.reorder(child, index);
    });
    return {select: [id]};
  });
  return frameId;
}

/** Frames in the selection that have auto layout. */
export const autoLayoutFrames = (doc: DesignDocument, selection: readonly NodeId[]) =>
  selection.filter(id => isFrameLikeNode(doc.nodes[id]) && isAutoLayout(doc.nodes[id]));

/** Turns auto layout off on the selected frames; their layers stay where layout put them. */
export function removeAutoLayout(store: DesignStore): void {
  const {doc, selection} = store.getState();
  const ids = autoLayoutFrames(doc, selection);
  if (!ids.length) return;
  store.transact('Remove auto layout', tx => {
    for (const id of ids) {
      const node = tx.get(id);
      if (node?.autoLayout) userUpdate(tx, id, {autoLayout: {...node.autoLayout, layoutMode: 'NONE'}});
    }
  });
}

/** Frames with auto layout in the selection and anywhere inside it, outside instances (whose layout follows their main). */
export function autoLayoutFramesWithin(doc: DesignDocument, selection: readonly NodeId[]): NodeId[] {
  const out: NodeId[] = [];
  const stack = [...selection];
  while (stack.length) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node || node.type === 'INSTANCE' || isInsideInstance(doc, id)) continue;
    if (isFrameLikeNode(node) && isAutoLayout(node)) out.push(id);
    stack.push(...(node.children ?? []));
  }
  return out;
}

/** "Remove all auto layout" (Figma's Remove all auto layout): off on the selected frames and every frame inside them, in
 *  one undo step; the layers stay where layout put them. */
export function removeAllAutoLayout(store: DesignStore): void {
  const {doc, selection} = store.getState();
  const ids = autoLayoutFramesWithin(doc, selection);
  if (!ids.length) return;
  store.transact('Remove all auto layout', tx => {
    for (const id of ids) {
      const node = tx.get(id);
      if (node?.autoLayout) userUpdate(tx, id, {autoLayout: {...node.autoLayout, layoutMode: 'NONE'}});
    }
  });
}

const state = (ctx: CommandContext) => ctx.store.getState();

export const AUTO_LAYOUT_COMMANDS: Command[] = [
  {
    id: 'object.auto-layout',
    label: 'Add auto layout',
    group: 'object',
    shortcut: {code: 'KeyA', shift: true},
    enabled: ctx => editableStructure(state(ctx).doc, state(ctx).selection).length > 0,
    run: ctx => void addAutoLayout(ctx.store),
  },
  {
    id: 'object.remove-auto-layout',
    label: 'Remove auto layout',
    group: 'object',
    shortcut: {code: 'KeyA', shift: true, alt: true},
    enabled: ctx => autoLayoutFrames(state(ctx).doc, state(ctx).selection).length > 0,
    run: ctx => removeAutoLayout(ctx.store),
  },
  {
    id: 'object.remove-all-auto-layout',
    label: 'Remove all auto layout',
    group: 'object',
    enabled: ctx => autoLayoutFramesWithin(state(ctx).doc, state(ctx).selection).length > 0,
    run: ctx => removeAllAutoLayout(ctx.store),
  },
  SUGGEST_LAYOUT_COMMAND,
];
