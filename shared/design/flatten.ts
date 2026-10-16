import type {DesignDocument, Matrix, NodeId, SceneNode, VectorPath} from './types';
import {IDENTITY, invert, localMatrix, multiply, worldMatrix} from './geometry';
import {transformPaths} from './paths';
import {nodeGeometry} from './shapes';
import {booleanGeometryExact, vectorFromPaths, type FlattenOutcome} from './boolean';

// "Flatten" (⌘E) for any selection of shapes: rectangles, ellipses, polygons, stars, lines,
// vectors, boolean groups, groups and frames of those become one VECTOR. Every source path is
// kept with its own winding rule (no boolean union), so the result paints exactly what the
// sources painted with the top layer's look. One source keeps its own rotation and flip, as in
// Figma; several are placed in their top layer's parent, unrotated. Text is skipped with a
// reason: flattening it needs glyph outlines, which the editor does not have.

export type Skipped = {id: NodeId; reason: string};
export type ToVectorResult = FlattenOutcome | {error: string; skipped: Skipped[]};

export const FLATTEN_REASONS = {
  text: 'Text cannot be flattened: the letter outlines are unavailable',
  hidden: 'A hidden layer was skipped',
  slice: 'A slice is not drawn',
  page: 'A page cannot be flattened',
  missing: 'Layer not found',
  otherPage: 'Layers from different pages',
  empty: 'Nothing to flatten: the selected layers have no outlines',
} as const;

/** Index path from the page down (page index first), for paint order: later paths draw on top. */
function orderKey(doc: DesignDocument, id: NodeId): number[] {
  const key: number[] = [];
  let node = doc.nodes[id];
  while (node?.parentId) {
    const parent = doc.nodes[node.parentId];
    key.unshift(parent?.children?.indexOf(node.id) ?? 0);
    node = parent;
  }
  key.unshift(node ? doc.pages.indexOf(node.id) : -1);
  return key;
}

function compareKeys(a: number[], b: number[]): number {
  for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) return a[k] - b[k];
  return a.length - b.length;
}

function hasAncestorIn(doc: DesignDocument, id: NodeId, set: ReadonlySet<NodeId>): boolean {
  for (let parent = doc.nodes[id]?.parentId; parent; parent = doc.nodes[parent]?.parentId) if (set.has(parent)) return true;
  return false;
}

const paints = (node: SceneNode) => node.fills.some(p => p.visible) || node.strokes.some(p => p.visible);

type Collected = {paths: VectorPath[]; style: {node: SceneNode; matrix: Matrix} | null};

/** Paths of a subtree mapped by `matrix`, in paint order; `style` ends as the top painted leaf. */
function collect(doc: DesignDocument, node: SceneNode, matrix: Matrix, out: Collected, skipped: Skipped[]): void {
  if (!node.visible) { skipped.push({id: node.id, reason: FLATTEN_REASONS.hidden}); return; }
  switch (node.type) {
    case 'TEXT': skipped.push({id: node.id, reason: FLATTEN_REASONS.text}); return;
    case 'SLICE': skipped.push({id: node.id, reason: FLATTEN_REASONS.slice}); return;
    case 'PAGE': skipped.push({id: node.id, reason: FLATTEN_REASONS.page}); return;
    case 'BOOLEAN_OPERATION': {
      out.paths.push(...transformPaths(booleanGeometryExact(doc, node.id), matrix));
      out.style = {node, matrix};
      return;
    }
    case 'GROUP': case 'FRAME': case 'COMPONENT': case 'COMPONENT_SET': case 'INSTANCE': case 'SECTION': {
      // A frame's own box counts when it paints; its children follow on top.
      if (node.type !== 'GROUP' && paints(node)) {
        out.paths.push(...transformPaths(nodeGeometry(node), matrix));
        out.style = {node, matrix};
      }
      for (const id of node.children ?? []) {
        const child = doc.nodes[id];
        if (child) collect(doc, child, multiply(matrix, localMatrix(child)), out, skipped);
      }
      return;
    }
    default: {
      const paths = nodeGeometry(node);
      if (!paths.length) return;
      out.paths.push(...transformPaths(paths, matrix));
      out.style = {node, matrix};
    }
  }
}

/** "Flatten": one VECTOR replacing the given nodes (and their subtrees). The result is placed
 *  where the top-most of them was, in its parent; `skipped` lists layers that could not take
 *  part and why. An error when nothing can be flattened. */
export function toVector(doc: DesignDocument, ids: readonly NodeId[]): ToVectorResult {
  const skipped: Skipped[] = [];
  const unique = [...new Set(ids)].filter(id => {
    const node = doc.nodes[id];
    if (!node) { skipped.push({id, reason: FLATTEN_REASONS.missing}); return false; }
    if (node.type === 'PAGE' || !node.parentId) { skipped.push({id, reason: FLATTEN_REASONS.page}); return false; }
    return true;
  });
  const set = new Set(unique);
  // A node selected together with its ancestor goes with the ancestor.
  const roots = unique.filter(id => !hasAncestorIn(doc, id, set));
  if (!roots.length) return {error: FLATTEN_REASONS.empty, skipped};
  const keys = new Map(roots.map(id => [id, orderKey(doc, id)]));
  roots.sort((a, b) => compareKeys(keys.get(a)!, keys.get(b)!));
  if (new Set(roots.map(id => keys.get(id)![0])).size > 1) return {error: FLATTEN_REASONS.otherPage, skipped};
  // Each root in its own space first. Only roots that contribute paths take part: a skipped text
  // is neither removed nor allowed to decide where the vector goes.
  type Part = {id: NodeId; paths: VectorPath[]; style: {node: SceneNode; matrix: Matrix}};
  const parts: Part[] = [];
  for (const id of roots) {
    const collected: Collected = {paths: [], style: null};
    collect(doc, doc.nodes[id], IDENTITY, collected, skipped);
    if (collected.paths.length && collected.style) parts.push({id, paths: collected.paths, style: collected.style});
  }
  if (!parts.length) return {error: FLATTEN_REASONS.empty, skipped};
  const last = parts[parts.length - 1];
  const top = doc.nodes[last.id];
  const parentId = top.parentId as NodeId;
  const single = parts.length === 1;
  // One source keeps its own space (and so its rotation); several meet in the top one's parent.
  const toParent = invert(worldMatrix(doc, parentId));
  const placeOf = (id: NodeId) => (single ? IDENTITY : multiply(toParent, worldMatrix(doc, id)));
  const paths = parts.flatMap(part => transformPaths(part.paths, placeOf(part.id)));
  const space = single ? localMatrix(top) : IDENTITY;
  const vector = vectorFromPaths(last.style.node, paths, space, parentId, {
    name: single ? top.name : 'Vector',
    sourceMatrix: multiply(space, multiply(placeOf(last.id), last.style.matrix)),
  });
  // Layer settings come from the top selected layer, as its place in the stack does.
  vector.visible = top.visible;
  vector.locked = top.locked;
  vector.constraints = {...top.constraints};
  const remove = parts.map(part => part.id);
  const removed = new Set(remove);
  let index = 0;
  for (const id of doc.nodes[parentId]?.children ?? []) {
    if (id === top.id) break;
    if (!removed.has(id)) index++;
  }
  return {node: vector, parentId, index, remove, skipped};
}
