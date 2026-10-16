import type {DesignDocument, NodeId, Vec} from '../../../../shared/design/types';
import {applyLinear, invert, rectsIntersect, unionRects, worldBox, worldMatrix} from '../../../../shared/design/geometry';
import {isFrameLikeNode, sortByPaintOrder} from '../../../../shared/design/tree';
import {cloneSubtrees, insertClones} from '../clipboard';
import {mainsAsInstances} from '../main-copies';
import {editableStructure, selectAllIds} from '../selection';
import type {DesignStore} from '../store';
import type {Command, CommandContext} from './registry';
import {removeNodes} from './structure';

// Undo, Redo, Select all, Delete, Duplicate. ⌘D puts a copy on top of its original,
// except frames standing on the canvas, whose copies go to their right; a ⌘D after moving the copy
// repeats that move. A main component's copy is an instance of it (main-copies.ts).

const state = (ctx: CommandContext) => ctx.store.getState();
const hasEditable = (ctx: CommandContext) => editableStructure(state(ctx).doc, state(ctx).selection).length > 0;

/** The last ⌘D: its copies and where their originals stood, so the next ⌘D repeats the offset the
 *  user gave the copies ("smart duplicate"). */
let lastDuplicate: {copies: NodeId[]; origins: Map<NodeId, Vec>} | null = null;

/** Space Figma leaves between a duplicated top-level frame and its neighbour on the right. */
export const FRAME_DUPLICATE_GAP = 100;

/** Where copies of frames standing on the canvas go: to the right of the originals, past whatever
 *  already stands there, so a ⌘D never hides a copy under its screen (as in Figma). Null when the
 *  selection is not only such frames. */
export function besideOffset(doc: DesignDocument, ids: readonly NodeId[]): Vec | null {
  const onCanvas = (id: NodeId) => {
    const node = doc.nodes[id], parent = doc.nodes[node?.parentId ?? ''];
    return !!node && (isFrameLikeNode(node) || node.type === 'SECTION') && (parent?.type === 'PAGE' || parent?.type === 'SECTION');
  };
  if (!ids.length || !ids.every(onCanvas)) return null;
  const bounds = unionRects(ids.map(id => worldBox(doc, id)));
  if (!bounds) return null;
  const parentId = doc.nodes[ids[0]].parentId!;
  const taken = (doc.nodes[parentId].children ?? []).filter(id => !ids.includes(id) && doc.nodes[id]?.visible).map(id => worldBox(doc, id));
  let x = bounds.x + bounds.width + FRAME_DUPLICATE_GAP;
  for (let guard = 0; guard <= taken.length; guard++) {
    const spot = {x, y: bounds.y, width: bounds.width, height: bounds.height};
    const blocking = taken.filter(rect => rectsIntersect(rect, spot));
    if (!blocking.length) break;
    x = Math.max(...blocking.map(rect => rect.x + rect.width)) + FRAME_DUPLICATE_GAP;
  }
  return {x: x - bounds.x, y: 0};
}

export function duplicateSelection(ctx: CommandContext): NodeId[] {
  const {doc, selection} = state(ctx);
  const ids = sortByPaintOrder(doc, editableStructure(doc, selection));
  if (!ids.length) return [];
  let offset: Vec = {x: 0, y: 0};
  let repeated = false;
  if (lastDuplicate && lastDuplicate.copies.length === ids.length && ids.every(id => lastDuplicate!.copies.includes(id))) {
    const first = ids[0];
    const origin = lastDuplicate.origins.get(first);
    const now = worldBox(doc, first);
    if (origin) {
      offset = {x: now.x - origin.x, y: now.y - origin.y};
      repeated = true;
    }
  }
  if (!repeated) offset = besideOffset(doc, ids) ?? offset;
  const {nodes, ids: map} = mainsAsInstances(doc, doc.nodes, ids, cloneSubtrees(doc.nodes, ids));
  const original = new Map([...map].map(([old, fresh]) => [fresh, old]));
  const copies = ids.map(id => map.get(id)!);
  ctx.store.transact('Duplicate', tx => {
    insertClones(tx, nodes, root => {
      const source = original.get(root.id)!;
      const parentId = doc.nodes[source].parentId!;
      return {parentId, index: (tx.get(parentId)!.children ?? []).indexOf(source) + 1};
    });
    if (offset.x || offset.y) {
      for (const id of ids) {
        const copy = map.get(id)!;
        const node = tx.get(copy)!;
        const local = applyLinear(invert(worldMatrix(doc, doc.nodes[id].parentId!)), offset);
        tx.update(copy, {x: node.x + local.x, y: node.y + local.y});
      }
    }
  }, {select: copies});
  const origins = new Map<NodeId, Vec>();
  for (const id of ids) {
    const box = worldBox(doc, id);
    origins.set(map.get(id)!, {x: box.x, y: box.y});
  }
  lastDuplicate = {copies, origins};
  return copies;
}

/** The frame tool's "+" beside a frame on the canvas (Figma's quick-add): a copy of the frame on that side, the frames
 *  standing beyond it in its row moved over to make room. The gap is the one to the next frame there, or the usual
 *  FRAME_DUPLICATE_GAP. Returns the copy's id. */
export function quickAddFrame(store: DesignStore, frameId: NodeId, side: 'left' | 'right'): NodeId | null {
  const doc = store.getState().doc;
  const frame = doc.nodes[frameId];
  const parent = doc.nodes[frame?.parentId ?? ''];
  if (!frame || parent?.type !== 'PAGE' || !isFrameLikeNode(frame)) return null;
  const box = worldBox(doc, frameId);
  const sameRow = (rect: {y: number; height: number}) => rect.y < box.y + box.height && rect.y + rect.height > box.y;
  const beyond = (parent.children ?? []).filter(id => id !== frameId && doc.nodes[id]?.visible).map(id => ({id, rect: worldBox(doc, id)}))
    .filter(({rect}) => sameRow(rect) && (side === 'right' ? rect.x >= box.x + box.width : rect.x + rect.width <= box.x));
  const nearest = beyond.reduce<number | null>((best, {rect}) => {
    const gap = side === 'right' ? rect.x - (box.x + box.width) : box.x - (rect.x + rect.width);
    return best === null || gap < best ? gap : best;
  }, null);
  const gap = nearest !== null && nearest < FRAME_DUPLICATE_GAP * 4 ? nearest : FRAME_DUPLICATE_GAP;
  const shift = (box.width + gap) * (side === 'right' ? 1 : -1);
  const {nodes, ids: map} = mainsAsInstances(doc, doc.nodes, [frameId], cloneSubtrees(doc.nodes, [frameId]));
  const copy = map.get(frameId)!;
  store.transact('Add frame beside', tx => {
    for (const {id} of beyond) {
      const node = tx.get(id);
      if (node) tx.update(id, {x: node.x + shift});
    }
    insertClones(tx, nodes, () => ({parentId: parent.id, index: (tx.get(parent.id)!.children ?? []).indexOf(frameId) + 1}));
    const placed = tx.get(copy);
    if (placed) tx.update(copy, {x: placed.x + shift});
  }, {select: [copy]});
  return copy;
}

export const EDIT_COMMANDS: Command[] = [
  {
    id: 'undo',
    label: 'Undo',
    group: 'edit',
    shortcut: {code: 'KeyZ', mod: true},
    repeat: true,
    enabled: ctx => ctx.store.canUndo(),
    run: ctx => void ctx.store.undo(),
  },
  {
    id: 'redo',
    label: 'Redo',
    group: 'edit',
    shortcut: {code: 'KeyZ', mod: true, shift: true},
    alternates: [{code: 'KeyY', mod: true}],
    repeat: true,
    enabled: ctx => ctx.store.canRedo(),
    run: ctx => void ctx.store.redo(),
  },
  {
    id: 'select-all',
    label: 'Select all',
    group: 'edit',
    shortcut: {code: 'KeyA', mod: true},
    run: ctx => {
      const {doc, pageId, selection, context} = state(ctx);
      ctx.store.setSelection(selectAllIds(doc, pageId, selection, context));
    },
  },
  {
    id: 'delete',
    label: 'Delete',
    group: 'edit',
    shortcut: {code: 'Backspace'},
    alternates: [{code: 'Delete'}],
    enabled: hasEditable,
    run: ctx => {
      const {doc, selection} = state(ctx);
      const ids = editableStructure(doc, selection);
      ctx.store.transact('Delete', tx => removeNodes(tx, ids), {select: []});
    },
  },
  {
    id: 'duplicate',
    label: 'Duplicate',
    group: 'edit',
    shortcut: {code: 'KeyD', mod: true},
    enabled: hasEditable,
    run: ctx => void duplicateSelection(ctx),
  },
];
