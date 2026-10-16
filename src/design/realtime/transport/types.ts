import type {DesignFileOpened} from '../../../../shared/design/api';
import type {DesignLiveBye, DesignLiveChange, DesignLiveHello, DesignPeer, DesignPresencePost} from '../../../../shared/design/live';
import type {DocumentPatch} from '../../../../shared/design/patch';
import type {ClientOp, ProtocolErrorCode} from '../../../../shared/design/protocol';
import type {DesignTeamRole} from '../../../../shared/design/teams';
import type {ChangeFields} from '../fields';

// How one open file talks to the server (docs/BACKEND.md §2 and §7). Two transports carry the same
// events into live-session.ts, which keeps the one model of co-editing (the server's order, `own`, resync, rebase):
// - `sse` (DESIGN_COLLAB legacy and shadow): today's stream down (`GET /:id/events`), presence posts and PATCH saves up;
//   autosave sends its own requests.
// - `ws` (DESIGN_COLLAB rust): one WebSocket to `collab` carries everything; saves are `op` frames numbered by `seq`,
//   kept in the offline queue until acked (live-session.ts).

/** A change of someone else, as the session orders it. `client`/`seq` name the op (socket only): after a reconnect the
 *  catch-up may hold this editor's own op whose ack was lost. */
export type LiveChange = DesignLiveChange & {
  client?: string;
  seq?: number;
  /** A composite of consecutive changes `first`..`version` (a large catch-up composed in the decode worker), with the
   *  ops of each client it holds. */
  first?: number;
  ops?: {client: string; seq: number; version: number}[];
  /** Socket, protocol 2: nodes the file had, as the fields that changed (realtime/fields.ts); spread over the editor's
   *  node at the previous version. */
  fields?: ChangeFields;
  /** This editor's own op as the server stored it (live-session: an ack of a field op that landed as sent). */
  own?: true;
};

/** The first event of a connection, both transports alike (the SSE `hello`; the socket's `welcome`). */
export type LiveHello = DesignLiveHello & {
  /** Socket: the highest seq of this clientId the server holds (ops above it are re-sent). */
  ackedSeq?: number;
  /** Socket: the client's version is too old for a catch-up: reload (`snapshotUrl`, or the document event that follows). */
  resync?: boolean;
  snapshotUrl?: string;
};

/** Where a reload comes from: the server's snapshot, a document it sent, or (absent) the api's GET of the file. */
export type LiveResync = {version?: number; snapshotUrl?: string; document?: DesignFileOpened['document']};

export type LiveAck = {seq: number; version: number; own?: DocumentPatch};
export type LiveRefused = {seq: number; code: ProtocolErrorCode; currentVersion?: number; path?: string; nodeId?: string; message?: string};

/** Everything a connection reports; `raw` sees every event under its SSE name for the session's listeners (meeting). */
export type LiveHandlers = {
  hello(hello: LiveHello): void;
  change(change: LiveChange): void;
  /** Several changes in one frame (a catch-up, the answer to a pull): taken in together and applied as one (socket). */
  changes(changes: readonly LiveChange[]): void;
  ack(ack: LiveAck): void;
  refused(refused: LiveRefused): void;
  presence(peers: DesignPeer[]): void;
  leave(connection: string): void;
  access(access: {role: DesignTeamRole; canEdit: boolean}): void;
  file(name: string): void;
  comments(): void;
  resync(resync: LiveResync): void;
  /** A journal commit failed after fan-out: changes above `version` are gone (socket). */
  rollback(version: number): void;
  /** The server skipped changes from..to under backpressure (socket): pull them when ready. */
  catchUp(from: number, to: number): void;
  bye(reason: DesignLiveBye['reason'] | string): void;
  /** Every event, under the SSE event name, after the session handled it. */
  raw(name: string, data: unknown): void;
  /** Bytes or a heartbeat arrived: the silence watch restarts. */
  activity(): void;
};

/** What a connection asks for. */
export type LiveConnect = {
  fileId: string;
  /** The version the editor holds (changes after it are caught up). */
  since: number;
  /** Socket: this tab's id for op seqs, and the highest seq it gave out. */
  clientId: string;
  lastSeq: number;
  signal: AbortSignal;
  headers: Record<string, string>;
};

/** Thrown by `connect` when the server refuses (the SSE stream's StreamRefused, or the socket's session request). */
export type LiveRefusal = Error & {status: number; code: string | null};

export interface LiveTransport {
  readonly kind: 'sse' | 'ws';
  /** Saves go through `send` (ops with seq), not autosave's PATCH. */
  readonly sendsOps: boolean;
  /** How often this editor may send its presence (ms): 60 on the SSE path, 33 (30 Hz) on the socket. */
  readonly presenceMs: number;
  /** Opens one connection and reports its events until it ends: resolves when it closed, rejects on a refusal
   *  (LiveRefusal) or a network failure. */
  connect(options: LiveConnect, handlers: LiveHandlers): Promise<void>;
  /** Socket: one op; false when no connection is open (it stays queued and goes after the next welcome). */
  send(op: ClientOp): boolean;
  /** Socket: asks for the changes after `since` (after a catchUp). */
  pull(since: number): void;
  /** This editor's presence; false when the connection is gone. */
  presence(fileId: string, post: DesignPresencePost): Promise<boolean>;
  /** The stored document for a reload (api's GET, or the server's snapshot). */
  open(fileId: string, resync?: LiveResync): Promise<DesignFileOpened>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, {once: true});
  });
