import type {DocumentPatch} from './patch';
import type {DesignDocument, ImageAsset, ImageRef, NodeId, SceneNode, Style, StyleId, Variable, VariableCollection, VariableId} from './types';
import {LIBRARY_PAGE_ID} from './types';
import {createNode} from './defaults';
import {normalizeDetailed, type NormalizeContext} from './normalize';
import {carryTableCaches, copyTable, forgetTable} from './table-cache';
import {engineFor, engineWasm, EngineUnsupported, lazyInputs, markInFlight, markSettled, markStandIn, withEngine, type OpsTransactionHandle} from './engine-switch';
import {CallContext, sameJson, unsupportedAsFallback} from './ops-engine';
import {createScratch, TransactionError, type TableMode, type Transaction, type TransactionResult, type TransactionScratch} from './transaction';

// The ops engine's transaction (lane L2a; shared/design/transaction.ts `beginTransaction` comes here when ops is not
// `ts`). In `wasm` the Rust transaction (crates/ops/src/transaction.rs through crates/wasm `OpsTransaction`) decides
// every operation: its checks, children lists, `keepWorld` placement, dirty set and the patch's keys. The document
// stays in JavaScript: each operation answers the writes it made and `MirrorTransaction` makes the same writes to its
// draft, so `get` and `doc` read JavaScript objects (the caller's own where the TypeScript keeps them: one pool serves
// the transaction's life). `commit` has two steps around the TypeScript normalize: `stage`
// answers the dirty set, the TypeScript normalizes the draft, `finish` answers the patch's keys from what the committed
// document holds. In `both` the TypeScript transaction answers (with the gesture's scratch) and a mirror with a scratch
// of its own runs beside it: every operation must throw the same, and the commits must be equal (EngineDiffError).

type Table = 'nodes' | 'styles' | 'images' | 'variableCollections' | 'variables' | 'variableModes';
const TABLES: readonly Table[] = ['nodes', 'styles', 'images', 'variableCollections', 'variables', 'variableModes'];
type Effect =
  | ['touch', NodeId]
  | ['copy', NodeId]
  | ['set', NodeId, string, unknown]
  | ['delete', NodeId, string]
  | ['insert', NodeId, number, NodeId]
  | ['reorder', NodeId, number, number]
  | ['drop', NodeId, NodeId[]]
  | ['put', Table, string, unknown]
  | ['remove', Table, string]
  | ['pages', NodeId[]];
type Answer = {effects: Effect[]; pending: NodeId[]; error?: string; dirty?: NodeId[]; pages?: boolean; tables?: [Table, [string, boolean][]][]; codes?: (number | Effect[])[]};
/** A queued update: `[id, partial, keys, base?]` as the Rust's `update` takes it. */
type Queued = [NodeId, Partial<SceneNode>, string[], {node: Record<string, unknown> | null}?];
const STRUCTURAL = new Set(['id', 'parentId', 'children']);
/** A value the queue can carry (crates/wasm/src/ops.rs `decode_updates`): not an object, a string without NUL that is
 *  well-formed UTF-16 (a lone surrogate takes the JSON path, where the Rust reports it). */
const plain = (value: unknown) =>
  value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined || (typeof value === 'string' && !value.includes('\0') && wellFormed(value));
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (text: string): boolean => (text as {isWellFormed?: () => boolean}).isWellFormed?.() ?? !LONE_SURROGATE.test(text);

/** A plain value as `decode_updates` reads it. */
const token = (value: unknown): string =>
  typeof value === 'number' ? `n${String(value)}` : typeof value === 'string' ? `s${value}` : value === true ? 't' : value === false ? 'f' : value === null ? 'l' : 'u';

/** The queued updates as fields separated by NUL (crates/wasm/src/ops.rs `decode_updates`). */
function encodeUpdates(queue: Queued[]): string {
  const out: string[] = [];
  for (const [id, partial, keys, base] of queue) {
    out.push(id, String(keys.length));
    for (const key of keys) out.push(key, token((partial as Record<string, unknown>)[key]));
    if (!base) out.push('0');
    else if (!base.node) out.push('1');
    else {
      const fields = Object.keys(base.node);
      out.push('2', String(fields.length));
      for (const field of fields) out.push(field, token(base.node[field]));
    }
  }
  return out.join('\0');
}

/** What the committed document holds at a key: 0 nothing, 1 the base's very entry, 2 another. */
const status = (before: Record<string, unknown>, after: Record<string, unknown>, key: string) =>
  !Object.hasOwn(after, key) ? 0 : Object.hasOwn(before, key) && before[key] === after[key] ? 1 : 2;

/** The Rust transaction with a JavaScript mirror of its draft. */
export class MirrorTransaction implements Transaction {
  readonly base: DesignDocument;
  private readonly draft: DesignDocument;
  private readonly owned = new Set<Table>();
  private readonly touched = new Set<NodeId>();
  private pending = new Set<NodeId>();
  private readonly scratch: TransactionScratch | null;
  private readonly context: CallContext;
  private readonly rust: OpsTransactionHandle;

  constructor(base: DesignDocument, scratch?: TransactionScratch) {
    this.base = base;
    this.draft = {...base};
    // Written in place until commit, as the TypeScript's draft: the shadow document never follows it.
    markInFlight(this.draft);
    this.scratch = scratch && scratch.base === base ? scratch : null;
    if (this.scratch) {
      // As the TypeScript: the previous frame's writes reverted, the lent table written in place.
      const table = this.scratch.table;
      if (table && table !== base.nodes) {
        forgetTable(table);
        for (const id of this.scratch.changed) {
          if (id in base.nodes) table[id] = base.nodes[id];
          else delete table[id];
        }
        this.draft.nodes = table;
        this.owned.add('nodes');
      }
      this.scratch.changed = this.touched;
    }
    this.context = new CallContext(true, base);
    this.rust = new (engineWasm().OpsTransaction)(this.context);
  }

  private freed = false;
  private lost: EngineUnsupported | null = null;

  private run(name: string, ...args: unknown[]): Answer {
    if (this.queue.length) this.flushQueue();
    return this.send(name, () => this.context.input(args));
  }

  private send(name: string, input: () => string): Answer {
    // The Rust side is freed once the commit is through; it would answer this anyway.
    if (this.freed) throw new TransactionError('The transaction is already committed');
    // Once the Rust could not represent an input, its draft is not this one's: the rest is TypeScript's (counted).
    if (this.lost) throw this.lost;
    let text: string;
    try {
      text = unsupportedAsFallback(() => this.rust.op(name, input()));
    } catch (error) {
      if (error instanceof EngineUnsupported) this.lost = error;
      throw error;
    }
    const answer = this.context.decode(text) as Answer;
    for (const effect of answer.effects) this.apply(effect);
    this.pending = new Set(answer.pending);
    return this.checked(answer);
  }

  private checked(answer: Answer): Answer {
    if (answer.error !== undefined) throw new TransactionError(answer.error);
    return answer;
  }

  /**
   * Updates waiting to cross in one call (a drag frame's fifty become one): only ones that cannot fail (the node
   * exists, no structure or type key, the transaction open) and whose values are plain (no object whose identity the
   * Rust would need), so they cross as JSON without the pool and their writes come back as one number each
   * (crates/wasm/src/ops.rs `update_code`). Anything else first sends them, in order: the Rust sees the same sequence.
   */
  private queue: Queued[] = [];

  private flushQueue() {
    const queue = this.queue;
    this.queue = [];
    const answer = this.send('updates', () => encodeUpdates(queue));
    const codes = answer.codes ?? [];
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (typeof code !== 'number') {
        for (const effect of code) this.apply(effect);
        continue;
      }
      if (!code) continue;
      const [id, partial, keys] = queue[i];
      const table = this.nodesTable();
      if (code & 2) {
        table[id] = {...table[id]};
        this.ownedChildren.delete(id);
      }
      if (code & 4) this.touched.add(id);
      const node = table[id] as unknown as Record<string, unknown>;
      for (const key of keys) {
        if (STRUCTURAL.has(key)) continue;
        const value = (partial as Record<string, unknown>)[key];
        if (value === undefined) delete node[key];
        else node[key] = value;
      }
    }
    this.checked(answer);
  }

  /** Parents whose children list is this draft's own (`ownedChildren`). */
  private readonly ownedChildren = new Set<NodeId>();

  /** `writableChildren`: the parent's list copied once (`[...(children ?? [])]`), then written in place. */
  private writableChildren(id: NodeId): NodeId[] {
    const node = this.draft.nodes[id];
    if (!this.ownedChildren.has(id) || !node.children) {
      node.children = [...(node.children ?? [])];
      this.ownedChildren.add(id);
    }
    return node.children;
  }

  private nodesTable(): Record<NodeId, SceneNode> {
    if (!this.owned.has('nodes')) {
      this.draft.nodes = copyTable(this.draft.nodes);
      this.owned.add('nodes');
      if (this.scratch) this.scratch.table = this.draft.nodes;
    }
    return this.draft.nodes;
  }

  private tableFor(table: Table): Record<string, unknown> {
    if (table === 'nodes') return this.nodesTable() as Record<string, unknown>;
    if (!this.owned.has(table)) {
      (this.draft as Record<Table, unknown>)[table] = {...((this.draft[table] as Record<string, unknown> | undefined) ?? {})};
      this.owned.add(table);
    }
    return this.draft[table] as Record<string, unknown>;
  }

  private apply(effect: Effect) {
    switch (effect[0]) {
      case 'touch':
        this.touched.add(effect[1]);
        break;
      case 'copy': {
        const table = this.nodesTable();
        table[effect[1]] = {...table[effect[1]]};
        // The copy shares its children list with the base's node until its first change of them.
        this.ownedChildren.delete(effect[1]);
        break;
      }
      case 'set':
        (this.draft.nodes[effect[1]] as unknown as Record<string, unknown>)[effect[2]] = effect[3];
        break;
      case 'delete':
        delete (this.draft.nodes[effect[1]] as unknown as Record<string, unknown>)[effect[2]];
        break;
      case 'insert':
        this.writableChildren(effect[1]).splice(effect[2], 0, effect[3]);
        break;
      case 'reorder': {
        const children = this.writableChildren(effect[1]);
        const [moved] = children.splice(effect[2], 1);
        children.splice(effect[3], 0, moved);
        break;
      }
      case 'drop': {
        const removed = new Set(effect[2]);
        const node = this.draft.nodes[effect[1]];
        node.children = (node.children ?? []).filter(child => !removed.has(child));
        this.ownedChildren.add(effect[1]);
        break;
      }
      case 'put':
        this.tableFor(effect[1])[effect[2]] = effect[3];
        // A node the transaction made comes with a list of its own (or none).
        if (effect[1] === 'nodes') this.ownedChildren.add(effect[2]);
        break;
      case 'remove':
        delete this.tableFor(effect[1])[effect[2]];
        if (effect[1] === 'nodes') this.ownedChildren.delete(effect[2]);
        break;
      case 'pages':
        this.draft.pages = effect[1];
        break;
    }
  }

  get doc(): DesignDocument {
    if (this.queue.length) this.flushQueue();
    if (this.pending.size) this.run('flushAll');
    return this.draft;
  }

  get(id: NodeId): SceneNode | undefined {
    if (this.queue.length) this.flushQueue();
    if (this.pending.has(id)) this.run('flush', id);
    return this.draft.nodes[id];
  }

  update(id: NodeId, partial: Partial<SceneNode>): void {
    const keys = Object.keys(partial);
    let entry: Queued = [id, partial, keys];
    // A node the transaction has not written yet is the base's: its fields go with the call (the Rust would ask).
    if (!this.touched.has(id)) {
      const node = this.base.nodes[id] as unknown as Record<string, unknown> | undefined;
      let shape: Record<string, unknown> | null = null;
      if (node) {
        shape = {};
        for (const field of ['id', 'type', 'parentId', 'children', ...keys]) if (node[field] !== undefined) shape[field] = node[field];
      }
      entry = [id, partial, keys, {node: shape}];
    }
    if (this.deferrable(id, partial, keys, entry[3]?.node)) this.queue.push(entry);
    else this.run('update', ...entry);
  }

  /** An update that cannot fail and crosses as plain JSON (see `queue`). */
  private deferrable(id: NodeId, partial: Partial<SceneNode>, keys: string[], shape: Record<string, unknown> | null | undefined): boolean {
    if (this.freed || this.lost || typeof id !== 'string' || !id || !plain(id) || !Object.hasOwn(this.draft.nodes, id)) return false;
    for (const key of keys) if (STRUCTURAL.has(key) || key === 'type' || !plain(key) || !plain((partial as Record<string, unknown>)[key])) return false;
    if (shape) for (const key in shape) if (!plain(key) || !plain(shape[key])) return false;
    return true;
  }

  create(node: SceneNode, parentId: NodeId, index?: number): void {
    this.run('create', node, parentId, index ?? null);
  }

  remove(id: NodeId): void {
    this.run('remove', id);
  }

  move(id: NodeId, parentId: NodeId, index?: number, options: {keepWorld?: boolean} = {}): void {
    this.run('move', id, parentId, index ?? null, options.keepWorld !== false);
  }

  reorder(id: NodeId, index: number): void {
    this.run('reorder', id, index);
  }

  setStyle(style: Style): void {
    this.run('setStyle', style);
  }

  removeStyle(id: StyleId): void {
    this.run('removeStyle', id);
  }

  setImage(ref: ImageRef, asset: ImageAsset): void {
    this.run('setImage', ref, asset);
  }

  removeImage(ref: ImageRef): void {
    this.run('removeImage', ref);
  }

  setPages(order: readonly NodeId[]): void {
    this.run('setPages', order);
  }

  addPage(node: SceneNode, index?: number): void {
    this.run('addPage', node, index ?? null);
  }

  removePage(id: NodeId): void {
    this.run('removePage', id);
  }

  addLibraryPage(): void {
    this.run('addLibraryPage', createNode('PAGE', {id: LIBRARY_PAGE_ID, name: 'Libraries', parentId: null, children: []}));
  }

  setVariableCollection(collection: VariableCollection): void {
    this.run('setVariableCollection', collection);
  }

  removeVariableCollection(id: string): void {
    this.run('removeVariableCollection', id);
  }

  setVariable(variable: Variable): void {
    this.run('setVariable', variable);
  }

  removeVariable(id: VariableId): void {
    this.run('removeVariable', id);
  }

  setVariableModes(nodeId: NodeId, modes: Record<string, string> | null): void {
    this.run('setVariableModes', nodeId, modes);
  }

  abort(): void {
    // The mirror writes a table of its own (a copy, or the gesture's mirror scratch): nothing to put back.
    if (this.freed) return;
    markSettled(this.draft);
    this.rust.free();
    this.freed = true;
  }

  commit(context: NormalizeContext): TransactionResult {
    const staged = this.run('stage');
    const dirty = new Set<NodeId>(staged.dirty);
    const draft = this.draft;
    markSettled(draft);
    const owned = this.owned.has('nodes');
    if (owned) forgetTable(draft.nodes);
    let doc: DesignDocument = draft;
    const changed: NodeId[] = [];
    if (dirty.size) {
      try {
        const out = normalizeDetailed(draft, dirty, context, {owned, origin: {nodes: this.base.nodes, changed: this.touched, doc: this.base}});
        doc = out.doc;
        for (const id of out.changed) {
          this.touched.add(id);
          changed.push(id);
        }
      } catch (error) {
        if (this.scratch && owned) this.scratch.table = null;
        throw error;
      }
    }
    if (this.scratch && doc.nodes !== draft.nodes && doc.nodes !== this.base.nodes) this.scratch.table = doc.nodes;
    // What the committed document holds at every node key the patch may name, and the tables normalization replaced.
    const nodes: Record<string, number> = {};
    for (const id of this.touched) nodes[id] = status(this.base.nodes, doc.nodes, id);
    const replaced: Record<string, [string, number][]> = {};
    for (const table of TABLES) {
      if (table === 'nodes' || doc[table] === draft[table]) continue;
      const before = (this.base[table] as Record<string, unknown> | undefined) ?? {};
      const after = (doc[table] as Record<string, unknown> | undefined) ?? {};
      replaced[table] = Object.keys(after).map(key => [key, status(before, after, key)]);
    }
    // Whether the base has each node normalization wrote (a group's refit rewrites its other layers too).
    const based: Record<string, number> = {};
    for (const id of changed) based[id] = Object.hasOwn(this.base.nodes, id) ? 1 : 0;
    const keys = this.run('finish', changed, nodes, replaced, based);
    const patch: DocumentPatch = {};
    const inverse: DocumentPatch = {};
    if (keys.pages) {
      patch.pages = [...doc.pages];
      inverse.pages = [...this.base.pages];
    }
    for (const [table, entries] of keys.tables ?? []) {
      const before = (this.base[table] as Record<string, unknown> | undefined) ?? {};
      const after = (doc[table] as Record<string, unknown> | undefined) ?? {};
      const changes: Record<string, unknown> = {};
      const undo: Record<string, unknown> = {};
      for (const [key, has] of entries) {
        changes[key] = has ? after[key] : null;
        undo[key] = key in before ? before[key] : null;
      }
      (patch as Record<Table, unknown>)[table] = changes;
      (inverse as Record<Table, unknown>)[table] = undo;
    }
    this.rust.free();
    this.freed = true;
    if (!keys.pages && !(keys.tables ?? []).length) return {doc: this.base, patch: {}, inverse: {}, dirty};
    if (!this.scratch && doc.nodes !== this.base.nodes) carryTableCaches(this.base.nodes, doc.nodes, this.touched);
    return {doc, patch, inverse, dirty};
  }
}

/** Documents equal as JSON, except that a table's key order is free: a scratch table the TypeScript reverts puts a
 *  removed node back at the end of its table (an order nothing reads), a fresh copy keeps the base's. The node table
 *  is compared at the keys the patches name (normalization's writes included): both drafts start from the base's
 *  table and write only keys the transaction touched, which the patch comparison checks to be the same; walking two
 *  20 000-entry tables per drag frame would be the oracle's cost, and the editor's own enumeration guards
 *  (design-perf: a keystroke never enumerates the file) hold in `both` too. The other tables are small: in full. */
function sameDoc(a: DesignDocument, b: DesignDocument, patches: DocumentPatch[]): boolean {
  const x = a as unknown as Record<string, unknown>,
    y = b as unknown as Record<string, unknown>;
  const keys = Object.keys(x).filter(key => x[key] !== undefined);
  if (keys.length !== Object.keys(y).filter(key => y[key] !== undefined).length) return false;
  for (const key of keys) {
    if (!(TABLES as readonly string[]).includes(key)) {
      if (!sameJson(x[key], y[key])) return false;
      continue;
    }
    const p = (x[key] ?? {}) as Record<string, unknown>,
      q = (y[key] ?? {}) as Record<string, unknown>;
    if (p === q) continue;
    let named: string[];
    if (key === 'nodes') named = patches.flatMap(patch => Object.keys(patch.nodes ?? {}));
    else {
      named = Object.keys(p);
      if (named.length !== Object.keys(q).length) return false;
    }
    for (const entry of named) {
      if (Object.hasOwn(p, entry) !== Object.hasOwn(q, entry)) return false;
      if (Object.hasOwn(p, entry) && !sameJson(p[entry], q[entry])) return false;
    }
  }
  return true;
}

type Outcome<T> = {value?: T; error?: unknown; text?: string};

function attempt<T>(run: () => T): Outcome<T> {
  try {
    return {value: run()};
  } catch (error) {
    return {error, text: error instanceof Error ? `${error.name}: ${error.message}` : String(error)};
  }
}

/** A wasm outcome the Rust could not represent goes to the switch as EngineUnsupported (TypeScript answers). */
function unsupported<T>(outcome: Outcome<T>): Outcome<T> {
  if (outcome.error instanceof EngineUnsupported) throw outcome.error;
  return outcome;
}

const sameOutcome = (a: Outcome<unknown>, b: Outcome<unknown>): string | null => (a.text === b.text ? null : '.error');

function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.text !== undefined) throw outcome.error;
  return outcome.value as T;
}

const noTypeScript = (): never => {
  throw new Error('ops transaction: the TypeScript side does not run in wasm mode');
};

/** The transaction behind the switch: `ts` is null in `wasm` mode. Every operation is one `withEngine('ops',
 *  'transaction.<op>', …)` call (counted; in `both` compared, refusals included). */
class SwitchTransaction implements Transaction {
  /** The operations so far, for a diff's digest. */
  private readonly log: unknown[] = [];

  constructor(
    private readonly ts: Transaction | null,
    private readonly wasm: MirrorTransaction,
  ) {}

  get base() {
    return this.wasm.base;
  }

  get doc() {
    if (!this.ts) return this.wasm.doc;
    this.beside(() => this.wasm.doc);
    return this.ts.doc;
  }

  get(id: NodeId) {
    this.log.push(['get', id]);
    if (!this.ts) return this.wasm.get(id);
    this.beside(() => this.wasm.get(id));
    return this.ts.get(id);
  }

  abort(): void {
    this.ts?.abort();
    this.beside(() => this.wasm.abort());
  }

  /** `both`: the mirror reads beside the TypeScript (its pending removals flush at the same points); a mirror the
   *  Rust gave up on is left behind (its operations already count as fallbacks). */
  private beside(read: () => unknown) {
    try {
      read();
    } catch (error) {
      if (!(error instanceof EngineUnsupported)) throw error;
    }
  }

  private op(name: string, args: unknown[], run: (tx: Transaction) => void) {
    this.log.push([name, ...args.map(arg => (arg !== null && typeof arg === 'object' && 'id' in arg ? (arg as {id: unknown}).id : arg))]);
    const ts = this.ts;
    const outcome = withEngine(
      'ops',
      `transaction.${name}`,
      ts ? () => attempt(() => run(ts)) : noTypeScript,
      () => unsupported(attempt(() => run(this.wasm))),
      {equal: sameOutcome, inputs: lazyInputs(() => this.log)},
    );
    unwrap(outcome);
  }

  update(id: NodeId, partial: Partial<SceneNode>) {
    this.op('update', [id, partial], tx => tx.update(id, partial));
  }
  create(node: SceneNode, parentId: NodeId, index?: number) {
    this.op('create', [node, parentId, index], tx => tx.create(node, parentId, index));
  }
  remove(id: NodeId) {
    this.op('remove', [id], tx => tx.remove(id));
  }
  move(id: NodeId, parentId: NodeId, index?: number, options?: {keepWorld?: boolean}) {
    this.op('move', [id, parentId, index, options], tx => tx.move(id, parentId, index, options));
  }
  reorder(id: NodeId, index: number) {
    this.op('reorder', [id, index], tx => tx.reorder(id, index));
  }
  setStyle(style: Style) {
    this.op('setStyle', [style], tx => tx.setStyle(style));
  }
  removeStyle(id: StyleId) {
    this.op('removeStyle', [id], tx => tx.removeStyle(id));
  }
  setImage(ref: ImageRef, asset: ImageAsset) {
    this.op('setImage', [ref], tx => tx.setImage(ref, asset));
  }
  removeImage(ref: ImageRef) {
    this.op('removeImage', [ref], tx => tx.removeImage(ref));
  }
  setPages(order: readonly NodeId[]) {
    this.op('setPages', [order], tx => tx.setPages(order));
  }
  addPage(node: SceneNode, index?: number) {
    this.op('addPage', [node, index], tx => tx.addPage(node, index));
  }
  removePage(id: NodeId) {
    this.op('removePage', [id], tx => tx.removePage(id));
  }
  addLibraryPage() {
    this.op('addLibraryPage', [], tx => tx.addLibraryPage());
  }
  setVariableCollection(collection: VariableCollection) {
    this.op('setVariableCollection', [collection], tx => tx.setVariableCollection(collection));
  }
  removeVariableCollection(id: string) {
    this.op('removeVariableCollection', [id], tx => tx.removeVariableCollection(id));
  }
  setVariable(variable: Variable) {
    this.op('setVariable', [variable], tx => tx.setVariable(variable));
  }
  removeVariable(id: VariableId) {
    this.op('removeVariable', [id], tx => tx.removeVariable(id));
  }
  setVariableModes(nodeId: NodeId, modes: Record<string, string> | null) {
    this.op('setVariableModes', [nodeId, modes], tx => tx.setVariableModes(nodeId, modes));
  }

  commit(context: NormalizeContext): TransactionResult {
    const ts = this.ts;
    const outcome = withEngine(
      'ops',
      'transaction.commit',
      ts ? () => attempt(() => ts.commit(context)) : noTypeScript,
      () => unsupported(attempt(() => this.wasm.commit(context))),
      {equal: (a, b) => sameOutcome(a, b) ?? (a.value && b.value ? sameCommit(a.value, b.value, ts!.base, this.wasm.base) : null), inputs: lazyInputs(() => this.log)},
    );
    return unwrap(outcome);
  }
}

/** The first part of two commits that differs (null: equal). */
function sameCommit(a: TransactionResult, b: TransactionResult, baseA: DesignDocument, baseB: DesignDocument): string | null {
  if (!sameJson(a.patch, b.patch)) return '.patch';
  if (!sameJson(a.inverse, b.inverse)) return '.inverse';
  if (!sameJson([...a.dirty], [...b.dirty])) return '.dirty';
  if (!sameDoc(a.doc, b.doc, [a.patch, b.patch])) return '.doc';
  if ((a.doc === baseA) !== (b.doc === baseB)) return '.doc (unchanged)';
  return null;
}

/** `both`: the mirror's scratch for each of the gestures' scratches (one table cannot serve two drafts). */
const mirrorScratches = new WeakMap<TransactionScratch, TransactionScratch>();

/** `beginTransaction` when ops is `wasm` or `both`; `typescript` makes the TypeScript transaction. */
export function beginOpsTransaction(doc: DesignDocument, scratch: TransactionScratch | undefined, typescript: () => Transaction, table: TableMode = 'copy'): Transaction {
  // The mirror keeps copy semantics (`table` is the TypeScript transaction's): in `wasm` it writes a copy of the table as
  // it always did, and in `both` beside a transaction that writes the document's own table it works on a copy taken
  // before that one writes, so the oracle compares two commits of the same base.
  if (engineFor('ops') === 'wasm') return new SwitchTransaction(null, new MirrorTransaction(doc, scratch));
  if (table === 'in-place') {
    // The TypeScript transaction first: a gesture's frame puts the previous frame's writes back; the copy comes after.
    const ts = typescript();
    const frozen: DesignDocument = {...doc, nodes: copyTable(doc.nodes)};
    // A copy no follower holds: the shadow is never brought to it for the mirror's normalize (as it is not for `doc`).
    markStandIn(frozen);
    return new SwitchTransaction(ts, new MirrorTransaction(frozen));
  }
  // The TypeScript transaction first: it reverts the gesture's table to the base's.
  const ts = typescript();
  let mirrorScratch: TransactionScratch | undefined;
  if (scratch) {
    mirrorScratch = mirrorScratches.get(scratch);
    if (!mirrorScratch || mirrorScratch.base !== scratch.base) {
      // A table made ahead of time (`prepareScratch`) gets its own copy for the mirror, taken from that table (now the
      // base's again), so the oracle never walks the base's table where the TypeScript does not.
      const table = scratch.table && scratch.table !== scratch.base.nodes && scratch.base === doc ? copyTable(scratch.table) : null;
      mirrorScratches.set(scratch, (mirrorScratch = {...createScratch(scratch.base), table}));
    }
  }
  return new SwitchTransaction(ts, new MirrorTransaction(doc, mirrorScratch));
}
