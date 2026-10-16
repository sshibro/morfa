import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {normalizeDetailed} from '../shared/design/normalize';
import {isEmptyPatch, type DocumentPatch} from '../shared/design/patch';
import {checkPatchedDocument, validateDocument} from '../shared/design/schema';
import {insertText} from '../shared/design/text-edit';
import {same} from '../shared/design/merge';
import type {DesignChange, DesignPatchContext, DesignSaved} from '../shared/design/api';
import type {DesignLiveChange} from '../shared/design/live';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import {applyDocumentChange, layOutChange, storedValues} from '../server/design/apply';
import {createDesignStore, type DesignStore, type Gesture} from '../src/design/engine/store';
import {attachPersistence, type SessionPersistence} from '../src/design/editor/editor-session';
import {startLiveSession, type LiveSession} from '../src/design/realtime/live-session';
import type {StreamEvent} from '../src/design/realtime/stream';
import {sseTransport} from '../src/design/realtime/transport/sse';
import {wsTransport} from '../src/design/realtime/transport/ws';
import {memoryQueue} from '../src/design/realtime/offline-queue';
import {FakeCollab} from './helpers/fake-collab';
import {testIdentity, TRANSPORTS, type TransportKind} from './helpers/live-transports';

// Co-editing end to end without a network (docs/design-tool.md "Real-time collaboration"): two editors (the real store,
// autosave and live session) and a server that runs the server's own apply step (server/design/apply.ts) and checks,
// with every save answer and stream event delivered in a random order. Whatever the order, once everything is delivered
// and saved, both editors and the server hold the same document, and every stored version passed the server's checks.
// Both transports: `sse` (PATCH answers and stream events, each delivered whenever the test picks)
// and `ws` (ops, acks and changes on one socket per editor, its frames in their order, the sockets interleaved).

/** DESIGN_SERVER_LAYOUT=1 the PATCH server lays out every merged save and says so (answer and hello), so the
 *  editors on `sse` never correct. Collab does not lay out (its welcome carries no `layout`): editors on `ws` keep
 *  correcting with the flag or without it. */
const serverLayout = process.env.DESIGN_SERVER_LAYOUT === '1';
/** Saves the editors made as their own layout correction (live-session.ts `relayout`), per transport. */
const corrections: Record<TransportKind, number> = {sse: 0, ws: 0};
/** Counts the store's correction transactions (live-session.ts `relayout` labels them so). */
function countCorrections(store: DesignStore, kind: TransportKind) {
  const transact = store.transact.bind(store);
  store.transact = ((label: string, ...rest: unknown[]) => {
    if (label === 'Co-editing') corrections[kind]++;
    return (transact as (...args: unknown[]) => unknown)(label, ...rest);
  }) as typeof store.transact;
}

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

/** A seeded generator (mulberry32): a failing seed reproduces. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {next, int: (n: number) => Math.floor(next() * n), pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]};
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function startDocument(): DesignDocument {
  let doc = createDocument('page');
  const tx = beginTransaction(doc);
  tx.create(createNode('FRAME', {id: 'F1', x: 0, y: 0, width: 400, height: 400}), 'page');
  tx.create(createNode('FRAME', {id: 'F2', x: 500, y: 0, width: 400, height: 400}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'r1', x: 10, y: 10, width: 40, height: 40}), 'F1');
  tx.create(createNode('RECTANGLE', {id: 'r2', x: 60, y: 10, width: 40, height: 40}), 'F1');
  tx.create(createNode('ELLIPSE', {id: 'e1', x: 10, y: 10, width: 40, height: 40}), 'F2');
  const text = defaultTextProps('First sentence. Second sentence.');
  tx.create(createNode('TEXT', {id: 't1', x: 20, y: 200, width: 300, height: 20, text: {...text, textAutoResize: 'NONE'}}), 'F1');
  // An auto-layout row whose size hugs its children, an auto-width text in it, and a group.
  tx.create(createNode('FRAME', {id: 'A1', x: 0, y: 500, width: 100, height: 60, autoLayout: {...createNode('FRAME', {id: 'tmp'}).autoLayout!, layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: 10, paddingRight: 10, paddingTop: 10, paddingBottom: 10}, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'a1', width: 40, height: 40}), 'A1');
  tx.create(createNode('TEXT', {id: 't2', text: {...defaultTextProps('Button'), textAutoResize: 'WIDTH_AND_HEIGHT'}}), 'A1');
  tx.create(createNode('GROUP', {id: 'G1', x: 600, y: 500, width: 10, height: 10}), 'page');
  tx.create(createNode('ELLIPSE', {id: 'g1', x: 0, y: 0, width: 30, height: 30}), 'G1');
  tx.create(createNode('ELLIPSE', {id: 'g2', x: 50, y: 20, width: 30, height: 30}), 'G1');
  doc = tx.commit({measurer}).doc;
  assert.ok(validateDocument(clone(doc)).ok);
  return doc;
}

/** The server: one document, numbered versions, the change log, and a stream per connection (others' changes only). */
class Server {
  doc: DesignDocument;
  version = 1;
  log: DesignChange[] = [];
  streams = new Map<string, (change: DesignLiveChange) => void>();
  stored = 0;
  /** Saves made on an older version (merged), and saves stored differently from what was sent. */
  behind = 0;
  adjusted = 0;
  constructor(doc: DesignDocument) {
    this.doc = clone(doc);
  }
  handle(base: number, patch: DocumentPatch, context: DesignPatchContext | undefined, by: string | null): DesignSaved {
    assert.ok(context?.before, 'co-editing saves carry before copies');
    assert.ok(base <= this.version);
    // The wire: what the server gets is JSON.
    const sent = clone(patch);
    const behind = this.version > base;
    const merged = applyDocumentChange(this.doc, {patch: sent, before: clone(context.before), beforeTables: context.beforeTables && clone(context.beforeTables)});
    const applied = serverLayout && !isEmptyPatch(merged.stored) ? layOutChange(merged, measurer) : {...merged, laidOut: false};
    const layout = applied.laidOut ? {layout: 'server' as const} : {};
    if (behind) this.behind++;
    if (applied.adjusted) this.adjusted++;
    const changes = behind ? this.log.filter(change => change.version > base) : [];
    if (isEmptyPatch(applied.stored))
      return {version: this.version, updatedAt: '', ...(changes.length ? {changes: clone(changes)} : {}), ...(behind || applied.adjusted ? {own: clone(storedValues(this.doc, sent, {}))} : {})};
    const checked = checkPatchedDocument(this.doc, applied.doc, applied.stored);
    assert.ok(checked.ok, !checked.ok ? `the server refused a merged save: ${checked.error} at ${checked.path}` : '');
    const full = validateDocument(clone(applied.doc));
    assert.ok(full.ok, !full.ok ? `a stored document is invalid: ${full.error} at ${full.path}` : '');
    this.doc = applied.doc;
    this.version++;
    this.stored++;
    const change = {version: this.version, patch: clone(applied.stored)};
    this.log.push(change);
    for (const [connection, push] of this.streams) if (connection !== by) push({...change, by, user: 'u'});
    return {version: this.version, updatedAt: '', ...(changes.length ? {changes: clone(changes)} : {}), ...(behind || applied.adjusted ? {own: clone(storedValues(this.doc, sent, applied.stored))} : {}), ...layout};
  }
}

const noTimers = {setTimeout: () => 1, clearTimeout: () => {}};

type Editor = {
  name: string;
  store: DesignStore;
  persistence: SessionPersistence;
  live: LiveSession;
  /** Something is waiting to be delivered to this editor. */
  waiting(): boolean;
  /** Delivers one save answer (sse) or the next frame of the socket (ws); false when there was none. */
  answer(): boolean;
  /** Delivers one stream event (sse) or the next frame of the socket (ws). */
  event(): boolean;
  gesture: Gesture | null;
};

/** What the editors talk to: the PATCH server and its streams, or the fake collab. */
type Harness = {kind: TransportKind; doc(): DesignDocument; version(): number; editor(name: string): Editor; stats(): {stored: number; behind: number; adjusted: number}};

function sseHarness(start: DesignDocument): Harness {
  const server = new Server(start);
  return {kind: 'sse', doc: () => server.doc, version: () => server.version, stats: () => ({stored: server.stored, behind: server.behind, adjusted: server.adjusted}), editor: name => sseEditor(name, server)};
}

function wsHarness(start: DesignDocument): Harness {
  const fake = new FakeCollab(start);
  return {
    kind: 'ws',
    doc: () => fake.doc,
    version: () => fake.version,
    stats: () => {
      assert.deepEqual(fake.duplicates(), [], 'no op applied twice');
      return {stored: fake.versionsStored, behind: fake.behind, adjusted: fake.adjusted};
    },
    editor(name) {
      const store = createDesignStore({doc: clone(fake.doc), measurer, idle: () => () => {}});
      countCorrections(store, 'ws');
      const persistence = attachPersistence(store, {
        fileId: 'f', baseVersion: fake.version, events: null, timers: noTimers,
        onStatus: () => {},
        onConflict: () => assert.fail('no conflicts while co-editing'),
        onStopped: report => assert.fail(`${name}: saving stopped: ${report.message}`),
        request: async () => assert.fail('the socket carries the saves'),
      });
      const io = fake.memoryIo({autoDeliver: false});
      const live = startLiveSession({
        fileId: 'f', store, persistence, version: fake.version, canEdit: true, timers: noTimers, network: null,
        queue: memoryQueue(), identity: testIdentity('client-' + name),
        callbacks: {onAccess: () => assert.fail('access'), onEnd: reason => assert.fail('ended: ' + reason), onRename: () => {}},
        transport: wsTransport({io}),
      });
      const socket = () => io.sockets.at(-1);
      const next = () => (socket()?.deliver(1) ?? 0) > 0;
      return {name, store, persistence, live, gesture: null, waiting: () => (socket()?.inbox.length ?? 0) > 0, answer: next, event: next};
    },
  };
}

function sseEditor(name: string, server: Server): Editor {
  const store = createDesignStore({doc: clone(server.doc), measurer, idle: () => () => {}});
  countCorrections(store, 'sse');
  const answers: (() => void)[] = [];
  const events: StreamEvent[] = [];
  let emit: ((event: StreamEvent) => void) | null = null;
  const connection = name + '-connection';
  const persistence = attachPersistence(store, {
    fileId: 'f',
    baseVersion: server.version,
    events: null,
    timers: noTimers,
    onStatus: () => {},
    onConflict: () => assert.fail('no conflicts while co-editing'),
    onStopped: report => assert.fail(`${name}: saving stopped: ${report.message}`),
    request: (_id, base, patch, _init, context) => {
      const answer = server.handle(base, patch, context, context?.client ?? null);
      return new Promise(resolve => answers.push(() => resolve(answer)));
    },
  });
  server.streams.set(connection, change => events.push({event: 'change', data: JSON.stringify(change), id: String(change.version)}));
  const live = startLiveSession({
    fileId: 'f',
    store,
    persistence,
    version: server.version,
    canEdit: true,
    timers: noTimers,
    callbacks: {onAccess: () => assert.fail('access'), onEnd: reason => assert.fail('ended: ' + reason), onRename: () => {}},
    transport: sseTransport({
      stream: (_url, init, onEvent) => {
        emit = onEvent;
        onEvent({event: 'hello', data: JSON.stringify({connection, token: 'token-' + name, version: server.version, role: 'editor', canEdit: true, user: name, name, color: 0, peers: [], ...(serverLayout ? {layout: 'server'} : {})}), id: null});
        return new Promise(resolve => init.signal?.addEventListener('abort', () => resolve()));
      },
      open: async () => ({file: {id: 'f', name: 'f', version: server.version, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}, document: clone(server.doc)}),
      presence: async () => true,
      sleep: async () => {},
    }),
  });
  return {
    name, store, persistence, live, gesture: null,
    waiting: () => answers.length > 0 || events.length > 0,
    answer: () => {
      const next = answers.shift();
      next?.();
      return !!next;
    },
    event: () => {
      const next = events.shift();
      if (next) emit!(next);
      return !!next;
    },
  };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** One random edit, as a designer makes them: the transactions the editor's commands use. */
function edit(rng: ReturnType<typeof random>, who: Editor) {
  const {store} = who;
  const doc = store.getState().doc;
  const ids = Object.keys(doc.nodes).filter(id => doc.nodes[id].type !== 'PAGE').sort();
  const containers = Object.keys(doc.nodes).filter(id => ['PAGE', 'FRAME', 'GROUP'].includes(doc.nodes[id].type)).sort();
  const any = () => rng.pick(ids);
  const kind = rng.int(14);
  try {
    if (!ids.length && kind !== 2) return;
    switch (kind) {
      case 11: {
        // Auto layout: a child added to (or a spacing changed in) a row the other may be changing too.
        const rows = Object.keys(doc.nodes).filter(id => doc.nodes[id].autoLayout?.layoutMode === 'HORIZONTAL').sort();
        if (!rows.length) return;
        const row = rng.pick(rows);
        if (rng.next() < 0.5) store.transact('Gap', tx => tx.update(row, {autoLayout: {...doc.nodes[row].autoLayout!, itemSpacing: rng.int(24)}}));
        else store.transact('Add to row', tx => tx.create(createNode('RECTANGLE', {id: who.name + '-' + Math.floor(rng.next() * 1e9).toString(36), width: 10 + rng.int(40), height: 10 + rng.int(40)}), row));
        break;
      }
      case 12: {
        // An auto-width text typed in.
        const texts = ids.filter(id => doc.nodes[id].text?.textAutoResize === 'WIDTH_AND_HEIGHT');
        if (!texts.length) return;
        const id = rng.pick(texts), text = doc.nodes[id].text!;
        const at = rng.int(text.characters.length + 1);
        store.transact('Text', tx => tx.update(id, {text: insertText(text, at, at, rng.pick(['a', 'Ok', ' so']))}));
        break;
      }
      case 13: {
        // A layer of a group moved: the group fits its children.
        const inGroups = ids.filter(id => doc.nodes[doc.nodes[id].parentId!]?.type === 'GROUP');
        if (!inGroups.length) return;
        store.transact('Position', tx => tx.update(rng.pick(inGroups), {x: rng.int(200), y: rng.int(200)}));
        break;
      }
      case 0:
        store.transact('Position', tx => tx.update(any(), {x: rng.int(300), y: rng.int(300)}));
        break;
      case 1:
        store.transact('Fill', tx => tx.update(any(), {fills: [solid({r: rng.next(), g: rng.next(), b: rng.next()})]}));
        break;
      case 2: {
        const id = who.name + '-' + Math.floor(rng.next() * 1e9).toString(36);
        store.transact('Rectangle', tx => tx.create(createNode('RECTANGLE', {id, x: rng.int(200), y: rng.int(200), width: 10 + rng.int(50), height: 10 + rng.int(50)}), rng.pick(containers)));
        break;
      }
      case 3:
        store.transact('Delete', tx => tx.remove(any()));
        break;
      case 4:
        store.transact('Move', tx => tx.move(any(), rng.pick(containers)));
        break;
      case 5: {
        const id = any();
        const siblings = doc.nodes[doc.nodes[id].parentId!].children!.length;
        store.transact('Reorder', tx => tx.reorder(id, rng.int(siblings)));
        break;
      }
      case 6: {
        const texts = ids.filter(id => doc.nodes[id].type === 'TEXT');
        if (!texts.length) return;
        const id = rng.pick(texts), text = doc.nodes[id].text!;
        const at = rng.int(text.characters.length + 1), to = Math.min(text.characters.length, at + rng.int(3));
        store.transact('Text', tx => tx.update(id, {text: insertText(text, at, to, rng.pick(['a', 'B', ' sun', '', 'xyz']))}));
        break;
      }
      case 7:
        store.transact('Name', tx => tx.update(any(), {name: 'Layer ' + rng.int(100)}));
        break;
      case 8:
        store.undo();
        break;
      case 9:
        store.redo();
        break;
      case 10: {
        // A drag: remote changes that arrive meanwhile wait for its end.
        if (who.gesture?.active) {
          who.gesture.commit();
          who.gesture = null;
          break;
        }
        const id = any();
        who.gesture = store.gesture('Drag');
        who.gesture.update(tx => tx.update(id, {x: rng.int(300)}));
        break;
      }
    }
  } catch (error) {
    // A move into its own subtree and the like: the editor refuses it too.
    if (!(error instanceof Error) || !/cannot|own subtree|exist|missing|Removing|move|hold/i.test(error.message)) throw error;
  }
}

async function settle(editors: Editor[]) {
  for (let round = 0; round < 400; round++) {
    let busy = false;
    for (const who of editors) {
      if (who.gesture?.active) {
        who.gesture.commit();
        who.gesture = null;
      }
      while (who.event()) busy = true;
      while (who.answer()) {
        busy = true;
        await tick();
      }
      if (who.persistence.dirty()) {
        busy = true;
        void who.persistence.flush().catch(() => {});
        await tick();
      }
    }
    await tick();
    if (!busy && editors.every(who => !who.waiting() && !who.persistence.dirty())) return;
  }
  assert.fail('the editors did not settle');
}

const describe = (doc: DesignDocument) => JSON.stringify({pages: doc.pages, nodes: Object.keys(doc.nodes).sort().map(id => [id, doc.nodes[id].parentId, doc.nodes[id].children])});

async function run(kind: TransportKind, seed: number, steps: number) {
  const rng = random(seed);
  const harness = (kind === 'sse' ? sseHarness : wsHarness)(startDocument());
  const editors = [harness.editor('a'), harness.editor('b')];
  await tick();
  for (let step = 0; step < steps; step++) {
    const who = rng.pick(editors);
    const action = rng.int(10);
    if (action < 5) edit(rng, who);
    else if (action < 7) {
      if (!who.persistence.autosave()?.busy()) void who.persistence.flush().catch(() => {});
    } else if (action < 9) who.answer();
    else who.event();
    await tick();
  }
  await settle(editors);
  const serverDoc = harness.doc();
  for (const who of editors) {
    const doc = who.store.getState().doc;
    if (!same(doc, serverDoc)) {
      assert.equal(describe(doc), describe(serverDoc), `${kind} seed ${seed}: ${who.name}'s structure differs from the server's`);
      const differing = Object.keys({...doc.nodes, ...serverDoc.nodes}).filter(id => !same(doc.nodes[id], serverDoc.nodes[id]));
      assert.fail(`${kind} seed ${seed}: ${who.name} differs from the server at ${differing.join(', ')}: ${JSON.stringify(differing.map(id => [doc.nodes[id], serverDoc.nodes[id]]))}`);
    }
    assert.ok(validateDocument(clone(doc)).ok);
  }
  // Whatever was combined was laid out again by the editor that combined it: auto layout, group boxes and text sizes
  // are those the layout gives (normalizing the whole file moves nothing).
  const laid = normalizeDetailed(serverDoc, new Set(Object.keys(serverDoc.nodes)), {measurer});
  const moved = [...laid.changed].filter(id => !same(laid.doc.nodes[id], serverDoc.nodes[id]));
  assert.deepEqual(moved, [], `${kind} seed ${seed}: layers not laid out: ${JSON.stringify(moved.map(id => [serverDoc.nodes[id], laid.doc.nodes[id]]))}`);
  for (const who of editors) {
    who.live.stop();
    who.persistence.dispose();
  }
  return harness.stats();
}

for (const kind of TRANSPORTS) {
  test(`${kind}: two editors and the server end with one document, whatever the order of answers and events`, async t => {
    let stored = 0, behind = 0, adjusted = 0;
    corrections[kind] = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const stats = await run(kind, seed, 80);
      stored += stats.stored;
      behind += stats.behind;
      adjusted += stats.adjusted;
    }
    t.diagnostic(`stored ${stored}, merged onto a newer version ${behind}, adjusted ${adjusted}, editors' layout corrections ${corrections[kind]}`);
    // With the server laying out (sse with DESIGN_SERVER_LAYOUT=1), two editors never correct each other (nor anything).
    // Collab does not lay out: on the socket the editors' correction stays the rule.
    if (kind === 'sse' && serverLayout) assert.equal(corrections[kind], 0, 'layout corrections made by editors');
    else assert.ok(corrections[kind] > 0, `the editors corrected merged layouts (${corrections[kind]})`);
    assert.ok(stored > 1_000, `the runs stored versions (${stored})`);
    // The orders really interleave: many saves land on versions their editor had not seen, and the merge changes some.
    assert.ok(behind > stored / 10, `saves made on an older version: ${behind}`);
    assert.ok(adjusted > 20, `saves the merge adjusted: ${adjusted}`);
  });

  test(`${kind}: long sessions converge too`, async () => {
    for (const seed of [1001, 1002, 1003, 1004, 1005]) await run(kind, seed, 600);
  });

  test(`${kind}: a remote change waits for a drag and the drag keeps its own change`, async () => {
    const harness = (kind === 'sse' ? sseHarness : wsHarness)(startDocument());
    const [a, b] = [harness.editor('a'), harness.editor('b')];
    await tick();
    const drag = a.store.gesture('Drag');
    drag.update(tx => tx.update('r1', {x: 123}));
    b.store.transact('Fill', tx => tx.update('r1', {fills: [solid({r: 1, g: 0, b: 0})]}));
    void b.persistence.flush();
    assert.ok(b.answer());
    await tick();
    while (a.event()) await tick();
    assert.equal(a.store.getState().doc.nodes.r1.x, 123, 'the drag is not interrupted');
    assert.equal(a.store.remotePending(), 1, 'the remote change waits');
    assert.equal(a.store.getState().doc.nodes.r1.fills[0].type, 'SOLID');
    drag.commit();
    assert.equal(a.store.remotePending(), 0);
    const r1 = a.store.getState().doc.nodes.r1;
    assert.equal(r1.x, 123);
    assert.deepEqual((r1.fills[0] as {color: unknown}).color, {r: 1, g: 0, b: 0});
    assert.equal(a.store.canUndo(), true);
    a.store.undo();
    // Undo reverts only a's own field: b's fill stays.
    assert.equal(a.store.getState().doc.nodes.r1.x, 10);
    assert.deepEqual((a.store.getState().doc.nodes.r1.fills[0] as {color: unknown}).color, {r: 1, g: 0, b: 0});
    await settle([a, b]);
    assert.ok(same(a.store.getState().doc, harness.doc()) && same(b.store.getState().doc, harness.doc()));
    for (const who of [a, b]) {
      who.live.stop();
      who.persistence.dispose();
    }
  });

  test(`${kind}: undo never brings back a layer someone else removed`, async () => {
    const harness = (kind === 'sse' ? sseHarness : wsHarness)(startDocument());
    const [a, b] = [harness.editor('a'), harness.editor('b')];
    await tick();
    a.store.transact('Position', tx => tx.update('r2', {x: 77}));
    await settle([a, b]);
    b.store.transact('Delete', tx => tx.remove('r2'));
    await settle([a, b]);
    assert.equal(a.store.getState().doc.nodes.r2, undefined);
    a.store.undo();
    assert.equal(a.store.getState().doc.nodes.r2, undefined, 'the removal stays');
    await settle([a, b]);
    assert.ok(same(a.store.getState().doc, harness.doc()) && same(b.store.getState().doc, harness.doc()));
    assert.ok(validateDocument(clone(harness.doc())).ok);
    for (const who of [a, b]) {
      who.live.stop();
      who.persistence.dispose();
    }
  });
}

void ({} as NodeId | SceneNode);
