import assert from 'node:assert/strict';

// A plain client of collab's socket for the api's tests (lane B6): Node's WebSocket, JSON text frames (`?wire=json`), the messages
// of crates/protocol/schema.json. The editor's own transport is lane B3's (src/design/realtime/transport/ws.ts); these tests drive
// the protocol by hand so they depend on nothing of it.

export type ServerMessage = {t: string; [key: string]: any};

export type CollabSocket = {
  messages: ServerMessage[];
  welcome: ServerMessage;
  readonly closed: boolean;
  send(message: Record<string, unknown>): void;
  /** The next message of type `t` (after those already taken) that matches. */
  next(t: string, match?: (message: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  /** Resolves when the socket closed (the server's bye, or the connection dropped). */
  ended(timeoutMs?: number): Promise<number>;
  close(): void;
};

export async function openSocket(
  session: {wsUrl: string; ticket: string},
  hello: {clientId: string; since?: number; lastSeq?: number; origin?: string},
): Promise<CollabSocket> {
  const url = new URL(session.wsUrl);
  url.searchParams.set('wire', 'json');
  const socket = new WebSocket(url.toString());
  const messages: ServerMessage[] = [];
  let waiters: (() => void)[] = [];
  let closed = false;
  let closedAt = 0;
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  socket.onmessage = event => {
    messages.push(JSON.parse(String(event.data)) as ServerMessage);
    wake();
  };
  socket.onclose = () => {
    closed = true;
    closedAt = performance.now();
    wake();
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(Error(`socket ${url} failed`));
  });
  socket.send(JSON.stringify({t: 'hello', ticket: session.ticket, clientId: hello.clientId, protocol: 1, ...(hello.since !== undefined ? {since: hello.since} : {}), ...(hello.lastSeq !== undefined ? {lastSeq: hello.lastSeq} : {})}));
  let read = 0;
  const wait = (timeoutMs: number) =>
    new Promise<void>(resolve => {
      waiters.push(resolve);
      setTimeout(resolve, Math.min(timeoutMs, 250));
    });
  const next = async (t: string, match: (message: ServerMessage) => boolean = () => true, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (; read < messages.length; read++) {
        const message = messages[read];
        if (message.t === t && match(message)) {
          read++;
          return message;
        }
      }
      if (closed) assert.fail(`the socket closed before «${t}» (${JSON.stringify(messages.map(m => m.t === 'bye' ? `bye:${m.reason}` : m.t))})`);
      if (Date.now() > deadline) assert.fail(`no «${t}» within ${timeoutMs} ms (${JSON.stringify(messages.map(m => m.t))})`);
      await wait(deadline - Date.now());
    }
  };
  const welcome = await next('welcome');
  return {
    messages,
    welcome,
    get closed() {
      return closed;
    },
    send: message => socket.send(JSON.stringify(message)),
    next,
    async ended(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!closed) {
        if (Date.now() > deadline) assert.fail(`the socket did not close within ${timeoutMs} ms`);
        await wait(deadline - Date.now());
      }
      return closedAt;
    },
    close: () => socket.close(1000, 'done'),
  };
}
