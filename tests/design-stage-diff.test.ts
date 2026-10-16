import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDocument, createNode} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {STAGE_ORDER, assertStageEqual, runRustStage, runTsStage, stageDiff} from './helpers/stage-diff';
import {createInstance} from '../shared/design/components';
import {bindVariable, createVariable, createVariableCollection} from '../shared/design/variables';
import {defaultAutoLayout} from '../shared/design/defaults';
import type {GridLayout} from '../shared/design/types';
import {fuzzDocument, fuzzEdit} from './helpers/design-fuzz';

// The stage oracle itself (tests/helpers/stage-diff.ts): equal stages pass, a stage Rust does not have is an error, every
// ported stage (L2b's and L2c's) and the whole Rust orchestrator equal the TypeScript, and a Rust stage that writes
// something else is caught with the node and field.

/** A frame (no auto layout) whose child asks to fill it: step 0 turns that into FIXED. */
function fillOutsideAutoLayout(): DesignDocument {
  const doc = createDocument('page', 'Page');
  const put = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!].children!.push(node.id);
  };
  put(createNode('FRAME', {id: 'f', parentId: 'page', width: 300, height: 200}));
  put(createNode('RECTANGLE', {id: 'r', parentId: 'f', width: 40, height: 40, layoutSizingHorizontal: 'FILL'}));
  return doc;
}

test('equal stages pass', () => {
  const doc = fillOutsideAutoLayout();
  const diff = assertStageEqual('noop', doc, new Set(['f', 'r']));
  assert.deepEqual(diff.rust, {reported: [], written: [], nodes: {}, modes: {}});
});

test('a stage Rust does not know is an error, not a pass', () => {
  assert.throws(() => runRustStage('nonesuch', fillOutsideAutoLayout(), new Set(['f'])), /stage 'nonesuch'/);
});

test('every ported stage, alone and as the whole orchestrator, equals the TypeScript (L2b and L2c merged)', () => {
  let compared = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const doc = fuzzDocument(seed, {nodes: 120});
    const edited = fuzzEdit(doc, seed);
    const cases: [DesignDocument, Set<string>][] = [
      [doc, new Set(Object.keys(doc.nodes))],
      [edited.doc, new Set(Object.keys(edited.patch.nodes ?? {}))],
    ];
    for (const [subject, dirty] of cases) {
      if (!dirty.size) continue;
      for (const stage of [...STAGE_ORDER, 'normalize'] as const) {
        const diff = stageDiff(stage, subject, dirty);
        assert.equal(diff.path, null, `seed ${seed}: ${diff.message}`);
        compared++;
      }
    }
    // L2b's names are aliases of the same steps.
    assert.equal(stageDiff('auto-layout', doc, new Set(Object.keys(doc.nodes))).path, null);
  }
  assert.ok(compared >= 6 * 7, `${compared} stage runs compared`);
});

test('variable modes written are compared too, and strings well-formed', () => {
  const doc = fillOutsideAutoLayout();
  const ts = runTsStage('sizing', doc, new Set(['f']));
  assert.deepEqual(ts.modes, {});
  const modes = stageDiff('sizing', doc, new Set(['f']), {rust: () => ({...ts, modes: {f: {c1: 'm2'}}})});
  assert.equal(modes.path, '.modes.f');
  const named = {...ts, nodes: {r: {...ts.nodes.r!, name: 'a\ud83d'}}};
  const replaced = {...ts, nodes: {r: {...ts.nodes.r!, name: 'a\ufffd'}}};
  assert.equal(stageDiff('sizing', doc, new Set(['f']), {rust: () => named}).path, '.nodes.r.name');
  assert.equal(stageDiff('sizing', {...doc, nodes: {...doc.nodes, r: {...doc.nodes.r, name: 'a\ud83d'}}}, new Set(['f']), {rust: () => replaced}).path, null);
});

test('a Rust stage that writes differently is caught at the node and field', () => {
  const doc = fillOutsideAutoLayout();
  const ts = runTsStage('sizing', doc, new Set(['f']));
  assert.equal(ts.nodes.r?.layoutSizingHorizontal, 'FIXED');
  // A wrong port: writes the node with another value.
  const wrong = stageDiff('sizing', doc, new Set(['f']), {rust: () => ({...ts, nodes: {r: {...ts.nodes.r!, layoutSizingHorizontal: 'HUG'}}})});
  assert.equal(wrong.path, '.nodes.r.layoutSizingHorizontal');
  assert.match(wrong.message, /"HUG"/);
  // A port that writes nothing.
  const missing = stageDiff('sizing', doc, new Set(['f']), {rust: (_, d, dirty) => runRustStage('noop', d, dirty)});
  assert.equal(missing.path, '.nodes.r');
  // The same writes reported in another order are equal unless the order is asked for.
  const reordered = {...ts, written: [...ts.written].reverse(), reported: [...ts.reported].reverse()};
  assert.equal(stageDiff('sizing', doc, new Set(['f']), {rust: () => reordered}).path, null);
});

// Lane N1 step 12: the grid's granular overrides and the bound gaps go through the Rust stages as the TypeScript does.
const GRID: GridLayout = {rowCount: 2, columnCount: 2, rowGap: 4, columnGap: 6, rowSizes: [{type: 'HUG'}, {type: 'FLEX'}], columnSizes: [{type: 'FIXED', value: 80}, {type: 'FLEX', value: 2}], autoTracks: 'NONE', itemsPositioning: 'ROW_AUTO_FLOW'};

function gridComponentWithInstance(): DesignDocument {
  let doc = createDocument('page', 'Page');
  const put = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!].children!.push(node.id);
  };
  put(createNode('COMPONENT', {id: 'main', parentId: 'page', width: 200, height: 120, autoLayout: defaultAutoLayout('GRID'), grid: GRID}));
  put(createNode('RECTANGLE', {id: 'a', parentId: 'main', width: 30, height: 20, gridChild: {horizontalAlign: 'CENTER'}}));
  put(createNode('RECTANGLE', {id: 'b', parentId: 'main', width: 30, height: 20, layoutSizingHorizontal: 'FILL', gridChild: {columnSpan: 2}}));
  doc = createInstance(doc, 'main', {parentId: 'page', newId: 'copy', x: 300, y: 0}).doc;
  return doc;
}

test('a copy keeps its own grid.rowGap and its child its cell while the main changes the columns, on both sides', () => {
  const doc = gridComponentWithInstance();
  // The copy overrides one part of the grid and its child's placement.
  const copyChild = doc.nodes.copy.children!.find(id => doc.nodes[id].name === doc.nodes.a.name)!;
  const overridden: DesignDocument = {...doc, nodes: {...doc.nodes,
    copy: {...doc.nodes.copy, grid: {...GRID, rowGap: 20}, overrides: ['grid.rowGap']},
    [copyChild]: {...doc.nodes[copyChild], gridChild: {horizontalAlign: 'MAX', rowSpan: 2}, overrides: ['gridChild']},
    main: {...doc.nodes.main, grid: {...GRID, columnCount: 3, columnGap: 10}},
  }};
  for (const stage of ['instances', 'normalize'] as const) {
    const diff = stageDiff(stage, overridden, new Set(['main']));
    assert.equal(diff.path, null, `${stage}: ${diff.message}`);
  }
  const ts = runTsStage('instances', overridden, new Set(['main']));
  assert.ok(ts.written.includes('copy'), 'the copy follows the main');
  assert.deepEqual(ts.nodes.copy!.grid, {...GRID, columnCount: 3, columnGap: 10, rowGap: 20}, 'the main\'s columns, the copy\'s own row gap');
  assert.deepEqual(ts.nodes[copyChild]?.gridChild ?? overridden.nodes[copyChild].gridChild, {horizontalAlign: 'MAX', rowSpan: 2}, 'the child keeps its cell');
});

test('a variable bound to a grid gap writes it on both sides', () => {
  let doc = gridComponentWithInstance();
  doc = createVariableCollection(doc, {id: 'col', name: 'Spacing'}).doc;
  doc = createVariable(doc, {id: 'gap', name: 'Step', collectionId: 'col', type: 'FLOAT', value: 24}).doc;
  doc = bindVariable(doc, 'main', 'gridRowGap', 'gap').doc;
  doc = bindVariable(doc, 'main', 'gridColumnGap', 'gap').doc;
  assert.deepEqual(doc.nodes.main.boundVariables, {gridRowGap: {type: 'VARIABLE_ALIAS', id: 'gap'}, gridColumnGap: {type: 'VARIABLE_ALIAS', id: 'gap'}});
  assert.equal(doc.nodes.main.grid!.rowGap, 24, 'binding applies the value at once');
  // The variable's table changes behind the pass's back (an undo restores it): the dirty variable id brings the bound
  // frame up to date, on both sides.
  const raw: DesignDocument = {...doc, variables: {...doc.variables, gap: {...doc.variables.gap, valuesByMode: {...doc.variables.gap.valuesByMode, 'col:1': 30}}}};
  for (const stage of ['variables', 'normalize'] as const) {
    const diff = stageDiff(stage, raw, new Set(['gap']));
    assert.equal(diff.path, null, `${stage}: ${diff.message}`);
  }
  const ts = runTsStage('variables', raw, new Set(['gap']));
  assert.equal(ts.nodes.main!.grid!.rowGap, 30);
  assert.equal(ts.nodes.main!.grid!.columnGap, 30);
});
