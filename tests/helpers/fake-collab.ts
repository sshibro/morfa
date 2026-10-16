import {createHash, randomBytes} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import type {Duplex} from 'node:stream';
import {applyDocumentChange, storedValues} from '../../server/design/apply';
import {isEmptyPatch, type DocumentPatch} from '../../shared/design/patch';
import {checkPatchedDocument} from '../../shared/design/schema';
import type {DesignDocument} from '../../shared/design/types';
import type {DesignFileOpened} from '../../shared/design/api';
import type {ClientMessage, ProtocolChange, ProtocolPeer, ServerMessage} from '../../shared/design/protocol';
import type {FrameDecoder, SocketLike, WsIo} from '../../src/design/realtime/transport/ws';
import {decodeComposed} from '../../src/design/realtime/transport/frame-decoder';
import {expandFieldOp} from '../../src/design/realtime/fields';

// A stand-in for lane B1's `collab` (crates/protocol/schema.json, docs/BACKEND.md §2) for the client's tests: one file,
// the server's own apply step (server/design/apply.ts: mergeChange, then the checks), numbered versions, the change
// log as the journal, per-(clientId, seq) de-duplication, presence fan-out. Two ways in:
// - `memorySocket()`: an in-process socket whose frames the test delivers one at a time (the order on one socket is
//   kept, as on a real one; across sockets the test interleaves them);
// - `listen()`: a real WebSocket server on 127.0.0.1 (node:http upgrade, RFC 6455 text frames) for Node's WebSocket.
// Knobs for the tests: `offline` refuses connections, `drop()` cuts every socket, `loseAcks` stores ops without acking
// them (the ack lost on the way), `edit()` is someone else's change made through the api. Frames are serialized when
// sent (a socket writes text), so the log and the document go out without copies.

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The schema's document hash: SHA-256 of the canonical JSON (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const keys = Object.keys(value as object).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export const documentHash = (doc: DesignDocument) => createHash('sha256').update(canonicalJson(doc)).digest('hex');

type Connection = {
  id: string;
  clientId: string;
  user: string;
  peer: ProtocolPeer;
  send(message: ServerMessage): void;
  close(): void;
  welcomed: boolean;
};

export type FakeCollabOptions = {
  /** The journal tail served on a catch-up; older `since` gets a reload (BACKEND M9). */
  tail?: number;
  /** Send `snapshotUrl` instead of a document frame on a reload. */
  snapshots?: boolean;
  /** `own` on the ack of an op that was behind (Node's PATCH, the default); false: only when the merge adjusted the
   *  op, as crates/collab does. */
  ownWhenBehind?: boolean;
  /** Reloads as crates/collab serves them: a joining client's welcome says nothing and its document frame comes after
   *  the ack of the op it re-sends (the snapshot is encoded off the actor); a `pull` beyond the tail is answered
   *  `resync` + the document. */
  collabReload?: boolean;
  /** As crates/collab: an op on the current version is applied as sent, its `before` unread (nothing to merge). */
  mergeOnlyBehind?: boolean;
};

export class FakeCollab {
  doc: DesignDocument;
  version: number;
  log: (ProtocolChange & {version: number})[] = [];
  readonly connections = new Set<Connection>();
  /** (clientId, seq) → the version it was stored at and the `own` its ack carried. */
  readonly stored = new Map<string, {version: number; own?: DocumentPatch}>();
  readonly ackedSeq = new Map<string, number>();
  /** How many times each (clientId, seq) was applied: more than once is a duplicate. */
  readonly applied = new Map<string, number>();
  readonly received: ClientMessage[] = [];
  /** Time spent in the server's own work (receiving, applying, writing frames): a test subtracts it from the client's. */
  busyMs = 0;
  offline = false;
  loseAcks = false;
  /** Versions stored, ops merged onto a newer version than their base, ops the merge stored differently. */
  versionsStored = 0;
  behind = 0;
  adjusted = 0;
  /** Ops refused with this code (tests of refusals). */
  refuseNext: {code: 'version_conflict' | 'design_document_invalid' | 'design_document_too_large'; path?: string; nodeId?: string} | null = null;
  private next = 1;
  constructor(doc: DesignDocument, version = 1, private readonly options: FakeCollabOptions = {}) {
    this.doc = clone(doc);
    this.version = version;
  }

  /** The api's GET of the file (a reload). */
  opened(): DesignFileOpened {
    return {file: {id: 'f', name: 'f', version: this.version, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}, document: clone(this.doc)};
  }

  /** Someone else's change through the api (no socket): stored, journaled, fanned out. */
  edit(patch: DocumentPatch) {
    const applied = applyDocumentChange(this.doc, {patch: clone(patch)});
    if (isEmptyPatch(applied.stored)) return this.version;
    this.doc = applied.doc;
    this.version++;
    const change = {version: this.version, by: null, user: 'api', patch: clone(applied.stored)};
    this.log.push(change);
    for (const connection of this.connections) if (connection.welcomed) connection.send({t: 'change', ...change});
    return this.version;
  }

  /** A new socket: `send` takes the server's frames to the client, the result takes the client's frames in. */
  accept(send: (message: ServerMessage) => void, close: () => void): {receive(message: ClientMessage): void; closed(): void} {
    const connection: Connection = {id: `c${this.next++}`, clientId: '', user: '', peer: null!, send, close, welcomed: false};
    return {
      receive: message => {
        const started = performance.now();
        try {
          this.receive(connection, message);
        } finally {
          this.busyMs += performance.now() - started;
        }
      },
      closed: () => {
        if (!this.connections.delete(connection)) return;
        for (const other of this.connections) if (other.welcomed) other.send({t: 'leave', connection: connection.id});
      },
    };
  }

  /** Every socket is cut (the network went away). */
  drop() {
    for (const connection of [...this.connections]) {
      this.connections.delete(connection);
      connection.close();
    }
  }

  duplicates(): string[] {
    return [...this.applied].filter(([, count]) => count > 1).map(([key]) => key);
  }

  private receive(connection: Connection, message: ClientMessage) {
    this.received.push(message);
    switch (message.t) {
      case 'hello': {
        connection.clientId = message.clientId;
        connection.user = 'u-' + message.clientId.slice(0, 4);
        connection.peer = {connection: connection.id, user: connection.user, name: connection.user, color: 0, role: 'editor', cursor: null, page: null, selection: [], selectionCount: 0, viewport: null, editing: null};
        this.connections.add(connection);
        const since = message.since;
        const tail = this.options.tail ?? Infinity;
        const behind = since === undefined ? null : this.log.filter(change => change.version > since);
        const reload = since === undefined || since < this.version - tail || (behind !== null && behind.length !== this.version - since);
        const peers = [...this.connections].filter(other => other !== connection && other.welcomed).map(other => other.peer);
        connection.welcomed = true;
        const ackedSeq = this.ackedSeq.get(message.clientId) ?? 0;
        connection.send({
          t: 'welcome', connection: connection.id, version: this.version, role: 'editor', canEdit: true, user: connection.user, name: connection.user, color: 0, peers,
          ...(reload && !this.options.collabReload ? {resync: true, ...(this.options.snapshots ? {snapshotUrl: `/snapshot/${this.version}`} : {})} : {}),
          ackedSeq,
        });
        // As crates/collab does: the file's name, then the catch-up (or the document) in frames of their own.
        connection.send({t: 'file', name: 'f'});
        if (reload && this.options.collabReload) {
          const at = this.version, doc = this.doc;
          setTimeout(() => connection.send({t: 'document', version: at, document: doc}), 0);
        } else if (reload && !this.options.snapshots) connection.send({t: 'document', version: this.version, document: this.doc});
        else if (!reload && behind!.length) connection.send({t: 'changes', changes: behind!});
        for (const other of this.connections) if (other !== connection && other.welcomed) other.send({t: 'presence', peers: [connection.peer]});
        return;
      }
      case 'op': {
        const key = `${connection.clientId}:${message.seq}`;
        const known = this.stored.get(key);
        if (known) {
          // Re-sent after a lost ack: re-acked, never applied again.
          connection.send({t: 'ack', seq: message.seq, version: known.version, ...(known.own ? {own: clone(known.own)} : {})});
          return;
        }
        if (this.refuseNext) {
          const refusal = this.refuseNext;
          this.refuseNext = null;
          connection.send({t: 'refused', seq: message.seq, ...refusal, ...(refusal.code === 'version_conflict' ? {currentVersion: this.version} : {})});
          return;
        }
        // Protocol 2's field ops over this file's nodes, as crates/collab expands them.
        const expanded = expandFieldOp(message, this.version, id => this.doc.nodes[id]);
        if (!expanded) {
          connection.send({t: 'refused', seq: message.seq, code: 'design_document_invalid', path: 'fields', message: 'There is no such layer in the file.'});
          return;
        }
        const op = expanded.op;
        // Edits of layers removed since the op's base are dropped (removal wins): the answer says what this file holds.
        const dropped = expanded.dropped;
        const sent = clone(op.patch);
        const behind = this.version > op.baseVersion;
        if (behind && !op.before) {
          connection.send({t: 'refused', seq: op.seq, code: 'version_conflict', currentVersion: this.version});
          return;
        }
        const merge = behind || !this.options.mergeOnlyBehind;
        const applied = applyDocumentChange(this.doc, merge ? {patch: sent, before: op.before && clone(op.before), beforeTables: op.beforeTables && clone(op.beforeTables)} : {patch: sent});
        this.applied.set(key, (this.applied.get(key) ?? 0) + 1);
        if (behind) this.behind++;
        if (applied.adjusted) this.adjusted++;
        this.ackedSeq.set(connection.clientId, Math.max(this.ackedSeq.get(connection.clientId) ?? 0, op.seq));
        const withDropped = dropped.length ? {...sent, nodes: {...sent.nodes, ...Object.fromEntries(dropped.map(id => [id, null]))}} : sent;
        if (isEmptyPatch(applied.stored)) {
          const own = (behind && this.options.ownWhenBehind !== false) || applied.adjusted || dropped.length ? clone(storedValues(this.doc, withDropped, {})) : undefined;
          this.stored.set(key, {version: this.version, own});
          if (!this.loseAcks) connection.send({t: 'ack', seq: op.seq, version: this.version, ...(own ? {own} : {})});
          return;
        }
        const checked = checkPatchedDocument(this.doc, applied.doc, applied.stored);
        if (!checked.ok) {
          this.applied.delete(key);
          connection.send({t: 'refused', seq: op.seq, code: 'design_document_invalid', path: checked.path, message: checked.error});
          return;
        }
        this.doc = applied.doc;
        this.version++;
        this.versionsStored++;
        const change = {version: this.version, by: connection.id, client: connection.clientId, seq: op.seq, user: connection.user, patch: clone(applied.stored)};
        this.log.push(change);
        // Fan-out before the ack (BACKEND §2): the peers get the change, never its sender.
        for (const other of this.connections) if (other !== connection && other.welcomed) other.send({t: 'change', ...change});
        const own = (behind && this.options.ownWhenBehind !== false) || applied.adjusted || dropped.length ? clone(storedValues(this.doc, withDropped, applied.stored)) : undefined;
        this.stored.set(key, {version: this.version, own});
        if (!this.loseAcks) connection.send({t: 'ack', seq: op.seq, version: this.version, ...(own ? {own} : {})});
        return;
      }
      case 'presence': {
        const {t: _t, ...fields} = message;
        connection.peer = {...connection.peer, ...fields} as ProtocolPeer;
        for (const other of this.connections) if (other !== connection && other.welcomed) other.send({t: 'presence', peers: [connection.peer]});
        return;
      }
      case 'pull':
        if (this.options.collabReload && message.since < this.version - (this.options.tail ?? Infinity)) {
          connection.send({t: 'resync', version: this.version});
          connection.send({t: 'document', version: this.version, document: this.doc});
          return;
        }
        connection.send({t: 'changes', changes: this.log.filter(change => change.version > message.since)});
        return;
      case 'ping':
        connection.send({t: 'pong'});
        return;
    }
  }

  // ── In-process sockets ──

  /** A socket wired to this server in memory. Frames to the client queue in `inbox` until `deliver` (or `autoDeliver`). */
  memorySocket(): SocketLike & {inbox: string[]; deliver(count?: number): number; autoDeliver: boolean; cut(): void} {
    const server = this;
    let side: ReturnType<FakeCollab['accept']> | null = null;
    const socket = {
      binaryType: 'arraybuffer',
      readyState: 0,
      inbox: [] as string[],
      autoDeliver: false,
      onopen: null as SocketLike['onopen'],
      onmessage: null as SocketLike['onmessage'],
      onclose: null as SocketLike['onclose'],
      onerror: null as SocketLike['onerror'],
      send(data: string | Uint8Array) {
        if (socket.readyState !== 1) return;
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        side?.receive(JSON.parse(text) as ClientMessage);
      },
      close() {
        socket.cut();
      },
      cut() {
        if (socket.readyState === 3) return;
        socket.readyState = 3;
        socket.inbox.length = 0;
        side?.closed();
        queueMicrotask(() => socket.onclose?.({code: 1006, reason: ''}));
      },
      deliver(count = Infinity) {
        let n = 0;
        while (socket.inbox.length && n < count && socket.readyState === 1) {
          const data = socket.inbox.shift()!;
          socket.onmessage?.({data});
          n++;
        }
        return n;
      },
    };
    queueMicrotask(() => {
      if (server.offline) {
        socket.readyState = 3;
        socket.onclose?.({code: 1006, reason: ''});
        return;
      }
      side = server.accept(
        message => {
          if (socket.readyState !== 1) return;
          socket.inbox.push(JSON.stringify(message));
          if (socket.autoDeliver) queueMicrotask(() => socket.deliver());
        },
        () => socket.cut(),
      );
      socket.readyState = 1;
      socket.onopen?.({});
    });
    return socket;
  }

  /** A WsIo for the client's transport over memory sockets; `sockets` lists them (the latest last). */
  memoryIo(options: {autoDeliver?: boolean; decoder?: () => FrameDecoder | null} = {}): WsIo & {sockets: ReturnType<FakeCollab['memorySocket']>[]} {
    const sockets: ReturnType<FakeCollab['memorySocket']>[] = [];
    return {
      sockets,
      session: async () => {
        if (this.offline) throw new TypeError('Failed to fetch');
        return {wsUrl: 'ws://fake/collab/f', ticket: 'ticket'};
      },
      socket: () => {
        const socket = this.memorySocket();
        socket.autoDeliver = options.autoDeliver ?? true;
        sockets.push(socket);
        return socket;
      },
      open: async () => this.opened(),
      snapshot: async () => ({version: this.version, document: clone(this.doc)}),
      // A real (short) wait: a session failing to connect again and again must not spin the microtask queue.
      sleep: (_ms, signal) => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 1);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, {once: true});
      }),
      setInterval: () => 0,
      clearInterval: () => {},
      ...(options.decoder ? {decoder: options.decoder} : {}),
    };
  }

  // ── A real WebSocket server ──

  /** Listens on 127.0.0.1; `io()` gives the client's WsIo for Node's global WebSocket. */
  async listen(): Promise<{url: string; io(): WsIo; close(): Promise<void>}> {
    const sockets = new Set<Duplex>();
    const server = http.createServer((_req, res) => {
      res.writeHead(404).end();
    });
    server.on('upgrade', (req, socket: Duplex) => {
      if (this.offline) return void socket.destroy();
      const key = req.headers['sec-websocket-key'];
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      sockets.add(socket);
      let open = true;
      const side = this.accept(
        message => {
          if (open) socket.write(frame(Buffer.from(JSON.stringify(message))));
        },
        () => {
          open = false;
          socket.destroy();
        },
      );
      let buffer = Buffer.alloc(0);
      let parts: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const parsed = unframe(buffer);
          if (!parsed) break;
          buffer = buffer.subarray(parsed.length);
          if (parsed.opcode === 8) {
            open = false;
            socket.end(frame(Buffer.alloc(0), 8));
            return;
          }
          if (parsed.opcode === 9) {
            socket.write(frame(parsed.payload, 10));
            continue;
          }
          if (parsed.opcode === 1 || parsed.opcode === 2 || parsed.opcode === 0) {
            parts.push(parsed.payload);
            if (!parsed.fin) continue;
            const text = Buffer.concat(parts).toString('utf8');
            parts = [];
            side.receive(JSON.parse(text) as ClientMessage);
          }
        }
      });
      const gone = () => {
        open = false;
        sockets.delete(socket);
        side.closed();
      };
      socket.on('close', gone);
      socket.on('error', gone);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/collab/f`;
    return {
      url,
      io: () => ({
        session: async () => {
          if (this.offline) throw new TypeError('Failed to fetch');
          return {wsUrl: url, ticket: 'ticket'};
        },
        socket: target => new WebSocket(target) as unknown as SocketLike,
        open: async () => this.opened(),
        snapshot: async () => ({version: this.version, document: clone(this.doc)}),
        sleep: (ms, signal) => new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(ms, 20));
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, {once: true});
        }),
        setInterval: (run, ms) => setInterval(run, ms),
        clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
      }),
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      },
    };
  }
}

/** One unmasked server frame (FIN set). */
function frame(payload: Buffer, opcode = 1): Buffer {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65_536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)]);
  return Buffer.concat([head, payload]);
}
function bigLength(length: number) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(length));
  return out;
}

/** One client frame (masked) from the front of `buffer`, or null while it is incomplete. */
function unframe(buffer: Buffer): {fin: boolean; opcode: number; payload: Buffer; length: number} | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f, masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f, offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
  return {fin, opcode, payload, length: offset + length};
}

export const randomClientId = () => randomBytes(9).toString('base64url');

/** The decode worker in-process (the browser runs frame-decoder.ts in a Worker): answers on a later macrotask, so the
 *  frames behind a large one must wait for it; `busyMs` is the time it took, off the editor's main thread there. */
export function inProcessDecoder(): FrameDecoder & {busyMs: number; frames: number} {
  const decoder = {
    busyMs: 0,
    frames: 0,
    decode(data: string | ArrayBuffer) {
      return new Promise<ReturnType<typeof decodeComposed>>((resolve, reject) => setImmediate(() => {
        const started = performance.now();
        try {
          resolve(decodeComposed(typeof data === 'string' ? data : new TextDecoder().decode(data)));
        } catch (error) {
          reject(error);
        } finally {
          decoder.busyMs += performance.now() - started;
          decoder.frames++;
        }
      }));
    },
    close() {},
  };
  return decoder;
}
