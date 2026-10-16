import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {colorBehind, contrastCategory, contrastRatio, formatRatio, nearestCompliant} from '../src/design/panels/design/paint/contrast';

// The colour picker's contrast check, as Figma's: the WCAG ratio against the colour behind the layer, the category from
// the layer's text, and the nearest colour that passes.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const BLACK = {r: 0, g: 0, b: 0}, WHITE = {r: 1, g: 1, b: 1};

test('should give 21 for black on white and 1 for a colour on itself', () => {
  assert.equal(Math.round(contrastRatio(BLACK, WHITE) * 100) / 100, 21);
  assert.equal(contrastRatio(WHITE, WHITE), 1);
  assert.equal(formatRatio(4.56), '4.5 : 1');
});

test('should read the colour behind from the nearest filled parent, else the page', () => {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'card', fills: [solid({r: 0.1, g: 0.2, b: 0.3})]}), 'page');
  tx.create(createNode('GROUP', {id: 'group'}), 'card');
  tx.create(createNode('RECTANGLE', {id: 'inner'}), 'group');
  tx.create(createNode('RECTANGLE', {id: 'loose'}), 'page');
  const doc = tx.commit({measurer}).doc;

  assert.deepEqual(colorBehind(doc, 'inner'), {r: 0.1, g: 0.2, b: 0.3});
  assert.deepEqual(colorBehind(doc, 'loose'), {r: 245 / 255, g: 245 / 255, b: 245 / 255});
});

test('should judge text by its size and weight, and other layers as graphics', () => {
  const text = (fontSize: number, fontWeight = 400) => ({...createNode('TEXT', {id: 't'}), text: {...defaultTextProps('Hello'), style: {...defaultTextProps('Hello').style, fontSize, fontWeight}}});
  assert.equal(contrastCategory(text(16)), 'normal-text');
  assert.equal(contrastCategory(text(24)), 'large-text');
  assert.equal(contrastCategory(text(19, 700)), 'large-text');
  assert.equal(contrastCategory(createNode('RECTANGLE', {id: 'r'})), 'graphics');
});

test('should find the nearest passing colour by brightness when a colour fails', () => {
  const grey = {r: 0.6, g: 0.6, b: 0.6};
  assert.ok(contrastRatio(grey, WHITE) < 4.5);

  const fixed = nearestCompliant(grey, WHITE, 4.5)!;

  assert.ok(contrastRatio(fixed, WHITE) >= 4.5);
  assert.ok(fixed.r < grey.r, 'darker on white');
  assert.deepEqual(nearestCompliant(BLACK, WHITE, 4.5), BLACK, 'a passing colour stays');
});
