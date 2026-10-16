import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {createDocument, createNode, defaultAutoLayout} from '../shared/design/defaults';
import {clearEngineCrash, engineCalls, engineCrash, engineFor, engineWasm, resetEngineCalls, resetShadow, setEngine} from '../shared/design/engine-switch';
import {worldBox} from '../shared/design/geometry';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {createDesignStore} from '../src/design/engine/store';
import {testMeasurer} from './helpers/design-big-files';

// A Rust panic inside the engine (shared/design/engine-switch.ts «Rust crashes»): crates/wasm's `debug_fault('normalize.panic')`
// panics inside normalize with the shadow's indexes borrowed, as a real panic in a stage would. The edit still lands,
// answered by TypeScript, and the engine stays off for the session: before, the edit threw, the shadow refused every
// later patch, and enough refusals overwrote the module's memory. Needs the nodejs wasm build (scripts/wasm-build.sh).

const restore: (() => void)[] = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
  engineWasm().debug_fault('');
  clearEngineCrash();
  resetShadow();
  resetEngineCalls();
});

/** A hugging row holding two rectangles: a width change of one moves the other and resizes the row. */
function row(): DesignDocument {
  const doc = createDocument('page', 'Page');
  const put = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!].children!.push(node.id);
  };
  put(createNode('FRAME', {id: 'row', parentId: 'page', x: 10, y: 20, autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 8}, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'}));
  put(createNode('RECTANGLE', {id: 'a', parentId: 'row', width: 40, height: 30}));
  put(createNode('RECTANGLE', {id: 'b', parentId: 'row', width: 20, height: 30}));
  return doc;
}

/** The row's and b's boxes after `widths` (a's width per edit), with every module in TypeScript (called before a test
 *  sets its own modes). */
function expected(widths: number[]) {
  const undo = setEngine('*', 'ts');
  try {
    const store = createDesignStore({doc: row(), measurer: testMeasurer, deferShadow: false});
    for (const width of widths) store.transact('width', tx => tx.update('a', {width}));
    const doc = store.getState().doc;
    return {row: worldBox(doc, 'row'), b: worldBox(doc, 'b')};
  } finally {
    undo();
  }
}

test('a Rust panic in normalize: the edit lands in TypeScript and every module runs TypeScript after it', () => {
  const want = expected([50, 70, 90, 30, 60]);
  // The modules this test names, whatever MORFA_ENGINE says for the others.
  restore.push(setEngine('*', 'ts'), setEngine('normalize', 'wasm'), setEngine('geometry', 'wasm'));
  const store = createDesignStore({doc: row(), measurer: testMeasurer, deferShadow: false});
  store.transact('width', tx => tx.update('a', {width: 50}));
  assert.ok(engineCalls('normalize').wasm >= 1, 'the first edit was laid out in Rust');
  assert.equal(engineCrash(), null);

  engineWasm().debug_fault('normalize.panic');
  const quiet = console.error;
  console.error = () => {};
  try {
    store.transact('width', tx => tx.update('a', {width: 70}));
  } finally {
    console.error = quiet;
  }
  const crash = engineCrash();
  assert.equal(crash?.module, 'normalize');
  assert.match(crash!.message, /debug_fault normalize\.panic/, 'the panic hook kept the message');
  for (const module of ['normalize', 'geometry', 'ops', 'text', 'render', 'export'] as const) assert.equal(engineFor(module), 'ts', module);

  // The trapped module is never called again: later edits and reads are TypeScript's, and right.
  engineWasm().debug_fault('');
  const wasmCalls = engineCalls('normalize').wasm + engineCalls('geometry').wasm;
  for (const width of [90, 30, 60]) store.transact('width', tx => tx.update('a', {width}));
  const doc = store.getState().doc;
  const answer = {row: worldBox(doc, 'row'), b: worldBox(doc, 'b')};
  assert.equal(engineCalls('normalize').wasm + engineCalls('geometry').wasm, wasmCalls);
  assert.deepEqual(answer, want);
});

test('both mode: the panic fails the call, as a test must see it, and the engine stays off after it', () => {
  const want = expected([50, 70]);
  restore.push(setEngine('*', 'ts'), setEngine('normalize', 'both'));
  const store = createDesignStore({doc: row(), measurer: testMeasurer, deferShadow: false});
  store.transact('width', tx => tx.update('a', {width: 50}));
  engineWasm().debug_fault('normalize.panic');
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.throws(() => store.transact('width', tx => tx.update('a', {width: 70})), WebAssembly.RuntimeError);
  } finally {
    console.error = quiet;
  }
  assert.equal(engineCrash()?.module, 'normalize');
  assert.equal(engineFor('normalize'), 'ts');
  engineWasm().debug_fault('');
  store.transact('width', tx => tx.update('a', {width: 70}));
  assert.deepEqual(worldBox(store.getState().doc, 'row'), want.row);
});
