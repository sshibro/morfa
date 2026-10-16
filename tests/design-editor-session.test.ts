import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {DocumentPatch} from '../shared/design/patch';
import type {DesignSaved} from '../shared/design/api';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import {SpatialIndex} from '../src/design/engine/render/spatial-index';
import {
  attachPersistence, familyLoaded, relayoutTextFor, returnToMoveAfterDrawing, saveFailureMessage, staleTextFor, textUsesFamily, waitForFonts, watchFontLoads,
} from '../src/design/editor/editor-session';
import {createThumbnailScheduler} from '../src/design/editor/thumbnails';
import {DEFAULT_PREFERENCES, parsePreferences} from '../src/design/editor/preferences';

// src/design/editor/editor-session.ts and thumbnails.ts: text re-measured when its font arrives (no
// undo step, saved), drawing tools handing back to "Move", autosave wiring (the server's own
// copy is never sent back, "Keep mine" writes over newer copies), the card picture's timing, and
// the preferences' parsing.

/** A measurer whose type can "load": `scale` changes the widths and bumps the revision, as fonts.ts does. */
function loadingMeasurer() {
  let scale = 0.5, revision = 0;
  const measurer: TextMeasurer & {revision: number} = {
    get revision() {
      return revision;
    },
    width: (text, font) => text.length * font.size * scale,
    metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
  };
  return {measurer, load(next: number) {
    scale = next;
    revision++;
  }};
}

function textNode(id: NodeId, characters: string, family: string, extra: Partial<SceneNode> = {}): SceneNode {
  const text = defaultTextProps(characters);
  text.style = {...text.style, fontFamily: family, fontSize: 10};
  text.textAutoResize = 'WIDTH_AND_HEIGHT';
  return createNode('TEXT', {id, text, ...extra});
}

function docWith(nodes: SceneNode[], measurer: TextMeasurer): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  for (const node of nodes) tx.create(node, 'page');
  return tx.commit({measurer}).doc;
}

test('a loaded font re-measures the auto-sized text that uses it, without an undo step, and the change is saved', () => {
  const {measurer, load} = loadingMeasurer();
  const runs = textNode('mixed', 'abcd', 'Roboto');
  runs.text!.runs = [{start: 0, end: 2, style: {fontFamily: 'Inter'}}];
  const doc = docWith([textNode('inter', 'hello', 'Inter'), textNode('roboto', 'hello', 'Roboto'), runs, textNode('fixed', 'hello', 'Inter', {})], measurer);
  const fixed = beginTransaction(doc);
  fixed.update('fixed', {text: {...doc.nodes.fixed.text!, textAutoResize: 'NONE'}, width: 33});
  const store = createDesignStore({doc: fixed.commit({measurer}).doc, measurer});
  assert.equal(store.getState().doc.nodes.inter.width, 25);
  assert.ok(textUsesFamily(store.getState().doc.nodes.mixed, 'Inter'), 'a run in the family counts');
  assert.deepEqual(staleTextFor(store.getState().doc, 'Inter', measurer), [], 'nothing is stale before the face arrives');

  const patches: {source: string; patch: DocumentPatch}[] = [];
  store.onPatch(event => patches.push(event));
  load(0.6);
  assert.deepEqual(relayoutTextFor(store, 'Inter').sort(), ['inter', 'mixed']);
  const after = store.getState().doc;
  assert.equal(after.nodes.inter.width, 30);
  assert.equal(after.nodes.roboto.width, 25, 'another family waits for its own face');
  assert.equal(after.nodes.fixed.width, 33, 'a fixed box keeps its size');
  assert.equal(store.canUndo(), false, 'not an undo step');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].source, 'edit');
  assert.deepEqual(Object.keys(patches[0].patch.nodes ?? {}).sort(), ['inter', 'mixed']);
  assert.deepEqual(relayoutTextFor(store, 'Inter'), [], 'idempotent');
});

test('font loads wait for a drag to end and skip faces that failed', () => {
  const {measurer, load} = loadingMeasurer();
  const store = createDesignStore({doc: docWith([textNode('t', 'hello', 'Inter'), createNode('RECTANGLE', {id: 'r'})], measurer), measurer});
  const listeners = new Set<(family: string) => void>();
  const fonts = {onLoad: (listener: (family: string) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }};
  const loaded = new Set<string>();
  const stop = watchFontLoads(store, fonts, [], family => loaded.has(family));
  const drag = store.gesture('Move');
  drag.update(tx => tx.update('r', {x: 50}));
  load(0.6);
  loaded.add('Inter');
  for (const listener of listeners) listener('Inter');
  assert.equal(drag.active, true, 'the drag goes on');
  assert.equal(store.getState().doc.nodes.t.width, 25);
  drag.commit();
  assert.equal(store.getState().doc.nodes.t.width, 30, 'measured once the drag ended');
  assert.equal(store.getState().history.undo, 'Move', 'the drag is still the undo step');

  // A face that failed to load also reports: the fallback must not overwrite real sizes.
  load(0.9);
  for (const listener of listeners) listener('Roboto');
  for (const listener of listeners) listener('Unknown');
  assert.equal(store.getState().doc.nodes.t.width, 30);
  stop();
  assert.equal(listeners.size, 0);
  assert.equal(familyLoaded('Inter', [{status: 'loaded', family: '"dz Inter"'} as FontFace]), true);
  assert.equal(familyLoaded('Inter', [{status: 'error', family: 'dz Inter'} as FontFace]), false);
});

test('the first paint waits for fonts at most the given time', async () => {
  const started = Date.now();
  await waitForFonts({ensure: () => new Promise(() => {})}, [{family: 'Inter', weight: 400, italic: false, size: 12}], 30);
  assert.ok(Date.now() - started < 1000);
  let ready = false;
  await waitForFonts({ensure: async () => void (ready = true)}, [{family: 'Inter', weight: 400, italic: false, size: 12}], 5000);
  assert.ok(ready);
});

test('a drawing tool hands back to "Move" after it created a layer', async () => {
  const {measurer} = loadingMeasurer();
  const store = createDesignStore({doc: createDocument('page'), measurer, tool: 'rectangle'});
  const queue: (() => void)[] = [];
  returnToMoveAfterDrawing(store, run => queue.push(run));
  store.transact('Property', tx => tx.update('page', {name: 'Cover'}));
  assert.equal(queue.length, 0, 'an edit that creates nothing keeps the tool');
  store.transact('Rectangle', tx => tx.create(createNode('RECTANGLE', {id: 'r'}), 'page'));
  assert.equal(store.getState().tool, 'rectangle', 'not inside the tool’s own handler');
  queue.shift()!();
  assert.equal(store.getState().tool, 'move');
  store.setTool('pen');
  store.transact('Vector', tx => tx.create(createNode('VECTOR', {id: 'v'}), 'page'));
  assert.equal(queue.length, 0, 'the pen keeps drawing');
});

test('the canvas index follows a drag whose frames share one rewritten node table', () => {
  const {measurer} = loadingMeasurer();
  const doc = docWith([createNode('RECTANGLE', {id: 'r', x: 0, y: 0, width: 100, height: 80})], measurer);
  const store = createDesignStore({doc, measurer});
  const index = new SpatialIndex();
  let pending: {from: DesignDocument; ids: Set<NodeId>} | null = null;
  store.onDocument(change => {
    pending ??= {from: index.document!, ids: new Set()};
    for (const id of change.changed) pending.ids.add(id);
  });
  const sync = (withHint: boolean) => {
    const result = index.sync(store.getState().doc, 'page', measurer, withHint && pending ? pending : undefined);
    pending = null;
    return result;
  };
  index.sync(doc, 'page', measurer);
  const drag = store.gesture('Move');
  const dirty: {x: number; y: number}[] = [];
  for (const [step, hinted] of [[50, true], [120, true], [200, false], [260, true]] as const) {
    drag.update(tx => tx.update('r', {x: step, y: step / 2}));
    const result = sync(hinted);
    dirty.push(...result.dirty.map(area => ({x: area.rect.x, y: area.rect.y})));
    assert.equal(index.bounds('r')?.x, step, `frame at ${step}: the index sees the node where it is now`);
  }
  assert.ok(dirty.some(area => area.x === 120) && dirty.some(area => area.x === 260), 'old and new places of each frame are reported');
  // A new node drawn by a gesture grows over several frames.
  const draw = store.gesture('Rectangle');
  for (const width of [10, 60, 300]) {
    draw.update(tx => tx.create(createNode('RECTANGLE', {id: 'n', x: -100, y: -100, width, height: width}), 'page'));
    sync(true);
    assert.equal(index.bounds('n')?.width, width);
  }
  draw.commit();
  sync(true);
  assert.equal(index.bounds('n')?.width, 300);
  assert.deepEqual(index.query({x: 150, y: 150, width: 1, height: 1}).sort(), ['n']);
});

// ── Autosave wiring ──────────────────────────────────────────────────────────────────────────────

function persistenceHarness(store: DesignStore, replies: {replace?: (base: number) => Promise<DesignSaved>} = {}) {
  const requests: {base: number; patch: DocumentPatch}[] = [];
  const replaces: number[] = [];
  const statuses: string[] = [];
  const persistence = attachPersistence(store, {
    fileId: 'f', baseVersion: 3, events: null,
    onStatus: status => statuses.push(status),
    onConflict: () => statuses.push('conflict!'),
    request: async (_id, base, patch) => {
      requests.push({base, patch});
      return {version: base + 1, updatedAt: ''};
    },
    replace: async (_id, base) => {
      replaces.push(base);
      return replies.replace ? replies.replace(base) : {version: base + 1, updatedAt: ''};
    },
    currentVersion: async () => 40,
  });
  return {persistence, requests, replaces, statuses};
}

test('autosave sends edits, not the server’s own copy, and flush says why it could not save', async () => {
  const {measurer} = loadingMeasurer();
  const store = createDesignStore({doc: createDocument('page'), measurer});
  const {persistence, requests} = persistenceHarness(store);
  store.transact('Rectangle', tx => tx.create(createNode('RECTANGLE', {id: 'r'}), 'page'));
  assert.equal(persistence.dirty(), true);
  await persistence.flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].base, 3);
  assert.equal(persistence.version(), 4);
  assert.equal(persistence.dirty(), false);

  // A restored or reloaded copy is shown, not sent back; saving continues from its version.
  const server = createDocument('page');
  persistence.adopt(server, 10);
  assert.equal(store.getState().doc.nodes.r, undefined);
  assert.equal(persistence.dirty(), false);
  store.transact('Ellipse', tx => tx.create(createNode('ELLIPSE', {id: 'e'}), 'page'));
  await persistence.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].base, 10);
  // A replace that did not come from the server (a local import) is saved like any edit.
  store.replaceDocument(createDocument('page'));
  await persistence.flush();
  assert.equal(requests.length, 3);
  persistence.close();
  store.transact('Rectangle', tx => tx.create(createNode('RECTANGLE', {id: 'late'}), 'page'));
  await persistence.flush();
  assert.equal(requests.length, 3, 'a file in the trash takes no more saves');
  persistence.dispose();
  assert.match(saveFailureMessage('offline'), /No connection/);
  assert.match(saveFailureMessage('conflict'), /another tab/);
});

test('"Keep mine" writes the whole document over newer copies and saving goes on', async () => {
  const {measurer} = loadingMeasurer();
  const store = createDesignStore({doc: createDocument('page'), measurer});
  let conflicts = 1;
  const {persistence, replaces, requests} = persistenceHarness(store, {replace: async base => {
    if (conflicts-- > 0) throw Object.assign(new Error('conflict'), {status: 409, details: {code: 'version_conflict', currentVersion: base + 5}});
    return {version: base + 1, updatedAt: ''};
  }});
  await persistence.keepMine(7);
  assert.deepEqual(replaces, [7, 12], 'someone saved again meanwhile: written over that one too');
  assert.equal(persistence.version(), 13);
  store.transact('Rectangle', tx => tx.create(createNode('RECTANGLE', {id: 'r'}), 'page'));
  await persistence.flush();
  assert.equal(requests.at(-1)?.base, 13);
  await persistence.keepMine(null);
  assert.equal(replaces.at(-1), 40, 'an unknown version is read from the server');
  persistence.dispose();
});

test('a failed "Keep mine" keeps the changes unsaved: the tab still warns before it closes, and the next attempt saves them', async () => {
  const {measurer} = loadingMeasurer();
  const store = createDesignStore({doc: createDocument('page'), measurer});
  let online = false;
  const statuses: string[] = [];
  const persistence = attachPersistence(store, {
    fileId: 'f', baseVersion: 3, events: null,
    onStatus: status => statuses.push(status),
    onConflict: () => statuses.push('conflict!'),
    // Another tab saved first: the edit's save is refused as a conflict, and saving stops.
    request: async () => {
      throw Object.assign(new Error('conflict'), {status: 409, details: {code: 'version_conflict', currentVersion: 9}});
    },
    replace: async (_id, base) => {
      if (!online) throw new TypeError('Failed to fetch');
      return {version: base + 1, updatedAt: ''};
    },
    currentVersion: async () => 9,
  });
  store.transact('Rectangle', tx => tx.create(createNode('RECTANGLE', {id: 'r'}), 'page'));
  await assert.rejects(persistence.flush());
  assert.ok(statuses.includes('conflict!'));
  assert.equal(persistence.dirty(), true);
  await assert.rejects(persistence.keepMine(9), /Failed to fetch/);
  assert.equal(persistence.dirty(), true, 'the close guard still sees the unsaved rectangle');
  online = true;
  await persistence.keepMine(9);
  assert.equal(persistence.dirty(), false);
  assert.equal(persistence.version(), 10);
  persistence.dispose();
});

test('a change too big for one PATCH is saved as the whole document, and saving goes on from its version', async () => {
  const {measurer} = loadingMeasurer();
  const store = createDesignStore({doc: createDocument('page'), measurer});
  const replaced: unknown[] = [];
  const patches: number[] = [];
  const persistence = attachPersistence(store, {
    fileId: 'f', baseVersion: 3, events: null, onStatus: () => {}, onConflict: () => {},
    request: async (_id, base, patch) => {
      if (Object.keys(patch.nodes ?? {}).length > 2) throw Object.assign(new Error('The change is too large to save in one go.'), {status: 413, details: {code: 'design_document_too_large'}});
      patches.push(base);
      return {version: base + 1, updatedAt: ''};
    },
    replace: async (_id, base, doc) => {
      replaced.push(Object.keys(doc.nodes).length);
      return {version: base + 10, updatedAt: ''};
    },
  });
  store.transact('Paste', tx => {
    for (const id of ['a', 'b', 'c']) tx.create(createNode('RECTANGLE', {id}), 'page');
  });
  await persistence.flush();
  assert.deepEqual(replaced, [4], 'the page and its three layers went whole');
  assert.equal(persistence.version(), 13);
  store.transact('Rectangle', tx => tx.create(createNode('RECTANGLE', {id: 'd'}), 'page'));
  await persistence.flush();
  assert.deepEqual(patches, [13], 'then patches again, on the stored version');
  persistence.dispose();
});

// ── Card picture ─────────────────────────────────────────────────────────────────────────────────

test('the card picture is taken after 3 s of quiet, at most once a minute, and on leaving', async () => {
  let clock = 0;
  const due: {at: number; run: () => void; id: number}[] = [];
  let next = 1;
  const timers = {
    setTimeout: (run: () => void, ms: number) => {
      const id = next++;
      due.push({at: clock + ms, run, id});
      return id;
    },
    clearTimeout: (id: unknown) => {
      const at = due.findIndex(entry => entry.id === id);
      if (at >= 0) due.splice(at, 1);
    },
  };
  const advance = async (ms: number) => {
    clock += ms;
    for (let entry = due.sort((a, b) => a.at - b.at)[0]; entry && entry.at <= clock; entry = due.sort((a, b) => a.at - b.at)[0]) {
      due.shift();
      entry.run();
      await Promise.resolve();
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  const uploads: number[] = [];
  const scheduler = createThumbnailScheduler({
    getDoc: () => createDocument('page'),
    render: async () => new Blob(['x']),
    upload: async () => void uploads.push(clock),
    timers,
    now: () => clock,
  });
  scheduler.noteEdit();
  await advance(2000);
  scheduler.noteEdit();
  await advance(2999);
  assert.deepEqual(uploads, [], 'each edit restarts the quiet time');
  await advance(1);
  assert.deepEqual(uploads, [5000]);
  scheduler.noteEdit();
  await advance(3000);
  assert.deepEqual(uploads, [5000], 'not twice within a minute');
  await advance(57_000);
  assert.deepEqual(uploads, [5000, 65_000]);
  assert.equal(scheduler.dirty, false);
  scheduler.noteEdit();
  await scheduler.flush();
  assert.deepEqual(uploads, [5000, 65_000, 65_000], 'leaving pictures pending edits at once');
  await scheduler.flush();
  assert.equal(uploads.length, 3, 'nothing new, nothing sent');
  scheduler.dispose();
});

// ── Preferences ──────────────────────────────────────────────────────────────────────────────────

test('preferences keep only well-formed values', () => {
  assert.deepEqual(parsePreferences(null), DEFAULT_PREFERENCES);
  const parsed = parsePreferences({nudgeSmall: 2, nudgeLarge: -1, snapToObjects: 'yes', hoverSizes: true, view: {rulers: true, outlines: true}, recentCommands: ['group', 5, 'x'.repeat(200)]});
  assert.equal(parsed.nudgeSmall, 2);
  assert.equal(parsed.nudgeLarge, 10);
  assert.equal(parsed.snapToObjects, true);
  assert.equal(parsed.hoverSizes, true);
  assert.equal(parsed.view.rulers, true);
  assert.equal('outlines' in parsed.view, false);
  assert.deepEqual(parsed.recentCommands, ['group']);
  assert.equal(parsed.view.multiplayerCursors, true, 'others\' cursors show unless turned off');
  assert.equal(parsePreferences({view: {multiplayerCursors: false}}).view.multiplayerCursors, false);
});
