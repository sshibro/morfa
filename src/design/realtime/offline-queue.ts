import type {ClientOp} from '../../../shared/design/protocol';

// The offline queue of the socket path: every op this
// tab sent and the server has not acked, kept in IndexedDB per file until its ack, so a dropped connection, a reload or
// a crash never loses a save. After a reconnect the ops go again with their own `seq`; the server de-duplicates by
// (clientId, seq), so an op whose ack was lost is re-acked, never applied twice.
//
// The tab's identity for a file (clientId and the last seq it gave out) lives in sessionStorage: a reload of the tab
// keeps it (and so finds its queued ops), another tab gets its own. A duplicated tab copies sessionStorage; a Web Lock on
// the id tells the copy to take a new one. A tab that would take a new id first adopts the id of a closed tab that left
// ops in the queue (its lock is free): those ops then go with this tab's, under the id and seqs the server knows them by.

export type QueuedOp = {fileId: string; clientId: string; seq: number; op: ClientOp; queuedAt: number};

export interface OpQueue {
  /** Every queued op of the file (all clientIds), in seq order per client. */
  load(fileId: string): Promise<QueuedOp[]>;
  put(entry: QueuedOp): Promise<void>;
  remove(fileId: string, clientId: string, seq: number): Promise<void>;
}

const bySeq = (a: QueuedOp, b: QueuedOp) => (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : a.seq - b.seq);

/** In memory (tests, and browsers without IndexedDB: the queue then survives reconnects but not a reload). */
export function memoryQueue(): OpQueue & {size(): number} {
  const entries = new Map<string, QueuedOp>();
  const key = (fileId: string, clientId: string, seq: number) => `${fileId}\u0000${clientId}\u0000${seq}`;
  return {
    async load(fileId) {
      return [...entries.values()].filter(entry => entry.fileId === fileId).sort(bySeq);
    },
    async put(entry) {
      entries.set(key(entry.fileId, entry.clientId, entry.seq), entry);
    },
    async remove(fileId, clientId, seq) {
      entries.delete(key(fileId, clientId, seq));
    },
    size: () => entries.size,
  };
}

const DB_NAME = 'morfa-collab';
const STORE = 'ops';

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** IndexedDB: database `morfa-collab`, store `ops` keyed by [fileId, clientId, seq]. */
export function indexedDbQueue(factory: IDBFactory = indexedDB): OpQueue {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, {keyPath: ['fileId', 'clientId', 'seq']});
        store.createIndex('file', 'fileId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        db = null;
        reject(req.error);
      };
    }));
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) => {
    const tx = (await open()).transaction(STORE, mode, {durability: 'strict'} as IDBTransactionOptions);
    const result = request(work(tx.objectStore(STORE)));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    return result;
  };
  return {
    async load(fileId) {
      const all = await run('readonly', store => store.index('file').getAll(IDBKeyRange.only(fileId)) as IDBRequest<QueuedOp[]>);
      return all.sort(bySeq);
    },
    async put(entry) {
      await run('readwrite', store => store.put(entry));
    },
    async remove(fileId, clientId, seq) {
      await run('readwrite', store => store.delete([fileId, clientId, seq]));
    },
  };
}

/** The queue this browser offers: IndexedDB when there is one, memory otherwise. */
export function browserQueue(): OpQueue {
  try {
    if (typeof indexedDB !== 'undefined') return indexedDbQueue();
  } catch {
    // Blocked storage (a private window in some browsers).
  }
  return memoryQueue();
}

// ── The tab's identity in one file ────────────────────────────────────────────────────────────────

export type ClientIdentity = {
  readonly clientId: string;
  /** The highest seq given out (persisted, so a reload never reuses one). */
  lastSeq: number;
  /** Gives out the next seq and remembers it. */
  next(): number;
  /** The server holds seqs up to `acked` (welcome.ackedSeq): never give one of those out again. */
  atLeast(acked: number): void;
  release(): void;
};

export const newClientId = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

type KeyValue = {getItem(key: string): string | null; setItem(key: string, value: string): void};
type Locks = {request(name: string, options: {ifAvailable: boolean}, run: (lock: unknown) => Promise<void> | void): Promise<unknown>};

/** This tab's clientId and seq counter for `fileId`: reused across a reload, new in a duplicated tab. `orphans`: the ids
 *  with ops in the queue, one of which a tab without its own id adopts when no other tab holds it (Web Locks only). */
export async function clientIdentity(fileId: string, options: {storage?: KeyValue | null; locks?: Locks | null; orphans?: readonly string[]} = {}): Promise<ClientIdentity> {
  const storage = options.storage !== undefined ? options.storage : typeof sessionStorage === 'undefined' ? null : safeSessionStorage();
  const locks = options.locks !== undefined ? options.locks : ((globalThis.navigator as {locks?: Locks} | undefined)?.locks ?? null);
  const key = `morfa:collab:${fileId}`;
  let stored: {clientId?: unknown; lastSeq?: unknown} = {};
  try {
    stored = JSON.parse(storage?.getItem(key) ?? '{}') ?? {};
  } catch {
    stored = {};
  }
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
  const own = validId(stored.clientId);
  let clientId = own ? (stored.clientId as string) : newClientId();
  let lastSeq = typeof stored.lastSeq === 'number' && Number.isSafeInteger(stored.lastSeq) && stored.lastSeq >= 0 ? stored.lastSeq : 0;
  let release = () => {};
  if (locks) {
    const take = async (id: string) => {
      let held = false;
      let free: () => void = () => {};
      const freed = new Promise<void>(resolve => (free = resolve));
      await new Promise<void>(granted => {
        void locks.request(`morfa-collab:${fileId}:${id}`, {ifAvailable: true}, lock => {
          held = lock !== null;
          granted();
          return held ? freed : undefined;
        });
      });
      return held ? free : null;
    };
    let freeLock = own ? await take(clientId).catch(() => null) : null;
    if (!freeLock) {
      // No id of its own, or another tab (a duplicate of this one) holds it: a closed tab's id with ops left, else a new one.
      lastSeq = 0;
      for (const orphan of options.orphans ?? []) {
        if (orphan === stored.clientId || !validId(orphan)) continue;
        freeLock = await take(orphan).catch(() => null);
        if (freeLock) {
          clientId = orphan;
          break;
        }
      }
      if (!freeLock) {
        clientId = newClientId();
        freeLock = await take(clientId).catch(() => null);
      }
    }
    release = freeLock ?? (() => {});
  }
  const save = () => {
    try {
      storage?.setItem(key, JSON.stringify({clientId, lastSeq}));
    } catch {
      // Storage full or blocked: the counter still moves in memory (the server's ackedSeq guards a reload).
    }
  };
  save();
  return {
    clientId,
    get lastSeq() {
      return lastSeq;
    },
    set lastSeq(value: number) {
      lastSeq = value;
      save();
    },
    next() {
      lastSeq++;
      save();
      return lastSeq;
    },
    atLeast(acked) {
      if (acked > lastSeq) {
        lastSeq = acked;
        save();
      }
    },
    release: () => release(),
  };
}

function safeSessionStorage(): KeyValue | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}
