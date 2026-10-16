import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {applyPatch} from '../shared/design/patch';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore, currentViewport, type DocumentChange, type PatchEvent} from '../src/design/engine/store';
import {budget} from './helpers/speed';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.addPage(createNode('PAGE', {id: 'page2', name: 'Page 2'}));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

const sample = () => build(add => {
  add('FRAME', 'f', 'page', {width: 300, height: 300});
  add('RECTANGLE', 'r', 'f', {x: 10, y: 10});
  add('ELLIPSE', 'e', 'page', {x: 400});
  add('RECTANGLE', 'p2r', 'page2');
});

test('transact, undo and redo restore the document, the selection and the page', () => {
  const store = createDesignStore({doc: sample(), measurer});
  const initial = store.getState().doc;
  store.setSelection(['r']);
  store.transact('Nudge', tx => tx.update('r', {x: 99}), {select: ['r', 'e']});
  assert.equal(store.getState().doc.nodes.r.x, 99);
  assert.deepEqual(store.getState().selection, ['r', 'e']);
  assert.deepEqual(store.getState().history, {undo: 'Nudge', redo: null});
  store.setPage('page2');
  assert.deepEqual(store.getState().selection, []);
  assert.ok(store.undo());
  assert.deepEqual(store.getState().doc, initial);
  assert.equal(store.getState().pageId, 'page', 'undo brings back the page the change was made on');
  assert.deepEqual(store.getState().selection, ['r']);
  assert.ok(store.redo());
  assert.equal(store.getState().doc.nodes.r.x, 99);
  assert.deepEqual(store.getState().selection, ['r', 'e']);
  assert.ok(!store.redo());
  store.undo();
  store.transact('Other', tx => tx.update('e', {y: 5}));
  assert.ok(!store.canRedo(), 'a new change drops the redo branch');
});

test('a gesture of 50 updates is one undo step, re-run from its start, with live ids while it runs', () => {
  const store = createDesignStore({doc: sample(), measurer});
  const base = store.getState().doc;
  const snapshot = JSON.stringify(base);
  const changes: DocumentChange[] = [];
  store.onDocument(change => changes.push(change));
  const gesture = store.gesture('Move');
  for (let i = 1; i <= 50; i++) {
    gesture.update(tx => tx.update('r', {x: tx.get('r')!.x + i}));
    assert.equal(store.getState().doc.nodes.r.x, 10 + i, 'each update starts from the base, so nothing accumulates');
    assert.deepEqual([...store.getState().live], ['r']);
  }
  assert.equal(JSON.stringify(base), snapshot, 'the base document is never written');
  assert.ok(!store.canUndo());
  const result = gesture.commit();
  assert.ok(result);
  assert.equal(store.getState().live.size, 0);
  assert.equal(store.getState().doc.nodes.r.x, 60);
  assert.ok(changes.every(change => change.changed.size === 1 && change.changed.has('r')));
  assert.equal(changes.at(-1)!.source, 'edit');
  store.undo();
  assert.deepEqual(store.getState().doc, base);
  assert.ok(!store.canUndo(), 'exactly one step');
  gesture.update(tx => tx.update('r', {x: 1}));
  assert.equal(store.getState().doc.nodes.r.x, 10, 'a finished gesture ignores updates');
});

test('cancel and failing recipes put the document back', () => {
  const store = createDesignStore({doc: sample(), measurer});
  const base = store.getState().doc;
  store.setSelection(['r']);
  const gesture = store.gesture('Rotate');
  gesture.update(tx => tx.update('r', {rotation: 30}));
  gesture.update(() => ({select: ['e']}));
  assert.deepEqual(store.getState().selection, ['e']);
  assert.throws(() => gesture.update(tx => {
    tx.update('r', {rotation: 45});
    throw new Error('boom');
  }));
  assert.equal(store.getState().doc, base);
  gesture.update(tx => tx.update('r', {rotation: 60}));
  assert.equal(store.getState().doc.nodes.r.rotation, 60);
  gesture.cancel();
  assert.equal(store.getState().doc, base);
  assert.deepEqual(store.getState().selection, ['r']);
  assert.ok(!store.canUndo());
});

test('a transaction during a gesture finishes the gesture first', () => {
  const store = createDesignStore({doc: sample(), measurer});
  const gesture = store.gesture('Move');
  gesture.update(tx => tx.update('r', {x: 50}));
  store.transact('Color', tx => tx.update('e', {opacity: 0.5}));
  assert.ok(!gesture.active);
  store.undo();
  assert.equal(store.getState().doc.nodes.r.x, 50);
  store.undo();
  assert.equal(store.getState().doc.nodes.r.x, 10);
});

test('the selection drops deleted and off-page ids; hover, context and editing follow', () => {
  const store = createDesignStore({doc: sample(), measurer});
  store.setSelection(['r', 'e', 'p2r', 'page', 'missing']);
  assert.deepEqual(store.getState().selection, ['r', 'e']);
  store.setHover('r');
  store.setContext('f');
  store.setEditing({kind: 'vector', id: 'r'});
  store.transact('Delete', tx => tx.remove('f'));
  const state = store.getState();
  assert.deepEqual(state.selection, ['e']);
  assert.equal(state.hoverId, null);
  assert.equal(state.context, null);
  assert.equal(state.editing, null);
});

test('each page keeps its viewport and its selection', () => {
  const store = createDesignStore({doc: sample(), measurer});
  store.setViewport({x: 100, y: 50, zoom: 2});
  store.setSelection(['e']);
  store.setPage('page2');
  assert.deepEqual(currentViewport(store.getState()), {x: 0, y: 0, zoom: 1});
  store.setViewport({x: -5, y: -5, zoom: 0.5});
  store.setPage('page');
  assert.deepEqual(currentViewport(store.getState()), {x: 100, y: 50, zoom: 2});
  assert.deepEqual(store.getState().selection, ['e']);
  store.setPage('page2');
  assert.deepEqual(currentViewport(store.getState()), {x: -5, y: -5, zoom: 0.5});
});

test('onPatch carries every committed change for autosave', () => {
  const initial = sample();
  const store = createDesignStore({doc: initial, measurer});
  const events: PatchEvent[] = [];
  store.onPatch(event => events.push(event));
  store.transact('A', tx => tx.update('r', {x: 1}));
  const gesture = store.gesture('B');
  for (let i = 0; i < 5; i++) gesture.update(tx => tx.update('e', {y: i}));
  gesture.commit();
  store.undo();
  store.redo();
  store.transact('C', tx => tx.create(createNode('STAR', {id: 'star'}), 'page'));
  assert.deepEqual(events.map(event => event.source), ['edit', 'edit', 'undo', 'redo', 'edit']);
  let replay = initial;
  for (const event of events) replay = applyPatch(replay, event.patch);
  assert.deepEqual(replay, store.getState().doc);
});

test('subscribers wake only for the slices they read', () => {
  const store = createDesignStore({doc: sample(), measurer});
  let docCalls = 0, viewportCalls = 0, allCalls = 0, selected = 0;
  store.subscribe(() => docCalls++, {slice: 'doc'});
  store.subscribe(() => viewportCalls++, {slice: ['viewport']});
  store.subscribe(() => allCalls++);
  store.select(state => state.doc.nodes.r.fills, () => selected++, {slice: 'doc'});
  for (let i = 0; i < 10; i++) store.setViewport({x: i, y: 0, zoom: 1});
  assert.equal(docCalls, 0);
  assert.equal(viewportCalls, 10);
  const gesture = store.gesture('Move');
  for (let i = 0; i < 10; i++) gesture.update(tx => tx.update('r', {x: i}));
  gesture.commit();
  assert.equal(docCalls, 10);
  assert.equal(selected, 0, 'moving does not change the fills a panel reads');
  store.transact('Fill', tx => tx.update('r', {fills: []}));
  assert.equal(selected, 1);
  assert.equal(allCalls, 10 + 10 + 1 + 1, 'every change once: viewports, frames, the end of the drag, the fill');
});

test('consecutive nudges coalesce into one undo step', () => {
  const store = createDesignStore({doc: sample(), measurer});
  for (let i = 1; i <= 5; i++) store.transact('Move', tx => tx.update('r', {x: 10 + i}), {coalesce: 'nudge'});
  store.transact('Other', tx => tx.update('r', {y: 99}));
  store.undo();
  assert.equal(store.getState().doc.nodes.r.x, 15);
  store.undo();
  assert.equal(store.getState().doc.nodes.r.x, 10);
  assert.ok(!store.canUndo());
});

test('history keeps its limit; replaceDocument starts over', () => {
  const store = createDesignStore({doc: sample(), measurer, historyLimit: 3});
  for (let i = 0; i < 6; i++) store.transact(`Step ${i}`, tx => tx.update('r', {x: i}));
  let undone = 0;
  while (store.undo()) undone++;
  assert.equal(undone, 3);
  const replacement = sample();
  const events: PatchEvent[] = [];
  store.onPatch(event => events.push(event));
  store.setPage('page2');
  store.replaceDocument(createDocument('fresh'));
  assert.equal(store.getState().pageId, 'fresh', 'a page that is gone falls back to the first one');
  assert.ok(!store.canRedo() && !store.canUndo());
  assert.equal(events[0].source, 'replace');
  store.replaceDocument(replacement, {keepHistory: true});
  assert.equal(store.getState().doc, replacement);
});

test('undo of a 5 000-node paste is patch-based and quick', () => {
  const store = createDesignStore({doc: sample(), measurer});
  store.transact('Insert', tx => {
    for (let i = 0; i < 5000; i++) tx.create(createNode('RECTANGLE', {id: `n${i}`, x: i}), 'page');
  }, {select: Array.from({length: 5000}, (_, i) => `n${i}`)});
  assert.equal(store.getState().selection.length, 5000);
  const started = performance.now();
  store.undo();
  const elapsed = performance.now() - started;
  assert.equal(store.getState().doc.nodes.n0, undefined);
  assert.equal(store.getState().selection.length, 0);
  assert.ok(elapsed < budget(150), `undo took ${elapsed.toFixed(1)} ms`);
});

test('a drag frame on a 20 000-node page does not copy the page', () => {
  const doc = build(add => {
    for (let i = 0; i < 20_000; i++) add('RECTANGLE', `n${i}`, 'page', {x: i});
  });
  const store = createDesignStore({doc, measurer});
  const gesture = store.gesture('Move');
  gesture.update(tx => tx.update('n5', {y: 1}));
  const started = performance.now();
  for (let i = 0; i < 60; i++) gesture.update(tx => tx.update('n5', {y: i}));
  const perFrame = (performance.now() - started) / 60;
  gesture.commit();
  assert.ok(perFrame < budget(4), `${perFrame.toFixed(2)} ms per frame`);
  assert.equal(store.getState().doc.nodes.n5.y, 59);
  assert.equal(doc.nodes.n5.y, 0);
});

// ── Pages on demand (big files, docs/decisions/big-files.md §4) ──

import {pageSlice, skeletonOf} from '../shared/design/pages';
import type {DesignPageSlice} from '../shared/design/pages';

/** A server of page slices over a whole document, counting the fetches and answering when told to. */
function pageServer(whole: () => DesignDocument) {
  const calls: NodeId[] = [];
  let version = 1;
  const pending: (() => void)[] = [];
  return {
    calls,
    bump: () => ++version,
    load: (pageId: NodeId) =>
      new Promise<DesignPageSlice>(resolve => {
        calls.push(pageId);
        pending.push(() => resolve({version, nodes: pageSlice(whole(), pageId)}));
      }),
    /** Answers every waiting fetch. */
    async answer() {
      const now = pending.splice(0);
      for (const resolve of now) resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  };
}

test('a partial store switches to a page once its layers arrive, and never sends them as an edit', async () => {
  const whole = sample();
  const server = pageServer(() => whole);
  const store = createDesignStore({doc: skeletonOf(whole, ['page']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['page'], load: server.load}});
  const patches: PatchEvent[] = [];
  store.onPatch(event => patches.push(event));
  assert.deepEqual([...store.getState().pages!.loaded], ['page']);
  assert.equal(store.getState().doc.nodes.p2r, undefined, 'page 2 is not here yet');
  store.setPage('page2');
  assert.equal(store.getState().pageId, 'page', 'the switch waits for the layers');
  assert.deepEqual([...store.getState().pages!.loading], ['page2']);
  assert.deepEqual(server.calls, ['page2']);
  await server.answer();
  assert.equal(store.getState().pageId, 'page2');
  assert.deepEqual([...store.getState().pages!.loaded].sort(), ['page', 'page2']);
  assert.deepEqual([...store.getState().pages!.loading], []);
  assert.equal(store.getState().doc.nodes.p2r, whole.nodes.p2r);
  assert.deepEqual(patches.map(event => event.source), ['page']);
  assert.ok(patches[0].patch.nodes!.p2r, 'the page frame carries the layers');
  // Loaded already: resolved at once, no fetch.
  await store.ensurePage('page2');
  assert.deepEqual(server.calls, ['page2']);
  // ensureAllPages fetches what is missing only.
  const promise = store.ensureAllPages();
  assert.deepEqual(server.calls, ['page2']);
  await promise;
});

test('remote changes to pages the store does not hold are dropped; a move into a held page refetches it', async () => {
  const whole = sample();
  let current = whole;
  const server = pageServer(() => current);
  const store = createDesignStore({doc: skeletonOf(whole, ['page']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['page'], load: server.load}});
  // A layer added on page 2 by someone else: not kept; a layer added on page 1: kept; a page rename: kept.
  const onPage2 = createNode('RECTANGLE', {id: 'p2new', parentId: 'page2'});
  const onPage1 = createNode('RECTANGLE', {id: 'p1new', parentId: 'page'});
  store.applyRemote(() => ({nodes: {p2new: onPage2, p1new: onPage1, page2: {...whole.nodes.page2, name: 'Another', children: [...whole.nodes.page2.children!, 'p2new']}}}));
  const doc = store.getState().doc;
  assert.equal(doc.nodes.p2new, undefined);
  assert.equal(doc.nodes.p1new, onPage1);
  assert.equal(doc.nodes.page2.name, 'Another');
  assert.deepEqual(server.calls, []);
  // A frame with children moves from page 2 into page 1: its children are missing here, so page 1 is fetched again.
  const moved = createNode('FRAME', {id: 'mv', parentId: 'page', children: ['mvr']});
  current = {...whole, nodes: {...whole.nodes, mv: moved, mvr: createNode('RECTANGLE', {id: 'mvr', parentId: 'mv'}), page: {...whole.nodes.page, children: [...whole.nodes.page.children!, 'mv']}}};
  store.applyRemote(() => ({nodes: {mv: moved, page: current.nodes.page}}));
  assert.deepEqual(server.calls, ['page']);
  await server.answer();
  assert.equal(store.getState().doc.nodes.mvr?.parentId, 'mv', 'the refetched page brought the moved subtree');
});

test('a remote change during a fetch makes the store fetch the page again', async () => {
  const whole = sample();
  const server = pageServer(() => whole);
  const store = createDesignStore({doc: skeletonOf(whole, ['page']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['page'], load: server.load}});
  const promise = store.ensurePage('page2');
  store.applyRemote(() => ({nodes: {page: {...whole.nodes.page, name: 'First'}}}));
  await server.answer();
  assert.deepEqual(server.calls, ['page2', 'page2'], 'fetched again: the first slice may predate the change');
  await server.answer();
  await promise;
  assert.ok(store.getState().pages!.loaded.has('page2'));
});

/** The sample plus a component on page 1 and a variant set on page 2 (resident on every client). */
const partialSample = () => build(add => {
  add('FRAME', 'f', 'page', {width: 300, height: 300});
  add('RECTANGLE', 'r', 'f', {x: 10, y: 10});
  add('COMPONENT', 'c', 'f', {x: 50, y: 50, width: 40, height: 40});
  add('RECTANGLE', 'cr', 'c');
  add('RECTANGLE', 'p2r', 'page2');
  add('COMPONENT_SET', 'set', 'page2', {width: 100, height: 100});
  add('COMPONENT', 'v1', 'set', {name: 'Type=A'});
  add('RECTANGLE', 'v1r', 'v1');
});

test('undo of a step on an evicted page loads the page first; eviction respects the current page, the history and unsaved changes', async () => {
  const whole = partialSample();
  const server = pageServer(() => whole);
  let dirty = false;
  const store = createDesignStore({doc: skeletonOf(whole, ['page', 'page2']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['page', 'page2'], load: server.load, dirty: () => dirty}});
  store.setPage('page2');
  store.transact('Edit', tx => tx.update('p2r', {name: 'Changed'}));
  store.setPage('page');
  assert.equal(store.evictPage('page2'), false, 'the history refers to it');
  assert.equal(store.evictPage('page'), false, 'the current page');
  const replacedHistory = createDesignStore({doc: store.getState().doc, measurer, idle: work => (work(), () => {}), partial: {loaded: ['page', 'page2'], load: server.load, dirty: () => dirty}});
  dirty = true;
  assert.equal(replacedHistory.evictPage('page2'), false, 'an unsaved change waits');
  dirty = false;
  const patches: PatchEvent[] = [];
  replacedHistory.onPatch(event => patches.push(event));
  assert.equal(replacedHistory.evictPage('page2'), true);
  assert.equal(replacedHistory.getState().doc.nodes.p2r, undefined);
  assert.ok(replacedHistory.getState().doc.nodes.v1r, 'components stay resident');
  assert.equal(replacedHistory.getState().doc.nodes.page2.children!.length, 2, 'the page node keeps its list');
  assert.deepEqual(patches.map(event => event.source), ['page']);
  assert.deepEqual([...replacedHistory.getState().pages!.loaded], ['page']);
  // Undo on the first store, whose page 2 the history holds: still loaded, the step applies at once.
  assert.equal(store.undo(), true);
  assert.equal(store.getState().pageId, 'page2');
  assert.equal(store.getState().doc.nodes.p2r.name, whole.nodes.p2r.name);
});

test('replaceDocument of a whole document keeps only the pages a partial store holds', () => {
  const whole = sample();
  const store = createDesignStore({doc: skeletonOf(whole, ['page']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['page'], load: () => Promise.reject(new Error('unused'))}});
  const renamed = {...whole, nodes: {...whole.nodes, r: {...whole.nodes.r, name: 'Server'}}};
  store.replaceDocument(renamed);
  assert.equal(store.getState().doc.nodes.r.name, 'Server');
  assert.equal(store.getState().doc.nodes.p2r, undefined, 'page 2 was never loaded');
  assert.deepEqual([...store.getState().pages!.loaded], ['page']);
});

test('the memory guard refuses edits that add layers while the budget is full, lets the rest through', () => {
  const store = createDesignStore({doc: sample(), measurer, idle: work => (work(), () => {})});
  const refused: [string, string][] = [];
  store.onRefused((label, reason) => refused.push([label, reason]));
  store.setMemoryGuard(() => false);
  store.transact('Insert', tx => tx.create(createNode('RECTANGLE', {id: 'added'}), 'page'));
  assert.equal(store.getState().doc.nodes.added, undefined, 'a new layer is refused');
  assert.deepEqual(refused, [['Insert', 'memory']]);
  store.transact('Rename', tx => tx.update('r', {name: 'Allowed'}));
  assert.equal(store.getState().doc.nodes.r.name, 'Allowed', 'a change of a layer goes through');
  store.transact('Delete', tx => tx.remove('e'));
  assert.equal(store.getState().doc.nodes.e, undefined, 'a removal goes through');
  const gesture = store.gesture('Draw');
  gesture.update(tx => tx.create(createNode('RECTANGLE', {id: 'drawn'}), 'page'));
  assert.ok(store.getState().doc.nodes.drawn, 'shown while the gesture runs');
  assert.equal(gesture.commit(), null);
  assert.equal(store.getState().doc.nodes.drawn, undefined, 'dropped at the end');
  assert.equal(refused.length, 2);
  store.setMemoryGuard(null);
  store.transact('Insert', tx => tx.create(createNode('RECTANGLE', {id: 'added'}), 'page'));
  assert.ok(store.getState().doc.nodes.added, 'the guard is gone');
  assert.equal(store.canUndo(), true);
});

test('in Dev Mode (ui.devMode) only annotations and measurements change the document, and only they undo', () => {
  const store = createDesignStore({doc: sample(), measurer});
  const refused: [string, string][] = [];
  store.onRefused((label, reason) => refused.push([label, reason]));
  store.transact('Nudge', tx => tx.update('r', {x: 50}));
  store.setUI({devMode: true});
  store.transact('Nudge', tx => tx.update('r', {x: 60}), {coalesce: 'nudge'});
  assert.equal(store.getState().doc.nodes.r.x, 50, 'a nudge is refused');
  const drag = store.gesture('Move');
  assert.equal(drag.active, false, 'a drag does not start');
  drag.update(tx => tx.update('r', {x: 70}));
  assert.equal(drag.commit(), null);
  assert.equal(store.getState().doc.nodes.r.x, 50);
  assert.equal(store.undo(), false, 'the design edit made before Dev Mode stays');
  assert.equal(store.getState().doc.nodes.r.x, 50);
  assert.deepEqual(refused, [['Nudge', 'devMode'], ['Move', 'devMode'], ['Nudge', 'devMode']]);

  store.transact('Annotation', tx => tx.update('r', {annotations: [{id: 'a1', label: 'Padding 16'}]}), {annotation: true});
  assert.equal(store.getState().doc.nodes.r.annotations?.[0].label, 'Padding 16');
  const measure = store.gesture('Measure', {annotation: true});
  measure.update(tx => tx.update('page', {measurements: [{id: 'm1', start: {nodeId: 'r', side: 'LEFT'}, end: {nodeId: 'e', side: 'LEFT'}, offset: {type: 'OUTER', fixed: 8}}]}));
  assert.ok(measure.commit(), 'a measurement goes through');
  assert.ok(store.undo(), 'the measurement undoes');
  assert.ok(store.undo(), 'the note undoes');
  assert.equal(store.getState().doc.nodes.r.annotations, undefined);
  assert.equal(store.undo(), false);
  store.transact('Font loaded', tx => tx.update('r', {name: 'Remeasured'}), {history: false});
  assert.equal(store.getState().doc.nodes.r.name, 'Remeasured', 'the engine\'s own corrections still apply');

  store.setUI({devMode: false});
  assert.ok(store.undo(), 'back in Design mode the edit undoes');
  assert.equal(store.getState().doc.nodes.r.x, 10);
});
