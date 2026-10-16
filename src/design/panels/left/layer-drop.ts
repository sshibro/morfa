import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import type {Transaction} from '../../../../shared/design/transaction';
import {moveViolation, COMPONENT_ERROR_MESSAGES} from '../../../../shared/design/components';
import {isAncestor, sortByPaintOrder} from '../../../../shared/design/tree';
import {dropAllowed} from '../../engine/commands/components';
import {acceptsChildren, type RowSpan} from './layer-rows';

// Where a layer dragged in the layers panel lands, as Figma decides it: the top and bottom quarter of
// a container row (half of a leaf row) put it beside that layer, the middle of a container puts it
// inside, on top. The boundary under the last layer of a nested list is ambiguous (inside the group,
// or after the group, or after its parent…); the pointer's horizontal position picks the level, as the
// indentation of the drop line shows. Positions are indices into the parent's children (bottom-to-top),
// so an auto-layout parent takes the layer into its flow at that place.

/** `row`: the boundary above that row index for a line, the row itself for "into". */
export type DropIndicator = {kind: 'line'; row: number; depth: number} | {kind: 'into'; row: number};
/** `index` is where the block goes in the parent's current children (0 = bottom-most, length = top). */
export type DropTarget = {parentId: NodeId; index: number; indicator: DropIndicator};

/** The pointer over the rows: the row under it (may be `length` below the last one), how far down that
 *  row (0..1), and the indentation level its x points at. */
export type DropPoint = {row: number; fraction: number; level: number};

/** Why the dragged layers cannot go into `parentId` (a Russian message), or null when they can. The
 *  same rule as the move tool on the canvas (`dropAllowed`): nothing into or out of an instance, only
 *  components into a variant set, no component inside itself. */
export function dropViolation(doc: DesignDocument, dragged: readonly NodeId[], parentId: NodeId): string | null {
  const parent = doc.nodes[parentId];
  if (!parent?.children) return COMPONENT_ERROR_MESSAGES.not_container;
  for (const id of dragged) {
    if (id === parentId || isAncestor(doc, id, parentId)) return 'A layer cannot be nested inside itself';
  }
  if (dragged.every(id => dropAllowed(doc, id, parentId))) return null;
  const code = moveViolation(doc, dragged, parentId);
  return COMPONENT_ERROR_MESSAGES[code ?? 'inside_instance'];
}

/** Index in the parent's children (bottom-to-top) for "directly above `id`" in the panel. */
const aboveIndex = (doc: DesignDocument, id: NodeId) => (doc.nodes[doc.nodes[id].parentId!]?.children ?? []).indexOf(id) + 1;
/** Index for "directly below `id`" in the panel. */
const belowIndex = (doc: DesignDocument, id: NodeId) => (doc.nodes[doc.nodes[id].parentId!]?.children ?? []).indexOf(id);

/** The ancestor of row `row` (inclusive) whose depth is `depth`. */
function ancestorAtDepth(doc: DesignDocument, rows: RowSpan, row: number, depth: number): NodeId {
  let id = rows.ids[row];
  for (let d = rows.depths[row]; d > depth; d--) id = doc.nodes[id].parentId!;
  return id;
}

/** What a drop at `point` means, or null when it is not allowed there. */
export function dropTarget(doc: DesignDocument, rows: RowSpan, point: DropPoint, dragged: readonly NodeId[], pageId: NodeId): DropTarget | null {
  const count = rows.ids.length;
  const draggedSet = new Set(dragged);
  let boundary: number;
  if (!count) {
    return dropViolation(doc, dragged, pageId) ? null : {parentId: pageId, index: doc.nodes[pageId]?.children?.length ?? 0, indicator: {kind: 'line', row: 0, depth: 0}};
  }
  if (point.row >= count) boundary = count;
  else if (point.row < 0) boundary = 0;
  else {
    const id = rows.ids[point.row];
    const node = doc.nodes[id];
    const nest = acceptsChildren(node) && !draggedSet.has(id);
    const edge = nest ? 0.25 : 0.5;
    if (point.fraction < edge) boundary = point.row;
    else if (point.fraction > 1 - edge || !nest) boundary = point.row + 1;
    else {
      if (dropViolation(doc, dragged, id)) return null;
      return {parentId: id, index: node.children!.length, indicator: {kind: 'into', row: point.row}};
    }
  }
  const upper = boundary > 0 ? boundary - 1 : -1;
  const lower = boundary < count ? boundary : -1;
  const upperDepth = upper >= 0 ? rows.depths[upper] : 0;
  const lowerDepth = lower >= 0 ? rows.depths[lower] : 0;

  let parentId: NodeId;
  let index: number;
  let depth: number;
  if (upper >= 0 && lower >= 0 && lowerDepth > upperDepth) {
    // Right under an expanded container: on top of its children.
    const container = rows.ids[upper];
    parentId = container;
    index = doc.nodes[container].children!.length;
    depth = upperDepth + 1;
  } else if (upper < 0) {
    parentId = doc.nodes[rows.ids[lower]].parentId!;
    index = aboveIndex(doc, rows.ids[lower]);
    depth = lowerDepth;
  } else {
    // Between a deeper (or equal) row above and a shallower (or no) row below: the pointer picks the level.
    const min = lower >= 0 ? lowerDepth : 0;
    depth = Math.max(min, Math.min(upperDepth, Math.round(point.level)));
    const sibling = ancestorAtDepth(doc, rows, upper, depth);
    parentId = doc.nodes[sibling].parentId!;
    index = belowIndex(doc, sibling);
  }
  if (dropViolation(doc, dragged, parentId)) return null;
  return {parentId, index, indicator: {kind: 'line', row: boundary, depth}};
}

/** The dragged layers top-most first as the panel lists them (rows first, the rest by paint order). */
export function panelOrder(doc: DesignDocument, rows: {rowOf(id: NodeId): number}, ids: readonly NodeId[]): NodeId[] {
  const shown = ids.filter(id => rows.rowOf(id) >= 0).sort((a, b) => rows.rowOf(a) - rows.rowOf(b));
  const hidden = sortByPaintOrder(doc, ids.filter(id => rows.rowOf(id) < 0)).reverse();
  return [...shown, ...hidden];
}

/** The parent's children after the block (top-most first) lands at `index`, or null when nothing would move. */
export function orderAfterDrop(doc: DesignDocument, blockTopFirst: readonly NodeId[], parentId: NodeId, index: number): NodeId[] | null {
  const children = doc.nodes[parentId]?.children ?? [];
  const block = new Set(blockTopFirst);
  let kept = 0;
  for (let i = 0; i < index && i < children.length; i++) if (!block.has(children[i])) kept++;
  const rest = children.filter(id => !block.has(id));
  const result = [...rest.slice(0, kept), ...[...blockTopFirst].reverse(), ...rest.slice(kept)];
  const same = blockTopFirst.every(id => doc.nodes[id]?.parentId === parentId) && result.length === children.length && result.every((id, i) => id === children[i]);
  return same ? null : result;
}

/** Moves the block (top-most first) into `parentId` at `index`, keeping the layers where they are on
 *  screen unless an auto-layout parent places them. Returns false when nothing moves. */
export function applyDrop(tx: Transaction, blockTopFirst: readonly NodeId[], parentId: NodeId, index: number): boolean {
  const doc = tx.doc;
  if (!orderAfterDrop(doc, blockTopFirst, parentId, index)) return false;
  const block = new Set(blockTopFirst);
  const children = doc.nodes[parentId].children ?? [];
  let kept = 0;
  for (let i = 0; i < index && i < children.length; i++) if (!block.has(children[i])) kept++;
  const bottomFirst = [...blockTopFirst].reverse();
  // Everything to the top of the parent first (in order), then each one down to its place.
  for (const id of bottomFirst) {
    if (tx.get(id)!.parentId === parentId) tx.reorder(id, Number.MAX_SAFE_INTEGER);
    else tx.move(id, parentId, undefined, {keepWorld: true});
  }
  bottomFirst.forEach((id, k) => tx.reorder(id, kept + k));
  return true;
}
