import assert from 'node:assert/strict';
import {after, afterEach, beforeEach, describe, test} from 'node:test';
import {createDocument, createNode} from '../shared/design/defaults';
import {
  EDITOR_DEFAULTS,
  ENGINE_MODULES,
  EngineDiffError,
  engineByDefault,
  engineFor,
  engineCalls,
  engineWasm,
  firstDifference,
  resetEngineCalls,
  resetShadow,
  resetShadowStats,
  setEngine,
  shadowFor,
  shadowNear,
  shadowStats,
} from '../shared/design/engine-switch';
import {localMatrix, worldBox, worldMatrix} from '../shared/design/geometry';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {createDesignStore} from '../src/design/engine/store';
import {heavyPage, testMeasurer} from './helpers/design-big-files';

// Lane E1: the shadow following the editor's store at idle (`followStore`'s `defer`, the browser's default), the
// readers that keep to its reach (`shadowNear`), the part-by-part load at idle, and geometry's readers (worldMatrix
// through the shadow, localMatrix kept in TypeScript outside `both`). Needs the nodejs wasm build.

const restore: (() => void)[] = [];
const use = (module: Parameters<typeof setEngine>[0], mode: Parameters<typeof setEngine>[1]) => restore.push(setEngine(module, mode));
beforeEach(() => {
  resetEngineCalls();
  resetShadow();
  resetShadowStats();
});
afterEach(() => {
  while (restore.length) restore.pop()!();
  engineWasm().debug_fault('');
});
after(() => resetShadow());

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

/** A store following the shadow at idle, its idle work run when the test says. */
function deferredStore(doc: DesignDocument) {
  const queue: (() => void)[] = [];
  const store = createDesignStore({
    doc,
    measurer: testMeasurer,
    deferShadow: true,
    idle: work => {
      let live = true;
      queue.push(() => live && work());
      return () => void (live = false);
    },
  });
  const idle = () => {
    let steps = 0;
    while (queue.length) queue.shift()!(), steps++;
    return steps;
  };
  return {store, idle};
}

describe('geometry readers (lane E1)', () => {
  test('worldMatrix through the shadow: both compares, a wrong wasm matrix fails with the path', () => {
    use('geometry', 'both');
    const doc = nested();
    assert.equal(firstDifference(worldMatrix(doc, 'r'), worldMatrix(doc, 'r')), null);
    assert.ok(engineCalls('geometry').both > 0);
    engineWasm().debug_fault('geometry.worldMatrix');
    assert.throws(() => worldMatrix(doc, 'r'), (error: unknown) => error instanceof EngineDiffError && error.call === 'worldMatrix' && error.path === '[0][2]');
  });

  test('wasm: worldMatrix answers from Rust, equal to TypeScript within the tolerance', () => {
    use('geometry', 'wasm');
    const doc = nested();
    const m = worldMatrix(doc, 'r');
    assert.equal(engineCalls('geometry').wasm, 1);
    use('geometry', 'ts');
    assert.equal(firstDifference(worldMatrix(doc, 'r'), m, 1e-9), null);
  });

  test('wasm: localMatrix stays in TypeScript (no crossing); both still compares it', () => {
    use('geometry', 'wasm');
    const node = nested().nodes.r;
    const m = localMatrix(node);
    assert.equal(engineCalls('geometry').wasm, 0);
    use('geometry', 'both');
    assert.deepEqual(localMatrix(node), m);
    assert.equal(engineCalls('geometry').both, 1);
  });
});

describe('documents the shadow never follows', () => {
  test('a table laid over through its prototype (codegen): the readers answer in TypeScript, the shadow stays', () => {
    use('geometry', 'both');
    const doc = nested();
    worldBox(doc, 'r');
    const nodes = Object.create(doc.nodes) as typeof doc.nodes;
    nodes.r = {...doc.nodes.r, x: 321};
    const layered: DesignDocument = {...doc, nodes};
    assert.equal(shadowNear(layered), false);
    const box = worldMatrix(layered, 'r');
    assert.equal(engineCalls('geometry').skipped, 1);
    // The shadow still holds `doc`, every node of it.
    assert.equal(shadowFor(doc).node('g')?.id, 'g');
    use('geometry', 'ts');
    assert.deepEqual(worldMatrix(layered, 'r'), box);
  });
});

describe('the shadow following at idle', () => {
  test('a commit crosses nothing; the next idle sends every commit since in one patch', () => {
    use('geometry', 'wasm');
    const {store, idle} = deferredStore(nested());
    idle();
    assert.equal(shadowStats().loads, 1);
    resetShadowStats();
    for (let k = 1; k <= 5; k++) store.transact('move', tx => tx.update('r', {x: 5 + k}));
    // Lane N1: a commit whose normalize ran in wasm by default is applied at once — the shadow holds its final nodes
    // as a journal entry, so the patch costs a replay, and the next commit stays in reach. Otherwise nothing crosses.
    const held = engineFor('normalize') === 'wasm' && engineByDefault('normalize');
    assert.equal(shadowStats().patches, held ? 5 : 0, held ? 'each held commit applied at once' : 'no commit crossed');
    idle();
    const stats = shadowStats();
    assert.equal(stats.patches, held ? 5 : 1, JSON.stringify(stats));
    assert.equal(stats.fullDiffs, 0);
    const doc = store.getState().doc;
    assert.equal(firstDifference(JSON.parse(JSON.stringify(doc.nodes.r)), shadowFor(doc).node('r')), null);
  });

  test('a read before the idle brings the shadow along by the changed ids, never by the file', () => {
    use('geometry', 'both');
    const {store, idle} = deferredStore(nested());
    idle();
    store.transact('move', tx => tx.update('r', {x: 40, rotation: 70}));
    const doc = store.getState().doc;
    assert.equal(shadowNear(doc), true);
    worldBox(doc, 'r');
    assert.equal(engineCalls('geometry').skipped, 0);
    assert.ok(engineCalls('geometry').both > 0);
    assert.equal(shadowStats().fullDiffs, 0);
  });

  test('a drag frame of many layers: nodes off the dragged chains answer from the shadow as it stands, the rest from TypeScript', () => {
    use('geometry', 'both');
    const page = heavyPage();
    const {store, idle} = deferredStore(page);
    idle();
    const leaves = Object.values(page.nodes).filter(node => !node.children && node.type !== 'PAGE');
    const dragged = leaves.slice(0, 40).map(node => node.id);
    const gesture = store.gesture('move');
    gesture.update(tx => dragged.forEach(id => tx.update(id, {x: page.nodes[id].x + 5})));
    const frame = store.getState().doc;
    assert.equal(shadowNear(frame), false, '40 ids away');
    const untouched = leaves[leaves.length - 1].id;
    resetEngineCalls();
    worldBox(frame, untouched);
    worldMatrix(frame, untouched);
    assert.equal(engineCalls('geometry').skipped, 0);
    assert.ok(engineCalls('geometry').both >= 2, 'compared against TypeScript on the frame itself');
    resetEngineCalls();
    worldBox(frame, dragged[0]);
    assert.equal(engineCalls('geometry').skipped, 1, 'a dragged layer is the frame’s own');
    gesture.commit();
  });

  test('a document out of reach is declined, never loaded: TypeScript answers, counted as skipped', () => {
    use('geometry', 'wasm');
    const {idle} = deferredStore(nested());
    idle();
    const loads = shadowStats().loads;
    const other = nested();
    other.nodes.r = {...other.nodes.r, x: 999};
    assert.equal(shadowNear(other), false);
    const box = worldBox(other, 'r');
    assert.equal(engineCalls('geometry').skipped, 1);
    assert.equal(engineCalls('geometry').wasm, 0);
    assert.equal(shadowStats().loads, loads);
    assert.equal(shadowStats().fullDiffs, 0);
    use('geometry', 'ts');
    assert.deepEqual(worldBox(other, 'r'), box);
  });

  test('a large file loads at idle a part per callback; reads before the last part are declined', () => {
    use('geometry', 'wasm');
    const page = heavyPage();
    const {store, idle} = deferredStore(page);
    const doc = store.getState().doc;
    const leaf = Object.values(doc.nodes).find(node => !node.children && node.type !== 'PAGE')!.id;
    worldBox(doc, leaf);
    assert.equal(engineCalls('geometry').skipped, 1, 'not loaded yet');
    // A commit while loading: noted, sent after the last part.
    store.transact('move', tx => tx.update(leaf, {x: 1234}));
    const steps = idle();
    assert.ok(steps > Object.keys(doc.nodes).length / 2000, `${steps} idle steps`);
    const now = store.getState().doc;
    assert.equal(shadowFor(now).node(leaf)?.x, 1234);
    const before = engineCalls('geometry').wasm;
    worldBox(now, leaf);
    assert.equal(engineCalls('geometry').wasm, before + 1);
  });

  test('a change of thousands of layers (a page loaded on demand) is caught up in idle-sized parts, never one patch', () => {
    use('geometry', 'wasm');
    const page = heavyPage();
    const {store, idle} = deferredStore(page);
    idle();
    resetShadowStats();
    const leaves = Object.values(page.nodes).filter(node => !node.children && node.type !== 'PAGE').slice(0, 3000);
    store.transact('move', tx => leaves.forEach(node => tx.update(node.id, {x: node.x + 1})));
    const steps = idle();
    assert.ok(steps > 4, `${steps} idle steps`);
    assert.equal(shadowStats().patches, 0, 'no single patch of 3 000 entries');
    const doc = store.getState().doc;
    assert.equal(shadowFor(doc).node(leaves[0].id)?.x, doc.nodes[leaves[0].id].x);
  });

  test('replace: the new document is loaded at idle', () => {
    use('geometry', 'wasm');
    const {store, idle} = deferredStore(nested());
    idle();
    const other = nested();
    other.nodes.r = {...other.nodes.r, x: 77};
    store.replaceDocument(other);
    assert.equal(shadowNear(store.getState().doc), false);
    idle();
    assert.equal(shadowFor(store.getState().doc).node('r')?.x, 77);
    assert.equal(shadowNear(store.getState().doc), true);
  });
});

describe('defaults (EDITOR_DEFAULTS)', () => {
  const withEnv = (vars: Record<string, string | undefined>, run: () => void) => {
    const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
    const env = process.env as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(vars)) value === undefined ? delete env[key] : (env[key] = value);
    setEngine('*', null);
    try {
      run();
    } finally {
      for (const [key, value] of Object.entries(saved)) value === undefined ? delete env[key] : (env[key] = value);
      setEngine('*', null);
    }
  };
  const cleared = Object.fromEntries(['MORFA_ENGINE', ...ENGINE_MODULES.map(module => `MORFA_ENGINE_${module.toUpperCase()}`)].map(key => [key, undefined]));

  test('Node runs every module as ts unless asked; MORFA_ENGINE=editor runs the editor table, by default', () => {
    withEnv(cleared, () => {
      for (const module of ENGINE_MODULES) assert.equal(engineFor(module), 'ts');
      assert.equal(engineByDefault('geometry'), false);
    });
    withEnv({...cleared, MORFA_ENGINE: 'editor'}, () => {
      for (const module of ENGINE_MODULES) {
        assert.equal(engineFor(module), EDITOR_DEFAULTS[module]);
        assert.equal(engineByDefault(module), EDITOR_DEFAULTS[module] !== 'ts');
      }
    });
    withEnv({...cleared, MORFA_ENGINE: 'editor', MORFA_ENGINE_GEOMETRY: 'both'}, () => {
      assert.equal(engineFor('geometry'), 'both');
      assert.equal(engineByDefault('geometry'), false, 'chosen, not a default');
    });
  });

  test('a module defaults to wasm only where its measured numbers justify it (geometry, normalize)', () => {
    assert.deepEqual(
      ENGINE_MODULES.filter(module => EDITOR_DEFAULTS[module] !== 'ts'),
      ['geometry', 'normalize'],
    );
  });
});
