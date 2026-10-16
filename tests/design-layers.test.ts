import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {createComponent, createInstance} from '../shared/design/components';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore} from '../src/design/engine/store';
import {LayerRows, rangeOfRows, searchLayers, layerPath, foldText} from '../src/design/panels/left/layer-rows';
import {applyDrop, dropTarget, dropViolation, orderAfterDrop, panelOrder} from '../src/design/panels/left/layer-drop';
import {layerTreeState} from '../src/design/panels/left/tree-state';
import {commitEdit} from '../src/design/panels/left/apply-edit';
import {userUpdate} from '../src/design/engine/user-edit';
import {addPage, duplicatePage, movePage} from '../src/design/panels/left/page-actions';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

// page: a (frame: a1, a2 (group: g1, g2)), b (rect), c (frame, empty). Bottom-to-top in the model,
// so the panel lists c, b, a.
const sample = () => build(add => {
  add('FRAME', 'a', 'page', {width: 400, height: 400});
  add('RECTANGLE', 'a1', 'a');
  add('GROUP', 'a2', 'a');
  add('RECTANGLE', 'g1', 'a2', {x: 10, y: 10, width: 10, height: 10});
  add('ELLIPSE', 'g2', 'a2', {x: 30, y: 30, width: 10, height: 10});
  add('RECTANGLE', 'b', 'page', {x: 500});
  add('FRAME', 'c', 'page', {x: 700});
});

const rowsOf = (rows: LayerRows) => rows.ids.map((id, i) => `${'  '.repeat(rows.depths[i])}${id}`);

test('rows list the page top-first and expanded containers in place', () => {
  const rows = new LayerRows(sample(), 'page');
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a']);
  assert.ok(rows.setExpanded('a', true));
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '  a1']);
  assert.ok(rows.setExpanded('a2', true));
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '    g2', '    g1', '  a1']);
  assert.ok(rows.setExpanded('a', false));
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a']);
  // The inner expansion is remembered.
  rows.setExpanded('a', true);
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '    g2', '    g1', '  a1']);
  assert.equal(rows.rowOf('g1'), 5);
  assert.equal(rows.rowOf('missing'), -1);
});

test('⌥-click expands and collapses every container inside', () => {
  const rows = new LayerRows(sample(), 'page');
  rows.setExpanded('a', true, true);
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '    g2', '    g1', '  a1']);
  rows.setExpanded('a', false, true);
  rows.setExpanded('a', true);
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '  a1'], 'the deep collapse forgot the group');
  assert.ok(!rows.setExpanded('b', true), 'a leaf has nothing to expand');
});

test('a change that keeps the structure leaves the rows untouched; a reorder rebuilds only that segment', () => {
  const store = createDesignStore({doc: sample(), measurer});
  const rows = new LayerRows(store.getState().doc, 'page');
  rows.setExpanded('a', true);
  rows.setExpanded('a2', true);
  const ids = rows.ids;
  const version = rows.version;
  store.transact('Move', tx => tx.update('g1', {x: 99, name: 'new name'}));
  assert.equal(rows.update(store.getState().doc), false);
  assert.equal(rows.ids, ids, 'the very same array');
  assert.equal(rows.version, version);
  store.transact('Reorder', tx => tx.reorder('g1', 1));
  assert.equal(rows.update(store.getState().doc), true);
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '    g1', '    g2', '  a1']);
  store.transact('Delete', tx => tx.remove('a1'));
  rows.update(store.getState().doc);
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '    g1', '    g2']);
  store.transact('New', tx => tx.create(createNode('TEXT', {id: 't', name: 't'}), 'page'));
  rows.update(store.getState().doc);
  assert.deepEqual(rowsOf(rows), ['t', 'c', 'b', 'a', '  a2', '    g1', '    g2']);
  // A move between two expanded containers updates both places.
  rows.setExpanded('c', true);
  store.transact('Transfer', tx => tx.move('g2', 'c'));
  rows.update(store.getState().doc);
  assert.deepEqual(rowsOf(rows), ['t', 'c', '  g2', 'b', 'a', '  a2', '    g1']);
  // Undo all the way back.
  while (store.undo()) rows.update(store.getState().doc);
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '    g2', '    g1', '  a1']);
});

test('reveal expands the ancestors of a layer chosen on the canvas; collapse all folds everything', () => {
  const rows = new LayerRows(sample(), 'page');
  assert.ok(rows.reveal(['g2']));
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a', '  a2', '    g2', '    g1', '  a1']);
  assert.ok(!rows.reveal(['g1', 'b']), 'already visible');
  assert.ok(rows.collapseAll());
  assert.deepEqual(rowsOf(rows), ['c', 'b', 'a']);
  assert.deepEqual([...rows.expanded], []);
});

test('range selection takes the rows between the anchor and the clicked row', () => {
  const rows = new LayerRows(sample(), 'page');
  rows.setExpanded('a', true);
  assert.deepEqual(rangeOfRows(rows, rows.rowOf('b'), rows.rowOf('a2')), ['b', 'a', 'a2']);
  assert.deepEqual(rangeOfRows(rows, rows.rowOf('a1'), rows.rowOf('a')), ['a', 'a2', 'a1']);
  assert.deepEqual(rangeOfRows(rows, -1, 2), []);
});

test('search finds layers by name (ё = е, any case) and by kind, in panel order with paths', () => {
  // Cyrillic on purpose: the layer names below check the search's folding of ё to е and of upper case.
  const doc = build(add => {
    add('FRAME', 'f', 'page', {name: 'Шапка'});
    add('TEXT', 't1', 'f', {name: 'Заголовок ёлки'});
    add('RECTANGLE', 'img', 'f', {name: 'Фото', fills: [{type: 'IMAGE', imageRef: 'x', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
    add('TEXT', 't2', 'page', {name: 'Подпись'});
  });
  assert.deepEqual(searchLayers(doc, 'page', 'ЕЛК'), ['t1']);
  assert.deepEqual(searchLayers(doc, 'page', '', new Set(['text'])), ['t2', 't1']);
  assert.deepEqual(searchLayers(doc, 'page', '', new Set(['image'])), ['img']);
  assert.deepEqual(searchLayers(doc, 'page', 'о', new Set(['text', 'image'])), ['t2', 'img', 't1']);
  assert.deepEqual(searchLayers(doc, 'page', '   '), []);
  assert.equal(layerPath(doc, 't1'), 'Шапка');
  assert.equal(foldText('ЁЖ'), 'еж');
});

// ── Drops ──────────────────────────────────────────────────────────────────────────────────────

test('drop positions map to (parent, index) the way the panel shows them', () => {
  const doc = sample();
  const rows = new LayerRows(doc, 'page');
  rows.setExpanded('a', true);
  rows.setExpanded('a2', true);
  // Rows: 0 c, 1 b, 2 a, 3 a2, 4 g2, 5 g1, 6 a1.
  const at = (row: number, fraction: number, level = 0, dragged = ['b']) => dropTarget(doc, rows, {row, fraction, level}, dragged, 'page');

  // Top quarter of the frame c: above c on the page (c is the top-most child, index 3 of 3).
  assert.deepEqual(at(0, 0.1), {parentId: 'page', index: 3, indicator: {kind: 'line', row: 0, depth: 0}});
  // The middle of a container: into it, on top.
  assert.deepEqual(at(0, 0.5), {parentId: 'c', index: 0, indicator: {kind: 'into', row: 0}});
  // Lower half of a leaf (b is not a container): below b.
  assert.deepEqual(at(1, 0.6, 0, ['g1']), {parentId: 'page', index: 1, indicator: {kind: 'line', row: 2, depth: 0}});
  // Just under an expanded frame: on top of its children.
  assert.deepEqual(at(2, 0.9), {parentId: 'a', index: 2, indicator: {kind: 'line', row: 3, depth: 1}});
  // Under the last row of the nested group the pointer's level decides: inside the group, after it, after the frame.
  assert.deepEqual(at(5, 0.9, 2), {parentId: 'a2', index: 0, indicator: {kind: 'line', row: 6, depth: 2}});
  assert.deepEqual(at(5, 0.9, 1), {parentId: 'a', index: 1, indicator: {kind: 'line', row: 6, depth: 1}});
  assert.deepEqual(at(5, 0.9, 0), {parentId: 'a', index: 1, indicator: {kind: 'line', row: 6, depth: 1}}, 'a1 is below: no shallower level');
  // Below the very last row: any level up to the page.
  assert.deepEqual(at(7, 0.2, 0), {parentId: 'page', index: 0, indicator: {kind: 'line', row: 7, depth: 0}});
  assert.deepEqual(at(7, 0.2, 5), {parentId: 'a', index: 0, indicator: {kind: 'line', row: 7, depth: 1}});
});

test('drops into the layer itself, its descendants, instances and their copies are refused', () => {
  let doc = build(add => {
    add('FRAME', 'card', 'page', {width: 200, height: 100});
    add('RECTANGLE', 'bg', 'card');
    add('FRAME', 'other', 'page', {x: 300});
  });
  const made = createComponent(doc, ['card']);
  doc = made.doc;
  const componentId = made.componentIds[0];
  const instance = createInstance(doc, componentId, {parentId: 'page', x: 600, newId: 'inst'});
  doc = instance.doc;
  const copy = doc.nodes.inst.children![0];
  assert.match(copy, /^inst;/);
  assert.ok(dropViolation(doc, ['other'], 'inst'), 'not into an instance');
  assert.ok(dropViolation(doc, ['other'], copy) || !doc.nodes[copy].children, 'not into a copy');
  assert.ok(dropViolation(doc, [copy], 'other'), 'copies cannot be dragged out');
  assert.ok(dropViolation(doc, [componentId], componentId), 'not into itself');
  assert.equal(dropViolation(doc, ['other'], componentId), null, 'into a component is fine');
  assert.ok(dropViolation(doc, ['inst'], componentId), 'an instance inside its own component is a cycle');

  const rows = new LayerRows(doc, 'page');
  const instRow = rows.rowOf('inst');
  assert.equal(dropTarget(doc, rows, {row: instRow, fraction: 0.5, level: 0}, ['other'], 'page')?.indicator.kind, 'line', 'the middle of an instance is a line, not «into»');
  // The line right under an expanded instance would put the layer inside it: refused.
  rows.setExpanded('inst', true);
  assert.equal(dropTarget(doc, rows, {row: instRow, fraction: 0.95, level: 1}, ['other'], 'page'), null);
});

test('a dropped block keeps its order, lands at the index and is one undo step', () => {
  const store = createDesignStore({doc: build(add => {
    add('FRAME', 'list', 'page', {width: 100, height: 300, autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 10}, layoutSizingVertical: 'HUG'});
    for (const id of ['i0', 'i1', 'i2', 'i3']) add('RECTANGLE', id, 'list', {width: 100, height: 20});
    add('RECTANGLE', 'loose', 'page', {x: 300, y: 40, width: 50, height: 50});
  }), measurer});
  const doc = store.getState().doc;
  // Panel order (top-first) of the block: i3 then i1 → bottom-to-top i1, i3.
  assert.deepEqual(orderAfterDrop(doc, ['i3', 'i1'], 'list', 1), ['i0', 'i1', 'i3', 'i2']);
  assert.equal(orderAfterDrop(doc, ['i2', 'i1'], 'list', 1), null, 'already there');
  store.transact('Move layers', tx => void applyDrop(tx, ['i3', 'i1'], 'list', 1));
  assert.deepEqual(store.getState().doc.nodes.list.children, ['i0', 'i1', 'i3', 'i2']);
  // The auto-layout parent places them in its flow.
  const y = (id: string) => store.getState().doc.nodes[id].y;
  assert.ok(y('i0') < y('i1') && y('i1') < y('i3') && y('i3') < y('i2'));
  // A layer from elsewhere joins the flow at the index (keepWorld does not fight the layout).
  store.transact('Move layers', tx => void applyDrop(tx, ['loose'], 'list', 0));
  assert.deepEqual(store.getState().doc.nodes.list.children, ['loose', 'i0', 'i1', 'i3', 'i2']);
  assert.equal(store.getState().doc.nodes.loose.y, 0);
  store.undo();
  assert.equal(store.getState().doc.nodes.loose.parentId, 'page');
  assert.equal(store.getState().doc.nodes.loose.x, 300, 'undo puts it back where it was');
  store.undo();
  assert.deepEqual(store.getState().doc.nodes.list.children, ['i0', 'i1', 'i2', 'i3']);
});

test('moving out of a frame keeps the layer where it is on screen', () => {
  const store = createDesignStore({doc: build(add => {
    add('FRAME', 'f', 'page', {x: 100, y: 100, width: 200, height: 200});
    add('RECTANGLE', 'r', 'f', {x: 10, y: 20, width: 10, height: 10});
  }), measurer});
  store.transact('Move layers', tx => void applyDrop(tx, ['r'], 'page', 0));
  const r = store.getState().doc.nodes.r;
  assert.equal(r.parentId, 'page');
  assert.deepEqual([r.x, r.y], [110, 120]);
  assert.deepEqual(store.getState().doc.nodes.page.children, ['r', 'f']);
});

test('panel order puts shown rows first, hidden ones by paint order', () => {
  const doc = sample();
  const rows = new LayerRows(doc, 'page');
  assert.deepEqual(panelOrder(doc, rows, ['a', 'g1', 'c', 'g2']), ['c', 'a', 'g2', 'g1']);
});

// ── The per-store state ────────────────────────────────────────────────────────────────────────

test('the tree state follows the store, keeps expansion per page and asks the tree to rename', () => {
  const tx = beginTransaction(sample());
  tx.addPage(createNode('PAGE', {id: 'p2', name: 'Second'}));
  tx.create(createNode('FRAME', {id: 'x', name: 'x'}), 'p2');
  tx.create(createNode('RECTANGLE', {id: 'x1', name: 'x1'}), 'x');
  const store = createDesignStore({doc: tx.commit({measurer}).doc, measurer});
  const state = layerTreeState(store);
  assert.equal(layerTreeState(store), state, 'one per store');
  let calls = 0;
  const stop = state.subscribe(() => calls++);
  state.setExpanded('a', true);
  assert.equal(calls, 1);
  assert.deepEqual(state.rows().ids, ['c', 'b', 'a', 'a2', 'a1']);
  store.transact('Move', tx => tx.update('b', {x: 1}));
  assert.equal(calls, 1, 'no structural change, no notification');
  store.setPage('p2');
  assert.equal(calls, 2);
  assert.deepEqual(state.rows().ids, ['x']);
  store.setPage('page');
  assert.deepEqual(state.rows().ids, ['c', 'b', 'a', 'a2', 'a1'], 'the page kept its expansion');
  state.collapseAll();
  assert.deepEqual(state.rows().ids, ['c', 'b', 'a']);
  let asked: string | null = null;
  assert.equal(state.requestRename('b'), false);
  const off = state.onRenameRequest(id => {asked = id;});
  assert.equal(state.requestRename('b'), true);
  assert.equal(asked, 'b');
  off();
  stop();
});

test('rename is one undo step and a copy inside an instance records it as an override', () => {
  let doc = build(add => {
    add('FRAME', 'card', 'page', {width: 200, height: 100});
    add('TEXT', 'label', 'card');
  });
  const made = createComponent(doc, ['card']);
  doc = createInstance(made.doc, made.componentIds[0], {parentId: 'page', x: 400, newId: 'inst'}).doc;
  const store = createDesignStore({doc, measurer});
  const copy = store.getState().doc.nodes.inst.children![0];
  store.transact('Rename', tx => userUpdate(tx, copy, {name: 'Caption'}));
  assert.equal(store.getState().doc.nodes[copy].name, 'Caption');
  assert.ok(store.getState().doc.nodes[copy].overrides?.includes('name'));
  // Syncing with the main (a change to the component) keeps the override.
  store.transact('Main', tx => tx.update(made.componentIds[0], {opacity: 0.5}));
  assert.equal(store.getState().doc.nodes[copy].name, 'Caption');
  store.undo();
  store.undo();
  assert.notEqual(store.getState().doc.nodes[copy].name, 'Caption');
});

test('an operation result is committed through a transaction (instances, variables)', () => {
  let doc = build(add => {
    add('FRAME', 'card', 'page', {width: 200, height: 100});
    add('RECTANGLE', 'bg', 'card');
    add('FRAME', 'target', 'page', {x: 400, width: 300, height: 300});
  });
  const made = createComponent(doc, ['card']);
  const store = createDesignStore({doc: made.doc, measurer});
  const before = store.getState().doc;
  const edit = createInstance(before, made.componentIds[0], {parentId: 'target', x: 10, y: 20, newId: 'inst'});
  commitEdit(store, 'Insert instance', before, edit, {select: ['inst']});
  const after = store.getState().doc;
  assert.equal(after.nodes.inst.parentId, 'target');
  assert.deepEqual(after.nodes.target.children, ['inst']);
  assert.equal(after.nodes.inst.children?.length, 1);
  assert.equal(after.nodes[after.nodes.inst.children![0]].parentId, 'inst');
  assert.deepEqual(store.getState().selection, ['inst']);
  store.undo();
  assert.equal(store.getState().doc.nodes.inst, undefined);
  assert.deepEqual(store.getState().doc.nodes.target.children, []);
});

// ── Pages ──────────────────────────────────────────────────────────────────────────────────────

test('pages: add "Page N", reorder, duplicate with fresh ids (instance copies re-keyed), each one undo step', () => {
  let doc = build(add => {
    add('FRAME', 'card', 'page', {width: 200, height: 100});
    add('RECTANGLE', 'bg', 'card');
  });
  const made = createComponent(doc, ['card']);
  doc = createInstance(made.doc, made.componentIds[0], {parentId: 'page', x: 400, newId: 'inst'}).doc;
  const store = createDesignStore({doc, measurer});
  const name = (id: string) => store.getState().doc.nodes[id].name;
  store.transact('Name the first page', tx => tx.update('page', {name: 'Page 1'}), {history: false});

  const added = addPage(store);
  assert.equal(name(added), 'Page 2', 'after the file\'s "Page 1"');
  assert.equal(store.getState().pageId, added);
  assert.deepEqual(store.getState().doc.pages, ['page', added]);
  assert.equal(name(addPage(store)), 'Page 3');

  assert.ok(movePage(store, added, 0));
  assert.equal(store.getState().doc.pages[0], added);
  assert.ok(!movePage(store, added, 1), 'dropping beside itself moves nothing');

  const copy = duplicatePage(store, 'page')!;
  const after = store.getState().doc;
  assert.equal(after.nodes[copy].name, `${after.nodes.page.name} (copy)`);
  assert.equal(after.pages[after.pages.indexOf('page') + 1], copy);
  assert.equal(after.nodes[copy].children!.length, after.nodes.page.children!.length);
  const copiedIds = after.nodes[copy].children!;
  assert.ok(copiedIds.every(id => !after.nodes.page.children!.includes(id)), 'fresh ids');
  const instanceCopy = copiedIds.map(id => after.nodes[id]).find(node => node.type === 'INSTANCE')!;
  assert.ok(instanceCopy.children!.every(child => child.startsWith(instanceCopy.id + ';')), 'copies follow their new instance');
  assert.equal(instanceCopy.componentId, made.componentIds[0], 'still an instance of the same component');
  assert.equal(store.getState().pageId, copy);
  assert.ok(store.undo());
  assert.equal(store.getState().doc.nodes[copy], undefined);
});
