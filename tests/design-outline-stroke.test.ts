import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dashPolylines, outlineStroke, outlineStrokeNode} from '../shared/design/outline-stroke';
import {flattenPath, pathsBounds, pointInPaths} from '../shared/design/paths';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import type {DesignDocument, SceneNode, VectorPath} from '../shared/design/types';
import {budget} from './helpers/speed';

const near = (actual: number, expected: number, eps: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≉ ${expected} (±${eps})`);

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

const line = (props: Partial<SceneNode>) => createNode('LINE', {id: 'l', width: 100, strokeWeight: 4, ...props});

test('a straight line: length × weight, plus what the caps add', () => {
  near(area(outlineStroke(line({}))), 400, 1e-9, 'butt');
  near(area(outlineStroke(line({strokeCap: 'SQUARE'}))), 416, 1e-9, 'square');
  near(area(outlineStroke(line({strokeCap: 'ROUND'}))), 400 + Math.PI * 4, 0.1, 'round');
  assert.deepEqual(pathsBounds(outlineStroke(line({}))), {x: 0, y: -2, width: 100, height: 4});
  assert.deepEqual(outlineStroke(line({strokeWeight: 0})), []);
});

test('rectangle strokes by alignment', () => {
  const rect = (strokeAlign: SceneNode['strokeAlign'], extra: Partial<SceneNode> = {}) => createNode('RECTANGLE', {id: 'r', width: 100, height: 50, strokeWeight: 10, strokeAlign, ...extra});
  near(area(outlineStroke(rect('CENTER'))), 110 * 60 - 90 * 40, 1e-9, 'center');
  near(area(outlineStroke(rect('INSIDE'))), 100 * 50 - 80 * 30, 1e-9, 'inside');
  near(area(outlineStroke(rect('OUTSIDE'))), 120 * 70 - 100 * 50, 1e-9, 'outside');
  near(area(outlineStroke(rect('OUTSIDE', {strokeJoin: 'ROUND'}))), 120 * 70 - 100 * 50 - (400 - 100 * Math.PI), 1.5, 'round joins');
  near(area(outlineStroke(rect('OUTSIDE', {strokeJoin: 'BEVEL'}))), 120 * 70 - 100 * 50 - 4 * 50, 1e-6, 'bevel joins');
  const inside = outlineStroke(rect('INSIDE'));
  assert.equal(pointInPaths(inside, {x: 50, y: 25}), false);
  assert.equal(pointInPaths(inside, {x: 5, y: 25}), true);
  assert.equal(pointInPaths(inside, {x: -2, y: 25}), false);
});

test('per-side weights', () => {
  const node = createNode('RECTANGLE', {id: 'r', width: 100, height: 50, individualStrokeWeights: {top: 4, right: 0, bottom: 2, left: 0}, strokeAlign: 'INSIDE'});
  near(area(outlineStroke(node)), 600, 1e-9);
  const centered = createNode('RECTANGLE', {id: 'r', width: 100, height: 50, individualStrokeWeights: {top: 4, right: 4, bottom: 4, left: 4}, strokeAlign: 'CENTER'});
  near(area(outlineStroke(centered)), 104 * 54 - 96 * 46, 1e-9);
});

test('curves: a circle stroke is a ring of 2πr × weight, as a few cubics', () => {
  const circle = createNode('ELLIPSE', {id: 'e', width: 100, height: 100, strokeWeight: 10, strokeAlign: 'CENTER'});
  const paths = outlineStroke(circle);
  near(area(paths), Math.PI * (55 * 55 - 45 * 45), Math.PI * 1000 * 0.002);
  assert.ok(paths[0].commands.length < 24, `${paths[0].commands.length} commands`);
  assert.equal(pointInPaths(paths, {x: 50, y: 50}), false);
  assert.equal(pointInPaths(paths, {x: 50, y: 1}), true);
  const outside = outlineStroke({...circle, strokeAlign: 'OUTSIDE'});
  near(area(outside), Math.PI * (60 * 60 - 50 * 50), Math.PI * 1100 * 0.002);
});

test('dashes, miter limit and markers', () => {
  near(area(outlineStroke(line({dashPattern: [10, 10]}))), 200, 1e-9, 'dashes');
  near(area(outlineStroke(line({dashPattern: [10]}))), 200, 1e-9, 'odd pattern repeats');
  near(area(outlineStroke(line({dashPattern: [10, 0]}))), 400, 1e-9, 'no gaps');
  // Zero-length dashes with round caps are dots.
  near(area(outlineStroke(line({dashPattern: [0, 20], strokeCap: 'ROUND'}))), 6 * Math.PI * 4, 0.5, 'dots');
  const sharp = (strokeMiterLimit: number) => createNode('VECTOR', {id: 'v', strokeWeight: 4, strokeMiterLimit, vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 50, y: 10}, {type: 'L', x: 0, y: 20}]}]});
  const mitered = area(outlineStroke(sharp(10))), beveled = area(outlineStroke(sharp(1)));
  assert.ok(mitered > beveled + 5, `${mitered} vs ${beveled}`);
  const arrow = outlineStroke(line({strokeWeight: 2, strokeEndMarker: 'TRIANGLE_ARROW'}));
  const b = pathsBounds(arrow)!;
  near(b.x + b.width, 100, 1e-9, 'tip at the end');
  assert.ok(b.height > 2);
  const chevron = outlineStroke(line({strokeWeight: 2, strokeStartMarker: 'LINE_ARROW'}));
  assert.ok(pathsBounds(chevron)!.height > 8);
  // ROUND and SQUARE markers act as caps at their end only.
  near(area(outlineStroke(line({strokeEndMarker: 'SQUARE'}))), 408, 1e-9);
  assert.deepEqual(dashPolylines([{points: [{x: 0, y: 0}, {x: 30, y: 0}], closed: false}], [10, 5]).map(l => [l.points[0].x, l.points[l.points.length - 1].x]), [[0, 10], [15, 25]]);
});

test('hostile stroke input stays bounded', () => {
  const long = line({width: 1e6, dashPattern: [0.01, 0.01]});
  const start = performance.now();
  const paths = outlineStroke(long);
  assert.ok(performance.now() - start < 2000);
  near(area(paths), 4e6, 1, 'too many dashes: drawn solid');
  const zigzag: SceneNode = createNode('VECTOR', {id: 'z', strokeWeight: 3, strokeJoin: 'ROUND', vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, ...Array.from({length: 1500}, (_, k) => ({type: 'L' as const, x: k + 1, y: k % 2 ? 0 : 10}))]}]});
  const t2 = performance.now();
  assert.ok(outlineStroke(zigzag).length === 1);
  assert.ok(performance.now() - t2 < budget(5000), `${performance.now() - t2} ms`);
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

test('"Outline stroke": a vector filled with the stroke, grouped with the fill when there is one', () => {
  const red = solid({r: 1, g: 0, b: 0});
  const doc = documentWith([
    createNode('RECTANGLE', {id: 'filled', parentId: 'page', x: 10, y: 20, width: 100, height: 50, strokes: [red], strokeWeight: 4, strokeAlign: 'CENTER', rotation: 15, opacity: 0.5}),
    createNode('ELLIPSE', {id: 'ring', parentId: 'page', x: 200, width: 40, height: 40, fills: [], strokes: [red], strokeWeight: 2}),
  ]);
  const grouped = outlineStrokeNode(doc, 'filled')!;
  assert.equal(grouped.nodes[0].type, 'GROUP');
  assert.equal(grouped.nodes.length, 3);
  const [group, fill, stroke] = grouped.nodes;
  assert.deepEqual(group.children, [fill.id, stroke.id]);
  assert.equal(fill.type, 'RECTANGLE');
  assert.deepEqual(fill.strokes, []);
  assert.equal(stroke.type, 'VECTOR');
  assert.deepEqual(stroke.fills.map(p => p.type), ['SOLID']);
  assert.deepEqual(stroke.strokes, []);
  assert.equal(group.opacity, 0.5);
  assert.equal(stroke.opacity, 1);
  assert.equal(grouped.index, 0);
  assert.deepEqual(grouped.remove, ['filled']);
  const single = outlineStrokeNode(doc, 'ring')!;
  assert.equal(single.nodes.length, 1);
  assert.equal(single.nodes[0].type, 'VECTOR');
  near(area(single.nodes[0].vectorPaths!), Math.PI * (20 * 20 - 18 * 18), 0.5); // ellipses stroke inside by default
  assert.equal(outlineStrokeNode(doc, 'page'), null);
  assert.equal(outlineStrokeNode(documentWith([createNode('TEXT', {id: 't', parentId: 'page', strokes: [red]})]), 't'), null);
});
