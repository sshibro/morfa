import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import type {DocumentPatch} from '../../../shared/design/patch';
import type {DesignPeer, DesignPresencePost} from '../../../shared/design/live';
import {db} from '../../db';
import {loadDatabaseConfig} from '../../postgresql/config';
import {postgresClientOptions} from '../../postgresql/connection-options';

// How live events reach the streams of other server processes (docs/design-tool.md "Co-editing"). Today
// the app runs as one process and `localFanOut` passes nothing on. With DESIGN_LIVE_FANOUT=postgres every process
// LISTENs on one PostgreSQL channel and announces its own events with pg_notify. A notification holds less than 8 000
// bytes: a longer event (a drag of 20 layers is ~9 KB) goes in numbered parts, all sent by one statement, so they reach
// every listener together and in order with the sender's other events, and the receiver puts them back together. Only an
// event over 1 MB travels without its body: a change as its version (the receiving streams reload the document), a
// presence without its selections. Nothing is stored.

export type FanOutMessage =
  | {kind: 'change'; fileId: string; version: number; patch: DocumentPatch | null; by: string | null; user: string}
  | {kind: 'reset'; fileId: string; version: number}
  | {kind: 'file'; fileId: string; name: string}
  | {kind: 'comments'; fileId: string}
  | {kind: 'meeting'; fileId: string; revision: number; user?: string; by?: string}
  | {kind: 'close'; fileId: string; reason: 'trashed' | 'erased'}
  | {kind: 'revalidate'; teamId?: string; fileId?: string; userId?: string}
  | {kind: 'collab'; fileId: string; mode: 'rust'; sessionUrl: string}
  /** `opened`: when each listed stream opened (ms since the epoch): who came first keeps their colour (hub.ts settleColors). */
  | {kind: 'presence'; fileId: string; peers: DesignPeer[]; left: string[]; opened?: Record<string, number>}
  /** A presence post that reached a process without its stream (Caddy balances each request on its own): the process holding
   *  the stream (`token`, the digest of its presence token) applies it. `session` is the digest of the poster's session. */
  | {kind: 'presence-post'; fileId: string; token: string; session: string; post: Omit<DesignPresencePost, 'token'>}
  /** A process opened a room for the file: the others say at once who they hold in it (not at their next announce). */
  | {kind: 'presence-ask'; fileId: string};

export interface LiveFanOut {
  /** Tells the other processes; never this one. */
  publish(message: FanOutMessage): void;
  /** Messages of the other processes; `lost` runs after a gap (the listening connection dropped and came back). */
  subscribe(handler: (message: FanOutMessage) => void, lost?: () => void): () => void;
  /** Resolves once this process hears the others (at once for one process). */
  ready(): Promise<void>;
  close(): Promise<void>;
}

export const localFanOut = (): LiveFanOut => ({publish() {}, subscribe: () => () => {}, ready: async () => {}, close: async () => {}});

const CHANNEL = 'morfa_design_live';
/** PostgreSQL refuses a notification payload of 8 000 bytes or more. */
const NOTIFY_LIMIT = 7_900;
/** An event longer than one notification goes in parts up to this size (~135 notifications); a longer one without its body. */
const SPLIT_LIMIT = 1024 * 1024;
/** A part: `P:<sender>:<event>:<index>:<count>:` and a slice of the event's JSON, cut between UTF-8 characters. */
const PART = /^P:([0-9a-f-]{36}):(\d{1,15}):(\d{1,4}):(\d{1,4}):/;
const PART_BYTES = NOTIFY_LIMIT - 80;
const MAX_PARTS = Math.ceil(SPLIT_LIMIT / (PART_BYTES - 3)) + 1;
/** Parts of an event that did not all arrive in this time are dropped (they always come in one transaction). */
const PARTS_WAIT_MS = 30_000;

/** `text` as slices of at most `size` UTF-8 bytes, never inside a character. */
export function splitUtf8(text: string, size: number): string[] {
  // A character takes up to four bytes: a smaller slice could not always hold one.
  if (size < 4) throw RangeError('A slice holds at least four bytes.');
  const bytes = Buffer.from(text);
  const out: string[] = [];
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(bytes.length, start + size);
    // A continuation byte (10xxxxxx) never starts a character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.toString('utf8', start, end));
    start = end;
  }
  return out;
}

export function postgresFanOut(): LiveFanOut {
  const instance = randomUUID();
  const handlers = new Set<{message: (message: FanOutMessage) => void; lost?: () => void}>();
  let client: Client | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let connectedOnce = false;
  let listening!: () => void;
  const ready = new Promise<void>(resolve => (listening = resolve));
  let sending: Promise<void> = Promise.resolve();
  let sent = 0;
  /** Events of other processes whose parts are arriving, by sender and event. */
  const assembling = new Map<string, {parts: (string | undefined)[]; got: number; at: number}>();
  const deliver = (payload: string) => {
    let data: {i?: unknown; m?: FanOutMessage};
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (data.i === instance || !data.m) return;
    for (const handler of handlers) handler.message(data.m);
  };
  const part = (payload: string) => {
    const head = PART.exec(payload);
    if (!head || head[1] === instance) return;
    const index = Number(head[3]),
      count = Number(head[4]);
    if (count < 2 || count > MAX_PARTS || index >= count) return;
    const now = Date.now();
    for (const [key, entry] of assembling) if (now - entry.at > PARTS_WAIT_MS) assembling.delete(key);
    const key = head[1] + ':' + head[2];
    let entry = assembling.get(key);
    if (!entry) assembling.set(key, (entry = {parts: new Array<string | undefined>(count), got: 0, at: now}));
    if (entry.parts.length !== count || entry.parts[index] !== undefined) return;
    entry.parts[index] = payload.slice(head[0].length);
    if (++entry.got < count) return;
    assembling.delete(key);
    deliver(entry.parts.join(''));
  };

  const reconnect = () => {
    if (closed || retry) return;
    const dropped = client;
    client = null;
    dropped?.removeAllListeners();
    dropped?.end().catch(() => {});
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, Math.min(30_000, 500 * 2 ** attempt++));
    retry.unref();
  };
  async function connect() {
    if (closed) return;
    const next = new Client(postgresClientOptions(loadDatabaseConfig('application')));
    next.on('error', reconnect);
    next.on('end', reconnect);
    next.on('notification', notification => {
      if (notification.channel !== CHANNEL || !notification.payload) return;
      if (notification.payload.startsWith('P:')) part(notification.payload);
      else deliver(notification.payload);
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${CHANNEL}`);
    } catch {
      client = next;
      reconnect();
      return;
    }
    if (closed) {
      await next.end().catch(() => {});
      return;
    }
    client = next;
    attempt = 0;
    // Notifications sent while this process was not listening are gone: the streams catch up by reloading.
    assembling.clear();
    if (connectedOnce) for (const handler of handlers) handler.lost?.();
    connectedOnce = true;
    listening();
  }
  void connect();

  return {
    publish(message) {
      if (closed) return;
      let payload = JSON.stringify({i: instance, m: message});
      if (Buffer.byteLength(payload) > SPLIT_LIMIT) {
        if (message.kind === 'change') payload = JSON.stringify({i: instance, m: {...message, patch: null}});
        else if (message.kind === 'presence') {
          const peers = message.peers.map(peer => ({...peer, selection: []}));
          payload = JSON.stringify({i: instance, m: {...message, peers}});
          // Still too large (a very crowded file whose people moved and chatted in one flush): one event per person, which always
          // fits (a presence without its selection is a few hundred bytes, cursor chat at most 100 characters).
          if (Buffer.byteLength(payload) > SPLIT_LIMIT && peers.length > 1) {
            peers.forEach((peer, index) => {
              const opened = message.opened?.[peer.connection];
              this.publish({kind: 'presence', fileId: message.fileId, peers: [peer], left: index ? [] : message.left, ...(opened !== undefined ? {opened: {[peer.connection]: opened}} : {})});
            });
            return;
          }
        }
        if (Buffer.byteLength(payload) > SPLIT_LIMIT) return;
      }
      const event = ++sent;
      const slices = Buffer.byteLength(payload) > NOTIFY_LIMIT ? splitUtf8(payload, PART_BYTES) : [payload];
      const parts = slices.length > 1 ? slices.map((slice, index) => `P:${instance}:${event}:${index}:${slices.length}:${slice}`) : slices;
      // One after another: notifications sent on different pool connections may arrive in any order, and a file's
      // changes must arrive in version order. The parts of one event go in one statement (one transaction): together.
      sending = sending
        .then(() =>
          parts.length > 1
            ? db.query('SELECT pg_notify($1,part) FROM unnest($2::text[]) AS part', [CHANNEL, parts])
            : db.query('SELECT pg_notify($1,$2)', [CHANNEL, parts[0]]),
        )
        .then(
          () => undefined,
          () => undefined,
        );
    },
    subscribe(message, lost) {
      const handler = {message, lost};
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    ready: () => ready,
    async close() {
      closed = true;
      if (retry) clearTimeout(retry);
      const current = client;
      client = null;
      current?.removeAllListeners();
      await current?.end().catch(() => {});
    },
  };
}
