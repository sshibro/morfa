import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyPatch} from '../shared/design/patch';
import {createNode} from '../shared/design/defaults';
import type {Transaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId} from '../shared/design/types';
import type {DocumentPatch} from '../shared/design/patch';
import {createDesignStore} from '../src/design/engine/store';
import type {TableMode} from '../shared/design/transaction';
import {testMeasurer} from './helpers/design-big-files';
import {fuzzDocument, mulberry32} from './helpers/design-fuzz';
import {randomRecipe} from './helpers/table-fuzz';
import {fuzzDocument as l2cDocument} from './helpers/l2c-fuzz';

// The invariant every commit of the editor store keeps, whatever the node table does underneath (a table copied per commit, or one table written in place with the previous values living only in the
// inverse): after a commit, `applyPatch(after, inverse)` is the document before it, value for
// value; the inverse names exactly the entries the patch names; the patch replayed on the document before reproduces the
// committed document; and the store's undo and redo land on those same documents. `before` is compared as a value copy
// taken before the commit, never through the object itself, so the test holds in both table modes.

const TABLES = ['nodes', 'styles', 'images', 'variableCollections', 'variables', 'variableModes'] as const;

/** A value copy: what the document says, free of object identity (and of `undefined` fields, as the stored JSON is). */
const plain = (doc: DesignDocument): DesignDocument => JSON.parse(JSON.stringify(doc)) as DesignDocument;

const keysOf = (patch: DocumentPatch, table: (typeof TABLES)[number]) => Object.keys(patch[table] ?? {}).sort();

/** Runs `count` random commits on a store of `doc` and checks the invariant after each; returns how many changed something. */
function checkCommits(doc: DesignDocument, seed: number, count: number, label: string, table: TableMode): number {
  const r = mulberry32(seed);
  let made = 0;
  const fresh = () => `${label}-new-${seed}-${made++}`;
  const store = createDesignStore({doc, measurer: testMeasurer, table});
  assert.equal(store.table, table);
  let effective = 0;
  for (let step = 0; step < count; step++) {
    const before = store.getState().doc;
    const snapshot = plain(before);
    const where = `${label} seed ${seed} step ${step}`;
    const useGesture = r() < 0.25;
    let result;
    if (useGesture) {
      // A gesture's frames share one table (shared/design/transaction.ts `createScratch`): the commit is the last frame's.
      const gesture = store.gesture(`${where} gesture`);
      const frames = 1 + Math.floor(r() * 3);
      for (let frame = 0; frame < frames; frame++) gesture.update(randomRecipe(r, fresh));
      result = gesture.commit();
      if (!result) {
        assert.deepEqual(plain(store.getState().doc), snapshot, `${where}: an empty gesture leaves the document as it was`);
        continue;
      }
    } else {
      result = store.transact(where, randomRecipe(r, fresh));
    }
    const {patch, inverse} = result;
    const after = store.getState().doc;
    const afterSnapshot = plain(after);
    if (!TABLES.some(table => keysOf(patch, table).length) && !patch.pages) {
      assert.deepEqual(afterSnapshot, snapshot, `${where}: an empty patch leaves the document as it was`);
      continue;
    }
    effective++;
    assert.deepEqual(plain(result.doc), afterSnapshot, `${where}: the store publishes the committed document`);
    // In place the document's own table holds the change (a gesture's frames write a shared copy of their own, whatever
    // the mode); with a copy the committed document has a table of its own.
    if (table === 'in-place' && !useGesture) assert.equal(after.nodes, before.nodes, `${where}: the table is the document's own`);
    else assert.notEqual(after.nodes, before.nodes, `${where}: a copy was made`);
    assert.notEqual(after, before, `${where}: a new document object`);
    for (const table of TABLES) assert.deepEqual(keysOf(inverse, table), keysOf(patch, table), `${where}: the inverse names what the patch names (${table})`);
    assert.equal(!!inverse.pages, !!patch.pages, `${where}: the inverse has a page order iff the patch has one`);
    // The inverse takes the committed document back to the one before it, value for value.
    assert.deepEqual(plain(applyPatch(after, inverse)), snapshot, `${where}: applyPatch(after, inverse) is the document before`);
    // The patch replayed on the document before reproduces the committed one, value for value. Not its node-table key
    // order: when normalization re-creates an instance's children (components.ts), the committed table lists them at the
    // end while a replay keeps the old place — true of today's copied table as of one written in place, and the reason the
    // key order of a table built from patches (a collaborator's, the server's) already differs from the editor's.
    assert.deepEqual(plain(applyPatch(snapshot, patch)), afterSnapshot, `${where}: applyPatch(before, patch) is the committed document`);
    // Undo and redo land on the same two documents (the store's history applies the same inverse and patch).
    assert.ok(store.undo(), `${where}: undo`);
    assert.deepEqual(plain(store.getState().doc), snapshot, `${where}: undo is the document before`);
    assert.ok(store.redo(), `${where}: redo`);
    assert.deepEqual(plain(store.getState().doc), afterSnapshot, `${where}: redo is the committed document`);
  }
  return effective;
}

for (const table of ['copy', 'in-place'] as const) {
  test(`${table}: every commit: applyPatch(after, inverse) is the document before, the inverse names the changed ids, undo and redo agree (fuzz documents)`, () => {
    let effective = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) effective += checkCommits(fuzzDocument(seed, {nodes: 200}), seed, 25, 'fuzz', table);
    assert.ok(effective > 60, `few effective commits: ${effective}`);
  });

  test(`${table}: every commit: the same on documents with components, variants and variables (L2c fuzz)`, () => {
    let effective = 0;
    for (const seed of [11, 12, 13, 14]) effective += checkCommits(l2cDocument(seed, 'small'), seed, 25, 'l2c', table);
    assert.ok(effective > 40, `few effective commits: ${effective}`);
  });
}

test('a hand-made case: create, move with the world kept, remove, undo twice', () => {
  const doc = fuzzDocument(21, {nodes: 60});
  const page = doc.pages[0];
  const store = createDesignStore({doc, measurer: testMeasurer, table: 'in-place'});
  const snapshots: DesignDocument[] = [plain(store.getState().doc)];
  const frame = `hand-frame`;
  const recipes: ((tx: Transaction) => void)[] = [
    tx => tx.create(createNode('FRAME', {id: frame, name: 'frame', x: 10, y: 10, width: 300, height: 200}), page),
    tx => tx.create(createNode('RECTANGLE', {id: 'hand-rect', name: 'rectangle', x: 500, y: 500, width: 50, height: 50}), page),
    tx => tx.move('hand-rect', frame, 0, {keepWorld: true}),
    tx => tx.remove(frame),
  ];
  const results = recipes.map((recipe, i) => {
    const result = store.transact(`hand ${i}`, recipe);
    snapshots.push(plain(store.getState().doc));
    return result;
  });
  for (let i = results.length - 1; i >= 0; i--) {
    assert.deepEqual(plain(applyPatch(store.getState().doc, results[i].inverse)), snapshots[i], `hand ${i}: inverse`);
    assert.ok(store.undo());
    assert.deepEqual(plain(store.getState().doc), snapshots[i], `hand ${i}: undo`);
  }
  for (let i = 0; i < results.length; i++) {
    assert.ok(store.redo());
    assert.deepEqual(plain(store.getState().doc), snapshots[i + 1], `hand ${i}: redo`);
  }
  // The removed frame took its child with it, and the inverse brought both back.
  assert.ok(!store.getState().doc.nodes[frame] && !store.getState().doc.nodes['hand-rect']);
});
