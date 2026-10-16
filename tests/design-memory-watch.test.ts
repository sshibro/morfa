import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {pageSlice, skeletonOf} from '../shared/design/pages';
import {createDesignStore} from '../src/design/engine/store';
import {BYTES_PER_LAYER} from '../src/design/editor/memory-budget';
import {memoryWatchOf, startMemoryWatch} from '../src/design/editor/memory-watch';

// The memory watch (docs/decisions/big-files.md §5): the estimate follows the pages the store holds, hidden pages go past the
// first warning, the guard holds while the budget is full, nothing runs for a whole document.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** Three pages of `n` rectangles each. */
function pagesOf(n: number): DesignDocument {
  const tx = beginTransaction(createDocument('p1'));
  tx.addPage(createNode('PAGE', {id: 'p2', name: 'Second'}));
  tx.addPage(createNode('PAGE', {id: 'p3', name: 'Third'}));
  for (const page of ['p1', 'p2', 'p3']) for (let i = 0; i < n; i++) tx.create(createNode('RECTANGLE', {id: `${page}r${i}`, x: i, y: i}) as SceneNode, page as NodeId);
  return tx.commit({measurer}).doc;
}

test('a whole document has no watch', () => {
  const store = createDesignStore({doc: pagesOf(2), measurer, idle: work => (work(), () => {})});
  const watch = startMemoryWatch(store);
  assert.equal(watch.estimate(), null);
  assert.equal(memoryWatchOf(store).estimate(), null);
  watch.stop();
});

test('the estimate follows loaded pages; past 60 % hidden pages go, least recently viewed first; at 100 % the guard holds', async () => {
  const whole = pagesOf(10);
  const load = (pageId: NodeId) => Promise.resolve({version: 1, nodes: pageSlice(whole, pageId)});
  const layers = {p1: 10, p2: 10, p3: 10};
  const store = createDesignStore({doc: skeletonOf(whole, ['p1']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['p1'], layers, load}});
  let clock = 1;
  const levels: string[] = [];
  // A budget of 25 layers: one page is 40 %, two are 80 % (past the first warning), three are 120 % (full).
  const watch = startMemoryWatch(store, {budget: 25 * BYTES_PER_LAYER, debounceMs: 1, now: () => clock++, measured: () => null, wasm: () => 0, onLevel: level => levels.push(level)});
  assert.equal(memoryWatchOf(store), watch);
  assert.equal(watch.estimate()!.layers, 10);
  assert.equal(watch.estimate()!.level, 'ok');
  // A second page: 80 % — past the first warning (the second one, even); the hidden page goes.
  store.setPage('p2');
  await tick();
  await tick();
  assert.equal(store.getState().pageId, 'p2');
  watch.refresh();
  assert.equal(watch.estimate()!.level, 'ok', 'p1 was let go: back to one page');
  assert.deepEqual([...store.getState().pages!.loaded], ['p2']);
  assert.ok(levels.includes('high') || levels.includes('warn'), `the warning was raised once on the way (${levels})`);
  watch.stop();
  // Without eviction room (every page in the history), the guard holds at 100 %.
  const full = createDesignStore({doc: skeletonOf(whole, ['p1', 'p2', 'p3']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['p1', 'p2', 'p3'], layers, load, dirty: () => true}});
  const refused: string[] = [];
  full.onRefused((_label, reason) => refused.push(reason));
  const guard = startMemoryWatch(full, {budget: 25 * BYTES_PER_LAYER, debounceMs: 1, measured: () => null, wasm: () => 0});
  assert.equal(guard.estimate()!.level, 'full');
  assert.deepEqual([...full.getState().pages!.loaded].sort(), ['p1', 'p2', 'p3'], 'nothing evicted: an unsaved change waits');
  full.transact('Insert', tx => tx.create(createNode('RECTANGLE', {id: 'more'}), 'p1'));
  assert.deepEqual(refused, ['memory']);
  guard.stop();
  full.transact('Insert', tx => tx.create(createNode('RECTANGLE', {id: 'more'}), 'p1'));
  assert.ok(full.getState().doc.nodes.more, 'the guard is lifted when the watch stops');
});

test('the layer count follows every change without a scan of the node table (the f500k hitch)', async () => {
  const whole = pagesOf(6);
  const load = (pageId: NodeId) => Promise.resolve({version: 1, nodes: pageSlice(whole, pageId)});
  const store = createDesignStore({doc: skeletonOf(whole, ['p1']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['p1'], layers: {p1: 6, p2: 6, p3: 6}, load}});
  const watch = startMemoryWatch(store, {debounceMs: 1, measured: () => null, wasm: () => 0});
  // Object.keys on the store's node table while the watch counts (the store's own uses aside): never, after it started.
  const keys = Object.keys;
  let scans = 0, counting = false;
  Object.keys = ((o: object) => {
    if (counting && o === store.getState().doc.nodes) scans++;
    return keys(o);
  }) as typeof Object.keys;
  const check = (step: string) => {
    counting = true;
    watch.refresh();
    counting = false;
    const state = store.getState();
    const nodes = keys(state.doc.nodes).length;
    assert.equal(watch.estimate()!.layers, nodes - state.doc.pages.length, step);
    assert.equal(scans, 0, `${step}: no scan`);
  };
  try {
    check('opened');
    store.transact('add', tx => tx.create(createNode('RECTANGLE', {id: 'n1', x: 0, y: 0}) as SceneNode, 'p1' as NodeId));
    check('a layer added');
    store.transact('remove', tx => tx.remove('p1r0' as NodeId));
    check('a layer removed');
    store.transact('move', tx => tx.update('p1r1' as NodeId, {x: 40}));
    check('a layer changed');
    // A gesture that adds a layer and then, in a later frame, does not.
    const drag = store.gesture('copy');
    drag.update(tx => tx.create(createNode('RECTANGLE', {id: 'g1', x: 1, y: 1}) as SceneNode, 'p1' as NodeId));
    check('a gesture frame that adds');
    drag.update(tx => tx.update('p1r2' as NodeId, {x: 9}));
    check('a gesture frame that does not');
    drag.update(tx => {
      tx.create(createNode('RECTANGLE', {id: 'g2', x: 2, y: 2}) as SceneNode, 'p1' as NodeId);
      tx.remove('p1r3' as NodeId);
    });
    drag.commit();
    check('the gesture kept');
    const cancelled = store.gesture('cancelled');
    cancelled.update(tx => tx.create(createNode('RECTANGLE', {id: 'g3', x: 3, y: 3}) as SceneNode, 'p1' as NodeId));
    cancelled.cancel();
    check('a gesture cancelled');
    store.undo();
    check('undo');
    store.redo();
    check('redo');
    store.setPage('p2');
    await tick();
    await tick();
    check('a page loaded');
    store.evictPage('p3');
    store.setPage('p1');
    assert.ok(store.evictPage('p2'), 'p2 goes');
    check('a page let go');
    store.applyRemote(() => ({nodes: {r9: createNode('RECTANGLE', {id: 'r9', parentId: 'p1'}) as SceneNode}}));
    check('a remote change');
    store.replaceDocument(skeletonOf(whole, ['p1', 'p2']));
    check('the document replaced');
  } finally {
    Object.keys = keys;
    watch.stop();
  }
});

test('the wasm modules\' memories count toward the budget', () => {
  const whole = pagesOf(4);
  const store = createDesignStore({doc: skeletonOf(whole, ['p1']), measurer, idle: work => (work(), () => {}), partial: {loaded: ['p1'], layers: {p1: 4, p2: 4, p3: 4}, load: async () => ({version: 1, nodes: {}})}});
  let wasm = 0;
  const watch = startMemoryWatch(store, {budget: 100 * BYTES_PER_LAYER, measured: () => null, wasm: () => wasm});
  assert.equal(watch.estimate()!.wasm, 0);
  wasm = 70 * BYTES_PER_LAYER;
  watch.refresh();
  assert.equal(watch.estimate()!.wasm, wasm);
  assert.equal(watch.estimate()!.total, 4 * BYTES_PER_LAYER + wasm);
  assert.equal(watch.estimate()!.level, 'warn', '74 % of the budget');
  watch.stop();
});
