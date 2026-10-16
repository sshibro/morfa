import type {DesignDocument, SceneNode} from '../../../shared/design/types';
import {composePatches, diffDocuments, type DocumentPatch} from '../../../shared/design/patch';
import type {DesignChange, DesignPatchContext, DesignSaved} from '../../../shared/design/api';
import {documentTarget, mergeChange, rebaseLocal} from '../../../shared/design/merge';
import {normalizeDetailed} from '../../../shared/design/normalize';
import {DESIGN_LIVE, type DesignLiveBye, type DesignLiveHello} from '../../../shared/design/live';
import {PROTOCOL_ERROR_STATUS, type ClientOp} from '../../../shared/design/protocol';
import type {DesignTeamRole} from '../../../shared/design/teams';
import {apiGeneration, SESSION_CHANGED_EVENT} from '../../api';
import type {DesignStore} from '../engine/store';
import type {SessionPersistence} from '../editor/editor-session';
import type {AutosaveRequest} from '../persistence/autosave';
import {createLocalPresence, createPeerStore, type LocalPresence, type PeerStore} from './presence';
import {StreamRefused} from './stream';
import {commentsChanged} from '../comments/feed';
import {browserQueue, clientIdentity, type ClientIdentity, type OpQueue} from './offline-queue';
import {accountHeaders, sseTransport} from './transport/sse';
import {resolveChanges, toFieldOp, type ChangeFields} from './fields';
import type {LiveAck, LiveChange, LiveHandlers, LiveHello, LiveRefused, LiveResync, LiveTransport} from './transport/types';

// Co-editing of one open file (docs/design-tool.md "Co-editing"). The server orders every accepted change
// and numbers it; this editor follows that order exactly:
// - its own saves go through autosave with `before` copies; the answer brings the others' changes up to the save's
//   version and the server's version of the save, applied together (`onSaved`);
// - the others' changes arrive on the connection; while a save is on its way they wait (its answer brings them),
//   otherwise they apply in version order, the unsaved changes re-based on top with the server's own merge (rebaseLocal),
//   and never enter the undo history. A gap that does not close (a lost event, an answer lost on the way) reloads the
//   stored document under the unsaved changes;
// - undo after others' changes reverts only this person's fields (store.setHistoryRebase).
// Presence goes the other way, coalesced (presence.ts).
//
// The connection is a LiveTransport (transport/): today's SSE stream with PATCH saves, or the socket to `collab`
// (DESIGN_COLLAB rust, docs/BACKEND.md §2). On the socket a save is an `op` numbered by this tab's `seq`: it is kept in
// the offline queue (IndexedDB) until its ack, goes again after a reconnect with the same seq (the server de-duplicates),
// and its ack becomes the save's answer, with the others' changes up to its version taken from what the socket
// delivered before it. The model above does not change with the transport.

export type LiveStatus = 'connecting' | 'live' | 'offline';
export type LiveEnd = DesignLiveBye['reason'] | 'missing';

export type LiveCallbacks = {
  /** The role in the file differs from the one the editor opened with: an editor made a viewer or the reverse, or a developer
   *  made a viewer or the reverse (the "Code" tab is a developer's). */
  onAccess(access: {role: DesignTeamRole; canEdit: boolean}): void;
  /** The stream ended for good: no access, signed out, the file went to the trash or was erased. */
  onEnd(reason: LiveEnd): void;
  onRename(name: string): void;
  onStatus?(status: LiveStatus): void;
};

export type {LiveTransport} from './transport/types';

export type LiveSession = {
  readonly peers: PeerStore;
  readonly presence: LocalPresence;
  /** The version of the server's document this editor shows (with its unsaved changes on top). */
  version(): number;
  status(): LiveStatus;
  /** This editor's connection, while the stream is open. */
  connection(): string | null;
  /** The last `hello` of the stream (who this editor is in the file), null before the first. */
  hello(): DesignLiveHello | null;
  /** Every event of the stream after the session handled it (the meeting module reads `hello`, `access` and `meeting`). */
  listen(listener: (name: string, data: unknown) => void): () => void;
  /** The transport in use, once chosen ('sse' or 'ws'). */
  transport(): LiveTransport['kind'] | null;
  /** Socket: ops sent and not acked yet (the offline queue). */
  unacked(): number;
  stop(): void;
};

/** A gap in the versions closes by itself within this time, or the stored document is reloaded. */
const GAP_MS = 2_500;
/** A reload that failed (the network), tried again after this: the stream moved past what it could not apply. */
const RESYNC_RETRY_MS = 5_000;
/** Others' changes from the stream apply at most this often: a lone change at once, a burst from many people as one
 *  document update. Each update copies the layer table (20 000 entries in a big file) and redraws what changed, so ten
 *  people editing cost at most 20 of them a second, not one per edit. */
export const REMOTE_APPLY_MS = 50;
/** When an update takes long (a huge file on a slow machine) the next waits ten times what it took, up to this: others'
 *  changes then never hold more than about a tenth of the main thread, however many people edit. */
export const REMOTE_APPLY_MAX_MS = 250;

/** One op of this tab not acked yet. `answer` is autosave's request waiting for it; an op left by an earlier life of the
 *  tab (a reload) has none: its ack applies it like someone else's change. */
type PendingOp = {op: ClientOp; sent: boolean; answer: {resolve(saved: DesignSaved): void; reject(error: unknown): void} | null};

/** A refusal of an op as autosave reads an api error (status, details.code ...). */
function refusalError(refused: LiveRefused): Error {
  const status = (PROTOCOL_ERROR_STATUS as Record<string, number>)[refused.code] ?? 400;
  const details: Record<string, unknown> = {code: refused.code};
  if (refused.currentVersion !== undefined) details.currentVersion = refused.currentVersion;
  if (refused.path !== undefined) details.path = refused.path;
  if (refused.nodeId !== undefined) details.entry = {table: 'nodes', key: refused.nodeId};
  // The socket brings the changes the op was refused over: autosave rebases on them and sends again (no conflict).
  if (refused.code === 'version_conflict') details.rebase = true;
  return Object.assign(new Error(refused.message ?? 'File not saved.'), {status, details});
}

export function startLiveSession(options: {
  fileId: string;
  store: DesignStore;
  persistence: SessionPersistence;
  /** The version the editor opened. */
  version: number;
  canEdit: boolean;
  /** The role the editor opened with (a team file); absent, only a change of `canEdit` counts. */
  role?: DesignTeamRole;
  callbacks: LiveCallbacks;
  /** The connection, or how to pick it (DESIGN_COLLAB from /api/config, index.tsx). Default: SSE. */
  transport?: LiveTransport | (() => Promise<LiveTransport>);
  /** Socket: the offline queue (default IndexedDB) and this tab's identity (default sessionStorage + Web Locks). */
  queue?: OpQueue;
  identity?: (fileId: string, options?: {orphans?: readonly string[]}) => Promise<ClientIdentity>;
  /** Tests: the clock of the gap and silence watches (`now` also paces others' changes; without it they apply at once). */
  timers?: {setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now?(): number};
  /** Where `online` is heard (the window): the network coming back cuts a reconnect's wait short. */
  network?: EventTarget | null;
}): LiveSession {
  const {fileId, store, persistence, callbacks} = options;
  const setTimeout = options.timers?.setTimeout ?? ((run: () => void, ms: number) => globalThis.setTimeout(run, ms));
  const clearTimeout = options.timers?.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const now = options.timers ? options.timers.now ?? null : () => performance.now();
  const peers = createPeerStore();
  let transport: LiveTransport | null = typeof options.transport === 'object' ? options.transport : options.transport ? null : sseTransport();
  let version = options.version;
  let connection: string | null = null;
  let status: LiveStatus = 'connecting';
  let stopped = false;
  let controller: AbortController | null = null;
  let silence: unknown = null;
  let gap: unknown = null;
  let resyncRetry: ReturnType<typeof setTimeout> | null = null;
  let resyncing = false;
  let resyncAfterSave = false;
  /** Where the next reload comes from (the socket's snapshot or document), and the version it must reach. */
  let resyncSource: LiveResync | null = null;
  let canEdit = options.canEdit;
  let role: DesignTeamRole | null = options.role ?? null;
  /** A role or edit right other than the editor's: it reopens. */
  const accessChanged = (next: {role: DesignTeamRole; canEdit: boolean}) => {
    const changed = next.canEdit !== canEdit || (role !== null && next.role !== role);
    canEdit = next.canEdit;
    if (role !== null) role = next.role;
    if (changed) callbacks.onAccess({role: next.role, canEdit: next.canEdit});
  };
  let ended = false;
  let lastHello: DesignLiveHello | null = null;
  const listeners = new Set<(name: string, data: unknown) => void>();
  /** The server lays out what it merges (DESIGN_SERVER_LAYOUT=1, from the hello or a save's answer): no corrections here.
   *  Collab's hello carries no `layout` (it does not lay out), so on the socket it stays false. */
  let serverLayout = false;
  /** When others' changes last applied and what that took, and the pump waiting for its turn since then. */
  let appliedAt = -Infinity;
  let applyMs = 0;
  let paced: unknown = null;
  /** Changes of the stream waiting for their turn, by their first version (a composite covers first..version). */
  const waiting = new Map<number, LiveChange>();
  /** Takes a change in; false when it starts at or below this editor's version but ends above it (a composite that
   *  cannot be cut): the stored document is reloaded instead. */
  const receive = (change: LiveChange) => {
    if (change.version <= version) return true;
    const first = change.first ?? change.version;
    if (first <= version) return false;
    waiting.set(first, change);
    return true;
  };

  // Socket only: this tab's identity, the ops not acked yet (by seq, in order) and an ack waiting for its changes.
  let queue: OpQueue | null = options.queue ?? null;
  let identity: ClientIdentity | null = null;
  const ops = new Map<number, PendingOp>();
  let heldAck: {ack: LiveAck; timer: unknown} | null = null;

  const setStatus = (next: LiveStatus) => {
    if (next === status) return;
    status = next;
    callbacks.onStatus?.(next);
    // "Offline" in the title bar while an op waits for the socket.
    if (transport?.sendsOps) persistence.autosave()?.connectivity(next === 'live');
  };
  const autosave = () => persistence.autosave();

  const presence = createLocalPresence(post => (transport ? transport.presence(fileId, post) : Promise.resolve(false)), {
    intervalMs: () => transport?.presenceMs ?? DESIGN_LIVE.presenceMs,
    onGone: () => controller?.abort(),
  });

  // ── The server's order ──

  /** The server's changes up to `at` (and `own`, its version of this editor's save) go into the document. Field-level
   *  nodes (protocol 2) are spread over the server's node as this editor holds it: the document's, or for a layer with
   *  unsaved changes here, the server's copy autosave keeps. */
  function apply(changes: readonly (DesignChange & {fields?: ChangeFields})[], own: DocumentPatch | null, at: number) {
    const started = now?.() ?? 0;
    version = Math.max(version, at);
    // Through the store's queue even when empty: autosave's version moves only once what came before has applied.
    let combined: string[] = [];
    let unresolved = false;
    store.applyRemote(state => {
      const saving = autosave();
      const unsaved = saving?.unsaved()?.nodes;
      const patch = resolveChanges(changes, own, id => {
        if (unsaved && Object.hasOwn(unsaved, id)) {
          const server = saving?.serverEntry?.('nodes', id);
          if (server !== undefined) return server as SceneNode | null;
        }
        return state.doc.nodes[id];
      });
      if (!patch) {
        // The server changed a layer this editor does not hold as it was: reload what the server has.
        unresolved = true;
        return {};
      }
      if (!saving) return patch;
      // Layers this editor has unsaved changes to are combined with the others' here: they are laid out again below.
      if (unsaved && patch.nodes) combined = Object.keys(patch.nodes).filter(id => Object.hasOwn(unsaved, id));
      return saving.serverChanged(patch, state.doc, at, rebaseLocal);
    });
    store.afterRemote(() => {
      if (unresolved) return void resync();
      if (combined.length && !serverLayout) relayout(combined);
      autosave()?.resume();
    });
    // What the update took here (the store's listeners included; nothing when it waits for a gesture to end).
    appliedAt = now?.() ?? 0;
    applyMs = appliedAt - started;
  }

  /** pump() for a change of the stream, at most every REMOTE_APPLY_MS, or ten times the last update (see there). */
  function pumpSoon() {
    if (paced !== null) return;
    const wait = now ? appliedAt + Math.min(REMOTE_APPLY_MAX_MS, Math.max(REMOTE_APPLY_MS, applyMs * 10)) - now() : 0;
    if (wait <= 0) return pump();
    paced = setTimeout(() => {
      paced = null;
      if (!stopped) pump();
    }, wait);
  }

  /** Applies the waiting changes that are next in order; a save on its way brings them itself. */
  function pump() {
    if (autosave()?.busy() || resyncing) return;
    const ready: LiveChange[] = [];
    let at = version;
    for (let next = waiting.get(at + 1); next; next = waiting.get(at + 1)) {
      ready.push(next);
      waiting.delete(at + 1);
      at = next.version;
    }
    if (ready.length) apply(ready, null, at);
    for (const key of waiting.keys()) if (key <= version) waiting.delete(key);
    watchGap();
  }

  function watchGap() {
    if (waiting.size && !gap) {
      gap = setTimeout(() => {
        gap = null;
        if (waiting.size && !autosave()?.busy()) void resync();
      }, GAP_MS);
    } else if (!waiting.size && gap && !heldAck) {
      clearTimeout(gap);
      gap = null;
    }
  }

  /**
   * The server merged this editor's save into others' changes, and it cannot measure text or lay out frames: the layouts
   * around what the merge wrote are run here, once, as this editor's own correction (no undo step), and saved. Only
   * the editor whose save was merged does it, so two editors never correct each other back and forth.
   */
  function relayout(ids: readonly string[]) {
    if (stopped || store.readOnly) return;
    const doc = store.getState().doc;
    const present = ids.filter(id => doc.nodes[id]);
    if (!present.length) return;
    let result: ReturnType<typeof normalizeDetailed>;
    try {
      result = normalizeDetailed(doc, new Set(present), {measurer: store.measurer});
    } catch {
      return;
    }
    const writes = [...result.changed].filter(id => result.doc.nodes[id] && doc.nodes[id] && result.doc.nodes[id] !== doc.nodes[id]);
    if (!writes.length) return;
    store.transact('Co-editing', tx => {
      for (const id of writes) {
        const {id: _id, parentId: _parent, children: _children, ...fields} = result.doc.nodes[id];
        tx.update(id, fields);
      }
    }, {history: false});
  }

  function onSaved(answer: DesignSaved) {
    if (answer.resync) {
      void resync();
      return;
    }
    const changes = (answer.changes ?? []).filter(change => change.version > version);
    if (answer.version >= version) apply(changes, answer.own ?? null, answer.version);
    if (answer.layout === 'server') serverLayout = true;
    // This editor's own layers the server put next to others' changes (`own`, or its field op spread over them).
    const own = (answer.changes as LiveChange[] | undefined)?.find(change => change.own);
    const merged = [...Object.keys(answer.own?.nodes ?? {}), ...Object.keys(own?.patch.nodes ?? {}), ...Object.keys(own?.fields ?? {})];
    if (merged.length && answer.layout !== 'server') store.afterRemote(() => relayout(merged));
    if (resyncAfterSave) {
      resyncAfterSave = false;
      void resync();
      return;
    }
    pump();
  }

  /** The stored document, with this editor's unsaved changes on top: after a gap, a replaced document or a reconnect too late. */
  async function resync() {
    if (resyncing || stopped || !transport) return;
    if (autosave()?.busy()) {
      resyncAfterSave = true;
      return;
    }
    resyncing = true;
    const source = resyncSource;
    resyncSource = null;
    try {
      // A snapshot older than what this editor already applied would go back in time: the api's copy instead.
      const opened = await transport.open(fileId, source && (source.version ?? 0) >= version ? source : undefined);
      if (stopped) return;
      if (resyncRetry) clearTimeout(resyncRetry);
      resyncRetry = null;
      version = opened.file.version;
      for (const key of waiting.keys()) if (key <= version) waiting.delete(key);
      const next: DesignDocument = opened.document;
      store.applyRemote(state => {
        const saving = autosave();
        const doc = saving ? saving.serverDocument(next, opened.file.version, state.doc, rebaseLocal) : next;
        return diffDocuments(state.doc, doc);
      });
      store.afterRemote(() => autosave()?.resume());
    } catch {
      // Again shortly: the version moved on past what this editor could not apply (or never got), so neither the stream nor a
      // reconnect (`since` that version) would bring it back.
      if (!stopped && !resyncRetry)
        resyncRetry = setTimeout(() => {
          resyncRetry = null;
          resyncSource ??= source;
          void resync();
        }, RESYNC_RETRY_MS);
    } finally {
      resyncing = false;
      // Saves held during the reload go (after the reloaded document, which `hold` waits for while it is queued).
      autosave()?.resume();
    }
    pump();
  }

  // ── Ops on the socket (the offline queue) ──

  /** autosave's request on the socket: the save becomes an op with the next seq, kept until its ack. */
  const opRequest: AutosaveRequest = (_fileId, baseVersion, patch, _init, context?: DesignPatchContext) =>
    new Promise<DesignSaved>((resolve, reject) => {
      if (!identity || !transport) return reject(Object.assign(new TypeError('Offline.'), {status: 0}));
      const seq = identity.next();
      const op: ClientOp = {t: 'op', seq, baseVersion, patch, ...(context?.before ? {before: context.before} : {}), ...(context?.beforeTables ? {beforeTables: context.beforeTables} : {})};
      const entry: PendingOp = {op, sent: false, answer: {resolve, reject}};
      ops.set(seq, entry);
      void queue?.put({fileId, clientId: identity.clientId, seq, op, queuedAt: Date.now()}).catch(() => undefined);
      if (status === 'live') entry.sent = transport.send(op);
    });

  function forget(seq: number) {
    ops.delete(seq);
    if (identity) void queue?.remove(fileId, identity.clientId, seq).catch(() => undefined);
  }

  /** The changes the socket delivered after this editor's version up to `at`, or null while one is missing. */
  function delivered(at: number): LiveChange[] | null {
    const list: LiveChange[] = [];
    for (let v = version + 1; v <= at; ) {
      const change = waiting.get(v);
      if (change) {
        // A composite reaching past the op cannot be cut at it.
        if (change.version > at) return null;
        list.push(change);
        v = change.version + 1;
      } else if (v === at) v++;
      // The op's own version may be absent (the server does not echo it): the ack stands for it.
      else return null;
    }
    return list;
  }

  function onAck(ack: LiveAck) {
    const entry = ops.get(ack.seq);
    if (!entry) return;
    if (heldAck && heldAck.ack.seq !== ack.seq) return;
    const changes = ack.version > version ? delivered(ack.version) : [];
    if (changes === null) {
      // A change before the op was not delivered (skipped under backpressure): ask for it, and reload if it never comes.
      if (!heldAck) {
        heldAck = {ack, timer: setTimeout(() => {
          const held = heldAck;
          heldAck = null;
          if (held) settleOp(held.ack.seq, {version: held.ack.version, updatedAt: '', resync: true});
        }, GAP_MS)};
        transport?.pull(version);
      }
      return;
    }
    if (heldAck) {
      clearTimeout(heldAck.timer);
      heldAck = null;
    }
    // The op's own change, when the socket carried it (a catch-up after a reconnect), is part of what the server stored.
    // An ack without `own` means the op landed as sent (collab sends `own` only when the merge adjusted it; Node's PATCH
    // also when the save was behind): when others' changes landed between its base and it, the sent values are the
    // server's and go on top of them, or those changes would overwrite this editor's values (diverged from the server).
    // Not when the socket delivered the op's own stored change (a catch-up): that change is what the server holds.
    const landed = changes.some(change => change.version === ack.version);
    // Protocol 2 sent the op's layers as the fields it wrote: "as sent" is those fields over the server's layers (the others'
    // changes to their other fields stay), so the op goes in as the last change, spread like anyone's (realtime/fields.ts).
    const sent = ack.own || landed ? null : sentChange(entry.op, ack.version);
    const own = ack.own ?? (!landed && !sent && entry.op.baseVersion < ack.version - 1 ? entry.op.patch : null);
    const answered = sent && entry.op.baseVersion < ack.version - 1 ? [...changes, sent] : changes;
    if (entry.answer) settleOp(ack.seq, {version: ack.version, updatedAt: '', ...(answered.length ? {changes: answered} : {}), ...(own ? {own} : {})});
    else {
      // An op of an earlier life of this tab: the editor never showed it, so it applies like someone else's change.
      forget(ack.seq);
      if (ack.version > version && !waiting.has(ack.version))
        waiting.set(ack.version, sent ?? {version: ack.version, patch: own ? composePatches(entry.op.patch, own) : entry.op.patch, by: null, user: ''});
      pump();
    }
  }

  /** The op as the change the server stored when it landed as sent: its field-level layers spread over the server's (protocol 2),
   *  or null when it went whole (no `before` copies: nothing to send as fields). */
  function sentChange(op: ClientOp, at: number): LiveChange | null {
    if (transport?.kind !== 'ws') return null;
    const field = toFieldOp(op);
    if (!field.fields) return null;
    const {set = {}, unset = {}} = field.fields;
    const fields: ChangeFields = {};
    for (const id of new Set([...Object.keys(set), ...Object.keys(unset)])) fields[id] = {...(set[id] ? {set: set[id]} : {}), ...(unset[id] ? {unset: unset[id]} : {})};
    return {version: at, patch: field.patch, fields, by: null, user: '', own: true};
  }

  function settleOp(seq: number, answer: DesignSaved) {
    const entry = ops.get(seq);
    forget(seq);
    entry?.answer?.resolve(answer);
  }

  function onRefused(refused: LiveRefused) {
    const entry = ops.get(refused.seq);
    if (!entry) return;
    if (heldAck?.ack.seq === refused.seq) {
      clearTimeout(heldAck.timer);
      heldAck = null;
    }
    forget(refused.seq);
    // Not stored: autosave puts the patch back and decides (rebase, retry, put a value back, the whole document, stop).
    entry.answer?.reject(refusalError(refused));
    // The changes (or the reload) behind the refusal waited for this save: they go once autosave has taken the answer.
    setTimeout(() => {
      if (stopped) return;
      if (resyncAfterSave) {
        resyncAfterSave = false;
        void resync();
      } else pump();
    }, 0);
  }

  /** After `welcome`: ops above what the server holds go again in seq order; the ops it holds (their acks lost) are
   *  answered from the catch-up that follows the welcome (answerStored). */
  function resend(hello: LiveHello) {
    if (!transport?.sendsOps || !identity) return;
    const acked = hello.ackedSeq ?? 0;
    identity.atLeast(acked);
    for (const [seq, entry] of [...ops]) {
      if (seq > acked || entry.sent) continue;
      // Numbered but never sent, below what the server holds (a lost counter): it takes a fresh seq.
      ops.delete(seq);
      void queue?.remove(fileId, identity.clientId, seq).catch(() => undefined);
      const next = identity.next();
      entry.op = {...entry.op, seq: next};
      ops.set(next, entry);
      void queue?.put({fileId, clientId: identity.clientId, seq: next, op: entry.op, queuedAt: Date.now()}).catch(() => undefined);
    }
    for (const entry of [...ops.values()].sort((a, b) => a.op.seq - b.op.seq)) if (entry.op.seq > acked) entry.sent = transport.send(entry.op) || entry.sent;
    stored = {hello, acked, timer: null};
    answerStored();
  }

  /** The welcome whose stored ops wait for their catch-up, and the watch that stops waiting. */
  let stored: {hello: LiveHello; acked: number; timer: unknown} | null = null;

  /** True when the changes up to `at` are here (or applied). */
  function reaches(at: number) {
    for (let v = version; v < at; ) {
      const change = waiting.get(v + 1);
      if (!change) return false;
      v = change.version;
    }
    return true;
  }

  /**
   * The ops the server already holds (seq ≤ ackedSeq) are answered from the catch-up: the change the server stored for
   * each is there, carrying this tab's clientId and seq (or inside a composite: answered at its end). An op of an
   * earlier life of the tab is simply dropped (its change applies like anyone's). Without the catch-up (a reload, or it
   * never came within GAP_MS) the save's answer asks for a reload of the stored document, which holds the op.
   */
  function answerStored(force = false) {
    if (!stored || !identity) return;
    const {hello, acked} = stored;
    const held = [...ops].filter(([seq, entry]) => seq <= acked && entry.sent);
    if (!held.length) return void clearStored();
    if (!force && !hello.resync && !reaches(hello.version)) {
      stored.timer ??= setTimeout(() => answerStored(true), GAP_MS);
      return;
    }
    clearStored();
    for (const [seq, entry] of held) {
      let at: number | null = null;
      for (const change of waiting.values()) {
        if (change.client === identity.clientId && change.seq === seq) at = change.version;
        else if (change.ops?.some(op => op.client === identity!.clientId && op.seq === seq)) at = change.version;
      }
      if (!entry.answer) forget(seq);
      else if (at !== null) onAck({seq, version: at});
      else settleOp(seq, {version: hello.version, updatedAt: '', resync: true});
    }
  }

  function clearStored() {
    if (stored?.timer) clearTimeout(stored.timer);
    stored = null;
  }

  // ── The connection ──

  const handlers: LiveHandlers = {
    hello(hello) {
      attempt = 0;
      // An ack held for a missing change on the last connection: the op is answered again from this welcome (resend).
      if (heldAck) {
        clearTimeout(heldAck.timer);
        heldAck = null;
      }
      lastHello = hello;
      // Each connection says again whether the server lays out (an SSE hello from Node with DESIGN_SERVER_LAYOUT=1);
      // collab's welcome never does, so a switch to the socket turns it off.
      serverLayout = hello.layout === 'server';
      connection = hello.connection;
      peers.reset(hello.peers, {connection: hello.connection, user: hello.user});
      if (hello.resync) {
        resyncSource = {version: hello.version, ...(hello.snapshotUrl ? {snapshotUrl: hello.snapshotUrl} : {})};
      }
      setStatus('live');
      presence.connected(hello.token);
      accessChanged({role: hello.role, canEdit: hello.canEdit});
      resend(hello);
      // The catch-up follows in `changes` frames; after a resync without a snapshot, a document frame.
      if (hello.resync && hello.snapshotUrl) void resync();
      else if (!hello.resync) pump();
    },
    change(change) {
      if (!receive(change)) return void resync();
      if (stored) answerStored();
      if (heldAck) onAck(heldAck.ack);
      pumpSoon();
    },
    changes(list) {
      // One apply for the frame: 1 000 changes taken one by one cost seconds (a store update and rebase each).
      for (const change of list) if (!receive(change)) return void resync();
      if (stored) answerStored();
      if (heldAck) onAck(heldAck.ack);
      pumpSoon();
    },
    ack: onAck,
    refused: onRefused,
    presence: list => peers.update(list),
    leave: id => peers.leave(id),
    access: accessChanged,
    file: name => callbacks.onRename(name),
    comments: () => commentsChanged(fileId),
    resync(source) {
      if (source.document || source.snapshotUrl) resyncSource = source;
      // An ack held for changes that will not come (the server answers with the document instead, B1 M9): the document
      // holds the op, so the save is answered with it now rather than after GAP_MS.
      if (heldAck && source.document && (source.version ?? -1) >= heldAck.ack.version) {
        const held = heldAck;
        clearTimeout(held.timer);
        heldAck = null;
        settleOp(held.ack.seq, {version: held.ack.version, updatedAt: '', resync: true});
        return;
      }
      void resync();
    },
    rollback(at) {
      // The journal lost the changes above `at`: they are gone everywhere. Reload what the server holds.
      for (const key of waiting.keys()) if (key > at) waiting.delete(key);
      if (version > at) void resync();
    },
    catchUp(from) {
      transport?.pull(Math.min(version, from - 1));
    },
    bye(reason) {
      // Signed out elsewhere (or the session expired): the app reads the session again and shows the sign-in, as a refused
      // stream or a refused save does, rather than an editor that looks live and hears nothing.
      if (reason === 'session' && typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
      if (reason === 'access' || reason === 'session' || reason === 'trashed' || reason === 'erased') end(reason);
    },
    raw(name, data) {
      // The server put the file on collab (lane B6, `collab {mode: rust}`): move to the socket without a reload.
      if (name === 'collab' && transport && !transport.sendsOps) repickTransport();
      for (const listener of [...listeners]) listener(name, data);
    },
    activity: () => watch(),
  };

  function end(reason: LiveEnd) {
    if (ended) return;
    ended = true;
    stopped = true;
    network?.removeEventListener('online', online);
    controller?.abort();
    pause?.abort();
    peers.clear();
    callbacks.onEnd(reason);
  }

  const watch = () => {
    if (silence) clearTimeout(silence);
    silence = setTimeout(() => controller?.abort(), DESIGN_LIVE.silenceMs);
  };

  let attempt = 0;
  /** The transport is picked again (DESIGN_COLLAB moved for this file, lane B6): set by the server's word, taken by run(). */
  let repick = false;
  function repickTransport() {
    if (typeof options.transport !== 'function') return;
    repick = true;
    controller?.abort();
    pause?.abort();
  }

  /** Ops waiting on the socket when it is left: their saves go again (autosave retries them; on SSE they become PATCHes). */
  function leaveSocket() {
    for (const [seq, entry] of [...ops]) {
      forget(seq);
      entry.answer?.reject(Object.assign(new TypeError('Switching connection.'), {status: 0}));
    }
    if (heldAck) clearTimeout(heldAck.timer);
    heldAck = null;
    clearStored();
    identity?.release();
    identity = null;
  }

  /** Takes the identity and the queue of the socket (run() at the start, and after a switch to the socket). */
  async function joinSocket(): Promise<boolean> {
    // Ops an earlier life of this tab left unacked (a reload, a crash), or a closed tab whose id this one adopts: they
    // go after the welcome like any other.
    const left = await (queue ??= browserQueue()).load(fileId).catch(() => []);
    identity = await (options.identity ?? clientIdentity)(fileId, {orphans: [...new Set(left.map(entry => entry.clientId))]}).catch(() => null);
    if (stopped) {
      identity?.release();
      return false;
    }
    if (!identity) transport = sseTransport();
    else {
      for (const entry of left) if (entry.clientId === identity.clientId && !ops.has(entry.seq)) ops.set(entry.seq, {op: entry.op, sent: true, answer: null});
      identity.atLeast(Math.max(0, ...left.filter(entry => entry.clientId === identity!.clientId).map(entry => entry.seq)));
    }
    return true;
  }

  async function switchTransport() {
    let next: LiveTransport;
    try {
      next = await (options.transport as () => Promise<LiveTransport>)();
    } catch {
      return;
    }
    if (stopped || !transport || next.kind === transport.kind) return;
    if (transport.sendsOps) leaveSocket();
    transport = next;
    if (transport.sendsOps && !(await joinSocket())) return;
    attempt = 0;
    // As at the start: a save the switch held goes now, a change still inside its debounce waits for it.
    autosave()?.resume({keepDebounce: true});
  }

  async function run() {
    if (!transport) {
      try {
        transport = await (options.transport as () => Promise<LiveTransport>)();
      } catch {
        transport = sseTransport();
      }
      if (stopped) return;
    }
    if (transport.sendsOps && !(await joinSocket())) return;
    // Saves waited for the choice of transport (`hold`); they go now, by PATCH or as ops. A change still inside its
    // debounce keeps it: the first edits of a file opened a moment ago go as one save, as before the hold existed.
    autosave()?.resume({keepDebounce: true});
    while (!stopped) {
      const generation = apiGeneration();
      controller = new AbortController();
      setStatus(attempt ? 'offline' : 'connecting');
      let retryAfter = 0;
      try {
        watch();
        await transport.connect({fileId, since: version, clientId: identity?.clientId ?? '', lastSeq: identity?.lastSeq ?? 0, signal: controller.signal, headers: accountHeaders()}, handlers);
      } catch (error) {
        if (stopped) break;
        const refused = error instanceof StreamRefused ? error : null;
        if (refused) {
          if (refused.status === 404) {
            // The file itself gone or out of reach: leave. Only the stream missing (an older server): edit on without it.
            const reachable = await transport.open(fileId).then(() => true, (failure: unknown) => (failure as {status?: unknown})?.status !== 404);
            if (!reachable) return end('missing');
            retryAfter = 5 * 60_000;
          }
          // The file left collab (lane B6, /session 409 collab_inactive): back to SSE + PATCH, no reload.
          if (refused.status === 409 && refused.code === 'collab_inactive' && typeof options.transport === 'function') repick = true;
          else if (refused.status === 401 || refused.status === 409) {
            // Signed out or another account in this browser: the app's own check takes over.
            if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
            return end('session');
          }
          if (refused.status === 429) retryAfter = 15_000;
          // Switched off by the operator: saves still merge and bring the others' changes; look again later.
          if (refused.code === 'design_live_off') retryAfter = 5 * 60_000;
        }
      } finally {
        if (silence) clearTimeout(silence);
        silence = null;
      }
      if (stopped || generation !== apiGeneration()) break;
      connection = null;
      presence.disconnected();
      peers.stale();
      if (repick) {
        repick = false;
        await switchTransport();
        if (stopped) break;
        continue;
      }
      setStatus('offline');
      const delays = DESIGN_LIVE.reconnectMs;
      const wait = Math.max(retryAfter, delays[Math.min(attempt, delays.length - 1)] * (0.8 + Math.random() * 0.4));
      attempt++;
      pause = new AbortController();
      await transport.sleep(wait, pause.signal);
    }
  }
  let pause: AbortController | null = null;
  // Back online: reconnect now rather than after the rest of the back-off (up to 20 s after a long outage), as Figma does.
  const network = options.network === undefined ? (typeof window === 'undefined' ? null : window) : options.network;
  const online = () => pause?.abort();
  network?.addEventListener('online', online);

  // ── Wiring ──

  persistence.setCollaboration({
    client: () => connection,
    // A save waits while remote changes wait behind a drag (its `before` copies must match its version), and until the
    // transport is chosen (a PATCH to a file the socket owns would be refused).
    // While a reload is on its way, no save: one made now would claim the reloaded version with copies (`before`) of the
    // document before it, and the server, at that version, would store it without merging (stale fields win).
    hold: () => resyncing || store.remotePending() > 0 || !transport || (transport.sendsOps && !identity),
    request: () => (transport?.sendsOps && identity ? opRequest : null),
    onSaved: answer => onSaved(answer),
    onReset(next) {
      version = next;
      waiting.clear();
    },
  });
  store.setHistoryRebase((doc, step, expected) => mergeChange(documentTarget(doc), step, expected).patch);
  void run();

  return {
    peers,
    presence,
    version: () => version,
    status: () => status,
    connection: () => connection,
    hello: () => lastHello,
    listen(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    transport: () => transport?.kind ?? null,
    unacked: () => ops.size,
    stop() {
      stopped = true;
      network?.removeEventListener('online', online);
      controller?.abort();
      pause?.abort();
      if (gap) clearTimeout(gap);
      if (resyncRetry) clearTimeout(resyncRetry);
      if (paced !== null) clearTimeout(paced);
      if (silence) clearTimeout(silence);
      if (heldAck) clearTimeout(heldAck.timer);
      clearStored();
      presence.dispose();
      persistence.setCollaboration(null);
      store.setHistoryRebase(null);
      peers.clear();
      identity?.release();
      // Ops still unacked stay in the queue for the next open of the file in this tab.
    },
  };
}

