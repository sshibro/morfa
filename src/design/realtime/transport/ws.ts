import type {DesignFileOpened} from '../../../../shared/design/api';
import type {DesignPeer, DesignPresencePost} from '../../../../shared/design/live';
import {PROTOCOL_LIMITS, PROTOCOL_VERSION, type ClientMessage, type ClientOp, type ServerMessage, type ServerWelcome} from '../../../../shared/design/protocol';
import {openDesignFile} from '../../api';
import {StreamRefused} from '../stream';
import {LARGE_FRAME} from './frame-decoder';
import {toFieldOp} from '../fields';
import {engineWasm, engineWasmLoaded} from '../../../../shared/design/engine-switch';
import {documentOf} from '../../../../shared/design/parts';
import {accountHeaders} from './sse';
import {sleep, type LiveConnect, type LiveHandlers, type LiveHello, type LiveResync, type LiveTransport} from './types';

// The socket to `collab` (DESIGN_COLLAB rust; docs/BACKEND.md §2, crates/protocol/schema.json). Loaded with `import()`
// only when the switch says rust, so the SSE path never carries it.
//
// One WebSocket per open file per tab: `GET /api/design-files/:id/session` (api) names the node and mints a 60 s ticket,
// the first frame is `hello {ticket, clientId, since, lastSeq}`, the server answers `welcome` (with the catch-up or a
// reload) and from then on carries ops, acks, the others' changes and presence both ways.
//
// The wire is a codec (WireCodec): JSON text frames (`?wire=json`, the default, the fake server and debugging) or the
// binary wire (`?wire=bin`, lane B1's crates/protocol/src/binary.rs) through crates/wasm's `decode_frame` and
// `encode_frame`: a frame decodes into the same message objects, so switching is `binaryCodec(wasm)` and nothing else
// (TARGETS §3b). Large frames of either wire decode in the worker (decode-worker.ts).

/** What a frame is on the wire. `decode` returns the message as the schema describes it. */
export type WireCodec = {
  readonly wire: 'json' | 'binary';
  encode(message: ClientMessage): string | Uint8Array;
  decode(data: string | ArrayBuffer | Uint8Array): ServerMessage;
};

const textDecoder = typeof TextDecoder === 'undefined' ? null : new TextDecoder();

export const jsonCodec: WireCodec = {
  wire: 'json',
  encode: message => JSON.stringify(message),
  decode(data) {
    const text = typeof data === 'string' ? data : textDecoder!.decode(data);
    return JSON.parse(text) as ServerMessage;
  },
};

/** The exports of crates/wasm the binary wire needs (`crates/wasm/src/protocol.rs`). */
export type WasmWire = {
  /** One server frame (`?wire=bin`, crates/protocol/src/binary.rs) → the JSON text the JSON wire would carry. */
  decode_frame(bytes: Uint8Array): string;
  /** One client message as JSON → its binary frame. */
  encode_frame(json: string): Uint8Array;
  /** `decode_frame` with a catch-up's consecutive changes composed into one inside WASM (frame-decoder.ts
   *  `composeChanges`'s result): the decode worker's path for large frames. */
  decode_frame_composed?(bytes: Uint8Array): string;
};

/** The binary wire through the WASM build: the frame becomes the JSON wire's text inside WASM and `JSON.parse` makes the
 *  objects (faster in V8 than building them across the boundary). A text frame is the JSON wire's (the server never
 *  sends one on `?wire=bin`; a proxy's error page would be one). */
export function binaryCodec(wasm: WasmWire): WireCodec {
  return {
    wire: 'binary',
    encode: message => wasm.encode_frame(JSON.stringify(message)),
    decode(data) {
      if (typeof data === 'string') return JSON.parse(data) as ServerMessage;
      return JSON.parse(wasm.decode_frame(data instanceof Uint8Array ? data : new Uint8Array(data))) as ServerMessage;
    },
  };
}

/** `GET /api/design-files/:id/session` (api, lane B6): where the file's actor runs and the ticket for it. */
export type CollabSession = {wsUrl: string; ticket: string};

/** The parts of a WebSocket the transport uses (the browser's, Node's, or a test's). */
export type SocketLike = {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: {data: unknown}) => void) | null;
  onclose: ((event: {code: number; reason: string}) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

/** Decodes large frames off the main thread (frame-decoder.ts), in order of arrival. A frame the decoder could not read
 *  rejects with a `DecodeFailed` that hands its bytes back (they were moved to the worker): the transport then decodes
 *  it on the main thread, so a catch-up is never lost to a worker that failed (the WASM not loading in it, say). */
export type FrameDecoder = {decode(data: string | ArrayBuffer): Promise<ServerMessage>; close(): void};

export class DecodeFailed extends Error {
  constructor(
    message: string,
    readonly data: string | ArrayBuffer | null,
  ) {
    super(message);
  }
}

/** The browser's decoder: one module worker, created on the first large frame. */
export function workerDecoder(): FrameDecoder | null {
  if (typeof Worker === 'undefined') return null;
  let worker: Worker | null = null;
  let next = 0;
  const waiting = new Map<number, {resolve(message: ServerMessage): void; reject(error: unknown): void}>();
  const start = () => {
    worker = new Worker(new URL('./decode-worker.ts', import.meta.url), {type: 'module'});
    worker.onmessage = (event: MessageEvent<{id: number; message?: ServerMessage; error?: string; data?: string | ArrayBuffer}>) => {
      const entry = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      if (event.data.message) entry?.resolve(event.data.message);
      else entry?.reject(new DecodeFailed(event.data.error ?? 'decode failed', event.data.data ?? null));
    };
    worker.onerror = () => {
      for (const entry of waiting.values()) entry.reject(new DecodeFailed('decode worker failed', null));
      waiting.clear();
      worker = null;
    };
    return worker;
  };
  return {
    decode(data) {
      const id = next++;
      return new Promise<ServerMessage>((resolve, reject) => {
        waiting.set(id, {resolve, reject});
        // A frame's bytes move to the worker (no copy); text is copied, as postMessage does.
        (worker ?? start()).postMessage({id, data}, typeof data === 'string' ? [] : [data]);
      });
    },
    close() {
      worker?.terminate();
      worker = null;
    },
  };
}

export type WsIo = {
  session(fileId: string, headers: Record<string, string>, signal: AbortSignal): Promise<CollabSession>;
  socket(url: string): SocketLike;
  open(fileId: string): Promise<DesignFileOpened>;
  /** The server's snapshot of the document (a reload beyond the journal's tail, BACKEND §2). */
  snapshot(url: string): Promise<{version?: number; document: DesignFileOpened['document']}>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Large frames go here (either wire: the worker tells a binary frame by its first byte); absent, every frame
   *  decodes on the main thread. */
  decoder?: () => FrameDecoder | null;
};

async function refusal(response: Response): Promise<StreamRefused> {
  let message = 'Could not connect to co-editing.',
    code: string | null = null;
  try {
    const body = (await response.json()) as {error?: unknown; code?: unknown};
    if (typeof body.error === 'string') message = body.error;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // Not our JSON (a proxy's page).
  }
  return new StreamRefused(message, response.status, code);
}

export const browserWsIo: WsIo = {
  async session(fileId, headers, signal) {
    const response = await fetch(`/api/design-files/${encodeURIComponent(fileId)}/session`, {credentials: 'same-origin', cache: 'no-store', signal, headers: {Accept: 'application/json', ...headers}});
    if (!response.ok) throw await refusal(response);
    return (await response.json()) as CollabSession;
  },
  socket: url => new WebSocket(url) as unknown as SocketLike,
  open: fileId => openDesignFile(fileId),
  async snapshot(url) {
    const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store'});
    if (!response.ok) throw await refusal(response);
    // api's checkpoint: the document in the model's binary codec at X-Design-Version.
    if (!(response.headers.get('Content-Type') ?? '').includes('json')) {
      const header = response.headers.get('X-Design-Version');
      const version = header === null || header === '' ? NaN : Number(header);
      if (!Number.isSafeInteger(version)) throw new Error('checkpoint: no X-Design-Version');
      return {version, document: await checkpointDocument(new Uint8Array(await response.arrayBuffer()))};
    }
    const body = (await response.json()) as {version?: number; document?: DesignFileOpened['document']} & DesignFileOpened['document'];
    // Either {version, document} or the document itself.
    return body.document && typeof body.document === 'object' && 'nodes' in body.document ? {version: body.version, document: body.document} : {document: body};
  },
  sleep,
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: handle => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  decoder: workerDecoder,
};

/** The engine's browser loader, a lazy chunk (Node loads its own build on first use). */
const loadEngineLoader = () => import('../../engine/engine-wasm');

/** The document of checkpoint bytes (an `MRFA` frame): decoded in the engine's wasm, read back in parts, never as one
 *  JSON text of the file. The engine module loads first in the browser (Node loads its own build on first use). */
export async function checkpointDocument(bytes: Uint8Array): Promise<DesignFileOpened['document']> {
  if (!engineWasmLoaded() && typeof window !== 'undefined') await (await loadEngineLoader()).loadEngineWasm();
  const handle = engineWasm().MorfaDoc.decode_from(bytes);
  try {
    return documentOf(handle) as DesignFileOpened['document'];
  } finally {
    handle.free();
  }
}

/** The socket URL with the wire named (the server picks the codec from it). */
export function socketUrl(wsUrl: string, wire: WireCodec['wire']): string {
  const base = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  const url = new URL(wsUrl, base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  // The server's names (crates/protocol `Wire`): `json`, `bin`.
  url.searchParams.set('wire', wire === 'binary' ? 'bin' : 'json');
  return url.toString();
}

const OPEN = 1;

/** `welcome` as the session's hello (the SSE hello's fields, the socket's catch-up and seq on top). */
export function helloOf(welcome: ServerWelcome): LiveHello {
  return {
    connection: welcome.connection,
    // Presence on the socket needs no secret; the connection id stands in for it.
    token: welcome.connection,
    version: welcome.version,
    role: welcome.role,
    canEdit: welcome.canEdit,
    user: welcome.user,
    name: welcome.name,
    color: welcome.color,
    peers: welcome.peers as DesignPeer[],
    ...(welcome.ackedSeq !== undefined ? {ackedSeq: welcome.ackedSeq} : {}),
    ...(welcome.resync ? {resync: true} : {}),
    ...(welcome.snapshotUrl ? {snapshotUrl: welcome.snapshotUrl} : {}),
  };
}

/** One server message into the handlers. */
export function dispatchMessage(message: ServerMessage, handlers: LiveHandlers) {
  switch (message.t) {
    case 'welcome': {
      const hello = helloOf(message);
      handlers.hello(hello);
      handlers.raw('hello', hello);
      return;
    }
    case 'ack':
      handlers.ack({seq: message.seq, version: message.version, ...(message.own ? {own: message.own} : {})});
      return;
    case 'refused':
      handlers.refused(message);
      return;
    case 'change': {
      const {t: _t, ...change} = message;
      handlers.change(change);
      handlers.raw('change', change);
      return;
    }
    case 'changes':
      handlers.changes(message.changes);
      for (const change of message.changes) handlers.raw('change', change);
      return;
    case 'catchUp':
      handlers.catchUp(message.from, message.to);
      return;
    case 'presence':
      // The schema names emote ids as strings; the editor's MeetingEmote lists them (unknown ones are not drawn).
      handlers.presence(message.peers as DesignPeer[]);
      handlers.raw('presence', {peers: message.peers});
      return;
    case 'leave':
      handlers.leave(message.connection);
      handlers.raw('leave', {connection: message.connection});
      return;
    case 'access': {
      const access = {role: message.role, canEdit: message.canEdit};
      handlers.access(access);
      handlers.raw('access', access);
      return;
    }
    case 'file':
      handlers.file(message.name);
      handlers.raw('file', {name: message.name});
      return;
    case 'comments':
      handlers.comments();
      handlers.raw('comments', {});
      return;
    case 'meeting': {
      // The SSE `meeting` event's data: the meeting module reads it again (only the named user's own votes when `user` is set).
      const meeting = {revision: message.revision, ...(message.user !== undefined ? {user: message.user} : {})};
      handlers.raw('meeting', meeting);
      return;
    }
    case 'rollback':
      handlers.rollback(message.version);
      return;
    case 'resync':
      handlers.resync({version: message.version, ...(message.snapshotUrl ? {snapshotUrl: message.snapshotUrl} : {})});
      handlers.raw('resync', {version: message.version});
      return;
    case 'document':
      handlers.resync({version: message.version, document: message.document});
      return;
    case 'bye':
      handlers.bye(message.reason);
      handlers.raw('bye', {reason: message.reason});
      return;
    case 'pong':
    case 'error':
      return;
  }
}

export type WsTransportOptions = {io?: WsIo; codec?: WireCodec};

export function wsTransport(options: WsTransportOptions = {}): LiveTransport {
  const io = options.io ?? browserWsIo;
  const codec = options.codec ?? jsonCodec;
  let socket: SocketLike | null = null;
  let decoder: FrameDecoder | null | undefined;
  const size = (data: unknown) => (typeof data === 'string' ? data.length : data instanceof ArrayBuffer ? data.byteLength : 0);
  /** Ops and presence go only after `welcome` (the server reads `hello` first). */
  let welcomed = false;
  const write = (message: ClientMessage) => {
    if (!socket || socket.readyState !== OPEN || !welcomed) return false;
    socket.send(codec.encode(message));
    return true;
  };

  return {
    kind: 'ws',
    sendsOps: true,
    presenceMs: PROTOCOL_LIMITS.presenceFlushMs,
    async connect(connect: LiveConnect, handlers: LiveHandlers) {
      const {ticket, wsUrl} = await io.session(connect.fileId, connect.headers, connect.signal);
      if (connect.signal.aborted) return;
      const ws = io.socket(socketUrl(wsUrl, codec.wire));
      ws.binaryType = 'arraybuffer';
      socket = ws;
      welcomed = false;
      let ping: unknown = null;
      /** Frames decoding in the worker, and the frames behind them: dispatched in the order they arrived. */
      let order: Promise<void> = Promise.resolve();
      let queued = 0;
      let closed = false;
      const deliver = (message: ServerMessage) => {
        if (closed) return;
        if (message.t === 'welcome') welcomed = true;
        dispatchMessage(message, handlers);
      };
      try {
        await new Promise<void>((resolve, reject) => {
          let opened = false;
          const abort = () => ws.close(1000, 'closed');
          connect.signal.addEventListener('abort', abort, {once: true});
          ws.onopen = () => {
            opened = true;
            ws.send(codec.encode({t: 'hello', ticket, clientId: connect.clientId, since: connect.since, lastSeq: connect.lastSeq, protocol: PROTOCOL_VERSION}));
            ping = io.setInterval(() => {
              if (ws.readyState === OPEN) ws.send(codec.encode({t: 'ping'}));
            }, PROTOCOL_LIMITS.pingMs);
          };
          ws.onmessage = event => {
            handlers.activity();
            const data = event.data as string | ArrayBuffer;
            if (size(data) >= LARGE_FRAME && (decoder ??= io.decoder?.() ?? null)) {
              // A catch-up: decoded and composed in the worker; what arrives meanwhile waits behind it. A frame the
              // worker could not read comes back and is decoded here.
              const decoding = decoder.decode(data);
              queued++;
              order = order
                .then(() => decoding)
                .then(deliver, (error: unknown) => {
                  const back = error instanceof DecodeFailed ? error.data : typeof data === 'string' ? data : null;
                  if (back !== null) deliver(codec.decode(back));
                })
                .catch(() => undefined)
                .finally(() => void queued--);
              return;
            }
            let message: ServerMessage;
            try {
              message = codec.decode(data);
            } catch {
              return;
            }
            if (queued) order = order.then(() => deliver(message));
            else deliver(message);
          };
          // An error before the socket opened is the failed attempt (a close may never follow it: Node's WebSocket closed
          // while connecting); after it opened, the close that follows ends the connection.
          ws.onerror = () => {
            if (opened || connect.signal.aborted) return;
            connect.signal.removeEventListener('abort', abort);
            reject(new TypeError('WebSocket failed before it opened'));
            try {
              ws.close();
            } catch {
              // Already closing.
            }
          };
          ws.onclose = () => {
            connect.signal.removeEventListener('abort', abort);
            // A socket that never opened is a network failure (the next attempt backs off); a closed one ended once the
            // frames it delivered are handled (a reconnect's welcome never overtakes them).
            if (!opened && !connect.signal.aborted) return reject(new TypeError('WebSocket closed before it opened'));
            void order.then(() => {
              closed = true;
              resolve();
            });
          };
        });
      } finally {
        if (ping !== null) io.clearInterval(ping);
        if (socket === ws) {
          socket = null;
          welcomed = false;
        }
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      }
    },
    // Protocol 2: the nodes the op changes go as the fields it wrote (realtime/fields.ts).
    send: (op: ClientOp) => write(toFieldOp(op)),
    pull: since => void write({t: 'pull', since}),
    async presence(_fileId, post: DesignPresencePost) {
      const {token: _token, ...fields} = post;
      return write({t: 'presence', ...fields});
    },
    async open(fileId, resync?: LiveResync) {
      if (resync?.document) return {file: {version: resync.version ?? 0}, document: resync.document} as DesignFileOpened;
      if (resync?.snapshotUrl) {
        try {
          const snapshot = await io.snapshot(resync.snapshotUrl);
          return {file: {version: snapshot.version ?? resync.version ?? 0}, document: snapshot.document} as DesignFileOpened;
        } catch {
          // The checkpoint is not served (503: the file opens the usual way, 413, a decode that fails): the api's copy.
          // The changes the server sent after the checkpoint below its version are dropped by the session.
          return io.open(fileId);
        }
      }
      return io.open(fileId);
    },
    sleep: (ms, signal) => io.sleep(ms, signal),
  };
}

