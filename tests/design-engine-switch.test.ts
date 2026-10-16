import assert from 'node:assert/strict';
import {after, afterEach, beforeEach, describe, test} from 'node:test';
import {createDocument, createNode} from '../shared/design/defaults';
import {
  EngineDiffError,
  EngineUnsupported,
  assertWasmRan,
  digestOf,
  engineCalls,
  engineFor,
  engineWasm,
  firstDifference,
  resetEngineCalls,
  resetShadow,
  resetShadowStats,
  setEngine,
  setEngineWasm,
  shadowFor,
  shadowStats,
  withEngine,
} from '../shared/design/engine-switch';
import {localMatrix, worldBox} from '../shared/design/geometry';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import {createDesignStore} from '../src/design/engine/store';
import {heavyPage, testMeasurer} from './helpers/design-big-files';
import {fuzzCommits, fuzzDocument} from './helpers/design-fuzz';

// The engine switch (lane S2): modes, counters, the differential comparison, fake-green detection and the shadow
// document that follows the editor's store. Needs the nodejs wasm build (scripts/wasm-build.sh).

const restore: (() => void)[] = [];
const use = (module: Parameters<typeof setEngine>[0], mode: Parameters<typeof setEngine>[1]) => restore.push(setEngine(module, mode));
beforeEach(() => resetEngineCalls());
afterEach(() => {
  while (restore.length) restore.pop()!();
  engineWasm().debug_fault('');
});
after(() => resetShadow());

/** A page with a rotated, flipped frame holding a rotated group holding a rectangle. */
function nested(): DesignDocument {
  const doc = createDocument('page', 'Page');
  const put = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!].children!.push(node.id);
  };
  put(createNode('FRAME', {id: 'f', parentId: 'page', x: 100, y: 50, width: 400, height: 300, rotation: 30, flipX: true}));
  put(createNode('GROUP', {id: 'g', parentId: 'f', x: 10, y: 20, width: 200, height: 100, rotation: -45}));
  put(createNode('RECTANGLE', {id: 'r', parentId: 'g', x: 5, y: 7, width: 50, height: 25, rotation: 12.5, flipY: true}));
  return doc;
}

describe('selection', () => {
  test('modes come from setEngine, per module or for all', () => {
    use('*', 'both');
    assert.equal(engineFor('geometry'), 'both');
    use('ops', 'wasm');
    assert.equal(engineFor('ops'), 'wasm');
    assert.equal(engineFor('text'), 'both');
  });

  test('an unknown mode throws instead of meaning ts', () => {
    assert.throws(() => setEngine('geometry', 'wasn' as never), /expected ts, wasm or both/);
  });
});

describe('comparison', () => {
  test('first differing path, tolerance, absent = undefined', () => {
    assert.equal(firstDifference({a: [1, {b: 2}]}, {a: [1, {b: 3}]}), '.a[1].b');
    assert.equal(firstDifference({a: 1, c: undefined}, {a: 1}), null);
    assert.equal(firstDifference({'1:2': 1}, {'1:2': 2}), '["1:2"]');
    assert.equal(firstDifference([1, 2], [1, 2, 3]), '.length');
    assert.equal(firstDifference(1, 1 + 1e-12), '');
    assert.equal(firstDifference(1, 1 + 1e-12, 1e-9), null);
    assert.equal(firstDifference(1e6, 1e6 + 1e-2, 1e-9), '');
    assert.equal(firstDifference(0, -0), '', 'exact compare keeps −0 apart');
    assert.equal(firstDifference(NaN, NaN), null);
    assert.equal(firstDifference(new Float64Array([1, 2]), [1, 2]), null);
    assert.equal(firstDifference(new Map([['a', 1]]), new Map([['a', 2]])), '.get("a")');
  });

  test('digests are stable and short', () => {
    assert.equal(digestOf({a: 1}), digestOf({a: 1}));
    assert.notEqual(digestOf({a: 1}), digestOf({a: 2}));
  });
});

describe('the proof module: localMatrix and worldBox', () => {
  test('both mode runs the wasm side and finds no difference', () => {
    use('geometry', 'both');
    const doc = nested();
    for (const id of ['f', 'g', 'r', 'page', 'missing']) worldBox(doc, id);
    for (const node of Object.values(doc.nodes)) localMatrix(node);
    const calls = assertWasmRan('geometry');
    assert.equal(calls.diffs, 0);
    assert.ok(calls.both > 0 && calls.both === calls.wasm, JSON.stringify(calls));
  });

  test('wasm mode answers without running TypeScript', () => {
    use('geometry', 'wasm');
    const doc = nested();
    const box = worldBox(doc, 'r');
    assert.equal(engineCalls('geometry').ts, 0);
    use('geometry', 'ts');
    assert.equal(firstDifference(worldBox(doc, 'r'), box, 1e-9), null);
  });

  test('fake green: a wrong wasm matrix fails both mode with the path', () => {
    use('geometry', 'both');
    engineWasm().debug_fault('geometry.localMatrix');
    const node = nested().nodes.r;
    assert.throws(
      () => localMatrix(node),
      (error: unknown) => error instanceof EngineDiffError && error.module === 'geometry' && error.call === 'localMatrix' && error.path === '[0][2]' && /inputs [0-9a-f]{8}\//.test(error.message),
    );
    assert.equal(engineCalls('geometry').diffs, 1);
  });

  test('fake green: a wrong wasm box fails both mode with the path', () => {
    use('geometry', 'both');
    engineWasm().debug_fault('geometry.worldBox');
    assert.throws(() => worldBox(nested(), 'r'), (error: unknown) => error instanceof EngineDiffError && error.call === 'worldBox' && error.path === '.height');
  });

  test('fake green: a module that falls back to TypeScript fails assertWasmRan', () => {
    use('geometry', 'wasm');
    const answer = withEngine('geometry', 'fallsBack', () => 1, () => {
      throw new EngineUnsupported('not ported');
    });
    assert.equal(answer, 1);
    assert.throws(() => assertWasmRan('geometry'), /made no wasm call/);
    worldBox(nested(), 'r');
    assert.throws(() => assertWasmRan('geometry'), /fell back to TypeScript 1 times/);
    assert.doesNotThrow(() => assertWasmRan('geometry', {allowFallback: true}));
  });

  test('fake green: no wasm build means an error, never TypeScript', () => {
    use('geometry', 'wasm');
    const saved = process.env.MORFA_WASM_PATH;
    const loaded = engineWasm();
    process.env.MORFA_WASM_PATH = '/nonexistent/morfa_wasm.js';
    try {
      setEngineWasm(null);
      assert.throws(() => worldBox(nested(), 'r'), /wasm engine is not loaded/);
      assert.equal(engineCalls('geometry').ts, 0);
    } finally {
      if (saved === undefined) delete process.env.MORFA_WASM_PATH;
      else process.env.MORFA_WASM_PATH = saved;
      setEngineWasm(loaded);
    }
  });
});

/** A seeded generator (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Strings compared well-formed: a lone UTF-16 surrogate (a name cut mid-emoji, which the fuzz makes) reads as U+FFFD in
// Rust, the one documented difference of the model's string handling.
const wellFormed = (_: string, value: unknown) => (typeof value === 'string' ? (value as string & {toWellFormed(): string}).toWellFormed() : value);
const plain = (node: SceneNode | undefined) => (node === undefined ? undefined : JSON.parse(JSON.stringify(node), wellFormed));

describe('the shadow document', () => {
  test('follows 1 000 random commits of the store on the heavy page, node for node', () => {
    use('geometry', 'both');
    // Made first: the page's own normalize runs on the shadow too when normalize is wasm/both.
    const page = heavyPage();
    resetShadow();
    resetShadowStats();
    const store = createDesignStore({doc: page, measurer: testMeasurer, idle: run => (run(), () => {})});
    const next = random(7);
    const ids = () => Object.keys(store.getState().doc.nodes).filter(id => store.getState().doc.nodes[id].type !== 'PAGE');
    let made = 0;
    for (let i = 0; i < 1000; i++) {
      const roll = next();
      const pool = ids();
      const id = pool[Math.floor(next() * pool.length)];
      const node = store.getState().doc.nodes[id];
      if (roll < 0.08 && store.canUndo()) store.undo();
      else if (roll < 0.12 && store.canRedo()) store.redo();
      else if (roll < 0.2 && node.parentId) {
        const parent = node.parentId;
        store.transact('create', tx => tx.create(createNode('RECTANGLE', {id: `s2-${++made}`, parentId: parent, x: next() * 100, y: next() * 100, width: 10 + next() * 50, height: 10}), parent));
      } else if (roll < 0.25 && (store.getState().doc.nodes[id].children?.length ?? 0) === 0) store.transact('remove', tx => tx.remove(id));
      else if (roll < 0.3) {
        // A drag: frames the shadow is asked about mid-way (worldBox in both mode), then the commit.
        const drag = store.gesture('drag');
        for (let frame = 1; frame <= 3; frame++) {
          drag.update(tx => tx.update(id, {x: node.x + frame * 3, y: node.y - frame}));
          if (frame === 2) worldBox(store.getState().doc, id);
        }
        drag.commit();
      } else if (roll < 0.35) store.transact('rename', tx => tx.update(id, {name: `Layer ${i}`}));
      else if (roll < 0.4) store.transact('rotate', tx => tx.update(id, {rotation: Math.round(next() * 360) - 180, flipX: next() < 0.5}));
      else store.transact('move', tx => tx.update(id, {x: Math.round(next() * 1000), y: Math.round(next() * 1000) / 4}), {coalesce: next() < 0.2 ? 'nudge' : undefined});
    }
    const doc = store.getState().doc;
    const shadow = shadowFor(doc);
    const all = new Set([...Object.keys(doc.nodes), ...Array.from({length: made}, (_, k) => `s2-${k + 1}`)]);
    for (const id of all) {
      const path = firstDifference(plain(doc.nodes[id]), shadow.node(id));
      assert.equal(path, null, `node ${id} differs at ${path}`);
    }
    assert.deepEqual(shadow.pages(), doc.pages);
    const stats = shadowStats();
    assert.equal(stats.loads, 1, JSON.stringify(stats));
    assert.equal(stats.fullDiffs, 0, `every change reached the shadow as a patch: ${JSON.stringify(stats)}`);
    assert.ok(stats.patches > 900, JSON.stringify(stats));
    assertWasmRan('geometry');
  });

  test('replace loads the new document', () => {
    use('geometry', 'both');
    resetShadow();
    const store = createDesignStore({doc: nested(), measurer: testMeasurer});
    worldBox(store.getState().doc, 'r');
    const other = nested();
    other.nodes.r = {...other.nodes.r, x: 77};
    store.replaceDocument(other);
    assert.equal(shadowFor(store.getState().doc).node('r')?.x, 77);
  });

  test('a document inside an open transaction is never shadowed: TypeScript answers, counted as skipped', () => {
    use('geometry', 'both');
    const store = createDesignStore({doc: nested(), measurer: testMeasurer});
    let inside: ReturnType<typeof worldBox> | null = null;
    store.transact('move', tx => {
      tx.update('r', {x: 40});
      inside = worldBox(tx.doc, 'r');
      tx.update('r', {x: 60});
    });
    assert.ok(inside);
    // The reader declines without trying (lane E1: no exception per call): skipped, never a fallback.
    assert.equal(engineCalls('geometry').skipped, 1);
    assert.equal(engineCalls('geometry').fallback, 0);
    // The committed document is followed again.
    const after = store.getState().doc;
    assert.equal(shadowFor(after).node('r')?.x, after.nodes.r.x);
    assert.equal(firstDifference(shadowFor(after).node('g'), JSON.parse(JSON.stringify(after.nodes.g))), null);
    assert.equal(firstDifference(worldBox(after, 'r'), worldBox(after, 'r')), null);
  });

  test('any other document is reached by comparing tables', () => {
    use('geometry', 'both');
    resetShadow();
    resetShadowStats();
    const doc = nested();
    worldBox(doc, 'r');
    const moved: DesignDocument = {...doc, nodes: {...doc.nodes, g: {...doc.nodes.g, x: 999}}};
    delete (moved.nodes as Record<NodeId, SceneNode>).r;
    moved.nodes.g = {...moved.nodes.g, children: []};
    assert.deepEqual(worldBox(moved, 'g'), worldBox(moved, 'g'));
    const shadow = shadowFor(moved);
    assert.equal(shadow.node('g')?.x, 999);
    assert.equal(shadow.node('r'), undefined);
    assert.equal(shadowStats().fullDiffs, 1);
  });
});

describe('the shadow on fuzzed documents (tests/helpers/design-fuzz.ts)', () => {
  test('every node of 30 fuzzed documents, and after 20 fuzzed commits each, equals the TypeScript', () => {
    use('geometry', 'both');
    for (let seed = 1; seed <= 30; seed++) {
      resetShadow();
      let doc = fuzzDocument(seed, {nodes: 80 + seed * 20});
      const check = (when: string) => {
        const shadow = shadowFor(doc);
        for (const id of Object.keys(doc.nodes)) {
          const path = firstDifference(plain(doc.nodes[id]), plain(shadow.node(id)));
          assert.equal(path, null, `seed ${seed} ${when}: node ${id} differs at ${path}`);
          worldBox(doc, id);
        }
        assert.deepEqual(shadow.pages(), doc.pages);
      };
      check('loaded');
      for (const commit of fuzzCommits(doc, 20, seed)) doc = commit.doc;
      check('after 20 commits');
    }
    assert.equal(assertWasmRan('geometry').diffs, 0);
  });
});
