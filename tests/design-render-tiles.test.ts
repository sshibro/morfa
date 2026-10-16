import {test} from 'node:test';
import assert from 'node:assert/strict';
import {levelKey, levelScale, placeRects, planFallback, TILE, tileBudgetBytes, tileKey, tilePageRect, tileRange, tileScreenRect, tilesByDistance} from '../src/design/engine/render/tile-math';
import {gridBands, gridLines} from '../src/design/engine/render/grid-math';

const MB = 1024 * 1024;

test('levels: exact screen scale once settled, the power of two above it while zooming', () => {
  assert.equal(levelScale(2, true), 2);
  // Exactly the screen scale: rounded, its tiles were drawn resampled and showed every seam.
  assert.equal(levelScale(1.37, true), 1.37);
  assert.equal(levelScale(2 * 1.234567891, true), 2 * 1.234567891);
  assert.equal(levelScale(1.37, false), 2);
  assert.equal(levelScale(0.3, false), 0.5);
  assert.equal(levelScale(4, false), 4);
  assert.equal(levelScale(0, true), 1);
  assert.notEqual(levelKey(1), levelKey(1.0001));
  assert.notEqual(levelKey(1.37), levelKey(1.3700001));
});

test('tiles cover page rectangles on a grid anchored at the page origin', () => {
  assert.deepEqual(tilePageRect(1, -1, 2), {x: TILE / 2, y: -TILE / 2, width: TILE / 2, height: TILE / 2});
  assert.deepEqual(tileRange({x: 0, y: 0, width: TILE, height: TILE}, 1), {i0: 0, j0: 0, i1: 0, j1: 0});
  assert.deepEqual(tileRange({x: -1, y: 0, width: TILE + 2, height: 1}, 1), {i0: -1, j0: 0, i1: 1, j1: 0});
  assert.deepEqual(tileRange({x: 0, y: 0, width: 1000, height: 10}, 0.5), {i0: 0, j0: 0, i1: 0, j1: 0});
});

test('the visible tiles come nearest the centre first', () => {
  const order = tilesByDistance({x: 0, y: 0, width: 3 * TILE, height: TILE}, 1);
  assert.equal(order.length, 3);
  assert.deepEqual(order[0], {i: 1, j: 0});
});

test('tile memory follows device memory within 96–384 MB', () => {
  assert.equal(tileBudgetBytes(undefined), 192 * MB);
  assert.equal(tileBudgetBytes(1), 96 * MB);
  assert.equal(tileBudgetBytes(4), 192 * MB);
  assert.equal(tileBudgetBytes(16), 384 * MB);
});

test('same-scale tiles land on whole pixels; other scales stretch', () => {
  const r = tileScreenRect(2, 1, 1, 10.4, -3.6, 1);
  assert.deepEqual(r, {x: 2 * TILE - 10, y: TILE + 4, width: TILE, height: TILE});
  const stretched = tileScreenRect(1, 0, 2, 0, 0, 1);
  assert.deepEqual(stretched, {x: TILE / 2, y: 0, width: TILE / 2, height: TILE / 2});
});

test('tiles meet edge to edge on whole pixels at any zoom: no seam is left half covered', () => {
  for (const [scale, screen, vx, vy] of [[2, 1.37 * 2, 13.3, -7.77], [1, 0.731, 101.9, 5.5], [4, 3.3333, -0.4, 0.6], [2.71, 2.71, 3.21, 9.99], [1, 1.25, 0.37, 0.61]]) {
    for (let i = -3; i < 4; i++) for (let j = -3; j < 4; j++) {
      const a = tileScreenRect(i, j, scale, vx, vy, screen), right = tileScreenRect(i + 1, j, scale, vx, vy, screen), below = tileScreenRect(i, j + 1, scale, vx, vy, screen);
      for (const value of [a.x, a.y, a.width, a.height]) assert.ok(Number.isInteger(value), `${value} at ${scale}/${screen}`);
      assert.ok(a.x + a.width === right.x, `x seam at ${i},${j}`);
      assert.ok(a.y + a.height === below.y, `y seam at ${i},${j}`);
      assert.ok(Math.abs(a.width - (TILE * screen) / scale) <= 1);
    }
  }
});

type T = {i: number; j: number; dirty: boolean};
const level = (scale: number, places: [number, number][], dirty: [number, number][] = []) => ({
  scale,
  tiles: new Map<string, T>([...places.map(([i, j]) => [tileKey(i, j), {i, j, dirty: false}] as const), ...dirty.map(([i, j]) => [tileKey(i, j), {i, j, dirty: true}] as const)]),
});

test('fallback: a hole closes at the nearest level that covers it, and further levels fill only what stays open', () => {
  const holes = [{i: 0, j: 0}, {i: 1, j: 0}, {i: 2, j: 0}];
  // Half this scale: tile (0, 0) covers holes 0 and 1; (1, 0) covers hole 2 but is stale.
  const half = level(0.5, [[0, 0]], [[1, 0]]);
  // Twice this scale: four tiles under each hole; only hole 2 is complete.
  const double = level(2, [[0, 0], [4, 0], [5, 0], [4, 1], [5, 1]]);
  const quarter = level(0.25, [[0, 0]]);
  const {picks, covered} = planFallback<T, ReturnType<typeof level>>(holes, 1, [half, double, quarter]);
  assert.equal(covered, true);
  assert.deepEqual(picks.map(p => p.level.scale), [0.5, 2]);
  assert.deepEqual(picks[0].open, holes, 'the nearest level is asked about every hole');
  assert.deepEqual(picks[1].open, [{i: 2, j: 0}], 'the next only about the hole the nearest left open');
  assert.equal(picks[1].tiles.length, 4, 'only its tiles under that hole');
  assert.equal(picks.length, 2, 'the walk stops once every hole is closed: the quarter scale is never drawn');
  const none = planFallback<T, ReturnType<typeof level>>(holes, 1, [level(4, [[0, 0]])]);
  assert.equal(none.covered, false);
  assert.deepEqual(none.picks[0].open, holes);
});

test('fallback: a level with fewer tiles than places under the holes is walked by its tiles', () => {
  // 64× finer: each hole spans 4096 places; the level holds two tiles, under hole 1 only.
  const fine = level(64, [[64, 0], [65, 3]]);
  const {picks, covered} = planFallback<T, ReturnType<typeof level>>([{i: 0, j: 0}, {i: 1, j: 0}], 1, [fine]);
  assert.equal(covered, false);
  assert.equal(picks[0].tiles.length, 2);
});

test('hole places merge into rectangles: row runs, then equal runs of neighbouring rows', () => {
  assert.deepEqual(placeRects([{i: 0, j: 0}, {i: 1, j: 0}, {i: 0, j: 1}, {i: 1, j: 1}, {i: 3, j: 1}]), [{i0: 0, j0: 0, i1: 1, j1: 1}, {i0: 3, j0: 1, i1: 3, j1: 1}]);
  assert.deepEqual(placeRects([{i: 2, j: 5}]), [{i0: 2, j0: 5, i1: 2, j1: 5}]);
  assert.deepEqual(placeRects([]), []);
});

test('layout grid columns: stretch, aligned and automatic counts', () => {
  const color = {r: 1, g: 0, b: 0, a: 0.1};
  const stretch = gridBands({pattern: 'COLUMNS', alignment: 'STRETCH', count: 4, gutterSize: 20, offset: 40, sectionSize: 0, visible: true, color}, 1000, 500);
  assert.equal(stretch.length, 4);
  assert.equal(stretch[0].x, 40);
  assert.equal(stretch[0].width, (1000 - 80 - 60) / 4);
  assert.equal(stretch[3].x + stretch[3].width, 960);
  const centred = gridBands({pattern: 'COLUMNS', alignment: 'CENTER', count: 2, gutterSize: 10, offset: 0, sectionSize: 100, visible: true, color}, 400, 100);
  assert.deepEqual(centred.map(b => b.x), [95, 205]);
  const right = gridBands({pattern: 'ROWS', alignment: 'MAX', count: 1, gutterSize: 0, offset: 10, sectionSize: 50, visible: true, color}, 100, 300);
  assert.deepEqual(right[0], {x: 0, y: 240, width: 100, height: 50});
  const auto = gridBands({pattern: 'COLUMNS', alignment: 'MIN', count: Infinity, gutterSize: 10, offset: 0, sectionSize: 90, visible: true, color}, 400, 10);
  assert.equal(auto.length, 4);
  assert.deepEqual(gridLines(10, 35, 20), {xs: [10, 20, 30], ys: [10]});
  assert.deepEqual(gridLines(0, 35, 20), {xs: [], ys: []});
});
