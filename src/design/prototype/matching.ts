import type {DesignDocument, NodeId, Reaction, SceneNode} from '../../../shared/design/types';

// "Select matching interactions" (Figma's Select matching interactions, help.figma.com "Connect your prototype"): the layers in
// the page's other top-level frames that sit where this one sits (the same names down from their frame) and carry the same
// interaction (the same trigger, actions and destinations). Copied screens keep their buttons' interactions in step this way.

/** The names from the top-level frame (left out) down to the node, or null for a top-level frame or a layer outside one. */
function namePath(doc: DesignDocument, node: SceneNode): string[] | null {
  const names: string[] = [];
  let current: SceneNode | undefined = node;
  while (current?.parentId) {
    const parent: SceneNode | undefined = doc.nodes[current.parentId];
    if (!parent) return null;
    if (parent.type === 'PAGE') return names.length ? names : null;
    names.unshift(current.name);
    current = parent;
  }
  return null;
}

const sameReaction = (a: Reaction, b: Reaction) => JSON.stringify(a) === JSON.stringify(b);

/** Every layer of the page whose position and interaction match `reaction` of `nodeId`, the node itself first. */
export function matchingInteractions(doc: DesignDocument, nodeId: NodeId, reactionIndex: number): NodeId[] {
  const node = doc.nodes[nodeId];
  const reaction = node?.reactions[reactionIndex];
  const path = node && namePath(doc, node);
  if (!node || !reaction || !path) return node ? [nodeId] : [];
  let page: SceneNode | undefined = node;
  while (page && page.type !== 'PAGE') page = page.parentId ? doc.nodes[page.parentId] : undefined;
  const out = [nodeId];
  const key = path.join('\u0000');
  const visit = (id: NodeId) => {
    const each = doc.nodes[id];
    if (!each) return;
    if (id !== nodeId && each.reactions.some(other => sameReaction(other, reaction)) && namePath(doc, each)?.join('\u0000') === key) out.push(id);
    for (const child of each.children ?? []) visit(child);
  };
  for (const frame of page?.children ?? []) visit(frame);
  return out;
}

/** Whether every one of these layers has the same interactions (then the panel edits them together). */
export function sameInteractions(nodes: readonly Pick<SceneNode, 'reactions'>[]): boolean {
  const first = JSON.stringify(nodes[0]?.reactions ?? []);
  return nodes.every(node => JSON.stringify(node.reactions) === first);
}
