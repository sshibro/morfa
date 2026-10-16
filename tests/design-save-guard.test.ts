import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import {checkPatchedDocument, patchedDocumentIssues, patchIssues, validateDocument, validatePatch} from '../shared/design/schema';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import {attachPersistence, type SaveRecovered, type SaveStopped} from '../src/design/editor/editor-session';
import type {AutosaveStatus} from '../src/design/persistence/autosave';
import {createSavedState, inspectPatch, refusedEntry} from '../src/design/persistence/patch-guard';
import {recoveryMessage} from '../src/design/persistence/recovery';

// Saving that never loses work (src/design/persistence/patch-guard.ts, recovery.ts, autosave.ts): a value the server
// would refuse is caught before it is sent, put back as the server has it (no undo step), the user is told once,
// and everything else saves. A refusal the client could not foresee (a picture of another account) is put back
// from the server's answer. A value refused again after that stops saving with "Saving stopped".

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

const badLink = (node: SceneNode): SceneNode => ({
  ...node,
  reactions: [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'javascript:alert(1)', openInNewTab: true}]}],
});

type Refusal = Error & {status: number; details: Record<string, unknown>};
const refusal = (status: number, message: string, details: Record<string, unknown>): Refusal =>
  Object.assign(new Error(message), {status, details: {code: 'design_document_invalid', ...details}});

/** The server's PATCH step with the shared schema (server/design/files.ts): the body as JSON, the patch's entries,
 *  then the invariants, refused in its words with `path` and `entry`. `extra` adds a refusal of its own. */
function fakeServer(initial: DesignDocument, extra?: (patch: DocumentPatch, doc: DesignDocument) => Refusal | null) {
  let doc = structuredClone(initial),
    version = 1;
  const requests: DocumentPatch[] = [];
  const refused: string[] = [];
  const fail = (result: {error: string; path: string; entry?: unknown}) => {
    refused.push(result.path);
    return refusal(400, 'File not saved: ' + result.error.replace(/\.$/, '') + '.', {path: result.path, ...(result.entry ? {entry: result.entry} : {})});
  };
  return {
    requests,
    refused,
    get doc() {
      return doc;
    },
    get version() {
      return version;
    },
    async request(_id: string, base: number, patch: DocumentPatch): Promise<{version: number; updatedAt: string}> {
      requests.push(patch);
      if (base !== version) throw refusal(409, 'Conflict', {code: 'version_conflict', currentVersion: version});
      const shape = validatePatch(JSON.parse(JSON.stringify(patch)));
      if (!shape.ok) throw fail(shape);
      const next = applyPatch(doc, shape.value);
      const checked = checkPatchedDocument(doc, next, shape.value);
      if (!checked.ok) throw fail(checked);
      const own = extra?.(shape.value, doc);
      if (own) {
        refused.push(String(own.details.path));
        throw own;
      }
      doc = next;
      version++;
      return {version, updatedAt: ''};
    },
  };
}

function editor(doc: DesignDocument, extra?: Parameters<typeof fakeServer>[1]) {
  const store = createDesignStore({doc, measurer});
  const server = fakeServer(doc, extra);
  const statuses: AutosaveStatus[] = [];
  const recovered: SaveRecovered[] = [];
  const stopped: SaveStopped[] = [];
  const persistence = attachPersistence(store, {
    fileId: 'f',
    baseVersion: 1,
    events: null,
    onStatus: status => statuses.push(status),
    onConflict: () => assert.fail('no conflict expected'),
    request: (id, base, patch) => server.request(id, base, patch),
    onRecovered: report => recovered.push(report),
    onStopped: report => stopped.push(report),
  });
  const flush = () => persistence.flush().then(() => true, () => false);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  return {store, server, persistence, statuses, recovered, stopped, flush, tick};
}

const base = () => {
  const doc = createDocument('page');
  const tx = createDesignStore({doc, measurer});
  tx.transact('setup', t => {
    t.create(createNode('RECTANGLE', {id: 'a', name: 'Card', x: 10, y: 10, width: 100, height: 50}), 'page');
    t.create(createNode('FRAME', {id: 'frame', name: 'Screen', x: 200, y: 0, width: 375, height: 812}), 'page');
  });
  return tx.getState().doc;
};
const ids = (doc: DesignDocument) => Object.keys(doc.nodes).sort();

// ── The shared checks ─────────────────────────────────────────────────────────────────────────────

test('patchIssues names every refused entry without changing the patch', () => {
  const good = createNode('RECTANGLE', {id: 'good', parentId: 'page'}) as SceneNode & {extra?: string};
  good.extra = 'kept';
  const patch: DocumentPatch = {
    nodes: {good, bad: badLink(createNode('RECTANGLE', {id: 'bad', parentId: 'page'})), 'odd.id': {...createNode('ELLIPSE', {id: 'odd.id', parentId: 'page'}), opacity: 7}},
    styles: {s1: {id: 's1', type: 'FILL', name: 'x'.repeat(600), description: ''}},
    images: {img: {url: 'https://evil.example/x.png', width: 10, height: 10}},
  };
  const issues = patchIssues(patch);
  assert.deepEqual(issues.map(issue => `${issue.table}:${issue.key}`).sort(), ['images:img', 'nodes:bad', 'nodes:odd.id', 'styles:s1']);
  const link = issues.find(issue => issue.key === 'bad')!;
  assert.match(link.error, /http/);
  assert.equal(link.path, 'nodes.bad.reactions.0.actions.0.url');
  assert.equal(issues.find(issue => issue.key === 'odd.id')!.path, 'nodes.odd.id.opacity', 'an id with dots is one key');
  assert.equal(good.extra, 'kept', 'unknown keys stay: the editor’s objects are never written to');
  assert.deepEqual(patchIssues({nodes: {good: createNode('RECTANGLE', {id: 'good', parentId: 'page'})}}), []);
});

test('the invariants name the patched entry they are about, every one of them', () => {
  const before = base();
  const orphan = createNode('RECTANGLE', {id: 'orphan', parentId: 'missing'});
  const loose = createNode('RECTANGLE', {id: 'loose', parentId: 'frame'});
  const after = applyPatch(before, {nodes: {orphan, loose}});
  const issues = patchedDocumentIssues({pages: before.pages, node: id => before.nodes[id]}, after, {nodes: {orphan, loose}});
  assert.deepEqual(issues.map(issue => issue.key).sort(), ['loose', 'orphan']);
  assert.ok(issues.every(issue => issue.table === 'nodes' && issue.error.length > 0));
  // The server's single answer carries the entry too (PATCH and PUT alike).
  const single = checkPatchedDocument(before, after, {nodes: {orphan, loose}});
  assert.equal(single.ok, false);
  assert.ok(!single.ok && single.entry?.table === 'nodes' && ['orphan', 'loose'].includes(single.entry.key!));
  const whole = validateDocument({...after});
  assert.ok(!whole.ok && whole.entry?.table === 'nodes', JSON.stringify(whole));
  const shape = validatePatch({nodes: {bad: badLink(createNode('RECTANGLE', {id: 'bad', parentId: 'page'}))}});
  assert.ok(!shape.ok && shape.entry?.key === 'bad' && shape.path.startsWith('nodes.bad.'));
});

test('a server refusal names its entry, or the patched key its path points into', () => {
  const patch: DocumentPatch = {nodes: {'a.b': createNode('RECTANGLE', {id: 'a.b'}), a: createNode('RECTANGLE', {id: 'a'})}};
  const withEntry = refusal(400, 'File not saved: Invalid value.', {path: 'nodes.a.b.fills', entry: {table: 'nodes', key: 'a.b'}});
  assert.deepEqual({...refusedEntry(withEntry, patch)!, error: ''}, {table: 'nodes', key: 'a.b', path: 'nodes.a.b.fills', error: ''});
  assert.equal(refusedEntry(withEntry, patch)!.error, 'Invalid value.');
  assert.equal(refusedEntry(refusal(400, 'x', {path: 'nodes.a.b.fills.0'}), patch)!.key, 'a.b', 'the longest key wins');
  assert.equal(refusedEntry(refusal(400, 'x', {path: 'nodes.a.x'}), patch)!.key, 'a');
  assert.equal(refusedEntry(refusal(403, 'x', {path: 'images.r1', entry: {table: 'images', key: 'r1'}}), {})!.table, 'images');
  assert.equal(refusedEntry(refusal(400, 'x', {path: 'nodes'}), patch), null, 'the whole table: nothing to put back');
  assert.equal(refusedEntry(new Error('network'), patch), null);
});

// ── Recovery in the editor ────────────────────────────────────────────────────────────────────────

test('a stream of edits with one bad layer: the rest saves, the layer is taken away and the user told once', async () => {
  const e = editor(base());
  e.store.transact('Paste', tx => tx.create(badLink(createNode('RECTANGLE', {id: 'bad', name: 'Button'})), 'page'));
  e.store.transact('Rename', tx => tx.update('a', {name: 'Card 2'}));
  e.store.transact('Rectangle', tx => tx.create(createNode('RECTANGLE', {id: 'c', name: 'Background'}), 'frame'));
  assert.equal(await e.flush(), true);
  await e.tick();
  assert.equal(e.server.refused.length, 0, 'nothing refused reached the server');
  assert.equal(e.server.doc.nodes.a.name, 'Card 2');
  assert.ok(e.server.doc.nodes.c, 'the later layer is saved');
  assert.equal(e.server.doc.nodes.bad, undefined);
  assert.equal(e.store.getState().doc.nodes.bad, undefined, 'the bad layer left the editor too');
  assert.deepEqual(e.store.getState().doc.nodes.page.children, e.server.doc.nodes.page.children);
  assert.equal(e.recovered.length, 1);
  assert.match(e.recovered[0].message, /^Could not save layer "Button": .+\. The change was reverted\.$/);
  assert.equal(e.store.getState().history.undo, 'Rectangle', 'the recovery is no undo step');
  assert.equal(e.statuses.at(-1), 'saved');
  // Work goes on and saves; nobody is told again.
  e.store.transact('Rename', tx => tx.update('c', {name: 'Background 2'}));
  assert.equal(await e.flush(), true);
  await e.tick();
  assert.equal(e.server.doc.nodes.c.name, 'Background 2');
  assert.equal(e.recovered.length, 1);
  assert.deepEqual(ids(e.server.doc), ids(e.store.getState().doc));
});

test('a saved layer edited into a value the server refuses gets its saved properties back; other edits stay', async () => {
  const e = editor(base());
  e.store.transact('Edit', tx => {
    tx.update('a', {opacity: 3, x: 55});
    tx.update('frame', {name: 'Login screen'});
  });
  assert.equal(await e.flush(), true);
  await e.tick();
  const a = e.store.getState().doc.nodes.a;
  assert.equal(a.opacity, 1);
  assert.equal(a.x, 10, 'the whole layer is as the server has it');
  assert.equal(e.server.doc.nodes.frame.name, 'Login screen');
  assert.equal(e.recovered.length, 1);
  assert.match(e.recovered[0].message, /^Could not save layer "Card": .+\. The change was reverted\.$/);
  // A layer that moved into a new parent and went bad goes back to where it was saved.
  e.store.transact('Move', tx => {
    tx.move('a', 'frame');
    tx.update('a', {name: 'n'.repeat(600)});
  });
  assert.equal(await e.flush(), true);
  await e.tick();
  assert.equal(e.store.getState().doc.nodes.a.parentId, 'page');
  assert.equal(e.store.getState().doc.nodes.a.name, 'Card');
  assert.deepEqual(e.store.getState().doc.nodes.page.children, e.server.doc.nodes.page.children);
});

test('a new parent goes with its subtree, but layers saved before move back out instead of being lost', async () => {
  const e = editor(base());
  e.store.transact('Group', tx => {
    tx.create({...createNode('FRAME', {id: 'box', name: 'Block'}), opacity: -1}, 'page');
    tx.create(createNode('TEXT', {id: 'label', name: 'Label', text: defaultTextProps('Hello')}), 'box');
    tx.move('a', 'box');
  });
  assert.equal(await e.flush(), true);
  await e.tick();
  const doc = e.store.getState().doc;
  assert.equal(doc.nodes.box, undefined);
  assert.equal(doc.nodes.label, undefined, 'the new layer inside the refused one went with it');
  assert.equal(doc.nodes.a?.parentId, 'page', 'the saved layer is back on the page');
  assert.ok(e.server.doc.nodes.a);
  assert.deepEqual(ids(e.server.doc), ids(doc));
  assert.equal(validateDocument(structuredClone(doc)).ok, true);
  // A bad layer inside a good new parent: only the bad one goes.
  e.store.transact('Paste', tx => {
    tx.create(createNode('FRAME', {id: 'card', name: 'Panel'}), 'page');
    tx.create(badLink(createNode('RECTANGLE', {id: 'cta', name: 'Buy'})), 'card');
    tx.create(createNode('RECTANGLE', {id: 'pic', name: 'Photo'}), 'card');
  });
  assert.equal(await e.flush(), true);
  await e.tick();
  assert.deepEqual(e.server.doc.nodes.card.children, ['pic']);
  assert.equal(e.store.getState().doc.nodes.cta, undefined);
  assert.equal(e.recovered.length, 2);
});

test('a refusal only the server can make (a picture of another account) is put back from its answer', async () => {
  const foreign = (patch: DocumentPatch) => {
    const ref = Object.entries(patch.images ?? {}).find(([, asset]) => asset && !asset.url.startsWith('/uploads/dz-mine'))?.[0];
    return ref === undefined ? null : refusal(403, 'The image is not available to this account. Upload your own copy.', {path: `images.${ref}`, entry: {table: 'images', key: ref}});
  };
  const e = editor(base(), foreign);
  e.store.transact('Paste', tx => {
    tx.setImage('dz-theirs', {url: '/uploads/dz-theirs.webp', width: 10, height: 10, name: 'Photo.jpg'});
    tx.create({...createNode('RECTANGLE', {id: 'photo', name: 'Photo'}), fills: [{type: 'IMAGE', imageRef: 'dz-theirs', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]}, 'page');
  });
  e.store.transact('Rename', tx => tx.update('a', {name: 'Card 3'}));
  assert.equal(await e.flush(), true);
  await e.tick();
  assert.deepEqual(e.server.refused, ['images.dz-theirs']);
  assert.equal(e.server.requests.length, 2, 'refused once, then the rest went');
  assert.ok(e.server.doc.nodes.photo, 'the layer itself is saved');
  assert.equal(e.server.doc.nodes.a.name, 'Card 3');
  assert.equal(e.server.doc.images['dz-theirs'], undefined);
  assert.equal(e.store.getState().doc.images['dz-theirs'], undefined);
  assert.equal(e.recovered.length, 1);
  assert.equal(e.recovered[0].message, 'Could not save image "Photo.jpg": the image is not available to this account. Upload your own copy. The change was reverted.');
});

test('a value refused again after it was put back stops saving: never a loop, never silent', async () => {
  // A server that refuses the layer "a" whatever it holds (a check this side does not know).
  const stubborn = (patch: DocumentPatch) => (patch.nodes && 'a' in patch.nodes ? refusal(400, 'File not saved: The layer is locked.', {path: 'nodes.a', entry: {table: 'nodes', key: 'a'}}) : null);
  const e = editor(base(), stubborn);
  e.store.transact('Edit', tx => {
    tx.update('a', {name: 'New name'});
    tx.update('frame', {name: 'Screen 2'});
  });
  assert.equal(await e.flush(), false);
  await e.tick();
  assert.equal(e.server.requests.length, 2, 'one recovery, one more try, then stop');
  assert.equal(e.statuses.at(-1), 'stopped');
  assert.equal(e.stopped.length, 1);
  assert.equal(e.stopped[0].message, 'Could not save layer "Card": the layer is locked.');
  assert.ok(e.persistence.stopped(), 'the editor can show the banner again after a remount');
  // Later work is kept in the editor, never sent, and leaving says why.
  e.store.transact('More', tx => tx.update('frame', {name: 'Screen 3'}));
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.equal(e.server.requests.length, 2);
  assert.equal(e.persistence.dirty(), true);
  await assert.rejects(e.persistence.flush(), /Saving stopped/);
  // "Reload file": the stored copy, and saving starts again.
  e.persistence.adopt(e.server.doc, e.server.version);
  assert.equal(e.persistence.stopped(), null);
  e.store.transact('After', tx => tx.update('frame', {name: 'Screen 4'}));
  assert.equal(await e.flush(), true);
  assert.equal(e.server.doc.nodes.frame.name, 'Screen 4');
});

test('a refusal that names nothing to put back stops saving with the server’s words', async () => {
  const whole = () => refusal(400, 'File not saved: The file has more than 50000 layers.', {path: 'nodes'});
  const e = editor(base(), whole);
  e.store.transact('Edit', tx => tx.update('a', {name: 'x'}));
  assert.equal(await e.flush(), false);
  assert.equal(e.stopped.length, 1);
  assert.equal(e.stopped[0].message, 'File not saved: The file has more than 50000 layers.');
  assert.equal(e.server.requests.length, 1);
});

test('messages: one entry, several, plurals', () => {
  const layer = (name: string) => ({kind: 'layer' as const, name, removed: true, error: 'Invalid value.'});
  assert.equal(recoveryMessage([layer('Button')]), 'Could not save layer "Button": invalid value. The change was reverted.');
  assert.equal(recoveryMessage([layer('A'), layer('B')]), 'Could not save 2 changes (layer "A", layer "B"): invalid value. The changes were reverted.');
  assert.equal(recoveryMessage([layer('A'), layer('B'), layer('C'), layer('D'), layer('E')]), 'Could not save 5 changes (layer "A", layer "B" and 3 more): invalid value. The changes were reverted.');
  assert.match(recoveryMessage([layer('z'.repeat(80))]), /"z{39}…"/);
});

// ── Cost ──────────────────────────────────────────────────────────────────────────────────────────

/** 40 screens × 10 sections × a group of 48 layers: 20 041 nodes (tests/design-perf.test.ts). */
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
    const screen = add('FRAME', 'page', {x: (s % 8) * 1600, y: Math.floor(s / 8) * 2200, width: 1440, height: 2000});
    for (let k = 0; k < 10; k++) {
      const section = add('FRAME', screen, {y: k * 200, width: 1440, height: 200});
      const group = add('GROUP', section, {x: 20, y: 20, width: 1400, height: 160});
      for (let i = 0; i < 48; i++) {
        const type = kinds[i % kinds.length];
        add(type, group, {x: 20 + (i % 12) * 110, y: 20 + Math.floor(i / 12) * 38, width: 100, height: type === 'LINE' ? 0 : 30, ...(type === 'TEXT' ? {text: defaultTextProps('Text')} : {})});
      }
    }
  }
  return doc;
}

/** How much slower than the reference machine this one runs right now (tests/design-perf.test.ts). */
function speedFactor(): number {
  let best = Infinity;
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    const table: Record<string, {id: string; x: number}> = {};
    for (let i = 0; i < 20000; i++) table[`k${i}`] = {id: `k${i}`, x: i};
    let sum = 0;
    for (let i = 0; i < 300000; i++) sum += Math.sqrt(i) * Math.sin(i);
    assert.ok(Object.keys(table).length && Number.isFinite(sum));
    best = Math.min(best, performance.now() - started);
  }
  return Math.max(1, best / 15);
}

test('the check costs well under 2 ms for a typical save of a 20 000-layer file', () => {
  const store: DesignStore = createDesignStore({doc: heavyPage(), measurer});
  const saved = createSavedState();
  let last: DocumentPatch = {};
  store.onPatch(event => {
    saved.note(event.patch, {inverse: event.inverse, after: event.doc});
    last = event.patch;
  });
  const factor = speedFactor();
  const measure = (edit: () => void) => {
    const times: number[] = [];
    for (let run = 0; run < 15; run++) {
      edit();
      const started = performance.now();
      assert.deepEqual(inspectPatch(last, saved), []);
      times.push(performance.now() - started);
    }
    return times.sort((a, b) => a - b)[7];
  };
  let step = 0;
  const drag = measure(() => store.transact('Move', tx => {
    step++;
    for (let i = 0; i < 12; i++) tx.update(`n${4 + i}`, {x: 10 + step + i});
  }));
  const typing = measure(() => store.transact('Text', tx => {
    const node = tx.get('n5')!;
    tx.update('n5', {text: {...node.text!, characters: node.text!.characters + 'a'}});
  }));
  assert.ok(drag <= 2 * factor, `a drag of 12 layers: ${drag.toFixed(3)} ms`);
  assert.ok(typing <= 2 * factor, `a keystroke: ${typing.toFixed(3)} ms`);
});
