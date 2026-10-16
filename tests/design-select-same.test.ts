import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, Paint, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {canSelectSame, selectSame} from '../src/design/engine/select-same';

// "Select all with same" (Figma's Edit ▸ Select all with same …): fill, stroke, effects, text properties, font, main component.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const solid = (r: number): Paint => ({type: 'SOLID', color: {r, g: 0, b: 0, a: 1}, opacity: 1, visible: true, blendMode: 'NORMAL'}) as Paint;

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

const doc = build(add => {
  add('RECTANGLE', 'red1', 'page', {fills: [solid(1)]});
  add('RECTANGLE', 'red2', 'page', {fills: [solid(1)], strokes: [solid(0)], strokeWeight: 2});
  add('ELLIPSE', 'blue', 'page', {fills: [solid(0.2)], strokes: [solid(0)], strokeWeight: 2});
  add('FRAME', 'frame', 'page', {fills: []});
  add('RECTANGLE', 'inner', 'frame', {fills: [solid(1)]});
  add('RECTANGLE', 'hidden', 'page', {fills: [solid(1)], visible: false});
  add('COMPONENT', 'main', 'page', {fills: []});
  add('INSTANCE', 'i1', 'page', {componentId: 'main', fills: []});
  add('INSTANCE', 'i2', 'frame', {componentId: 'main', fills: []});
});

test('should select every visible layer of the page with the same fill, nested ones included', () => {
  assert.deepEqual(selectSame(doc, 'page', ['red1'], 'fill').sort(), ['inner', 'red1', 'red2']);
});

test('should match the stroke with its weight', () => {
  assert.deepEqual(selectSame(doc, 'page', ['red2'], 'stroke').sort(), ['blue', 'red2']);
});

test('should select the instances of the same main', () => {
  assert.deepEqual(selectSame(doc, 'page', ['i1'], 'instance').sort(), ['i1', 'i2']);
});

test('should leave the selection and disable the command when there is nothing to match', () => {
  assert.equal(canSelectSame(doc, ['frame'], 'fill'), false);
  assert.deepEqual(selectSame(doc, 'page', ['frame'], 'fill'), ['frame']);
  assert.equal(canSelectSame(doc, ['red1'], 'font'), false);
});
