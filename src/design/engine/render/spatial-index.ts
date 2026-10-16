import type {DesignDocument, Matrix, NodeId, SceneNode} from '../../../../shared/design/types';
import {CONTAINER_TYPES} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import {IDENTITY, transformRect} from '../../../../shared/design/geometry';
import {blurReach, clipsChildren, expandWorldByEffects, localRenderBounds, strokeOutsets} from '../../../../shared/design/bounds';
import type {TextMeasurer} from '../../../../shared/design/text-layout';
import {layoutText} from '../../../../shared/design/text-layout';
import {hidesContents, sameLook, worldOf, worldOfNode} from './painter';
import type {SceneIndex} from './types';

// A uniform-grid spatial index of one page: every node at every depth with the page-space bounds
// of what its subtree paints (shared/design/bounds.ts semantics). The tile renderer culls with it,
// hit testing and marquee selection query it, and `sync` keeps it current from one immutable
// document to the next by comparing node objects, so an edit costs work proportional to what it
// touched (plus one pass of identity checks), never a rebuild.
//
// `sync` also answers which page areas look different now (`dirty`): a node's old and new bounds
// when it moved or changed how it looks, nothing for nodes that only shifted inside a group that
// refitted around them (same world matrix, same look).
//
// Built lazily by page root: a rebuild works out every node's bounds, but
// the subtree of a top-level root that clips its content stays out of the grid (and out of `seen`)
// until a query meets the area its nodes cover, an edit touches it, or an idle slice comes
// (`completeSome`). Every answer — bounds, mask flags, queries, the background blur's reach — equals
// a whole build's; what waits is the grid's bookkeeping, about half of a rebuild.

const CELL = 256;
/** Items covering more cells than this live in a list every query checks instead of the grid. */
const BIG_CELLS = 64;
const OFFSET = 1 << 20;
const cellKey = (cx: number, cy: number) => (cx + OFFSET) * 2097152 + (cy + OFFSET);

type Entry = {rect: Rect | null; keys: number[] | null};

const isContainer = (node: SceneNode) => CONTAINER_TYPES.includes(node.type) && node.type !== 'BOOLEAN_OPERATION';
const hasEffects = (node: SceneNode) => node.effects.some(effect => effect.visible !== false);
const sameMatrix = (m: Matrix, n: Matrix) =>
  m === n || (Math.abs(m[0][0] - n[0][0]) < 1e-9 && Math.abs(m[0][1] - n[0][1]) < 1e-9 && Math.abs(m[0][2] - n[0][2]) < 1e-7 && Math.abs(m[1][0] - n[1][0]) < 1e-9 && Math.abs(m[1][1] - n[1][1]) < 1e-9 && Math.abs(m[1][2] - n[1][2]) < 1e-7);

const sameRect = (a: Rect | null, b: Rect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/** Local fields that move a node's children. */
const movesChildren = (a: SceneNode, b: SceneNode) =>
  a.x !== b.x || a.y !== b.y || a.rotation !== b.rotation || !!a.flipX !== !!b.flipX || !!a.flipY !== !!b.flipY || ((a.flipX || a.flipY) && (a.width !== b.width || a.height !== b.height));

/** `doc` differs from `from` only in these node ids (what the store's patches since `from` touched).
 *  With it a sync costs what changed instead of one identity check per node of the file. */
export type ChangeHint = {from: DesignDocument; ids: Iterable<NodeId>};

/** A page-space area that looks different, and the node whose change caused it. */
export type DirtyArea = {id: NodeId; rect: Rect};

export type IndexSync = {
  /** Areas that look different between the two documents. */
  dirty: DirtyArea[];
  /** The index was rebuilt (another page, first document): treat everything as changed. */
  rebuilt: boolean;
};

export class SpatialIndex implements SceneIndex {
  private doc: DesignDocument | null = null;
  private pageId: NodeId | null = null;
  private revision: number | undefined;
  private readonly entries = new Map<NodeId, Entry>();
  private readonly grid = new Map<number, Set<NodeId>>();
  private readonly big = new Set<NodeId>();
  private readonly masks = new Set<NodeId>();
  private measurer: TextMeasurer | undefined;
  /** Largest background blur on the page: a change under it reaches this much further. */
  private backgroundReach = 0;
  /** Keys of `doc.nodes` (all pages), or -1 when unknown. */
  private keyCount = -1;
  /** The node objects as of the last sync. A drag's documents share one node table that each frame
   *  rewrites (TransactionScratch in shared/design/transaction.ts), so the previous document's
   *  `nodes` may already hold the new objects: changes are found against this copy instead. */
  private readonly seen = new Map<NodeId, SceneNode>();
  /** Top-level roots whose subtrees are not in the grid yet (their own entries are): every node's bounds as a whole
   *  build computes them, and the area they cover together (a clipped child may lie outside the root's box). */
  private readonly lazy = new Map<NodeId, {rects: Map<NodeId, Rect | null>; extent: Rect | null; text: boolean}>();

  /** The background slice `completeLater` asked for (its cancel). */
  private later: (() => void) | null = null;

  /** `eager`: every subtree is indexed on a rebuild (the tests' reference). */
  constructor(private readonly options: {eager?: boolean} = {}) {}

  get document() { return this.doc; }
  /** Top-level roots not indexed yet. */
  get unindexed() { return this.lazy.size; }
  get page() { return this.pageId; }
  /** Page px the largest background blur on the page reads around itself (tiles raster with this margin). */
  get blurMargin() { return this.backgroundReach; }

  bounds(id: NodeId): Rect | undefined {
    const entry = this.entries.get(id);
    if (entry || !this.lazy.size) return entry?.rect ?? undefined;
    const root = this.lazyRootOf(this.doc, id);
    return root === null ? undefined : (this.lazy.get(root)!.rects.get(id) ?? undefined);
  }

  hasMask(id: NodeId): boolean {
    return this.masks.has(id);
  }

  /** Indexes up to `deadline()` reaches zero (at least one root): the roots not indexed yet, in page order. True when
   *  none is left. */
  completeSome(deadline: () => number): boolean {
    for (const id of this.lazy.keys()) {
      this.indexRoot(id);
      if (deadline() <= 0) break;
    }
    return !this.lazy.size;
  }

  /** Indexes the waiting roots in background slices of `sliceMs` (after input and frames), until none is left or
   *  `stopLater`. A query never waits for them: it indexes what it meets itself. */
  completeLater(sliceMs = 4): void {
    if (!this.lazy.size || this.later) return;
    this.later = whenFree(() => {
      this.later = null;
      const end = performance.now() + sliceMs;
      if (!this.completeSome(() => end - performance.now())) this.completeLater(sliceMs);
    });
  }

  stopLater(): void {
    this.later?.();
    this.later = null;
  }

  /** Indexes every root not indexed yet. */
  complete(): void {
    for (const id of [...this.lazy.keys()]) this.indexRoot(id);
  }

  /** Ids (any depth) whose painted bounds meet `rect`, in no particular order. */
  query(rect: Rect): NodeId[] {
    if (this.lazy.size) for (const [id, root] of [...this.lazy]) if (root.extent && meets(root.extent, rect)) this.indexRoot(id);
    const out = new Set<NodeId>();
    const x0 = Math.floor(rect.x / CELL), y0 = Math.floor(rect.y / CELL);
    const x1 = Math.floor((rect.x + rect.width) / CELL), y1 = Math.floor((rect.y + rect.height) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.entries.size * 2) {
      // A view far larger than the content: checking every entry is cheaper than every cell.
      for (const [id, entry] of this.entries) if (entry.rect && meets(entry.rect, rect)) out.add(id);
      return [...out];
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.grid.get(cellKey(cx, cy));
        if (!cell) continue;
        for (const id of cell) if (!out.has(id) && meets(this.entries.get(id)!.rect!, rect)) out.add(id);
      }
    }
    for (const id of this.big) if (meets(this.entries.get(id)!.rect!, rect)) out.add(id);
    return [...out];
  }

  /** Ids whose painted bounds contain the point (candidates for hit testing). */
  queryPoint(x: number, y: number): NodeId[] {
    return this.query({x, y, width: 0, height: 0});
  }

  /** Brings the index to `doc`'s page `pageId`; `measurer` sizes text that overflows its box. */
  sync(doc: DesignDocument, pageId: NodeId, measurer?: TextMeasurer, hint?: ChangeHint): IndexSync {
    if (doc === this.doc && pageId === this.pageId && measurer === this.measurer && measurer?.revision === this.revision) return {dirty: [], rebuilt: false};
    const prev = this.doc;
    if (!prev || pageId !== this.pageId || !doc.nodes[pageId] || measurer !== this.measurer) {
      this.rebuild(doc, pageId, measurer);
      return {dirty: [], rebuilt: true};
    }
    const fontsChanged = measurer?.revision !== this.revision;
    this.doc = doc;
    this.revision = measurer?.revision;
    return this.update(prev, doc, fontsChanged, hint);
  }

  private rebuild(doc: DesignDocument, pageId: NodeId, measurer?: TextMeasurer): void {
    this.doc = doc;
    this.pageId = pageId;
    this.measurer = measurer;
    this.revision = measurer?.revision;
    this.entries.clear();
    this.grid.clear();
    this.big.clear();
    this.masks.clear();
    this.keyCount = -1;
    this.backgroundReach = 0;
    this.seen.clear();
    this.lazy.clear();
    const page = doc.nodes[pageId];
    if (!page) return;
    this.seen.set(pageId, page);
    for (const id of page.children ?? []) {
      const root = doc.nodes[id];
      if (!root) continue;
      if (!this.options.eager && root.children?.length && isContainer(root) && clipsChildren(root)) {
        // Its subtree's bounds are worked out now; the grid waits for a query that meets them, an edit or an idle slice.
        this.seen.set(id, root);
        const pending = this.measureRoot(doc, root);
        this.store(id, pending.rects.get(id) ?? null);
        this.lazy.set(id, pending);
      } else this.visit(doc, root);
    }
    this.refreshMask(doc, page);
  }

  /** Indexes `node`'s subtree from `doc` (children before parents) and records its node objects as seen. */
  private visit(doc: DesignDocument, node: SceneNode): Rect | null {
    this.seen.set(node.id, node);
    for (const childId of node.children ?? []) {
      const child = doc.nodes[childId];
      if (child) this.visit(doc, child);
    }
    if (node.children) this.refreshMask(doc, node);
    return this.compute(doc, node);
  }

  /** A root's subtree measured as `visit` would (bounds, mask flags, the blur's reach), its bounds kept aside. */
  private measureRoot(doc: DesignDocument, root: SceneNode): {rects: Map<NodeId, Rect | null>; extent: Rect | null; text: boolean} {
    const rects = new Map<NodeId, Rect | null>();
    let text = false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const measure = (node: SceneNode) => {
      for (const childId of node.children ?? []) {
        const child = doc.nodes[childId];
        if (child) measure(child);
      }
      if (node.children) this.refreshMask(doc, node);
      if (node.type === 'TEXT') text = true;
      const rect = this.rectOf(doc, node, id => rects.get(id));
      rects.set(node.id, rect);
      if (rect && Number.isFinite(rect.x + rect.y + rect.width + rect.height)) {
        if (rect.x < minX) minX = rect.x;
        if (rect.y < minY) minY = rect.y;
        if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
        if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
      }
    };
    measure(root);
    return {rects, extent: minX <= maxX ? {x: minX, y: minY, width: maxX - minX, height: maxY - minY} : null, text};
  }

  /** Puts a root's measured subtree into the grid: the nodes of `doc` (the document it was measured on). */
  private indexRoot(id: NodeId, doc = this.doc!): void {
    const pending = this.lazy.get(id);
    if (!pending) return;
    this.lazy.delete(id);
    const stack: NodeId[] = [id];
    while (stack.length) {
      const each = stack.pop()!;
      const node = doc.nodes[each];
      if (!node) continue;
      this.seen.set(each, node);
      this.store(each, pending.rects.get(each) ?? null);
      if (node.children) for (const child of node.children) stack.push(child);
    }
  }

  /** The root not indexed yet that holds `id` (or is it) in `doc`, else null. */
  private lazyRootOf(doc: DesignDocument | null, id: NodeId): NodeId | null {
    if (!doc) return null;
    let node: SceneNode | undefined = doc.nodes[id];
    for (let depth = 0; node && depth < 10_000; depth++) {
      if (node.parentId === this.pageId) return this.lazy.has(node.id) ? node.id : null;
      node = node.parentId ? doc.nodes[node.parentId] : undefined;
    }
    return null;
  }

  private update(prev: DesignDocument, next: DesignDocument, fontsChanged: boolean, hint?: ChangeHint): IndexSync {
    const pageId = this.pageId!;
    const dirty: DirtyArea[] = [];
    const mark = (id: NodeId, rect: Rect | null | undefined) => {
      if (rect) dirty.push({id, rect});
    };
    const changed: NodeId[] = [];
    this.diff(prev, next, hint, changed);
    // A drag lends its transactions one node table frame after frame (shared/design/transaction.ts
    // `createScratch`): two documents of the same gesture then share it and `prev` already shows the
    // new nodes. Changes are found against `seen`; the reported ids are recomputed with their subtrees
    // and, the old world matrices being unknown, their old (indexed) and new areas marked.
    const shared = prev.nodes === next.nodes;
    // A change inside a root still waiting: the root goes into the grid as it was measured (the nodes of the document
    // before), and the change is then taken as for any indexed node. With a shared table the document before already
    // holds the new nodes: those changed are taken as new ones (their measured area and their new one repainted).
    const unknownOld = new Set<NodeId>();
    if (this.lazy.size) {
      const touched = new Set<NodeId>();
      for (const id of changed) {
        const root = this.lazyRootOf(next, id) ?? this.lazyRootOf(prev, id);
        if (!root) continue;
        touched.add(root);
        if (shared) unknownOld.add(id);
      }
      for (const id of touched) this.indexRoot(id, prev);
      // A face that arrived: the roots still waiting are measured again (their text paints inside their boxes).
      if (fontsChanged) for (const [id, pending] of [...this.lazy]) {
        if (!pending.text) continue;
        const root = next.nodes[id];
        if (!root) continue;
        this.lazy.set(id, this.measureRoot(next, root));
        mark(id, this.entries.get(id)?.rect);
      }
    }
    // A face that arrived re-measures every text: same node objects, new widths.
    const remeasured = new Set<NodeId>();
    if (fontsChanged) {
      for (const [id] of this.entries) {
        if (next.nodes[id]?.type === 'TEXT' && this.seen.get(id) === next.nodes[id]) {
          remeasured.add(id);
          changed.push(id);
        }
      }
    }
    // What the loops below compare against, then the new objects become the ones seen.
    const olds = new Map<NodeId, SceneNode | undefined>();
    for (const id of changed) {
      if (olds.has(id)) continue;
      olds.set(id, unknownOld.has(id) ? undefined : this.seen.get(id));
      const node = next.nodes[id];
      if (node) this.seen.set(id, node);
      else this.seen.delete(id);
    }
    const oldOf = (id: NodeId) => (olds.has(id) ? olds.get(id) : this.seen.get(id));
    const recompute = new Set<NodeId>();
    /** Containers whose unchanged subtree only slid along with them (see `slid`). */
    const slidRoots = new Set<NodeId>();
    const changedSet = changed.length > 8 ? new Set(changed) : null;
    const isChanged = (id: NodeId) => (changedSet ? changedSet.has(id) : changed.includes(id));
    const touchedParents = new Set<NodeId>();
    // Containers whose mask flag is re-read once at the end: re-reading a parent's children for each
    // of its new children would cost children² when thousands are pasted into one frame.
    const maskParents = new Set<NodeId>();
    const onPage = (id: NodeId) => {
      let node: SceneNode | undefined = next.nodes[id];
      while (node && node.type !== 'PAGE') node = node.parentId ? next.nodes[node.parentId] : undefined;
      return node?.id === pageId;
    };
    for (const id of changed) {
      const before = oldOf(id), after = next.nodes[id];
      if (before?.type === 'PAGE' || after?.type === 'PAGE') {
        if (id === pageId && after?.children !== before?.children) {
          if (after) this.refreshMask(next, after);
          if (before?.children && after?.children) dirty.push(...this.reordered(before.children, after.children));
        }
        continue;
      }
      if (!after || !onPage(id)) {
        const entry = this.entries.get(id);
        if (entry) {
          mark(id, entry.rect);
          this.remove(id);
          if (before?.parentId) touchedParents.add(before.parentId);
        }
        continue;
      }
      recompute.add(id);
      if (before?.parentId && before.parentId !== after.parentId) touchedParents.add(before.parentId);
      if (after.children && (shared || (before && movesChildren(before, after)))) {
        // A container that only slid (nudged or dragged): its untouched subtree moves by the same
        // offset, so the descendants' bounds shift instead of being recomputed one world matrix each.
        if (before && this.slid(prev, before, next, after, shared, isChanged)) slidRoots.add(id);
        else this.collectDescendants(next, after, recompute);
      }
      if (after.parentId && (!before || before.isMask !== after.isMask || before.parentId !== after.parentId)) maskParents.add(after.parentId);
      if (after.children && before?.children !== after.children) {
        this.refreshMask(next, after);
        if (before?.children) dirty.push(...this.reordered(before.children, after.children));
      }
    }
    for (const id of maskParents) {
      const parent = next.nodes[id];
      if (parent) this.refreshMask(next, parent);
    }
    if (!recompute.size && !touchedParents.size) return {dirty: this.reach(dirty), rebuilt: false};

    // Every ancestor's union may have moved: recompute children before parents.
    const parentOf = (node: SceneNode | undefined) => (node?.parentId ? next.nodes[node.parentId] : undefined);
    const ancestors = new Set<NodeId>();
    const addChain = (start: SceneNode | undefined) => {
      for (let node = start; node && node.type !== 'PAGE'; node = parentOf(node)) {
        if (ancestors.has(node.id)) break;
        ancestors.add(node.id);
      }
    };
    for (const id of recompute) addChain(parentOf(next.nodes[id]));
    for (const id of touchedParents) addChain(next.nodes[id]);
    // Depths are worked out once per id (a comparator that walked the chain cost n·log n walks).
    const depths = new Map<NodeId, number>();
    const depth = (id: NodeId): number => {
      let d = depths.get(id);
      if (d !== undefined) return d;
      const parentId = next.nodes[id]?.parentId;
      d = parentId ? depth(parentId) + 1 : 0;
      depths.set(id, d);
      return d;
    };
    const order = [...new Set([...recompute, ...ancestors])];
    for (const id of order) depth(id);
    order.sort((a, b) => depths.get(b)! - depths.get(a)!);
    const beforeRects = new Map<NodeId, Rect | null>();
    const dirtyNodes: NodeId[] = [];
    for (const id of order) {
      const node = next.nodes[id];
      const before = this.entries.get(id)?.rect ?? null;
      beforeRects.set(id, before);
      const after = this.compute(next, node);
      if (!recompute.has(id)) continue;
      if (slidRoots.has(id)) {
        // Its subtree slid with it: the area it covered and the area it covers now.
        dirtyNodes.push(id);
        mark(id, before);
        mark(id, after);
        continue;
      }
      const old = oldOf(id);
      if (!old || remeasured.has(id)) {
        mark(id, before);
        mark(id, after);
        dirtyNodes.push(id);
        continue;
      }
      // With a rewritten table the old world matrix is unknown: count it as moved (repaint old and new).
      const moved = shared || !sameRect(before, after) || !sameMatrix(worldOfNode(prev, old), worldOfNode(next, node));
      const looks = sameLook(old, node);
      if (!moved && looks) continue;
      dirtyNodes.push(id);
      if (!looks || shared || !isContainer(node) || clipsChildren(node) || hasEffects(node)) {
        mark(id, before);
        mark(id, after);
      } else if (node.type !== 'GROUP') {
        // A container that only moved repaints its own box; descendants that moved report themselves.
        mark(id, transformRect(worldOfNode(prev, old), localRenderBounds(old)));
        mark(id, transformRect(worldOfNode(next, node), localRenderBounds(node)));
      }
    }
    // Containers whose effects come from their content (a group's shadow) change with any descendant.
    const effectful = new Set<NodeId>();
    for (const id of dirtyNodes) {
      for (let node = parentOf(next.nodes[id]); node && node.type !== 'PAGE'; node = parentOf(node)) {
        if (!hasEffects(node) || effectful.has(node.id)) continue;
        effectful.add(node.id);
        const before = beforeRects.has(node.id) ? beforeRects.get(node.id) : this.entries.get(node.id)?.rect;
        const after = this.entries.get(node.id)?.rect;
        mark(node.id, before);
        mark(node.id, after);
      }
    }
    return {dirty: this.reach(dirty), rebuilt: false};
  }

  /** Node ids whose objects differ between the documents (added and removed ones included). */
  private diff(prev: DesignDocument, next: DesignDocument, hint: ChangeHint | undefined, out: NodeId[]): void {
    // Compared with the objects seen at the last sync, not `prev.nodes` (see `seen`).
    if (hint && hint.from === prev) {
      const visited = new Set<NodeId>();
      for (const id of hint.ids) {
        if (visited.has(id)) continue;
        visited.add(id);
        const before = this.seen.has(id), after = id in next.nodes;
        // (An id never seen may be one of a waiting root's, removed now: `update` finds out.)
        if (this.seen.get(id) !== next.nodes[id] || (!before && this.lazy.size)) out.push(id);
        if (this.keyCount >= 0) this.keyCount += (after ? 1 : 0) - (before ? 1 : 0);
      }
      return;
    }
    // Without a hint every root not indexed yet is indexed first (marked as changed: what it painted is not known).
    if (this.lazy.size) for (const id of this.lazy.keys()) out.push(id);
    // One pass over the new document; the old one is walked only when something was removed
    // (fewer of its keys survived than it had).
    let count = 0, kept = 0;
    for (const id in next.nodes) {
      count++;
      const before = this.seen.get(id);
      if (before !== undefined) kept++;
      if (before !== next.nodes[id]) out.push(id);
    }
    if (kept !== this.seen.size) for (const id of this.seen.keys()) if (!(id in next.nodes)) out.push(id);
    this.keyCount = count;
  }

  /** Grows dirty areas by the page's largest background blur, which smears a change sideways. */
  private reach(dirty: DirtyArea[]): DirtyArea[] {
    if (!this.backgroundReach) return dirty;
    const r = this.backgroundReach;
    return dirty.map(({id, rect}) => ({id, rect: {x: rect.x - r, y: rect.y - r, width: rect.width + 2 * r, height: rect.height + 2 * r}}));
  }

  /** Bounds of children whose order relative to each other changed. */
  private reordered(before: readonly NodeId[], after: readonly NodeId[]): DirtyArea[] {
    const kept = new Set(after);
    const was = before.filter(id => kept.has(id));
    const present = new Set(was);
    const now = after.filter(id => present.has(id));
    let first = 0, last = was.length - 1;
    while (first <= last && was[first] === now[first]) first++;
    while (last >= first && was[last] === now[last]) last--;
    const out: DirtyArea[] = [];
    for (let i = first; i <= last; i++) {
      const rect = this.entries.get(now[i])?.rect;
      if (rect) out.push({id: now[i], rect});
    }
    return out;
  }

  /** When the container `after` only slid since `before` (its world matrix moved by a translation)
   *  and nothing under it changed, shifts its descendants' bounds by that offset and returns true.
   *  With a shared table (a drag) the old world matrix is known only while no ancestor changed. */
  private slid(prev: DesignDocument, before: SceneNode, next: DesignDocument, after: SceneNode, shared: boolean, isChanged: (id: NodeId) => boolean): boolean {
    let was: Matrix;
    if (shared) {
      // The old world matrix is the old object under its old parent: a node moved to another parent (in place every commit
      // shares the table, so this is any reparenting, not only a drag's) did not slide; its subtree is recomputed.
      if (before.parentId !== after.parentId) return false;
      const parent = after.parentId ? next.nodes[after.parentId] : undefined;
      for (let node = parent; node && node.type !== 'PAGE'; node = node.parentId ? next.nodes[node.parentId] : undefined) if (isChanged(node.id)) return false;
      was = worldOf(before, parent ? worldOfNode(next, parent) : IDENTITY);
    } else was = worldOfNode(prev, before);
    const now = worldOfNode(next, after);
    const linear = (m: Matrix, n: Matrix) => Math.abs(m[0][0] - n[0][0]) < 1e-12 && Math.abs(m[0][1] - n[0][1]) < 1e-12 && Math.abs(m[1][0] - n[1][0]) < 1e-12 && Math.abs(m[1][1] - n[1][1]) < 1e-12;
    if (!linear(was, now)) return false;
    const dx = now[0][2] - was[0][2], dy = now[1][2] - was[1][2];
    if (!Number.isFinite(dx + dy)) return false;
    const subtree: NodeId[] = [];
    const stack = [...(after.children ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      const node = next.nodes[id];
      if (!node) continue;
      if (isChanged(id) || this.seen.get(id) !== node) return false;
      subtree.push(id);
      if (node.children) for (const child of node.children) stack.push(child);
    }
    for (const id of subtree) {
      const rect = this.entries.get(id)?.rect;
      if (rect) this.store(id, {x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height});
    }
    return true;
  }

  private collectDescendants(doc: DesignDocument, node: SceneNode, into: Set<NodeId>): void {
    for (const childId of node.children ?? []) {
      const child = doc.nodes[childId];
      if (!child) continue;
      into.add(childId);
      this.collectDescendants(doc, child, into);
    }
  }

  private refreshMask(doc: DesignDocument, container: SceneNode): void {
    if (container.children?.some(id => doc.nodes[id]?.isMask)) this.masks.add(container.id);
    else this.masks.delete(container.id);
  }

  /** Computes and stores a node's subtree bounds from its children's entries. */
  private compute(doc: DesignDocument, node: SceneNode): Rect | null {
    const rect = this.rectOf(doc, node, id => this.entries.get(id)?.rect);
    this.store(node.id, rect);
    return rect;
  }

  /** A node's subtree bounds from its children's (`childRect`); notes its background blur's reach. */
  private rectOf(doc: DesignDocument, node: SceneNode, childRect: (id: NodeId) => Rect | null | undefined): Rect | null {
    const world = worldOfNode(doc, node);
    let rect: Rect | null;
    if (node.type === 'SLICE') rect = null;
    else if (!isContainer(node) || clipsChildren(node)) {
      // Most nodes are a plain box (no stroke, no effects, not text): skip the general bounds maths.
      const plain = node.type !== 'TEXT' && !node.effects.length && !(node.strokeWeight > 0 && node.strokes.length);
      rect = plain ? boxBounds(world, node.width, node.height) : transformRect(world, localRenderBounds(node, node.type === 'TEXT' && this.measurer ? layoutText(node, this.measurer) : undefined));
    } else {
      if (node.type === 'GROUP') rect = null;
      else {
        const out = strokeOutsets(node);
        rect = transformRect(world, {x: -out.left, y: -out.top, width: Math.max(0, node.width) + out.left + out.right, height: Math.max(0, node.height) + out.top + out.bottom});
      }
      let minX = rect ? rect.x : Infinity, minY = rect ? rect.y : Infinity;
      let maxX = rect ? rect.x + rect.width : -Infinity, maxY = rect ? rect.y + rect.height : -Infinity;
      for (const childId of hidesContents(node) ? [] : node.children ?? []) {
        const child = doc.nodes[childId];
        if (!child || child.visible === false) continue;
        const r = childRect(childId);
        if (!r) continue;
        if (r.x < minX) minX = r.x;
        if (r.y < minY) minY = r.y;
        if (r.x + r.width > maxX) maxX = r.x + r.width;
        if (r.y + r.height > maxY) maxY = r.y + r.height;
      }
      rect = minX <= maxX ? {x: minX, y: minY, width: maxX - minX, height: maxY - minY} : null;
      if (rect && node.effects.length) rect = expandWorldByEffects(rect, node, world);
    }
    for (const effect of node.effects) {
      if (effect.type === 'BACKGROUND_BLUR' && effect.visible !== false) this.backgroundReach = Math.max(this.backgroundReach, blurReach(effect.radius));
    }
    return rect;
  }

  private store(id: NodeId, rect: Rect | null): void {
    const old = this.entries.get(id);
    if (old?.rect && rect && old.rect.x === rect.x && old.rect.y === rect.y && old.rect.width === rect.width && old.rect.height === rect.height) return;
    // Still in the same cells (a nudge by a few px, a small resize): only the bounds change.
    if (old?.rect && rect && Number.isFinite(rect.x + rect.y + rect.width + rect.height)
      && Math.floor(old.rect.x / CELL) === Math.floor(rect.x / CELL) && Math.floor(old.rect.y / CELL) === Math.floor(rect.y / CELL)
      && Math.floor((old.rect.x + old.rect.width) / CELL) === Math.floor((rect.x + rect.width) / CELL)
      && Math.floor((old.rect.y + old.rect.height) / CELL) === Math.floor((rect.y + rect.height) / CELL)) {
      old.rect = rect;
      return;
    }
    this.unlink(id, old);
    const entry: Entry = {rect, keys: null};
    if (rect && Number.isFinite(rect.x + rect.y + rect.width + rect.height)) {
      const x0 = Math.floor(rect.x / CELL), y0 = Math.floor(rect.y / CELL);
      const x1 = Math.floor((rect.x + rect.width) / CELL), y1 = Math.floor((rect.y + rect.height) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > BIG_CELLS) this.big.add(id);
      else {
        entry.keys = [];
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const key = cellKey(cx, cy);
            let cell = this.grid.get(key);
            if (!cell) this.grid.set(key, (cell = new Set()));
            cell.add(id);
            entry.keys.push(key);
          }
        }
      }
    } else entry.rect = null;
    this.entries.set(id, entry);
  }

  private unlink(id: NodeId, entry: Entry | undefined): void {
    if (!entry) return;
    this.big.delete(id);
    for (const key of entry.keys ?? []) {
      const cell = this.grid.get(key);
      if (!cell) continue;
      cell.delete(id);
      if (!cell.size) this.grid.delete(key);
    }
  }

  private remove(id: NodeId): void {
    this.unlink(id, this.entries.get(id));
    this.entries.delete(id);
    this.masks.delete(id);
  }
}

/** Background work: a `scheduler.postTask` task of background priority (after input and frames), a timer elsewhere. */
function whenFree(work: () => void): () => void {
  const scheduler = (globalThis as {scheduler?: {postTask?: (task: () => void, options: {priority: 'background'; signal: AbortSignal}) => Promise<unknown>}}).scheduler;
  if (typeof scheduler?.postTask === 'function') {
    const controller = new AbortController();
    scheduler.postTask(work, {priority: 'background', signal: controller.signal}).catch(() => {});
    return () => controller.abort();
  }
  const timer = setTimeout(work, 0);
  (timer as unknown as {unref?: () => void}).unref?.();
  return () => clearTimeout(timer);
}

/** Page-space bounds of a node's box under its world matrix, without intermediate arrays. */
function boxBounds(m: Matrix, width: number, height: number): Rect {
  const w = Math.max(0, width), h = Math.max(0, height);
  const ax = m[0][0] * w, cx = m[0][1] * h, by = m[1][0] * w, dy = m[1][1] * h;
  const minX = m[0][2] + Math.min(0, ax) + Math.min(0, cx), maxX = m[0][2] + Math.max(0, ax) + Math.max(0, cx);
  const minY = m[1][2] + Math.min(0, by) + Math.min(0, dy), maxY = m[1][2] + Math.max(0, by) + Math.max(0, dy);
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

const meets = (a: Rect, b: Rect) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
