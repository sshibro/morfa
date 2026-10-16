import type {DesignFileOpened} from '../../shared/design/api';
import type {ServerMessage} from '../../shared/design/protocol';
import {memoryQueue, type ClientIdentity} from '../../src/design/realtime/offline-queue';
import {StreamRefused, type StreamEvent} from '../../src/design/realtime/stream';
import {sseTransport} from '../../src/design/realtime/transport/sse';
import type {LiveTransport} from '../../src/design/realtime/transport/types';
import {wsTransport, type SocketLike, type WsIo} from '../../src/design/realtime/transport/ws';

// The live session's tests run over both transports: a script written as SSE events (what today's
// stream sends) is played either on the SSE transport or, translated into the socket's messages
// (crates/protocol/schema.json), on the WebSocket transport over an in-memory socket.

export type TransportKind = 'sse' | 'ws';
export const TRANSPORTS: readonly TransportKind[] = ['sse', 'ws'];

/** One attempt: the events it delivers then the connection ends; `open` keeps it open; a refusal or an error throws. */
export type Attempt = StreamEvent[] | StreamRefused | Error | {events: StreamEvent[]; open: true};

/** An SSE event as the socket's message. */
export function toMessage(event: StreamEvent): ServerMessage | null {
  const data = JSON.parse(event.data) as Record<string, unknown>;
  switch (event.event) {
    case 'hello': {
      const {token: _token, ...rest} = data;
      return {t: 'welcome', ...rest} as ServerMessage;
    }
    case 'change':
    case 'file':
    case 'access':
    case 'bye':
    case 'presence':
    case 'leave':
      return {t: event.event, ...data} as ServerMessage;
    case 'resync':
      return {t: 'resync', version: (data.version as number | undefined) ?? 0};
    default:
      return null;
  }
}

/** A socket that plays a script after the client's hello. */
function scriptedSocket(script: {events: StreamEvent[]; open: boolean}, sent: unknown[]): SocketLike {
  const socket: SocketLike & {readyState: number} = {
    binaryType: 'arraybuffer',
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      const message = JSON.parse(String(data)) as {t: string};
      sent.push(message);
      if (message.t !== 'hello') return;
      for (const event of script.events) {
        const frame = toMessage(event);
        if (frame) socket.onmessage?.({data: JSON.stringify(frame)});
        // A script may stop the session (bye): nothing after it.
        if (socket.readyState !== 1) return;
      }
      if (!script.open) socket.close();
    },
    close() {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      queueMicrotask(() => socket.onclose?.({code: 1000, reason: ''}));
    },
  };
  queueMicrotask(() => {
    socket.readyState = 1;
    socket.onopen?.({});
  });
  return socket;
}

const normalize = (attempt: Attempt | undefined): {events: StreamEvent[]; open: boolean} | Error | null => {
  if (!attempt) return null;
  if (attempt instanceof Error) return attempt;
  if (Array.isArray(attempt)) return {events: attempt, open: false};
  return {events: attempt.events, open: true};
};

/** A transport of `kind` playing `attempts` (one per connection; after the last, a connection stays open and silent). */
export function scriptedTransport(kind: TransportKind, attempts: Attempt[], open: () => Promise<DesignFileOpened>, options: {sleep?: (ms: number, signal: AbortSignal) => Promise<void>; onAttempt?: () => void} = {}): LiveTransport & {sent: unknown[]} {
  let attempt = 0;
  const sleep = options.sleep ?? (async () => {});
  const sent: unknown[] = [];
  if (kind === 'sse') {
    const transport = sseTransport({
      async stream(_url, init, emit) {
        options.onAttempt?.();
        const script = normalize(attempts[attempt++]);
        if (script instanceof Error) throw script;
        if (script) for (const event of script.events) emit(event);
        if (!script || script.open) return new Promise(resolve => init.signal?.addEventListener('abort', () => resolve()));
      },
      open,
      presence: async (_fileId, post) => {
        sent.push(post);
        return true;
      },
      sleep,
    });
    return Object.assign(transport, {sent});
  }
  let current: {events: StreamEvent[]; open: boolean} | null = null;
  const io: WsIo = {
    async session() {
      options.onAttempt?.();
      const script = normalize(attempts[attempt++]);
      if (script instanceof Error) throw script;
      current = script ?? {events: [], open: true};
      return {wsUrl: 'ws://fake/collab/f', ticket: 'ticket'};
    },
    socket: () => scriptedSocket(current!, sent),
    open,
    snapshot: async () => {
      const opened = await open();
      return {version: opened.file.version, document: opened.document};
    },
    sleep,
    setInterval: () => 0,
    clearInterval: () => {},
  };
  return Object.assign(wsTransport({io}), {sent});
}

/** A fixed identity (no sessionStorage or Web Locks in Node). */
export function testIdentity(clientId = 'client-a', lastSeq = 0): () => Promise<ClientIdentity> {
  let seq = lastSeq;
  const identity: ClientIdentity = {
    clientId,
    get lastSeq() {
      return seq;
    },
    set lastSeq(value: number) {
      seq = value;
    },
    next: () => ++seq,
    atLeast(acked) {
      seq = Math.max(seq, acked);
    },
    release() {},
  };
  return async () => identity;
}

export {memoryQueue, StreamRefused};
