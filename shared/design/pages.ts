// Pages loaded on demand (docs/decisions/big-files.md §3–§4, lane BF). With the big-files switch on, a client opens a file as a
// skeleton — every page node (its `children` intact), every component and component set with its subtree (instances on a loaded
// page need their mains), the hidden library page whole, and all the other tables — and asks for a page's layers when it shows
// the page. These helpers build the skeleton and the page slices on the server (server/design/files.ts) and keep the editor's
// partial document in step (src/design/engine/store.ts). Plain functions over `DesignDocument`: importable anywhere.
import type {DesignDocument, NodeId, SceneNode} from './types';
import {LIBRARY_PAGE_ID} from './types';

/** `partial` of an opened file: the pages whose layers came with it, and how many layers each page holds (for the memory budget). */
export type DesignPartial = {loaded: NodeId[]; layers: Record<NodeId, number>};
/** `GET /:id/pages/:pageId`: a page's layers (its descendants, not the page node) at the file's `version`. */
export type DesignPageSlice = {version: number; nodes: Record<NodeId, SceneNode>};

const RESIDENT_TYPES = new Set<SceneNode['type']>(['COMPONENT', 'COMPONENT_SET']);
/** A node every client keeps whatever page it is on: a component or a variant set (instances read their mains). */
export const isResidentNode = (node: SceneNode | undefined): boolean => !!node && RESIDENT_TYPES.has(node.type);

const own = (nodes: Record<NodeId, SceneNode>, id: NodeId): SceneNode | undefined => (Object.hasOwn(nodes, id) ? nodes[id] : undefined);

/** Every descendant of `rootId` (depth first, iterative), the root excluded, each at most once; absent ids are skipped. */
function collectSubtree(nodes: Record<NodeId, SceneNode>, rootId: NodeId, into: Record<NodeId, SceneNode>): void {
  const stack = [...(own(nodes, rootId)?.children ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (Object.hasOwn(into, id)) continue;
    const node = own(nodes, id);
    if (!node) continue;
    into[id] = node;
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

/** The page roots a skeleton walks: the listed pages and the hidden library page when the file has one. */
const pageRoots = (doc: DesignDocument): NodeId[] => (own(doc.nodes, LIBRARY_PAGE_ID)?.type === 'PAGE' ? [...doc.pages, LIBRARY_PAGE_ID] : doc.pages);

/**
 * The document with only the skeleton and the layers of `loaded` pages: page nodes, the library page whole, every component and
 * component set with its subtree (wherever it is), the other tables untouched. Pages that are not listed and not in `loaded`
 * keep their node (and its `children` list) but none of their layers.
 */
export function skeletonOf(doc: DesignDocument, loaded: Iterable<NodeId> = []): DesignDocument {
  const keep = new Set(loaded);
  const nodes: Record<NodeId, SceneNode> = {};
  for (const pageId of pageRoots(doc)) {
    const page = own(doc.nodes, pageId);
    if (!page) continue;
    nodes[pageId] = page;
    if (pageId === LIBRARY_PAGE_ID || keep.has(pageId)) {
      collectSubtree(doc.nodes, pageId, nodes);
      continue;
    }
    // An unloaded page: its components stay resident, with their subtrees.
    const stack = [...(page.children ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      const node = own(doc.nodes, id);
      if (!node || Object.hasOwn(nodes, id)) continue;
      if (isResidentNode(node)) {
        nodes[id] = node;
        collectSubtree(doc.nodes, id, nodes);
        continue;
      }
      if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
  return {...doc, nodes};
}

/** A page's layers (every descendant of the page node) as the client asks for them. */
export function pageSlice(doc: DesignDocument, pageId: NodeId): Record<NodeId, SceneNode> {
  const nodes: Record<NodeId, SceneNode> = {};
  if (own(doc.nodes, pageId)?.type === 'PAGE') collectSubtree(doc.nodes, pageId, nodes);
  return nodes;
}

/** How many layers each listed page holds (the page node excluded), for the memory budget's estimate before a page is loaded. */
export function pageLayerCounts(doc: DesignDocument): Record<NodeId, number> {
  const counts: Record<NodeId, number> = {};
  for (const pageId of doc.pages) {
    let count = 0;
    const stack = [...(own(doc.nodes, pageId)?.children ?? [])];
    while (stack.length) {
      const node = own(doc.nodes, stack.pop()!);
      if (!node) continue;
      count++;
      if (node.children) for (const child of node.children) stack.push(child);
    }
    counts[pageId] = count;
  }
  return counts;
}

/** The pages whose layers are all present: every direct child of the page node exists (a page without layers counts). */
export function loadedPagesOf(doc: DesignDocument): Set<NodeId> {
  const loaded = new Set<NodeId>();
  for (const pageId of doc.pages) {
    const page = own(doc.nodes, pageId);
    if (page?.type === 'PAGE' && (page.children ?? []).every(child => Object.hasOwn(doc.nodes, child))) loaded.add(pageId);
  }
  return loaded;
}

/**
 * The page an entry belongs to, looked up through `read` (the patch's nodes first, then the document's): the id of the page,
 * `'resident'` for a component (or anything inside one), or null when the chain breaks before a page — a layer of a page the
 * client does not hold.
 */
export function pageOfEntry(read: (id: NodeId) => SceneNode | null | undefined, id: NodeId): NodeId | 'resident' | null {
  const seen = new Set<NodeId>();
  let at: NodeId | null = id;
  while (at && !seen.has(at)) {
    seen.add(at);
    const node = read(at);
    if (!node) return null;
    if (node.type === 'PAGE') return node.id;
    if (isResidentNode(node)) return 'resident';
    at = node.parentId;
  }
  return null;
}
