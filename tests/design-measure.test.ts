import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {measureRects, measureTarget} from '../src/design/engine/measure';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const r = (x: number, y: number, width: number, height: number) => ({x, y, width, height});
const values = (list: ReturnType<typeof measureRects>) => list.map(m => `${m.axis}:${m.value}`);

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

test('side by side: only the gap between facing edges, through what both cover', () => {
  const list = measureRects(r(0, 0, 100, 100), r(150, 50, 100, 100));
  assert.deepEqual(values(list), ['x:50']);
  const gap = list[0];
  assert.deepEqual([gap.from, gap.to], [{x: 100, y: 75}, {x: 150, y: 75}], 'at the middle of the shared band (50..100)');
  assert.deepEqual(gap.helpers, [], 'the line meets both boxes');
});

test('diagonal: both gaps, with dashed extensions of the far box', () => {
  const list = measureRects(r(0, 0, 100, 100), r(200, 300, 50, 50));
  assert.deepEqual(values(list), ['x:100', 'y:200']);
  const [horizontal, vertical] = list;
  assert.deepEqual([horizontal.from, horizontal.to], [{x: 100, y: 50}, {x: 200, y: 50}], 'through the selection’s centre');
  assert.deepEqual(horizontal.helpers, [[{x: 200, y: 50}, {x: 200, y: 300}]], 'the far box’s left edge extended up to the line');
  assert.deepEqual(vertical.helpers, [[{x: 50, y: 300}, {x: 200, y: 300}]]);
});

test('inside a frame: the four distances to its edges', () => {
  const list = measureRects(r(20, 30, 60, 40), r(0, 0, 200, 100));
  assert.deepEqual(values(list), ['x:20', 'x:120', 'y:30', 'y:30']);
  assert.deepEqual([list[0].from, list[0].to], [{x: 0, y: 50}, {x: 20, y: 50}]);
  assert.ok(list.every(m => !m.helpers.length));
});

test('crossing boxes: the offsets of their edges', () => {
  assert.deepEqual(values(measureRects(r(0, 0, 100, 100), r(50, 20, 100, 100))), ['x:50', 'x:50', 'y:20', 'y:20']);
});

test('touching or equal edges give no zero-length lines', () => {
  assert.deepEqual(values(measureRects(r(0, 0, 100, 100), r(100, 0, 100, 100))), []);
  assert.deepEqual(values(measureRects(r(0, 0, 100, 100), r(0, 0, 100, 100))), []);
});

test('what ⌥ measures to: the hovered layer, else the parent frame', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 400, height: 300});
    add('RECTANGLE', 'a', 'f', {x: 10, y: 10, width: 50, height: 50});
    add('RECTANGLE', 'b', 'f', {x: 100, y: 10, width: 50, height: 50});
    add('RECTANGLE', 'top', 'page', {x: 500, y: 0, width: 50, height: 50});
  });
  assert.deepEqual(measureTarget(doc, ['a'], 'b'), {from: r(10, 10, 50, 50), to: r(100, 10, 50, 50), targetId: 'b'});
  assert.equal(measureTarget(doc, ['a'], null)?.targetId, 'f', 'nothing hovered: the parent frame');
  assert.equal(measureTarget(doc, ['a'], 'a')?.targetId, 'f', 'hovering the selection itself');
  assert.equal(measureTarget(doc, ['top'], null), null, 'a layer on the page has no frame to measure to');
  assert.equal(measureTarget(doc, [], 'b'), null);
});
