import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FLATTEN_REASONS, toVector} from '../shared/design/flatten';
import {nodeGeometry} from '../shared/design/shapes';
import {pathsBounds, transformPaths} from '../shared/design/paths';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {apply, multiply, scaling, worldMatrix} from '../shared/design/geometry';
import type {DesignDocument, GradientPaint, SceneNode} from '../shared/design/types';

const near = (actual: number, expected: number, eps = 1e-6, label = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≉ ${expected} (±${eps})`);

function documentWith(nodes: SceneNode[]): DesignDocument {
  const doc = createDocument('page');
  for (const node of nodes) {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  }
  return doc;
}

/** Page-space bounds of what a node's own geometry draws. */
const worldBounds = (doc: DesignDocument, id: string, paths = nodeGeometry(doc.nodes[id])) => pathsBounds(transformPaths(paths, worldMatrix(doc, id)))!;

test('one shape keeps its rotation and draws the same', () => {
  const doc = documentWith([
    createNode('FRAME', {id: 'f', parentId: 'page', x: 100, y: 50, width: 400, height: 400}),
    createNode('RECTANGLE', {id: 'r', parentId: 'f', name: 'Button', x: 20, y: 30, width: 120, height: 40, rotation: 20, cornerRadius: 8}),
  ]);
  const result = toVector(doc, ['r']);
  assert.ok('node' in result);
  const {node, parentId, index, remove} = result;
  assert.equal(node.type, 'VECTOR');
  assert.equal(node.name, 'Button');
  assert.equal(node.rotation, 20);
  assert.equal(parentId, 'f');
  assert.equal(index, 0);
  assert.deepEqual(remove, ['r']);
  near(node.width, 120); near(node.height, 40);
  const after = {...doc, nodes: {...doc.nodes, [node.id]: node}};
  const a = worldBounds(doc, 'r'), b = worldBounds(after, node.id, node.vectorPaths!);
  near(a.x, b.x); near(a.y, b.y); near(a.width, b.width); near(a.height, b.height);
});

test('several shapes from different groups become one vector in the top one’s parent', () => {
  const doc = documentWith([
    createNode('RECTANGLE', {id: 'bottom', parentId: 'page', x: 0, y: 0, width: 50, height: 50, fills: [solid({r: 1, g: 0, b: 0})]}),
    createNode('GROUP', {id: 'g', parentId: 'page', x: 100, y: 100, width: 40, height: 40}),
    createNode('ELLIPSE', {id: 'top', parentId: 'g', x: 0, y: 0, width: 40, height: 40, fills: [solid({r: 0, g: 0, b: 1})]}),
    createNode('LINE', {id: 'line', parentId: 'page', x: 0, y: 200, width: 30}),
    createNode('TEXT', {id: 'text', parentId: 'page'}),
  ]);
  const result = toVector(doc, ['top', 'bottom', 'text']);
  assert.ok('node' in result);
  assert.equal(result.parentId, 'g');
  assert.equal(result.node.name, 'Vector');
  assert.equal(result.node.rotation, 0);
  assert.deepEqual(result.skipped, [{id: 'text', reason: FLATTEN_REASONS.text}]);
  assert.deepEqual(result.remove.sort(), ['bottom', 'top']);
  assert.equal(result.node.vectorPaths!.length, 2);
  // Look from the top layer.
  assert.deepEqual((result.node.fills[0] as {color: unknown}).color, {r: 0, g: 0, b: 1});
  const after = {...doc, nodes: {...doc.nodes, [result.node.id]: result.node}};
  const b = worldBounds(after, result.node.id, result.node.vectorPaths!);
  near(b.x, 0); near(b.y, 0); near(b.width, 140); near(b.height, 140);
});

test('groups and booleans flatten through; only text is an error', () => {
  const doc = documentWith([
    createNode('GROUP', {id: 'g', parentId: 'page', width: 30, height: 10}),
    createNode('RECTANGLE', {id: 'a', parentId: 'g', width: 10, height: 10}),
    createNode('BOOLEAN_OPERATION', {id: 'b', parentId: 'g', x: 20, width: 10, height: 10, booleanOperation: 'UNION'}),
    createNode('ELLIPSE', {id: 'e', parentId: 'b', width: 10, height: 10}),
    createNode('TEXT', {id: 't', parentId: 'page'}),
    createNode('RECTANGLE', {id: 'hidden', parentId: 'page', visible: false}),
  ]);
  const grouped = toVector(doc, ['g', 'a']);
  assert.ok('node' in grouped);
  assert.deepEqual(grouped.remove, ['g']);
  assert.equal(grouped.node.vectorPaths!.length, 2);
  near(grouped.node.width, 30, 1e-9);
  const onlyText = toVector(doc, ['t']);
  assert.ok('error' in onlyText);
  assert.equal(onlyText.error, FLATTEN_REASONS.empty);
  assert.deepEqual(onlyText.skipped, [{id: 't', reason: FLATTEN_REASONS.text}]);
  const hidden = toVector(doc, ['hidden']);
  assert.ok('error' in hidden);
  assert.ok('error' in toVector(doc, ['page']));
  assert.ok('error' in toVector(doc, ['nope']));
});

test('the vector takes the top layer’s place and keeps its gradient where it was', () => {
  const gradient: GradientPaint = {
    type: 'GRADIENT_LINEAR', opacity: 1, visible: true, blendMode: 'NORMAL',
    gradientStops: [{position: 0, color: {r: 0, g: 0, b: 0, a: 1}}, {position: 1, color: {r: 1, g: 1, b: 1, a: 1}}],
    gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}],
  };
  const doc = documentWith([
    createNode('RECTANGLE', {id: 'one', parentId: 'page'}),
    createNode('RECTANGLE', {id: 'two', parentId: 'page', x: 0, y: 0, width: 100, height: 20}),
    createNode('RECTANGLE', {id: 'three', parentId: 'page'}),
    createNode('ELLIPSE', {id: 'four', parentId: 'page', x: 50, y: 0, width: 100, height: 100, fills: [gradient]}),
  ]);
  const result = toVector(doc, ['four', 'two']);
  assert.ok('node' in result);
  // Children left after removal: one, three → the vector goes above "three", where "four" was.
  assert.equal(result.index, 2);
  const after = {...doc, nodes: {...doc.nodes, [result.node.id]: result.node}};
  const unitToPage = (id: string, d: DesignDocument) => multiply(worldMatrix(d, id), scaling(d.nodes[id].width, d.nodes[id].height));
  const before = (doc.nodes.four.fills[0] as GradientPaint).gradientHandlePositions.map(p => apply(unitToPage('four', doc), p));
  const moved = (result.node.fills[0] as GradientPaint).gradientHandlePositions.map(p => apply(unitToPage(result.node.id, after), p));
  before.forEach((p, k) => { near(p.x, moved[k].x, 1e-6); near(p.y, moved[k].y, 1e-6); });
});
