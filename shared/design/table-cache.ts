import type {DesignDocument, NodeId, SceneNode} from './types';

// Indexes derived from a document's node table (component → instances, variable → bound nodes, …)
// are cached by the table's identity, which is cheap and right as long as a table never changes
// once something was derived from it. Published tables never do. Two kinds of table are written
// in place, though: the private copy a transaction builds (normalization writes into it as well,
// so a commit costs what changed instead of a copy of a 20 000-node table per pass), and the
// scratch table a gesture reuses frame after frame (shared/design/transaction.ts). Whoever writes
// into a table in place calls `forgetTable` so nothing derived from an earlier state of it
// survives, and `carryTableCaches` hands a finished table the indexes of the table it was made
// from when the change between them leaves them as they were: an edit then never pays for a scan
// of the whole file to rebuild an index it did not affect.

type Nodes = Readonly<Record<NodeId, SceneNode>>;

/** Computes the index of `after` from the index of `before`, given every id whose entry differs
 *  between them. Returns undefined when it cannot (the index is then rebuilt on demand). */
export type DeriveIndex<T> = (previous: T, before: Nodes, after: Nodes, changed: Iterable<NodeId>) => T | undefined;

type Registered = {cache: WeakMap<object, unknown>; derive?: DeriveIndex<unknown>};
const registry: Registered[] = [];

/** A cache keyed by node-table identity that in-place writers can clear. */
export function tableCache<T>(derive?: DeriveIndex<T>): WeakMap<object, T> {
  const cache = new WeakMap<object, T>();
  registry.push({cache: cache as WeakMap<object, unknown>, derive: derive as DeriveIndex<unknown> | undefined});
  return cache;
}

/** Drops every index derived from `table` (it is about to be, or was, written in place). */
export function forgetTable(table: object): void {
  for (const {cache} of registry) cache.delete(table);
}

/** A shallow copy of a table (same entries, same key order). With tens of thousands of keys an object
 *  is a hash table, and assigning its keys one by one costs about half of what a spread does. */
export function copyTable<T>(table: Readonly<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  const keys = Object.keys(table);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    // An own "__proto__" key is data (as a spread keeps it), never the prototype.
    if (key === '__proto__') Object.defineProperty(out, key, {value: table[key], writable: true, enumerable: true, configurable: true});
    else out[key] = table[key];
  }
  return out;
}

/** A copy of a table made a slice at a time (`continueCopy`), so making it never holds the thread longer than a slice:
 *  the editor's idle copy (src/design/engine/store.ts) runs in the gaps between frames and keystrokes. `table` holds
 *  `keys[0, next)` of `from`, in its key order. */
export type TableCopy<T> = {from: Readonly<Record<string, T>>; readonly table: Record<string, T>; readonly keys: readonly string[]; next: number};

/** Keys copied between two checks of the clock. */
const COPY_SLICE = 2048;

export function startCopy<T>(from: Readonly<Record<string, T>>): TableCopy<T> {
  return {from, table: {}, keys: Object.keys(from), next: 0};
}

export const copyDone = <T>(copy: TableCopy<T>): boolean => copy.next >= copy.keys.length;

/** Copies on until the copy is whole or `stop()` says so (asked every `COPY_SLICE` keys); true when it is whole. */
export function continueCopy<T>(copy: TableCopy<T>, stop?: () => boolean): boolean {
  const {keys, table, from} = copy;
  let i = copy.next;
  while (i < keys.length) {
    const end = Math.min(keys.length, i + COPY_SLICE);
    for (; i < end; i++) {
      const key = keys[i];
      // An own "__proto__" key is data (as copyTable keeps it), never the prototype.
      if (key === '__proto__') Object.defineProperty(table, key, {value: from[key], writable: true, enumerable: true, configurable: true});
      else table[key] = from[key];
    }
    if (i < keys.length && stop?.()) break;
  }
  copy.next = i;
  return i >= keys.length;
}

/** `after` is final and differs from `before` only at `changed`: indexes cached for `before` that
 *  the change leaves valid are cached for `after` too, so the next edit finds them. */
export function carryTableCaches(before: Nodes, after: Nodes, changed: Iterable<NodeId>): void {
  if (before === after) return;
  for (const {cache, derive} of registry) {
    if (!derive || cache.has(after)) continue;
    const previous = cache.get(before);
    if (previous === undefined) continue;
    const next = derive(previous, before, after, changed);
    if (next !== undefined) cache.set(after, next);
  }
}

// ── Tables written in place ───────────────────────────────────────────────────
//
// The editor's store may commit into the document's own node table instead of a copy (`'in-place'`,
// shared/design/transaction.ts). Node objects stay copy-on-write per id (a write replaces the entry
// with a new object), so the previous value of every entry a change touched is kept in a log, the
// first time it is written. The log is what the inverse patch, the pre-write view (`tx.base`) and
// the caches' derivation read instead of the earlier table — which no longer exists.

/** The originals of a table written in place: for every id touched, the entry it held before (null: none). */
export class TableLog {
  readonly originals = new Map<NodeId, SceneNode | null>();
  /** Keys present before that were deleted (a re-creation puts them at the table's end), and the key order of the
   *  table when the first of them went: `restoreKeyOrder` puts them back where a replica applying the patch has them. */
  private deleted: Set<NodeId> | null = null;
  private keyOrder: string[] | null = null;

  constructor(readonly table: Record<NodeId, SceneNode>) {}

  /** Before any write of `id`: the entry as it is now, recorded once. */
  touch(id: NodeId): void {
    if (!this.originals.has(id)) this.originals.set(id, Object.hasOwn(this.table, id) ? this.table[id] : null);
  }

  /** Before `delete table[id]`. */
  deleting(id: NodeId): void {
    this.touch(id);
    if (this.originals.get(id) === null || !Object.hasOwn(this.table, id)) return;
    (this.deleted ??= new Set()).add(id);
    // One enumeration, only in a change that removes a layer: what a copy would have cost in keys alone.
    this.keyOrder ??= Object.keys(this.table);
  }

  /** The entry `id` held before the log's writes (undefined: none). */
  before(id: NodeId): SceneNode | undefined {
    if (this.originals.has(id)) return this.originals.get(id) ?? undefined;
    return Object.hasOwn(this.table, id) ? this.table[id] : undefined;
  }

  /** Puts every touched entry back: the table holds what it held before the log's writes, keys in their old places. */
  revert(): void {
    for (const [id, original] of this.originals) {
      if (original === null) delete this.table[id];
      else setKey(this.table, id, original);
    }
    this.restoreKeyOrder();
  }

  /** A key deleted and present again sits at the table's end, where a replica applying the patch keeps it in place:
   *  the table is rebuilt in its old order (one pass, only when that happened) so the two agree on key order. */
  restoreKeyOrder(): void {
    if (!this.deleted || !this.keyOrder) return;
    let needed = false;
    for (const id of this.deleted) if (Object.hasOwn(this.table, id)) (needed = true);
    if (!needed) return;
    const table = this.table;
    const current = Object.keys(table);
    const old = new Set(this.keyOrder);
    const order = [...this.keyOrder.filter(key => Object.hasOwn(table, key)), ...current.filter(key => !old.has(key))];
    const values = order.map(key => table[key]);
    for (const key of current) delete table[key];
    for (let i = 0; i < order.length; i++) setKey(table, order[i], values[i]);
    this.deleted = null;
  }
}

function setKey<T>(table: Record<string, T>, key: string, value: T): void {
  // An own "__proto__" key is data (as copyTable keeps it), never the prototype.
  if (key === '__proto__') Object.defineProperty(table, key, {value, writable: true, enumerable: true, configurable: true});
  else table[key] = value;
}

/** The table as it was before `log`'s writes, read through the log: `view[id]` and `id in view` cost a lookup; an
 *  enumeration (`Object.keys`, a spread) materializes a copy once. Read-only. */
export function loggedView(log: TableLog): Readonly<Record<NodeId, SceneNode>> {
  let snapshot: Record<NodeId, SceneNode> | null = null;
  const materialize = () => {
    if (!snapshot) {
      snapshot = copyTable(log.table);
      for (const [id, original] of log.originals) {
        if (original === null) delete snapshot[id];
        else setKey(snapshot, id, original);
      }
    }
    return snapshot;
  };
  const readOnly = () => {
    throw new Error('A logged view of a node table is read-only');
  };
  return new Proxy({} as Record<NodeId, SceneNode>, {
    get: (_, key) => (typeof key === 'string' ? log.before(key) : undefined),
    has: (_, key) => typeof key === 'string' && log.before(key) !== undefined,
    ownKeys: () => Reflect.ownKeys(materialize()),
    getOwnPropertyDescriptor: (_, key) => {
      const value = typeof key === 'string' ? log.before(key) : undefined;
      return value === undefined ? undefined : {value, writable: false, enumerable: true, configurable: true};
    },
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
  });
}

/** `table` with `overlay` laid over it, as a transaction's draft table while its recipe runs: reads fall through to the
 *  table, writes (`view[id] = node`, `delete view[id]`) go to the overlay, and the table itself stays as it is until the
 *  overlay is applied (at commit) — synchronous readers of the document see no half-written change. Every write logs
 *  the key's original in `log` (the table being untouched, that is the value before the transaction). An enumeration
 *  (`Object.keys`) is the table's with the overlay applied, made anew each time. */
export function overlayView(table: Readonly<Record<NodeId, SceneNode>>, overlay: Map<NodeId, SceneNode | null>, log: TableLog): Record<NodeId, SceneNode> {
  const read = (id: string): SceneNode | undefined => (overlay.has(id) ? overlay.get(id) ?? undefined : Object.hasOwn(table, id) ? table[id] : undefined);
  const materialize = () => {
    const out = copyTable(table);
    for (const [id, value] of overlay) {
      if (value === null) delete out[id];
      else setKey(out, id, value);
    }
    return out;
  };
  return new Proxy({} as Record<NodeId, SceneNode>, {
    get: (_, key) => (typeof key === 'string' ? read(key) : undefined),
    has: (_, key) => typeof key === 'string' && read(key) !== undefined,
    ownKeys: () => Reflect.ownKeys(materialize()),
    getOwnPropertyDescriptor: (_, key) => {
      const value = typeof key === 'string' ? read(key) : undefined;
      return value === undefined ? undefined : {value, writable: true, enumerable: true, configurable: true};
    },
    set: (_, key, value) => {
      if (typeof key !== 'string') return false;
      log.touch(key);
      overlay.set(key, value as SceneNode);
      return true;
    },
    defineProperty: (_, key, descriptor) => {
      if (typeof key !== 'string' || !('value' in descriptor)) return false;
      log.touch(key);
      overlay.set(key, descriptor.value as SceneNode);
      return true;
    },
    deleteProperty: (_, key) => {
      if (typeof key !== 'string') return false;
      if (read(key) !== undefined) {
        log.deleting(key);
        overlay.set(key, null);
      }
      return true;
    },
  });
}

/** A document of its own for work that spans awaits, idle slices or timers (an export, a thumbnail, "Code"): the same
 *  entries in a table nobody writes, with the indexes of the source table. O(layers), once per job — explicit, where
 *  a table written in place would otherwise change under the job. */
export function snapshotDocument(doc: DesignDocument): DesignDocument {
  const nodes = copyTable(doc.nodes);
  carryTableCaches(doc.nodes, nodes, []);
  return {...doc, nodes};
}

/** Indexes taken off a table about to be written in place (`detachTableCaches`): the readers of the table rebuild or
 *  derive theirs meanwhile, as they do for a fresh copy, and the change derives the table's new indexes from these
 *  (`deriveTableCachesInPlace`). */
export type DetachedCaches = Map<WeakMap<object, unknown>, unknown>;

export function detachTableCaches(table: object): DetachedCaches {
  const detached: DetachedCaches = new Map();
  for (const {cache} of registry) {
    if (!cache.has(table)) continue;
    detached.set(cache, cache.get(table));
    cache.delete(table);
  }
  return detached;
}

/** Puts detached indexes back under `key` (the table itself once its writes were reverted, or a view of it). */
export function attachTableCaches(key: object, detached: DetachedCaches): void {
  for (const [cache, value] of detached) cache.set(key, value);
}

/** `carryTableCaches` for a table written in place: `table` now differs from what `detached` describes (its state
 *  before the writes, readable through `before`) at `changed`; the indexes the change leaves valid are derived and
 *  cached for the table again. The others are rebuilt on demand. */
export function deriveTableCachesInPlace(table: Nodes, before: Nodes, changed: Iterable<NodeId>, detached: DetachedCaches): void {
  const ids = [...changed];
  for (const {cache, derive} of registry) {
    if (!derive || !detached.has(cache) || cache.has(table)) continue;
    const next = derive(detached.get(cache), before, table, ids);
    if (next !== undefined) cache.set(table, next);
  }
}

/** `applyPatch`'s node writes into the document's own table (`nodesCopy === doc.nodes`): every entry set or removed,
 *  logged as it goes, keys back in their places, and the table's indexes derived for the change. */
export function applyEntriesInPlace(table: Record<NodeId, SceneNode>, changes: Readonly<Record<NodeId, SceneNode | null>>): void {
  const detached = detachTableCaches(table);
  const log = new TableLog(table);
  const keys = Object.keys(changes);
  for (const key of keys) {
    const value = changes[key];
    if (value === null) {
      log.deleting(key);
      delete table[key];
    } else {
      log.touch(key);
      setKey(table, key, value);
    }
  }
  log.restoreKeyOrder();
  deriveTableCachesInPlace(table, loggedView(log), keys, detached);
}
