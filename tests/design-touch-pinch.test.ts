import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pinchViewport} from '../src/design/engine/touch/pinch';
import {screenToPage} from '../src/design/engine/viewport';
import {ZOOM_MAX} from '../src/design/engine/contracts';

// Two fingers on the canvas (src/design/engine/touch/pinch.ts): zoom about the fingers' centre, pan with it.

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('should double the zoom when the fingers spread to twice their distance', () => {
  const from = {x: 0, y: 0, zoom: 1};

  const next = pinchViewport(from, [{x: 100, y: 100}, {x: 200, y: 100}], [{x: 50, y: 100}, {x: 250, y: 100}]);

  close(next.zoom, 2);
});

test('should keep the page point under the fingers\' centre when they pinch in place', () => {
  const from = {x: -40, y: 30, zoom: 0.5};
  const start = [{x: 120, y: 300}, {x: 220, y: 380}] as const;
  const before = screenToPage(from, {x: 170, y: 340});

  const next = pinchViewport(from, start, [{x: 70, y: 260}, {x: 270, y: 420}]);
  const after = screenToPage(next, {x: 170, y: 340});

  close(after.x, before.x);
  close(after.y, before.y);
});

test('should pan by the centre\'s travel when the fingers move together without spreading', () => {
  const from = {x: 10, y: 10, zoom: 2};

  const next = pinchViewport(from, [{x: 100, y: 100}, {x: 200, y: 100}], [{x: 130, y: 60}, {x: 230, y: 60}]);

  close(next.zoom, 2);
  close(next.x, 10 - 30 / 2);
  close(next.y, 10 + 40 / 2);
});

test('should stop at the zoom limit when the fingers spread past it', () => {
  const next = pinchViewport({x: 0, y: 0, zoom: 200}, [{x: 100, y: 100}, {x: 110, y: 100}], [{x: 0, y: 100}, {x: 300, y: 100}]);

  assert.equal(next.zoom, ZOOM_MAX);
});

test('should keep the zoom when the fingers start too close to measure', () => {
  const next = pinchViewport({x: 0, y: 0, zoom: 1}, [{x: 100, y: 100}, {x: 101, y: 100}], [{x: 0, y: 100}, {x: 300, y: 100}]);

  assert.equal(next.zoom, 1);
});
