import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PathCommand, Vec} from '../shared/design/types';
import {markerSize} from '../shared/design/bounds';
import {individualStrokeBand, markerShape, pathEnds, roundedRectCommands, shortenPath, strokePlan} from '../src/design/engine/render/stroke-math';

const close = (a: number, b: number, message = '') => assert.ok(Math.abs(a - b) < 1e-9, `${message} ${a} ≠ ${b}`);
const points = (commands: PathCommand[] | null) => (commands ?? []).filter((c): c is Extract<PathCommand, {x: number}> => c.type !== 'Z').map(c => ({x: c.x, y: c.y}));

test('stroke alignment: inside clips to the shape, outside clips it out, both at twice the weight', () => {
  assert.deepEqual(strokePlan('INSIDE', 3, false), {clip: 'inside', lineWidth: 6});
  assert.deepEqual(strokePlan('OUTSIDE', 3, false), {clip: 'outside', lineWidth: 6});
  assert.deepEqual(strokePlan('CENTER', 3, false), {clip: null, lineWidth: 3});
  assert.deepEqual(strokePlan('OUTSIDE', 3, true), {clip: null, lineWidth: 3}, 'open paths have no outside');
});

test('path ends point out of the path, along the first and last tangents', () => {
  const ends = pathEnds([{type: 'M', x: 0, y: 0}, {type: 'L', x: 100, y: 0}]);
  assert.ok(ends);
  assert.deepEqual(ends.start.point, {x: 0, y: 0});
  close(ends.start.direction.x, -1);
  close(ends.end.direction.x, 1);
  // A curve ends along its last control leg, not its chord.
  const curve = pathEnds([{type: 'M', x: 0, y: 0}, {type: 'C', x1: 0, y1: 50, x2: 100, y2: 50, x: 100, y: 0}]);
  close(curve!.start.direction.y, -1);
  close(curve!.end.direction.y, -1);
  assert.equal(pathEnds([{type: 'M', x: 0, y: 0}, {type: 'L', x: 1, y: 0}, {type: 'L', x: 1, y: 1}, {type: 'Z'}]), null);
});

test('markers sit on the ends and scale with the stroke weight', () => {
  const end = {point: {x: 100, y: 0}, direction: {x: 1, y: 0}};
  const arrow = markerShape('TRIANGLE_ARROW', end, 2)!;
  const tri = points(arrow.fill);
  assert.deepEqual(tri[0], {x: 100, y: 0}, 'the tip is the end point');
  close(Math.min(...tri.map(p => p.x)), 100 - markerSize(2));
  assert.ok(arrow.inset > 0 && arrow.inset < markerSize(2), 'the line stops under the triangle');
  const reversed = points(markerShape('REVERSED_TRIANGLE', end, 2)!.fill);
  close(reversed[0].x, 100 - markerSize(2), 'its tip points back along the line');
  const big = points(markerShape('CIRCLE', end, 10)!.fill), small = points(markerShape('CIRCLE', end, 1)!.fill);
  assert.ok(Math.max(...big.map(p => p.x)) - 100 > Math.max(...small.map(p => p.x)) - 100);
  const open = markerShape('LINE_ARROW', end, 2)!;
  assert.equal(open.fill, null);
  assert.equal(points(open.stroke).length, 3);
  const square = points(markerShape('SQUARE', end, 4)!.fill);
  close(Math.max(...square.map(p => p.x)), 102, 'a square cap reaches half the weight');
  assert.equal(markerShape('NONE', end, 2), null);
});

test('shortening moves only the free ends, keeping tangents', () => {
  const line: PathCommand[] = [{type: 'M', x: 0, y: 0}, {type: 'L', x: 100, y: 0}];
  const short = points(shortenPath(line, 5, 10));
  assert.deepEqual(short, [{x: 5, y: 0}, {x: 90, y: 0}]);
  assert.equal(line[0].type === 'M' && line[0].x, 0, 'the input is not mutated');
  const curve: PathCommand[] = [{type: 'M', x: 0, y: 0}, {type: 'C', x1: 0, y1: 50, x2: 100, y2: 50, x: 100, y: 0}];
  const out = shortenPath(curve, 0, 10)[1] as Extract<PathCommand, {type: 'C'}>;
  close(out.y, 10); close(out.y2, 60);
  assert.equal(shortenPath(line, 0, 0), line);
});

test('per-side stroke weights make a band between two rounded rectangles', () => {
  const inside = individualStrokeBand(100, 50, {top: 2, right: 4, bottom: 6, left: 8}, 'INSIDE', [10, 0, 0, 0]);
  assert.deepEqual(inside.outer.rect, {x: -0, y: -0, width: 100, height: 50});
  assert.deepEqual(inside.inner!.rect, {x: 8, y: 2, width: 88, height: 42});
  assert.deepEqual(inside.inner!.radii, [2, 0, 0, 0], 'the inner corner shrinks by its larger side');
  const outside = individualStrokeBand(100, 50, {top: 2, right: 4, bottom: 6, left: 8}, 'OUTSIDE', [10, 0, 0, 0]);
  assert.deepEqual(outside.outer.rect, {x: -8, y: -2, width: 112, height: 58});
  assert.deepEqual(outside.outer.radii, [18, 0, 0, 0], 'sharp corners stay sharp');
  const center = individualStrokeBand(10, 10, {top: 30, right: 0, bottom: 0, left: 0}, 'CENTER', [0, 0, 0, 0]);
  assert.equal(center.inner, null, 'a stroke wider than the box leaves no hole');
});

test('rounded rectangle radii are clamped so corners never overlap', () => {
  const cmds = roundedRectCommands({x: 0, y: 0, width: 100, height: 20}, [50, 50, 50, 50]);
  const xs = points(cmds).map((p: Vec) => p.x), ys = points(cmds).map((p: Vec) => p.y);
  close(Math.min(...xs), 0); close(Math.max(...xs), 100);
  close(Math.min(...ys), 0); close(Math.max(...ys), 20);
  assert.deepEqual(points(roundedRectCommands({x: 0, y: 0, width: 10, height: 10}, [0, 0, 0, 0])).length, 5);
});
