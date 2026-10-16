import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from './types';
import type {DocumentPatch} from './patch';
import type {LocalChanges, MergeOutcome, MergeTarget, Rebased} from './merge';
import type {DesignValidation} from './schema';
import {applyEntriesInPlace, carryTableCaches, copyTable} from './table-cache';
import {engineScratch, engineWasm, EngineUnsupported, firstDifference, lazyInputs, withEngine, type MorfaWasm} from './engine-switch';

// The wasm side of the ops module (lane L2a, crates/ops through crates/wasm src/ops.rs): what `withEngine('ops', …)`
// runs in shared/design/{patch,merge,transaction}.ts, server/design/apply.ts and the `checkPatchedDocument` callers.
// The TypeScript is the oracle; the comparison is exact JSON (key order included, `sameJson`).
//
// Calls cross as JSON with an entry pool (crates/wasm/src/ops.rs): every object of the arguments down to depth 3
// (documents, tables, entries, page lists) is listed once and referred to by index, and the answer refers back to
// every one it holds unchanged, so JavaScript identity survives the boundary where the TypeScript observes it
// (`diffDocuments` compares entries with `===`, `applyPatch` keeps untouched entries, `rebaseLocal` shows an entry
// unless it is the very object the document holds). Documents stay in JavaScript (`lazy(doc)`): the Rust reads the
// entries it needs by id through the call's lookup, never the whole table.
//
// Why not the shadow document (MorfaDoc): it holds the model crate's typed model, which keeps neither the JavaScript key order of
// an entry nor its identity, and refuses the partial nodes the TypeScript tolerates; ops answers are records written
// to storage byte for byte (open questions).

type OpsWasm = MorfaWasm;
const wasm = (): OpsWasm => engineWasm();

/** What the Rust asks of the documents that stay in JavaScript (crates/wasm/src/ops.rs `Lookup`). */
export type OpsLookup = {
  entry(doc: number, table: string, key: string): string | undefined;
  pages(doc: number): string;
  size(doc: number, table: string): number;
  identities(doc: number, table: string): string;
  entries(doc: number, table: string, keys: string): string;
  projections(doc: number, keys: string, fields: string): string;
};

/** Objects deeper than this cross inline. */
const POOL_DEPTH = 2;

/** A document argument that stays in JavaScript: the Rust reads the entries it needs through the call's lookup. */
export class Lazy {
  constructor(readonly doc: object) {}
}
export const lazy = (doc: object) => new Lazy(doc);

/**
 * One call's pool: every object that crossed (or that the Rust may name by identity) has an index; the arguments and
 * the lookups' answers refer to sent objects by index, and the result refers back to them the same way.
 */
export class CallContext implements OpsLookup {
  /** `poolEntries`: a lookup's answer pools the entry's fields too (a transaction's context lives across calls, and
   *  a caller's partial may hold the very objects an entry holds). `base`: the document lookups read as doc 0. */
  constructor(
    private readonly poolEntries = false,
    base?: object,
  ) {
    if (base) this.register(base);
  }

  private readonly index = new Map<object, number>();
  readonly objects: object[] = [];
  private readonly sent = new Set<number>();
  private readonly pool: {i: number; v: unknown}[] = [];

  private register(value: object): number {
    let at = this.index.get(value);
    if (at === undefined) {
      at = this.objects.length;
      this.objects.push(value);
      this.index.set(value, at);
    }
    return at;
  }

  /** An argument, its objects down to POOL_DEPTH pooled (children first). */
  encode(value: unknown, depth = 0): unknown {
    if (value instanceof Lazy) return {$doc: this.register(value.doc)};
    if (value === null || typeof value !== 'object') return value;
    const known = this.index.get(value);
    if (known !== undefined && this.sent.has(known)) return {$r: known};
    if (depth > POOL_DEPTH) return value;
    let encoded: unknown;
    // At the last pooled level the children cross inline: the object itself is the encoding.
    if (depth === POOL_DEPTH) encoded = value;
    else if (Array.isArray(value)) encoded = value.map(item => this.encode(item, depth + 1));
    else {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) out[key] = this.encode(item, depth + 1);
      }
      encoded = out;
    }
    const at = this.register(value);
    this.sent.add(at);
    this.pool.push({i: at, v: encoded});
    return {$r: at};
  }

  input(args: readonly unknown[]): string {
    const encoded = args.map(arg => (arg === undefined ? null : this.encode(arg)));
    return JSON.stringify({pool: this.pool.splice(0), args: encoded});
  }

  private answer(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify({v: value ?? null});
    if (this.poolEntries) {
      const ref = this.encode(value, 1) as {$r: number};
      return JSON.stringify({pool: this.pool.splice(0), i: ref.$r});
    }
    const at = this.register(value);
    if (this.sent.has(at)) return `{"i":${at}}`;
    this.sent.add(at);
    return `{"i":${at},"v":${JSON.stringify(value)}}`;
  }

  private table(doc: number, table: string): Record<string, unknown> | undefined {
    const value = (this.objects[doc] as Record<string, unknown> | undefined)?.[table];
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  }

  entry(doc: number, table: string, key: string): string | undefined {
    const entries = this.table(doc, table);
    if (!entries || !Object.hasOwn(entries, key)) return undefined;
    return this.answer(entries[key]);
  }

  pages(doc: number): string {
    return this.answer((this.objects[doc] as {pages?: unknown}).pages ?? null);
  }

  size(doc: number, table: string): number {
    const entries = this.table(doc, table);
    return entries ? Object.keys(entries).length : 0;
  }

  entries(doc: number, table: string, keys: string): string {
    const list = JSON.parse(keys) as string[];
    const out: string[] = [];
    for (const key of list) out.push(this.entry(doc, table, key) ?? 'null');
    return `[${out.join(',')}]`;
  }

  projections(doc: number, keys: string, fields: string): string {
    const nodes = this.table(doc, 'nodes');
    const names = JSON.parse(fields) as string[];
    const out: unknown[] = [];
    for (const key of JSON.parse(keys) as string[]) {
      if (!nodes || !Object.hasOwn(nodes, key)) {
        out.push(null);
        continue;
      }
      const node = nodes[key] as Record<string, unknown>;
      const shape: Record<string, unknown> = {};
      for (const field of names) {
        const value = node[field];
        if (value === undefined) continue;
        // A transaction's context names the objects it hands over (pooled), so a partial can hold the very same.
        shape[field] = this.poolEntries && value !== null && typeof value === 'object' ? this.encode(value, POOL_DEPTH) : value;
      }
      out.push(shape);
    }
    return this.poolEntries ? JSON.stringify({pool: this.pool.splice(0), v: out}) : JSON.stringify(out);
  }

  identities(doc: number, table: string): string {
    const entries = this.table(doc, table);
    if (!entries) return '[]';
    const out: [string, number][] = [];
    for (const key of Object.keys(entries)) {
      const value = entries[key];
      out.push([key, value !== null && typeof value === 'object' ? this.register(value) : -1]);
    }
    return JSON.stringify(out);
  }

  decode(text: string): unknown {
    const walk = (value: unknown, depth: number): unknown => {
      if (value === null || typeof value !== 'object') return value;
      if (!Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '$r') return this.objects[(value as {$r: number}).$r];
      }
      if (depth > POOL_DEPTH + 2) return value;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = walk(value[i], depth + 1);
      } else for (const key of Object.keys(value)) (value as Record<string, unknown>)[key] = walk((value as Record<string, unknown>)[key], depth + 1);
      return value;
    };
    return walk(JSON.parse(text), 0);
  }
}

/** One call of the Rust port by the TypeScript function's name; `lazy(doc)` arguments stay in JavaScript. */
export function opsCall<T>(name: string, ...args: unknown[]): T {
  const context = new CallContext();
  const input = context.input(args);
  return context.decode(unsupportedAsFallback(() => wasm().ops_call(name, input, context))) as T;
}

/** The Rust's `unsupported:` errors (a lone UTF-16 surrogate, which a Rust string cannot hold: crates/wasm/src/ops.rs
 *  `LOSSY`) as EngineUnsupported: TypeScript answers and the switch counts a fallback. */
export function unsupportedAsFallback<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof Error && error.message.includes(': unsupported: ')) throw new EngineUnsupported(error.message);
    throw error;
  }
}

// ── Comparison ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Exact equality as JSON text (key order included, undefined keys absent, numbers as JSON writes them), without
 * writing it: shared objects are equal at once, so comparing two versions of a 20 000-layer document costs its changes.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return JSON.stringify(a) === JSON.stringify(b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return (a ?? null) === (b ?? null);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i] === undefined ? null : a[i], other[i] === undefined ? null : other[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  const keys = Object.keys(x).filter(key => x[key] !== undefined),
    others = Object.keys(y).filter(key => y[key] !== undefined);
  if (keys.length !== others.length) return false;
  for (let i = 0; i < keys.length; i++) if (keys[i] !== others[i] || !sameJson(x[keys[i]], y[keys[i]])) return false;
  return true;
}

/** The switch's `equal` for ops: exact JSON; on a difference the switch's path to it (or `(key order)` when only the
 *  order of keys differs). */
export function opsEqual(ts: unknown, wasm: unknown): string | null {
  if (sameJson(ts, wasm)) return null;
  return firstDifference(ts, wasm) ?? '(key order)';
}

// ── Adapters: the wasm side of each ported function, with the TypeScript function's signature ─────────────────────

export function applyPatchWasm(doc: DesignDocument, patch: DocumentPatch, nodesCopy?: Record<NodeId, SceneNode>): DesignDocument {
  // The Rust answers the writes; they go into this document's copy of each table (JavaScript holds the document).
  const writes = opsCall<{pages?: NodeId[]; tables: [string, Record<string, unknown>, string[]][]}>('applyPatch', lazy(doc), patch);
  const next = {...doc} as DesignDocument & Record<string, unknown>;
  if (writes.pages) next.pages = [...writes.pages];
  for (const [table, sets, removes] of writes.tables) {
    if (table === 'nodes' && nodesCopy === doc.nodes) {
      // In place (the editor's store): the document's own table takes the writes, logged.
      const changes: Record<NodeId, SceneNode | null> = {};
      for (const key of Object.keys(sets)) changes[key] = sets[key] as SceneNode;
      for (const key of removes) changes[key] = null;
      applyEntriesInPlace(nodesCopy, changes);
      continue;
    }
    const copy: Record<string, unknown> =
      table === 'nodes' && nodesCopy ? nodesCopy : copyTable(((doc as unknown as Record<string, unknown>)[table] as Record<string, unknown> | undefined) ?? {});
    for (const key of Object.keys(sets)) copy[key] = sets[key];
    for (const key of removes) delete copy[key];
    next[table] = copy;
    if (table === 'nodes') carryTableCaches(doc.nodes, next.nodes, Object.keys(patch.nodes ?? {}));
  }
  return next;
}

export const isEmptyPatchWasm = (patch: DocumentPatch): boolean => opsCall<boolean>('isEmptyPatch', patch);
export const invertPatchWasm = (doc: DesignDocument, patch: DocumentPatch): DocumentPatch => opsCall<DocumentPatch>('invertPatch', lazy(doc), patch);
export const composePatchesWasm = (first: DocumentPatch, second: DocumentPatch): DocumentPatch => opsCall<DocumentPatch>('composePatches', first, second);
export const diffDocumentsWasm = (before: DesignDocument, after: DesignDocument): DocumentPatch => opsCall<DocumentPatch>('diffDocuments', lazy(before), lazy(after));

/** The documents behind the targets `documentTarget` made: the Rust port needs the document, not the callbacks. */
const targets = new WeakMap<MergeTarget, DesignDocument>();
export const rememberTarget = (target: MergeTarget, doc: DesignDocument): void => void targets.set(target, doc);

export function mergeChangeWasm(target: MergeTarget, change: DocumentPatch, before: DocumentPatch | undefined): MergeOutcome {
  const doc = targets.get(target);
  // A target built by hand (callbacks, no document behind them) cannot cross: the TypeScript answers, counted.
  if (!doc) throw new EngineUnsupported('mergeChange: a MergeTarget not made by documentTarget has no document to read');
  return opsCall<MergeOutcome>('mergeChange', lazy(doc), change, before ?? null);
}

export function mergeListWasm(list: readonly string[], base: readonly string[], ours: readonly string[], keep: (id: string) => boolean): string[] {
  // `keep` is a callback: it crosses as the ids it keeps (every id the merge can ask about).
  const kept = [...new Set([...list, ...base, ...ours])].filter(id => keep(id));
  return opsCall<string[]>('mergeList', list, base, ours, kept);
}

export const textEditWasm = (a: string, b: string): {start: number; end: number; inserted: string} | null => opsCall('textEdit', a, b);

export const rebaseLocalWasm = (state: LocalChanges, change: DocumentPatch): Rebased =>
  opsCall<Rebased>('rebaseLocal', lazy(state.doc), state.local, state.server, change);

type DocumentChange = {patch: DocumentPatch; before?: Record<NodeId, SceneNode | null>; beforeTables?: DocumentPatch};
type AppliedChange = {doc: DesignDocument; stored: DocumentPatch; adjusted: boolean};

/** `applyDocumentChange` of server/design/apply.ts: the Rust merges (reading the stored document entry by entry); the
 *  writes go in through `apply` (applyPatch, itself switched). */
export function applyDocumentChangeWasm(current: DesignDocument, change: DocumentChange, apply: (doc: DesignDocument, patch: DocumentPatch) => DesignDocument): AppliedChange {
  const merged = opsCall<{stored: DocumentPatch; adjusted: boolean}>(
    'applyDocumentChange',
    lazy(current),
    change.patch,
    change.before ?? null,
    change.beforeTables ?? null,
    change.before !== undefined,
    change.beforeTables !== undefined,
  );
  return {doc: apply(current, merged.stored), stored: merged.stored, adjusted: merged.adjusted};
}

export const storedValuesWasm = (doc: DesignDocument, sent: DocumentPatch, stored: DocumentPatch): DocumentPatch => opsCall<DocumentPatch>('storedValues', lazy(doc), sent, stored);

/** What the check reads of a patch itself: its node keys (null: removed), its page order, the `id` of the other
 *  entries. The patched nodes are read from `after` (they are the same objects). */
function outline(patch: DocumentPatch): unknown {
  const out: Record<string, unknown> = {};
  for (const [table, changes] of Object.entries(patch as Record<string, unknown>)) {
    if (table === 'pages' || changes === null || typeof changes !== 'object') out[table] = changes;
    else {
      const entries: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(changes as Record<string, unknown>))
        entries[key] = value === null ? null : table === 'nodes' ? 1 : value !== null && typeof value === 'object' ? {id: (value as {id?: unknown}).id} : value;
      out[table] = entries;
    }
  }
  return out;
}

export function checkPatchedDocumentWasm(before: DesignDocument, after: DesignDocument, patch: DocumentPatch, nodeCount?: () => number): DesignValidation<DesignDocument> {
  const count = patch.nodes && nodeCount ? nodeCount() : null;
  const result = opsCall<{ok: boolean}>('checkPatchedDocument', lazy(before), lazy(after), outline(patch), count);
  return (result.ok ? {ok: true, value: after} : result) as DesignValidation<DesignDocument>;
}

/** `withEngine('ops', call, …)` with the ops comparison; the inputs are worked out only for a diff's digest. */
export function viaOps<T>(call: string, ts: () => T, wasm: () => T, inputs: () => unknown): T {
  return withEngine('ops', call, ts, wasm, {equal: opsEqual, inputs: lazyInputs(inputs)});
}

// ── The placement helpers (transaction.ts) through the scratch buffer ───────────────────────────────────────────

type Placement = {x: number; y: number; rotation: number; flipX: boolean; flipY: boolean};
const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

export function boxOriginWasm(centre: Vec, width: number, height: number, rotation: number): Vec {
  wasm().ops_box_origin_into(centre.x, centre.y, width, height, rotation);
  const out = engineScratch();
  return {x: out[0], y: out[1]};
}

export function placementForWasm(node: Pick<SceneNode, 'width' | 'height' | 'flipX' | 'flipY'>, matrix: Matrix, prefer?: {flipX: boolean; flipY: boolean}): Placement {
  const [[a, c, e], [b, d, f]] = matrix;
  wasm().ops_placement_for_into(a, c, e, b, d, f, number(node.width), number(node.height), prefer ? prefer.flipX : !!node.flipX, prefer ? prefer.flipY : !!node.flipY);
  const out = engineScratch();
  return {x: out[0], y: out[1], rotation: out[2], flipX: out[3] === 1, flipY: out[4] === 1};
}

export function placementChangesWasm(node: SceneNode, placement: Placement): Partial<SceneNode> {
  wasm().ops_placement_changes_into(number(node.x), number(node.y), number(node.rotation), !!node.flipX, !!node.flipY, placement.x, placement.y, placement.rotation, placement.flipX, placement.flipY);
  const mask = engineScratch()[0];
  const out: Partial<SceneNode> = {};
  if (mask & 1) out.x = placement.x;
  if (mask & 2) out.y = placement.y;
  if (mask & 4) out.rotation = placement.rotation;
  if (mask & 8) out.flipX = placement.flipX;
  if (mask & 16) out.flipY = placement.flipY;
  return out;
}
