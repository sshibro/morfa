import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {stripFrames, viewportBetweenBars} from '../src/design/editor/phone/frame-strip-model';
import {pageToScreen} from '../src/design/engine/viewport';

// The phone's frame strip (src/design/editor/phone/frame-strip-model.ts).

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function page() {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'a', name: 'Login', x: 0, y: 0, width: 390, height: 844}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'r', x: 500, y: 0, width: 10, height: 10}), 'page');
  tx.create(createNode('SECTION', {id: 's', x: 1000, y: 0, width: 1000, height: 1000}), 'page');
  tx.create(createNode('FRAME', {id: 'b', name: 'Feed', x: 1100, y: 50, width: 390, height: 844}), 's');
  tx.create(createNode('FRAME', {id: 'h', name: 'Hidden', x: 0, y: 2000, width: 10, height: 10, visible: false}), 'page');
  return tx.commit({measurer}).doc;
}

test('should list the page\'s top-level frames and those in sections when the strip opens', () => {
  assert.deepEqual(stripFrames(page(), 'page'), [{id: 'a', name: 'Login'}, {id: 'b', name: 'Feed'}]);
});

test('should show a frame whole between the bars when it is tapped in the strip', () => {
  const size = {width: 390, height: 844}, top = 64, bottom = 140;
  const viewport = viewportBetweenBars(size, {x: 0, y: 0, width: 390, height: 844}, top, bottom);

  const topLeft = pageToScreen(viewport, {x: 0, y: 0});
  const bottomRight = pageToScreen(viewport, {x: 390, y: 844});
  assert.ok(topLeft.y >= top - 1e-6, `top ${topLeft.y}`);
  assert.ok(bottomRight.y <= size.height - bottom + 1e-6, `bottom ${bottomRight.y}`);
  assert.ok(topLeft.x >= 0 && bottomRight.x <= size.width);
});
