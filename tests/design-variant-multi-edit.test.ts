import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {variantMultiEdit} from '../src/design/engine/variant-multi-edit';

// Figma's Multi-edit variants (Q): the same layer in every variant of the set.

const measurer: TextMeasurer = {width: () => 0, metrics: () => ({ascent: 0, descent: 0})};

function doc() {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('COMPONENT_SET', {id: 'set', name: 'Button', width: 300, height: 100}), 'page');
  for (const variant of ['v1', 'v2', 'v3']) {
    tx.create(createNode('COMPONENT', {id: variant, name: 'Type=' + variant, width: 80, height: 40}), 'set');
    tx.create(createNode('FRAME', {id: variant + 'box', name: 'Content'}), variant);
    if (variant !== 'v3') tx.create(createNode('RECTANGLE', {id: variant + 'icon', name: 'Icon'}), variant + 'box');
  }
  tx.create(createNode('RECTANGLE', {id: 'outside', name: 'Icon'}), 'page');
  return tx.commit({measurer}).doc;
}

test('should take a layer inside a variant to the same layer in every variant that has it', () => {
  assert.deepEqual(variantMultiEdit(doc(), ['v1icon']), ['v1icon', 'v2icon']);
});

test('should take a variant or the set to every variant', () => {
  assert.deepEqual(variantMultiEdit(doc(), ['v2']), ['v1', 'v2', 'v3']);
  assert.deepEqual(variantMultiEdit(doc(), ['set']), ['v1', 'v2', 'v3']);
});

test('should do nothing outside a component set or when everything is already selected', () => {
  assert.equal(variantMultiEdit(doc(), ['outside']), null);
  assert.equal(variantMultiEdit(doc(), ['v1', 'v2', 'v3']), null);
});
