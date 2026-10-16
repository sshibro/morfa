import assert from 'node:assert/strict';
import {test} from 'node:test';
import {keepShown, NO_SELECTION, selectAll, selectFile, selectOnly} from '../src/design/files/selection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

test('should select only the clicked file when a plain click lands on it', () => {
  assert.deepEqual(selectFile({ids: ['a', 'b'], anchor: 'a', focus: 'b'}, 'd', 'only', ORDER), {ids: ['d'], anchor: 'd', focus: 'd'});
});

test('should add and then remove a file when it is clicked with the command key twice', () => {
  const added = selectFile(selectOnly('a'), 'c', 'toggle', ORDER);
  assert.deepEqual(added.ids, ['a', 'c']);
  assert.deepEqual(selectFile(added, 'c', 'toggle', ORDER).ids, ['a']);
});

test('should select the run from the anchor when a file is clicked with shift', () => {
  assert.deepEqual(selectFile(selectOnly('b'), 'd', 'range', ORDER).ids, ['b', 'c', 'd']);
  assert.deepEqual(selectFile(selectOnly('d'), 'a', 'range', ORDER).ids, ['a', 'b', 'c', 'd']);
});

test('should keep the anchor when shift-clicks change the run', () => {
  const first = selectFile(selectOnly('b'), 'e', 'range', ORDER);
  assert.deepEqual(selectFile(first, 'c', 'range', ORDER), {ids: ['b', 'c'], anchor: 'b', focus: 'c'});
});

test('should start the run at the clicked file when nothing was selected before', () => {
  assert.deepEqual(selectFile(NO_SELECTION, 'c', 'range', ORDER).ids, ['c']);
});

test('should select every shown file when all are asked for', () => {
  assert.deepEqual(selectAll(ORDER).ids, ORDER);
  assert.equal(selectAll([]), NO_SELECTION);
});

test('should drop the files that are no longer shown', () => {
  assert.deepEqual(keepShown({ids: ['a', 'c'], anchor: 'c', focus: 'c'}, ['a', 'b']), {ids: ['a'], anchor: null, focus: null});
  assert.equal(keepShown({ids: ['c'], anchor: 'c', focus: 'c'}, ['a']), NO_SELECTION);
});
