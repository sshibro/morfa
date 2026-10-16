import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {emptyNormalizeStats, normalizeDetailed, normalizeDocument} from '../shared/design/normalize';
import {beginTransaction, createScratch, prepareScratch} from '../shared/design/transaction';
import {applyVariablesDetailed, createVariable, createVariableCollection} from '../shared/design/variables';
import {applyAllVariables} from '../shared/design/variables';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import {SpatialIndex} from '../src/design/engine/render/spatial-index';
import {budget, speedFactor} from './helpers/speed';

// Speed of the editing path on a 20 000-layer page (docs/design-tool.md §Performance): a drag frame,
// a keystroke, an undo of a large paste and opening a file, through the store, normalization and the
// canvas's spatial index, as the editor runs them. Two kinds of check:
//
// - Work counts, which do not depend on the machine: a node table that counts how often it is
//   enumerated and read shows that an edit never walks the whole file.
// - Time budgets, scaled by how fast this machine runs a fixed piece of work right now (measured
//   first), so a slower or busy machine gets proportionally more time instead of a flaky failure.
//   The budgets are those of a modest laptop: 4 ms of engine work per drag frame or keystroke,
//   50 ms to undo a 5 000-layer paste, 400 ms to normalize a 20 000-layer file.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

/** 40 screens × 10 sections × a group of 48 layers: 20 041 nodes, every layer inside a group. */
function heavyPage(): DesignDocument {
  const doc = createDocument('page', 'Heavy page');
  let n = 0;
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>) => {
    const id = `n${++n}`;
    doc.nodes[id] = createNode(type, {...props, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  const kinds: NodeType[] = ['RECTANGLE', 'TEXT', 'ELLIPSE', 'VECTOR', 'RECTANGLE', 'LINE'];
  for (let s = 0; s < 40; s++) {
    const screen = add('FRAME', 'page', {name: `Screen ${s + 1}`, x: (s % 8) * 1600, y: Math.floor(s / 8) * 2200, width: 1440, height: 2000});
    for (let k = 0; k < 10; k++) {
      const section = add('FRAME', screen, {name: `Section ${k + 1}`, x: 0, y: k * 200, width: 1440, height: 200});
      const group = add('GROUP', section, {name: `Group ${k + 1}`, x: 20, y: 20, width: 1400, height: 160});
      for (let i = 0; i < 48; i++) {
        const type = kinds[i % kinds.length];
        add(type, group, {x: 20 + (i % 12) * 110, y: 20 + Math.floor(i / 12) * 38, width: 100, height: type === 'LINE' ? 0 : 30, ...(type === 'TEXT' ? {text: defaultTextProps('Text')} : {})});
      }
    }
  }
  return doc;
}

let cached: {raw: DesignDocument; doc: DesignDocument; normalizeMs: number} | null = null;
/** The raw page, the page normalized, and the best of two whole-file normalizations (ms). */
function page() {
  if (cached) return cached;
  const raw = heavyPage();
  const all = new Set(Object.keys(raw.nodes));
  let doc = raw, normalizeMs = Infinity;
  for (let k = 0; k < 2; k++) {
    const started = performance.now();
    doc = normalizeDocument(raw, all, {measurer});
    normalizeMs = Math.min(normalizeMs, performance.now() - started);
  }
  return (cached = {raw, doc, normalizeMs});
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// ── Counting tables ───────────────────────────────────────────────────────────────────────────────

type Counts = {enumerations: number; reads: number};
/** `doc` with a node table that counts whole-table enumerations (keys, spread, for…in) and reads. */
function counted(doc: DesignDocument): {doc: DesignDocument; counts: Counts} {
  const counts: Counts = {enumerations: 0, reads: 0};
  const nodes = new Proxy(doc.nodes, {
    ownKeys(target) {
      counts.enumerations++;
      return Reflect.ownKeys(target);
    },
    get(target, key, receiver) {
      if (typeof key === 'string') counts.reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return {doc: {...doc, nodes}, counts};
}

// ── The canvas's side: a spatial index fed with the store's changed ids ─────────────────────────────

function canvasIndex(store: DesignStore) {
  const index = new SpatialIndex();
  index.sync(store.getState().doc, 'page', measurer);
  let from: DesignDocument | null = null, to: DesignDocument | null = null;
  const ids = new Set<NodeId>();
  store.onDocument(change => {
    from ??= index.document;
    for (const id of change.changed) ids.add(id);
    to = change.doc;
  });
  return () => {
    const doc = store.getState().doc;
    const hint = from && from === index.document && to === doc ? {from, ids} : undefined;
    index.sync(doc, 'page', measurer, hint);
    from = to = null;
    ids.clear();
    return index;
  };
}

/** A store whose idle work runs when the test says (between frames or keystrokes, as a browser would). */
function editor(doc: DesignDocument) {
  let idle: (() => void) | null = null;
  const store = createDesignStore({doc, measurer, table: 'copy', idle: work => {
    idle = work;
    return () => void (idle = null);
  }});
  const runIdle = () => {
    const work = idle;
    idle = null;
    work?.();
  };
  return {store, runIdle, sync: canvasIndex(store)};
}

// ── Work counts ───────────────────────────────────────────────────────────────────────────────────

test('drag frames never enumerate the file and read a few entries of it', () => {
  const {doc, counts} = counted(page().doc);
  const scratch = createScratch(doc);
  const id = 'n500', start = doc.nodes[id];
  const frame = (k: number) => {
    const tx = beginTransaction(doc, {scratch});
    tx.update(id, {x: start.x + k * 2, y: start.y + k});
    return tx.commit({measurer});
  };
  frame(1); // The first frame copies the table (unless the store had an idle copy ready).
  const before = {...counts};
  let result = frame(2);
  for (let k = 3; k < 23; k++) result = frame(k);
  assert.equal(counts.enumerations - before.enumerations, 0, 'no frame walks the file');
  assert.ok((counts.reads - before.reads) / 21 < 40, `entries of the file read per frame: ${(counts.reads - before.reads) / 21}`);
  // (Read before the next frame rewrites the shared table.)
  assert.deepEqual(Object.keys(result.patch.nodes!).sort(), [id, 'n453'].sort(), 'the layer and its group (refitted)');
  assert.equal(result.doc.nodes[id].x, start.x + 44);

  const stats = emptyNormalizeStats();
  const tx = beginTransaction(doc, {scratch});
  tx.update(id, {x: start.x + 50, y: start.y + 25});
  const last = normalizeDetailed(tx.doc, new Set([id]), {measurer, stats}, {owned: true});
  assert.ok(last.changed.size <= 3, `normalization wrote ${last.changed.size} nodes`);
  assert.ok(stats.fitted <= 2 && stats.measured + stats.arranged === 0, JSON.stringify(stats));
});

const firstText = () => Object.keys(page().doc.nodes).find(id => page().doc.nodes[id].type === 'TEXT' && Number(id.slice(1)) > 1000)!;

test('a keystroke with the idle copy ready never enumerates the file', () => {
  const {doc, counts} = counted(page().doc);
  let idle: (() => void) | null = null;
  const store = createDesignStore({doc, measurer, table: 'copy', idle: work => {
    idle = work;
    return () => void (idle = null);
  }});
  const runIdle = () => {
    const work = idle;
    idle = null;
    work?.();
  };
  assert.equal(counts.enumerations, 0);
  runIdle();
  assert.equal(counts.enumerations, 1, 'the idle copy');
  const text = firstText();
  const before = {...counts};
  store.transact('Text', tx => tx.update(text, {text: {...tx.get(text)!.text!, characters: 'Text with new words'}}), {coalesce: 'typing'});
  assert.equal(counts.enumerations - before.enumerations, 0);
  assert.ok(counts.reads - before.reads < 40, `entries read: ${counts.reads - before.reads}`);
  assert.equal(store.getState().doc.nodes[text].text!.characters, 'Text with new words');
  assert.ok(store.getState().doc.nodes[text].width > page().doc.nodes[text].width, 'the auto-width text grew');
  assert.equal(doc.nodes[text].text!.characters, 'Text', 'the document before the keystroke is untouched');
  runIdle();
  assert.ok(store.undo());
  assert.equal(store.getState().doc.nodes[text].text!.characters, 'Text');
  assert.equal(store.getState().doc.nodes[text].width, page().doc.nodes[text].width);
});

test('variables cost nothing in a file without them and only what changed in a file with them', () => {
  const {doc, counts} = counted(page().doc);
  const none = applyVariablesDetailed(doc, new Set(['n500', 'n453']));
  assert.equal(none.doc, doc);
  assert.deepEqual(counts, {enumerations: 0, reads: 0}, 'not one entry looked at');

  let withVars = createVariableCollection(page().doc, {id: 'c', name: 'Colors'}).doc;
  withVars = createVariable(withVars, {id: 'v', name: 'Accent', collectionId: 'c', type: 'COLOR', value: {r: 1, g: 0, b: 0, a: 1}}).doc;
  const nodes = {...withVars.nodes};
  let bound = 0;
  for (const id of Object.keys(nodes)) {
    if (nodes[id].type !== 'RECTANGLE' || bound++ >= 2000) continue;
    const fill = nodes[id].fills[0] as Extract<SceneNode['fills'][number], {type: 'SOLID'}>;
    nodes[id] = {...nodes[id], fills: [{...fill, boundVariables: {color: {type: 'VARIABLE_ALIAS', id: 'v'}}}]};
  }
  const resolved = applyAllVariables({...withVars, nodes});
  assert.equal((resolved.nodes.n4.fills[0] as {color: {r: number}}).color.r, 1, 'bound fills took the value');
  const tracked = counted(resolved);
  const scratch = createScratch(tracked.doc);
  const frame = (k: number) => {
    const tx = beginTransaction(tracked.doc, {scratch});
    tx.update('n4', {x: 20 + k, y: 20 + k});
    return tx.commit({measurer});
  };
  frame(1);
  frame(2); // The base's index of bindings is built once, here or in the frame before.
  const before = {...tracked.counts};
  for (let k = 3; k < 13; k++) frame(k);
  assert.equal(tracked.counts.enumerations - before.enumerations, 0, 'the index of bindings is reused');
  assert.ok((tracked.counts.reads - before.reads) / 10 < 40, `entries read per frame: ${(tracked.counts.reads - before.reads) / 10}`);
});

test('the canvas index follows drag frames by the reported ids', () => {
  const {store, sync} = editor(page().doc);
  sync();
  const gesture = store.gesture('Move');
  const start = page().doc.nodes.n500;
  for (let k = 1; k <= 3; k++) {
    gesture.update(tx => tx.update('n500', {x: start.x + 10 * k, y: start.y + 5 * k}));
    const index = sync();
    // Frames share one node table; the index must still match one built from scratch.
    const fresh = new SpatialIndex();
    fresh.sync(store.getState().doc, 'page', measurer);
    for (const id of ['n500', 'n453', 'n452', 'n1']) assert.deepEqual(index.bounds(id), fresh.bounds(id), `${id} after frame ${k}`);
  }
  gesture.commit();

  // A hinted sync reads what changed and its ancestors, never the whole table.
  const doc = store.getState().doc;
  const probe = new SpatialIndex();
  probe.sync(doc, 'page', measurer);
  const next = counted({...doc, nodes: {...doc.nodes, n500: {...doc.nodes.n500, x: start.x + 40}}});
  probe.sync(next.doc, 'page', measurer, {from: doc, ids: ['n500']});
  assert.equal(next.counts.enumerations, 0, 'a hinted sync never enumerates the file');
  assert.ok(next.counts.reads < 300, `entries read: ${next.counts.reads}`);
  assert.equal(probe.bounds('n500')!.x - probe.bounds('n499')!.x, 40 + start.x - doc.nodes.n499.x);
});

// ── Time budgets ──────────────────────────────────────────────────────────────────────────────────

test('a drag frame of one layer and of fifty layers stays within 4 ms on a 20 000-layer page', t => {
  const {store, runIdle, sync} = editor(page().doc);
  runIdle();
  sync();
  const time = (ids: NodeId[]) => {
    const starts = ids.map(id => page().doc.nodes[id]);
    const gesture = store.gesture('Move');
    const frames: number[] = [];
    for (let k = 0; k < 40; k++) {
      const started = performance.now();
      gesture.update(tx => ids.forEach((id, i) => tx.update(id, {x: starts[i].x + k * 2, y: starts[i].y + k})));
      sync();
      frames.push(performance.now() - started);
    }
    gesture.commit();
    sync();
    runIdle();
    return median(frames.slice(5));
  };
  const one = time(['n500']);
  const fifty = time([...page().doc.nodes.n3.children!.slice(0, 25), ...page().doc.nodes.n53.children!.slice(0, 25)]);
  t.diagnostic(`speed factor ${speedFactor().toFixed(2)}; drag frame: one layer ${one.toFixed(2)} ms, fifty ${fifty.toFixed(2)} ms`);
  assert.ok(one <= budget(4), `one layer: ${one.toFixed(2)} ms per frame (budget ${budget(4).toFixed(1)})`);
  assert.ok(fifty <= budget(4), `fifty layers: ${fifty.toFixed(2)} ms per frame (budget ${budget(4).toFixed(1)})`);
});

test('a keystroke in a 20 000-layer file stays within 4 ms', t => {
  const {store, runIdle, sync} = editor(page().doc);
  const text = firstText();
  let characters = page().doc.nodes[text].text!.characters;
  const times: number[] = [];
  for (let k = 0; k < 30; k++) {
    runIdle(); // The pause between two keys.
    characters += 'y';
    const started = performance.now();
    store.transact('Text', tx => tx.update(text, {text: {...tx.get(text)!.text!, characters}}), {coalesce: 'typing'});
    sync();
    times.push(performance.now() - started);
  }
  assert.equal(store.getState().doc.nodes[text].text!.characters, characters);
  const typical = median(times.slice(3));
  t.diagnostic(`keystroke ${typical.toFixed(2)} ms`);
  assert.ok(typical <= budget(4), `keystroke: ${typical.toFixed(2)} ms (budget ${budget(4).toFixed(1)})`);
});

test('nudging every screen of a 20 000-layer page stays within 16 ms: the index slides the screens\' layers', t => {
  const {store, runIdle, sync} = editor(page().doc);
  const screens = page().doc.nodes.page.children!;
  store.setSelection(screens);
  sync();
  const times: number[] = [];
  for (let k = 0; k < 24; k++) {
    runIdle(); // The pause between two presses.
    const dx = k % 2 ? -1 : 1;
    const started = performance.now();
    store.transact('Shift', tx => {
      for (const id of screens) tx.update(id, {x: tx.get(id)!.x + dx});
    }, {coalesce: 'nudge'});
    sync();
    times.push(performance.now() - started);
  }
  // Across grid cells and back, then the index must equal one built from scratch.
  runIdle();
  store.transact('Shift', tx => {
    for (const id of screens) tx.update(id, {x: tx.get(id)!.x + 300, y: tx.get(id)!.y + 10});
  });
  const index = sync();
  const fresh = new SpatialIndex();
  fresh.sync(store.getState().doc, 'page', measurer);
  for (const id of ['n1', 'n2', 'n4', 'n500', 'n9000', 'n20000']) {
    const a = index.bounds(id)!, b = fresh.bounds(id)!;
    for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(a[key] - b[key]) < 1e-6, `${id}.${key}: ${a[key]} vs ${b[key]}`);
  }
  const typical = median(times.slice(4));
  t.diagnostic(`nudge of ${screens.length} screens (${Object.keys(page().doc.nodes).length} layers): ${typical.toFixed(2)} ms`);
  assert.ok(typical <= budget(16), `nudge: ${typical.toFixed(2)} ms (budget ${budget(16).toFixed(1)})`);
});

test('undoing a 5 000-layer paste stays within 50 ms', t => {
  const {store, runIdle, sync} = editor(page().doc);
  sync();
  store.transact('Paste', tx => {
    tx.create(createNode('FRAME', {id: 'pasted', x: 20000, y: 0, width: 4000, height: 4000}), 'page');
    for (let i = 0; i < 5000; i++) tx.create(createNode('RECTANGLE', {id: `p${i}`, x: (i % 70) * 50, y: Math.floor(i / 70) * 50, width: 40, height: 40}), 'pasted');
  });
  sync();
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    runIdle();
    const started = performance.now();
    store.undo();
    sync();
    best = Math.min(best, performance.now() - started);
    assert.equal(store.getState().doc.nodes.p0, undefined);
    runIdle();
    store.redo();
    sync();
    assert.ok(store.getState().doc.nodes.p4999);
  }
  t.diagnostic(`undo of the paste ${best.toFixed(1)} ms`);
  assert.ok(best <= budget(50), `undo: ${best.toFixed(1)} ms (budget ${budget(50).toFixed(0)})`);
});

test('normalizing a 20 000-layer file stays within 400 ms', t => {
  const {raw, doc, normalizeMs} = page();
  assert.ok(Object.keys(raw.nodes).length > 20_000);
  assert.notEqual(doc, raw, 'the groups were fitted');
  t.diagnostic(`normalize ${normalizeMs.toFixed(0)} ms`);
  assert.ok(normalizeMs <= budget(400), `normalize: ${normalizeMs.toFixed(0)} ms (budget ${budget(400).toFixed(0)})`);
  // A second pass over a normalized file changes nothing.
  assert.equal(normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer}), doc);
});

test('an idle copy is taken once and only for its own document', () => {
  const {store, runIdle} = editor(page().doc);
  runIdle();
  const first = store.getState().doc;
  store.transact('Shift', tx => tx.update('n500', {x: 1}));
  const second = store.getState().doc;
  assert.notEqual(second.nodes, first.nodes);
  assert.equal(first.nodes.n500.x, page().doc.nodes.n500.x, 'the earlier document is untouched');
  // No idle time: the next edit copies the table itself, and both earlier documents stay as they were.
  store.transact('Shift', tx => tx.update('n500', {x: 2}));
  assert.equal(second.nodes.n500.x, 1);
  assert.equal(first.nodes.n500.x, page().doc.nodes.n500.x);
  runIdle();
  const third = store.getState().doc;
  store.undo();
  assert.equal(third.nodes.n500.x, 2, 'undo wrote into a copy, not into the document it left');
  assert.equal(store.getState().doc.nodes.n500.x, 1);
  // A spare made for one document is never used for another.
  const scratch = prepareScratch(first);
  const tx = beginTransaction(second, {scratch});
  tx.update('n500', {x: 3});
  tx.commit({measurer});
  assert.equal(first.nodes.n500.x, page().doc.nodes.n500.x);
  assert.equal(second.nodes.n500.x, 1);
});
