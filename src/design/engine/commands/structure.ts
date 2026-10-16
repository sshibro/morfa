import type {DesignDocument, NodeId, NodeType} from '../../../../shared/design/types';
import {createNode, newId, TYPE_NAMES} from '../../../../shared/design/defaults';
import {invert, multiply, transformRect, unionRects, worldMatrix} from '../../../../shared/design/geometry';
import type {Transaction} from '../../../../shared/design/transaction';
import {nextLayerName, pageIdOf, sortByPaintOrder} from '../../../../shared/design/tree';

// Structural edits shared by the commands: removing layers, wrapping them in a group or a frame,
// and reordering siblings. They work inside a transaction and keep the document's invariants
// (a group or boolean operation never ends up empty).

/** Removes the nodes, then any group or boolean operation they leave empty, up the tree. */
export function removeNodes(tx: Transaction, ids: readonly NodeId[]) {
  const parents = new Set<NodeId>();
  for (const id of ids) {
    const node = tx.get(id);
    if (!node) continue;
    if (node.parentId) parents.add(node.parentId);
    tx.remove(id);
  }
  for (let parentId of parents) {
    for (let parent = tx.get(parentId); parent && (parent.type === 'GROUP' || parent.type === 'BOOLEAN_OPERATION') && !parent.children?.length; parent = tx.get(parentId)) {
      const above = parent.parentId;
      tx.remove(parentId);
      if (!above) break;
      parentId = above;
    }
  }
}

/** Wraps the nodes in a new GROUP or FRAME placed where the top-most of them was, its box the union
 *  of theirs in the parent's space. Nodes from other parents move in keeping their place on screen.
 *  Returns the new container's id. */
export function wrapNodes(tx: Transaction, doc: DesignDocument, ids: readonly NodeId[], type: Extract<NodeType, 'GROUP' | 'FRAME'>, makeId: () => NodeId = newId): NodeId | null {
  const ordered = sortByPaintOrder(doc, ids);
  const top = ordered.at(-1);
  if (!top) return null;
  const parentId = doc.nodes[top].parentId!;
  const toParent = invert(worldMatrix(doc, parentId));
  const box = unionRects(ordered.map(id => transformRect(multiply(toParent, worldMatrix(doc, id)), {x: 0, y: 0, width: doc.nodes[id].width, height: doc.nodes[id].height})))!;
  const id = makeId();
  const name = nextLayerName(doc, pageIdOf(doc, parentId), TYPE_NAMES[type]);
  const extra = type === 'FRAME' ? {fills: [], clipsContent: false} : {};
  tx.create(createNode(type, {id, name, x: box.x, y: box.y, width: box.width, height: box.height, ...extra}), parentId, (tx.get(parentId)!.children ?? []).indexOf(top) + 1);
  const left = new Set<NodeId>();
  for (const each of ordered) {
    const from = tx.get(each)?.parentId;
    if (from && from !== parentId) left.add(from);
    tx.move(each, id);
  }
  removeNodes(tx, [...left].filter(parent => {
    const node = tx.get(parent);
    return node && (node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION') && !node.children?.length;
  }));
  return id;
}

/** "Move to page": the nodes go to the top of page `pageId`, in their paint order, keeping their place
 *  in page coordinates (Figma's "Move to page"). Groups they leave empty go; a flow that starts on a moved frame
 *  starts on its new page. */
export function moveNodesToPage(tx: Transaction, doc: DesignDocument, ids: readonly NodeId[], pageId: NodeId) {
  const ordered = sortByPaintOrder(doc, ids);
  const left = new Set<NodeId>();
  const moved = new Set(ordered);
  for (const id of ordered) {
    const from = tx.get(id)?.parentId;
    if (!from || from === pageId) continue;
    left.add(from);
    tx.move(id, pageId);
  }
  removeNodes(tx, [...left].filter(parent => {
    const node = tx.get(parent);
    return node && (node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION') && !node.children?.length;
  }));
  const source = pageIdOf(doc, ordered[0] ?? pageId);
  const flows = source ? doc.nodes[source]?.flowStartingPoints ?? [] : [];
  const going = flows.filter(flow => moved.has(flow.nodeId));
  if (source && source !== pageId && going.length) {
    tx.update(source, {flowStartingPoints: flows.filter(flow => !moved.has(flow.nodeId))});
    tx.update(pageId, {flowStartingPoints: [...(doc.nodes[pageId].flowStartingPoints ?? []), ...going]});
  }
}

/** Applies a new order of `parentId`'s children in which only `moving` changed place: they go to the
 *  top first, then down to their final index, so every step is a valid reorder. */
export function applyOrder(tx: Transaction, final: readonly NodeId[], moving: ReadonlySet<NodeId>) {
  const placed = final.filter(id => moving.has(id));
  for (const id of placed) tx.reorder(id, Number.MAX_SAFE_INTEGER);
  final.forEach((id, index) => {
    if (moving.has(id)) tx.reorder(id, index);
  });
}

export type OrderMove = 'forward' | 'backward' | 'front' | 'back';

/** The children order after moving the selected ones one step or all the way up or down. A block of
 *  selected layers moves together and stops at the end. */
export function reorderedChildren(children: readonly NodeId[], selected: ReadonlySet<NodeId>, move: OrderMove): NodeId[] {
  const list = [...children];
  if (move === 'front') return [...list.filter(id => !selected.has(id)), ...list.filter(id => selected.has(id))];
  if (move === 'back') return [...list.filter(id => selected.has(id)), ...list.filter(id => !selected.has(id))];
  if (move === 'forward') {
    for (let i = list.length - 2; i >= 0; i--) {
      if (selected.has(list[i]) && !selected.has(list[i + 1])) [list[i], list[i + 1]] = [list[i + 1], list[i]];
    }
  } else {
    for (let i = 1; i < list.length; i++) {
      if (selected.has(list[i]) && !selected.has(list[i - 1])) [list[i], list[i - 1]] = [list[i - 1], list[i]];
    }
  }
  return list;
}
