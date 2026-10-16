import {apiAccount, apiGeneration, ApiError} from '../../api';
import {readApiBytes, type ReadProgress} from '../../api-read';
import {adoptShadow, anyWasmEngine, engineWasm, shadowIfNear, type MorfaDocHandle} from '../../../shared/design/engine-switch';
import type {DesignFileAccess} from '../../../shared/design/teams';
import type {DesignFileSummary} from '../../../shared/design/api';
import {documentFromParts, type CheckpointSource} from './open-checkpoint';
import {noteCheckpointBytes} from '../../../shared/design/render-engine';
import {memoryWatchOf} from './memory-watch';
import type {DesignFileOpened} from '../../../shared/design/api';
import {bigFilesEnabled} from '../../../shared/design/big-files';
import {loadDesignPage, openDesignFile, openDesignFileSince, openDesignSkeleton} from '../api';
import type {DesignStore, PartialOptions} from '../engine/store';
import {benchMark} from './bench-hook';
import {browserCheckpoints, keepCheckpoint, type CheckpointStore} from './checkpoint-cache';
import type {DesignDocument} from '../../../shared/design/types';

// The editor's open path: the stored file as the editor first shows it. DesignEditor.tsx calls
// it before it makes the session; the bench marks (`?bench=1`, bench-hook.ts) time its phases for scripts/bench/open.ts.

/** Opens the file: whole, or — big files (docs/decisions/big-files.md §3) — as a skeleton plus its first page, so the first byte
 *  of a 100 MB file does not wait for the whole text and the editor holds one page at a time. */
export async function openForEditing(fileId: string, signal?: AbortSignal, onProgress?: (progress: ReadProgress) => void, checkpoints: CheckpointStore | null = browserCheckpoints()): Promise<DesignFileOpened> {
  const early = early_.get(fileId);
  if (early && early.generation === apiGeneration()) {
    early.listeners.add(onProgress);
    try {
      const opened = await abortable(early.opened, signal);
      early_.delete(fileId);
      return opened;
    } finally {
      early.listeners.delete(onProgress);
    }
  }
  return openNow(fileId, signal, onProgress, checkpoints);
}

async function openNow(fileId: string, signal?: AbortSignal, onProgress?: (progress: ReadProgress) => void, checkpoints: CheckpointStore | null = browserCheckpoints()): Promise<DesignFileOpened> {
  if (checkpointOpenAsked()) return (await openFromCheckpoint(fileId, null, signal, onProgress, checkpoints)) ?? openWhole(fileId, signal, onProgress, checkpoints);
  if (!bigFilesEnabled()) return openWhole(fileId, signal, onProgress, checkpoints);
  return openPartial(fileId, signal, onProgress, checkpoints);
}

/** Reads started before the editor's code arrived (`openEarly`), by file, until an editor takes the answer. */
const early_ = new Map<string, {generation: number; opened: Promise<DesignFileOpened>; listeners: Set<((progress: ReadProgress) => void) | undefined>}>();

/** Starts the file's read as soon as the address names it (DesignRoot.tsx, while the editor's chunk downloads and compiles): over a
 *  slow link the editor's code and the document then arrive together. The editor's `openForEditing` takes it over; one that
 *  fails is forgotten, so "Try again" reads again. Never aborted by an editor that unmounts (StrictMode mounts twice). */
export function openEarly(fileId: string): void {
  if (early_.has(fileId)) return;
  const entry = {generation: apiGeneration(), opened: null as unknown as Promise<DesignFileOpened>, listeners: new Set<((progress: ReadProgress) => void) | undefined>()};
  entry.opened = openNow(fileId, undefined, progress => entry.listeners.forEach(listener => listener?.(progress)));
  entry.opened.catch(() => {
    if (early_.get(fileId) === entry) early_.delete(fileId);
  });
  early_.set(fileId, entry);
  // Nobody took it (the address changed before the editor mounted): let it go after a while.
  setTimeout(() => {
    if (early_.get(fileId) === entry) early_.delete(fileId);
  }, EARLY_KEEP_MS);
}
const EARLY_KEEP_MS = 120_000;

const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> =>
  !signal
    ? promise
    : new Promise<T>((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });

async function openPartial(fileId: string, signal?: AbortSignal, onProgress?: (progress: ReadProgress) => void, checkpoints: CheckpointStore | null = browserCheckpoints()): Promise<DesignFileOpened> {
  const skeleton = await openDesignSkeleton(fileId, signal, pagesAlwaysAsked());
  // A file the fixed caps hold: as with big files off (every page; the warm cache).
  if (skeleton.whole === 'small') return openWhole(fileId, signal, onProgress, checkpoints);
  // Too big for the server to keep parsed (one 400 MB page): its skeleton and pages would each parse it again. From its binary
  // checkpoint when the server has one, else whole.
  if (skeleton.whole)
    return (await openFromCheckpoint(fileId, skeleton, signal, onProgress, checkpoints)) ?? openWhole(fileId, signal, onProgress, checkpoints);
  const opened = skeleton;
  if (!opened.partial) return opened;
  const first = opened.document.pages[0];
  if (!first) return opened;
  const slice = await loadDesignPage(fileId, first, signal, {onProgress});
  return {...opened, document: {...opened.document, nodes: {...opened.document.nodes, ...slice.nodes}}, partial: {...opened.partial, loaded: [first]}};
}

/** The stored file again (a conflict, "Reload file"): a big file comes as its skeleton plus the pages the store holds. */
export async function reopenForEditing(fileId: string, store: DesignStore): Promise<DesignFileOpened> {
  const pages = store.getState().pages;
  if (!pages) return openDesignFile(fileId);
  const skeleton = await openDesignSkeleton(fileId, undefined, pagesAlwaysAsked());
  if (skeleton.whole) {
    // Small again, or grown past what the server keeps parsed: the whole file, every page of it loaded.
    const whole = await openDesignFile(fileId);
    return {...whole, partial: {loaded: Object.values(whole.document.nodes).filter(node => node.type === 'PAGE').map(node => node.id), layers: {}}};
  }
  const opened = skeleton;
  const wanted = new Set([...pages.loaded, store.getState().pageId]);
  const slices = await Promise.all([...wanted].filter(id => opened.document.nodes[id]?.type === 'PAGE').map(id => loadDesignPage(fileId, id).then(slice => [id, slice] as const)));
  const nodes = {...opened.document.nodes};
  for (const [, slice] of slices) Object.assign(nodes, slice.nodes);
  return {...opened, document: {...opened.document, nodes}, partial: {loaded: slices.map(([id]) => id), layers: opened.partial?.layers ?? {}}};
}

/** `?pages=1` in the address: pages on demand even for a small file (the page machinery's e2e; no product default). */
const pagesAlwaysAsked = (): boolean => typeof location !== 'undefined' && /[?&]pages=1(?:&|$)/.test(location.search);

/** The store's page-on-demand options of an opened big file (null for a whole document). A page the server does not know is one
 *  this editor made and has not saved yet (a new page, a pasted one): it has no layers there, so it loads empty rather than fail
 *  (the server's `page_not_found`). */
export const partialOf = (opened: DesignFileOpened): PartialOptions | undefined =>
  opened.partial
    ? {
        loaded: opened.partial.loaded,
        layers: opened.partial.layers,
        load: pageId =>
          loadDesignPage(opened.file.id, pageId).catch(error => {
            if (error instanceof ApiError && error.status === 404 && error.details?.code === 'page_not_found') return {version: opened.file.version, nodes: {}};
            throw error;
          }),
      }
    : undefined;

/** The whole file, from this browser's checkpoint when the server says it is still the stored version (checkpoint-cache.ts),
 *  else downloaded — and then kept for the next open. */
export async function openWhole(fileId: string, signal?: AbortSignal, onProgress?: (progress: ReadProgress) => void, checkpoints: CheckpointStore | null = browserCheckpoints()): Promise<DesignFileOpened> {
  const account = apiAccount();
  const store = account ? checkpoints : null;
  const cached = store && account ? await store.meta(account, fileId).catch(() => null) : null;
  // The cached text is read while the server answers (a stored string comes back in ~0.5 s for 80 MB of JSON); it is parsed only
  // once the server said it is still that version.
  const cachedText = cached && store && account ? store.body(account, fileId) : null;
  cachedText?.catch(() => {});
  const answer = await openDesignFileSince(fileId, cached?.version ?? null, {signal, onProgress});
  if (!answer.current) return answer;
  // `current` answers only the version asked for; a cached copy that does not read is dropped and the file opened whole.
  if (cached && store && account && answer.file.version === cached.version) {
    const document = await cachedText!.then(text => (typeof text === 'string' ? (JSON.parse(text) as DesignDocument) : null)).catch(() => null);
    signal?.throwIfAborted();
    if (document?.nodes && apiAccount() === account) {
      benchMark('open:checkpoint');
      void store.touch(account, fileId, Date.now()).catch(() => {});
      return {file: answer.file, access: answer.access, document};
    }
    await store.remove(account, fileId).catch(() => {});
  }
  return openWhole(fileId, signal, onProgress, null);
}

/** Documents up to this many nodes are also kept while the editor idles (their JSON costs well under a frame or two to write);
 *  larger ones only when the tab is hidden or the file closes, where the cost is not in the way. */
const IDLE_KEEP_NODES = 25_000;
const IDLE_KEEP_EVERY_MS = 15_000;

/** Keeps this browser's checkpoint at the version the editor shows: a document with nothing unsaved is the server's at
 *  `persistence.version()` (autosave and co-editing move that version only once the store holds it), so its JSON is written as
 *  that version's checkpoint — when the tab is hidden, when the file closes and, for documents up to IDLE_KEEP_NODES, every
 *  IDLE_KEEP_EVERY_MS while idle. A version already kept is not written again. A big file's partial document is never kept. */
export function keepCheckpointFresh(options: {
  fileId: string;
  store: DesignStore;
  persistence: {version(): number; dirty(): boolean; status(): string};
  checkpoints?: CheckpointStore | null;
  /** Opened from checkpoint bytes (default: `openedFromBytes` of the store's first document). */
  binary?: boolean;
  /** The document in the model's codec (default: the engine's shadow at it, `encode()`; null when the shadow is not there). */
  encode?: (doc: DesignDocument) => Uint8Array | null;
}): () => void {
  const {fileId, store, persistence} = options;
  const checkpoints = options.checkpoints === undefined ? browserCheckpoints() : options.checkpoints;
  if (!checkpoints || typeof document === 'undefined') return () => {};
  // Opened from checkpoint bytes: the cache keeps bytes, the engine's shadow encoded at the saved
  // version, on hide and close only (encoding a big file is no idle work), and never the document's JSON (the very string the
  // binary open avoids). When the shadow is not at the document, nothing is written: the bytes kept stay at their version.
  const binary = options.binary ?? openedFromBytes(store.getState().doc);
  const encode = options.encode ?? ((doc: DesignDocument) => shadowIfNear(doc)?.encode() ?? null);
  let kept: number | null = null;
  let writing = false;
  // The idle tick's size check, never a scan every tick (a scan of 500 000 keys is a quarter of a second): the memory watch's
  // exact count when it runs (big files on), else one count per node table.
  let counted: {nodes: object; count: number} | null = null;
  const layersOf = (doc: DesignDocument) => {
    const watched = memoryWatchOf(store).estimate()?.layers;
    if (watched !== undefined) return watched;
    if (counted?.nodes !== doc.nodes) counted = {nodes: doc.nodes, count: Object.keys(doc.nodes).length};
    return counted.count;
  };
  const write = async (small: boolean) => {
    const account = apiAccount();
    const version = persistence.version();
    const state = store.getState();
    if (writing || !account || version === kept || persistence.dirty() || persistence.status() !== 'saved' || state.pages) return;
    if (small && (binary || layersOf(state.doc) > IDLE_KEEP_NODES)) return;
    writing = true;
    try {
      const meta = await checkpoints.meta(account, fileId).catch(() => null);
      // Unchanged, or changed while the meta was read: the next moment writes it.
      if (meta?.version === version) kept = version;
      if (kept === version || persistence.version() !== version || persistence.dirty() || store.getState().doc !== state.doc) return;
      const body = binary ? encode(state.doc) : JSON.stringify(state.doc);
      if (!body) return;
      kept = version;
      await keepCheckpoint(checkpoints, {account, fileId, version, body});
    } catch {
      // Storage blocked or full: only the next warm open is lost.
    } finally {
      writing = false;
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void write(false);
  };
  document.addEventListener('visibilitychange', onVisibility);
  const idle = setInterval(() => {
    const run = () => void write(true);
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, {timeout: IDLE_KEEP_EVERY_MS});
    else run();
  }, IDLE_KEEP_EVERY_MS);
  return () => {
    clearInterval(idle);
    document.removeEventListener('visibilitychange', onVisibility);
    void write(false);
  };
}

// ── From the binary checkpoint ───────────────────────────────────────────────────────────

/** `?checkpoint=1` in the address: every file opens from its checkpoint bytes (tests, the benches' f100k). Without it only a big
 *  file the server cannot keep parsed does (the skeleton's `whole`). */
const checkpointOpenAsked = (): boolean => typeof location !== 'undefined' && /[?&]checkpoint=1(?:&|$)/.test(location.search);

/** The engine's loader (src/design/engine/engine-wasm.ts): a dynamic import keeps Vite's `import.meta.glob` out of Node, and at
 *  module level it holds no editor alive (tests/design-lazy-imports.test.ts). */
const loadEngineModule = () => import('../engine/engine-wasm');

/** The decoded document behind an opened file, until the session takes it as its shadow (`adoptOpenedShadow`). */
const decoded = new WeakMap<DesignDocument, MorfaDocHandle>();
/** Documents opened from checkpoint bytes: their warm-cache entry stays bytes (`keepCheckpointFresh`), never JSON (a 400 MB string). */
const fromBytes = new WeakSet<DesignDocument>();
/** The checkpoint bytes an opened document was decoded from, until the session hands them to the renderer. */
const fetchedBytes = new WeakMap<DesignDocument, Uint8Array>();
export const openedFromBytes = (doc: DesignDocument): boolean => fromBytes.has(doc);

const fromBase64Url = (text: string): string => {
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** `GET /:id/checkpoint` (lane S): the document in the model's codec, decoded in wasm and read into the store's objects part by
 *  part — never one text of the whole file. The bytes of this browser's checkpoint are used instead when they are the version the
 *  server just named (`version`, from the skeleton's answer), and the fetched bytes are kept for the next open. Null when the
 *  server has no checkpoint for it (503) or will not encode it on the api path (413): the caller opens it whole. */
export async function openFromCheckpoint(
  fileId: string,
  skeleton: {file: DesignFileSummary; access?: DesignFileAccess} | null,
  signal?: AbortSignal,
  onProgress?: (progress: ReadProgress) => void,
  checkpoints: CheckpointStore | null = browserCheckpoints(),
): Promise<DesignFileOpened | null> {
  const account = apiAccount();
  const store = account ? checkpoints : null;
  const cached = store && account ? await store.meta(account, fileId).catch(() => null) : null;
  let bytes: Uint8Array | null = null;
  // From this browser's bytes, the file's row and access are the answer that named their version: the skeleton's, or — without
  // one — `GET /:id?have=`, whose answer is the server's whole document when the bytes are not its version any more.
  let opened: {file: DesignFileSummary; access?: DesignFileAccess} | null = skeleton;
  if (cached && store && account) {
    const body = store.body(account, fileId).catch(() => null);
    if (!opened) {
      const answer = await openDesignFileSince(fileId, cached.version, {signal, onProgress});
      if (!answer.current) return answer;
      opened = answer;
    }
    const kept = cached.version === opened.file.version ? await body : null;
    if (kept instanceof Uint8Array) bytes = kept;
  }
  // The engine's module (decode_from lives there), loaded beside the read.
  const engine = loadEngineModule().then(module => module.loadEngineWasm());
  engine.catch(() => {});
  if (!bytes) {
    try {
      const answer = await readApiBytes(`/design-files/${encodeURIComponent(fileId)}/checkpoint`, {signal, onProgress, retryDelays: []});
      bytes = answer.bytes;
      const header = answer.headers.get('X-Design-File');
      const meta = header ? (JSON.parse(fromBase64Url(header)) as {file: DesignFileSummary; access?: DesignFileAccess}) : skeleton;
      if (!meta) throw new ApiError('Could not open the file: the server did not name its version.', 502);
      // The bytes' version: a collab file's journal may be ahead of them, and the live session catches up from here.
      const at = Number(answer.headers.get('X-Design-Version'));
      opened = {file: {...meta.file, version: Number.isSafeInteger(at) ? at : meta.file.version}, access: meta.access};
      if (store && account && apiAccount() === account)
        void keepCheckpoint(store, {account, fileId, version: opened.file.version, body: bytes}).catch(() => {});
    } catch (error) {
      if (error instanceof ApiError && (error.status === 413 || error.status === 503)) return null;
      throw error;
    }
  } else {
    benchMark('open:checkpoint');
    void store!.touch(account!, fileId, Date.now()).catch(() => {});
  }
  await engine;
  signal?.throwIfAborted();
  const handle = engineWasm().MorfaDoc.decode_from(bytes);
  try {
    const {doc} = await documentFromParts(handle as unknown as CheckpointSource, {signal});
    decoded.set(doc, handle);
    fetchedBytes.set(doc, bytes);
    fromBytes.add(doc);
    return {file: opened!.file, access: opened!.access, document: doc};
  } catch (error) {
    handle.free();
    throw error;
  }
}

/** The session's store holds `held`, made from the opened document `opened` (the same object, or in the store's in-place mode
 *  its own copy of the table): the document decoded for `opened` becomes the engine's shadow of `held` (no
 *  second load, no idle preload — `adoptShadow`), or is freed when no module runs in wasm. Nothing for a document read
 *  from text. */
export function adoptOpenedShadow(opened: DesignDocument, held: DesignDocument = opened): void {
  // The renderer loads its own copy from the fetched bytes, not from an `encode()` (the RenderShadow asks the store's
  // document, which under the in-place table is `held`, not `opened`).
  const bytes = fetchedBytes.get(opened);
  if (bytes) {
    fetchedBytes.delete(opened);
    noteCheckpointBytes(held, bytes);
  }
  const handle = decoded.get(opened);
  if (!handle) return;
  decoded.delete(opened);
  if (anyWasmEngine()) adoptShadow(handle, held);
  else handle.free();
}
