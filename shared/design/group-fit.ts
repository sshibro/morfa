import type {DesignDocument, NodeId, SceneNode} from './types';
import {localMatrix, multiply, translation, unionRects} from './geometry';
import {Draft, boundsOf, sameValue} from './constraints';
import type {NodeUpdates} from './constraints';
import {engineTs, withEngine} from './engine-switch';
import {layoutEntries, updatesFrom} from './layout-wasm';

// GROUP and BOOLEAN_OPERATION have no size of their own: their box is the union of their
// children's boxes (hidden children included, turned children by their rotated bounds), in the
// group's space. After a change the box is refitted and the children shifted the other way, so
// nothing moves on screen. A group left without children is removed, and so is a parent group
// that this empties in turn.

export const isGroupLike = (node: SceneNode | undefined): boolean => node?.type === 'GROUP' || node?.type === 'BOOLEAN_OPERATION';

/** Refits one group to its children. Returns whether its box changed. */
function fitGroup(draft: Draft, group: SceneNode): boolean {
  const children = (group.children ?? []).map(id => draft.get(id)).filter((child): child is SceneNode => !!child);
  const union = unionRects(children.map(child => boundsOf(child)));
  if (!union) return false;
  if (sameValue(union.x, 0) && sameValue(union.y, 0) && sameValue(union.width, group.width) && sameValue(union.height, group.height)) return false;
  // The new box must map its local origin where the old box mapped (union.x, union.y); rotation
  // and flips stay, so only the translation is solved for (flips turn about the new centre).
  const target = multiply(localMatrix(group), translation(union.x, union.y));
  const zero = localMatrix({...group, x: 0, y: 0, width: union.width, height: union.height});
  draft.update(group.id, {x: target[0][2] - zero[0][2], y: target[1][2] - zero[1][2], width: union.width, height: union.height});
  if (union.x || union.y) for (const child of children) draft.update(child.id, {x: child.x - union.x, y: child.y - union.y});
  return true;
}

/** Refits every group that contains one of `ids` (or is one), innermost first, removing empty
 *  ones. `ids` may name removed nodes; their former parents must be listed too. */
export function fitGroups(draft: Draft, ids: Iterable<NodeId>, stats?: {fitted: number}): void {
  const groups = new Set<NodeId>();
  for (const id of ids) {
    let node = draft.get(id);
    if (node && !isGroupLike(node)) node = draft.get(node.parentId);
    while (node && isGroupLike(node) && !groups.has(node.id)) {
      groups.add(node.id);
      node = draft.get(node.parentId);
    }
  }
  if (!groups.size) return;
  const depth = new Map<NodeId, number>();
  for (const id of groups) {
    let d = 0;
    for (let node = draft.get(id); node?.parentId; node = draft.get(node.parentId)) d++;
    depth.set(id, d);
  }
  for (const id of [...groups].sort((a, b) => depth.get(b)! - depth.get(a)!)) {
    const group = draft.get(id);
    if (!group) continue;
    if (stats) stats.fitted++;
    if (!group.children?.some(child => draft.get(child))) draft.remove(id);
    else fitGroup(draft, group);
  }
}

/** Field updates that refit the groups around `ids`, and the groups removed for being empty
 *  (selection drops them). */
export function groupFitUpdates(doc: DesignDocument, ids: Iterable<NodeId>): {updates: NodeUpdates; removed: NodeId[]} {
  if (engineTs('normalize')) return groupFitUpdatesTs(doc, ids);
  const list = [...ids];
  return withEngine('normalize', 'groupFitUpdates', () => groupFitUpdatesTs(doc, list), () => updatesFrom(doc, layoutEntries(doc).normalize_group_fit(JSON.stringify(list))), {inputs: list});
}

function groupFitUpdatesTs(doc: DesignDocument, ids: Iterable<NodeId>): {updates: NodeUpdates; removed: NodeId[]} {
  const draft = new Draft(doc);
  fitGroups(draft, ids);
  return {updates: draft.updates, removed: [...draft.removed]};
}
