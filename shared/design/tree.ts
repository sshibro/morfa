import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from './types';
import {CONTAINER_TYPES, FRAME_LIKE_TYPES} from './types';
import {apply, IDENTITY, invert, localMatrix, multiply, worldMatrix, type Rect} from './geometry';

// Pure queries over the node tree: who contains whom, in which order things are painted and hit,
// and which container a drop or a new shape lands in. Nothing here changes a document.
//
// Children are listed bottom-to-top, so paint order is a pre-order walk (a parent, then its
// children from index 0 up) and hit order is its exact reverse (front-most first, children before
// their parent). An auto-layout frame with "First on top" (`itemReverseZIndex`) paints its
// children the other way round.

const NO_IDS: readonly NodeId[] = [];

/** Finds nodes by page-space bounds without walking the page. The renderer builds one per page
 *  (src/design/engine/render/spatial-index.ts); hit testing, marquee and drop targets take it when
 *  they have it and walk the tree when they do not. */
export interface SpatialIndex {
  /** Ids of nodes on the indexed page, at any depth, whose page-space bounds intersect `rect`. Any order. */
  query(rect: Rect): Iterable<NodeId>;
}

export const isContainerNode = (node: Pick<SceneNode, 'type'> | undefined): boolean => !!node && CONTAINER_TYPES.includes(node.type);
export const isFrameLikeNode = (node: Pick<SceneNode, 'type'> | undefined): boolean => !!node && FRAME_LIKE_TYPES.includes(node.type);
/** Nodes drawn in the component colour: main components, variant sets and instances. */
export const isComponentLike = (node: Pick<SceneNode, 'type'> | undefined): boolean =>
  !!node && (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE');
/** Containers a drop or a new shape can land in: frames, components, variant sets and sections.
 *  Instances are excluded, their children come from the main component; so are a board's objects and their
 *  layers (docs/board.md: a sticky dropped on a sticky stays beside it). */
export const isDropTarget = (node: Pick<SceneNode, 'type' | 'board'> | undefined): boolean =>
  !!node && !node.board && (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'SECTION');

export const childrenOf = (doc: DesignDocument, id: NodeId): readonly NodeId[] => doc.nodes[id]?.children ?? NO_IDS;

export function parentOf(doc: DesignDocument, id: NodeId): SceneNode | undefined {
  const parentId = doc.nodes[id]?.parentId;
  return parentId ? doc.nodes[parentId] : undefined;
}

/** Ancestors from the parent up to the page, inclusive. */
export function ancestors(doc: DesignDocument, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (let node = doc.nodes[id]; node?.parentId; node = doc.nodes[node.parentId]) out.push(node.parentId);
  return out;
}

/** Whether `ancestor` contains `id` (strictly: a node is not its own ancestor). */
export function isAncestor(doc: DesignDocument, ancestor: NodeId, id: NodeId): boolean {
  for (let node = doc.nodes[id]; node?.parentId; node = doc.nodes[node.parentId]) {
    if (node.parentId === ancestor) return true;
  }
  return false;
}

/** Visits the subtree under `id` (not `id` itself) depth-first in paint order. Returning false from
 *  `visit` skips that node's children. */
export function forEachDescendant(doc: DesignDocument, id: NodeId, visit: (node: SceneNode, depth: number) => void | boolean) {
  const walk = (parentId: NodeId, depth: number) => {
    for (const childId of childrenOf(doc, parentId)) {
      const child = doc.nodes[childId];
      if (!child) continue;
      if (visit(child, depth) === false) continue;
      if (child.children?.length) walk(childId, depth + 1);
    }
  };
  walk(id, 0);
}

/** Every node under `id` in depth-first (paint) order, `id` excluded. */
export function descendants(doc: DesignDocument, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  forEachDescendant(doc, id, node => void out.push(node.id));
  return out;
}

/** The id of the page a node is on, or null for a detached node. */
export function pageIdOf(doc: DesignDocument, id: NodeId): NodeId | null {
  let node = doc.nodes[id];
  while (node && node.type !== 'PAGE') node = node.parentId ? doc.nodes[node.parentId] : (undefined as never);
  return node ? node.id : null;
}

/** Children in the order they are painted (back to front). */
export function paintChildren(node: SceneNode | undefined): readonly NodeId[] {
  // A board section with its contents hidden (FigJam's "Hide section") paints and offers none of them.
  if (node?.type === 'SECTION' && node.board?.kind === 'section' && node.board.hidden) return NO_IDS;
  const children = node?.children ?? NO_IDS;
  if (node?.autoLayout?.itemReverseZIndex && node.autoLayout.layoutMode !== 'NONE' && children.length > 1) return [...children].reverse();
  return children;
}

/** Nodes under `rootId` back to front (the renderer's order), `rootId` excluded. */
export function paintOrder(doc: DesignDocument, rootId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const walk = (id: NodeId) => {
    for (const childId of paintChildren(doc.nodes[id])) {
      if (!doc.nodes[childId]) continue;
      out.push(childId);
      walk(childId);
    }
  };
  walk(rootId);
  return out;
}

/** Nodes under `rootId` front to back (the order a click meets them), `rootId` excluded. */
export function hitOrder(doc: DesignDocument, rootId: NodeId): NodeId[] {
  return paintOrder(doc, rootId).reverse();
}

/** Child id → index, per children list: sorting hundreds of layers of a frame with hundreds of
 *  children would otherwise scan the list once per layer and level. A list a transaction is still
 *  editing in place can go stale, so every answer is checked against the list itself. */
const childIndexes = new WeakMap<readonly NodeId[], Map<NodeId, number>>();
function indexIn(children: readonly NodeId[], id: NodeId): number {
  if (children.length < 32) return children.indexOf(id);
  let map = childIndexes.get(children);
  const known = map?.get(id);
  if (known !== undefined && children[known] === id) return known;
  map = new Map();
  for (let i = 0; i < children.length; i++) map.set(children[i], i);
  childIndexes.set(children, map);
  return map.get(id) ?? -1;
}

/** Index of a child in its parent's paint order (`paintChildren`), -1 when it is not a child. */
function paintIndex(parent: SceneNode | undefined, id: NodeId): number {
  const children = parent?.children;
  if (!children) return -1;
  const index = indexIn(children, id);
  return index >= 0 && paintsReversed(parent!) ? children.length - 1 - index : index;
}

/** An auto-layout frame whose first child is drawn on top ("First on top"). */
const paintsReversed = (node: SceneNode) => !!node.autoLayout?.itemReverseZIndex && node.autoLayout.layoutMode !== 'NONE' && (node.children?.length ?? 0) > 1;

/** Position of a node in paint order as a path of child indices from its page (the page's index in
 *  `pages` first). Comparing two paths lexicographically compares paint order. */
export function paintPath(doc: DesignDocument, id: NodeId): number[] {
  const path: number[] = [];
  let node = doc.nodes[id];
  while (node?.parentId) {
    const parent = doc.nodes[node.parentId];
    path.push(paintIndex(parent, node.id));
    node = parent;
  }
  path.push(node ? doc.pages.indexOf(node.id) : -1);
  return path.reverse();
}

/** Negative when `a` is painted before (below) `b`. An ancestor is painted before its descendants. */
export function comparePaintPaths(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Ids sorted back to front. Missing ids are dropped. */
export function sortByPaintOrder(doc: DesignDocument, ids: Iterable<NodeId>): NodeId[] {
  const keyed: {id: NodeId; path: number[]}[] = [];
  for (const id of new Set(ids)) if (doc.nodes[id]) keyed.push({id, path: paintPath(doc, id)});
  keyed.sort((a, b) => comparePaintPaths(a.path, b.path));
  return keyed.map(entry => entry.id);
}

/** The selection without nodes whose ancestor is also selected (what moves, groups or deletes),
 *  in the given order, without duplicates or missing ids. */
export function topLevelSelection(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const selected = new Set(ids);
  const out: NodeId[] = [];
  const seen = new Set<NodeId>();
  // Whether a container or one of its ancestors is selected, worked out once per container: thousands of selected
  // siblings ask about the same few parents.
  const covered = new Map<NodeId, boolean>();
  const isCovered = (parentId: NodeId): boolean => {
    const chain: NodeId[] = [];
    let answer = false;
    for (let at: NodeId | null | undefined = parentId; at; at = doc.nodes[at]?.parentId) {
      const known = covered.get(at);
      if (known !== undefined) {
        answer = known;
        break;
      }
      chain.push(at);
      if (selected.has(at)) {
        answer = true;
        break;
      }
    }
    for (const each of chain) covered.set(each, answer);
    return answer;
  };
  for (const id of ids) {
    if (seen.has(id) || !doc.nodes[id]) continue;
    seen.add(id);
    const parentId = doc.nodes[id].parentId;
    if (parentId && isCovered(parentId)) continue;
    out.push(id);
  }
  return out;
}

/** The deepest node containing every given node (the parent they share, or the closest common
 *  ancestor of their parents). Null when the ids are on different pages or missing. */
export function commonParent(doc: DesignDocument, ids: readonly NodeId[]): NodeId | null {
  let chain: NodeId[] | null = null;
  for (const id of ids) {
    const parentId = doc.nodes[id]?.parentId;
    if (!parentId) return null;
    const own = [parentId, ...ancestors(doc, parentId)];
    if (!chain) {
      chain = own;
      continue;
    }
    const set = new Set(own);
    const at = chain.findIndex(each => set.has(each));
    if (at < 0) return null;
    chain = chain.slice(at);
  }
  return chain?.[0] ?? null;
}

/** Index of the node in its parent's children (bottom-to-top), or -1. */
export function siblingIndex(doc: DesignDocument, id: NodeId): number {
  const parent = parentOf(doc, id);
  return parent?.children ? parent.children.indexOf(id) : -1;
}

/** The closest ancestor (or the node itself with `includeSelf`) that is a frame, component, variant
 *  set, section or instance. Null when only the page is above. */
export function nearestFrameLike(doc: DesignDocument, id: NodeId, options: {includeSelf?: boolean} = {}): NodeId | null {
  let node: SceneNode | undefined = options.includeSelf ? doc.nodes[id] : parentOf(doc, id);
  while (node && node.type !== 'PAGE') {
    if (isFrameLikeNode(node) || node.type === 'SECTION') return node.id;
    node = node.parentId ? doc.nodes[node.parentId] : undefined;
  }
  return null;
}

/** Whether the node lives inside an instance (its fields mirror the main component's). */
export function isInsideInstance(doc: DesignDocument, id: NodeId): boolean {
  for (let node = parentOf(doc, id); node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : undefined) {
    if (node.type === 'INSTANCE') return true;
  }
  return false;
}

/** The node and every ancestor up to the page are visible. */
export function isVisibleInTree(doc: DesignDocument, id: NodeId): boolean {
  for (let node: SceneNode | undefined = doc.nodes[id]; node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : undefined) {
    if (!node.visible) return false;
  }
  return !!doc.nodes[id];
}

/** The node or one of its ancestors is locked (it cannot be picked on the canvas). */
export function isLockedInTree(doc: DesignDocument, id: NodeId): boolean {
  for (let node: SceneNode | undefined = doc.nodes[id]; node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : undefined) {
    if (node.locked) return true;
  }
  return false;
}

const insideBox = (node: SceneNode, local: Vec) => local.x >= 0 && local.y >= 0 && local.x <= node.width && local.y <= node.height;

/** The top-most visible, unlocked frame, component, variant set or section whose box contains the
 *  page-space `point`: where a dropped node or a newly drawn shape goes. Nodes in `exclude` (the ones
 *  being dragged) and their subtrees are skipped, instances are never entered, children of a
 *  clipping frame count only inside it. Null means the page itself. */
export function frameAtPoint(doc: DesignDocument, pageId: NodeId, point: Vec, exclude: ReadonlySet<NodeId> = new Set(), index?: SpatialIndex | null): NodeId | null {
  if (index) return frameAtPointIndexed(doc, pageId, point, exclude, index);
  const search = (parentId: NodeId, world: Matrix): NodeId | null => {
    const children = paintChildren(doc.nodes[parentId]);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = doc.nodes[children[i]];
      if (!child || !child.visible || child.locked || exclude.has(child.id) || child.type === 'INSTANCE') continue;
      if (child.type !== 'GROUP' && !isDropTarget(child)) continue;
      const m = multiply(world, localMatrix(child));
      if (child.type === 'GROUP') {
        const inner = search(child.id, m);
        if (inner) return inner;
        continue;
      }
      const inside = insideBox(child, apply(invert(m), point));
      const clips = child.type !== 'SECTION' && child.clipsContent !== false;
      if (inside || !clips) {
        const inner = search(child.id, m);
        if (inner) return inner;
      }
      if (inside) return child.id;
    }
    return null;
  };
  return search(pageId, IDENTITY);
}

function frameAtPointIndexed(doc: DesignDocument, pageId: NodeId, point: Vec, exclude: ReadonlySet<NodeId>, index: SpatialIndex): NodeId | null {
  let best: {id: NodeId; path: number[]} | null = null;
  for (const id of index.query({x: point.x, y: point.y, width: 0, height: 0})) {
    const node = doc.nodes[id];
    if (!isDropTarget(node)) continue;
    if (!insideBox(node, apply(invert(worldMatrix(doc, id)), point))) continue;
    let usable = true;
    for (let up: SceneNode | undefined = node; up && up.type !== 'PAGE'; up = up.parentId ? doc.nodes[up.parentId] : undefined) {
      if (!up.visible || up.locked || exclude.has(up.id) || (up !== node && up.type === 'INSTANCE')) {
        usable = false;
        break;
      }
      if (up !== node && isFrameLikeNode(up) && up.clipsContent !== false && !insideBox(up, apply(invert(worldMatrix(doc, up.id)), point))) {
        usable = false;
        break;
      }
    }
    if (!usable || pageIdOf(doc, id) !== pageId) continue;
    const path = paintPath(doc, id);
    if (!best || comparePaintPaths(path, best.path) > 0) best = {id, path};
  }
  return best?.id ?? null;
}

/** `name` if no sibling uses it, otherwise "name 2", "name 3"… */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(name)) return name;
  let n = 2;
  while (names.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

/** The next numbered name after the highest one in use: "Frame 3" after "Frame 1" and "Frame 2". */
export function nextNumberedName(base: string, taken: Iterable<string>): string {
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
  let max = 0;
  for (const name of taken) {
    const match = pattern.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${base} ${max + 1}`;
}

/** A new layer's name as Figma gives it: its type numbered after the highest number of that name
 *  anywhere on the page ("Rectangle 3" when the page has 1 and 2, whatever frames they are in). */
export function nextLayerName(doc: DesignDocument, pageId: NodeId | null, base: string): string {
  const prefix = base + ' ';
  let max = 0;
  const stack = [...(pageId ? doc.nodes[pageId]?.children ?? [] : [])];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    const name = node.name;
    if (name.length > prefix.length && name.startsWith(prefix)) {
      const rest = name.slice(prefix.length);
      if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
    }
    if (node.children) for (const child of node.children) stack.push(child);
  }
  return `${base} ${max + 1}`;
}

/** Names of the children of `parentId`. */
export const childNames = (doc: DesignDocument, parentId: NodeId): string[] =>
  childrenOf(doc, parentId).map(id => doc.nodes[id]?.name).filter((name): name is string => typeof name === 'string');
