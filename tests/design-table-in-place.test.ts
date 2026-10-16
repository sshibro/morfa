import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDocument, createNode} from '../shared/design/defaults';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import {TableLog, snapshotDocument, tableCache} from '../shared/design/table-cache';
import {beginTransaction, type TableMode} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import {createDesignStore} from '../src/design/engine/store';
import {LayerRows} from '../src/design/panels/left/layer-rows';
import {createSavedState} from '../src/design/persistence/patch-guard';
import {runExport, type ExportServices} from '../src/design/panels/design/layout/export/run';
import {documentText} from '../server/design/document-text';
import {testMeasurer} from './helpers/design-big-files';
import {pageSlice, skeletonOf, type DesignPageSlice} from '../shared/design/pages';
import {fuzzDocument, mulberry32} from './helpers/design-fuzz';
import {randomRecipe} from './helpers/table-fuzz';

// The node table written in place: the conditions it must meet,
// each a test, beside the fuzz test of tests/design-transaction-inverse.test.ts (condition 1). Where a condition is about
// a reader, the test runs in both table modes: what holds with a copy must hold in place.

const MODES: readonly TableMode[] = ['copy', 'in-place'];
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function build(): DesignDocument {
  const doc = createDocument('page');
  const put = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!].children!.push(node.id);
  };
  put(createNode('FRAME', {id: 'f', name: 'frame', parentId: 'page', x: 0, y: 0, width: 300, height: 200, children: []}));
  put(createNode('RECTANGLE', {id: 'a', name: 'first', parentId: 'f', x: 10, y: 10, width: 40, height: 30}));
  put(createNode('RECTANGLE', {id: 'b', name: 'second', parentId: 'f', x: 60, y: 10, width: 40, height: 30}));
  put(createNode('RECTANGLE', {id: 'c', name: 'third', parentId: 'page', x: 400, y: 10, width: 40, height: 30}));
  return doc;
}

const rect = (id: NodeId, x = 0) => createNode('RECTANGLE', {id, name: id, x, y: 0, width: 20, height: 20});

// ── 2. The «show base» paths ─────────────────────────────────────────────────────────────────────

for (const table of MODES) {
  test(`${table}: a recipe that throws midway leaves the document as it was`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const before = store.getState().doc;
    const snapshot = plain(before);
    assert.throws(() =>
      store.transact('boom', tx => {
        tx.update('a', {x: 123});
        tx.create(rect('new'), 'f');
        tx.remove('b');
        throw new Error('boom');
      }),
    );
    assert.equal(store.getState().doc, before, 'the state is the one before');
    assert.deepEqual(plain(store.getState().doc), snapshot, 'and the document holds its values');
    // The store goes on: the next change commits as usual.
    store.transact('after', tx => tx.update('a', {x: 5}));
    assert.equal(store.getState().doc.nodes.a.x, 5);
    assert.ok(store.undo());
    assert.deepEqual(plain(store.getState().doc), snapshot);
  });

  test(`${table}: a gesture cancelled leaves the document as it was`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const snapshot = plain(store.getState().doc);
    const gesture = store.gesture('drag');
    gesture.update(tx => tx.update('a', {x: 50}));
    gesture.update(tx => {
      tx.update('a', {x: 80});
      tx.create(rect('while-dragging'), 'f');
    });
    assert.equal(store.getState().doc.nodes.a.x, 80, 'the frame is shown');
    gesture.cancel();
    assert.deepEqual(plain(store.getState().doc), snapshot);
    assert.equal(store.getState().history.undo, null, 'no undo step');
  });

  test(`${table}: a memory refusal during a gesture leaves the document as it was`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const snapshot = plain(store.getState().doc);
    store.setMemoryGuard(() => false);
    const gesture = store.gesture('draw');
    gesture.update(tx => tx.create(rect('drawn'), 'f'));
    assert.ok(store.getState().doc.nodes.drawn, 'the frame is shown while the gesture runs');
    assert.equal(gesture.commit(), null, 'refused: the budget is full and the change adds a layer');
    assert.deepEqual(plain(store.getState().doc), snapshot);
  });
}

// ── 3. The memory guard ───────────────────────────────────────────────────────────────────────────

for (const table of MODES) {
  test(`${table}: with a full budget a create is refused and the document unchanged; an edit goes through`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const snapshot = plain(store.getState().doc);
    store.setMemoryGuard(() => false);
    const refused = store.transact('create', tx => tx.create(rect('more'), 'f'));
    assert.deepEqual(refused.patch, {}, 'the change is dropped');
    assert.deepEqual(plain(store.getState().doc), snapshot);
    assert.equal(store.getState().doc.nodes.more, undefined);
    // A plain edit, and a removal, go through.
    store.transact('edit', tx => tx.update('a', {x: 77}));
    assert.equal(store.getState().doc.nodes.a.x, 77);
    store.transact('remove', tx => tx.remove('b'));
    assert.equal(store.getState().doc.nodes.b, undefined);
  });
}

// ── 4. Change detection never relies on table identity ───────────────────────────────────────────

for (const table of MODES) {
  test(`${table}: the layers panel sees a layer added and a layer removed`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const rows = new LayerRows(store.getState().doc, 'page', new Set(['f']));
    const ids = () => [...rows.ids].sort();
    assert.deepEqual(ids(), ['a', 'b', 'c', 'f']);
    store.transact('add', tx => tx.create(rect('d'), 'page'));
    assert.equal(rows.update(store.getState().doc), true, 'the rows changed');
    assert.deepEqual(ids(), ['a', 'b', 'c', 'd', 'f']);
    store.transact('remove', tx => tx.remove('a'));
    assert.equal(rows.update(store.getState().doc), true);
    assert.deepEqual(ids(), ['b', 'c', 'd', 'f']);
    store.transact('rename', tx => tx.update('b', {name: 'renamed'}));
    assert.equal(rows.update(store.getState().doc), false, 'a rename changes no row');
  });

  test(`${table}: the store's change events name what changed`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const seen: string[][] = [];
    store.onDocument(change => seen.push([...change.changed].sort()));
    store.transact('move', tx => tx.update('a', {x: 99}));
    store.transact('add', tx => tx.create(rect('d'), 'page'));
    assert.deepEqual(seen, [['a'], ['d', 'page']]);
  });
}

// ── 5. The autosave baseline ─────────────────────────────────────────────────────────────────────

for (const table of MODES) {
  test(`${table}: autosave knows the server's value from the inverse, and its node count moves`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const saved = createSavedState();
    store.onPatch(event => saved.note(event.patch, {inverse: event.inverse, after: event.doc}));
    const original = plain(store.getState().doc.nodes.a);
    store.transact('first', tx => tx.update('a', {x: 11}));
    const count = saved.nodeCount();
    store.transact('second', tx => tx.update('a', {x: 22, name: 'twice'}));
    const {server, local} = saved.changes(store.getState().doc);
    assert.deepEqual(plain(server.nodes!.a), original, 'the server still holds the node before the first edit');
    assert.equal((local.nodes!.a as SceneNode).x, 22);
    store.transact('add', tx => tx.create(rect('d'), 'page'));
    assert.equal(saved.nodeCount(), count + 1);
    assert.equal(saved.changes(store.getState().doc).server.nodes!.d, null, 'the server has no such node');
    store.transact('remove', tx => tx.remove('b'));
    assert.equal(saved.nodeCount(), count);
    assert.equal((saved.changes(store.getState().doc).server.nodes!.b as SceneNode).id, 'b', 'the server still has the removed node');
    store.undo();
    assert.equal(saved.nodeCount(), count + 1, 'undo brings it back');
  });
}

// ── 6. Reads inside a recipe ─────────────────────────────────────────────────────────────────────

test('a create into P and an update of P\'s child C in one call give the same patch in both modes', () => {
  const patches = MODES.map(table => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const result = store.transact('both', tx => {
      tx.create(rect('n', 5), 'f', 0);
      tx.update('a', {x: 99});
      // The base is the document before: a read after a write still sees the earlier value.
      assert.equal(tx.base.nodes.a.x, 10, `${table}: tx.base holds the value before the write`);
      assert.equal(tx.base.nodes.n, undefined, `${table}: tx.base lacks the created node`);
      assert.deepEqual(tx.base.nodes.f.children, ['a', 'b'], `${table}: tx.base's parent has its old children`);
      assert.equal(tx.get('a')!.x, 99, `${table}: the draft has the new value`);
    });
    return plain(result.patch);
  });
  assert.deepEqual(patches[0], patches[1]);
  assert.deepEqual(Object.keys(patches[1].nodes!).sort(), ['a', 'f', 'n']);
});

test('in place: the store\'s document is not written while the recipe runs', () => {
  const store = createDesignStore({doc: build(), measurer: testMeasurer, table: 'in-place'});
  const doc = store.getState().doc;
  store.transact('look', tx => {
    tx.update('a', {x: 99});
    tx.remove('b');
    tx.create(rect('n'), 'f');
    assert.equal(doc.nodes.a.x, 10, 'the published document still holds the old value');
    assert.ok(doc.nodes.b, 'and the removed node');
    assert.equal(doc.nodes.n, undefined, 'and not the created one');
    assert.deepEqual(Object.keys(tx.doc.nodes).sort(), ['a', 'c', 'f', 'n', 'page'], 'the draft enumerates with the overlay');
  });
  assert.equal(doc.nodes.a.x, 99, 'after the commit the same table holds the change');
  assert.equal(doc.nodes, store.getState().doc.nodes);
});

// ── 7. Async readers take an explicit snapshot ───────────────────────────────────────────────────

const exportServices = (): ExportServices => ({
  images: {whenReady: async () => {}} as unknown as ExportServices['images'],
  fonts: {measurer: testMeasurer, ensure: async () => {}} as unknown as ExportServices['fonts'],
});

for (const table of MODES) {
  test(`${table}: an export started before an edit, with the edit landing while it waits, gives the pre-edit output`, async () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const job = {nodeId: 'a', setting: {format: 'SVG' as const, suffix: '', constraint: {type: 'SCALE' as const, value: 1}}, path: 'a.svg'};
    const running = runExport(store.getState().doc, [job], exportServices());
    // The edit lands while the export waits for fonts and pictures.
    store.transact('resize', tx => tx.update('a', {width: 400, height: 300}));
    const [file] = await running;
    const svg = await file.blob.text();
    assert.match(svg, /width="40"/, 'the layer as it was when the export started');
    assert.doesNotMatch(svg, /width="400"/);
  });

  test(`${table}: snapshotDocument is a document of its own with the same entries`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    const live = store.getState().doc;
    const snapshot = snapshotDocument(live);
    assert.notEqual(snapshot.nodes, live.nodes);
    assert.equal(snapshot.nodes.a, live.nodes.a, 'the same node objects');
    store.transact('edit', tx => tx.update('a', {x: 99}));
    assert.equal(snapshot.nodes.a.x, 10);
  });
}

// ── 8. Key order ─────────────────────────────────────────────────────────────────────────────────

// With a copy, today as before, a re-created id goes to the end of the copied table while a replica keeps it in place: the
// condition is the in-place table's, whose writes land in the keys they had.
test('in place: a delete and re-create of the same id in one change keeps the table\'s key order (the stored bytes agree with a replica\'s)', () => {
  {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table: 'in-place'});
    const replica = plain(store.getState().doc);
    const result = store.transact('again', tx => {
      tx.remove('a');
      tx.create(createNode('RECTANGLE', {id: 'a', name: 'again', x: 1, y: 1, width: 20, height: 20}), 'f', 0);
    });
    const applied = applyPatch(replica, result.patch);
    assert.deepEqual(Object.keys(store.getState().doc.nodes), Object.keys(applied.nodes));
    assert.ok(documentText(store.getState().doc).equals(documentText(applied)), 'the same bytes');
  }
});

test('in place, the table\'s key order is a replica\'s (patch replay) after every commit; with a copy it was not, where normalization re-creates copies', () => {
  // Nothing compares a table's key order across replicas (collab's documentHash and the libraries' canonicalJson sort
  // keys; a checkpoint's SHA-256 covers its own bytes; autosave compares versions), so the order is a matter of the stored
  // bytes reading the same everywhere. In place adds no divergence: the live table lists its keys as a replica applying
  // the same patches does, commit by commit. A copy diverged where normalization deleted and re-created an instance's
  // children (they went to the copy's end) — the one divergence found before this step, left as it was in copy mode.
  const diverged = {copy: 0, 'in-place': 0};
  for (const seed of [1, 2, 3]) {
    for (const table of MODES) {
      const store = createDesignStore({doc: fuzzDocument(seed, {nodes: 150}), measurer: testMeasurer, table});
      let replica = plain(store.getState().doc);
      const rng = mulberry32(seed * 7 + 1);
      for (let step = 0; step < 20; step++) {
        let n = 0;
        const result = store.transact(`step ${step}`, randomRecipe(rng, () => `k-${seed}-${step}-${n++}`));
        replica = applyPatch(replica, result.patch);
        const live = Object.keys(store.getState().doc.nodes);
        if (live.join('\n') !== Object.keys(replica.nodes).join('\n')) diverged[table]++;
        assert.deepEqual(plain(store.getState().doc), plain(replica), `${table} seed ${seed} step ${step}: the values differ`);
        if (table === 'in-place') assert.deepEqual(live, Object.keys(replica.nodes), `seed ${seed} step ${step}: in place, the key order is the replica's`);
      }
    }
  }
  assert.equal(diverged['in-place'], 0);
  assert.ok(diverged.copy > 0, 'the copy mode\'s known divergence shows in these runs (else the runs test nothing)');
});

test('TableLog: a key deleted and present again goes back to its old place; revert restores every entry and the order', () => {
  const table: Record<string, SceneNode> = {};
  for (const id of ['x', 'y', 'z']) table[id] = rect(id);
  const log = new TableLog(table);
  log.deleting('y');
  delete table.y;
  log.touch('y');
  table.y = rect('y', 9);
  log.touch('w');
  table.w = rect('w');
  assert.deepEqual(Object.keys(table), ['x', 'z', 'y', 'w'], 'the re-created key sits at the end before the fix');
  log.restoreKeyOrder();
  assert.deepEqual(Object.keys(table), ['x', 'y', 'z', 'w']);
  assert.equal(table.y.x, 9);
  log.revert();
  assert.deepEqual(Object.keys(table), ['x', 'y', 'z']);
  assert.equal(table.y.x, 0);
});

// ── 9. The table caches ──────────────────────────────────────────────────────────────────────────

for (const table of MODES) {
  test(`${table}: an index cached for the table is derived through the change's ids, or dropped when it cannot be`, () => {
    const derivations: [NodeId, string | undefined, string | undefined][][] = [];
    const kept = tableCache<number>((previous, before, after, changed) => {
      derivations.push([...changed].map(id => [id, before[id]?.name, after[id]?.name]));
      return previous + 1;
    });
    const dropped = tableCache<string>(() => undefined);
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    kept.set(store.getState().doc.nodes, 1);
    dropped.set(store.getState().doc.nodes, 'index');
    store.transact('rename', tx => tx.update('a', {name: 'renamed'}));
    const nodes = store.getState().doc.nodes;
    assert.equal(kept.get(nodes), 2, 'derived once, from the index of the table before');
    // (The ops oracle's mirror, in `both`, derives for its own table too: the first derivation is this table's.)
    assert.deepEqual(derivations[0], [['a', 'first', 'renamed']], 'with the entry before and after');
    assert.equal(dropped.get(nodes), undefined, 'an index that cannot be derived is rebuilt on demand');
    // Undo applies a patch: the indexes follow the same way.
    const count = derivations.length;
    store.undo();
    assert.equal(kept.get(store.getState().doc.nodes), 3);
    assert.equal(derivations[count][0][0], 'a');
  });
}

// ── Lane K's review (two store fixes, 14:17) ─────────────────────────────────────────────────────

/** Three pages of `n` rectangles each (as tests/design-memory-watch.test.ts builds them). */
function pagesOf(n: number): DesignDocument {
  const tx = beginTransaction(createDocument('p1'));
  tx.addPage(createNode('PAGE', {id: 'p2', name: 'Second'}));
  tx.addPage(createNode('PAGE', {id: 'p3', name: 'Third'}));
  for (const page of ['p1', 'p2', 'p3']) for (let i = 0; i < n; i++) tx.create(createNode('RECTANGLE', {id: `${page}r${i}`, x: i, y: i}), page);
  return tx.commit({measurer: testMeasurer}).doc;
}

for (const table of MODES) {
  for (const end of ['commit', 'cancel'] as const) {
    test(`${table}: a page whose load resolves during a drag is installed when the drag ends (${end})`, async () => {
      const whole = pagesOf(3);
      let resolveLoad!: (slice: DesignPageSlice) => void;
      const load = (pageId: NodeId) => (pageId === 'p2' ? new Promise<DesignPageSlice>(resolve => (resolveLoad = resolve)) : Promise.resolve({version: 1, nodes: pageSlice(whole, pageId)}));
      const store = createDesignStore({doc: skeletonOf(whole, ['p1']), measurer: testMeasurer, idle: work => (work(), () => {}), partial: {loaded: ['p1'], layers: {p1: 3, p2: 3, p3: 3}, load}, table});
      const sources: string[] = [];
      store.onPatch(event => sources.push(event.source));
      const loading = store.ensurePage('p2');
      const gesture = store.gesture('drag');
      gesture.update(tx => tx.update('p1r0', {x: 50}));
      resolveLoad({version: 1, nodes: pageSlice(whole, 'p2')});
      await loading;
      // The slice waits: a gesture's frames write a table of their own from the gesture's base.
      assert.equal(store.getState().doc.nodes.p2r0, undefined, 'not while the drag runs');
      assert.equal(store.getState().pages!.loaded.has('p2'), false);
      if (end === 'commit') gesture.commit();
      else gesture.cancel();
      assert.ok(store.getState().doc.nodes.p2r0, 'the page\'s layers are in the document once the drag ends');
      assert.deepEqual([...store.getState().pages!.loaded].sort(), ['p1', 'p2']);
      assert.ok(sources.includes('page'), 'and a page patch was emitted for them');
      assert.equal(store.getState().doc.nodes.p1r0.x, end === 'commit' ? 50 : 0);
    });
  }

  test(`${table}: undo after a remote change to the same node: the event's inverse is what the document held before the undo`, () => {
    const store = createDesignStore({doc: build(), measurer: testMeasurer, table});
    store.transact('edit', tx => tx.update('a', {x: 111}));
    const remote = {...store.getState().doc.nodes.a, name: 'remote'};
    store.applyRemote(() => ({nodes: {a: remote}}));
    assert.equal(store.getState().doc.nodes.a.name, 'remote');
    const events: {source: string; inverse: DocumentPatch; patch: DocumentPatch}[] = [];
    store.onPatch(event => events.push(event));
    assert.ok(store.undo());
    const event = events.at(-1)!;
    assert.equal(event.source, 'undo');
    assert.equal((event.inverse.nodes!.a as SceneNode).name, 'remote', 'the inverse holds the remote value, not the edit\'s own before-value');
    assert.equal((event.inverse.nodes!.a as SceneNode).x, 111);
    assert.equal(store.getState().doc.nodes.a.x, 10, 'the undo took the edit back');
    // The inverse takes the undo back: redo by patch gives the document before the undo, remote rename included.
    assert.equal(applyPatch(store.getState().doc, event.inverse).nodes.a.name, 'remote');
  });
}

// ── The switch itself ────────────────────────────────────────────────────────────────────────────

test('the table mode is a per-call option of the transaction; the module default is copy', () => {
  const doc = build();
  const copied = beginTransaction(doc);
  copied.update('a', {x: 1});
  const viaCopy = copied.commit({measurer: testMeasurer});
  assert.notEqual(viaCopy.doc.nodes, doc.nodes, 'a copy by default');
  assert.equal(doc.nodes.a.x, 10);
  const own = beginTransaction(doc, {table: 'in-place'});
  own.update('a', {x: 2});
  const inPlace = own.commit({measurer: testMeasurer});
  assert.equal(inPlace.doc.nodes, doc.nodes, 'the document\'s own table, written');
  assert.equal(doc.nodes.a.x, 2);
  assert.deepEqual(plain(inPlace.inverse.nodes!.a), plain(viaCopy.inverse.nodes!.a), 'the same inverse');
  assert.throws(() => beginTransaction(doc, {table: 'in-place', scratch: {base: doc, table: null, changed: new Set()}}), /no scratch/);
});

test('the store takes a table of its own at the start in place: the caller\'s document stays what it was', () => {
  const doc = build();
  const store = createDesignStore({doc, measurer: testMeasurer, table: 'in-place'});
  store.transact('edit', tx => tx.update('a', {x: 99}));
  assert.equal(doc.nodes.a.x, 10);
  assert.equal(store.getState().doc.nodes.a.x, 99);
  assert.equal(store.table, 'in-place');
});
