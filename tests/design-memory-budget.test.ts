import test from 'node:test';
import assert from 'node:assert/strict';
import {BYTES_PER_LAYER, estimateMemory, evictionPlan, historyLayersOf, measuredHeapBytes, memoryBudget, memoryDetails, memoryLabel, memoryWarning, MEMORY_BUDGET_BYTES, MEMORY_EVICT_TO, MEMORY_WARN_AT} from '../src/design/editor/memory-budget';

// The memory budget of a big file (docs/decisions/big-files.md §5): the estimate, the levels, the eviction plan.

test('the budget is 2 GiB, a quarter of a small device', () => {
  assert.equal(memoryBudget(undefined), MEMORY_BUDGET_BYTES);
  assert.equal(memoryBudget(16), MEMORY_BUDGET_BYTES);
  assert.equal(memoryBudget(8), MEMORY_BUDGET_BYTES);
  assert.equal(memoryBudget(4), 1024 ** 3);
  assert.equal(memoryBudget(2), 512 * 1024 ** 2, 'never under half a GiB');
  assert.equal(memoryBudget(0), MEMORY_BUDGET_BYTES);
});

test('the estimate counts layers, tiles and the history against the budget, with Figma’s levels', () => {
  const ok = estimateMemory({layers: 100_201, tileBytes: 128 * 1024 ** 2});
  assert.equal(ok.document, 100_201 * BYTES_PER_LAYER);
  assert.equal(ok.total, ok.document + 128 * 1024 ** 2);
  assert.equal(ok.level, 'ok');
  assert.ok(ok.ratio > 0.14 && ok.ratio < 0.16, `f100k is about a seventh of the budget (${ok.ratio})`);
  assert.equal(estimateMemory({layers: 10, wasmBytes: 5000}).total, 10 * BYTES_PER_LAYER + 5000);
  assert.equal(estimateMemory({layers: 0, budget: 1000, tileBytes: 600}).level, 'warn');
  assert.equal(estimateMemory({layers: 0, budget: 1000, tileBytes: 750}).level, 'high');
  assert.equal(estimateMemory({layers: 0, budget: 1000, tileBytes: 1000}).level, 'full');
  assert.equal(estimateMemory({layers: 10, historyLayers: 5}).history, 5 * 2 * BYTES_PER_LAYER);
  assert.equal(historyLayersOf([{patch: {nodes: {a: 1, b: 2}}, inverse: {nodes: {a: 1, b: 2}}}, {patch: {}, inverse: {}}]), 2);
  assert.equal(measuredHeapBytes({memory: {usedJSHeapSize: 123}}), 123);
  assert.equal(measuredHeapBytes({}), null);
  assert.equal(measuredHeapBytes(undefined), null);
});

test('the eviction plan lets the least recently viewed hidden pages go until the estimate is under half the budget', () => {
  const layers: Record<string, number> = {a: 20_000, b: 20_000, c: 20_000, d: 20_000};
  const budget = 100_000 * BYTES_PER_LAYER;
  const state = {pageId: 'a', pages: {loaded: new Set(['a', 'b', 'c', 'd']), loading: new Set<string>(), layers}};
  const estimate = estimateMemory({layers: 80_000, budget});
  assert.equal(estimate.level, 'high');
  const lastViewed = new Map([['b', 3], ['c', 1], ['d', 2]]);
  assert.deepEqual(evictionPlan(state, estimate, lastViewed, id => layers[id]), ['c', 'd'], 'c then d: 80 000 → 40 000 layers = 40 % ≤ 50 %');
  assert.deepEqual(evictionPlan(state, estimateMemory({layers: 40_000, budget}), lastViewed, id => layers[id]), [], 'under the first warning: nothing goes');
  assert.deepEqual(evictionPlan({pageId: 'a', pages: null}, estimate, lastViewed, () => 0), [], 'a whole document is never evicted');
  const loading = {...state, pages: {...state.pages, loading: new Set(['c'])}};
  assert.deepEqual(evictionPlan(loading, estimate, lastViewed, id => layers[id]), ['d', 'b'], 'a loading page is skipped');
  assert.ok(MEMORY_EVICT_TO < MEMORY_WARN_AT);
});

test('labels and warnings', () => {
  const estimate = estimateMemory({layers: 100_201, tileBytes: 128 * 1024 ** 2, measured: 300 * 1024 ** 2});
  assert.equal(memoryLabel(estimate), 'File memory: 15%');
  const details = memoryDetails(estimate, {loaded: 1, total: 25});
  assert.match(details, /100,201 layers in memory, pages loaded 1 of 25/);
  assert.match(details, /Canvas cache: 128 MB/);
  assert.match(details, /Browser: 300 MB used by the tab/);
  assert.equal(memoryWarning('ok'), null);
  assert.match(memoryWarning('warn')!, /are unloaded/);
  assert.match(memoryWarning('high')!, /almost used up/);
  assert.match(memoryWarning('full')!, /are not applied/);
});
