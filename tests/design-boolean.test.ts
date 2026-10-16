import {test} from 'node:test';
import assert from 'node:assert/strict';
import {booleanGeometry, combinePaths, flattenBoolean} from '../shared/design/boolean';
import {ellipsePaths, rectanglePath} from '../shared/design/shapes';
import {flattenPath, pathsBounds, pointInPaths, transformPath} from '../shared/design/paths';
import {createDocument, createNode} from '../shared/design/defaults';
import {multiply, worldMatrix} from '../shared/design/geometry';
import type {DesignDocument, SceneNode, VectorPath} from '../shared/design/types';
import {budget} from './helpers/speed';

const near = (actual: number, expected: number, eps: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≉ ${expected} (±${eps})`);

/** Net filled area: polygon-clipping winds holes against their outlines, so signed areas add up. */
function area(paths: readonly VectorPath[]): number {
  let total = 0;
  for (const path of paths) for (const line of flattenPath(path.commands, 0.001)) {
    let s = 0;
    const pts = line.points;
    for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) s += (pts[j].x - pts[k].x) * (pts[j].y + pts[k].y);
    total += s / 2;
  }
  return Math.abs(total);
}

const square = (x: number, y: number, size: number): VectorPath[] => [{windingRule: 'NONZERO', commands: transformPath(rectanglePath(size, size), [[1, 0, x], [0, 1, y]])}];

test('two overlapping squares: area of each operation', () => {
  const a = square(0, 0, 10), b = square(5, 5, 10);
  near(area(combinePaths('UNION', [a, b])), 175, 1e-9, 'union');
  near(area(combinePaths('SUBTRACT', [a, b])), 75, 1e-9, 'subtract');
  near(area(combinePaths('INTERSECT', [a, b])), 25, 1e-9, 'intersect');
  near(area(combinePaths('EXCLUDE', [a, b])), 150, 1e-9, 'exclude');
  // Straight input stays straight, with no superfluous points.
  const union = combinePaths('UNION', [a, b])[0].commands;
  assert.equal(union.filter(c => c.type === 'L').length, 7);
  assert.equal(union.filter(c => c.type === 'C').length, 0);
  // Order matters only for subtraction.
  near(area(combinePaths('SUBTRACT', [b, a])), 75, 1e-9);
  assert.deepEqual(combinePaths('INTERSECT', [a, square(20, 20, 5)]), []);
  assert.deepEqual(combinePaths('SUBTRACT', [a, square(-5, -5, 30)]), []);
  near(area(combinePaths('UNION', [a])), 100, 1e-9);
});

test('a circle minus a square keeps true arcs: three cubics, exact area', () => {
  const circle = ellipsePaths(100, 100);
  const result = combinePaths('SUBTRACT', [circle, square(50, 50, 60)], 0.01);
  const commands = result[0].commands;
  assert.equal(commands.filter(c => c.type === 'C').length, 3, JSON.stringify(commands));
  assert.equal(commands.filter(c => c.type === 'L').length, 2);
  const full = area(circle);
  near(area(result), full * 0.75, full * 1e-6, 'three quarters');
  const b = pathsBounds(result)!;
  near(b.x, 0, 1e-9); near(b.y, 0, 1e-9); near(b.width, 100, 1e-9); near(b.height, 100, 1e-9);
  assert.equal(pointInPaths(result, {x: 75, y: 75}), false);
  assert.equal(pointInPaths(result, {x: 25, y: 25}), true);
});

test('a circle cut by a slanted square: arcs are pieces of the original curves', () => {
  const circle = ellipsePaths(100, 100);
  const tilted: VectorPath[] = [{windingRule: 'NONZERO', commands: transformPath(rectanglePath(60, 60), multiply([[1, 0, 50], [0, 1, 20]], [[Math.cos(0.4), -Math.sin(0.4), 0], [Math.sin(0.4), Math.cos(0.4), 0]]))}];
  const result = combinePaths('INTERSECT', [circle, tilted], 0.005);
  // Every point of the result lies inside both operands.
  for (const line of flattenPath(result[0].commands, 0.01)) for (const p of line.points) {
    assert.ok(Math.hypot(p.x - 50, p.y - 50) <= 50 + 0.02, `outside the circle: ${JSON.stringify(p)}`);
  }
  const curves = result[0].commands.filter(c => c.type === 'C').length;
  assert.ok(curves >= 1 && curves <= 4, `${curves} curves`);
});

test('fill rules: rings and nested outlines', () => {
  const ring = ellipsePaths(100, 100, {startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0.5});
  near(area(combinePaths('UNION', [ring])), area(ellipsePaths(100, 100)) * 0.75, 1);
  // Same-direction nested squares: NONZERO fills the inner one, EVENODD cuts it out.
  const nested = (rule: 'NONZERO' | 'EVENODD'): VectorPath[] => [{windingRule: rule, commands: [...square(0, 0, 100)[0].commands, ...square(25, 25, 50)[0].commands]}];
  near(area(combinePaths('UNION', [nested('NONZERO')])), 10_000, 1e-6);
  near(area(combinePaths('UNION', [nested('EVENODD')])), 7_500, 1e-6);
  // Opposite direction: a hole under NONZERO too.
  const hole: VectorPath[] = [{windingRule: 'NONZERO', commands: [...square(0, 0, 100)[0].commands, {type: 'M', x: 25, y: 25}, {type: 'L', x: 25, y: 75}, {type: 'L', x: 75, y: 75}, {type: 'L', x: 75, y: 25}, {type: 'Z'}]}];
  near(area(combinePaths('UNION', [hole])), 7_500, 1e-6);
  // An open path is filled as if closed; a line has no area.
  near(area(combinePaths('UNION', [[{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 0}, {type: 'L', x: 10, y: 10}]}]])), 50, 1e-9);
  assert.deepEqual(combinePaths('UNION', [[{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 0}]}]]), []);
});

function documentWith(nodes: SceneNode[]): DesignDocument {
  const doc = createDocument('page');
  for (const node of nodes) {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  }
  return doc;
}

test('boolean nodes: children in the boolean space, nested groups and booleans, hidden children ignored', () => {
  const doc = documentWith([
    createNode('BOOLEAN_OPERATION', {id: 'b', parentId: 'page', x: 100, y: 100, width: 15, height: 15, booleanOperation: 'SUBTRACT'}),
    createNode('RECTANGLE', {id: 'r1', parentId: 'b', x: 0, y: 0, width: 10, height: 10}),
    createNode('GROUP', {id: 'g', parentId: 'b', x: 5, y: 5, width: 10, height: 10}),
    createNode('RECTANGLE', {id: 'r2', parentId: 'g', x: 0, y: 0, width: 10, height: 10}),
    createNode('RECTANGLE', {id: 'hidden', parentId: 'b', x: 0, y: 0, width: 10, height: 10, visible: false}),
    createNode('TEXT', {id: 't', parentId: 'b'}),
  ]);
  const paths = booleanGeometry(doc, 'b');
  near(area(paths), 75, 1e-9);
  // Local space of the boolean: the result starts at its origin, not the page's.
  near(pathsBounds(paths)!.x, 0, 1e-9);
  // Cached by identity: the same document gives the same array back.
  assert.equal(booleanGeometry(doc, 'b'), paths);
  // A changed grandchild is noticed although its ancestors' objects did not change.
  const moved = {...doc, nodes: {...doc.nodes, r2: {...doc.nodes.r2, x: 2}}};
  near(area(booleanGeometry(moved, 'b')), 100 - 3 * 5, 1e-9);
  // Nested boolean.
  const nested = documentWith([
    createNode('BOOLEAN_OPERATION', {id: 'outer', parentId: 'page', booleanOperation: 'UNION'}),
    createNode('BOOLEAN_OPERATION', {id: 'inner', parentId: 'outer', booleanOperation: 'INTERSECT'}),
    createNode('RECTANGLE', {id: 'a', parentId: 'inner', width: 10, height: 10}),
    createNode('RECTANGLE', {id: 'c', parentId: 'inner', x: 5, width: 10, height: 10}),
    createNode('ELLIPSE', {id: 'e', parentId: 'outer', x: 20, width: 10, height: 10}),
  ]);
  near(area(booleanGeometry(nested, 'outer')), 50 + area(ellipsePaths(10, 10)), 1e-6);
  assert.deepEqual(booleanGeometry(nested, 'a'), []);
});

test('rotated children are brought into the boolean space exactly', () => {
  const doc = documentWith([
    createNode('BOOLEAN_OPERATION', {id: 'b', parentId: 'page', booleanOperation: 'UNION'}),
    createNode('RECTANGLE', {id: 'r', parentId: 'b', x: 0, y: 0, width: 10, height: 10, rotation: 45}),
  ]);
  const paths = booleanGeometry(doc, 'b');
  near(area(paths), 100, 1e-9);
  const b = pathsBounds(paths)!;
  near(b.width, 10 * Math.SQRT2, 1e-9);
});

test('"Flatten" a boolean: a vector in its place with its look', () => {
  const doc = documentWith([
    createNode('RECTANGLE', {id: 'under', parentId: 'page'}),
    createNode('BOOLEAN_OPERATION', {id: 'b', parentId: 'page', x: 40, y: 30, width: 15, height: 15, rotation: 30, booleanOperation: 'EXCLUDE', name: 'Mark'}),
    createNode('RECTANGLE', {id: 'r1', parentId: 'b', width: 10, height: 10}),
    createNode('RECTANGLE', {id: 'r2', parentId: 'b', x: 5, y: 5, width: 10, height: 10}),
  ]);
  const outcome = flattenBoolean(doc, 'b')!;
  assert.equal(outcome.node.type, 'VECTOR');
  assert.equal(outcome.node.name, 'Mark');
  assert.deepEqual(outcome.remove, ['b']);
  assert.equal(outcome.index, 1);
  assert.equal(outcome.node.rotation, 30);
  // The vector draws exactly where the boolean drew: compare page-space points.
  const after = {...doc, nodes: {...doc.nodes, [outcome.node.id]: outcome.node}};
  const vectorWorld = worldMatrix(after, outcome.node.id), boolWorld = worldMatrix(doc, 'b');
  const vp = transformPath(outcome.node.vectorPaths![0].commands, vectorWorld);
  const bp = transformPath(booleanGeometry(doc, 'b')[0].commands, boolWorld);
  near(area([{windingRule: 'NONZERO', commands: vp}]), 150, 1e-6);
  const vb = pathsBounds([{windingRule: 'NONZERO', commands: vp}])!, bb = pathsBounds([{windingRule: 'NONZERO', commands: bp}])!;
  near(vb.x, bb.x, 1e-9); near(vb.y, bb.y, 1e-9); near(vb.width, bb.width, 1e-9);
  assert.equal(flattenBoolean(doc, 'r1'), null);
});

test('hostile operands: huge curves and broken numbers stay bounded', () => {
  // 2 000 huge circles would flatten to millions of points at the requested tolerance.
  const huge: VectorPath[] = [];
  for (let k = 0; k < 2000; k++) huge.push(...ellipsePaths(1e6, 1e6).map(p => ({windingRule: p.windingRule, commands: transformPath(p.commands, [[1, 0, k * 10], [0, 1, 0]])})));
  const start = performance.now();
  const result = combinePaths('UNION', [huge], 0.001);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < budget(8000), `${elapsed} ms`);
  assert.equal(result.length, 1);
  const broken: VectorPath[] = [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: NaN, y: 5}, {type: 'L', x: 10, y: Infinity}, {type: 'L', x: 10, y: 10}, {type: 'L', x: 0, y: 10}, {type: 'Z'}]}];
  near(area(combinePaths('UNION', [broken])), 50, 1e-9);
});

test('many operands stay quick', () => {
  const circles: VectorPath[][] = [];
  for (let k = 0; k < 150; k++) {
    const x = (k % 15) * 7, y = Math.floor(k / 15) * 7;
    circles.push(ellipsePaths(10, 10).map(p => ({windingRule: p.windingRule, commands: transformPath(p.commands, [[1, 0, x], [0, 1, y]])})));
  }
  const start = performance.now();
  const result = combinePaths('UNION', circles, 0.01);
  const elapsed = performance.now() - start;
  assert.ok(result.length === 1);
  assert.ok(elapsed < budget(4000), `${elapsed} ms`);
});
