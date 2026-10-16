import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from '../shared/design/defaults';
import {createVariable, createVariableCollection, setVariableValue} from '../shared/design/variables';
import type {DesignDocument} from '../shared/design/types';
import {chain, clickSelect, duplicateMode, duplicateVariables, moveItems, moveToGroup, renameGroup, reorderMode, reorderVariables, tableRows} from '../src/design/panels/left/variables-table';

function themed(): DesignDocument {
  let n = 0;
  return chain(createDocument('page'),
    d => createVariableCollection(d, {id: 'c', name: 'Theme', modes: [{modeId: 'light', name: 'Light'}, {modeId: 'dark', name: 'Dark'}]}),
    d => createVariable(d, {id: 'bg', name: 'Colors/Background', collectionId: 'c', type: 'FLOAT'}),
    d => createVariable(d, {id: 'fg', name: 'Colors/Text', collectionId: 'c', type: 'FLOAT'}),
    d => createVariable(d, {id: 'gap', name: 'Padding', collectionId: 'c', type: 'FLOAT'}),
    d => createVariable(d, {id: 'r', name: 'Sizes/Radii/Small', collectionId: 'c', type: 'FLOAT'}),
    d => setVariableValue(d, 'bg', 'dark', 7),
    d => (n++, {doc: d, changed: new Set()}),
  ).doc;
}

test('moveItems keeps the moved items in their order and places them before the target', () => {
  assert.deepEqual(moveItems(['a', 'b', 'c', 'd'], ['d', 'a'], 'c'), ['b', 'a', 'd', 'c']);
  assert.deepEqual(moveItems(['a', 'b', 'c'], ['a'], null), ['b', 'c', 'a']);
  assert.deepEqual(moveItems(['a', 'b', 'c'], ['a', 'b'], 'b'), ['a', 'b', 'c'], 'onto itself: stays');
});

test('a mode is reordered and duplicated with its values, right after itself', () => {
  const doc = themed();
  assert.deepEqual(reorderMode(doc, 'c', 'dark', 'light').doc.variableCollections.c.modes.map(mode => mode.modeId), ['dark', 'light']);
  const copy = duplicateMode(doc, 'c', 'light', 'copy').doc;
  assert.deepEqual(copy.variableCollections.c.modes.map(mode => [mode.modeId, mode.name]), [['light', 'Light'], ['copy', 'Light copy'], ['dark', 'Dark']]);
  const darkCopy = duplicateMode(doc, 'c', 'dark', 'dc').doc;
  assert.equal(darkCopy.variables.bg.valuesByMode.dc, 7);
});

test('variables are reordered, duplicated after themselves, moved into a group and their group renamed', () => {
  const doc = themed();
  assert.deepEqual(reorderVariables(doc, 'c', ['gap'], 'bg').doc.variableCollections.c.variableIds, ['gap', 'bg', 'fg', 'r']);
  let k = 0;
  const dup = duplicateVariables(doc, ['bg'], () => 'bg' + ++k);
  assert.deepEqual(dup.doc.variableCollections.c.variableIds, ['bg', 'bg1', 'fg', 'gap', 'r']);
  assert.equal(dup.doc.variables.bg1.name, 'Colors/Background copy');
  assert.equal(dup.doc.variables.bg1.valuesByMode.dark, 7);
  assert.equal(moveToGroup(doc, ['gap'], 'Sizes').doc.variables.gap.name, 'Sizes/Padding');
  const renamed = renameGroup(doc, 'c', 'Sizes', 'Metrics').doc;
  assert.equal(renamed.variables.r.name, 'Metrics/Radii/Small');
});

test('rows: ungrouped first, a head per group level with its parents, folded groups and a search', () => {
  const doc = themed();
  const collection = doc.variableCollections.c;
  const label = (rows: ReturnType<typeof tableRows>) => rows.map(row => row.kind === 'group' ? `# ${row.parents ? row.parents + ' / ' : ''}${row.name}` : row.variable.id);
  assert.deepEqual(label(tableRows(doc, collection)), ['gap', '# Colors', 'bg', 'fg', '# Sizes', '# Sizes / Radii', 'r']);
  assert.deepEqual(label(tableRows(doc, collection, new Set(['Sizes']))), ['gap', '# Colors', 'bg', 'fg', '# Sizes']);
  assert.deepEqual(label(tableRows(doc, collection, new Set(), 'text')), ['# Colors', 'fg']);
});

test('a click selects one row, ⌘ toggles, ⇧ takes the range from the anchor', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(clickSelect(order, ['a'], 'a', 'c', {toggle: false, range: false}), ['c']);
  assert.deepEqual(clickSelect(order, ['a'], 'a', 'c', {toggle: true, range: false}), ['a', 'c']);
  assert.deepEqual(clickSelect(order, ['a'], 'a', 'c', {toggle: false, range: true}), ['a', 'b', 'c']);
});
