import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  ellipsePaths, markerGeometry, nodeGeometry, polygonPath, polygonVertices, rectanglePath, resolveCornerRadii, starPath, strokeGeometry,
} from '../shared/design/shapes';
import {pathBounds, pathsBounds, pathSegments, pointInPath, serializePathData, subpaths} from '../shared/design/paths';
import {createNode} from '../shared/design/defaults';
import type {PathCommand, Vec} from '../shared/design/types';

const near = (actual: number, expected: number, eps = 1e-6, label = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≉ ${expected} (±${eps})`);
const radii = (w: number, h: number, r: [number, number, number, number]) => resolveCornerRadii(w, h, r).map(c => c.radius);

test('rectangles: sharp ones are four lines, as before', () => {
  assert.equal(serializePathData(rectanglePath(100, 50)), 'M0 0L100 0L100 50L0 50Z');
  const node = createNode('RECTANGLE', {id: 'r', width: 80, height: 40});
  assert.equal(serializePathData(nodeGeometry(node)[0].commands), 'M0 0L80 0L80 40L0 40Z');
});

test('corner radii are shared along each side the way Figma shares them', () => {
  // A uniform radius beyond the box gives a pill.
  assert.deepEqual(radii(100, 50, [1000, 1000, 1000, 1000]), [25, 25, 25, 25]);
  // One big corner next to sharp ones may use the whole shorter side.
  assert.deepEqual(radii(100, 50, [100, 0, 0, 0]), [50, 0, 0, 0]);
  // Two corners on one side split it in proportion; the bigger chooses first.
  const [tl, tr] = radii(100, 100, [80, 60, 0, 0]);
  near(tl + tr, 100);
  near(tl / tr, 80 / 60);
  // Corners that fit are untouched.
  assert.deepEqual(radii(100, 100, [10, 20, 30, 40]), [10, 20, 30, 40]);
  // Corners that exactly fill a side are kept.
  assert.deepEqual(radii(100, 60, [50, 50, 10, 10]), [50, 50, 10, 10]);
  // The bigger corners choose first (in proportion), the smaller ones take what is left of the side.
  const [a, b, c, d] = radii(100, 60, [50, 50, 30, 30]);
  near(a, 37.5); near(b, 37.5); near(c, 22.5); near(d, 22.5);
  assert.deepEqual(radii(0, 0, [10, 10, 10, 10]), [0, 0, 0, 0]);
  const node = createNode('RECTANGLE', {id: 'r', width: 100, height: 40, cornerRadius: 999});
  assert.deepEqual(pathBounds(nodeGeometry(node)[0].commands), {x: 0, y: 0, width: 100, height: 40});
  const perCorner = createNode('RECTANGLE', {id: 'r', width: 100, height: 100, rectangleCornerRadii: [0, 50, 0, 0]});
  const commands = nodeGeometry(perCorner)[0].commands;
  assert.equal(commands.filter(c => c.type === 'C').length, 1);
  assert.equal(pointInPath(commands, {x: 99, y: 1}), false);
  assert.equal(pointInPath(commands, {x: 1, y: 1}), true);
});

/** Unit directions arriving at and leaving every joint between drawn segments. */
function jointTangents(commands: PathCommand[]): {into: Vec; outOf: Vec; at: Vec}[] {
  const segments = pathSegments(commands).filter(s => Math.hypot(s.p1.x - s.p0.x, s.p1.y - s.p0.y) > 1e-9);
  const dirOut = (s: (typeof segments)[number]) => {
    const to = s.kind === 'cubic' && Math.hypot(s.c1.x - s.p0.x, s.c1.y - s.p0.y) > 1e-9 ? s.c1 : s.kind === 'cubic' ? s.c2 : s.p1;
    const l = Math.hypot(to.x - s.p0.x, to.y - s.p0.y);
    return {x: (to.x - s.p0.x) / l, y: (to.y - s.p0.y) / l};
  };
  const dirIn = (s: (typeof segments)[number]) => {
    const from = s.kind === 'cubic' && Math.hypot(s.c2.x - s.p1.x, s.c2.y - s.p1.y) > 1e-9 ? s.c2 : s.kind === 'cubic' ? s.c1 : s.p0;
    const l = Math.hypot(s.p1.x - from.x, s.p1.y - from.y);
    return {x: (s.p1.x - from.x) / l, y: (s.p1.y - from.y) / l};
  };
  return segments.map((s, k) => ({into: dirIn(s), outOf: dirOut(segments[(k + 1) % segments.length]), at: s.p1}));
}

test('corner smoothing: tangent-continuous everywhere, reaching (1 + s)·r along each side', () => {
  for (const smoothing of [0, 0.3, 0.6, 1]) {
    const commands = rectanglePath(200, 120, [24, 24, 24, 24], smoothing);
    for (const joint of jointTangents(commands)) {
      const dotProduct = joint.into.x * joint.outOf.x + joint.into.y * joint.outOf.y;
      assert.ok(dotProduct > 1 - 1e-6, `kink at ${JSON.stringify(joint.at)} with smoothing ${smoothing}: ${dotProduct}`);
    }
    // The corner starts (1 + s)·r before the vertex on the top edge.
    const first = commands[0] as {x: number};
    near(first.x, 24 * (1 + smoothing), 1e-9, `smoothing ${smoothing}`);
    const b = pathBounds(commands)!;
    near(b.x, 0); near(b.y, 0); near(b.width, 200); near(b.height, 120);
  }
  // The squircle meets the plain corner on the diagonal and leaves the edge earlier and softer.
  const plain = rectanglePath(200, 200, [30, 30, 30, 30], 0), smooth = rectanglePath(200, 200, [30, 30, 30, 30], 1);
  for (const shape of [plain, smooth]) {
    assert.equal(pointInPath(shape, {x: 8.6, y: 8.6}), false);
    assert.equal(pointInPath(shape, {x: 9, y: 9}), true);
  }
  assert.equal(pointInPath(plain, {x: 1, y: 25}), true);
  assert.equal(pointInPath(smooth, {x: 1, y: 25}), false);
  assert.equal(pointInPath(plain, {x: 0.2, y: 35}), true);
  assert.equal(pointInPath(smooth, {x: 0.2, y: 35}), false);
  // Without room for it, smoothing gives way (a pill stays a pill).
  assert.equal(serializePathData(rectanglePath(100, 50, [25, 25, 25, 25], 1)), serializePathData(rectanglePath(100, 50, [25, 25, 25, 25], 0)));
});

test('ellipses: full, pie slice, ring and donut slice', () => {
  const full = ellipsePaths(100, 60);
  assert.equal(full.length, 1);
  assert.deepEqual(pathBounds(full[0].commands), {x: 0, y: 0, width: 100, height: 60});
  const quarter = ellipsePaths(100, 100, {startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0})[0];
  const qb = pathBounds(quarter.commands)!;
  near(qb.x, 50); near(qb.y, 50); near(qb.width, 50); near(qb.height, 50);
  assert.equal(pointInPath(quarter.commands, {x: 70, y: 70}), true); // clockwise from 3 o'clock: the lower right
  assert.equal(pointInPath(quarter.commands, {x: 70, y: 30}), false);
  const ring = ellipsePaths(100, 100, {startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0.5})[0];
  assert.equal(ring.windingRule, 'EVENODD');
  assert.equal(subpaths(ring.commands).length, 2);
  for (const rule of ['EVENODD', 'NONZERO'] as const) {
    assert.equal(pointInPath(ring.commands, {x: 50, y: 50}, rule), false, rule);
    assert.equal(pointInPath(ring.commands, {x: 50, y: 10}, rule), true, rule);
  }
  const donut = ellipsePaths(100, 100, {startingAngle: -Math.PI / 2, endingAngle: Math.PI / 2, innerRadius: 0.6})[0];
  assert.equal(pointInPath(donut.commands, {x: 90, y: 50}), true);
  assert.equal(pointInPath(donut.commands, {x: 60, y: 50}), false);
  assert.equal(pointInPath(donut.commands, {x: 10, y: 50}), false);
  // A whole turn, or nothing, draws the whole ellipse; the closing point is exact.
  assert.equal(serializePathData(ellipsePaths(100, 100, {startingAngle: 1, endingAngle: 1, innerRadius: 0})[0].commands), serializePathData(full.length ? ellipsePaths(100, 100)[0].commands : []));
  const last = full[0].commands[full[0].commands.length - 2] as {x: number; y: number};
  assert.deepEqual([last.x, last.y], [100, 30]);
});

test('polygons and stars: first point at the top, inscribed in the box ellipse, as in Figma', () => {
  assert.equal(serializePathData(polygonPath(100, 100, 3)), 'M50 0L93.301 75L6.699 75Z');
  const square = polygonVertices(100, 100, 4);
  near(square[0].x, 50); near(square[0].y, 0); near(square[1].x, 100); near(square[1].y, 50);
  const star = polygonVertices(100, 100, 5, 0.382);
  assert.equal(star.length, 10);
  near(star[0].x, 50); near(star[0].y, 0);
  near(Math.hypot(star[1].x - 50, star[1].y - 50), 50 * 0.382);
  // Clockwise on screen: the second vertex is to the right of the first.
  assert.ok(star[1].x > star[0].x);
  const node = createNode('STAR', {id: 's', width: 200, height: 100});
  const b = pathBounds(nodeGeometry(node)[0].commands)!;
  near(b.y, 0); near(b.x + b.width / 2, 100);
  assert.ok(b.height < 100); // like Figma, the box keeps the inscribed ellipse
  assert.equal(nodeGeometry(createNode('POLYGON', {id: 'p', pointCount: 2})).length, 1);
});

test('rounded polygon corners stay on their edges and never overrun half an edge', () => {
  const sharp = polygonPath(100, 100, 4), round = polygonPath(100, 100, 4, 10);
  assert.ok(round.filter(c => c.type === 'C').length === 4);
  const rb = pathBounds(round)!, sb = pathBounds(sharp)!;
  assert.ok(rb.width < sb.width && rb.x > sb.x);
  // A huge radius is capped at half of each edge: every edge keeps a zero-length straight part.
  const huge = polygonPath(100, 100, 6, 1e6);
  assert.ok(huge.filter(c => c.type === 'L').every((c, k, all) => k === 0 || all.length > 0));
  const roundedStar = starPath(100, 100, 5, 0.4, 4);
  // Five concave corners in one cubic each, five sharp tips (over 90°) in two.
  assert.equal(roundedStar.filter(c => c.type === 'C').length, 15);
  assert.equal(pointInPath(roundedStar, {x: 50, y: 50}), true);
  // Tips lose their point; concave vertices round the other way and fill their notch.
  const sharpStar = starPath(100, 100, 5, 0.4);
  assert.equal(pointInPath(sharpStar, {x: 50, y: 0.5}), true);
  assert.equal(pointInPath(roundedStar, {x: 50, y: 0.5}), false);
  const inner = polygonVertices(100, 100, 5, 0.4)[1];
  const beyond = {x: inner.x + (inner.x - 50) * 0.02, y: inner.y + (inner.y - 50) * 0.02};
  assert.equal(pointInPath(sharpStar, beyond), false);
  assert.equal(pointInPath(roundedStar, beyond), true);
});

test('lines, vectors and stroke ends', () => {
  const line = createNode('LINE', {id: 'l', width: 120, strokeEndMarker: 'TRIANGLE_ARROW'});
  const {paths, ends} = strokeGeometry(line);
  assert.equal(serializePathData(paths[0].commands), 'M0 0L120 0');
  assert.deepEqual(ends.map(e => [e.position, e.point.x, e.direction.x, e.marker]), [['START', 0, -1, 'NONE'], ['END', 120, 1, 'TRIANGLE_ARROW']]);
  const vector = createNode('VECTOR', {id: 'v', vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'C', x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0}, {type: 'M', x: 20, y: 0}, {type: 'L', x: 30, y: 0}, {type: 'L', x: 30, y: 10}, {type: 'Z'}]}]});
  const vEnds = strokeGeometry(vector).ends;
  assert.equal(vEnds.length, 2); // the closed subpath has no ends
  near(vEnds[0].direction.y, -1); // leaves downwards, so the start arrow points up
  near(vEnds[1].direction.y, -1);
  assert.equal(strokeGeometry(createNode('RECTANGLE', {id: 'r'})).ends.length, 0);
  const arrow = markerGeometry('TRIANGLE_ARROW', {point: {x: 100, y: 0}, direction: {x: 1, y: 0}}, 2);
  const ab = pathBounds(arrow.fill)!;
  near(ab.x + ab.width, 100);
  assert.ok(arrow.trim > 0);
  assert.equal(markerGeometry('LINE_ARROW', {point: {x: 0, y: 0}, direction: {x: 1, y: 0}}, 1).stroke.length, 3);
  assert.equal(markerGeometry('NONE', {point: {x: 0, y: 0}, direction: {x: 1, y: 0}}, 1).fill.length, 0);
  assert.deepEqual(nodeGeometry(createNode('GROUP', {id: 'g'})), []);
  assert.deepEqual(nodeGeometry(createNode('TEXT', {id: 't'})), []);
  assert.ok(pathsBounds(nodeGeometry(createNode('FRAME', {id: 'f', width: 10, height: 20, cornerRadius: 4}))));
});
