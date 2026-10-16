// One editor on the Rust collab path (lane B5), as the browser's live session talks to it (B3; crates/protocol): GET /session
// for a ticket and the node's socket, `hello {ticket, clientId, since, lastSeq}`, ops with a per-client `seq`, and after a
// `bye` or a closed socket a reconnect through /session that re-sends every unacked op with its seq (journaled ones are
// re-acked by the next owner, never re-applied). crates/loadgen has no reconnect, so the benches that kill or drain a node,
// freeze PostgreSQL or measure a catch-up use this client.
import type {SceneNode} from '../../../shared/design/types';
import {cookieOf, type Account} from './fixtures';
import type {BenchServer} from './server';

export type Ack = {seq: number; version: number; at: number};
export type Reconnect = {reason: string; downAt: number; upAt?: number; from: string; to?: string};
type Session = {wsUrl: string; ticket: string; version: number; node: string};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class CollabEditor {
  readonly clientId: string;
  seq = 0;
  known = 0;
  node = '';
  socket: WebSocket | null = null;
  welcomes = 0;
  resyncs = 0;
  /** When the last hello went out and its welcome came (performance.now()). */
  helloAt = NaN;
  welcomeAt = NaN;
  readonly unacked = new Map<number, string>();
  readonly acked: Ack[] = [];
  readonly reconnects: Reconnect[] = [];
  readonly byes: Record<string, number> = {};
  readonly refused: Record<string, number> = {};
  /** Reconnect after a bye or a closed socket (off for a client that leaves on purpose). */
  reconnect = true;
  /** Called with each change's version as it arrives (catch-up measurements). */
  onVersion: ((version: number, at: number) => void) | null = null;
  private lastBye = 'closed';

  constructor(readonly server: BenchServer, readonly account: Account, readonly fileId: string, clientId?: string) {
    this.clientId = clientId ?? `bench-${account.id.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async session(): Promise<Session | null> {
    const response = await fetch(`${this.server.base}/api/design-files/${this.fileId}/session`, {headers: {cookie: cookieOf(this.account)}}).catch(() => null);
    if (!response || response.status !== 200) return null;
    return (await response.json()) as Session;
  }

  /** Joins through /session, retrying (with backoff up to 1 s) until a node welcomes the socket. */
  async connect(deadlineMs = 60_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      const session = await this.session();
      if (session) {
        try {
          await this.open(session);
          return;
        } catch {
          // A node that refused the hello (draining, moved): ask /session again.
        }
      }
      await sleep(Math.min(1000, 50 * 2 ** attempt));
    }
    throw Error(`no node welcomed ${this.clientId} on ${this.fileId}`);
  }

  private open(session: Session): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(session.wsUrl);
      this.socket = socket;
      let welcomed = false;
      socket.onopen = () => {
        this.helloAt = performance.now();
        socket.send(JSON.stringify({t: 'hello', ticket: session.ticket, clientId: this.clientId, since: this.known, lastSeq: this.seq, protocol: 1}));
      };
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        const now = performance.now();
        switch (message.t) {
          case 'welcome': {
            welcomed = true;
            this.welcomes++;
            this.welcomeAt = now;
            // A resync (a document frame follows) puts the client at the node's version; otherwise the catch-up's changes do.
            if (message.resync) {
              this.resyncs++;
              this.known = Math.max(this.known, message.version);
            }
            this.node = session.node;
            const last = this.reconnects.at(-1);
            if (last && last.upAt === undefined) {
              last.upAt = now;
              last.to = session.node;
            }
            for (const [, frame] of [...this.unacked.entries()].sort(([a], [b]) => a - b)) socket.send(frame);
            resolve();
            break;
          }
          case 'ack':
            this.known = Math.max(this.known, message.version);
            if (this.unacked.delete(message.seq)) this.acked.push({seq: message.seq, version: message.version, at: now});
            break;
          case 'refused':
            this.refused[message.code] = (this.refused[message.code] ?? 0) + 1;
            this.unacked.delete(message.seq);
            break;
          case 'change':
            this.known = Math.max(this.known, message.version);
            this.onVersion?.(message.version, now);
            break;
          case 'changes':
            for (const change of message.changes ?? []) {
              this.known = Math.max(this.known, change.version);
              this.onVersion?.(change.version, now);
            }
            break;
          case 'document':
            this.known = Math.max(this.known, message.version);
            this.onVersion?.(message.version, now);
            break;
          case 'catchUp':
            socket.send(JSON.stringify({t: 'pull', since: message.from - 1}));
            break;
          case 'bye':
            this.lastBye = message.reason;
            this.byes[message.reason] = (this.byes[message.reason] ?? 0) + 1;
            break;
        }
      };
      socket.onerror = () => {
        if (!welcomed) reject(Error('socket error before welcome'));
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (!welcomed) return reject(Error('closed before welcome'));
        if (!this.reconnect) return;
        this.reconnects.push({reason: this.lastBye, downAt: performance.now(), from: session.node});
        this.lastBye = 'closed';
        void this.connect().catch(() => {});
      };
    });
  }

  /** An op moving `nodes` to x = this op's seq (the stored document then shows the last op that landed), with `before`. */
  move(nodes: SceneNode[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.seq++;
    const patch: Record<string, SceneNode> = {}, before: Record<string, SceneNode> = {};
    for (const node of nodes) {
      before[node.id] = node;
      patch[node.id] = {...node, x: this.seq} as SceneNode;
    }
    const frame = JSON.stringify({t: 'op', seq: this.seq, baseVersion: this.known, patch: {nodes: patch}, before});
    this.unacked.set(this.seq, frame);
    this.socket.send(frame);
  }

  /** Leaves without reconnecting. */
  leave(): void {
    this.reconnect = false;
    this.socket?.close();
    this.socket = null;
  }

  async settled(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.unacked.size && Date.now() < deadline) await sleep(50);
    return this.unacked.size === 0;
  }
}

/** Every acked op of `editors` that the journal does not hold at the acked version (design_file_changes). */
export async function missingAcks(databaseUrl: string, editors: CollabEditor[]): Promise<{acked: number; missing: number; examples: string[]}> {
  const pg = (await import('pg')).default;
  const client = new pg.Client({connectionString: databaseUrl});
  await client.connect();
  let acked = 0, missing = 0;
  const examples: string[] = [];
  try {
    for (const editor of editors) {
      const rows = (await client.query('SELECT client_seq, version FROM design_file_changes WHERE file_id=$1 AND client_id=$2', [editor.fileId, editor.clientId])).rows as {client_seq: string; version: string}[];
      const journaled = new Map(rows.map(row => [Number(row.client_seq), Number(row.version)]));
      for (const ack of editor.acked) {
        acked++;
        if (journaled.get(ack.seq) !== ack.version) {
          missing++;
          if (examples.length < 3) examples.push(`${editor.clientId}#${ack.seq}@${ack.version}`);
        }
      }
    }
  } finally {
    await client.end();
  }
  return {acked, missing, examples};
}
