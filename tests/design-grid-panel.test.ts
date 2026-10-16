import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {gridAlignUpdates, gridChildIds} from '../src/design/engine/commands/align';
import {newGrid, withCounts} from '../src/design/panels/design/layout/GridLayoutRows';

// The grid auto layout panel's pure half (Figma's grid flow; the model is lane N1's): the grid a frame gets when it
// switches to the grid flow, the counts the picker sets, and a child's alignment in its cells.

const measurer: TextMeasurer = {width: () => 0, metrics: () => ({ascent: 0, descent: 0})};

function doc(children: number) {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'f', width: 400, height: 300}), 'page');
  for (let k = 0; k < children; k++) tx.create(createNode('RECTANGLE', {id: 'r' + k, width: 40, height: 40}), 'f');
  return tx.commit({measurer}).doc;
}

test('should give a frame switching to the grid an about square grid for its children, rows following them', () => {
  const d = doc(5);
  const grid = newGrid(d, d.nodes.f);
  assert.deepEqual([grid.columnCount, grid.rowCount, grid.autoTracks, grid.itemsPositioning], [3, 2, 'ROWS', 'ROW_AUTO_FLOW']);
  assert.deepEqual(grid.columnSizes, [{type: 'FLEX', value: 1}, {type: 'FLEX', value: 1}, {type: 'FLEX', value: 1}], 'a set width: the columns share it');
  const four = doc(4);
  assert.deepEqual(newGrid(four, {...four.nodes.f, layoutSizingHorizontal: 'HUG'}).columnSizes.map(size => size.type), ['HUG', 'HUG'], 'a hugged width takes no shares');
});

test('should set the counts the picker gives, fitting the size lists, and rows "Auto"', () => {
  const d = doc(4);
  const grid = {...newGrid(d, d.nodes.f), columnSizes: [{type: 'FIXED' as const, value: 120}, {type: 'FLEX' as const, value: 2}]};
  const wider = withCounts(grid, 3, 4);
  assert.deepEqual([wider.rowCount, wider.columnCount, wider.autoTracks], [3, 4, 'NONE']);
  assert.deepEqual(wider.columnSizes, [{type: 'FIXED', value: 120}, {type: 'FLEX', value: 2}, {type: 'FLEX', value: 2}, {type: 'FLEX', value: 2}], 'new columns copy the last');
  assert.equal(withCounts(wider, 'auto', 1).autoTracks, 'ROWS');
  assert.equal(withCounts(wider, 2, 1).columnSizes.length, 1);
});

test('should align a grid child in its cells through its gridChild', () => {
  const d = doc(2);
  const tx = beginTransaction(d);
  tx.update('f', {autoLayout: {...d.nodes.f.autoLayout!, layoutMode: 'GRID'}});
  const grid = tx.commit({measurer}).doc;
  assert.deepEqual(gridChildIds(grid, ['r0', 'r1']), ['r0', 'r1']);
  assert.equal(gridChildIds(grid, ['r0', 'f']), null, 'not every one is a grid child');
  assert.deepEqual(Object.fromEntries(gridAlignUpdates(grid, ['r0'], 'right')), {r0: {gridChild: {horizontalAlign: 'MAX'}}});
});
