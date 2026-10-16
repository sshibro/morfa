import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {same} from '../shared/design/merge';
import type {DocumentPatch} from '../shared/design/patch';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {DesignDocument} from '../shared/design/types';
import type {ClientOp} from '../shared/design/protocol';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import {attachPersistence, type SessionPersistence} from '../src/design/editor/editor-session';
import type {AutosaveStatus} from '../src/design/persistence/autosave';
import {startLiveSession, type LiveSession} from '../src/design/realtime/live-session';
import {clientIdentity, memoryQueue, type OpQueue} from '../src/design/realtime/offline-queue';
import {wsTransport, type FrameDecoder, type WsIo} from '../src/design/realtime/transport/ws';
import {documentHash, FakeCollab, inProcessDecoder} from './helpers/fake-collab';
import {testIdentity} from './helpers/live-transports';
import {budget} from './helpers/speed';

// The socket path's offline queue (docs/BACKEND.md §2 «Reconnect and catch-up»): ops are
// numbered per tab, kept until acked, sent again after a reconnect with the same seq; the server (tests/helpers/
// fake-collab.ts) de-duplicates by (clientId, seq), so a lost ack never applies an op twice. A reload of the tab finds
// its ops and sends them; a 30 s outage with 50 local ops and 1 000 missed remote ones converges within 500 ms.

type SessionIdentity = Parameters<typeof startLiveSession>[0]['identity'];
const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const noTimers = {setTimeout: () => 1, clearTimeout: () => {}};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const flushAll = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};
/** Waits (real time, at most 2 s) until `done`: a reconnect waits on a timer. */
const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(done(), 'timed out');
};

function startDocument(layers = 40): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'F', x: 0, y: 0, width: 4000, height: 4000}), 'page');
  for (let i = 0; i < layers; i++) tx.create(createNode('RECTANGLE', {id: `r${i}`, x: (i % 20) * 50, y: Math.floor(i / 20) * 50, width: 40, height: 40}), 'F');
  return tx.commit({measurer}).doc;
}

type Editor = {store: DesignStore; persistence: SessionPersistence; live: LiveSession; statuses: AutosaveStatus[]; io: WsIo & {sockets: {inbox: string[]; cut(): void}[]}; network: EventTarget; stop(): void};

function editor(fake: FakeCollab, options: {clientId?: string; queue?: OpQueue; doc?: DesignDocument; version?: number; lastSeq?: number; decoder?: FrameDecoder; identity?: SessionIdentity} = {}): Editor {
  const store = createDesignStore({doc: clone(options.doc ?? fake.doc), measurer, idle: () => () => {}});
  const statuses: AutosaveStatus[] = [];
  const version = options.version ?? fake.version;
  const persistence = attachPersistence(store, {
    fileId: 'f', baseVersion: version, events: null, timers: noTimers,
    onStatus: status => statuses.push(status),
    onConflict: () => assert.fail('no conflicts on the socket'),
    onStopped: report => assert.fail(`saving stopped: ${report.message}`),
    request: async () => assert.fail('the socket carries the saves'),
  });
  const io = fake.memoryIo({autoDeliver: true, ...(options.decoder ? {decoder: () => options.decoder!} : {})});
  const network = new EventTarget();
  const live = startLiveSession({
    fileId: 'f', store, persistence, version, canEdit: true, network, queue: options.queue ?? memoryQueue(), identity: options.identity ?? testIdentity(options.clientId ?? 'tab-a', options.lastSeq ?? 0),
    callbacks: {onAccess: () => assert.fail('access'), onEnd: reason => assert.fail('ended: ' + reason), onRename: () => {}},
    transport: wsTransport({io}),
  });
  const made: Editor = {store, persistence, live, statuses, io, network, stop() {
    live.stop();
    persistence.dispose();
    running.delete(made);
  }};
  running.add(made);
  return made;
}

/** Every editor a test started is stopped after it, also when an assertion failed (a live session left running keeps
 *  the file from exiting). */
const running = new Set<Editor>();
afterEach(() => {
  for (const who of [...running]) who.stop();
});

/** sessionStorage and Web Locks of one browser, tab by tab (each tab its own storage, the locks shared). */
function browserTabs() {
  const held = new Set<string>();
  const locks = {
    async request(name: string, _options: {ifAvailable: boolean}, run: (lock: unknown) => Promise<void> | void) {
      if (held.has(name)) return run(null);
      held.add(name);
      await run({name});
      held.delete(name);
    },
  };
  const tab = () => {
    const storage = new Map<string, string>();
    return {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value)};
  };
  return {locks, held, tab};
}

const move = (store: DesignStore, id: string, x: number) => store.transact('Position', tx => tx.update(id, {x}));

test('the tab identity: kept across a reload, a new one in a duplicated tab, seqs never reused', async () => {
  const storage = new Map<string, string>();
  const kv = {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value)};
  const held = new Set<string>();
  const locks = {
    async request(name: string, _options: {ifAvailable: boolean}, run: (lock: unknown) => Promise<void> | void) {
      if (held.has(name)) return run(null);
      held.add(name);
      await run({name});
      held.delete(name);
    },
  };
  const first = await clientIdentity('f', {storage: kv, locks});
  assert.match(first.clientId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(first.next(), 1);
  assert.equal(first.next(), 2);
  // A duplicated tab (same sessionStorage) while the first is open: a new id, its own seqs.
  const copy = await clientIdentity('f', {storage: kv, locks});
  assert.notEqual(copy.clientId, first.clientId);
  assert.equal(copy.lastSeq, 0);
  copy.release();
  first.release();
  await flushAll(2);
  // A reload (the same tab, its lock released): the stored id and counter. The copy wrote last, so restore the first.
  kv.setItem('morfa:collab:f', JSON.stringify({clientId: first.clientId, lastSeq: 2}));
  const reloaded = await clientIdentity('f', {storage: kv, locks});
  assert.equal(reloaded.clientId, first.clientId);
  assert.equal(reloaded.next(), 3);
  reloaded.atLeast(10);
  assert.equal(reloaded.next(), 11, 'never below what the server holds');
  reloaded.release();
});

test('an op is numbered, queued until acked, and its ack is the save', async () => {
  const fake = new FakeCollab(startDocument());
  const queue = memoryQueue();
  const a = editor(fake, {queue});
  await flushAll();
  assert.equal(a.live.transport(), 'ws');
  assert.equal(a.live.status(), 'live');
  move(a.store, 'r1', 500);
  const saved = a.persistence.flush();
  assert.equal(queue.size(), 1, 'queued while on its way');
  await saved;
  assert.equal(queue.size(), 0, 'gone once acked');
  assert.equal(a.live.unacked(), 0);
  const ops = fake.received.filter((message): message is ClientOp => message.t === 'op');
  assert.deepEqual(ops.map(op => op.seq), [1]);
  // Protocol 2: the moved layer goes as the field it wrote, with its base value for the server's merge (lane W).
  assert.equal(ops[0].fields?.set?.r1?.x, 500);
  assert.ok(ops[0].fields?.was?.r1 && 'x' in ops[0].fields.was.r1, 'the op carries the base value of what it changed');
  assert.equal(fake.doc.nodes.r1.x, 500);
  assert.equal(a.persistence.version(), fake.version);
  assert.equal(a.statuses.at(-1), 'saved');
  a.stop();
});

test('a lost ack: after the reconnect the op is answered from the catch-up, never applied twice', async () => {
  const fake = new FakeCollab(startDocument());
  const a = editor(fake);
  const b = editor(fake, {clientId: 'tab-b'});
  await flushAll();
  fake.loseAcks = true;
  move(a.store, 'r2', 222);
  void a.persistence.flush().catch(() => {});
  await flushAll();
  assert.equal(fake.doc.nodes.r2.x, 222, 'the server stored it');
  assert.equal(a.live.unacked(), 1, 'but the ack never came');
  // Someone else edits meanwhile; then the connection drops and comes back.
  fake.loseAcks = false;
  move(b.store, 'r3', 333);
  await b.persistence.flush();
  fake.drop();
  await until(() => a.live.status() === 'live' && a.live.unacked() === 0 && b.live.status() === 'live');
  assert.equal(a.live.status(), 'live');
  assert.equal(a.live.unacked(), 0);
  assert.deepEqual(fake.duplicates(), []);
  assert.ok(same(a.store.getState().doc, fake.doc), 'a holds the server document');
  assert.equal(a.statuses.at(-1), 'saved');
  a.stop();
  b.stop();
});

test('a re-sent op the server already stored is re-acked (an older server without ackedSeq)', async () => {
  const fake = new FakeCollab(startDocument());
  const a = editor(fake);
  await flushAll();
  fake.loseAcks = true;
  move(a.store, 'r4', 44);
  void a.persistence.flush().catch(() => {});
  await flushAll();
  fake.loseAcks = false;
  // The server forgets the client's high-water mark: the op goes again and the de-duplication answers it.
  fake.ackedSeq.clear();
  fake.drop();
  await until(() => a.live.status() === 'live' && a.live.unacked() === 0);
  assert.equal(fake.received.filter(message => message.t === 'op').length, 2, 'sent twice');
  assert.deepEqual(fake.duplicates(), [], 'applied once');
  assert.equal(a.live.unacked(), 0);
  assert.ok(same(a.store.getState().doc, fake.doc));
  a.stop();
});

test('offline: the save waits in the queue, the title says "No connection", and it goes after the reconnect', async () => {
  const fake = new FakeCollab(startDocument());
  const a = editor(fake);
  await flushAll();
  fake.offline = true;
  fake.drop();
  await flushAll();
  assert.equal(a.live.status(), 'offline');
  move(a.store, 'r5', 55);
  const stored = await a.persistence.flush().then(() => true, () => false);
  assert.equal(stored, false, 'a flush while offline says the change is not stored yet');
  assert.equal(a.statuses.at(-1), 'offline');
  assert.equal(a.live.unacked(), 1);
  fake.offline = false;
  a.network.dispatchEvent(new Event('online'));
  await until(() => a.live.unacked() === 0 && a.statuses.at(-1) === 'saved');
  assert.equal(fake.doc.nodes.r5.x, 55);
  assert.equal(a.live.unacked(), 0);
  assert.equal(a.statuses.at(-1), 'saved');
  a.stop();
});

test('a tab without an id of its own adopts a closed tab\'s id with ops left; never one another tab holds', async () => {
  const browser = browserTabs();
  const closed = await clientIdentity('f', {storage: browser.tab(), locks: browser.locks});
  closed.next();
  closed.next();
  const open = await clientIdentity('f', {storage: browser.tab(), locks: browser.locks});
  // `open` holds its id: a new tab passing both as orphans adopts neither while they are held.
  const busy = await clientIdentity('f', {storage: browser.tab(), locks: browser.locks, orphans: [closed.clientId, open.clientId]});
  assert.ok(busy.clientId !== closed.clientId && busy.clientId !== open.clientId);
  busy.release();
  closed.release();
  await flushAll(2);
  const fresh = await clientIdentity('f', {storage: browser.tab(), locks: browser.locks, orphans: ['not an id!', open.clientId, closed.clientId]});
  assert.equal(fresh.clientId, closed.clientId, 'the closed tab\'s id (its lock is free)');
  assert.equal(fresh.lastSeq, 0, 'its seqs come from the queue (the session raises the counter past them)');
  // A duplicate of `fresh` (same sessionStorage) cannot have it: a new id.
  const kv = browser.tab();
  kv.setItem('morfa:collab:f', JSON.stringify({clientId: fresh.clientId, lastSeq: 2}));
  const duplicate = await clientIdentity('f', {storage: kv, locks: browser.locks, orphans: [fresh.clientId]});
  assert.notEqual(duplicate.clientId, fresh.clientId);
  assert.equal(duplicate.lastSeq, 0);
  // Without Web Locks nothing tells a closed tab from an open one: no adoption.
  const unlocked = await clientIdentity('f', {storage: browser.tab(), locks: null, orphans: [closed.clientId]});
  assert.notEqual(unlocked.clientId, closed.clientId);
  for (const identity of [fresh, duplicate, open, unlocked]) identity.release();
});

test('ops a closed tab left in the queue go with the next tab that opens the file, once', async () => {
  const fake = new FakeCollab(startDocument());
  const queue = memoryQueue();
  const browser = browserTabs();
  const identity = (): SessionIdentity => (fileId, options) => clientIdentity(fileId, {storage: browser.tab(), locks: browser.locks, ...options});
  const first = editor(fake, {queue, identity: identity()});
  await flushAll();
  fake.offline = true;
  fake.drop();
  await flushAll();
  move(first.store, 'r7', 77);
  void first.persistence.flush().catch(() => {});
  await flushAll();
  assert.equal(queue.size(), 1);
  // The tab is closed while offline; another tab (its own sessionStorage) opens the file later.
  first.live.stop();
  await flushAll(2);
  assert.equal(browser.held.size, 0, 'the closed tab let its id go');
  fake.offline = false;
  const opened = fake.opened();
  const second = editor(fake, {queue, doc: opened.document, version: opened.file.version, identity: identity()});
  await until(() => second.live.unacked() === 0 && second.store.getState().doc.nodes.r7.x === 77);
  assert.equal(fake.doc.nodes.r7.x, 77, 'the closed tab\'s op reached the server');
  assert.equal(queue.size(), 0);
  assert.deepEqual(fake.duplicates(), []);
  // The adopting tab's own edits go on under the same id with later seqs.
  move(second.store, 'r8', 88);
  void second.persistence.flush().catch(() => {});
  await until(() => second.live.unacked() === 0 && fake.doc.nodes.r8.x === 88);
  assert.deepEqual(fake.duplicates(), []);
  second.stop();
  first.persistence.dispose();
});

test('an op refused over changes it had not seen (version_conflict) is rebased on them and goes again: no conflict', async () => {
  const fake = new FakeCollab(startDocument());
  const a = editor(fake, {clientId: 'tab-a'});
  const b = editor(fake, {clientId: 'tab-b'});
  await flushAll();
  for (let round = 0; round < 3; round++) {
    // b moves r1 and a recolours it at the same moment; the server refuses a's op (collab's interim merge policy).
    a.store.transact('Fill', tx => tx.update('r1', {fills: [solid({r: 0, g: round / 3, b: 1})]}));
    move(b.store, 'r1', 500 + round);
    void b.persistence.flush();
    fake.refuseNext = {code: 'version_conflict'};
    void a.persistence.flush();
    await until(() => !a.persistence.dirty() && !a.live.unacked() && !b.persistence.dirty() && a.live.version() === fake.version && b.live.version() === fake.version);
    assert.equal(fake.doc.nodes.r1.x, 500 + round, 'b\'s move');
    assert.equal((fake.doc.nodes.r1.fills[0] as {color: {g: number}}).color.g, round / 3, 'a\'s colour, sent again');
    assert.ok(same(a.store.getState().doc, fake.doc) && same(b.store.getState().doc, fake.doc));
  }
  assert.ok(!a.statuses.includes('conflict'));
  assert.deepEqual(fake.duplicates(), []);
  assert.equal(a.store.canUndo(), true, 'a\'s history kept');
  a.stop();
  b.stop();
});

test('a reload finds the ops the tab left unacked and applies them once', async () => {
  const fake = new FakeCollab(startDocument());
  const queue = memoryQueue();
  const first = editor(fake, {queue});
  await flushAll();
  fake.offline = true;
  fake.drop();
  await flushAll();
  move(first.store, 'r6', 66);
  void first.persistence.flush().catch(() => {});
  await flushAll();
  assert.equal(queue.size(), 1);
  // The tab reloads: the editor opens the stored document, which lacks the change.
  first.live.stop();
  fake.offline = false;
  const opened = fake.opened();
  const second = editor(fake, {queue, doc: opened.document, version: opened.file.version, lastSeq: 1});
  await until(() => second.live.unacked() === 0 && second.store.getState().doc.nodes.r6.x === 66);
  assert.equal(fake.doc.nodes.r6.x, 66, 'the queued op reached the server');
  assert.equal(second.store.getState().doc.nodes.r6.x, 66, 'and the reopened editor shows it');
  assert.equal(second.store.canUndo(), false, 'as a change it did not make itself');
  assert.equal(queue.size(), 0);
  assert.deepEqual(fake.duplicates(), []);
  second.stop();
  first.persistence.dispose();
});

test('refusals reach autosave as the api would answer: a refused value is put back, the rest saves', async () => {
  const fake = new FakeCollab(startDocument());
  const a = editor(fake);
  await flushAll();
  move(a.store, 'r7', 77);
  fake.refuseNext = {code: 'design_live_busy' as never};
  // An unknown refusal of one op: autosave keeps the change and retries (here: the next flush).
  await a.persistence.flush().catch(() => {});
  await a.persistence.flush();
  assert.equal(fake.doc.nodes.r7.x, 77);
  assert.equal(a.live.unacked(), 0);
  a.stop();
});

for (const snapshots of [false, true]) test(`beyond the journal's tail the reconnect reloads the ${snapshots ? 'snapshot' : 'document frame'}, unsaved changes on top`, async () => {
  const fake = new FakeCollab(startDocument(), 1, {tail: 5, snapshots});
  const a = editor(fake);
  await flushAll();
  fake.offline = true;
  fake.drop();
  await flushAll();
  // While away: an unsaved local edit here, 20 changes there (more than the tail of 5).
  move(a.store, 'r8', 88);
  for (let i = 0; i < 20; i++) fake.edit({nodes: {r9: {...fake.doc.nodes.r9, y: 900 + i}}});
  fake.offline = false;
  a.network.dispatchEvent(new Event('online'));
  await until(() => a.live.version() === fake.version);
  assert.equal(a.store.getState().doc.nodes.r9.y, 919, 'the reloaded document');
  assert.equal(a.store.getState().doc.nodes.r8.x, 88, 'the unsaved change on top');
  await a.persistence.flush();
  assert.equal(fake.doc.nodes.r8.x, 88);
  assert.ok(same(a.store.getState().doc, fake.doc));
  a.stop();
});

test('beyond the tail as crates/collab answers it (the ack before the document): the op is answered by the document at once, no save on a stale copy', async () => {
  const fake = new FakeCollab(startDocument(), 1, {tail: 5, collabReload: true, ownWhenBehind: false, mergeOnlyBehind: true});
  const a = editor(fake);
  await flushAll();
  fake.offline = true;
  fake.drop();
  await flushAll();
  // Away: one op queued (r8), then edits of r9 waiting behind it; 20 changes of r9's y there (past the tail of 5).
  move(a.store, 'r8', 88);
  void a.persistence.flush().catch(() => {});
  await flushAll();
  move(a.store, 'r9', 99);
  for (let i = 0; i < 20; i++) fake.edit({nodes: {r9: {...fake.doc.nodes.r9, y: 900 + i}}});
  const started = performance.now();
  fake.offline = false;
  a.network.dispatchEvent(new Event('online'));
  await until(() => a.live.version() === fake.version && !a.live.unacked() && !a.persistence.dirty() && fake.doc.nodes.r9.x === 99);
  assert.ok(performance.now() - started < 1_000, `answered by the document, not after the gap timeout (${(performance.now() - started).toFixed(0)} ms)`);
  assert.equal(fake.doc.nodes.r8.x, 88, 'the queued op');
  assert.equal(fake.doc.nodes.r9.y, 919, 'the others\' changes kept: the save after the reload carried the reloaded copy');
  assert.ok(same(a.store.getState().doc, fake.doc));
  a.stop();
});

test('a queued op refused after the document frame: the reload waited for it, then runs, and the op goes again on top', async () => {
  const fake = new FakeCollab(startDocument(), 1, {tail: 5});
  const a = editor(fake);
  await flushAll();
  fake.offline = true;
  fake.drop();
  await flushAll();
  // An op waiting in the queue; meanwhile 20 changes of the same layer there (past the tail of 5).
  move(a.store, 'r9', 99);
  void a.persistence.flush().catch(() => {});
  await flushAll();
  for (let i = 0; i < 20; i++) fake.edit({nodes: {r9: {...fake.doc.nodes.r9, y: 900 + i}}});
  // The reconnect: welcome, the document frame (its reload waits behind the op on its way), then the op is refused.
  fake.refuseNext = {code: 'version_conflict'};
  fake.offline = false;
  a.network.dispatchEvent(new Event('online'));
  await until(() => a.live.version() === fake.version && !a.live.unacked() && !a.persistence.dirty());
  assert.equal(fake.doc.nodes.r9.x, 99, 'the op, sent again over the reloaded document');
  assert.equal(fake.doc.nodes.r9.y, 919, 'the others\' changes kept');
  assert.ok(same(a.store.getState().doc, fake.doc));
  assert.ok(!a.statuses.includes('conflict'));
  a.stop();
});

// `own` on every ack of an op that was behind (Node's PATCH) or only on an adjusted one (crates/collab): an ack without
// it means the op landed as sent, on top of the changes before it.
for (const ownWhenBehind of [true, false]) test(`two editors with random drops and lost acks end with the server document, no op applied twice (own ${ownWhenBehind ? 'when behind' : 'only when adjusted'})`, async () => {
  for (let seed = 1; seed <= 30; seed++) {
    let state = seed;
    const rnd = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const fake = new FakeCollab(startDocument(), 1, {ownWhenBehind});
    const editors = [editor(fake), editor(fake, {clientId: 'tab-b'})];
    await flushAll();
    for (let step = 0; step < 60; step++) {
      const who = editors[Math.floor(rnd() * 2)];
      const roll = rnd();
      if (roll < 0.5) move(who.store, `r${Math.floor(rnd() * 40)}`, Math.floor(rnd() * 900));
      else if (roll < 0.6) who.store.transact('Fill', tx => tx.update(`r${Math.floor(rnd() * 40)}`, {fills: [solid({r: rnd(), g: 0, b: 0})]}));
      else if (roll < 0.8) void who.persistence.flush().catch(() => {});
      else if (roll < 0.88) fake.loseAcks = !fake.loseAcks;
      else if (roll < 0.95) fake.drop();
      await flushAll(3);
    }
    fake.loseAcks = false;
    for (let round = 0; round < 50 && editors.some(who => who.persistence.dirty() || who.live.unacked()); round++) {
      if (round % 10 === 9) fake.drop();
      for (const who of editors) void who.persistence.flush().catch(() => {});
      await flushAll(5);
    }
    // A reconnect (or a held ack) waits on a real timer: up to 2 s more without drops. Others' changes apply up to
    // REMOTE_APPLY_MS after they arrive, so each editor also catches up with the server's version.
    for (let i = 0; i < 400 && editors.some(who => who.persistence.dirty() || who.live.unacked() || who.live.version() !== fake.version); i++) {
      for (const who of editors) void who.persistence.flush().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    for (const [i, who] of editors.entries()) {
      assert.equal(who.live.unacked(), 0, `seed ${seed}: editor ${i} has unacked ops`);
      assert.ok(same(who.store.getState().doc, fake.doc), `seed ${seed}: editor ${i} differs from the server`);
    }
    assert.deepEqual(fake.duplicates(), [], `seed ${seed}: an op applied twice`);
    for (const who of editors) who.stop();
  }
});

/** One M8 run: correctness asserted, the times returned. */
async function m8(worker: boolean) {
  const fake = new FakeCollab(startDocument(200));
  const decoder = worker ? inProcessDecoder() : null;
  const a = editor(fake, decoder ? {decoder} : {});
  await flushAll();
  fake.offline = true;
  fake.drop();
  await flushAll();
  // 50 local edits while offline, one of them saved into the queue, the rest waiting behind it.
  for (let i = 0; i < 50; i++) {
    a.store.transact(`Edit ${i}`, tx => tx.update(`r${i}`, {x: 1000 + i}));
    if (i === 0) void a.persistence.flush().catch(() => {});
  }
  // 1 000 remote ops of 20 moved layers each (the TARGETS §3 load op), on layers this editor also changed.
  for (let i = 0; i < 1000; i++) {
    const patch: DocumentPatch = {nodes: {}};
    for (let k = 0; k < 20; k++) {
      const id = `r${(i * 7 + k * 11) % 200}`;
      patch.nodes![id] = {...fake.doc.nodes[id], y: i + k};
    }
    fake.edit(patch);
  }
  fake.offline = false;
  fake.busyMs = 0;
  const started = performance.now();
  a.network.dispatchEvent(new Event('online'));
  for (let i = 0; i < 400 && (a.live.unacked() || a.persistence.dirty() || !same(a.store.getState().doc, fake.doc)); i++) {
    if (!a.live.unacked() && a.persistence.dirty()) void a.persistence.flush().catch(() => {});
    await tick();
  }
  const converged = performance.now() - started;
  // The fake server runs in this process: its work (the merge, writing 1 000 changes as JSON) is the Rust server's in
  // production (M8's server row), so the client's share is what remains.
  const client = converged - fake.busyMs - (decoder?.busyMs ?? 0);
  const line = `converged in ${converged.toFixed(1)} ms: server ${fake.busyMs.toFixed(1)} ms, ${decoder ? `worker ${decoder.busyMs.toFixed(1)} ms (${decoder.frames} frames), ` : ''}client main thread ${client.toFixed(1)} ms`;
  if (decoder) assert.ok(decoder.frames >= 1, 'the catch-up went through the worker');
  assert.equal(documentHash(a.store.getState().doc), documentHash(fake.doc), 'the document hash equals the server\'s');
  assert.deepEqual(fake.duplicates(), [], 'no op applied twice');
  for (let i = 0; i < 50; i++) assert.equal(fake.doc.nodes[`r${i}`].x, 1000 + i, 'every local op landed');
  let undo = 0;
  while (a.store.canUndo()) {
    a.store.undo();
    undo++;
  }
  assert.equal(undo, 50, 'the undo history holds the 50 local steps, none of the remote ones');
  a.stop();
  return {converged, client, line};
}

for (const worker of [false, true]) test(`M8${worker ? ' (catch-up decoded in the worker)' : ''}: 30 s offline with 50 local ops and 1 000 missed remote ops converges within 500 ms, history intact`, async t => {
  // Correct on every run; the times are wall clock on a shared machine, so the best of up to three runs is compared
  // (each against a budget scaled to the machine as it runs then).
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const run = await m8(worker);
    t.diagnostic(run.line);
    // The client's share of M8 over ru-net leaves room for the RTT and the server's 100 ms.
    const within = run.converged <= budget(500) && run.client <= budget(250);
    if (within) return;
    last = `${run.line} (budgets ${budget(500).toFixed(0)} / ${budget(250).toFixed(0)} ms)`;
  }
  assert.fail(`M8 over budget three times: ${last}`);
});

test('a real socket: two editors over Node\'s WebSocket and the fake server converge', async () => {
  const fake = new FakeCollab(startDocument());
  const server = await fake.listen();
  const make = (clientId: string) => {
    const store = createDesignStore({doc: clone(fake.doc), measurer, idle: () => () => {}});
    const persistence = attachPersistence(store, {fileId: 'f', baseVersion: fake.version, events: null, timers: noTimers, onStatus: () => {}, onConflict: () => assert.fail('conflict'), request: async () => assert.fail('socket')});
    const live = startLiveSession({
      fileId: 'f', store, persistence, version: fake.version, canEdit: true, network: null, queue: memoryQueue(), identity: testIdentity(clientId),
      callbacks: {onAccess: () => {}, onEnd: reason => assert.fail('ended: ' + reason), onRename: () => {}},
      transport: wsTransport({io: server.io()}),
    });
    return {store, persistence, live};
  };
  const a = make('real-a'), b = make('real-b');
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(done());
  };
  await until(() => a.live.status() === 'live' && b.live.status() === 'live');
  move(a.store, 'r1', 101);
  move(b.store, 'r2', 202);
  await Promise.all([a.persistence.flush(), b.persistence.flush()]);
  await until(() => same(a.store.getState().doc, fake.doc) && same(b.store.getState().doc, fake.doc));
  // Presence travels too.
  a.live.presence.set({cursor: {x: 5, y: 6}, page: 'page'});
  await until(() => [...b.live.peers.peers().values()].some(peer => peer.cursor?.x === 5));
  for (const who of [a, b]) {
    who.live.stop();
    who.persistence.dispose();
  }
  await server.close();
});
