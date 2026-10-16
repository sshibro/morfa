import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adoptShadow, engineCalls, engineWasm, EngineUnsupported, markInFlight, markSettled, resetEngineCalls, resetShadow, setEngine, shadowFor, shadowStats} from '../shared/design/engine-switch';
import {createDesignStore} from '../src/design/engine/store';
import {testMeasurer} from './helpers/design-big-files';
import {documentOf, fontSpecsOf, partsOf, readPart, PART_SHARED_FIELDS} from '../shared/design/parts';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import {fontSpecsUnder} from '../src/design/engine/export-raster';
import {FIXTURES} from '../scripts/goldens/fixtures';

// BIG.md stage B (lane W): the store's nodes from a decoded checkpoint in parts (crates/wasm src/parts.rs). TypeScript is
// the oracle: every node read from a part equals the decoded shadow's `node(id)` and the node as today's JSON load holds
// it (the document's own, less fields the model does not know: a fixture may set one through a cast), shared or not, and
// the faces equal `fontSpecsUnder`'s.

function decoded(doc: DesignDocument) {
  const Doc = engineWasm().MorfaDoc;
  const json = new Doc(JSON.stringify(doc));
  const bytes = json.encode();
  json.free();
  return Doc.decode(bytes);
}

for (const fixture of FIXTURES) {
  test(`${fixture.name}: every node of a part equals node(id) and the document's, shared or not`, () => {
    const doc = fixture.build();
    const handle = decoded(doc);
    const loaded = new (engineWasm().MorfaDoc)(JSON.stringify(doc));
    try {
      for (const shared of [false, true]) {
        const seen = new Set<NodeId>();
        for (const nodes of partsOf(handle, {shared, count: 97})) {
          for (const [id, node] of Object.entries(nodes)) {
            assert.ok(!seen.has(id), `${id} in one part only`);
            seen.add(id);
            assert.deepEqual(node, handle.node(id), `${fixture.name} ${id} (shared ${shared}) equals node(id)`);
            assert.deepEqual(node, loaded.node(id), `${fixture.name} ${id} (shared ${shared}) equals the JSON load's`);
          }
        }
        assert.deepEqual([...seen].sort(), Object.keys(doc.nodes).sort(), 'every node once');
      }
      for (const page of doc.pages)
        assert.deepEqual(fontSpecsOf(handle, page), fontSpecsUnder(doc, page), `faces under ${page}`);
      assert.deepEqual(fontSpecsOf(handle, 'no such node'), []);
    } finally {
      handle.free();
      loaded.free();
    }
  });
}

test('a shared part names each distinct heavy value once, and its nodes hold one object for it', () => {
  const doc = FIXTURES.find(f => f.name === 'heavy-page')!.build();
  const handle = decoded(doc);
  try {
    const json = handle.part_json(0, 2000, true);
    const raw = JSON.parse(json) as {nodes: Record<NodeId, Record<string, unknown>>; values: unknown[]};
    assert.ok(/^[\x00-\x7f]*$/.test(json), 'a part is ASCII');
    const texts = raw.values.map(value => JSON.stringify(value));
    assert.equal(new Set(texts).size, texts.length, 'each value once');
    const nodes = readPart(json);
    const byText = new Map<string, unknown>();
    let references = 0;
    for (const node of Object.values(nodes) as unknown as Record<string, unknown>[])
      for (const key of PART_SHARED_FIELDS) {
        if (node[key] === undefined) continue;
        references++;
        const text = JSON.stringify(node[key]);
        if (byText.has(text)) assert.equal(node[key], byText.get(text), `one object for ${text.slice(0, 40)}`);
        else byText.set(text, node[key]);
      }
    assert.ok(raw.values.length * 20 < references, `${raw.values.length} values for ${references} references`);
    assert.ok(json.length < handle.part_json(0, 2000, false).length, 'a shared part is smaller');
  } finally {
    handle.free();
  }
});

test('adoptShadow: a decoded document becomes the shadow, nothing loaded again', () => {
  resetShadow();
  const doc = FIXTURES.find(f => f.name === 'product-file')!.build();
  const handle = decoded(doc);
  const nodes: Record<NodeId, SceneNode> = {};
  for (const part of partsOf(handle)) Object.assign(nodes, part);
  const opened: DesignDocument = {...doc, nodes};
  const before = shadowStats();
  adoptShadow(handle, opened);
  assert.equal(shadowFor(opened), handle, 'the adopted handle answers');
  const after = shadowStats();
  assert.equal(after.loads - before.loads, 1);
  assert.equal(after.loadMs, before.loadMs, 'no load ran');
  assert.equal(after.fullDiffs, before.fullDiffs, 'no comparison of the file');
  const moved = {...opened, nodes: {...opened.nodes, [doc.pages[0]]: {...opened.nodes[doc.pages[0]], name: 'renamed'}}};
  assert.equal(
    (shadowFor(moved).node(doc.pages[0]) as SceneNode).name,
    'renamed',
    'the adopted shadow follows a change',
  );
  resetShadow();
});

test('adoptShadow then one commit: the normalize runs in wasm on the adopted shadow, nothing loaded or skipped', () => {
  resetShadow();
  const restore = setEngine('normalize', 'wasm');
  try {
    const source = FIXTURES.find(f => f.name === 'template-mobile')!.build();
    const handle = decoded(source);
    const idle: (() => void)[] = [];
    const store = createDesignStore({doc: documentOf(handle), measurer: testMeasurer, deferShadow: true, idle: work => (idle.push(work), () => {})});
    const opened = store.getState().doc;
    markInFlight(opened);
    assert.throws(() => adoptShadow(handle, opened), EngineUnsupported, 'never inside a commit');
    markSettled(opened);
    adoptShadow(handle, opened);
    const loads = shadowStats().loads;
    resetEngineCalls('normalize');
    const id = Object.keys(opened.nodes).find(key => opened.nodes[key].type === 'RECTANGLE')!;
    // Read before the commit: the store writes its table in place (docs/decisions/in-place-table.md), so `opened.nodes[id]`
    // is the moved node afterwards.
    const x = opened.nodes[id].x;
    store.transact('move', tx => tx.update(id, {x: x + 7}));
    const calls = engineCalls('normalize');
    assert.ok(calls.wasm >= 1, `normalize ran in wasm: ${JSON.stringify(calls)}`);
    assert.equal(calls.skipped + calls.fallback, 0, `nothing declined: ${JSON.stringify(calls)}`);
    assert.equal(shadowStats().loads, loads, 'the open loaded nothing again');
    assert.equal((shadowFor(store.getState().doc).node(id) as SceneNode).x, x + 7);
  } finally {
    restore();
    resetShadow();
  }
});
