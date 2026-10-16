import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DOT_SPACING, dotPositions, dotSpacing, paintDotGrid} from '../src/design/engine/render/dot-grid';
import type {Ctx2D} from '../src/design/engine/render/canvas';

// A board's dot grid (docs/board.md §Chrome): dots on page multiples so tiles line up, thinned when zoomed out, one fill per tile.

test('should keep dots 12 page px apart at 100 % and double the gap when they would come closer than 10 CSS px', () => {
  assert.equal(dotSpacing(1), DOT_SPACING);
  assert.equal(dotSpacing(0.5), DOT_SPACING * 2);
  assert.equal(dotSpacing(0.25), DOT_SPACING * 4);
  assert.equal(dotSpacing(0.1), DOT_SPACING * 16);
  assert.equal(dotSpacing(4), DOT_SPACING);
  for (const zoom of [0.02, 0.1, 0.37, 0.5, 1, 2, 8]) assert.ok(dotSpacing(zoom) * zoom >= 10, `zoom ${zoom}`);
});

test('should put dots on page multiples of the gap whichever tile paints them', () => {
  const scale = 2;
  const left = dotPositions({x: 0, y: 0}, scale, 24, 512, 512);
  const right = dotPositions({x: 256, y: 0}, scale, 24, 512, 512);
  // Page x of each dot: origin + device px / scale.
  const pageXs = (origin: number, xs: number[]) => xs.map(x => origin + x / scale);
  for (const x of [...pageXs(0, left.xs), ...pageXs(256, right.xs)]) assert.equal(x % 24, 0);
  assert.ok(pageXs(256, right.xs).includes(264));
  assert.equal(left.xs[0], 0);
});

test('should paint every dot of a tile with one fill', () => {
  let rects = 0, fills = 0;
  const ctx = {beginPath() {}, rect() { rects++; }, fill() { fills++; }, fillStyle: ''} as unknown as Ctx2D;
  paintDotGrid(ctx, {x: 0, y: 0}, 2, 2, 512, 512);
  assert.equal(fills, 1);
  // 512 device px at 2× is 256 page px: dots at 0, 12 … 252 → 22 a side.
  assert.equal(rects, 22 * 22);
});
