import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import type {DocumentPatch} from '../../../shared/design/patch';
import {PATCH_TABLES, patchedDocumentIssues, patchIssues, type PatchEntry, type PatchIssue, type PatchTable} from '../../../shared/design/schema';

// What autosave knows of the server's copy, and what it checks before a patch leaves (docs/design-tool.md §Server
// API, "Lossless saving"). The server refuses a whole patch for one bad value; autosave carries a refused patch
// into every later one, so one bad layer would stop all later work from saving. Every patch is therefore checked
// here with the server's own schema (shared/design/schema.ts), entry by entry, before it is sent, and a refused
// entry can be put back to the value the server has (src/design/persistence/recovery.ts) while the rest saves.
// No DOM, no store: autosave feeds it the patches and documents it sees.

/** The patch's change: the document after it and the inverse that leads back (the previous values at every entry the
 *  patch names — the store's `onPatch` event carries both; a document kept from before is no witness, its table may
 *  have been written in place). */
export type PatchDocs = {inverse: DocumentPatch; after: DesignDocument};

/** Whether the entry existed before the patch: the inverse puts a value back (null: it puts none). */
const hadBefore = (inverse: DocumentPatch, table: PatchTable, key: string): boolean => {
  const entries = inverse[table] as Record<string, unknown> | undefined;
  return !!entries && Object.hasOwn(entries, key) && entries[key] !== null;
};

/** The server's copy as far as an entry is concerned. */
export interface SavedLookup {
  /** The entry as the server has it: the value, null when the server has none, undefined when not known. */
  entry(table: PatchTable, key: string): unknown;
  node(id: NodeId): SceneNode | undefined;
  /** The page order as the server has it, or undefined when not known. */
  pages(): readonly NodeId[] | undefined;
  /** False once a change arrived without its documents: nothing above is known then. */
  readonly known: boolean;
}

export type SavedState = SavedLookup & {
  /** A change made in the editor; `docs` are the documents before and after it. */
  note(patch: DocumentPatch, docs?: PatchDocs): void;
  /** `stored` reached the server; `pending` came since and is not stored yet. */
  stored(stored: DocumentPatch, pending: DocumentPatch | null): void;
  /** The entry no longer differs from the server's (its change was taken out of the pending patch). */
  forget(table: PatchTable | 'pages', key: string | null): void;
  /** The document with every noted change: the server's copy plus what is pending. */
  readonly current: DesignDocument | null;
  /** Layers in `current`: counted once, then kept up to date by each change. */
  nodeCount(): number;
  /** Co-editing: every entry changed since the last stored state, the editor's value (read from `doc`) and the server's. */
  changes(doc: DesignDocument): {local: DocumentPatch; server: DocumentPatch};
  /** Co-editing: after a rebase over the server's changes exactly these entries differ from the server, which holds `server`. */
  reset(server: DocumentPatch): void;
  /** A change from the server was applied to the editor's document: nothing new differs from the server. */
  observe(patch: DocumentPatch, docs: PatchDocs): void;
};

const has = (map: object | undefined, key: string) => !!map && Object.hasOwn(map, key);

/**
 * Tracks the server's copy without keeping a second document: for every entry changed since the last stored state
 * it remembers the value the server has (taken from the document before the change), and reads every other entry
 * from the editor's current document. Cost: the size of each patch.
 */
export function createSavedState(): SavedState {
  const baseline = Object.fromEntries(PATCH_TABLES.map(table => [table, new Map<string, unknown>()])) as Record<PatchTable, Map<string, unknown>>;
  let pages: readonly NodeId[] | null = null;
  let current: DesignDocument | null = null;
  let known = true;
  let count: number | null = null;
  const state: SavedState = {
    get known() {
      return known && current !== null;
    },
    get current() {
      return current;
    },
    note(patch, docs) {
      if (!docs) {
        known = false;
        return;
      }
      for (const table of PATCH_TABLES) {
        const changes = patch[table] as Record<string, unknown> | undefined;
        if (!changes) continue;
        const map = baseline[table],
          before = docs.inverse[table] as Record<string, unknown> | undefined;
        for (const key of Object.keys(changes)) if (!map.has(key)) map.set(key, hadBefore(docs.inverse, table, key) ? before![key] : null);
      }
      if (patch.pages && !pages) pages = docs.inverse.pages ?? null;
      if (count !== null && patch.nodes)
        for (const key of Object.keys(patch.nodes)) count += Number(has(docs.after.nodes, key)) - Number(hadBefore(docs.inverse, 'nodes', key));
      current = docs.after;
    },
    stored(stored, pending) {
      for (const table of PATCH_TABLES) {
        const changes = stored[table] as Record<string, unknown> | undefined;
        if (!changes) continue;
        const later = pending?.[table] as Record<string, unknown> | undefined;
        for (const key of Object.keys(changes)) {
          // Changed again since it was sent: the server now holds the sent value. Otherwise it holds the current one.
          if (has(later, key)) baseline[table].set(key, changes[key] ?? null);
          else baseline[table].delete(key);
        }
      }
      if (stored.pages) pages = pending?.pages ? stored.pages : null;
    },
    forget(table, key) {
      if (table === 'pages') pages = null;
      else if (key !== null) baseline[table].delete(key);
    },
    entry(table, key) {
      if (!state.known) return undefined;
      const map = baseline[table];
      if (map.has(key)) return map.get(key);
      const live = current![table] as Record<string, unknown> | undefined;
      return has(live, key) ? live![key] : null;
    },
    node(id) {
      return (state.entry('nodes', id) as SceneNode | null | undefined) ?? undefined;
    },
    pages() {
      if (!state.known) return undefined;
      return pages ?? current!.pages;
    },
    nodeCount() {
      if (count === null) count = current ? Object.keys(current.nodes).length : 0;
      return count;
    },
    changes(doc) {
      const local: DocumentPatch = {}, server: DocumentPatch = {};
      for (const table of PATCH_TABLES) {
        const map = baseline[table];
        if (!map.size) continue;
        const mine: Record<string, unknown> = {}, theirs: Record<string, unknown> = {};
        const live = doc[table] as Record<string, unknown> | undefined;
        for (const [key, value] of map) {
          mine[key] = has(live, key) ? live![key] : null;
          theirs[key] = value;
        }
        (local as Record<string, unknown>)[table] = mine;
        (server as Record<string, unknown>)[table] = theirs;
      }
      if (pages) {
        local.pages = [...doc.pages];
        server.pages = [...pages];
      }
      return {local, server};
    },
    reset(server) {
      for (const table of PATCH_TABLES) {
        baseline[table].clear();
        const values = server[table] as Record<string, unknown> | undefined;
        for (const key of Object.keys(values ?? {})) baseline[table].set(key, values![key]);
      }
      pages = server.pages ? [...server.pages] : null;
    },
    observe(patch, docs) {
      if (count !== null && patch.nodes)
        for (const key of Object.keys(patch.nodes)) count += Number(has(docs.after.nodes, key)) - Number(hadBefore(docs.inverse, 'nodes', key));
      if (current !== null || known) current = docs.after;
    },
  };
  return state;
}

/**
 * Every entry of `patch` the server would refuse: the shape and bounds of each entry, then (when the server's copy is
 * known and every entry has a valid shape) the document's invariants around the entries the patch touches. Cost grows
 * with the patch, not the file: about a millisecond for a large paste into a 20 000-layer file.
 */
export function inspectPatch(patch: DocumentPatch, saved: Pick<SavedState, 'known' | 'pages' | 'node' | 'current' | 'nodeCount'>): PatchIssue[] {
  const issues = patchIssues(patch);
  if (issues.length || !saved.known || !saved.current) return issues;
  // The layer cap can only be crossed by a patch that adds layers; only then is the count needed.
  const adds = Object.entries(patch.nodes ?? {}).some(([id, node]) => node && saved.node(id) === undefined);
  return patchedDocumentIssues({pages: saved.pages()!, node: id => saved.node(id)}, saved.current, patch, {nodeCount: () => (adds ? saved.nodeCount() : 0)});
}

/** `table:key` of an entry, for sets. */
export const entryId = (entry: PatchEntry) => `${entry.table}:${entry.key ?? ''}`;

/**
 * The entry a refusal of the server names (400/403 `design_document_invalid`): its `entry` field, or else the entry of
 * `patch` its `path` points into (ids may contain dots: the longest key that matches wins). Null when it names none.
 */
export function refusedEntry(error: unknown, patch: DocumentPatch): PatchIssue | null {
  const details = (error as {details?: {code?: unknown; path?: unknown; entry?: unknown}})?.details;
  if (details?.code !== 'design_document_invalid') return null;
  const message = (error as {message?: unknown}).message;
  const reason = (typeof message === 'string' && message ? message : 'Invalid value.').replace(/^File not saved:\s*/, '');
  const path = typeof details.path === 'string' ? details.path : '';
  const named = details.entry as {table?: unknown; key?: unknown} | undefined;
  if (named && (named.table === 'pages' || (PATCH_TABLES as readonly unknown[]).includes(named.table)) && (typeof named.key === 'string' || named.key === null)) {
    if (named.table === 'pages') return {table: 'pages', key: null, error: reason, path};
    return {table: named.table as PatchTable, key: named.key as string | null, error: reason, path};
  }
  if (path === 'pages' || path.startsWith('pages.')) return {table: 'pages', key: null, error: reason, path};
  for (const table of PATCH_TABLES) {
    if (!path.startsWith(table + '.')) continue;
    const rest = path.slice(table.length + 1);
    let best: string | null = null;
    for (const key of Object.keys((patch[table] as Record<string, unknown> | undefined) ?? {}))
      if ((rest === key || rest.startsWith(key + '.')) && (best === null || key.length > best.length)) best = key;
    if (best !== null) return {table, key: best, error: reason, path};
  }
  return null;
}
