import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {same} from '../shared/design/merge';
import {firstDifference} from '../shared/design/engine-switch';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {DesignDocument} from '../shared/design/types';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import {attachPersistence, type SessionPersistence} from '../src/design/editor/editor-session';
import {startLiveSession, type LiveSession} from '../src/design/realtime/live-session';
import {memoryQueue} from '../src/design/realtime/offline-queue';
import {createRequire} from 'node:module';
import {binaryCodec, jsonCodec, wsTransport, type SocketLike, type WasmWire, type WireCodec} from '../src/design/realtime/transport/ws';
import {PROTOCOL_LIMITS} from '../shared/design/protocol';
import {documentHash} from './helpers/fake-collab';
import {testIdentity} from './helpers/live-transports';

// The client against lane B1's real `collab` binary (crates/collab): the editors, autosave and live sessions of the
// unit suites, a socket each over Node's WebSocket, the server's own merge in Rust. Runs when the binary is built
// (`cargo build --release -p morfa-collab`, found in $CARGO_TARGET_DIR or target/, or MORFA_COLLAB_BIN); skipped
// otherwise (the gate's cloud run builds no Rust service). Dev tickets, the in-memory journal and a seed document.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const noTimers = {setTimeout: () => 1, clearTimeout: () => {}};
const SECRET = 'b3-test-secret';

function binary(): string | null {
  const candidates = [process.env.MORFA_COLLAB_BIN, ...[process.env.CARGO_TARGET_DIR, 'target'].filter(Boolean).flatMap(dir => [path.join(dir!, 'release/morfa-collab'), path.join(dir!, 'debug/morfa-collab')])];
  return candidates.find(file => file && fs.existsSync(file)) ?? null;
}

function startDocument(layers = 40): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'F', x: 0, y: 0, width: 4000, height: 4000}), 'page');
  for (let i = 0; i < layers; i++) tx.create(createNode('RECTANGLE', {id: `r${i}`, x: (i % 20) * 50, y: Math.floor(i / 20) * 50, width: 40, height: 40}), 'F');
  return tx.commit({measurer}).doc;
}

const devTicket = (file: string, user: string) => 'dev.' + Buffer.from(JSON.stringify({file, user, name: user, role: 'editor', exp: Math.floor(Date.now() / 1000) + 600})).toString('base64url');

async function startCollab(bin: string, seed: DesignDocument): Promise<{port: number; child: ChildProcess; stop(): Promise<void>; doc(file: string): Promise<{version: number; hash: string}>}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-collab-'));
  const seedFile = path.join(dir, 'seed.json');
  fs.writeFileSync(seedFile, JSON.stringify(seed));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(bin, ['serve'], {env: {...process.env, MORFA_COLLAB_ADDR: `127.0.0.1:${port}`, MORFA_COLLAB_DEV_TICKETS: '1', MORFA_COLLAB_SEED: seedFile, MORFA_COLLAB_INTERNAL_SECRET: SECRET, RUST_LOG: 'warn'}, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr!.on('data', chunk => (stderr += chunk));
  for (let i = 0; i < 200; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok, () => false);
    if (ok) break;
    if (child.exitCode !== null) throw new Error(`collab exited: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return {
    port,
    child,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      fs.rmSync(dir, {recursive: true, force: true});
    },
    async doc(file) {
      const response = await fetch(`http://127.0.0.1:${port}/internal/doc/${file}`, {headers: {Authorization: `Bearer ${SECRET}`}});
      assert.ok(response.ok, `GET /internal/doc: ${response.status}`);
      return (await response.json()) as {version: number; hash: string};
    },
  };
}

/** The codec, counting the server's frames by type (which catch-up path ran). */
const counted = (codec: WireCodec, frames: Map<string, number>, name = ''): WireCodec => ({
  ...codec,
  encode(message) {
    if (process.env.B3_TRACE) fs.appendFileSync(process.env.B3_TRACE, JSON.stringify({name, dir: 'send', message}) + '\n');
    return codec.encode(message);
  },
  decode(data) {
    const message = codec.decode(data);
    if (process.env.B3_TRACE) fs.appendFileSync(process.env.B3_TRACE, JSON.stringify({name, dir: 'recv', message}) + '\n');
    frames.set(message.t, (frames.get(message.t) ?? 0) + 1);
    frames.set('#bytes', (frames.get('#bytes') ?? 0) + (typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength));
    return message;
  },
});

type Editor = {name: string; store: DesignStore; persistence: SessionPersistence; live: LiveSession; sockets: SocketLike[]; network: EventTarget; offline: boolean; frames: Map<string, number>; stop(): void};

function editor(port: number, file: string, name: string, seed: DesignDocument, version: number, wire: Wire = 'json'): Editor {
  const network = new EventTarget();
  const self = {offline: false};
  /** Server frames by type (which catch-up path ran). */
  const frames = new Map<string, number>();
  const store = createDesignStore({doc: clone(seed), measurer, idle: () => () => {}});
  const persistence = attachPersistence(store, {fileId: file, baseVersion: version, events: null, timers: noTimers, onStatus: () => {}, onConflict: () => assert.fail('conflict'), onStopped: report => assert.fail('stopped: ' + report.message), request: async () => assert.fail('the socket carries saves')});
  const sockets: SocketLike[] = [];
  const live = startLiveSession({
    fileId: file, store, persistence, version, canEdit: true, network, queue: memoryQueue(), identity: testIdentity('real-' + name),
    callbacks: {onAccess: () => {}, onEnd: reason => assert.fail(`${name} ended: ${reason}`), onRename: () => {}},
    transport: wsTransport({codec: counted(wire === 'binary' ? binaryCodec(wasmWire!) : jsonCodec, frames, name), io: {
      session: async () => {
        if (self.offline) throw new TypeError('offline');
        return {wsUrl: `ws://127.0.0.1:${port}/collab/${file}`, ticket: devTicket(file, name)};
      },
      socket: url => {
        const socket = new WebSocket(url) as unknown as SocketLike;
        sockets.push(socket);
        return socket;
      },
      open: async () => assert.fail('no reload expected'),
      snapshot: async () => assert.fail('no snapshot expected'),
      sleep: (ms, signal) => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.min(ms, 50));
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, {once: true});
      }),
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
    }}),
  });
  const made: Editor = {name, store, persistence, live, sockets, network, frames, get offline() {
    return self.offline;
  }, set offline(value: boolean) {
    self.offline = value;
    if (value) sockets.at(-1)?.close();
    else network.dispatchEvent(new Event('online'));
  }, stop() {
    live.stop();
    persistence.dispose();
    running.delete(made);
  }};
  running.add(made);
  return made;
}

/** Every editor a test started is stopped after it, also when an assertion failed (a session left reconnecting keeps
 *  the file from exiting). */
const running = new Set<Editor>();
afterEach(() => {
  for (const who of [...running]) who.stop();
});

const until = async (done: () => boolean | Promise<boolean>, what: string | (() => string | Promise<string>), ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) assert.fail(`timed out: ${typeof what === 'string' ? what : await what()}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const bin = binary();

/** The binary wire (`?wire=bin`) through crates/wasm's Node build, as the browser's codec uses its web build. Null when
 *  server/design/wasm is not built or predates `decode_frame` (the binary-wire runs are then skipped). */
const wasmWire: WasmWire | null = (() => {
  try {
    const wasm = createRequire(import.meta.url)('../server/design/wasm') as Partial<WasmWire>;
    return typeof wasm.decode_frame === 'function' && typeof wasm.encode_frame === 'function' ? (wasm as WasmWire) : null;
  } catch {
    return null;
  }
})();
type Wire = 'json' | 'binary';
const WIRES: readonly Wire[] = ['json', 'binary'];
const skipFor = (wire: Wire) => (!bin ? 'no morfa-collab binary (cargo build --release -p morfa-collab)' : wire === 'binary' && !wasmWire ? 'no decode_frame in server/design/wasm (scripts/wasm-build.sh)' : false);

for (const wire of WIRES) test(`the real collab (${wire} wire): two editors converge on its document (hash), through drops; M3 on localhost`, {skip: skipFor(wire)}, async t => {
  const seed = startDocument();
  const collab = await startCollab(bin!, seed);
  try {
    const file = `b3real${wire}`;
    const a = editor(collab.port, file, 'a', seed, 0, wire);
    const b = editor(collab.port, file, 'b', seed, 0, wire);
    await until(() => a.live.status() === 'live' && b.live.status() === 'live', 'both live');
    const version = a.live.version();
    // One edit, timed until the other editor shows it (M3 without the network).
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      a.store.transact('Move', tx => tx.update('r1', {x: 1000 + i}));
      // Timed from the save's start to the store change at b (not the polling below, which only waits).
      let seen = 0;
      const off = b.store.subscribe(() => {
        if (!seen && b.store.getState().doc.nodes.r1.x === 1000 + i) seen = performance.now();
      });
      const started = performance.now();
      void a.persistence.flush();
      await until(() => seen > 0, 'b sees a\'s move', 2_000);
      off();
      samples.push(seen - started);
    }
    samples.sort((x, y) => x - y);
    t.diagnostic(`${wire} wire: op → applied at the peer on localhost: p50 ${samples[10].toFixed(2)} ms, max ${samples.at(-1)!.toFixed(2)} ms (from version ${version})`);
    // Random edits from both, with sockets cut now and then (the client reconnects with since/lastSeq).
    let state = 7;
    const rnd = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let step = 0; step < 150; step++) {
      const who = rnd() < 0.5 ? a : b;
      const roll = rnd();
      if (roll < 0.55) who.store.transact('Move', tx => tx.update(`r${Math.floor(rnd() * 40)}`, {x: Math.floor(rnd() * 900), y: Math.floor(rnd() * 900)}));
      else if (roll < 0.7) who.store.transact('Fill', tx => tx.update(`r${Math.floor(rnd() * 40)}`, {fills: [solid({r: rnd(), g: rnd(), b: 0})]}));
      else if (roll < 0.95) void who.persistence.flush().catch(() => {});
      else who.sockets.at(-1)?.close();
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    for (let round = 0; round < 100 && [a, b].some(who => who.persistence.dirty() || who.live.unacked()); round++) {
      for (const who of [a, b]) void who.persistence.flush().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const server = await collab.doc(file);
    await until(() => a.live.version() === server.version && b.live.version() === server.version, 'both at the server version');
    const where = firstDifference(a.store.getState().doc, b.store.getState().doc);
    assert.ok(same(a.store.getState().doc, b.store.getState().doc), `a and b hold one document: ${where} (a ${documentHash(a.store.getState().doc) === server.hash ? '=' : '≠'} server, b ${documentHash(b.store.getState().doc) === server.hash ? '=' : '≠'} server)`);
    assert.equal(documentHash(a.store.getState().doc), server.hash, 'the document hash equals the server\'s');
    a.stop();
    b.stop();
  } finally {
    await collab.stop();
  }
});

// 20 layers per op is the loadgen op: 1 000 of them pass M9's 5 MB of tail, so the server sends the document. 2 layers per
// op keep the tail under it: the catch-up comes as changes.
for (const wire of WIRES) for (const layers of [20, 2]) test(`the real collab (${wire} wire), M8: 50 local ops offline while 5 others land 1 000 ops of ${layers} layers; converged, server hash, history intact`, {skip: skipFor(wire)}, async t => {
  const seed = startDocument(200);
  const collab = await startCollab(bin!, seed);
  try {
    const file = `b3m8x${layers}${wire}`;
    const a = editor(collab.port, file, 'a', seed, 0, wire);
    // Five others share the 1 000 ops (each connection stays under the server's PROTOCOL_LIMITS.opsPerSecond).
    const others = ['b', 'c', 'd', 'e', 'f'].map(name => editor(collab.port, file, name, seed, 0, wire));
    const b = others[0];
    await until(() => [a, ...others].every(who => who.live.status() === 'live'), 'all live');
    a.offline = true;
    await until(() => a.live.status() !== 'live', 'a offline');
    // 50 local edits while offline (x), one saved into the queue, the rest waiting behind it.
    for (let i = 0; i < 50; i++) {
      a.store.transact(`Edit ${i}`, tx => tx.update(`r${i}`, {x: 1000 + i}));
      if (i === 0) void a.persistence.flush().catch(() => {});
    }
    // 1 000 ops of moved layers (y), on layers a changed too: the server's merge and a's rebase both work. Each
    // editor moves its own layers (rows of 40), so the five never refuse one another.
    const pace = 1000 / (PROTOCOL_LIMITS.opsPerSecond * 0.8);
    await Promise.all(others.map(async (who, n) => {
      for (let i = 0; i < 200; i++) {
        const started = performance.now();
        who.store.transact('Move', tx => {
          for (let k = 0; k < layers; k++) tx.update(`r${n * 40 + ((i * 7 + k * 11) % 40)}`, {y: i + k});
        });
        await who.persistence.flush();
        await new Promise(resolve => setTimeout(resolve, Math.max(0, pace - (performance.now() - started))));
      }
    }));
    await until(() => others.every(who => !who.live.unacked() && who.live.version() === others[0].live.version()), 'the others acked');
    a.frames.clear();
    const started = performance.now();
    a.offline = false;
    const server = async () => collab.doc(file);
    await until(async () => {
      if (a.live.unacked()) return false;
      if (a.persistence.dirty()) {
        void a.persistence.flush().catch(() => {});
        return false;
      }
      const at = await server();
      return a.live.version() === at.version && documentHash(a.store.getState().doc) === at.hash;
    }, async () => {
      const at = await server();
      return `a converged: a at ${a.live.version()} (${a.live.status()}, unacked ${a.live.unacked()}, dirty ${a.persistence.dirty()}, hash ${documentHash(a.store.getState().doc) === at.hash ? '=' : '≠'}), the server at ${at.version}; vs ${b.name} at ${b.live.version()} (hash ${documentHash(b.store.getState().doc) === at.hash ? '=' : '≠'}): ${firstDifference(a.store.getState().doc, b.store.getState().doc)}`;
    }, 10_000);
    const converged = performance.now() - started;
    // Over 5 MB of journal tail the server sends the document instead of the changes (TARGETS M9).
    if (layers === 2) assert.ok(!a.frames.get('document') && a.frames.get('changes'), 'under 5 MB the catch-up comes as changes');
    const path = a.frames.get('document') ? 'the document frame (tail over M9\'s 5 MB)' : `${a.frames.get('changes') ?? 0} changes frames`;
    t.diagnostic(`${wire} wire, M8 against the real collab on localhost: converged in ${converged.toFixed(1)} ms through ${path} (${((a.frames.get('#bytes') ?? 0) / 1e6).toFixed(2)} MB received), 50 local edits on top`);
    const final = a.store.getState().doc;
    for (let i = 0; i < 50; i++) assert.equal(final.nodes[`r${i}`].x, 1000 + i, 'every local op landed');
    await until(() => others.every(who => who.live.version() === a.live.version()), 'the others caught up');
    for (const who of others) assert.ok(same(final, who.store.getState().doc), `a and ${who.name} hold one document`);
    let undo = 0;
    while (a.store.canUndo()) {
      a.store.undo();
      undo++;
    }
    assert.equal(undo, 50, 'the undo history holds the 50 local steps, none of the remote ones');
    for (const who of [a, ...others]) who.stop();
  } finally {
    await collab.stop();
  }
});
