import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../../../shared/design/types';

// The rows of the layers panel, outside React. A page's tree is flattened into two parallel arrays
// (ids and depths, top-most layer first, the reverse of the model's bottom-to-top children) holding
// only what is visible: the page's children and the subtrees of expanded containers.
//
// Files hold 20 000 layers, so nothing here walks the page on an ordinary change. The model remembers
// the `children` array of every container whose rows it materialized; documents are immutable and a
// transaction copies a children list only when it changes it, so a moved, renamed or recoloured layer
// leaves every remembered list identical and costs one identity check per expanded container. When a
// list did change, only that container's segment of rows is flattened again and spliced in.

export const ROW_HEIGHT = 32;
export const INDENT = 16;

export type RowSpan = {readonly ids: readonly NodeId[]; readonly depths: readonly number[]};

/** A layer the panel lets you drop others into: any container but pages, instances and copies inside an instance. */
export const acceptsChildren = (node: SceneNode | undefined): boolean =>
  !!node && !!node.children && node.type !== 'PAGE' && node.type !== 'INSTANCE' && node.mainId === undefined;

/** Whether the row has a caret (a container with something in it). */
export const hasChildRows = (node: SceneNode | undefined): boolean => !!node?.children?.length;

export class LayerRows implements RowSpan {
  ids: NodeId[] = [];
  depths: number[] = [];
  /** Bumped on every change of `ids`/`depths`. */
  version = 0;
  /** Container → the `children` array its rows were built from (the page and expanded containers). */
  private seen = new Map<NodeId, readonly NodeId[] | undefined>();
  private index: Map<NodeId, number> | null = null;

  constructor(public doc: DesignDocument, readonly pageId: NodeId, readonly expanded: Set<NodeId> = new Set()) {
    this.rebuild();
  }

  get length() {
    return this.ids.length;
  }

  /** Row index of a node, or -1 when it is not shown (collapsed ancestor, another page, gone). */
  rowOf(id: NodeId): number {
    if (!this.index) {
      this.index = new Map();
      for (let i = 0; i < this.ids.length; i++) this.index.set(this.ids[i], i);
    }
    return this.index.get(id) ?? -1;
  }

  /** Follows a new document. Returns whether the rows changed. */
  update(doc: DesignDocument): boolean {
    const previous = this.doc;
    this.doc = doc;
    // Never "same table, so nothing changed": the store may write its table in place; what changed
    // is found below against the children lists seen last.
    if (doc === previous) return false;
    if (!doc.nodes[this.pageId]) {
      const had = this.ids.length > 0;
      this.ids = [];
      this.depths = [];
      this.seen.clear();
      this.changed();
      return had;
    }
    const stale: NodeId[] = [];
    for (const [id, children] of this.seen) if (doc.nodes[id]?.children !== children) stale.push(id);
    if (!stale.length) return false;
    if (stale.includes(this.pageId)) {
      this.rebuild();
      return true;
    }
    // Rebuild the outermost changed containers that are on screen; a changed container inside one of
    // them is rebuilt with it.
    const shown = new Set(stale.filter(id => doc.nodes[id] && this.rowOf(id) >= 0));
    let changed = false;
    for (const id of stale) {
      if (!shown.has(id)) {
        this.seen.delete(id);
        continue;
      }
      if (this.hasAncestorIn(id, shown)) continue;
      const at = this.rowOf(id);
      if (at < 0) continue;
      this.replaceSegment(at);
      changed = true;
    }
    return changed;
  }

  /** Expands or collapses a container. `deep` (⌥-click) does the same to every container inside it. */
  setExpanded(id: NodeId, open: boolean, deep = false): boolean {
    const node = this.doc.nodes[id];
    if (!node?.children) return false;
    const before = this.expanded.has(id);
    if (open) {
      this.expanded.add(id);
      if (deep) this.forEachContainer(id, inner => void this.expanded.add(inner));
    } else {
      this.expanded.delete(id);
      if (deep) this.forEachContainer(id, inner => void this.expanded.delete(inner));
    }
    if (before === open && !deep) return false;
    const at = this.rowOf(id);
    if (at < 0) return false;
    if (!open) this.forgetSegment(at);
    this.replaceSegment(at);
    return true;
  }

  /** Expands the ancestors of the nodes so their rows exist. Returns whether rows were added. */
  reveal(ids: Iterable<NodeId>): boolean {
    const opened: {id: NodeId; depth: number}[] = [];
    for (const id of ids) {
      const chain: NodeId[] = [];
      for (let node: SceneNode | undefined = this.doc.nodes[this.doc.nodes[id]?.parentId ?? '']; node && node.type !== 'PAGE'; node = node.parentId ? this.doc.nodes[node.parentId] : undefined) chain.push(node.id);
      if (!chain.length) continue;
      const top = this.doc.nodes[chain[chain.length - 1]]?.parentId;
      if (top !== this.pageId) continue;
      for (let i = 0; i < chain.length; i++) {
        if (this.expanded.has(chain[i])) continue;
        this.expanded.add(chain[i]);
        opened.push({id: chain[i], depth: chain.length - 1 - i});
      }
    }
    if (!opened.length) return false;
    opened.sort((a, b) => a.depth - b.depth);
    const done = new Set<NodeId>();
    let changed = false;
    for (const {id} of opened) {
      if (this.hasAncestorIn(id, done)) continue;
      const at = this.rowOf(id);
      if (at < 0) continue;
      this.replaceSegment(at);
      done.add(id);
      changed = true;
    }
    return changed;
  }

  /** "Collapse all layers". */
  collapseAll(): boolean {
    if (!this.expanded.size) return false;
    this.expanded.clear();
    this.rebuild();
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  private changed() {
    this.index = null;
    this.version++;
  }

  private rebuild() {
    this.seen.clear();
    const ids: NodeId[] = [];
    const depths: number[] = [];
    if (this.doc.nodes[this.pageId]) this.flatten(this.pageId, -1, ids, depths);
    this.ids = ids;
    this.depths = depths;
    this.changed();
  }

  /** Appends the visible rows under `rootId` (top-most first) and remembers the lists they came from. */
  private flatten(rootId: NodeId, rootDepth: number, ids: NodeId[], depths: number[]) {
    const nodes = this.doc.nodes;
    const root = nodes[rootId];
    if (!root?.children) return;
    if (rootId !== this.pageId && !this.expanded.has(rootId)) return;
    this.seen.set(rootId, root.children);
    // An explicit stack (bottom-most pushed first, so the top-most pops first): nesting can be deep.
    const stack: NodeId[] = [];
    const levels: number[] = [];
    for (const child of root.children) {
      stack.push(child);
      levels.push(rootDepth + 1);
    }
    while (stack.length) {
      const id = stack.pop()!;
      const depth = levels.pop()!;
      const node = nodes[id];
      if (!node) continue;
      ids.push(id);
      depths.push(depth);
      if (node.children && this.expanded.has(id)) {
        this.seen.set(id, node.children);
        for (const child of node.children) {
          stack.push(child);
          levels.push(depth + 1);
        }
      }
    }
  }

  /** Rows after `at` that belong to its subtree end here. */
  private segmentEnd(at: number) {
    const depth = this.depths[at];
    let end = at + 1;
    while (end < this.depths.length && this.depths[end] > depth) end++;
    return end;
  }

  private forgetSegment(at: number) {
    const end = this.segmentEnd(at);
    for (let i = at + 1; i < end; i++) this.seen.delete(this.ids[i]);
  }

  /** Flattens the container at row `at` again and splices its rows in place of the old ones. */
  private replaceSegment(at: number) {
    const id = this.ids[at];
    const depth = this.depths[at];
    const end = this.segmentEnd(at);
    const ids: NodeId[] = [];
    const depths: number[] = [];
    if (!this.expanded.has(id)) this.seen.delete(id);
    this.flatten(id, depth, ids, depths);
    if (!ids.length && end === at + 1) return;
    this.ids = this.ids.slice(0, at + 1).concat(ids, this.ids.slice(end));
    this.depths = this.depths.slice(0, at + 1).concat(depths, this.depths.slice(end));
    this.changed();
  }

  private hasAncestorIn(id: NodeId, set: ReadonlySet<NodeId>): boolean {
    if (!set.size) return false;
    for (let node: SceneNode | undefined = this.doc.nodes[this.doc.nodes[id]?.parentId ?? '']; node; node = node.parentId ? this.doc.nodes[node.parentId] : undefined) {
      if (set.has(node.id)) return true;
    }
    return false;
  }

  private forEachContainer(id: NodeId, visit: (id: NodeId) => void) {
    const stack = [...(this.doc.nodes[id]?.children ?? [])];
    while (stack.length) {
      const node = this.doc.nodes[stack.pop()!];
      if (!node?.children?.length) continue;
      visit(node.id);
      stack.push(...node.children);
    }
  }
}

/** The ids of the rows from `from` to `to` (row indices, either order), inclusive: ⇧-click. */
export function rangeOfRows(rows: RowSpan, from: number, to: number): NodeId[] {
  if (from < 0 || to < 0) return [];
  const start = Math.min(from, to), end = Math.max(from, to);
  return rows.ids.slice(start, end + 1);
}

// ── Search ─────────────────────────────────────────────────────────────────────────────────────

export type LayerKind = 'frame' | 'component' | 'instance' | 'group' | 'text' | 'image' | 'shape';

export const LAYER_KINDS: readonly {id: LayerKind; label: string}[] = [
  {id: 'frame', label: 'Frames'},
  {id: 'component', label: 'Components'},
  {id: 'instance', label: 'Instances'},
  {id: 'group', label: 'Groups'},
  {id: 'text', label: 'Text'},
  {id: 'image', label: 'Images'},
  {id: 'shape', label: 'Shapes'},
];

const SHAPES = new Set<NodeType>(['RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'VECTOR', 'BOOLEAN_OPERATION']);

export function layerKinds(node: SceneNode): LayerKind[] {
  const kinds: LayerKind[] = [];
  if (node.type === 'FRAME' || node.type === 'SECTION') kinds.push('frame');
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') kinds.push('component');
  if (node.type === 'INSTANCE') kinds.push('instance');
  if (node.type === 'GROUP') kinds.push('group');
  if (node.type === 'TEXT') kinds.push('text');
  if (node.fills.some(fill => fill.type === 'IMAGE')) kinds.push('image');
  if (SHAPES.has(node.type) && !kinds.includes('image')) kinds.push('shape');
  return kinds;
}

/** Lower case, with the Cyrillic letter yo folded into ye so that Russian searches match (written as escapes). */
export const foldText = (text: string) => text.toLocaleLowerCase('en').replace(/\u0451/g, '\u0435');

/** Layers of the page whose name contains `query` and whose kind is one of `kinds` (any kind when
 *  empty), in panel order (top-most first, parents before their children). */
export function searchLayers(doc: DesignDocument, pageId: NodeId, query: string, kinds: ReadonlySet<LayerKind> = new Set(), limit = 5000): NodeId[] {
  const needle = foldText(query.trim());
  if (!needle && !kinds.size) return [];
  const out: NodeId[] = [];
  const stack = [...(doc.nodes[pageId]?.children ?? [])];
  while (stack.length && out.length < limit) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    const named = !needle || foldText(node.name).includes(needle);
    if (named && (!kinds.size || layerKinds(node).some(kind => kinds.has(kind)))) out.push(node.id);
    if (node.children) stack.push(...node.children);
  }
  return out;
}

/** "Home › Header": the names of a layer's ancestors below the page. */
export function layerPath(doc: DesignDocument, id: NodeId): string {
  const names: string[] = [];
  for (let node: SceneNode | undefined = doc.nodes[doc.nodes[id]?.parentId ?? '']; node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : undefined) names.push(node.name);
  return names.reverse().join(' › ');
}
