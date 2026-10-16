import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {sortByPaintOrder} from '../../../../shared/design/tree';
import {isMacPlatform} from '../keyboard';
import {editableStructure} from '../selection';
import type {DesignStore} from '../store';
import {userUpdate} from '../user-edit';
import type {Command} from './registry';
import {wrapNodes} from './structure';

// "Use as mask" (⌃⌘M). With several layers selected, the bottom-most becomes the mask of
// the others and they all go into a group named "Mask group", placed where the top-most layer
// was, as in Figma. One layer alone becomes a mask in place (it masks the layers above it in its
// parent, shared/design/types.ts `isMask`). On a selection of masks the command takes the mask off;
// the group stays, as Figma leaves it.

export const MASK_GROUP_NAME = 'Mask group';

export type MaskPlan = {kind: 'unmask'; ids: NodeId[]} | {kind: 'mask'; ids: NodeId[]} | {kind: 'group'; ids: NodeId[]} | {kind: 'none'};

export function planMask(doc: DesignDocument, selection: readonly NodeId[]): MaskPlan {
  const ids = sortByPaintOrder(doc, editableStructure(doc, selection));
  if (!ids.length) return {kind: 'none'};
  if (ids.every(id => doc.nodes[id].isMask)) return {kind: 'unmask', ids};
  return ids.length === 1 ? {kind: 'mask', ids} : {kind: 'group', ids};
}

/** `planMask(...).kind` without putting the layers in paint order (the panel asks on every change). */
export function maskPlanKind(doc: DesignDocument, selection: readonly NodeId[]): MaskPlan['kind'] {
  const ids = editableStructure(doc, selection);
  if (!ids.length) return 'none';
  if (ids.every(id => doc.nodes[id].isMask)) return 'unmask';
  return ids.length === 1 ? 'mask' : 'group';
}

/** Applies "Use as mask" (or takes the mask off). Returns what ends up selected. */
export function toggleMask(store: DesignStore): NodeId[] {
  const {doc, selection} = store.getState();
  const plan = planMask(doc, selection);
  switch (plan.kind) {
    case 'none':
      return [];
    case 'unmask':
      store.transact('Remove mask', tx => {
        for (const id of plan.ids) userUpdate(tx, id, {isMask: false});
      });
      return plan.ids;
    case 'mask':
      store.transact('Mask', tx => userUpdate(tx, plan.ids[0], {isMask: true}));
      return plan.ids;
    case 'group': {
      let group: NodeId | null = null;
      store.transact('Mask', tx => {
        group = wrapNodes(tx, doc, plan.ids, 'GROUP');
        if (!group) return;
        tx.update(group, {name: MASK_GROUP_NAME});
        // After the wrap the layers keep their order: the first is the bottom-most.
        userUpdate(tx, plan.ids[0], {isMask: true});
        // A mask lower down in the old stack must not cut this one off: the others stop being masks.
        for (const id of plan.ids.slice(1)) if (tx.get(id)?.isMask) userUpdate(tx, id, {isMask: false});
        return {select: [group]};
      });
      return group ? [group] : [];
    }
  }
}

export const MASK_COMMANDS: Command[] = [
  {
    id: 'object.mask',
    label: 'Use as mask',
    group: 'mask',
    // ⌃⌘M on a Mac, Ctrl+Alt+M elsewhere (Figma's keys; Ctrl+⌃ cannot be told apart off a Mac).
    shortcut: isMacPlatform() ? {code: 'KeyM', mod: true, ctrl: true} : {code: 'KeyM', mod: true, alt: true},
    enabled: ctx => maskPlanKind(ctx.store.getState().doc, ctx.store.getState().selection) !== 'none',
    run: ctx => void toggleMask(ctx.store),
  },
];
