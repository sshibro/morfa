import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {quickAddFrame} from '../src/design/engine/commands/edit';
import {createDesignStore} from '../src/design/engine/store';

// The frame tool's «+» beside a frame (help.figma.com «Frames in Figma Design»): a copy on that side, the frames beyond it
// in its row moved over.

const measurer: TextMeasurer = {width: () => 0, metrics: () => ({ascent: 0, descent: 0})};

function setup() {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'f1', x: 0, y: 0, width: 200, height: 400}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'inside', width: 20, height: 20}), 'f1');
  tx.create(createNode('FRAME', {id: 'f2', x: 260, y: 0, width: 200, height: 400}), 'page');
  tx.create(createNode('FRAME', {id: 'below', x: 300, y: 1000, width: 200, height: 400}), 'page');
  return createDesignStore({doc: tx.commit({measurer}).doc, measurer});
}

test('should put a copy to the right at the gap to the next frame and move that frame over', () => {
  const store = setup();
  const copy = quickAddFrame(store, 'f1', 'right')!;
  const doc = store.getState().doc;
  assert.equal(doc.nodes[copy].x, 260);
  assert.equal(doc.nodes[copy].children?.length, 1, 'with its layers');
  assert.equal(doc.nodes.f2.x, 520);
  assert.equal(doc.nodes.below.x, 300, 'another row stays');
  assert.deepEqual(store.getState().selection, [copy]);
});

test('should put a copy to the left at the usual gap when nothing stands there', () => {
  const store = setup();
  const copy = quickAddFrame(store, 'f1', 'left')!;
  assert.equal(store.getState().doc.nodes[copy].x, -300);
});
