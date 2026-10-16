import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Vec} from '../shared/design/types';
import {invert, apply} from '../shared/design/geometry';
import {colorAt, conicStartAngle, gradientFrame, gradientParameter, isSimilarity, keepsOrientation, linearGradientPoints, normalizedStops} from '../src/design/engine/render/gradient-math';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
type Handles = [Vec, Vec, Vec];

/** t of a canvas linear gradient from (x0, y0) to (x1, y1) at a point. */
function canvasT(p: {x0: number; y0: number; x1: number; y1: number}, point: Vec): number {
  const dx = p.x1 - p.x0, dy = p.y1 - p.y0;
  return ((point.x - p.x0) * dx + (point.y - p.y0) * dy) / (dx * dx + dy * dy);
}

test('default horizontal handles give a left-to-right gradient across the box', () => {
  const handles: Handles = [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}];
  const p = linearGradientPoints(handles, 200, 100);
  close(p.x0, 0); close(p.y0, 50); close(p.x1, 200); close(p.y1, 50);
});

test('a linear gradient matches the handles in gradient space for any box and handles', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 0.5;
  for (let k = 0; k < 200; k++) {
    const handles: Handles = [{x: random(), y: random()}, {x: random(), y: random()}, {x: random(), y: random()}];
    const width = 10 + Math.abs(random()) * 300, height = 10 + Math.abs(random()) * 300;
    const frame = gradientFrame(handles, width, height);
    const det = frame.a.x * frame.b.y - frame.a.y * frame.b.x;
    if (Math.abs(det) < 1e-3) continue;
    const p = linearGradientPoints(handles, width, height);
    const toGradient = invert(frame.matrix);
    for (let j = 0; j < 5; j++) {
      const point = {x: random() * width, y: random() * height};
      const u = apply(toGradient, point).x;
      close(canvasT(p, point), u, 1e-6);
      close(gradientParameter('GRADIENT_LINEAR', u, 0), u);
    }
  }
});

test('the perpendicular handle skews iso-colour lines on a stretched box', () => {
  // Handles along the unit diagonal; the box is 4:1, so in px the colour lines are not perpendicular
  // to the diagonal but parallel to the scaled (h2 − h0).
  const handles: Handles = [{x: 0, y: 0}, {x: 1, y: 1}, {x: -0.5, y: 0.5}];
  const p = linearGradientPoints(handles, 400, 100);
  // Points along the scaled h2 direction from the start share t = 0.
  close(canvasT(p, {x: -0.5 * 400 * 0.3, y: 0.5 * 100 * 0.3}), 0);
  close(canvasT(p, {x: 400, y: 100}), 1);
});

test('radial and angular gradients are native only when the frame keeps circles round', () => {
  const round = gradientFrame([{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}], 100, 100);
  assert.ok(isSimilarity(round));
  assert.ok(keepsOrientation(round));
  close(conicStartAngle(round), 0);
  const stretched = gradientFrame([{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}], 200, 100);
  assert.equal(isSimilarity(stretched), false);
  const mirrored = gradientFrame([{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 0}], 100, 100);
  assert.ok(isSimilarity(mirrored));
  assert.equal(keepsOrientation(mirrored), false, 'counter-clockwise sweep needs the shader');
  // A zero-height line still gets a usable frame.
  const line = gradientFrame([{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}], 100, 0);
  assert.ok(Number.isFinite(line.matrix[1][1]) && line.matrix[1][1] !== 0);
});

test('gradient parameters: radial distance, diamond |u|+|v|, angular clockwise from +u', () => {
  close(gradientParameter('GRADIENT_RADIAL', 0.6, 0.8), 1);
  close(gradientParameter('GRADIENT_DIAMOND', -0.25, 0.5), 0.75);
  close(gradientParameter('GRADIENT_ANGULAR', 1, 0), 0);
  close(gradientParameter('GRADIENT_ANGULAR', 0, 1), 0.25);
  close(gradientParameter('GRADIENT_ANGULAR', 0, -1), 0.75);
});

test('stops are sorted, clamped and interpolated', () => {
  const stops = [
    {position: 1.4, color: {r: 0, g: 0, b: 1, a: 1}},
    {position: -0.2, color: {r: 1, g: 0, b: 0, a: 1}},
    {position: 0.5, color: {r: 0, g: 1, b: 0, a: 0}},
  ];
  assert.deepEqual(normalizedStops(stops).map(s => s.position), [0, 0.5, 1]);
  const mid = colorAt(stops, 0.25);
  close(mid.r, 0.5); close(mid.g, 0.5); close(mid.a, 0.5);
  assert.deepEqual(colorAt(stops, 2), stops[0].color);
});
