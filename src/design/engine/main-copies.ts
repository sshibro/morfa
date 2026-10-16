import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {createNode} from '../../../shared/design/defaults';

// A main component's copies are instances of it, as in Figma: ⌘D, ⌥-drag and a paste in the file that holds the main
// (help.figma.com "Create and insert component instances"). A variant's copy stays a variant of its set, a main that is
// no longer in the file (cut, or copied from another file) comes back as a main, and a copy that lands inside its own
// main stays an ordinary copy (an instance there would contain itself).

/** Whether `doc` holds `id` as a main component standing outside a variant set (its copies are instances of it). */
export function copiesAsInstance(doc: DesignDocument, id: NodeId): boolean {
  const node = doc.nodes[id];
  return node?.type === 'COMPONENT' && node.mainId === undefined && doc.nodes[node.parentId ?? '']?.type !== 'COMPONENT_SET';
}

/** A bare instance of `main` in its place, under the id a copy would take: the transaction's normalize pass
 *  materialises its copies. */
export function bareInstance(main: SceneNode, id: NodeId, parentId: NodeId | null = main.parentId): SceneNode {
  return createNode('INSTANCE', {
    id, parentId, name: main.name, componentId: main.id, x: main.x, y: main.y, width: main.width, height: main.height,
    rotation: main.rotation, constraints: {...main.constraints}, layoutPositioning: main.layoutPositioning,
  });
}

/** Whether `id` is `ancestor` or inside it in `doc`. */
function within(doc: DesignDocument, id: NodeId | null | undefined, ancestor: NodeId): boolean {
  for (let node = id ? doc.nodes[id] : undefined; node; node = node.parentId ? doc.nodes[node.parentId] : undefined) {
    if (node.id === ancestor) return true;
  }
  return false;
}

/** `cloned` (a `cloneSubtrees` result for `rootIds` of `source`) with every root that `doc` holds as a main component
 *  turned into a bare instance of it, and that root's cloned subtree dropped. `into` is where the copies go: a main
 *  copied into itself stays an ordinary copy. */
export function mainsAsInstances(
  doc: DesignDocument, source: Readonly<Record<NodeId, SceneNode>>, rootIds: readonly NodeId[],
  cloned: {nodes: SceneNode[]; ids: Map<NodeId, NodeId>}, into?: NodeId,
): {nodes: SceneNode[]; ids: Map<NodeId, NodeId>} {
  const mains = rootIds.filter(id => source[id]?.type === 'COMPONENT' && copiesAsInstance(doc, id) && !(into && within(doc, into, id)));
  if (!mains.length) return cloned;
  const swapped = new Map(mains.map(id => [cloned.ids.get(id)!, id]));
  const dropped = new Set<NodeId>();
  const nodes = cloned.nodes.flatMap(clone => {
    const main = swapped.get(clone.id);
    if (main) return [bareInstance(source[main], clone.id, clone.parentId)];
    if (clone.parentId && (swapped.has(clone.parentId) || dropped.has(clone.parentId))) {
      dropped.add(clone.id);
      return [];
    }
    return [clone];
  });
  return {nodes, ids: cloned.ids};
}
