import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';

// "Edit all variants" (Figma's Multi-edit variants, Q; help.figma.com "Edit objects on the canvas in bulk"): with a
// component set, a variant or a layer inside a variant selected, the selection grows to the same layer in every variant
// of the set — the set's variants for the set or a variant, the layer at the same place (the same names down from its
// variant) for a layer inside one. Every edit after that reaches them all, as edits of a selection do.

/** The component set holding `id` (itself, its variant or a layer inside a variant), or null. */
function setOf(doc: DesignDocument, id: NodeId): SceneNode | null {
  for (let node: SceneNode | undefined = doc.nodes[id]; node; node = node.parentId ? doc.nodes[node.parentId] : undefined) {
    if (node.type === 'COMPONENT_SET') return node;
  }
  return null;
}

/** The names from the variant (left out) down to the node; [] for the variant itself. */
function pathInVariant(doc: DesignDocument, set: SceneNode, id: NodeId): string[] | null {
  const names: string[] = [];
  for (let node: SceneNode | undefined = doc.nodes[id]; node; node = node.parentId ? doc.nodes[node.parentId] : undefined) {
    if (node.parentId === set.id) return names;
    names.unshift(node.name);
  }
  return null;
}

/** The layer at `path` inside `variant`, or null. */
function atPath(doc: DesignDocument, variant: NodeId, path: readonly string[]): NodeId | null {
  let current: NodeId = variant;
  for (const name of path) {
    const next = doc.nodes[current]?.children?.find(child => doc.nodes[child]?.name === name);
    if (!next) return null;
    current = next;
  }
  return current;
}

/** The selection that edits every variant at once, or null when the selection is not in one component set. */
export function variantMultiEdit(doc: DesignDocument, selection: readonly NodeId[]): NodeId[] | null {
  if (!selection.length) return null;
  const set = setOf(doc, selection[0]);
  if (!set || selection.some(id => setOf(doc, id)?.id !== set.id)) return null;
  const variants = (set.children ?? []).filter(id => doc.nodes[id]?.type === 'COMPONENT');
  if (variants.length < 2) return null;
  const out = new Set<NodeId>();
  for (const id of selection) {
    if (id === set.id) {
      variants.forEach(variant => out.add(variant));
      continue;
    }
    const path = pathInVariant(doc, set, id);
    if (!path) continue;
    for (const variant of variants) {
      const match = atPath(doc, variant, path);
      if (match) out.add(match);
    }
  }
  const next = [...out];
  return next.length > selection.length || next.some(id => !selection.includes(id)) ? next : null;
}
