// Card Canvas: the card as Spec Lint sees it, apart from the document (docs/marketplaces.md §Spec Lint): the copy of a card its
// measurements paint, and what its checks depend on, to tell an edit of the card from an edit elsewhere in the file.

import {isShownOn} from '../../../../shared/design/marketplace/meta';
import type {Marketplace} from '../../../../shared/design/marketplace/specs';
import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';

/**
 * What painting the card needs, copied out of the document: the card's subtree and its ancestors, with the layers its picture on
 * `marketplace` does not show hidden, and every text layer too when `hideTexts`. Node objects are shared, never changed: the
 * copy is the card as it was at this moment, whatever the store does to its own table meanwhile.
 */
export function cardRenderDoc(doc: DesignDocument, frameId: NodeId, marketplace: Marketplace, hideTexts: boolean): DesignDocument {
  const nodes: Record<NodeId, SceneNode> = {};
  for (let id = doc.nodes[frameId]?.parentId ?? null, depth = 0; id && depth < 64; id = doc.nodes[id]?.parentId ?? null, depth++) {
    const node = doc.nodes[id];
    if (!node) break;
    nodes[id] = node;
  }
  const stack = [frameId];
  while (stack.length) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    const hide = id !== frameId && node.visible && (!isShownOn(node, marketplace) || (hideTexts && node.type === 'TEXT'));
    nodes[id] = hide ? {...node, visible: false} : node;
    if (node.children) stack.push(...node.children);
  }
  return {...doc, nodes};
}

/** The opacity a layer is painted with inside its card: its own times its ancestors' up to the card frame. */
export function opacityInCard(doc: DesignDocument, node: SceneNode, frameId: NodeId): number {
  let opacity = node.opacity;
  for (let id = node.parentId, depth = 0; id && id !== frameId && depth < 64; id = doc.nodes[id]?.parentId ?? null, depth++) opacity *= doc.nodes[id]?.opacity ?? 1;
  return opacity;
}

/** What the card's checks depend on, compared by identity: its layers (every node of its subtree), and the file's styles,
 *  pictures and variables. */
export function cardSignature(doc: DesignDocument, frameId: NodeId): unknown[] {
  const out: unknown[] = [doc.styles, doc.images, doc.variables, doc.variableModes];
  const stack = [frameId];
  // A card in a set also depends on its set's other cards (how many pictures the set has): their meta is on their frames.
  for (const pageId of doc.pages) for (const childId of doc.nodes[pageId]?.children ?? []) if (doc.nodes[childId]?.pluginData) out.push(doc.nodes[childId].pluginData);
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    out.push(node);
    if (node?.children) stack.push(...node.children);
  }
  return out;
}
export const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => value === b[i]);
