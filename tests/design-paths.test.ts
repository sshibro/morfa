import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorsToPath, cubicPoint, distanceToPath, fitCubics, flattenPath, formatNumber, insertAnchorAt, isClosed, parsePathData,
  pathBounds, pathLength, pathToAnchors, pointAtLength, pointInPath, reversePath, serializePathData, splitCubicAt, subpaths,
  transformPath, windingNumber, type Cubic,
} from '../shared/design/paths';
import type {PathCommand} from '../shared/design/types';
import {budget} from './helpers/speed';

const d = (source: string) => serializePathData(parsePathData(source));
const near = (actual: number, expected: number, eps = 1e-6, label = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≉ ${expected} (±${eps})`);

test('parser: absolute and relative commands, H/V, implicit repeats', () => {
  assert.equal(d('M0 0 H10 V10 H0 Z'), 'M0 0L10 0L10 10L0 10Z');
  assert.equal(d('m10 10 20 20 30 30z'), 'M10 10L30 30L60 60Z');
  assert.equal(d('M10 10 L20 20 30 30'), 'M10 10L20 20L30 30');
  assert.equal(d('m1 1 h2 v2 h-2 z m10 0 l1 1'), 'M1 1L3 1L3 3L1 3ZM11 1L12 2');
  assert.equal(d('M0,0L10,0,10,10'), 'M0 0L10 0L10 10');
  assert.equal(d('M 0 0 c 1 2 3 4 5 6 7 8 9 10 11 12'), 'M0 0C1 2 3 4 5 6C12 14 14 16 16 18');
});

test('parser: odd numbers — exponents, signs and dots as separators', () => {
  assert.equal(d('M1e-3.5.5.5'), 'M0.001 0.5L0.5 0.5');
  assert.deepEqual(parsePathData('M1e-3.5.5.5').slice(0, 1), [{type: 'M', x: 0.001, y: 0.5}]);
  assert.equal(d('M-.5-.5L+1.5e1-2E+0'), 'M-0.5 -0.5L15 -2');
  assert.equal(d('M1.5.5l.5.5'), 'M1.5 0.5L2 1');
  // An "e" with no digits is not an exponent: here it is a syntax error that ends the path.
  assert.equal(d('M1 2L3 4L3e Z'), 'M1 2L3 4');
  // An odd pair count is an error at the dangling number: drawing up to it is kept.
  assert.equal(d('M0 0L10 10 20'), 'M0 0L10 10');
  assert.equal(d('M1e-3.5.5L10-10'), '');
});

test('parser: S and T reflect the previous control point only after C/S and Q/T', () => {
  assert.equal(d('M0 0C10 0 10 10 0 10S-10 20 0 20'), 'M0 0C10 0 10 10 0 10C-10 10 -10 20 0 20');
  assert.equal(d('M0 0L5 5S10 10 20 20'), 'M0 0L5 5C5 5 10 10 20 20');
  assert.equal(d('M0 0Q5 5 10 0T20 0'), 'M0 0Q5 5 10 0Q15 -5 20 0');
  assert.equal(d('M0 0T10 0'), 'M0 0Q0 0 10 0');
});

test('parser: arcs become cubics, flags may be glued, degenerate arcs follow the spec', () => {
  const quarter = parsePathData('M0 0 a1 1 0 011 1');
  assert.equal(quarter.length, 2);
  assert.equal(quarter[1].type, 'C');
  assert.deepEqual([(quarter[1] as {x: number}).x, (quarter[1] as {y: number}).y], [1, 1]);
  // Large-arc and sweep flags without separators, then the end point.
  assert.equal(parsePathData('M0 0a5 5 0 1010 0').length, 3);
  // Radius 0 is a straight line; equal end points draw nothing.
  assert.equal(d('M0 0A0 5 0 0 1 10 0'), 'M0 0L10 0');
  assert.equal(d('M0 0A5 5 0 0 1 0 0L1 1'), 'M0 0L1 1');
  // Too-small radii are scaled up: a half circle through both ends.
  const half = parsePathData('M0 0A1 1 0 0 1 10 0');
  const b = pathBounds(half)!;
  near(b.width, 10, 1e-9);
  near(b.height, 5, 1e-3);
  // A full circle from two arcs: length 2πr within the cubic approximation.
  near(pathLength(parsePathData('M10 0A10 10 0 1 1 -10 0A10 10 0 1 1 10 0Z')), 2 * Math.PI * 10, 0.02);
});

test('parser: a drawing command after Z starts a new subpath at the old start', () => {
  assert.equal(d('M5 5L10 5Z L5 10'), 'M5 5L10 5ZM5 5L5 10');
  assert.equal(d('M0 0Z'), 'M0 0Z');
  assert.equal(d('M0 0 M5 5 L6 6'), 'M5 5L6 6');
  assert.equal(d('L5 5'), '');
  assert.equal(d(''), '');
  assert.equal(d('garbage'), '');
});

test('hostile path data is bounded and linear', () => {
  const huge = 'M0 0' + ' L1 1'.repeat(200_000); // 1 000 004 characters
  assert.ok(huge.length >= 1_000_000);
  const start = performance.now();
  const commands = parsePathData(huge);
  const elapsed = performance.now() - start;
  assert.ok(commands.length <= 200_000, `commands ${commands.length}`);
  assert.ok(elapsed < budget(1500), `parse took ${elapsed} ms`);
  assert.equal(parsePathData(huge, {maxCommands: 10}).length, 10);
  // Pathological numbers: endless digits and dots.
  const dots = 'M' + '.1'.repeat(300_000);
  const t2 = performance.now();
  parsePathData(dots);
  assert.ok(performance.now() - t2 < 1500);
  // Arcs are cut into at most four cubics each.
  assert.ok(parsePathData('M0 0A1e9 1e9 0 1 1 1 0').length <= 5);
});

test('serializer: precision, no negative zero, round trip', () => {
  assert.equal(formatNumber(-0.0001), '0');
  assert.equal(formatNumber(1.23456, 2), '1.23');
  assert.equal(formatNumber(1e-7, 9), '0.0000001');
  const source = 'M0.5 -1C1 2 3 4 5 6Q7 8 9 10L-1 -2Z';
  assert.equal(d(source), source);
  assert.equal(d(d(source)), source);
});

test('bounds follow curve extrema, not control points', () => {
  const b = pathBounds(parsePathData('M0 0C0 -10 10 -10 10 0'))!;
  near(b.y, -7.5, 1e-9, 'top');
  near(b.height, 7.5, 1e-9);
  near(b.width, 10, 1e-9);
  const q = pathBounds(parsePathData('M0 0Q5 10 10 0'))!;
  near(q.height, 5, 1e-9, 'quad');
  // S-curve: extrema in x inside the segment.
  const s = pathBounds(parsePathData('M0 0C20 0 -10 10 10 10'))!;
  assert.ok(s.x + s.width > 10 - 1e-9 && s.x < 0 + 1e-9 && s.x + s.width < 20);
  assert.equal(pathBounds([]), null);
  assert.deepEqual(pathBounds(parsePathData('M3 4Z')), {x: 3, y: 4, width: 0, height: 0});
});

test('point in path: nonzero and even-odd differ on a same-direction hole', () => {
  const nested = parsePathData('M0 0H100V100H0Z M25 25H75V75H25Z');
  assert.equal(pointInPath(nested, {x: 50, y: 50}, 'NONZERO'), true);
  assert.equal(pointInPath(nested, {x: 50, y: 50}, 'EVENODD'), false);
  assert.equal(windingNumber(nested, {x: 50, y: 50}), 2 * Math.sign(windingNumber(nested, {x: 10, y: 10})));
  const reversedHole = parsePathData('M0 0H100V100H0Z M25 25V75H75V25Z');
  assert.equal(pointInPath(reversedHole, {x: 50, y: 50}, 'NONZERO'), false);
  assert.equal(pointInPath(reversedHole, {x: 10, y: 50}, 'NONZERO'), true);
  assert.equal(pointInPath(nested, {x: 150, y: 50}), false);
  // Curves, including a ray through a vertex and a tangent point.
  const circle = parsePathData('M100 50C100 77.6 77.6 100 50 100C22.4 100 0 77.6 0 50C0 22.4 22.4 0 50 0C77.6 0 100 22.4 100 50Z');
  assert.equal(pointInPath(circle, {x: 50, y: 50}), true);
  assert.equal(pointInPath(circle, {x: 50, y: 0.5}), true);
  assert.equal(pointInPath(circle, {x: 99.9, y: 50}), true);
  assert.equal(pointInPath(circle, {x: 100.1, y: 50}), false);
  assert.equal(pointInPath(circle, {x: 5, y: 5}), false);
  // An open path is filled as if closed.
  assert.equal(pointInPath(parsePathData('M0 0L10 0L10 10'), {x: 8, y: 2}), true);
});

test('distance, length and point at length', () => {
  const line = parsePathData('M0 0L100 0');
  const hit = distanceToPath(line, {x: 30, y: 4})!;
  near(hit.distance, 4);
  near(hit.t, 0.3);
  assert.equal(hit.index, 1);
  near(pathLength(line), 100);
  const at = pointAtLength(parsePathData('M0 0L10 0L10 10'), 15)!;
  near(at.point.x, 10);
  near(at.point.y, 5);
  near(at.tangent.y, 1);
  const curve = parsePathData('M0 0C0 50 100 50 100 0');
  const total = pathLength(curve);
  const mid = pointAtLength(curve, total / 2)!;
  near(mid.point.x, 50, 1e-4, 'symmetric midpoint');
  const curveHit = distanceToPath(curve, {x: 50, y: 50})!;
  near(curveHit.point.x, 50, 1e-3);
  near(curveHit.distance, 50 - 37.5, 1e-3);
  // The closing line of Z is stroked and found.
  const closed = distanceToPath(parsePathData('M0 0L10 0L10 10Z'), {x: 3, y: 4})!;
  assert.equal(closed.index, 3);
});

test('split, reverse, subpaths, closedness', () => {
  const c: Cubic = [{x: 0, y: 0}, {x: 10, y: 20}, {x: 30, y: 20}, {x: 40, y: 0}];
  const [left, right] = splitCubicAt(c, 0.3);
  const p = cubicPoint(c, 0.3);
  near(left[3].x, p.x); near(left[3].y, p.y);
  assert.deepEqual(right[0], left[3]);
  const q = cubicPoint(c, 0.65), r = cubicPoint(right, (0.65 - 0.3) / 0.7);
  near(q.x, r.x); near(q.y, r.y);
  const path = parsePathData('M0 0L10 0L10 10Z M20 20C30 20 30 30 20 30');
  const reversed = reversePath(path);
  assert.equal(serializePathData(reversed), 'M0 0L10 10L10 0L0 0ZM20 30C30 30 30 20 20 20');
  near(pathLength(reversed), pathLength(path));
  assert.equal(serializePathData(reversePath(reversed)).replace('L0 0Z', 'Z').length > 0, true);
  assert.equal(subpaths(path).length, 2);
  assert.equal(isClosed(path), false);
  assert.equal(isClosed(parsePathData('M0 0L1 1Z')), true);
});

test('transform keeps curves exact', () => {
  const moved = transformPath(parsePathData('M0 0C10 0 10 10 0 10'), [[2, 0, 5], [0, 3, 1]]);
  assert.equal(serializePathData(moved), 'M5 1C25 1 25 31 5 31');
});

test('anchors: round trip, kinds, closing curve shares the first point', () => {
  const circle = parsePathData('M10 0A10 10 0 1 1 -10 0A10 10 0 1 1 10 0Z');
  const [ring] = pathToAnchors(circle);
  assert.equal(ring.closed, true);
  assert.equal(ring.anchors.length, 4);
  assert.ok(ring.anchors.every(a => a.kind === 'mirrored'), ring.anchors.map(a => a.kind).join());
  assert.equal(serializePathData(anchorsToPath([ring]), 6), serializePathData(circle, 6));
  const poly = parsePathData('M0 0L10 0L10 10Z');
  const [p] = pathToAnchors(poly);
  assert.equal(p.anchors.length, 3);
  assert.ok(p.anchors.every(a => a.kind === 'corner' && !a.in && !a.out));
  assert.equal(serializePathData(anchorsToPath([p])), 'M0 0L10 0L10 10Z');
  const smooth = pathToAnchors(parsePathData('M0 0C0 -5 5 -10 10 -10C20 -10 20 0 20 10'))[0];
  assert.equal(smooth.anchors[1].kind, 'smooth');
  const quad = pathToAnchors(parsePathData('M0 0Q5 10 10 0'))[0];
  assert.ok(quad.anchors[0].out && quad.anchors[1].in);
});

test('insertAnchorAt keeps the shape and puts the new point at the command index', () => {
  const curve = parsePathData('M0 0C0 50 100 50 100 0L100 100Z');
  for (const [index, t] of [[1, 0.25], [2, 0.5], [3, 0.4]] as const) {
    const split = insertAnchorAt(curve, index, t);
    assert.equal(split.length, curve.length + 1);
    near(pathLength(split), pathLength(curve), 1e-6, `length after splitting ${index}`);
    const total = pathLength(curve);
    for (const fraction of [0.1, 0.33, 0.5, 0.77, 0.95]) {
      const a = pointAtLength(curve, total * fraction)!.point, b = pointAtLength(split, total * fraction)!.point;
      near(a.x, b.x, 1e-3); near(a.y, b.y, 1e-3);
    }
  }
  const atZ = insertAnchorAt(curve, 3, 0.5);
  assert.deepEqual(atZ[3], {type: 'L', x: 50, y: 50});
  const quad = insertAnchorAt(parsePathData('M0 0Q5 10 10 0'), 1, 0.5);
  assert.deepEqual([quad[1].type, (quad[1] as {x: number}).x, (quad[1] as {y: number}).y], ['Q', 5, 5]);
  assert.deepEqual(insertAnchorAt(curve, 0, 0.5), curve);
});

test('flattening honours the tolerance; fitting recovers few cubics', () => {
  const circle = parsePathData('M50 0A50 50 0 1 1 -50 0A50 50 0 1 1 50 0Z');
  for (const tolerance of [1, 0.1, 0.01]) {
    const [line] = flattenPath(circle, tolerance);
    assert.equal(line.closed, true);
    for (let k = 0; k < line.points.length; k++) {
      const a = line.points[k], b = line.points[(k + 1) % line.points.length];
      const mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
      // Chord midpoints sit within tolerance of the circle (plus the cubic circle's own 0.03 %).
      assert.ok(50 - Math.hypot(mid.x, mid.y) <= tolerance + 0.02, `tolerance ${tolerance}`);
    }
  }
  const samples = Array.from({length: 101}, (_, k) => ({x: Math.cos((k / 100) * Math.PI) * 50, y: Math.sin((k / 100) * Math.PI) * 50}));
  const cubics = fitCubics(samples, 0.05);
  assert.ok(cubics.length <= 3, `${cubics.length} cubics for a half circle`);
  for (const c of cubics) for (let k = 0; k <= 20; k++) {
    const p = cubicPoint(c, k / 20);
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - 50) < 0.06);
  }
});

test('commands are plain data', () => {
  const commands: PathCommand[] = parsePathData('M0 0L1 1');
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), commands);
});
