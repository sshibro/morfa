import type {SceneNode} from '../../../../shared/design/types';
import {isLockedInTree} from '../../../../shared/design/tree';
import {userUpdate} from '../user-edit';
import type {Command, CommandContext} from './registry';

// "Swap fill and stroke" (⇧X, as in Figma): each selected layer's fills become its strokes and
// its strokes its fills, styles included, in one undo step. A layer that had no stroke gets a 1 px one
// so the former fill stays visible as an outline. "Remove fill" (⌥/) and "Remove stroke" (⇧/) take every fill or
// every stroke off the selected layers, their style with them, as Figma's.

const SWAPPABLE = new Set<SceneNode['type']>(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE', 'TEXT', 'FRAME', 'COMPONENT', 'INSTANCE', 'BOOLEAN_OPERATION', 'SECTION']);

const targets = (ctx: CommandContext, has: (node: SceneNode) => boolean = node => node.fills.length > 0 || node.strokes.length > 0) => {
  const {doc, selection} = ctx.store.getState();
  return selection.filter(id => {
    const node = doc.nodes[id];
    return !!node && SWAPPABLE.has(node.type) && !isLockedInTree(doc, id) && has(node);
  });
};

const hasFill = (node: SceneNode) => node.fills.length > 0 || !!node.fillStyleId;
const hasStroke = (node: SceneNode) => node.strokes.length > 0 || !!node.strokeStyleId;

/** A command that clears one kind of paint on the selected layers that have it, in one undo step. */
const removing = (id: string, label: string, shortcut: Command['shortcut'], has: (node: SceneNode) => boolean, patch: Partial<SceneNode>): Command => ({
  id, label, group: 'object', shortcut,
  enabled: ctx => targets(ctx, has).length > 0,
  run: ctx => {
    const ids = targets(ctx, has);
    if (!ids.length) return;
    ctx.store.transact(label, tx => {
      for (const each of ids) userUpdate(tx, each, patch);
    });
  },
});

/** The fields that swap a layer's fill and stroke. */
export function swappedPaints(node: SceneNode): Partial<SceneNode> {
  const patch: Partial<SceneNode> = {fills: node.strokes, strokes: node.fills, fillStyleId: node.strokeStyleId, strokeStyleId: node.fillStyleId};
  if (node.fills.length && !(node.strokeWeight > 0)) patch.strokeWeight = 1;
  return patch;
}

export const PAINT_SWAP_COMMANDS: Command[] = [{
  id: 'object.swap-fill-stroke',
  label: 'Swap fill and stroke',
  group: 'object',
  shortcut: {code: 'KeyX', shift: true},
  enabled: ctx => targets(ctx).length > 0,
  run: ctx => {
    const ids = targets(ctx);
    if (!ids.length) return;
    ctx.store.transact('Fill and stroke', tx => {
      for (const id of ids) {
        const node = tx.get(id);
        if (node) userUpdate(tx, id, swappedPaints(node));
      }
    });
  },
},
removing('object.remove-fill', 'Remove fill', {code: 'Slash', alt: true}, hasFill, {fills: [], fillStyleId: undefined}),
removing('object.remove-stroke', 'Remove stroke', {code: 'Slash', shift: true}, hasStroke, {strokes: [], strokeStyleId: undefined}),
];
