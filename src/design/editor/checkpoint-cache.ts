// The warm-open cache: the last copy of each file this browser showed with nothing
// unsaved — the server's document at the version the editor stood at — as its JSON text. The next open asks the server for the
// file with `?have=<version>`; a server whose copy is still that version answers the file's row and access without the
// document, and the editor parses the cached text instead of downloading it again. Anything else (another version, an old
// server that ignores `have`, a cache that is missing or unreadable) is a normal open. So the document shown is always the
// server's at the version the server just named: the cache never decides.
//
// The text is kept as a string, not a Blob: Chromium hands back a stored 80 MB string in ~0.5 s and the same bytes as a Blob's
// text in ~1.5–2 s (f100k; CPU 2× throttled).
//
// Keyed by account and file (another account in this browser never reads it), bounded by bytes and evicted least recently
// used first; an entry older than MAX_AGE_MS is dropped. Storage that is blocked or full only costs the warm open.

export type Checkpoint = {
  account: string;
  fileId: string;
  /** The server's version of the cached document. */
  version: number;
  /** The document's JSON, or its checkpoint in the model's codec (opened from bytes). */
  body: string | Uint8Array;
  /** Its size (UTF-16 code units of JSON, bytes of a checkpoint), the cache's measure. */
  bytes: number;
  /** Last written or read (ms since the epoch): eviction order. */
  usedAt: number;
};

export interface CheckpointStore {
  /** The entry without its body (cheap: the version to ask the server about). */
  meta(account: string, fileId: string): Promise<Omit<Checkpoint, 'body'> | null>;
  body(account: string, fileId: string): Promise<string | Uint8Array | null>;
  get(account: string, fileId: string): Promise<Checkpoint | null>;
  /** Writes `entry` over the file's previous one and drops `evicted`, all or nothing (one transaction): a page that goes away
   *  mid-write keeps the previous entry, never none. */
  put(entry: Checkpoint, evicted?: readonly {account: string; fileId: string}[]): Promise<void>;
  /** Marks an entry used now (it stays longest). */
  touch(account: string, fileId: string, at: number): Promise<void>;
  remove(account: string, fileId: string): Promise<void>;
  /** Every entry's key, size and use time (no bodies). */
  list(): Promise<Pick<Checkpoint, 'account' | 'fileId' | 'bytes' | 'usedAt'>[]>;
}

/** What the cache may hold in all (UTF-16 code units of JSON); one file larger than half of it is not kept. */
export const CACHE_BYTES = 512 * 2 ** 20;
export const MAX_AGE_MS = 30 * 24 * 3600_000;

/** In memory (tests, and browsers without IndexedDB: nothing survives a reload). */
export function memoryCheckpoints(): CheckpointStore {
  const entries = new Map<string, Checkpoint>();
  const key = (account: string, fileId: string) => `${account}\u0000${fileId}`;
  return {
    async meta(account, fileId) {
      const entry = entries.get(key(account, fileId));
      if (!entry) return null;
      const {body: _body, ...meta} = entry;
      return meta;
    },
    async body(account, fileId) {
      return entries.get(key(account, fileId))?.body ?? null;
    },
    async get(account, fileId) {
      return entries.get(key(account, fileId)) ?? null;
    },
    async put(entry, evicted = []) {
      for (const old of evicted) entries.delete(key(old.account, old.fileId));
      entries.set(key(entry.account, entry.fileId), entry);
    },
    async touch(account, fileId, at) {
      const entry = entries.get(key(account, fileId));
      if (entry) entry.usedAt = at;
    },
    async remove(account, fileId) {
      entries.delete(key(account, fileId));
    },
    async list() {
      return [...entries.values()].map(({account, fileId, bytes, usedAt}) => ({account, fileId, bytes, usedAt}));
    },
  };
}

const DB_NAME = 'morfa-checkpoints';
const BODIES = 'bodies';
const META = 'meta';

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** IndexedDB `morfa-checkpoints`: `meta` (key, version, size, use time) apart from `bodies` (the texts), so listing and
 *  touching never read a body. Both keyed by [account, fileId]. */
export function indexedDbCheckpoints(factory: IDBFactory = indexedDB): CheckpointStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(BODIES);
        req.result.createObjectStore(META, {keyPath: ['account', 'fileId']});
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        db = null;
        reject(req.error);
      };
    }));
  const run = async <T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>) => {
    const tx = (await open()).transaction(stores, mode);
    const finished = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const result = await work(tx);
    await finished;
    return result;
  };
  type Meta = Omit<Checkpoint, 'body'>;
  return {
    async meta(account, fileId) {
      return run([META], 'readonly', async tx => ((await done(tx.objectStore(META).get([account, fileId]))) as Meta | undefined) ?? null);
    },
    async body(account, fileId) {
      return run([BODIES], 'readonly', async tx => {
        const body = (await done(tx.objectStore(BODIES).get([account, fileId]))) as unknown;
        return typeof body === 'string' || body instanceof Uint8Array ? body : null;
      });
    },
    async get(account, fileId) {
      return run([META, BODIES], 'readonly', async tx => {
        const [meta, body] = await Promise.all([done(tx.objectStore(META).get([account, fileId]) as IDBRequest<Meta | undefined>), done(tx.objectStore(BODIES).get([account, fileId]) as IDBRequest<unknown>)]);
        return meta && (typeof body === 'string' || body instanceof Uint8Array) ? {...meta, body} : null;
      });
    },
    async put({body, ...meta}, evicted = []) {
      await run([META, BODIES], 'readwrite', async tx => {
        for (const old of evicted) {
          tx.objectStore(META).delete([old.account, old.fileId]);
          tx.objectStore(BODIES).delete([old.account, old.fileId]);
        }
        tx.objectStore(BODIES).put(body, [meta.account, meta.fileId]);
        tx.objectStore(META).put(meta);
      });
    },
    async touch(account, fileId, at) {
      await run([META], 'readwrite', async tx => {
        const store = tx.objectStore(META);
        const meta = (await done(store.get([account, fileId]))) as Meta | undefined;
        if (meta) store.put({...meta, usedAt: at});
      });
    },
    async remove(account, fileId) {
      await run([META, BODIES], 'readwrite', async tx => {
        tx.objectStore(META).delete([account, fileId]);
        tx.objectStore(BODIES).delete([account, fileId]);
      });
    },
    async list() {
      return run([META], 'readonly', async tx => ((await done(tx.objectStore(META).getAll())) as Meta[]).map(({account, fileId, bytes, usedAt}) => ({account, fileId, bytes, usedAt})));
    },
  };
}

let shared: CheckpointStore | null | undefined;
/** This browser's store: IndexedDB when it opens, else none (the open is then always a full one). */
export function browserCheckpoints(): CheckpointStore | null {
  if (shared !== undefined) return shared;
  try {
    shared = typeof indexedDB !== 'undefined' ? indexedDbCheckpoints() : null;
  } catch {
    shared = null;
  }
  return shared;
}

/** What to drop so the cache fits `limit` with `incoming` more bytes: what is too old, then the least recently used. `keep` (the
 *  entry being replaced) is not counted: its new body takes its place. */
function evictions(entries: Pick<Checkpoint, 'account' | 'fileId' | 'bytes' | 'usedAt'>[], incoming: number, now: number, limit: number, keep?: {account: string; fileId: string}) {
  const others = entries.filter(entry => !keep || entry.account !== keep.account || entry.fileId !== keep.fileId).sort((a, b) => a.usedAt - b.usedAt);
  let total = others.reduce((sum, entry) => sum + entry.bytes, 0) + incoming;
  const out: {account: string; fileId: string}[] = [];
  for (const entry of others) {
    if (total <= limit && now - entry.usedAt <= MAX_AGE_MS) continue;
    out.push({account: entry.account, fileId: entry.fileId});
    total -= entry.bytes;
  }
  return out;
}

/** Drops what is too old, then the least recently used, until the cache fits `limit` with `incoming` more bytes. */
export async function evict(store: CheckpointStore, incoming: number, now: number, limit = CACHE_BYTES): Promise<void> {
  for (const entry of evictions(await store.list(), incoming, now, limit)) await store.remove(entry.account, entry.fileId);
}

/** Keeps `body` (the server's document at `version`, as JSON) as the file's checkpoint, unless it is too large to keep. The new
 *  entry replaces the old one and the evictions happen in the same write: the file never has no entry in between (a page
 *  loaded while a write was under way used to find none and open whole). */
export async function keepCheckpoint(store: CheckpointStore, entry: {account: string; fileId: string; version: number; body: string | Uint8Array}, now = Date.now(), limit = CACHE_BYTES): Promise<boolean> {
  const bytes = typeof entry.body === 'string' ? entry.body.length : entry.body.byteLength;
  if (bytes > limit / 2) {
    await store.remove(entry.account, entry.fileId);
    return false;
  }
  await store.put({...entry, bytes, usedAt: now}, evictions(await store.list(), bytes, now, limit, entry));
  return true;
}
