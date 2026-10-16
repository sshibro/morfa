import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {apply, worldMatrix} from '../shared/design/geometry';
import {applyPatch} from '../shared/design/patch';
import {beginTransaction, createScratch, placementFor, TransactionError} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {budget} from './helpers/speed';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const context = {measurer};

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit(context).doc;
}

const close = (a: number, b: number, message?: string) => assert.ok(Math.abs(a - b) < 1e-6, message ?? `${a} ≈ ${b}`);
function sameWorld(a: DesignDocument, b: DesignDocument, id: NodeId) {
  const node = b.nodes[id];
  for (const corner of [{x: 0, y: 0}, {x: node.width, y: 0}, {x: node.width, y: node.height}]) {
    const p = apply(worldMatrix(a, id), corner), q = apply(worldMatrix(b, id), corner);
    close(p.x, q.x, `x of ${JSON.stringify(corner)}: ${p.x} vs ${q.x}`);
    close(p.y, q.y, `y of ${JSON.stringify(corner)}: ${p.y} vs ${q.y}`);
  }
}

test('create keeps parent and children consistent, default on top, index bottom-to-top', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {width: 200, height: 200});
    add('RECTANGLE', 'a', 'f');
    add('RECTANGLE', 'b', 'f');
  });
  const tx = beginTransaction(doc);
  tx.create(createNode('ELLIPSE', {id: 'c'}), 'f', 0);
  const {doc: next, dirty} = tx.commit(context);
  assert.deepEqual(next.nodes.f.children, ['c', 'a', 'b']);
  assert.equal(next.nodes.c.parentId, 'f');
  assert.ok(dirty.has('c') && dirty.has('f'));
  assert.deepEqual(doc.nodes.f.children, ['a', 'b'], 'the base document is untouched');
  assert.equal(next.nodes.a, doc.nodes.a, 'untouched nodes keep their identity');
});

test('invalid parents and cycles are rejected', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page');
    add('FRAME', 'inner', 'f');
    add('RECTANGLE', 'r', 'inner');
  });
  const tx = beginTransaction(doc);
  assert.throws(() => tx.move('f', 'inner'), TransactionError);
  assert.throws(() => tx.move('f', 'f'), TransactionError);
  assert.throws(() => tx.create(createNode('RECTANGLE', {id: 'x'}), 'r'), TransactionError, 'nothing inside leaves');
  assert.throws(() => tx.create(createNode('PAGE', {id: 'p2'}), 'f'), TransactionError, 'pages only at the root');
  assert.throws(() => tx.move('page', 'f'), TransactionError);
  assert.throws(() => tx.create(createNode('RECTANGLE', {id: 'r'}), 'f'), TransactionError, 'ids are unique');
  assert.throws(() => tx.update('r', {parentId: 'f'}), TransactionError);
  assert.throws(() => tx.update('f', {type: 'RECTANGLE'}), TransactionError);
  tx.update('f', {type: 'COMPONENT'});
  assert.equal(tx.get('f')!.type, 'COMPONENT');
  assert.throws(() => tx.removePage('page'), TransactionError, 'the last page stays');
});

test('remove takes the subtree and leaves the parent; variable modes of removed nodes go too', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page');
    add('GROUP', 'g', 'f');
    add('RECTANGLE', 'r1', 'g');
    add('RECTANGLE', 'r2', 'g');
    add('RECTANGLE', 'keep', 'f');
  });
  const withModes = beginTransaction(doc);
  withModes.setVariableModes('g', {c1: 'm1'});
  const base = withModes.commit(context).doc;
  const tx = beginTransaction(base);
  tx.remove('g');
  tx.remove('g');
  const {doc: next, patch, inverse} = tx.commit(context);
  assert.deepEqual(next.nodes.f.children, ['keep']);
  for (const id of ['g', 'r1', 'r2']) assert.equal(next.nodes[id], undefined);
  assert.equal(next.variableModes?.g, undefined);
  assert.equal(patch.nodes!.r1, null);
  assert.deepEqual(applyPatch(next, inverse), base);
});

test('update merges shallowly, drops undefined keys and skips no-op writes', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {minWidth: 10}));
  const same = beginTransaction(doc);
  same.update('r', {x: doc.nodes.r.x, fills: doc.nodes.r.fills});
  const result = same.commit(context);
  assert.equal(result.doc, doc, 'nothing changed: the same document');
  assert.deepEqual(result.patch, {});
  const tx = beginTransaction(doc);
  tx.update('r', {x: 5, minWidth: undefined});
  tx.update('r', {y: 7});
  const next = tx.commit(context).doc;
  assert.equal(next.nodes.r.x, 5);
  assert.equal(next.nodes.r.y, 7);
  assert.ok(!('minWidth' in next.nodes.r));
  assert.equal(doc.nodes.r.minWidth, 10);
});

test('move keeps the world position under rotated and flipped parents', () => {
  const doc = build(add => {
    add('FRAME', 'a', 'page', {x: 100, y: 50, width: 300, height: 200, rotation: 30});
    add('FRAME', 'b', 'page', {x: -40, y: 400, width: 120, height: 90, rotation: -75, flipX: true});
    add('FRAME', 'c', 'b', {x: 10, y: 10, width: 50, height: 40, flipY: true, rotation: 12});
    add('RECTANGLE', 'r', 'a', {x: 20, y: 30, width: 60, height: 20, rotation: 45, flipX: true});
  });
  let current = doc;
  for (const target of ['b', 'c', 'page', 'a']) {
    const tx = beginTransaction(current);
    tx.move('r', target);
    const next = tx.commit(context).doc;
    assert.equal(next.nodes.r.parentId, target);
    assert.equal(next.nodes[target].children!.at(-1), 'r');
    sameWorld(current, next, 'r');
    current = next;
  }
  const back = beginTransaction(current);
  back.move('r', 'page', undefined, {keepWorld: false});
  assert.equal(back.get('r')!.x, current.nodes.r.x, 'keepWorld: false keeps the fields');
});

test('placementFor round-trips localMatrix and keeps the preferred flip flag', () => {
  const node = createNode('RECTANGLE', {id: 'r', x: 12, y: -8, width: 40, height: 10, rotation: 33, flipY: true});
  const doc = build(add => add('RECTANGLE', 'r', 'page', node));
  const placed = placementFor(node, worldMatrix(doc, 'r'));
  assert.deepEqual(placed, {x: 12, y: -8, rotation: 33, flipX: false, flipY: true});
});

test('patch and inverse round-trip a mixed transaction', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {width: 100, height: 100});
    add('RECTANGLE', 'r', 'f');
    add('TEXT', 't', 'page');
  });
  const tx = beginTransaction(doc);
  tx.update('r', {x: 40, rotation: 15});
  tx.create(createNode('ELLIPSE', {id: 'e'}), 'f', 0);
  tx.move('t', 'f', 1);
  tx.reorder('r', 0);
  tx.setStyle({id: 's', type: 'FILL', name: 'Brand/Primary', description: '', paints: []});
  tx.setImage('img', {url: '/uploads/a.png', width: 10, height: 10});
  tx.setVariableCollection({id: 'col', name: 'Colors', modes: [{modeId: 'm', name: 'Light'}], defaultModeId: 'm', variableIds: []});
  tx.setVariable({id: 'v', name: 'accent', collectionId: 'col', type: 'FLOAT', valuesByMode: {m: 4}, description: ''});
  tx.addPage(createNode('PAGE', {id: 'p2'}));
  const {doc: next, patch, inverse} = tx.commit(context);
  assert.deepEqual(next.nodes.f.children, ['r', 'e', 't']);
  assert.deepEqual(next.variableCollections.col.variableIds, ['v']);
  assert.deepEqual(next.pages, ['page', 'p2']);
  assert.deepEqual(applyPatch(doc, patch), next);
  assert.deepEqual(applyPatch(next, inverse), doc);
});

test('variables stay listed in their collection', () => {
  const tx = beginTransaction(createDocument('page'));
  tx.setVariableCollection({id: 'a', name: 'A', modes: [], defaultModeId: 'm', variableIds: []});
  tx.setVariableCollection({id: 'b', name: 'B', modes: [], defaultModeId: 'm', variableIds: []});
  tx.setVariable({id: 'v', name: 'x', collectionId: 'a', type: 'FLOAT', valuesByMode: {}, description: ''});
  tx.setVariable({id: 'v', name: 'x', collectionId: 'b', type: 'FLOAT', valuesByMode: {}, description: ''});
  let doc = tx.commit(context).doc;
  assert.deepEqual(doc.variableCollections.a.variableIds, []);
  assert.deepEqual(doc.variableCollections.b.variableIds, ['v']);
  const remove = beginTransaction(doc);
  remove.removeVariableCollection('b');
  doc = remove.commit(context).doc;
  assert.deepEqual(doc.variables, {});
  assert.throws(() => beginTransaction(doc).setVariable({id: 'w', name: 'y', collectionId: 'nope', type: 'FLOAT', valuesByMode: {}, description: ''}), TransactionError);
});

test('pages: order, add, remove with their content', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page'));
  const tx = beginTransaction(doc);
  tx.addPage(createNode('PAGE', {id: 'p2'}), 0);
  tx.create(createNode('RECTANGLE', {id: 'q'}), 'p2');
  tx.reorder('p2', 1);
  assert.deepEqual(tx.doc.pages, ['page', 'p2']);
  assert.throws(() => tx.setPages(['page']), TransactionError);
  tx.removePage('page');
  const next = tx.commit(context).doc;
  assert.deepEqual(next.pages, ['p2']);
  assert.equal(next.nodes.r, undefined);
  assert.equal(next.nodes.q.parentId, 'p2');
});

test('a scratch table makes repeated transactions from one base equal to fresh ones', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {width: 400, height: 400});
    for (let i = 0; i < 20; i++) add('RECTANGLE', `r${i}`, 'f', {x: i * 10});
  });
  const snapshot = JSON.stringify(doc);
  const scratch = createScratch(doc);
  const recipes: ((tx: ReturnType<typeof beginTransaction>) => void)[] = [
    tx => tx.update('r1', {x: 500}),
    tx => {
      tx.update('r2', {y: 9});
      tx.remove('r3');
    },
    tx => tx.create(createNode('ELLIPSE', {id: 'new'}), 'f'),
    tx => {
      tx.move('r4', 'page');
      throw new Error('a recipe that fails halfway');
    },
    tx => tx.update('r5', {width: 1}),
  ];
  for (const recipe of recipes) {
    const fresh = beginTransaction(doc);
    const reused = beginTransaction(doc, {scratch});
    let failed = false;
    try {
      recipe(fresh);
    } catch {
      failed = true;
    }
    try {
      recipe(reused);
    } catch {
      /* the scratch must still be revertible */
    }
    if (failed) continue;
    const a = fresh.commit(context), b = reused.commit(context);
    assert.deepEqual(b.doc, a.doc);
    assert.deepEqual(b.patch, a.patch);
  }
  assert.equal(JSON.stringify(doc), snapshot, 'the base never changes');
});

test('bulk operations stay linear: 6 000 removals and moves out of one parent', () => {
  const doc = build(add => {
    add('FRAME', 'from', 'page');
    add('FRAME', 'to', 'page');
    for (let i = 0; i < 12_000; i++) add('RECTANGLE', `n${i}`, 'from');
  });
  const started = performance.now();
  const tx = beginTransaction(doc);
  for (let i = 0; i < 12_000; i += 2) tx.remove(`n${i}`);
  for (let i = 1; i < 12_000; i += 4) tx.move(`n${i}`, 'to');
  const {doc: next, inverse} = tx.commit(context);
  const elapsed = performance.now() - started;
  assert.equal(next.nodes.from.children!.length, 3000);
  assert.equal(next.nodes.to.children!.length, 3000);
  assert.ok(elapsed < budget(1500), `took ${elapsed.toFixed(0)} ms`);
  const undoStarted = performance.now();
  assert.deepEqual(applyPatch(next, inverse).nodes.from.children, doc.nodes.from.children);
  assert.ok(performance.now() - undoStarted < 500);
});
