import type {DesignDocument, ImageAsset, ImageRef, Matrix, NodeId, SceneNode, Style, StyleId, Variable, VariableCollection, VariableId, Vec} from './types';
import {CONTAINER_TYPES, LIBRARY_PAGE_ID} from './types';
import {createNode} from './defaults';
import {apply, applyLinear, invert, multiply, normalizeDegrees, rotationMatrix, toRadians, worldMatrix} from './geometry';
import {invertPatch, isEmptyPatch, type DocumentPatch} from './patch';
import {normalizeDetailed, type NormalizeContext} from './normalize';
import {TableLog, attachTableCaches, carryTableCaches, copyTable, deriveTableCachesInPlace, detachTableCaches, forgetTable, loggedView, overlayView, type DetachedCaches} from './table-cache';
import {engineTs, markInFlight, markSettled} from './engine-switch';
import {boxOriginWasm, placementChangesWasm, placementForWasm, viaOps} from './ops-engine';
import {beginOpsTransaction} from './ops-transaction';

// Every change to a design document goes through a transaction (docs/design-tool.md §Changing a
// document). A transaction is copy-on-write: the document it starts from is never touched, the
// tables and nodes it writes are copied once, and `commit` returns the new document with the patch
// that leads to it and the inverse that leads back (undo, autosave and the server all move
// documents with these patches).
//
// Files hold tens of thousands of nodes, and copying a node table that big costs ~10 ms, so a
// commit never diffs or walks the whole document: the table is copied once, normalization writes
// into that same copy and reports the ids it wrote (shared/design/normalize.ts), the patch is built
// from the keys the transaction and normalization touched, children lists drop removed ids in one
// pass per parent, and a drag can lend the transaction a scratch table it reverts and reuses frame
// after frame (`createScratch`), so a drag frame copies nothing at all.
//
// The editor's store may ask for no copy at all (`table: 'in-place'`). While the
// recipe runs, its writes go to an overlay laid over the base's table (`overlayView`): the document
// stays as it is, so a recipe that reads the store's document sees no half-written change, and a recipe
// that throws leaves nothing to undo. At commit the overlay is applied to the base document's own table
// — nodes stay copy-on-write per id — and normalization writes into that table too; the previous
// entry of every id touched is kept in a log (`TableLog`), which gives the inverse, the view of the
// document before that normalization's indexes derive from, and the way back when normalization
// throws. The document before the commit survives only as the inverse: readers that kept it compare
// through the patch, never through the table.

/** How a transaction gets a node table to write: a copy of the base's (the default everywhere but the editor's store),
 *  or the base's own table written in place and logged (`TableLog`). */
export type TableMode = 'copy' | 'in-place';

export type TransactionResult = {
  doc: DesignDocument;
  patch: DocumentPatch;
  inverse: DocumentPatch;
  /** Nodes the transaction touched (and their old and new parents) before normalization widened it. */
  dirty: ReadonlySet<NodeId>;
};

export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionError';
  }
}

/** The fields that place a node in its parent's space. */
export type Placement = {x: number; y: number; rotation: number; flipX: boolean; flipY: boolean};

export interface Transaction {
  /** The document as the transaction has changed it so far. */
  readonly doc: DesignDocument;
  /** The document the transaction started from; never changed. */
  readonly base: DesignDocument;
  get(id: NodeId): SceneNode | undefined;
  /** Shallow merge. A key set to `undefined` is removed from the node. `id`, `parentId` and
   *  `children` change only through create/move/remove; `type` may change between container
   *  types or between leaf types (FRAME → COMPONENT), never to or from PAGE. */
  update(id: NodeId, partial: Partial<SceneNode>): void;
  /** Adds a new node under `parentId` at `index` of its children (bottom-to-top; default top).
   *  A container starts with no children: create them after it. */
  create(node: SceneNode, parentId: NodeId, index?: number): void;
  /** Removes the node and its subtree. Removing a missing node does nothing; a page goes through `removePage`. */
  remove(id: NodeId): void;
  /** Moves a node under another parent. `keepWorld` (default true) recomputes x/y/rotation/flips
   *  so the node stays where it is on screen. Moving into its own subtree, into a leaf or a page into
   *  anything throws. `index` is the position in the new parent's children. */
  move(id: NodeId, parentId: NodeId, index?: number, options?: {keepWorld?: boolean}): void;
  /** Moves a node within its parent's children (or a page within the page list) to `index` of the result. */
  reorder(id: NodeId, index: number): void;
  setStyle(style: Style): void;
  removeStyle(id: StyleId): void;
  setImage(ref: ImageRef, asset: ImageAsset): void;
  removeImage(ref: ImageRef): void;
  /** A new order of the same pages. */
  setPages(order: readonly NodeId[]): void;
  addPage(node: SceneNode, index?: number): void;
  /** Removes a page and everything on it; the last page cannot be removed. */
  removePage(id: NodeId): void;
  /** Adds the hidden page that holds the file's copies of library components (`LIBRARY_PAGE_ID`, shared/design/libraries.ts)
   *  when the file has none. It is never in `pages`; `remove(LIBRARY_PAGE_ID)` takes it and its copies away. */
  addLibraryPage(): void;
  setVariableCollection(collection: VariableCollection): void;
  /** Removes the collection and its variables. */
  removeVariableCollection(id: string): void;
  /** Adds or replaces a variable and keeps its collection's `variableIds` in step. */
  setVariable(variable: Variable): void;
  removeVariable(id: VariableId): void;
  setVariableModes(nodeId: NodeId, modes: Record<string, string> | null): void;
  /** Normalizes the touched part of the document and closes the transaction. */
  commit(context: NormalizeContext): TransactionResult;
  /** Gives the transaction up without a commit (a recipe that threw). In place, the base's table gets its entries back;
   *  with a copy there is nothing to undo. The transaction is closed either way. */
  abort(): void;
}

/** A node table a gesture lends to its transactions so a drag does not copy the whole table on every
 *  frame. Only the gesture that created it may pass it, always with the same base document, and
 *  only while no one holds the intermediate documents it produced: each new transaction rewrites them. */
export type TransactionScratch = {readonly base: DesignDocument; table: Record<NodeId, SceneNode> | null; changed: Set<NodeId>};

export const createScratch = (base: DesignDocument): TransactionScratch => ({base, table: null, changed: new Set()});

/** A scratch whose table is already a copy of `base`'s, made ahead of time (while the editor is idle):
 *  the one transaction or gesture that takes it writes into that copy instead of making one while
 *  the user waits. `base` must be a published document (its table never changes). */
export const prepareScratch = (base: DesignDocument): TransactionScratch => ({base, table: copyTable(base.nodes), changed: new Set()});

/** A scratch on a table already equal to `base`'s (a whole `TableCopy` of it, shared/design/table-cache.ts). */
export const scratchOf = (base: DesignDocument, table: Record<NodeId, SceneNode>): TransactionScratch => ({base, table, changed: new Set()});

/** Ends a scratch's life once `doc`, the last document its gesture produced, is kept (the gesture
 *  committed): its table is never written again, so the indexes of the base's table that the change
 *  leaves valid are handed to it, and no later transaction may reuse it. */
export function sealScratch(scratch: TransactionScratch, doc: DesignDocument): void {
  if (scratch.table && doc.nodes === scratch.table) carryTableCaches(scratch.base.nodes, scratch.table, scratch.changed);
  scratch.table = null;
  scratch.changed = new Set();
}

type Table = 'nodes' | 'styles' | 'images' | 'variableCollections' | 'variables' | 'variableModes';
const TABLES: readonly Table[] = ['nodes', 'styles', 'images', 'variableCollections', 'variables', 'variableModes'];
const STRUCTURAL_KEYS = ['id', 'parentId', 'children'] as const;

export const isContainer = (node: Pick<SceneNode, 'type'>) => CONTAINER_TYPES.includes(node.type);

/** Rounds away float noise such as 99.99999999997 so panels and patches show the number a designer typed. */
function clean(value: number): number {
  const rounded = Math.round(value);
  const out = Math.abs(value - rounded) < 1e-7 ? rounded : value;
  return Object.is(out, -0) ? 0 : out;
}

/** (x, y) of a box of `width` × `height` whose centre sits at `centre` (parent space) with this rotation. */
function boxOriginTs(centre: Vec, width: number, height: number, rotation: number): Vec {
  const offset = applyLinear(rotationMatrix(-toRadians(rotation)), {x: width / 2, y: height / 2});
  return {x: clean(centre.x - offset.x), y: clean(centre.y - offset.y)};
}

/** Reads x/y/rotation/flips from a local → parent matrix of a box `width` × `height`
 *  (the inverse of `localMatrix`). Rigid matrices round-trip exactly; scale and skew are dropped.
 *  A reflection can be written as flipX or as flipY with a half turn; `prefer` keeps the node's own
 *  flags when they describe it, so moving a flipped node does not swap which flag the panel shows. */
function placementForTs(node: Pick<SceneNode, 'width' | 'height' | 'flipX' | 'flipY'>, matrix: Matrix, prefer: {flipX: boolean; flipY: boolean} = {flipX: !!node.flipX, flipY: !!node.flipY}): Placement {
  const [[a, c], [b, d]] = matrix;
  const mirrored = a * d - b * c < 0;
  let flipX = prefer.flipX, flipY = prefer.flipY;
  if (mirrored !== (flipX !== flipY)) {
    flipX = mirrored;
    flipY = false;
  }
  // localMatrix's linear part is rotate(−rotation) · flip, so rotate(−rotation) = linear · flip.
  const sx = flipX ? -1 : 1;
  const rotation = normalizeDegrees((-Math.atan2(b * sx, a * sx) * 180) / Math.PI);
  const centre = apply(matrix, {x: node.width / 2, y: node.height / 2});
  return {...boxOriginTs(centre, node.width, node.height, rotation), rotation, flipX, flipY};
}

/** Only the fields of `placement` that differ from the node, with absent flips read as false. */
function placementChangesTs(node: SceneNode, placement: Placement): Partial<SceneNode> {
  const out: Partial<SceneNode> = {};
  if (node.x !== placement.x) out.x = placement.x;
  if (node.y !== placement.y) out.y = placement.y;
  if ((node.rotation || 0) !== placement.rotation) out.rotation = placement.rotation;
  if (!!node.flipX !== placement.flipX) out.flipX = placement.flipX;
  if (!!node.flipY !== placement.flipY) out.flipY = placement.flipY;
  return out;
}

class DraftTransaction implements Transaction {
  /** The document the transaction started from (callers read it as `base`). */
  readonly base: DesignDocument;
  private readonly draft: DesignDocument;
  /** In place: the originals of every id written; the recipe's writes, held over the table until commit; the base
   *  table's indexes taken off for the commit; and, from the commit on, the base as it was, read through the log. */
  private readonly log: TableLog | null;
  private overlay: Map<NodeId, SceneNode | null> | null = null;
  private detached: DetachedCaches | null = null;
  private before: DesignDocument;
  private readonly ownedTables = new Set<Table>();
  private readonly ownedNodes = new Set<NodeId>();
  private readonly ownedChildren = new Set<NodeId>();
  /** Removed children per parent, dropped from the parent's list in one pass (`flush`). */
  private readonly pending = new Map<NodeId, Set<NodeId>>();
  private readonly touched: Record<Table, Set<string>> = {nodes: new Set(), styles: new Set(), images: new Set(), variableCollections: new Set(), variables: new Set(), variableModes: new Set()};
  private readonly dirty = new Set<NodeId>();
  private pagesTouched = false;
  private closed = false;
  private readonly scratch: TransactionScratch | null;

  constructor(base: DesignDocument, scratch?: TransactionScratch, mode: TableMode = 'copy') {
    this.base = base;
    this.before = base;
    this.draft = {...base};
    // Written in place until commit: the engine's shadow document must not take it for a settled one.
    markInFlight(this.draft);
    this.scratch = scratch && scratch.base === base ? scratch : null;
    if (mode === 'in-place') {
      // A gesture's frames keep their shared copy (`createScratch`): between two frames the shown document is the last
      // frame's, and a tool computes the next from the base — which must still be the base.
      if (this.scratch) throw new Error('A transaction in place takes no scratch: a gesture writes a table of its own');
      // The recipe writes an overlay over the base's own table; the commit applies it there. The log records the
      // original of every key written (the table being as it was until then).
      this.log = new TableLog(base.nodes);
      this.overlay = new Map();
      this.draft.nodes = overlayView(base.nodes, this.overlay, this.log);
      this.ownedTables.add('nodes');
      return;
    }
    this.log = null;
    if (!this.scratch) return;
    const table = this.scratch.table;
    if (table && table !== base.nodes) {
      // Put back what the previous frame changed; the table then equals the base's again. Indexes
      // someone derived from the previous frame's document describe a state that is going away.
      forgetTable(table);
      for (const id of this.scratch.changed) {
        if (id in base.nodes) table[id] = base.nodes[id];
        else delete table[id];
      }
      this.draft.nodes = table;
      this.ownedTables.add('nodes');
    }
    // Every key this transaction writes is recorded in the scratch as it happens, so even a recipe
    // that throws halfway leaves a table the next frame can revert.
    this.scratch.changed = this.touched.nodes;
  }

  get doc(): DesignDocument {
    this.flushAll();
    return this.draft;
  }

  get(id: NodeId): SceneNode | undefined {
    if (this.pending.has(id)) this.flush(id);
    return this.draft.nodes[id];
  }

  update(id: NodeId, partial: Partial<SceneNode>): void {
    this.assertOpen();
    const node = this.require(id);
    const keys = Object.keys(partial) as (keyof SceneNode)[];
    let changed = false;
    for (const key of keys) {
      const value = partial[key];
      if ((STRUCTURAL_KEYS as readonly string[]).includes(key)) {
        const same = key === 'children' ? sameIds(node.children, value as NodeId[] | undefined) : node[key] === value;
        if (!same) throw new TransactionError(`"${key}" changes through create, move or remove`);
        continue;
      }
      if (key === 'type' && value !== node.type) {
        const type = value as SceneNode['type'];
        if (type === 'PAGE' || node.type === 'PAGE' || isContainer({type}) !== isContainer(node)) throw new TransactionError(`A ${node.type} cannot become a ${type}`);
      }
      if (node[key] !== value) changed = true;
    }
    if (!changed) return;
    const target = this.writable(id) as unknown as Record<string, unknown>;
    for (const key of keys) {
      if ((STRUCTURAL_KEYS as readonly string[]).includes(key)) continue;
      const value = partial[key];
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
    this.dirty.add(id);
  }

  create(node: SceneNode, parentId: NodeId, index?: number): void {
    this.assertOpen();
    if (node.type === 'PAGE') throw new TransactionError('Pages are added with addPage');
    if (this.draft.nodes[node.id]) throw new TransactionError(`Node ${node.id} already exists`);
    const parent = this.require(parentId);
    if (!isContainer(parent)) throw new TransactionError(`A ${parent.type} cannot hold children`);
    const copy: SceneNode = {...node, parentId};
    if (isContainer(node)) copy.children = [];
    else delete copy.children;
    this.nodesTable()[node.id] = copy;
    this.ownedNodes.add(node.id);
    if (copy.children) this.ownedChildren.add(node.id);
    this.touched.nodes.add(node.id);
    insertAt(this.writableChildren(parentId), node.id, index);
    this.dirty.add(node.id);
    this.dirty.add(parentId);
  }

  remove(id: NodeId): void {
    this.assertOpen();
    const node = this.draft.nodes[id];
    if (!node) return;
    if (node.type === 'PAGE') return this.removePage(id);
    this.dropSubtree(id);
    const parentId = node.parentId!;
    let removed = this.pending.get(parentId);
    if (!removed) this.pending.set(parentId, (removed = new Set()));
    removed.add(id);
    this.dirty.add(id);
    this.dirty.add(parentId);
  }

  move(id: NodeId, parentId: NodeId, index?: number, options: {keepWorld?: boolean} = {}): void {
    this.assertOpen();
    const node = this.require(id);
    const target = this.require(parentId);
    if (node.type === 'PAGE') throw new TransactionError('Pages stay at the root');
    if (!isContainer(target)) throw new TransactionError(`A ${target.type} cannot hold children`);
    if (id === parentId || this.isAncestor(id, parentId)) throw new TransactionError('A node cannot move into itself');
    const oldParent = node.parentId!;
    if (oldParent === parentId) return this.reorder(id, index ?? Number.MAX_SAFE_INTEGER);
    let changes: Partial<SceneNode> = {};
    if (options.keepWorld !== false) {
      const local = multiply(invert(worldMatrix(this.draft, parentId)), worldMatrix(this.draft, id));
      changes = placementChangesTs(node, placementForTs(node, local));
    }
    let removed = this.pending.get(oldParent);
    if (!removed) this.pending.set(oldParent, (removed = new Set()));
    removed.add(id);
    insertAt(this.writableChildren(parentId), id, index);
    const writable = this.writable(id);
    writable.parentId = parentId;
    Object.assign(writable, changes);
    this.dirty.add(id);
    this.dirty.add(oldParent);
    this.dirty.add(parentId);
  }

  reorder(id: NodeId, index: number): void {
    this.assertOpen();
    const node = this.require(id);
    if (id === LIBRARY_PAGE_ID) return;
    if (node.type === 'PAGE') {
      const order = this.draft.pages.filter(page => page !== id);
      insertAt(order, id, index);
      if (order.some((page, i) => page !== this.draft.pages[i])) this.setPages(order);
      return;
    }
    const parentId = node.parentId!;
    this.flush(parentId);
    const current = this.draft.nodes[parentId].children ?? [];
    const from = current.indexOf(id);
    const to = Math.max(0, Math.min(current.length - 1, Math.round(index)));
    if (from < 0 || from === to) return;
    const children = this.writableChildren(parentId);
    children.splice(from, 1);
    children.splice(to, 0, id);
    this.dirty.add(id);
    this.dirty.add(parentId);
  }

  setStyle(style: Style): void {
    this.assertOpen();
    this.writeEntry('styles', style.id, style);
  }

  removeStyle(id: StyleId): void {
    this.assertOpen();
    this.deleteEntry('styles', id);
  }

  setImage(ref: ImageRef, asset: ImageAsset): void {
    this.assertOpen();
    this.writeEntry('images', ref, asset);
  }

  removeImage(ref: ImageRef): void {
    this.assertOpen();
    this.deleteEntry('images', ref);
  }

  setPages(order: readonly NodeId[]): void {
    this.assertOpen();
    const current = new Set(this.draft.pages);
    if (order.length !== current.size || new Set(order).size !== order.length || order.some(id => !current.has(id))) {
      throw new TransactionError('setPages takes a new order of the same pages');
    }
    this.draft.pages = [...order];
    this.pagesTouched = true;
  }

  addPage(node: SceneNode, index?: number): void {
    this.assertOpen();
    if (node.type !== 'PAGE') throw new TransactionError('addPage takes a PAGE');
    if (this.draft.nodes[node.id]) throw new TransactionError(`Node ${node.id} already exists`);
    this.nodesTable()[node.id] = {...node, parentId: null, children: []};
    this.ownedNodes.add(node.id);
    this.ownedChildren.add(node.id);
    this.touched.nodes.add(node.id);
    const pages = [...this.draft.pages];
    insertAt(pages, node.id, index);
    this.draft.pages = pages;
    this.pagesTouched = true;
    this.dirty.add(node.id);
  }

  removePage(id: NodeId): void {
    this.assertOpen();
    const node = this.draft.nodes[id];
    if (!node || node.type !== 'PAGE') throw new TransactionError(`${id} is not a page`);
    if (id === LIBRARY_PAGE_ID) {
      this.dropSubtree(id);
      this.dirty.add(id);
      return;
    }
    if (this.draft.pages.length <= 1) throw new TransactionError('A file keeps at least one page');
    this.dropSubtree(id);
    this.draft.pages = this.draft.pages.filter(page => page !== id);
    this.pagesTouched = true;
    this.dirty.add(id);
  }

  addLibraryPage(): void {
    this.assertOpen();
    if (this.draft.nodes[LIBRARY_PAGE_ID]) return;
    this.nodesTable()[LIBRARY_PAGE_ID] = createNode('PAGE', {id: LIBRARY_PAGE_ID, name: 'Libraries', parentId: null, children: []});
    this.ownedNodes.add(LIBRARY_PAGE_ID);
    this.ownedChildren.add(LIBRARY_PAGE_ID);
    this.touched.nodes.add(LIBRARY_PAGE_ID);
    this.dirty.add(LIBRARY_PAGE_ID);
  }

  setVariableCollection(collection: VariableCollection): void {
    this.assertOpen();
    this.writeEntry('variableCollections', collection.id, collection);
  }

  removeVariableCollection(id: string): void {
    this.assertOpen();
    const collection = this.draft.variableCollections[id];
    if (!collection) return;
    for (const variableId of collection.variableIds) this.deleteEntry('variables', variableId);
    for (const variable of Object.values(this.draft.variables)) if (variable.collectionId === id) this.deleteEntry('variables', variable.id);
    this.deleteEntry('variableCollections', id);
  }

  setVariable(variable: Variable): void {
    this.assertOpen();
    const collection = this.draft.variableCollections[variable.collectionId];
    if (!collection) throw new TransactionError(`Collection ${variable.collectionId} does not exist`);
    const previous = this.draft.variables[variable.id];
    if (previous && previous.collectionId !== variable.collectionId) this.unlistVariable(previous);
    this.writeEntry('variables', variable.id, variable);
    if (!collection.variableIds.includes(variable.id)) this.writeEntry('variableCollections', collection.id, {...collection, variableIds: [...collection.variableIds, variable.id]});
  }

  removeVariable(id: VariableId): void {
    this.assertOpen();
    const variable = this.draft.variables[id];
    if (!variable) return;
    this.unlistVariable(variable);
    this.deleteEntry('variables', id);
  }

  setVariableModes(nodeId: NodeId, modes: Record<string, string> | null): void {
    this.assertOpen();
    if (modes) {
      this.require(nodeId);
      this.writeEntry('variableModes', nodeId, {...modes});
    } else {
      this.deleteEntry('variableModes', nodeId);
    }
    this.dirty.add(nodeId);
  }

  commit(context: NormalizeContext): TransactionResult {
    this.assertOpen();
    this.flushAll();
    this.closed = true;
    const draft = this.draft;
    markSettled(draft);
    // The table this transaction copied (or the gesture lent) is its own until now: normalization
    // writes into it in place. Indexes derived from it while the recipe ran are stale. (In place the
    // base table's indexes came off at the start, and nothing of its own is cached under it.)
    const owned = this.ownedTables.has('nodes');
    if (owned && !this.log) forgetTable(draft.nodes);
    if (this.log) this.applyOverlay();
    let doc: DesignDocument = draft;
    if (this.dirty.size) {
      try {
        // The base's cached indexes (instances, variable bindings) carry over through the ids
        // touched here instead of being rebuilt from the file. In place, `origin.nodes` is the view
        // through the log and every pass logs what it writes.
        const out = normalizeDetailed(draft, this.dirty, context, {owned, origin: {nodes: this.before.nodes, changed: this.touched.nodes, doc: this.base}, log: this.log ?? undefined});
        doc = out.doc;
        // The patch is built from these keys, and the gesture's next frame reverts them.
        for (const id of out.changed) this.touched.nodes.add(id);
      } catch (error) {
        // A pass that failed halfway leaves the lent table in an unknown state: the gesture's next
        // frame copies the base's afresh. In place, the writes go back now.
        if (this.log) this.giveBack();
        else if (this.scratch && owned) this.scratch.table = null;
        throw error;
      }
    }
    if (this.log) return this.commitInPlace(doc);
    // Normalization copied the table (this transaction wrote no node): the next frame starts from
    // that copy, reverting the entries recorded above.
    if (this.scratch && doc.nodes !== draft.nodes && doc.nodes !== this.base.nodes) this.scratch.table = doc.nodes;
    const patch = this.buildPatch(doc);
    if (isEmptyPatch(patch)) return {doc: this.base, patch: {}, inverse: {}, dirty: this.dirty};
    // A table no one writes again gets the base's indexes the change leaves valid (a scratch table
    // is written by the next frame: `sealScratch` does this when its gesture ends).
    if (!this.scratch && doc.nodes !== this.base.nodes) carryTableCaches(this.base.nodes, doc.nodes, this.touched.nodes);
    return {doc, patch, inverse: invertPatch(this.base, patch), dirty: this.dirty};
  }

  /** In place, at commit: the recipe's writes go into the base's own table (its indexes come off first: the change
   *  derives the new ones at the end), and from here the base as it was is read through the log. */
  private applyOverlay() {
    const overlay = this.overlay!;
    const table = this.base.nodes;
    this.detached ??= detachTableCaches(table);
    for (const [id, value] of overlay) {
      if (value === null) delete table[id];
      else table[id] = value;
    }
    this.overlay = null;
    this.draft.nodes = table;
    this.before = {...this.base, nodes: loggedView(this.log!)};
  }

  /** The end of a commit in place: the base's table holds the change; the patch is built against the view, the inverse
   *  comes from the log, and the base table's indexes are derived for the change (a gesture's at `sealScratch`). */
  private commitInPlace(doc: DesignDocument): TransactionResult {
    const log = this.log!;
    // A key deleted and made again in this change goes back to its old place: the stored bytes list it where a replica
    // applying the patch has it.
    log.restoreKeyOrder();
    const patch = this.buildPatch(doc);
    if (isEmptyPatch(patch)) {
      // Nothing to publish: the base document stands, with its indexes.
      log.revert();
      if (this.detached) attachTableCaches(this.base.nodes, this.detached);
      return {doc: this.base, patch: {}, inverse: {}, dirty: this.dirty};
    }
    const inverse: DocumentPatch = {};
    if (patch.pages) inverse.pages = [...this.base.pages];
    for (const table of TABLES) {
      const changes = patch[table] as Record<string, unknown> | undefined;
      if (!changes) continue;
      const undo: Record<string, unknown> = {};
      if (table === 'nodes') {
        for (const id of Object.keys(changes)) {
          const original = log.originals.get(id);
          if (original === undefined) throw new Error(`transaction: ${id} changed without its original logged`);
          undo[id] = original;
        }
      } else {
        // The other tables were copied, as always: the base's are untouched.
        const before = (this.base[table] as Record<string, unknown> | undefined) ?? {};
        for (const key of Object.keys(changes)) undo[key] = key in before ? before[key] : null;
      }
      (inverse as Record<Table, unknown>)[table] = undo;
    }
    if (this.detached) deriveTableCachesInPlace(this.base.nodes, this.before.nodes, this.touched.nodes, this.detached);
    return {doc, patch, inverse, dirty: this.dirty};
  }

  /** In place, after a failure inside the commit: the writes go back and the base table gets its indexes again. */
  private giveBack() {
    this.log!.revert();
    if (this.detached) attachTableCaches(this.base.nodes, this.detached);
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    markSettled(this.draft);
    // Before the commit nothing reached the table (the overlay is dropped with the transaction).
    if (this.log && !this.overlay) this.giveBack();
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  private assertOpen() {
    if (this.closed) throw new TransactionError('The transaction is already committed');
  }

  private require(id: NodeId): SceneNode {
    const node = this.get(id);
    if (!node) throw new TransactionError(`Node ${id} does not exist`);
    return node;
  }

  private isAncestor(ancestor: NodeId, id: NodeId): boolean {
    for (let node = this.draft.nodes[id]; node?.parentId; node = this.draft.nodes[node.parentId]) {
      if (node.parentId === ancestor) return true;
    }
    return false;
  }

  private nodesTable(): Record<NodeId, SceneNode> {
    if (!this.ownedTables.has('nodes')) {
      this.draft.nodes = copyTable(this.draft.nodes);
      this.ownedTables.add('nodes');
      if (this.scratch) this.scratch.table = this.draft.nodes;
    }
    return this.draft.nodes;
  }

  private writable(id: NodeId): SceneNode {
    const table = this.nodesTable();
    let node = table[id];
    if (!node) throw new TransactionError(`Node ${id} does not exist`);
    if (!this.ownedNodes.has(id)) {
      node = {...node};
      table[id] = node;
      this.ownedNodes.add(id);
    }
    this.touched.nodes.add(id);
    return node;
  }

  private writableChildren(id: NodeId): NodeId[] {
    this.flush(id);
    const node = this.writable(id);
    if (!this.ownedChildren.has(id)) {
      node.children = [...(node.children ?? [])];
      this.ownedChildren.add(id);
    }
    return node.children!;
  }

  private flush(id: NodeId) {
    const removed = this.pending.get(id);
    if (!removed) return;
    this.pending.delete(id);
    if (!this.draft.nodes[id]) return;
    const node = this.writable(id);
    node.children = (node.children ?? []).filter(child => !removed.has(child));
    this.ownedChildren.add(id);
  }

  private flushAll() {
    for (const id of [...this.pending.keys()]) this.flush(id);
  }

  /** Deletes the node and its descendants from the table (the parent's list is handled by the caller). */
  private dropSubtree(id: NodeId) {
    const ids: NodeId[] = [];
    const stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      ids.push(next);
      if (this.pending.has(next)) this.flush(next);
      const children = this.draft.nodes[next]?.children;
      if (children) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    const table = this.nodesTable();
    const modes = this.draft.variableModes;
    for (const each of ids) {
      delete table[each];
      this.ownedNodes.delete(each);
      this.ownedChildren.delete(each);
      this.pending.delete(each);
      this.touched.nodes.add(each);
      if (modes && each in modes) this.deleteEntry('variableModes', each);
    }
  }

  private tableFor<T>(table: Table): Record<string, T> {
    if (!this.ownedTables.has(table)) {
      (this.draft as Record<Table, unknown>)[table] = {...((this.draft[table] as Record<string, T> | undefined) ?? {})};
      this.ownedTables.add(table);
    }
    return this.draft[table] as Record<string, T>;
  }

  private writeEntry<T>(table: Table, key: string, value: T) {
    this.tableFor<T>(table)[key] = value;
    this.touched[table].add(key);
  }

  private deleteEntry(table: Table, key: string) {
    const current = this.draft[table] as Record<string, unknown> | undefined;
    if (!current || !(key in current)) return;
    delete this.tableFor(table)[key];
    this.touched[table].add(key);
  }

  private unlistVariable(variable: Variable) {
    const collection = this.draft.variableCollections[variable.collectionId];
    if (collection?.variableIds.includes(variable.id)) {
      this.writeEntry('variableCollections', collection.id, {...collection, variableIds: collection.variableIds.filter(id => id !== variable.id)});
    }
  }

  /** The patch from the base to `doc`, compared on the keys this transaction and normalization
   *  touched (`commit` adds normalization's to `touched.nodes`), so its cost is the change, not the
   *  file. Normalization writes only nodes, and variable modes when it removes an instance's copies:
   *  a table it replaced that way is compared in full (it is small). */
  private buildPatch(doc: DesignDocument): DocumentPatch {
    const patch: DocumentPatch = {};
    if (this.pagesTouched && (doc.pages.length !== this.base.pages.length || doc.pages.some((id, i) => id !== this.base.pages[i]))) patch.pages = [...doc.pages];
    for (const table of TABLES) {
      // In place, `before.nodes` is the base's table read through the log (the table itself holds the change).
      const before = (this.before[table] as Record<string, unknown> | undefined) ?? {};
      const after = (doc[table] as Record<string, unknown> | undefined) ?? {};
      const keys: Iterable<string> = table === 'nodes' || doc[table] === this.draft[table] ? this.touched[table] : allKeys(before, after);
      const changes: Record<string, unknown> = {};
      let any = false;
      for (const key of keys) {
        const had = key in before, has = key in after;
        if (!had && !has) continue;
        if (had && has && before[key] === after[key]) continue;
        changes[key] = has ? after[key] : null;
        any = true;
      }
      if (any) (patch as Record<Table, unknown>)[table] = changes;
    }
    return patch;
  }
}

/** The keys of both tables, each once. */
function allKeys(a: Record<string, unknown>, b: Record<string, unknown>): Set<string> {
  const keys = new Set(Object.keys(b));
  for (const key in a) keys.add(key);
  return keys;
}

function sameIds(a: readonly NodeId[] | undefined, b: readonly NodeId[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

function insertAt(list: NodeId[], id: NodeId, index?: number) {
  if (index === undefined || index >= list.length) list.push(id);
  else list.splice(Math.max(0, Math.round(index)), 0, id);
}

/** Starts a transaction on `doc`. Pass the gesture's scratch (`createScratch(doc)`) to reuse one node
 *  table across the frames of a drag instead of copying it each time. */
export function beginTransaction(doc: DesignDocument, options: {scratch?: TransactionScratch; table?: TableMode} = {}): Transaction {
  const table = options.table ?? 'copy';
  if (engineTs('ops')) return new DraftTransaction(doc, options.scratch, table);
  // The ops engine (lane L2a): the Rust transaction, alone or beside this one (shared/design/ops-transaction.ts).
  return beginOpsTransaction(doc, options.scratch, () => new DraftTransaction(doc, options.scratch, table), table);
}

// The placement helpers through the ops engine: a few multiplications, so they cross as numbers through the scratch
// buffer (crates/wasm/src/ops.rs `ops_*_into`), never as JSON.

/** (x, y) of a box of `width` × `height` whose centre sits at `centre` (parent space) with this rotation. */
export function boxOrigin(centre: Vec, width: number, height: number, rotation: number): Vec {
  if (engineTs('ops')) return boxOriginTs(centre, width, height, rotation);
  return viaOps('boxOrigin', () => boxOriginTs(centre, width, height, rotation), () => boxOriginWasm(centre, width, height, rotation), () => [centre, width, height, rotation]);
}

/** See `placementForTs`. */
export function placementFor(node: Pick<SceneNode, 'width' | 'height' | 'flipX' | 'flipY'>, matrix: Matrix, prefer?: {flipX: boolean; flipY: boolean}): Placement {
  if (engineTs('ops')) return placementForTs(node, matrix, prefer);
  return viaOps('placementFor', () => placementForTs(node, matrix, prefer), () => placementForWasm(node, matrix, prefer), () => [node, matrix, prefer]);
}

/** Only the fields of `placement` that differ from the node, with absent flips read as false. */
export function placementChanges(node: SceneNode, placement: Placement): Partial<SceneNode> {
  if (engineTs('ops')) return placementChangesTs(node, placement);
  return viaOps('placementChanges', () => placementChangesTs(node, placement), () => placementChangesWasm(node, placement), () => [node, placement]);
}
