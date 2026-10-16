import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';
import {documentFromParts, type CheckpointSource} from '../src/design/editor/open-checkpoint';

// A decoded checkpoint crosses to the store part by part, in slices sized to a time budget.
// A fake source stands for MorfaDoc (part_json / tables_json): every slot one node, in the document's key order.

function documentOf(layers: number): DesignDocument {
  const doc = createDocument('page');
  const children: string[] = [];
  for (let i = 0; i < layers; i++) {
    const id = `n${i}`;
    doc.nodes[id] = createNode('RECTANGLE', {id, parentId: 'page', name: `Layer ${i}`, x: i, y: i % 7});
    children.push(id);
  }
  doc.nodes.page = {...doc.nodes.page, children};
  return doc;
}

/** part_json / tables_json over `doc`; each slot costs `perSlotMs` of the fake clock. */
function fakeSource(doc: DesignDocument, clock: {t: number}, perSlotMs: number): CheckpointSource & {calls: number[]} {
  const ids = Object.keys(doc.nodes);
  const {nodes: _nodes, ...head} = doc;
  const calls: number[] = [];
  return {
    calls,
    part_slots: () => ids.length,
    part_json(start, count) {
      calls.push(Math.min(count, ids.length - start));
      const part: Record<string, unknown> = {};
      for (const id of ids.slice(start, start + count)) part[id] = doc.nodes[id];
      clock.t += perSlotMs * Object.keys(part).length;
      return JSON.stringify({nodes: part});
    },
    font_specs: () => '[]',
    tables_json: () => JSON.stringify(head),
  };
}

test('the document from parts equals the document, field for field and in key order', async () => {
  const doc = documentOf(5_000);
  const clock = {t: 0};
  const {doc: read, stats} = await documentFromParts(fakeSource(doc, clock, 0.004), {now: () => clock.t, yieldNow: async () => {}});
  assert.deepEqual(read, doc);
  assert.deepEqual(Object.keys(read.nodes), Object.keys(doc.nodes));
  assert.equal(stats.nodes, 5_001);
});

test('each slice keeps to its budget: parts shrink on a slow machine and grow on a fast one, and the loader yields between slices', async () => {
  const doc = documentOf(20_000);
  for (const [perSlotMs, label] of [[0.06, 'slow'], [0.002, 'fast']] as const) {
    const clock = {t: 0};
    const source = fakeSource(doc, clock, perSlotMs);
    const slices: number[] = [];
    let sliceStart = 0;
    const {stats} = await documentFromParts(source, {
      budgetMs: 8,
      now: () => clock.t,
      yieldNow: async () => {
        slices.push(clock.t - sliceStart);
        sliceStart = clock.t;
      },
    });
    assert.equal(stats.nodes, 20_001, label);
    // After the first slice (its size is a guess), no slice runs past twice the budget.
    assert.ok(slices.slice(1).every(ms => ms <= 16), `${label}: slices ${slices.slice(0, 8).map(ms => ms.toFixed(1)).join(', ')}`);
    if (label === 'slow') assert.ok(Math.max(...source.calls.slice(2)) <= 100, 'a slow machine reads small parts');
    else assert.ok(Math.max(...source.calls) >= 1_000, 'a fast machine reads big parts');
  }
});

test('an aborted open stops between slices', async () => {
  const doc = documentOf(3_000);
  const clock = {t: 0};
  const controller = new AbortController();
  await assert.rejects(
    documentFromParts(fakeSource(doc, clock, 0.05), {now: () => clock.t, signal: controller.signal, yieldNow: async () => controller.abort(new Error('closed'))}),
    /closed/,
  );
});

// The real decoder (crates/wasm, lane W): bytes → MorfaDoc.decode_from → this loader's slices equals W's oracle and the
// document's own JSON, on every golden fixture.
test('from real checkpoint bytes: the loader’s document equals documentOf and to_json, on every fixture', async () => {
  const {engineWasm} = await import('../shared/design/engine-switch');
  const {documentOf} = await import('../shared/design/parts');
  const {FIXTURES} = await import('../scripts/goldens/fixtures');
  const Doc = engineWasm().MorfaDoc;
  for (const fixture of FIXTURES) {
    const json = new Doc(JSON.stringify(fixture.build()));
    const bytes = json.encode();
    const whole = JSON.parse(json.to_json());
    json.free();
    const handle = Doc.decode_from(bytes);
    try {
      const {doc} = await documentFromParts(handle as unknown as CheckpointSource, {budgetMs: 0.01, min: 3, yieldNow: async () => {}});
      assert.deepEqual(doc, documentOf(handle), `${fixture.name}: equals lane W's documentOf`);
      assert.deepEqual(doc, whole, `${fixture.name}: equals the document's JSON`);
    } finally {
      handle.free();
    }
  }
});
