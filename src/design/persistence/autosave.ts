import {applyPatch, composePatches, isEmptyPatch, type DocumentPatch} from '../../../shared/design/patch';
import type {DesignPatchContext, DesignSaved} from '../../../shared/design/api';
import type {DesignDocument} from '../../../shared/design/types';
import {DESIGN_KEEPALIVE_PATCH_BYTES} from '../../../shared/design/document-limits';
import {PATCH_TABLES, type PatchIssue, type PatchTable} from '../../../shared/design/schema';
import type {LocalChanges, Rebased} from '../../../shared/design/merge';
import {patchDesignDocument} from '../api';
import {createSavedState, entryId, inspectPatch, refusedEntry, type PatchDocs, type SavedLookup} from './patch-guard';

// Autosave of one open file (docs/design-tool.md §Server API): the store's patches are composed while the
// user works and sent about a second after the last change, one request at a time, each on the version
// the previous one produced. Store-agnostic: the editor calls `push` from `store.onPatch` and shows
// the status in the title bar ("Saved" / "Saving…" / "Offline").
//
// Nothing the server would refuse is sent (patch-guard.ts): before each request the patch is checked with the
// server's schema; an entry it refuses, or one the server refused and named in its answer, is handed to `recover`,
// which puts it back as the server has it, and the rest is sent. An entry refused again after that, or a refusal
// that names nothing to put back, stops saving with status 'stopped' (`onStopped`): never a silent loop.

export type AutosaveStatus = 'saved' | 'saving' | 'offline' | 'error' | 'conflict' | 'stopped';
/** Why saving stopped: the entries refused (empty when the refusal named none) and the server's words, if any. */
export type AutosaveStop = {issues: readonly PatchIssue[]; message: string | null};
/** `context`: with co-editing on, the server's copy of every entry the patch changes (`before`), so the server can merge
 *  the patch into a newer version field by field, and the editor's connection (its own changes are not echoed to it). */
export type AutosaveRequest = (fileId: string, baseVersion: number, patch: DocumentPatch, init?: RequestInit, context?: DesignPatchContext) => Promise<DesignSaved>;
/** The merge step of shared/design/merge.ts, handed in by the realtime module (so the editor's first load does not carry it). */
export type RebaseStep = (state: LocalChanges, change: DocumentPatch) => Rebased;
type Timers = {setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void};
type PageEvents = {window?: EventTarget; document?: EventTarget & {visibilityState?: string}};

/** Recoveries in a row without a stored save before autosave gives up. */
const MAX_RECOVERIES = 4;

export type AutosaveOptions = {
  fileId: string;
  /** The version the editor opened. */
  baseVersion: number;
  onStatus: (status: AutosaveStatus) => void;
  /** Another tab or device saved first: autosave stops; the editor offers to reopen the file (the
   *  unsaved changes stay readable through `unsaved()`). */
  onConflict: (currentVersion: number | null) => void;
  /** A save was stored (`sent`: the patch it carried). With co-editing the answer may carry what the editor must apply to
   *  catch up (`changes`, `own`); the realtime module applies it here, before the next save goes. */
  onSaved?: (saved: DesignSaved, sent: DocumentPatch) => void;
  /** Co-editing: send `before` copies (the server merges a patch made on an older version) and this connection's id.
   *  `request`, when given, carries the save instead of `request` below (the socket's ops, DESIGN_COLLAB rust). */
  collaboration?: () => {client: string | null; request?: AutosaveRequest | null} | null;
  /** True while saving must wait (remote changes queued behind a drag): the save goes once it returns false and
   *  `resume()` is called. */
  hold?: () => boolean;
  /** Default: `patchDesignDocument` (src/design/api.ts), which carries the account header. */
  request?: AutosaveRequest;
  /** Puts refused entries back as the server has them (`saved`), in the editor's document and without an undo step;
   *  that change comes back through `push`. `source` is 'check' for this side's check, 'server' for the server's
   *  answer. Returns false when it could not. Without it a refused entry stops saving. */
  recover?: (issues: readonly PatchIssue[], saved: SavedLookup, source: 'check' | 'server') => boolean;
  /** Saving stopped (status 'stopped'): the editor says so until the file is reloaded, with a copy to download. */
  onStopped?: (stop: AutosaveStop) => void;
  /** A change over the server's cap for one PATCH (413 `design_document_too_large`: a paste of thousands of layers)
   *  goes as the whole document instead (`PUT`, a file may be larger than one change); what changes meanwhile follows as
   *  patches on the version it stored. Without it, such a change stops saving with the server's words. */
  whole?: {
    document: () => DesignDocument;
    request: (fileId: string, baseVersion: number, doc: DesignDocument) => Promise<DesignSaved>;
    /** The whole document was stored at `saved.version` (co-editing follows it). */
    onStored?: (saved: DesignSaved) => void;
  };
  /** Quiet time after the last change before a save. */
  debounceMs?: number;
  /** Continuous editing still saves at least this often. */
  maxWaitMs?: number;
  /** Waits between retries after a lost connection or a server error; the last one repeats. */
  retryDelays?: readonly number[];
  /** Where `pagehide`, `visibilitychange` and `online` are heard; null listens nowhere. Default: the page. */
  events?: PageEvents | null;
  timers?: Timers;
  now?: () => number;
};

export type Autosave = {
  /** A committed change of the document (`store.onPatch`), with the documents before and after it: without them
   *  only the shape of each entry is checked and nothing refused can be put back. */
  push(patch: DocumentPatch, docs?: PatchDocs): void;
  /** Send what is waiting now; resolves true once everything is stored, false if a save failed or stopped. */
  flush(): Promise<boolean>;
  /** The page is going away: hand a small pending patch to `fetch(..., {keepalive: true})`. */
  flushOnHide(): void;
  dispose(): void;
  /** The server version of the last stored state. */
  readonly version: number;
  readonly status: AutosaveStatus;
  /** Changes not stored yet (in flight included), or null. */
  unsaved(): DocumentPatch | null;
  /** Why saving stopped, while it is stopped. */
  readonly stop: AutosaveStop | null;
  /** A request is on its way. */
  busy(): boolean;
  /** Co-editing: the server's copy changed (`change`: its values of the entries it names) at `version`. The unsaved
   *  changes are re-based on it (`rebase`, shared/design/merge.ts `rebaseLocal`) and stay unsaved; the answer is what the
   *  editor's document `doc` must take (apply it with `store.applyRemote`). */
  serverChanged(change: DocumentPatch, doc: DesignDocument, version: number | null, rebase: RebaseStep): DocumentPatch;
  /** Co-editing: the entry as the server holds it (the value, null when the server has none), undefined when not known.
   *  Field-level remote changes (realtime/fields.ts) spread over this for a layer with unsaved changes here. */
  serverEntry?(table: PatchTable, key: string): unknown;
  /** Co-editing: a whole document of the server at `version` (a reload after a gap): the unsaved changes on top of it. */
  serverDocument(doc: DesignDocument, version: number, current: DesignDocument, rebase: RebaseStep): DesignDocument;
  /** The editor's document took a change from the server (`store.onPatch` with source 'remote'). */
  observe(patch: DocumentPatch, docs: PatchDocs): void;
  /** Saving may go on (after `hold` turned false). `keepDebounce`: a change still inside its debounce waits for it
   *  instead of going at once. */
  resume(how?: {keepDebounce?: boolean}): void;
  /** Co-editing on the socket: a save waits in the offline queue while the connection is down (its answer comes after
   *  the reconnect, never a second request): the status says "Offline" meanwhile and `flush` answers false. */
  connectivity(online: boolean): void;
};

type Failure = 'conflict' | 'rebase' | 'offline' | 'retry' | 'fatal' | 'invalid';
/** api() throws ApiError(message, status, details) for an answer and a TypeError when the network failed. */
function classify(error: unknown): Failure {
  const status = (error as {status?: unknown})?.status;
  const code = (error as {details?: {code?: unknown}})?.details?.code;
  // The socket's refusal of an op whose entries moved since its base: the editor has those changes coming (rebase).
  if (status === 409 && code === 'version_conflict') return (error as {details?: {rebase?: unknown}})?.details?.rebase === true ? 'rebase' : 'conflict';
  // The file moved to (or away from) the collab socket (lane B6): the live session switches its transport; the save goes again.
  if (status === 409 && code === 'collab_active') return 'offline';
  if ((status === 400 || status === 403) && code === 'design_document_invalid') return 'invalid';
  if (typeof status !== 'number' || status === 0 || status === 502 || status === 503 || status === 504) return 'offline';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'fatal';
}
/** 413 `design_document_too_large`: a PATCH over the cap of one change, or a whole document over the cap of a file. */
const tooLarge = (error: unknown) =>
  (error as {status?: unknown})?.status === 413 && (error as {details?: {code?: unknown}})?.details?.code === 'design_document_too_large';
const messageOf = (error: unknown) => {
  const message = (error as {message?: unknown})?.message;
  return typeof message === 'string' && message ? message : null;
};
const conflictVersion = (error: unknown) => {
  const value = (error as {details?: {currentVersion?: unknown}})?.details?.currentVersion;
  return typeof value === 'number' ? value : null;
};
const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Refusals over moved entries in a row before the save waits like any failed one (backoff). */
const MAX_REBASES = 5;

export function createAutosave(options: AutosaveOptions): Autosave {
  const request = options.request ?? patchDesignDocument,
    debounceMs = options.debounceMs ?? 800,
    maxWaitMs = options.maxWaitMs ?? 5_000,
    retryDelays = options.retryDelays?.length ? options.retryDelays : [1_000, 2_000, 5_000, 10_000, 30_000],
    timers: Timers = options.timers ?? {setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: handle => globalThis.clearTimeout(handle as number)},
    now = options.now ?? Date.now;
  let version = options.baseVersion,
    status: AutosaveStatus = 'saved',
    pending: DocumentPatch | null = null,
    inflight: DocumentPatch | null = null,
    firstPendingAt: number | null = null,
    debounce: unknown = null,
    retry: unknown = null,
    attempt = 0,
    stopped = false,
    disposed = false,
    stop: AutosaveStop | null = null,
    recoveries = 0,
    /** Co-editing on the socket: a refused op waits until the editor holds this version (the server's changes it was
     *  refused over), then goes again rebased on them; `rebases` counts the refusals in a row. */
    rebaseAt: number | null = null,
    rebases = 0,
    /** The socket is up (co-editing on the socket; always true otherwise). */
    online = true;
  let waiters: ((stored: boolean) => void)[] = [];
  const saved = createSavedState();
  /** Entries put back since the last stored save: refused again, they stop saving. */
  const recovered = new Set<string>();

  const setStatus = (next: AutosaveStatus) => {
    if (next === status) return;
    status = next;
    options.onStatus(next);
  };
  const settle = (stored: boolean) => {
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve(stored);
  };
  const clear = (handle: unknown) => {
    if (handle !== null) timers.clearTimeout(handle);
    return null;
  };

  /** The server's copy of every entry `patch` changes, as the editor knows it (co-editing). */
  function contextFor(patch: DocumentPatch): DesignPatchContext | undefined {
    const collaboration = options.collaboration?.();
    if (!collaboration || !saved.known) return undefined;
    const tables: DocumentPatch = {};
    let before: DesignPatchContext['before'];
    for (const table of PATCH_TABLES) {
      const changes = patch[table] as Record<string, unknown> | undefined;
      if (!changes) continue;
      const copies: Record<string, unknown> = {};
      for (const key of Object.keys(changes)) {
        const value = saved.entry(table, key);
        if (value !== undefined) copies[key] = value;
      }
      if (table === 'nodes') before = copies as DesignPatchContext['before'];
      else (tables as Record<string, unknown>)[table] = copies;
    }
    if (patch.pages) {
      const pages = saved.pages();
      if (pages) tables.pages = [...pages];
    }
    return {before: before ?? {}, beforeTables: tables, client: collaboration.client};
  }

  function schedule() {
    if (disposed || stopped || inflight || retry !== null || !pending) return;
    debounce = clear(debounce);
    const waited = firstPendingAt === null ? 0 : now() - firstPendingAt;
    debounce = timers.setTimeout(() => {
      debounce = null;
      send();
    }, Math.max(0, Math.min(debounceMs, maxWaitMs - waited)));
  }

  /** Saving stops for good: the editor offers a copy and a reload. Always false. */
  function halt(issues: readonly PatchIssue[], message: string | null): false {
    stopped = true;
    stop = {issues, message};
    debounce = clear(debounce);
    retry = clear(retry);
    setStatus('stopped');
    settle(false);
    options.onStopped?.(stop);
    return false;
  }

  /** Hands refused entries to `recover`. False, with saving stopped, when they cannot be put back: no recovery, the
   *  server's copy unknown, a refusal about a whole table, an entry put back once already, or too many in a row. */
  function recover(issues: readonly PatchIssue[], source: 'check' | 'server'): boolean {
    if (!options.recover || !saved.known) return halt(issues, null);
    if (issues.some(issue => issue.key === null && issue.table !== 'pages')) return halt(issues, null);
    if (issues.some(issue => recovered.has(entryId(issue))) || ++recoveries > MAX_RECOVERIES) return halt(issues, null);
    for (const issue of issues) recovered.add(entryId(issue));
    let done = false;
    try {
      done = options.recover(issues, saved, source);
    } catch {
      done = false;
    }
    if (!done) return halt(issues, null);
    prune();
    return true;
  }

  /** New entries the recovery took away again: the server never had them, so there is nothing to send. */
  function prune() {
    if (!pending) return;
    // A copy: the pending patch may be the store's own (its undo history holds it).
    const next: DocumentPatch = {...pending};
    for (const table of PATCH_TABLES) {
      const changes = pending[table] as Record<string, unknown> | undefined;
      if (!changes) continue;
      const kept: Record<string, unknown> = {};
      for (const key of Object.keys(changes)) {
        if (changes[key] === null && saved.entry(table, key) === null) saved.forget(table, key);
        else kept[key] = changes[key];
      }
      (next as Record<string, unknown>)[table] = kept;
    }
    pending = next;
    if (isEmptyPatch(pending)) {
      pending = null;
      firstPendingAt = null;
    }
  }

  /** Checks what is about to go. Refused entries are put back (their change comes back through `push`) and the
   *  rest is checked again. False when nothing is to be sent now: saving stopped, or nothing is left to save. */
  function guard(): boolean {
    for (let round = 0; pending; round++) {
      const issues = inspectPatch(pending, saved);
      if (!issues.length) return true;
      if (round >= MAX_RECOVERIES) return halt(issues, null);
      if (!recover(issues, 'check')) return false;
      // The recovery's own change was pushed and scheduled a send: this one goes now.
      debounce = clear(debounce);
    }
    if (!stopped) {
      setStatus('saved');
      settle(true);
    }
    return false;
  }

  function send(init?: RequestInit) {
    debounce = clear(debounce);
    if (disposed || stopped || inflight || !pending) return;
    // Refused over changes not here yet: it goes once they are (`resume` after they apply), or when the wait times out.
    if (rebaseAt !== null && version < rebaseAt) return;
    rebaseAt = null;
    // Remote changes wait behind a drag: the save goes after them (`resume`), so its copies match its version.
    if (options.hold?.()) return;
    if (!guard()) return;
    const patch = pending!,
      base = version;
    pending = null;
    firstPendingAt = null;
    inflight = patch;
    if (status !== 'offline') setStatus('saving');
    const context = contextFor(patch);
    const carrier = options.collaboration?.()?.request ?? request;
    const queued = carrier !== request && !online;
    if (queued) setStatus('offline');
    carrier(options.fileId, base, patch, init, context).then(
      answer => {
        if (disposed) return;
        inflight = null;
        attempt = 0;
        rebases = 0;
        recoveries = 0;
        recovered.clear();
        version = Math.max(version, answer.version);
        saved.stored(patch, pending);
        options.onSaved?.(answer, patch);
        if (pending) return send();
        setStatus('saved');
        settle(true);
      },
      (error: unknown) => {
        if (disposed) return;
        inflight = null;
        // Nothing is lost: the failed patch goes back in front of what came since.
        pending = pending ? composePatches(patch, pending) : patch;
        if (tooLarge(error)) {
          // One change too big for a PATCH: the whole document goes instead, or saving says why it cannot.
          if (options.whole) sendWhole();
          else halt([], messageOf(error));
          return;
        }
        failed(error, patch);
      },
    );
    // Queued for the socket while it is down: whoever waits for a flush learns now that it is not stored yet.
    if (queued) settle(false);
  }

  /** The whole document instead of a patch too big for one request (`options.whole`). */
  function sendWhole() {
    const whole = options.whole!;
    // Everything the document holds now and the server lacks; what changes from here on stays pending.
    const upTo = pending!,
      base = version,
      doc = whole.document();
    pending = null;
    firstPendingAt = null;
    inflight = upTo;
    if (status !== 'offline') setStatus('saving');
    whole.request(options.fileId, base, doc).then(
      answer => {
        if (disposed) return;
        inflight = null;
        attempt = 0;
        rebases = 0;
        recoveries = 0;
        recovered.clear();
        version = Math.max(version, answer.version);
        saved.stored(upTo, pending);
        whole.onStored?.(answer);
        if (pending) return send();
        setStatus('saved');
        settle(true);
      },
      (error: unknown) => {
        if (disposed) return;
        inflight = null;
        pending = pending ? composePatches(upTo, pending) : upTo;
        // Over the cap of a whole file too: the server's words, and a copy to download.
        if (tooLarge(error)) halt([], messageOf(error));
        else failed(error, upTo);
      },
    );
  }

  /** A save that failed (`sent`, back in front of `pending`): a conflict stops, a refused value is put back, a lost
   *  connection retries with backoff, anything else waits for the next change. */
  function failed(error: unknown, sent: DocumentPatch) {
    const failure = classify(error);
    if (failure === 'conflict') {
      stopped = true;
      setStatus('conflict');
      settle(false);
      options.onConflict(conflictVersion(error));
      return;
    }
    if (failure === 'rebase' && ++rebases <= MAX_REBASES) {
      // Not a conflict for the person: the patch is back in `pending`, the others' changes rebase it as they apply.
      rebaseAt = conflictVersion(error) ?? version + 1;
      retry = clear(retry);
      if (version >= rebaseAt) return send();
      retry = timers.setTimeout(() => {
        retry = null;
        rebaseAt = null;
        send();
      }, retryDelays[0]);
      return;
    }
    if (failure === 'invalid') {
      // The server refused a value this side's check let through: put back the entry it names, send the rest.
      const issue = refusedEntry(error, sent);
      if (!issue) {
        halt([], messageOf(error));
        return;
      }
      if (recover([issue], 'server')) send();
      return;
    }
    settle(false);
    if (failure === 'fatal') {
      // Repeating the same refused request would fail again; the next change tries anew.
      setStatus('error');
      return;
    }
    setStatus(failure === 'offline' ? 'offline' : 'error');
    const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
    attempt++;
    retry = timers.setTimeout(() => {
      retry = null;
      send();
    }, delay);
  }

  function retryNow() {
    if (retry === null) return;
    retry = clear(retry);
    send();
  }

  function flushOnHide() {
    if (disposed || stopped || inflight || !pending) return;
    retry = clear(retry);
    // Browsers cap the bodies of all keepalive requests in flight at 64 KiB; a larger patch goes as an
    // ordinary request, which may still finish if the page is only hidden.
    const small = byteLength(JSON.stringify({baseVersion: version, patch: pending, ...contextFor(pending)})) < DESIGN_KEEPALIVE_PATCH_BYTES;
    send(small ? {keepalive: true} : undefined);
  }

  const pageWindow = options.events === undefined ? (typeof window === 'undefined' ? undefined : window) : (options.events?.window ?? undefined);
  const pageDocument = options.events === undefined ? (typeof document === 'undefined' ? undefined : document) : (options.events?.document ?? undefined);
  const onPageHide = () => flushOnHide();
  const onVisibility = () => {
    if (pageDocument?.visibilityState === 'hidden') flushOnHide();
  };
  pageWindow?.addEventListener('pagehide', onPageHide);
  pageWindow?.addEventListener('online', retryNow);
  pageDocument?.addEventListener('visibilitychange', onVisibility);

  return {
    push(patch, docs) {
      if (disposed || isEmptyPatch(patch)) return;
      saved.note(patch, docs);
      pending = pending ? composePatches(pending, patch) : patch;
      if (stopped) return;
      if (firstPendingAt === null) firstPendingAt = now();
      if (status === 'saved' || status === 'error') setStatus('saving');
      schedule();
    },
    flush() {
      if (disposed || stopped) return Promise.resolve(!pending && !inflight);
      if (!pending && !inflight) return Promise.resolve(true);
      const done = new Promise<boolean>(resolve => waiters.push(resolve));
      retry = clear(retry);
      send();
      return done;
    },
    flushOnHide,
    dispose() {
      if (disposed) return;
      disposed = true;
      debounce = clear(debounce);
      retry = clear(retry);
      pageWindow?.removeEventListener('pagehide', onPageHide);
      pageWindow?.removeEventListener('online', retryNow);
      pageDocument?.removeEventListener('visibilitychange', onVisibility);
      settle(false);
    },
    get version() {
      return version;
    },
    get status() {
      return status;
    },
    unsaved() {
      if (inflight && pending) return composePatches(inflight, pending);
      return inflight ?? pending;
    },
    get stop() {
      return stop;
    },
    busy: () => inflight !== null,
    serverChanged(change, doc, at, rebase) {
      if (at !== null) version = Math.max(version, at);
      if (disposed || !saved.known) {
        // Nothing unsaved is tracked (or nothing can be): the server's values are shown as they are.
        return change;
      }
      const {local, server} = saved.changes(doc);
      const result = rebase({doc, local, server}, change);
      adoptRebase(result.local, result.server);
      return result.display;
    },
    serverEntry: (table, key) => (disposed ? undefined : saved.entry(table, key)),
    serverDocument(next, at, current, rebase) {
      version = Math.max(version, at);
      if (disposed || !saved.known) return next;
      const {local, server} = saved.changes(current);
      // Every entry involved takes the server's value from the new document.
      const change: DocumentPatch = {};
      for (const table of PATCH_TABLES) {
        const keys = new Set([...Object.keys((local[table] as object | undefined) ?? {}), ...Object.keys((server[table] as object | undefined) ?? {})]);
        if (!keys.size) continue;
        const values: Record<string, unknown> = {};
        const stored = next[table] as Record<string, unknown> | undefined;
        for (const key of keys) values[key] = stored && Object.hasOwn(stored, key) ? stored[key] : null;
        (change as Record<string, unknown>)[table] = values;
      }
      if (local.pages) change.pages = [...next.pages];
      const result = rebase({doc: next, local, server}, change);
      adoptRebase(result.local, result.server);
      return applyPatch(next, result.display);
    },
    observe(patch, docs) {
      saved.observe(patch, docs);
    },
    resume(how) {
      if (options.hold?.()) return;
      // The debounce still running: its timer sends (the hold stopped nothing yet).
      if (how?.keepDebounce && debounce !== null) return;
      send();
    },
    connectivity(next) {
      if (next === online) return;
      online = next;
      if (disposed || stopped) return;
      if (!online) {
        // The op stays queued and goes again after the reconnect; who waits for a flush learns it is not stored yet.
        if (inflight || pending) setStatus('offline');
        settle(false);
      } else if (status === 'offline') setStatus(inflight || pending ? 'saving' : 'saved');
    },
  };

  /** After a rebase: `local` is what still differs from the server (`server`). Entries only in flight stay out of the
   *  waiting patch (the server merges them itself); the rest waits for the next save. */
  function adoptRebase(local: DocumentPatch, server: DocumentPatch) {
    saved.reset(server);
    const next: DocumentPatch = {};
    let any = false;
    for (const table of PATCH_TABLES) {
      const changes = local[table] as Record<string, unknown> | undefined;
      if (!changes) continue;
      const waiting = pending?.[table] as Record<string, unknown> | undefined, sent = inflight?.[table] as Record<string, unknown> | undefined;
      const kept: Record<string, unknown> = {};
      for (const key of Object.keys(changes)) if ((waiting && Object.hasOwn(waiting, key)) || !(sent && Object.hasOwn(sent, key))) {
        kept[key] = changes[key];
        any = true;
      }
      if (Object.keys(kept).length) (next as Record<string, unknown>)[table] = kept;
    }
    if (local.pages && (pending?.pages || !inflight?.pages)) {
      next.pages = local.pages;
      any = true;
    }
    pending = any ? next : null;
    if (!pending) firstPendingAt = null;
    else if (firstPendingAt === null) firstPendingAt = now();
    if (pending && !stopped && (status === 'saved' || status === 'error')) setStatus('saving');
    if (!pending && !inflight && !stopped && status === 'saving') {
      setStatus('saved');
      settle(true);
    }
    schedule();
  }
}
