import type {SceneNode} from '../../../shared/design/types';
import {boardObjectOf, childPart, isShapeWithText} from '../../../shared/design/board/model';
import {insertPieces} from '../../../shared/design/board/create';
import type {Command, CommandContext} from '../engine/commands';
import {blankCopy} from './tools/copies';

// ⌘↵ on a shape with text (help.figma.com "Visualize information using shapes with text": "A new, blank shape appears next to the
// original one with text field active"): a blank copy beside it, selected and open for typing. Stickies have their own
// (`board.sticky-next`).

const GAP = 24;

function shapeOf(ctx: CommandContext): SceneNode | null {
  const state = ctx.store.getState();
  const id = state.editing?.id ?? (state.selection.length === 1 ? state.selection[0] : undefined);
  const object = id ? boardObjectOf(nodeId => (nodeId ? state.doc.nodes[nodeId] : undefined), id) : null;
  return object && isShapeWithText(object) ? object : null;
}

export const SHAPE_NEXT: Command = {
  // ⌘↵ reaches it through the board's keys (useBoardKeys); the key stays `board.sticky-next`'s in the registry.
  id: 'board.shape-next', label: 'Next shape nearby', group: 'board',
  enabled: ctx => !ctx.store.readOnly && !!shapeOf(ctx),
  run: ctx => {
    const shape = shapeOf(ctx)!;
    const {doc} = ctx.store.getState();
    const build = blankCopy(doc, shape, Math.round(shape.x + shape.width + GAP), Math.round(shape.y));
    if (!build || !shape.parentId) return;
    ctx.store.setEditing(null);
    ctx.store.transact('Next shape', tx => void insertPieces(tx, build, shape.parentId!), {select: [build.id]});
    const get = (id: string | null | undefined) => (id ? ctx.store.getState().doc.nodes[id] : undefined);
    const text = childPart(get, get(build.id), 'text');
    if (text && ctx.enterEdit) ctx.enterEdit(text.id, 'text');
  },
};
