import type {NodeId, SceneNode} from './types';
import {newId} from './defaults';

// Copies of layers with fresh ids, for the editor's clipboard (src/design/engine/clipboard.ts) and the server's board templates
// (server/design/templates.ts): one rule for both, so a template inserted from the server is a copy as a paste makes one.

/** Copies of the subtrees under `rootIds` with fresh ids, parents before children, in paint order.
 *  Nodes inside an instance keep the `${instanceId};${mainId}` scheme: their ids are re-derived from
 *  the copied instance's new id; a copy taken out of its instance becomes an ordinary layer.
 *  Prototype links between copied nodes follow the copies, and so do a board's connector ends. Roots keep their old `parentId`. */
export function cloneSubtrees(nodes: Readonly<Record<NodeId, SceneNode>>, rootIds: readonly NodeId[], makeId: () => NodeId = newId): {nodes: SceneNode[]; ids: Map<NodeId, NodeId>} {
  const out: SceneNode[] = [];
  const ids = new Map<NodeId, NodeId>();
  /** Old id → old ids of the instances above it inside the copy, nearest last. */
  const visit = (id: NodeId, instances: NodeId[]) => {
    const node = nodes[id];
    if (!node) return;
    let fresh: NodeId | null = null;
    for (let i = instances.length - 1; i >= 0 && !fresh; i--) {
      const owner = instances[i];
      if (id.startsWith(owner + ';')) fresh = ids.get(owner)! + id.slice(owner.length);
    }
    const copy: SceneNode = {...node, id: fresh ?? makeId()};
    if (!fresh && !instances.length && (copy.mainId || copy.overrides)) {
      delete copy.mainId;
      delete copy.overrides;
    }
    ids.set(id, copy.id);
    if (copy.children) copy.children = [];
    out.push(copy);
    const inner = node.type === 'INSTANCE' ? [...instances, id] : instances;
    for (const child of node.children ?? []) visit(child, inner);
  };
  for (const root of rootIds) visit(root, []);
  for (const copy of out) {
    if (copy.parentId && ids.has(copy.parentId)) copy.parentId = ids.get(copy.parentId)!;
    if (copy.reactions.some(reaction => reaction.actions.some(action => action.type === 'NODE' && ids.has(action.destinationId)))) {
      copy.reactions = copy.reactions.map(reaction => ({...reaction, actions: reaction.actions.map(action => (action.type === 'NODE' && ids.has(action.destinationId) ? {...action, destinationId: ids.get(action.destinationId)!} : action))}));
    }
    // "Board" (docs/board.md): a connector's end on a copied object follows the copy (one copied alone stays on its objects).
    const meta = copy.board;
    if (meta?.kind === 'connector') {
      const follow = <E extends typeof meta.start>(end: E): E => ('node' in end && ids.has(end.node) ? {...end, node: ids.get(end.node)!} : end);
      const start = follow(meta.start), end = follow(meta.end);
      if (start !== meta.start || end !== meta.end) copy.board = {...meta, start, end};
    }
  }
  return {nodes: out, ids};
}
