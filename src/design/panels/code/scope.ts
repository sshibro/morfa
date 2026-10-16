import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../../../shared/design/types';
import {componentRoot} from '../../../../shared/design/codegen/tree';

// What "Code" reads of the document for a selection: the selected layers and everything inside them, their parents up to
// the page and their siblings (auto layout's stretch reads them), the components their instances use (whole variant sets,
// and the components those use in turn: nested instances, swaps, swap defaults), and the tables the code reads whole
// (styles, variables, pictures, modes). The store replaces only the layers a change touches, so while every entry here is
// the same object nothing the tab shows can have changed: a co-editor's edit elsewhere in the file costs one pass over
// this list instead of a new generation (CodePanel's useCodeDoc). tests/design-code-scope.test.ts reads the generator and
// every section through a recording document and checks that they read nothing else.

const TABLES = ['styles', 'images', 'variables', 'variableCollections', 'variableModes'] as const;

export type CodeScope = {
  /** Layers read, as the objects they were. */
  nodes: Map<NodeId, SceneNode | undefined>;
  /** Layers read only for what they are: the page above the selection, the frame a component stands in (is it a set?). */
  kinds: Map<NodeId, NodeType>;
  tables: readonly unknown[];
};

/** Past this many layers no scope is kept (the tab does not generate such a selection live; it regenerates then). */
const MAX_LAYERS = 100_000;

export function codeScope(doc: DesignDocument, ids: readonly NodeId[]): CodeScope | null {
  const nodes = new Map<NodeId, SceneNode | undefined>();
  const kinds = new Map<NodeId, NodeType>();
  const walk: NodeId[] = [...ids];
  for (const id of ids) {
    const node = doc.nodes[id];
    const parent = node?.parentId ? doc.nodes[node.parentId] : undefined;
    // Siblings: a layer in auto layout stretches by CSS's default only when they all do.
    if (parent && parent.type !== 'PAGE') for (const sibling of parent.children ?? []) nodes.set(sibling, doc.nodes[sibling]);
    for (let up = parent; up; up = up.parentId ? doc.nodes[up.parentId] : undefined) {
      // A text on the page reads the page's other texts (its role among them); anything else only that it is a page.
      if (up.type === 'PAGE' && node?.type !== 'TEXT') {
        kinds.set(up.id, up.type);
        break;
      }
      if (nodes.has(up.id)) break;
      nodes.set(up.id, up);
    }
  }
  const walked = new Set<NodeId>();
  const component = (id: string) => {
    if (doc.nodes[id]) walk.push(componentRoot(doc, id) ?? id);
  };
  while (walk.length) {
    const id = walk.pop()!;
    if (walked.has(id)) continue;
    walked.add(id);
    if (walked.size > MAX_LAYERS) return null;
    const node = doc.nodes[id];
    nodes.set(id, node);
    if (!node) continue;
    if (node.children) walk.push(...node.children);
    // A variant reads its whole set; an instance its component's, and a swap the component it puts in.
    const parent = node.type === 'COMPONENT' && node.parentId ? doc.nodes[node.parentId] : undefined;
    if (parent?.type === 'COMPONENT_SET') walk.push(parent.id);
    else if (parent) kinds.set(parent.id, parent.type);
    if (node.componentId) component(node.componentId);
    if (node.mainId) component(node.mainId);
    for (const value of Object.values(node.componentProperties ?? {})) if (typeof value === 'string') component(value);
    for (const definition of Object.values(node.componentPropertyDefinitions ?? {})) if (definition.type === 'INSTANCE_SWAP' && typeof definition.defaultValue === 'string') component(definition.defaultValue);
  }
  return {nodes, kinds, tables: TABLES.map(table => doc[table])};
}

/** Whether `doc` still holds everything `scope` read, as the same objects. */
export function scopeHolds(scope: CodeScope, doc: DesignDocument): boolean {
  if (TABLES.some((table, i) => doc[table] !== scope.tables[i])) return false;
  for (const [id, type] of scope.kinds) if (doc.nodes[id]?.type !== type) return false;
  for (const [id, node] of scope.nodes) if (doc.nodes[id] !== node) return false;
  return true;
}
