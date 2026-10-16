import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {renameOrder, renameAll} from '../src/design/panels/left/batch-rename';

// "Rename layers" for several layers (Figma's Rename layers, help.figma.com 360039958934): a name for all, numbers up
// or down, the current name kept as a part, and "Find" with a regular expression.

const names = ['Icon', 'Icon', 'Icon'];

test('should give every layer the same name when no token is used', () => {
  assert.deepEqual(renameAll(names, {find: '', replace: 'Button', start: 1}), ['Button', 'Button', 'Button']);
});

test('should number up from the start and down to it, padded to the digits asked', () => {
  assert.deepEqual(renameAll(names, {find: '', replace: 'Icon $n', start: 1}), ['Icon 1', 'Icon 2', 'Icon 3']);
  assert.deepEqual(renameAll(names, {find: '', replace: 'Icon $NNN', start: 0}), ['Icon 002', 'Icon 001', 'Icon 000']);
});

test('should keep the current name where $& stands, as a prefix rule', () => {
  assert.deepEqual(renameAll(['Home', 'Search'], {find: '', replace: 'Icon/$&', start: 1}), ['Icon/Home', 'Icon/Search']);
});

test('should replace only what "Find" matches, with groups, and take a broken expression as plain text', () => {
  assert.deepEqual(renameAll(['Icon_003', 'Icon_014'], {find: '([a-zA-Z]+)_(\\d+)', replace: '$2_$1', start: 1}), ['003_Icon', '014_Icon']);
  assert.deepEqual(renameAll(['Card (old)', 'Card (old) 2'], {find: '(old)', replace: 'new', start: 1}), ['Card (new)', 'Card (new) 2'],
    'a valid group matches "old"; the parentheses stay');
  assert.deepEqual(renameAll(['a[1', 'b[1'], {find: '[1', replace: '-2', start: 1}), ['a-2', 'b-2'], 'not an expression: the text itself');
});

test('should keep a name that would come out empty', () => {
  assert.deepEqual(renameAll(['Layer'], {find: 'Layer', replace: '', start: 1}), ['Layer']);
});

test('should order layers as the panel lists them: the top layer first, a parent before its children', () => {
  const measurer: TextMeasurer = {width: () => 0, metrics: () => ({ascent: 0, descent: 0})};
  const tx = beginTransaction(createDocument('page'));
  for (const id of ['a', 'b', 'c']) tx.create(createNode('RECTANGLE', {id, name: id}), 'page');
  tx.create(createNode('FRAME', {id: 'f', name: 'f'}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'f1', name: 'f1'}), 'f');
  const doc = tx.commit({measurer}).doc;
  assert.deepEqual(renameOrder(doc, ['a', 'f1', 'c', 'f', 'b']), ['f', 'f1', 'c', 'b', 'a']);
});
