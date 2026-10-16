import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {alignToParentsUpdates, alignUpdates} from '../src/design/engine/commands/align';

// ⇧ with an alignment button aligns each layer to its own parent frame (help.figma.com «Edit objects on the canvas in bulk»).

const measurer: TextMeasurer = {width: () => 0, metrics: () => ({ascent: 0, descent: 0})};

function doc() {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'f1', x: 0, y: 0, width: 200, height: 100}), 'page');
  tx.create(createNode('FRAME', {id: 'f2', x: 300, y: 0, width: 200, height: 100}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'a', x: 10, y: 10, width: 20, height: 20}), 'f1');
  tx.create(createNode('RECTANGLE', {id: 'b', x: 50, y: 30, width: 40, height: 20}), 'f2');
  tx.create(createNode('RECTANGLE', {id: 'loose', x: 600, y: 0, width: 20, height: 20}), 'page');
  return tx.commit({measurer}).doc;
}

test('should align each selected layer to the right edge of its own frame', () => {
  const updates = alignToParentsUpdates(doc(), ['a', 'b', 'loose'], 'right');
  assert.deepEqual(Object.fromEntries(updates), {a: {x: 180}, b: {x: 160}}, 'a layer on the page stays');
});

test('should keep the plain alignment against the selection bounds', () => {
  const updates = alignUpdates(doc(), ['a', 'b'], 'left');
  assert.deepEqual(updates.get('b'), {x: -290}, 'b moves to the left edge of both, in its own frame’s space');
});
