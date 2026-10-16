import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {createDocument, createNode} from '../shared/design/defaults';
import {EngineDiffError, assertWasmRan, engineCalls, engineWasm, resetEngineCalls, setEngine} from '../shared/design/engine-switch';
import {applyPatch, diffDocuments, invertPatch, type DocumentPatch} from '../shared/design/patch';
import {documentTarget, mergeChange} from '../shared/design/merge';
import {beginTransaction, createScratch, TransactionError} from '../shared/design/transaction';
import {applyDocumentChange} from '../server/design/apply';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {testMeasurer} from './helpers/design-big-files';
import {fuzzPatchPair} from './helpers/design-fuzz';
import {fuzzComparisons, mulberry32, randomDocument, runCase} from './helpers/ops-fuzz';

// The ops module through the engine switch (lane L2a: crates/ops via crates/wasm src/ops.rs, wired in
// shared/design/{patch,merge,transaction}.ts, server/design/apply.ts and shared/design/ops-check.ts). Needs the nodejs
// wasm build (scripts/wasm-build.sh). Each test forces its own mode, whatever MORFA_ENGINE says.

const restore: (() => void)[] = [];
const use = (mode: 'ts' | 'wasm' | 'both') => restore.push(setEngine('ops', mode));
beforeEach(() => resetEngineCalls('ops'));
afterEach(() => {
  while (restore.length) restore.pop()!();
  engineWasm().debug_fault('');
});

const CONTEXT = {measurer: testMeasurer};

function page(): DesignDocument {
  const doc = createDocument('p', 'Page');
  const put = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!].children!.push(node.id);
  };
  put(createNode('FRAME', {id: 'f', parentId: 'p', x: 10, y: 10, width: 300, height: 200}));
  for (let i = 0; i < 5; i++) put(createNode('RECTANGLE', {id: `r${i}`, parentId: 'f', x: i * 20, y: 5, width: 10, height: 10}));
  return doc;
}

/** The same edit in a mode: move two layers, rename one, remove one, add one. */
function edit(doc: DesignDocument) {
  const tx = beginTransaction(doc);
  tx.update('r0', {x: 100, y: 50});
  tx.update('r1', {name: 'Moved'});
  tx.remove('r2');
  tx.create(createNode('ELLIPSE', {id: 'e', x: 1, y: 2, width: 3, height: 4}), 'f', 1);
  tx.move('r3', 'p');
  return tx.commit(CONTEXT);
}

describe('ops through the switch', () => {
  test('wasm mode: the Rust answers, equal to the TypeScript, and the counters show it', () => {
    use('ts');
    const doc = page();
    const expected = edit(doc);
    assert.equal(engineCalls('ops').wasm, 0);
    use('wasm');
    resetEngineCalls('ops');
    const actual = edit(doc);
    assert.deepEqual(actual.patch, expected.patch);
    assert.deepEqual(actual.inverse, expected.inverse);
    assert.deepEqual([...actual.dirty], [...expected.dirty]);
    const next = applyPatch(doc, actual.patch);
    assert.deepEqual(diffDocuments(doc, next), actual.patch);
    assert.deepEqual(applyPatch(next, invertPatch(doc, actual.patch)).nodes, doc.nodes);
    const counts = assertWasmRan('ops');
    assert.equal(counts.ts, 0, 'wasm mode runs no TypeScript ops');
  });

  test('both mode: the merge fuzz finds no difference (200 patch pairs)', () => {
    use('both');
    const before = fuzzComparisons();
    for (let i = 0; i < 200; i++) runCase(mulberry32(7_000_003 + i), 7_000_003 + i);
    const counts = assertWasmRan('ops');
    assert.equal(counts.diffs, 0);
    assert.ok(fuzzComparisons() - before > 200 * 20, `comparisons: ${fuzzComparisons() - before}`);
  });

  test("both mode: S2's fuzzPatchPair merged both ways", () => {
    use('both');
    for (let seed = 1; seed <= 20; seed++) {
      const doc = randomDocument(mulberry32(seed));
      const {a, b, docA} = fuzzPatchPair(doc, seed);
      const outcome = mergeChange(documentTarget(docA), b, invertPatch(doc, b));
      applyPatch(docA, outcome.patch);
      applyDocumentChange(docA, {patch: b, before: invertPatch(doc, b).nodes});
      assert.ok(a);
    }
    // Its names are cut mid-emoji on purpose: a lone UTF-16 surrogate cannot cross into a Rust string, so those calls
    // fall back to TypeScript (counted). Everything else ran on both and agreed.
    const counts = assertWasmRan('ops', {allowFallback: true});
    assert.equal(counts.diffs, 0);
    assert.ok(counts.fallback < counts.wasm / 4, JSON.stringify(counts));
  });

  test('fake green: a wrong wasm answer fails both mode with the path', () => {
    use('both');
    const doc = page();
    const change: DocumentPatch = {nodes: {r0: {...doc.nodes.r0, x: 7}}};
    engineWasm().debug_fault('ops.mergeChange');
    assert.throws(
      () => mergeChange(documentTarget(doc), change, {nodes: {r0: doc.nodes.r0}}),
      (error: unknown) => error instanceof EngineDiffError && error.module === 'ops' && error.call === 'mergeChange' && error.path === '.adjusted',
    );
  });

  test('both mode: refusals must agree, and a drag frame on a lent scratch commits alike', () => {
    use('both');
    const doc = page();
    const tx = beginTransaction(doc);
    assert.throws(() => tx.update('missing', {x: 1}), TransactionError);
    assert.throws(() => tx.move('f', 'r0'), TransactionError);
    tx.update('r4', {x: 1});
    tx.commit(CONTEXT);
    const scratch = createScratch(doc);
    for (let k = 1; k <= 5; k++) {
      const frame = beginTransaction(doc, {scratch});
      for (const id of ['r0', 'r1', 'r3']) frame.update(id, {x: doc.nodes[id].x + k, y: doc.nodes[id].y + 2 * k});
      frame.commit(CONTEXT);
    }
    const counts = assertWasmRan('ops');
    assert.equal(counts.diffs, 0);
  });
});
