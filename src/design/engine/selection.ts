import type {DesignDocument, Matrix, NodeId, SceneNode} from '../../../shared/design/types';
import {transformRect, translation, unionRects, worldMatrices, worldMatrix, type Rect} from '../../../shared/design/geometry';
import {childrenOf, commonParent, isInsideInstance, isLockedInTree, isVisibleInTree, paintChildren, topLevelSelection} from '../../../shared/design/tree';

// What the selection is and how it changes, shared by the move tool, the commands and the panels.

/** The box the selection handles sit on: one node's own (rotated, flipped) box, or the axis-aligned
 *  union of several nodes. `matrix` maps the box's local space (0..width, 0..height) to the page. */
export type SelectionBox = {matrix: Matrix; width: number; height: number; nodeId: NodeId | null};

/** Nodes a move, resize or delete acts on: the top-level part of the selection, without pages and
 *  locked layers. */
export function movableSelection(doc: DesignDocument, selection: readonly NodeId[]): NodeId[] {
  return topLevelSelection(doc, selection).filter(id => {
    const node = doc.nodes[id];
    return node && node.type !== 'PAGE' && !node.locked;
  });
}

/** Page-space bounds of the nodes' boxes (each one's `worldBox`; selected siblings share their parents' matrices). */
export function selectionBounds(doc: DesignDocument, ids: readonly NodeId[]): Rect | null {
  const world = worldMatrices(doc);
  return unionRects(ids.filter(id => doc.nodes[id]).map(id => transformRect(world(id), {x: 0, y: 0, width: doc.nodes[id].width, height: doc.nodes[id].height})));
}

export function selectionBox(doc: DesignDocument, ids: readonly NodeId[]): SelectionBox | null {
  const present = ids.filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
  if (!present.length) return null;
  if (present.length === 1) {
    const node = doc.nodes[present[0]];
    return {matrix: worldMatrix(doc, node.id), width: node.width, height: node.height, nodeId: node.id};
  }
  const bounds = selectionBounds(doc, present)!;
  return {matrix: translation(bounds.x, bounds.y), width: bounds.width, height: bounds.height, nodeId: null};
}

export function toggleInSelection(selection: readonly NodeId[], id: NodeId): NodeId[] {
  return selection.includes(id) ? selection.filter(each => each !== id) : [...selection, id];
}

/** Whether a node can be picked on the canvas right now (visible, unlocked, on the page). */
export const isPickable = (doc: DesignDocument, id: NodeId) => isVisibleInTree(doc, id) && !isLockedInTree(doc, id);

/** "Select parent" and Esc: the parent of the selection (and the context above it), or nothing
 *  when the selection already sits on the page. */
export function parentSelection(doc: DesignDocument, selection: readonly NodeId[], pageId: NodeId): {selection: NodeId[]; context: NodeId | null} {
  const parent = selection.length ? commonParent(doc, selection) : null;
  if (!parent || parent === pageId || doc.nodes[parent]?.type === 'PAGE') return {selection: [], context: null};
  const above = doc.nodes[parent].parentId;
  return {selection: [parent], context: above && above !== pageId ? above : null};
}

/** "Select children" (Enter): the visible, unlocked children of the selected containers. The
 *  context moves into the container so further clicks pick among them. */
export function childSelection(doc: DesignDocument, selection: readonly NodeId[]): {selection: NodeId[]; context: NodeId | null} | null {
  const out: NodeId[] = [];
  let context: NodeId | null = null;
  for (const id of selection) {
    const children = childrenOf(doc, id).filter(child => doc.nodes[child]?.visible && !doc.nodes[child]?.locked);
    if (!children.length) continue;
    out.push(...children);
    context = id;
  }
  if (!out.length) return null;
  return {selection: out, context: selection.length === 1 ? context : null};
}

/** Tab / ⇧Tab: the next sibling down the layers list (dir 1) or up (dir −1), wrapping, skipping hidden
 *  and locked layers. With nothing selected, the top-most layer of the context or the page. */
export function siblingSelection(doc: DesignDocument, selection: readonly NodeId[], pageId: NodeId, context: NodeId | null, dir: 1 | -1): NodeId[] {
  const usable = (id: NodeId) => !!doc.nodes[id]?.visible && !doc.nodes[id]?.locked;
  if (!selection.length) {
    const children = paintChildren(doc.nodes[context ?? pageId]).filter(usable);
    return children.length ? [children[dir > 0 ? children.length - 1 : 0]] : [];
  }
  const anchor = selection[selection.length - 1];
  const parent = doc.nodes[doc.nodes[anchor]?.parentId ?? ''];
  if (!parent) return [...selection];
  // The layers panel lists children top-first, so "next" is one index lower.
  const siblings = paintChildren(parent);
  const at = siblings.indexOf(anchor);
  for (let step = 1; step <= siblings.length; step++) {
    const index = (((at - dir * step) % siblings.length) + siblings.length) % siblings.length;
    if (usable(siblings[index])) return [siblings[index]];
  }
  return [anchor];
}

/** ⌘A: every visible, unlocked child of the context; with a selection, its siblings; otherwise
 *  everything on the page. */
export function selectAllIds(doc: DesignDocument, pageId: NodeId, selection: readonly NodeId[], context: NodeId | null): NodeId[] {
  const scope = context ?? (selection.length ? commonParent(doc, selection) : null) ?? pageId;
  return childrenOf(doc, scope).filter(id => doc.nodes[id]?.visible && !doc.nodes[id]?.locked);
}

/** Nodes that commands which create, remove or reorder layers may touch: not pages, not inside instances. */
export const editableStructure = (doc: DesignDocument, ids: readonly NodeId[]) =>
  topLevelSelection(doc, ids).filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE' && !isInsideInstance(doc, id));

/** Formats a size for labels: up to two decimals, a decimal comma, no grouping ("120,5 × 48"). */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded).replace('.', ',');
}

export const sizeLabel = (width: number, height: number) => `${formatNumber(width)} × ${formatNumber(height)}`;

export const nodeOf = (doc: DesignDocument, id: NodeId | null | undefined): SceneNode | undefined => (id ? doc.nodes[id] : undefined);
