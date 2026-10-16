import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {EMPTY_PRESENCE, type DesignPeer, type DesignPresencePost} from '../shared/design/live';
import {rebaseLocal} from '../shared/design/merge';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import {attachPersistence} from '../src/design/editor/editor-session';
import {createLocalPresence, createPeerStore, PRESENCE_LINGER_MS} from '../src/design/realtime/presence';
import {followedViewport} from '../src/design/realtime/presence-bridge';
import {parseEvents, StreamRefused, type StreamEvent} from '../src/design/realtime/stream';
import {REMOTE_APPLY_MAX_MS, REMOTE_APPLY_MS, startLiveSession} from '../src/design/realtime/live-session';
import type {DesignFileOpened} from '../shared/design/api';
import {selectionThroughEdit} from '../src/design/engine/text-editor/model';
import {initials} from '../src/design/realtime/presence';
import {memoryQueue, scriptedTransport, testIdentity, TRANSPORTS, type Attempt, type TransportKind} from './helpers/live-transports';
import {composeChanges} from '../src/design/realtime/transport/frame-decoder';
import {resolveChanges} from '../src/design/realtime/fields';
import type {LiveChange} from '../src/design/realtime/transport/types';
import type {ProtocolChange} from '../shared/design/protocol';

// The editor's side of co-editing that runs without a network (src/design/realtime): presence posts are coalesced and
// throttled, the roster changes only when people come, go or change page (never on a cursor move), following fits the
// other viewport, the caret stays on its characters through someone else's edit, the stream parser, and the cost of a
// remote change on a 20 000-layer file.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

/** A clock the test moves by hand. */
function clock() {
  let now = 0;
  const timers = new Map<number, {at: number; run: () => void}>();
  let next = 1;
  return {
    timers: {
      now: () => now,
      setTimeout: (run: () => void, ms: number) => {
        timers.set(next, {at: now + ms, run});
        return next++;
      },
      clearTimeout: (handle: unknown) => void timers.delete(handle as number),
    },
    /** Time passing inside a synchronous step (work that takes `ms`). */
    spend(ms: number) {
      now += ms;
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = until;
    },
  };
}

test('presence: a burst of cursor moves becomes a few posts carrying only what changed, the last position always sent', async () => {
  const time = clock();
  const posts: DesignPresencePost[] = [];
  const presence = createLocalPresence(async post => {
    posts.push(post);
    return true;
  }, {intervalMs: 60, timers: time.timers});
  presence.set({page: 'p1', selection: ['a'], selectionCount: 1});
  presence.connected('secret-token-0123456789');
  await time.advance(0);
  assert.equal(posts.length, 1, 'connecting sends the whole state');
  assert.deepEqual(posts[0], {token: 'secret-token-0123456789', cursor: null, page: 'p1', selection: ['a'], selectionCount: 1, viewport: null, editing: null});
  // 100 pointer moves over one second: one post per 60 ms at most.
  for (let i = 0; i < 100; i++) {
    presence.set({cursor: {x: i, y: i * 2}});
    await time.advance(10);
  }
  await time.advance(200);
  const cursorPosts = posts.slice(1);
  assert.ok(cursorPosts.length >= 14 && cursorPosts.length <= 18, `posts: ${cursorPosts.length}`);
  assert.ok(cursorPosts.every(post => Object.keys(post).sort().join() === 'cursor,token'), 'only the cursor travels');
  assert.deepEqual(cursorPosts.at(-1)!.cursor, {x: 99, y: 198}, 'the last position arrives');
  // Nothing changes: nothing is sent.
  const before = posts.length;
  presence.set({cursor: {x: 99, y: 198}});
  await time.advance(500);
  assert.equal(posts.length, before);
  // A closed stream: posts wait for the next one, which gets everything again.
  presence.disconnected();
  presence.set({page: 'p2'});
  await time.advance(500);
  assert.equal(posts.length, before);
  presence.connected('secret-token-abcdefghij');
  await time.advance(100);
  assert.equal(posts.at(-1)!.page, 'p2');
  assert.deepEqual(posts.at(-1)!.cursor, {x: 99, y: 198});
  presence.dispose();
});

test('presence: a post refused as gone reports the stream lost', async () => {
  const time = clock();
  let gone = 0;
  const presence = createLocalPresence(async () => false, {timers: time.timers, onGone: () => gone++});
  presence.connected('secret-token-0123456789');
  await time.advance(0);
  assert.equal(gone, 1);
  presence.dispose();
});

const peer = (connection: string, user: string, extra: Partial<DesignPeer> = {}): DesignPeer => ({...EMPTY_PRESENCE, connection, user, name: user, color: 0, role: 'editor', page: 'p1', ...extra});

test('roster: people grouped across tabs, in join order; cursor moves never change it', async () => {
  const time = clock();
  const peers = createPeerStore({timers: time.timers});
  let rosterChanges = 0, motion = 0;
  peers.subscribeRoster(() => rosterChanges++);
  peers.subscribeMotion(() => motion++);
  peers.reset([peer('c1', 'anna'), peer('c2', 'boris'), peer('c3', 'anna'), peer('me', 'me')], {connection: 'me', user: 'me'});
  assert.deepEqual(peers.roster().map(entry => [entry.user, entry.connections.length]), [['anna', 2], ['boris', 1]]);
  const roster = peers.roster();
  for (let i = 0; i < 50; i++) peers.update([peer('c1', 'anna', {cursor: {x: i, y: i}})]);
  assert.equal(peers.roster(), roster, 'the same roster object: avatars do not re-render');
  assert.equal(rosterChanges, 1);
  assert.equal(motion, 51);
  peers.update([peer('c2', 'boris', {page: 'p2'})]);
  assert.equal(peers.roster()[1].page, 'p2', 'a page change reaches the avatars');
  // My other tab is listed last and marked.
  peers.update([peer('c4', 'me')]);
  assert.deepEqual(peers.roster().map(entry => [entry.user, entry.self]), [['anna', false], ['boris', false], ['me', true]]);
  // Following ends when the followed person is gone: a moment after their last connection left (they may be reconnecting).
  peers.follow('c2');
  assert.equal(peers.following(), 'c2');
  peers.leave('c2');
  assert.equal(peers.following(), 'c2');
  await time.advance(PRESENCE_LINGER_MS);
  assert.equal(peers.following(), null);
  assert.deepEqual(peers.roster().map(entry => entry.user), ['anna', 'me']);
  // One of two tabs leaving goes at once.
  peers.leave('c3');
  assert.deepEqual(peers.roster().map(entry => [entry.user, entry.connections.length]), [['anna', 1], ['me', 1]]);
});

test('roster: someone reconnecting, or this editor reconnecting, never makes the avatars go and come back', async () => {
  // The avatars are keyed by person and fade in when they appear: a stream that drops and comes back (a server restarting, a
  // network change) emptied the roster for half a second, and every avatar, cursor and selection blinked.
  const time = clock();
  const peers = createPeerStore({timers: time.timers});
  let rosterChanges = 0;
  peers.subscribeRoster(() => rosterChanges++);
  peers.reset([peer('c1', 'anna'), peer('c2', 'boris')], {connection: 'me', user: 'me'});
  peers.follow('c1');
  rosterChanges = 0;
  // Anna's stream drops; she is back on a new connection half a second later: the same person all along, still followed.
  peers.leave('c1');
  await time.advance(500);
  assert.deepEqual(peers.roster().map(entry => entry.user), ['anna', 'boris']);
  peers.update([peer('c9', 'anna', {cursor: {x: 1, y: 1}})]);
  assert.deepEqual(peers.roster().map(entry => [entry.user, entry.connections]), [['anna', ['c9']], ['boris', ['c2']]]);
  assert.equal(peers.following(), 'c9');
  assert.deepEqual([...peers.peers().keys()].sort(), ['c2', 'c9']);
  await time.advance(PRESENCE_LINGER_MS);
  assert.deepEqual(peers.roster().map(entry => entry.user), ['anna', 'boris']);
  // This editor's stream drops: everyone stays shown; the next hello says who is here, and Boris, gone meanwhile, goes a moment later.
  peers.stale();
  assert.deepEqual(peers.roster().map(entry => entry.user), ['anna', 'boris']);
  await time.advance(800);
  peers.reset([peer('c9', 'anna')], {connection: 'me2', user: 'me'});
  assert.deepEqual(peers.roster().map(entry => entry.user), ['anna', 'boris']);
  await time.advance(PRESENCE_LINGER_MS);
  assert.deepEqual(peers.roster().map(entry => entry.user), ['anna']);
  assert.equal(peers.following(), 'c9');
  // No step above re-listed Anna as someone new: her avatar never left.
  assert.ok(rosterChanges <= 3, `roster changes: ${rosterChanges}`);
  // Leaving the file for good (access lost, the editor closed) clears at once.
  peers.clear();
  assert.deepEqual(peers.roster(), []);
});

test('presence: an answer for a stream that went meanwhile neither ends the new stream nor counts as sent to it', async () => {
  // A post in flight when the stream dropped came back after the new one opened: "gone" aborted the new stream (a reconnect
  // loop), or "taken" marked the whole state sent, so the new stream never heard the page or selection.
  const time = clock();
  const posts: DesignPresencePost[] = [];
  const answers: ((ok: boolean) => void)[] = [];
  let gone = 0;
  const presence = createLocalPresence(post => {
    posts.push(post);
    return new Promise<boolean>(resolve => answers.push(resolve));
  }, {intervalMs: 60, timers: time.timers, onGone: () => gone++});
  presence.set({page: 'p1', selection: ['a'], selectionCount: 1});
  presence.connected('first-token-0123456789');
  await time.advance(0);
  presence.set({cursor: {x: 5, y: 5}});
  answers.shift()!(true);
  await time.advance(100);
  assert.equal(posts.length, 2);
  presence.disconnected();
  presence.connected('second-token-0123456789');
  answers.shift()!(false);
  await time.advance(100);
  assert.equal(gone, 0, 'the old stream’s "gone" is not the new one’s');
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[2], {token: 'second-token-0123456789', cursor: {x: 5, y: 5}, page: 'p1', selection: ['a'], selectionCount: 1, viewport: null, editing: null});
  presence.dispose();
});

test('following fits the other viewport around the same centre', () => {
  const theirs = {x: 100, y: 50, zoom: 2, width: 800, height: 600};
  // They see 400 × 300 page units from (100, 50): centre (300, 200).
  const same = followedViewport(theirs, {width: 800, height: 600});
  assert.deepEqual(same, {x: 100, y: 50, zoom: 2});
  const wide = followedViewport(theirs, {width: 1600, height: 600});
  assert.equal(wide.zoom, 2);
  assert.equal(wide.x + 1600 / 2 / wide.zoom, 300);
  const small = followedViewport(theirs, {width: 400, height: 300});
  assert.equal(small.zoom, 1);
  assert.equal(small.y + 300 / 2 / small.zoom, 200);
});

test('the caret stays on its characters when someone else edits the text', () => {
  const caret = (offset: number) => ({anchor: offset, focus: offset, affinity: 'downstream' as const});
  assert.equal(selectionThroughEdit('Hello world', 'Well, hello world', caret(11)).focus, 17, 'text typed before the caret moves it along');
  assert.equal(selectionThroughEdit('Hello world', 'Hello world!!!', caret(3)).focus, 3, 'text typed after stays out of the way');
  assert.equal(selectionThroughEdit('Hello world', 'Hell world', caret(8)).focus, 7);
  const range = selectionThroughEdit('abcdef', 'abXYZcdef', {anchor: 1, focus: 5, affinity: 'downstream'});
  assert.deepEqual([range.anchor, range.focus], [1, 8]);
  assert.equal(selectionThroughEdit('abcdef', 'abZf', caret(3)).focus, 3, 'inside a replaced part: to its end');
});

test('the stream parser: events, multi-line data, ids, comments and a tail kept for the next chunk', () => {
  const events: StreamEvent[] = [];
  let tail = parseEvents('event: hello\ndata: {"a":1}\n\n: hb\n\nevent: change\nid: 7\ndata: {"b":', event => events.push(event));
  assert.equal(events.length, 1);
  tail = parseEvents(tail + '2}\n\ndata: one\ndata: two\n\n', event => events.push(event));
  assert.equal(tail, '');
  assert.deepEqual(events, [
    {event: 'hello', data: '{"a":1}', id: null},
    {event: 'change', data: '{"b":2}', id: '7'},
    {event: 'message', data: 'one\ntwo', id: null},
  ]);
});

test('avatar initials', () => {
  assert.equal(initials('Anna Smith'), 'AS');
  assert.equal(initials('boris'), 'B');
  assert.equal(initials('  '), '?');
  assert.equal(initials('Maria Anna Ivanova'), 'MA');
});

// ── The session's decisions ──────────────────────────────────────────────────────────────────────

/** A live session over a scripted connection of `kind`: `attempts` is what the server sends on each connection attempt. */
function scripted(kind: TransportKind, attempts: Attempt[], open: () => Promise<DesignFileOpened>, setup?: (store: DesignStore, time: ReturnType<typeof clock>) => void) {
  const doc = createDocument('page');
  doc.nodes.r = createNode('RECTANGLE', {id: 'r', parentId: 'page'});
  doc.nodes.page.children = ['r'];
  const store = createDesignStore({doc, measurer, idle: () => () => {}});
  const persistence = attachPersistence(store, {fileId: 'f', baseVersion: 1, events: null, timers: {setTimeout: () => 1, clearTimeout: () => {}}, onStatus: () => {}, onConflict: () => {}, request: async () => ({version: 2, updatedAt: ''})});
  const happened: string[] = [];
  const time = clock();
  setup?.(store, time);
  const live = startLiveSession({
    fileId: 'f', store, persistence, version: 1, canEdit: true, timers: time.timers, network: null, queue: memoryQueue(), identity: testIdentity(),
    callbacks: {onAccess: access => happened.push('access:' + access.canEdit), onEnd: reason => happened.push('end:' + reason), onRename: name => happened.push('name:' + name)},
    transport: scriptedTransport(kind, attempts, open),
  });
  return {store, persistence, live, happened, time};
}
const event = (name: string, data: unknown): StreamEvent => ({event: name, data: JSON.stringify(data), id: null});
const hello = (canEdit = true) => event('hello', {connection: 'c1', token: 'secret-token-0123456789', version: 1, role: canEdit ? 'editor' : 'viewer', canEdit, user: 'me', name: 'Me', color: 0, peers: []});
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

for (const kind of TRANSPORTS) {
  test(`live session (${kind}): a changed role reopens, a rename shows, a removal ends`, async () => {
    const one = scripted(kind, [[hello(), event('file', {name: 'New name'}), event('access', {role: 'viewer', canEdit: false}), event('bye', {reason: 'access'})]], async () => assert.fail('no reload'));
    await flush();
    assert.deepEqual(one.happened, ['name:New name', 'access:false', 'end:access']);
    one.live.stop();
    // A hello that says read-only (demoted while away) reopens too.
    const two = scripted(kind, [[hello(false)]], async () => assert.fail('no reload'));
    await flush();
    assert.deepEqual(two.happened, ['access:false']);
    two.live.stop();
  });

  test(`live session (${kind}): a missing stream leaves only when the file is gone too`, async () => {
    const gone = scripted(kind, [new StreamRefused('File not found.', 404, 'not_found')], async () => Promise.reject(Object.assign(new Error('File not found.'), {status: 404})));
    await flush();
    assert.deepEqual(gone.happened, ['end:missing']);
    const older = scripted(kind, [new StreamRefused('Route not found.', 404, 'not_found')], async () => ({file: {id: 'f', name: 'f', version: 1, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}, document: createDocument('page')}));
    await flush();
    assert.deepEqual(older.happened, [], 'the editor stays without live changes');
    older.live.stop();
  });

  test(`live session (${kind}): changes apply in version order; a gap that does not close reloads the stored file`, async () => {
    let reloads = 0;
    const remoteDoc = createDocument('page');
    remoteDoc.nodes.r = createNode('RECTANGLE', {id: 'r', parentId: 'page', x: 77});
    remoteDoc.nodes.page.children = ['r'];
    const change = (version: number, x: number) => event('change', {version, patch: {nodes: {r: {...remoteDoc.nodes.r, x}}}, by: 'other', user: 'u'});
    const session = scripted(kind, [[hello(), change(3, 30), change(2, 20)]], async () => {
      reloads++;
      return {file: {id: 'f', name: 'f', version: 9, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}, document: remoteDoc};
    });
    await flush();
    assert.equal(session.store.getState().doc.nodes.r.x, 30, 'version 3 waited for version 2');
    assert.equal(session.live.version(), 3);
    assert.equal(session.store.canUndo(), false, 'remote changes are not undo steps');
    session.live.stop();
    const gap = scripted(kind, [[hello(), change(4, 40)]], async () => {
      reloads++;
      return {file: {id: 'f', name: 'f', version: 9, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}, document: remoteDoc};
    });
    await flush();
    assert.equal(gap.store.getState().doc.nodes.r.x, 0, 'version 4 waits for 2 and 3');
    await gap.time.advance(3_000);
    await flush();
    assert.equal(reloads, 1);
    assert.equal(gap.store.getState().doc.nodes.r.x, 77, 'the stored document');
    assert.equal(gap.live.version(), 9);
    gap.live.stop();
  });

  test(`live session (${kind}): a lone change applies at once, a burst from many people as one update ${REMOTE_APPLY_MS} ms later`, async () => {
    const r = createNode('RECTANGLE', {id: 'r', parentId: 'page'});
    const change = (version: number, x: number) => event('change', {version, patch: {nodes: {r: {...r, x}}}, by: 'other' + version, user: 'u' + version});
    const session = scripted(kind, [[hello(), change(2, 20), change(3, 30), change(4, 40), change(5, 50)]], async () => assert.fail('no reload'));
    let updates = 0;
    session.store.subscribe(() => updates++, {slice: 'doc'});
    await flush();
    assert.equal(session.store.getState().doc.nodes.r.x, 20, 'the first change at once');
    const first = updates;
    await session.time.advance(REMOTE_APPLY_MS - 1);
    await flush();
    assert.equal(session.store.getState().doc.nodes.r.x, 20, 'the rest wait for their turn');
    await session.time.advance(1);
    await flush();
    assert.equal(session.store.getState().doc.nodes.r.x, 50);
    assert.equal(session.live.version(), 5);
    assert.equal(updates - first, 1, 'three changes, one document update');
    session.live.stop();
  });

  test(`live session (${kind}): an update that takes long makes the next wait ten times as long, up to ${REMOTE_APPLY_MAX_MS} ms`, async () => {
    const r = createNode('RECTANGLE', {id: 'r', parentId: 'page'});
    const change = (version: number, x: number) => event('change', {version, patch: {nodes: {r: {...r, x}}}, by: 'other', user: 'u'});
    // Each document update takes 20 ms on this clock (a big file on a slow machine): the next waits 200 ms.
    const session = scripted(kind, [[hello(), change(2, 20), change(3, 30)]], async () => assert.fail('no reload'), (store, time) => {
      store.subscribe(() => time.spend(20), {slice: 'doc'});
    });
    await flush();
    assert.equal(session.store.getState().doc.nodes.r.x, 20);
    await session.time.advance(20 * 10 - 1);
    await flush();
    assert.equal(session.store.getState().doc.nodes.r.x, 20, 'still waiting');
    await session.time.advance(1);
    await flush();
    assert.equal(session.store.getState().doc.nodes.r.x, 30);
    session.live.stop();
  });
}

// ── Field-level remote changes (protocol 2, lane W) ──────────────────────────────────────────────

const fieldChange = (version: number, fields: Record<string, unknown>, patch: object = {}) => event('change', {version, patch, fields, by: 'other', user: 'u'});

test('live session (ws): field-level changes spread over the node; untouched fills, strokes and effects keep their identity', async () => {
  let before: SceneNode | null = null;
  let afterFirst: SceneNode | null = null;
  const session = scripted('ws', [{events: [hello(), fieldChange(2, {r: {set: {x: 20, y: 7}}}), fieldChange(3, {r: {set: {name: 'B'}, unset: ['cornerRadius']}}), fieldChange(4, {r: {set: {x: 30}}})], open: true}], async () => assert.fail('no reload'), store => {
    before = store.getState().doc.nodes.r;
    const stop = store.subscribe(() => {
      afterFirst = store.getState().doc.nodes.r;
      stop();
    }, {slice: 'doc'});
  });
  await flush();
  const r0 = before! as SceneNode;
  assert.ok(r0.fills.length && 'cornerRadius' in r0, 'a rectangle with fills and a corner radius');
  // The first change applies at once, alone.
  const r1 = afterFirst! as SceneNode;
  assert.equal(r1.x, 20);
  assert.equal(r1.y, 7);
  assert.notEqual(r1, r0, 'a new node object');
  assert.equal(r1.fills, r0.fills, 'fills: the same array');
  assert.equal(r1.strokes, r0.strokes, 'strokes: the same array');
  assert.equal(r1.effects, r0.effects, 'effects: the same array');
  assert.equal(r1.constraints, r0.constraints);
  // The next two as one burst.
  await session.time.advance(REMOTE_APPLY_MS);
  await flush();
  const r3 = session.store.getState().doc.nodes.r;
  assert.equal(session.live.version(), 4);
  assert.equal(r3.name, 'B');
  assert.equal(r3.x, 30);
  assert.equal(r3.y, 7);
  assert.ok(!('cornerRadius' in r3), 'unset removes the field');
  assert.equal(r3.fills, r0.fills, 'still the same fills');
  assert.equal(session.store.canUndo(), false, 'remote changes are not undo steps');
  session.live.stop();
});

test('live session (ws): a field-level change of a layer with unsaved changes here spreads over the server\'s copy', async () => {
  const red = [solid({r: 1, g: 0, b: 0})];
  const session = scripted('ws', [{events: [hello(), fieldChange(2, {r: {set: {name: 'Their name'}}})], open: true}], async () => assert.fail('no reload'), store => {
    store.transact('Fill', tx => tx.update('r', {fills: red}));
  });
  await flush();
  const node = session.store.getState().doc.nodes.r;
  assert.equal(session.live.version(), 2);
  assert.equal(node.name, 'Their name', 'their field landed');
  assert.deepEqual(node.fills, red, 'the unsaved fill stays on top');
  const unsaved = session.persistence.autosave()!.unsaved();
  assert.deepEqual(unsaved?.nodes?.r?.fills, red, 'and is still to be saved (the server never had it)');
  session.live.stop();
});

test('live session (ws): fields for a layer the editor does not hold reload the stored file', async () => {
  let reloads = 0;
  const remoteDoc = createDocument('page');
  remoteDoc.nodes.q = createNode('RECTANGLE', {id: 'q', parentId: 'page', x: 5});
  remoteDoc.nodes.page.children = ['q'];
  const session = scripted('ws', [{events: [hello(), fieldChange(2, {q: {set: {x: 5}}})], open: true}], async () => {
    reloads++;
    return {file: {id: 'f', name: 'f', version: 2, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}, document: remoteDoc};
  });
  await flush();
  await session.time.advance(10);
  await flush();
  assert.equal(reloads, 1);
  assert.equal(session.store.getState().doc.nodes.q.x, 5);
  session.live.stop();
});

test('a catch-up composes field-level changes with whole ones (decode worker)', () => {
  const r = createNode('RECTANGLE', {id: 'r', parentId: 'page'});
  const c = (version: number, patch: object, fields?: object) => ({version, by: 'o', user: 'u', patch, ...(fields ? {fields} : {})}) as ProtocolChange;
  // fields, fields: merged (a later set lifts an earlier unset, a later unset drops an earlier set).
  const merged = composeChanges([c(2, {}, {r: {set: {x: 1, y: 1}, unset: ['name']}}), c(3, {}, {r: {set: {name: 'n'}, unset: ['y']}})])!;
  assert.deepEqual(merged.fields, {r: {set: {x: 1, name: 'n'}, unset: ['y']}});
  assert.deepEqual(merged.patch, {});
  // whole, fields: the fields go into the whole node.
  const whole = composeChanges([c(2, {nodes: {r: {...r, x: 5}}}), c(3, {}, {r: {set: {y: 9}}})])!;
  assert.equal(whole.fields, undefined);
  assert.equal(whole.patch.nodes!.r!.x, 5);
  assert.equal(whole.patch.nodes!.r!.y, 9);
  // fields, whole: the whole node wins.
  const later = composeChanges([c(2, {}, {r: {set: {y: 9}}}), c(3, {nodes: {r: {...r, x: 5}}})])!;
  assert.equal(later.fields, undefined);
  assert.equal(later.patch.nodes!.r!.y, r.y);
  // removed, fields: does not compose.
  assert.equal(composeChanges([c(2, {nodes: {r: null}}), c(3, {}, {r: {set: {y: 9}}})]), null);
  // Resolved over a base, the composite is the one-by-one result.
  const base = {...r, x: 0, y: 0, name: 'a'};
  const one = resolveChanges([c(2, {}, {r: {set: {x: 1, y: 1}, unset: ['name']}}), c(3, {}, {r: {set: {name: 'n'}, unset: ['y']}})] as LiveChange[], null, () => base);
  const composite = resolveChanges([merged as LiveChange], null, () => base);
  assert.deepEqual(composite, one);
  assert.equal(composite!.nodes!.r!.fills, base.fills, 'untouched values keep their identity');
});

// ── Speed ──────────────────────────────────────────────────────────────────────────────────────

/** 20 041 nodes: 40 screens × 10 sections × 49 layers. */
function heavyPage(screens = 40): DesignDocument {
  const doc = createDocument('page', 'Heavy page');
  let n = 0;
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>) => {
    const id = `n${++n}`;
    doc.nodes[id] = createNode(type, {...props, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  for (let s = 0; s < screens; s++) {
    const screen = add('FRAME', 'page', {x: (s % 8) * 1600, y: Math.floor(s / 8) * 2200, width: 1440, height: 2000});
    for (let k = 0; k < 10; k++) {
      const section = add('FRAME', screen, {x: 0, y: k * 200, width: 1440, height: 200});
      for (let i = 0; i < 49; i++) add(i % 6 === 1 ? 'TEXT' : 'RECTANGLE', section, {x: 20 + (i % 12) * 110, y: 20 + Math.floor(i / 12) * 38, width: 100, height: 30, ...(i % 6 === 1 ? {text: defaultTextProps('Text')} : {})});
    }
  }
  return doc;
}

/** How much longer a remote change may take on 40× the layers (fastest rounds). Measured 1.4–2.7× with the default engines
 *  and 5.8–9.8× in `both` mode (its oracle compare has a share that grows with the file), also with every core busy;
 *  a change that costs O(file) would be ≈40×. */
const RATIO_BOUND = 20;

/** A store on `doc` with an unsaved local edit of a few layers, and one remote change applied to it per call (timed). */
function remoteRounds(doc: DesignDocument) {
  // The idle copy of the node table is ready, as it is between edits in the editor.
  let idleWork: (() => void) | null = null;
  const store = createDesignStore({doc, measurer, idle: work => {
    idleWork = work;
    return () => void (idleWork = null);
  }});
  const persistence = attachPersistence(store, {fileId: 'f', baseVersion: 1, events: null, timers: {setTimeout: () => 1, clearTimeout: () => {}}, onStatus: () => {}, onConflict: () => {},
    request: async () => ({version: 2, updatedAt: ''})});
  // An unsaved local edit of a few layers.
  store.transact('Fill', tx => {
    for (const id of ['n3', 'n4', 'n5']) tx.update(id, {fills: [solid({r: 1, g: 0, b: 0})]});
  });
  const autosave = persistence.autosave()!;
  return {
    store,
    persistence,
    round(round: number) {
      (idleWork as (() => void) | null)?.();
      // Someone moved a dozen layers, one of them also changed here.
      const change = {nodes: Object.fromEntries(['n3', ...Array.from({length: 11}, (_, i) => `n${200 + i + round * 20}`)].map(id => [id, {...store.getState().doc.nodes[id], x: round * 3}]))};
      const started = performance.now();
      store.applyRemote(state => autosave.serverChanged(change, state.doc, 2 + round, rebaseLocal));
      return performance.now() - started;
    },
  };
}

test('a remote change on a 20 000-layer file costs what it costs on a 500-layer one, local unsaved changes rebased', async t => {
  const doc = heavyPage();
  assert.ok(Object.keys(doc.nodes).length > 20_000);
  const small = heavyPage(1);
  assert.ok(Object.keys(small.nodes).length > 500 && Object.keys(small.nodes).length < 600);
  // The same remote changes on both files, measured back to back in this process: the load the machine is under falls on
  // both alike, so the ratio says whether a change costs O(change) (≈1×) or O(file) (≈40×), not how busy the machine is.
  // One file at a time (the engine's shadow document follows one store: alternating would resync it every round).
  const little = remoteRounds(small);
  const smallMs = Array.from({length: 12}, (_, round) => little.round(round));
  const big = remoteRounds(doc);
  const bigMs = Array.from({length: 12}, (_, round) => big.round(round));
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const state = big.store.getState().doc;
  assert.equal(state.nodes.n3.x, 33, 'the remote field landed');
  assert.deepEqual((state.nodes.n3.fills[0] as {color: unknown}).color, {r: 1, g: 0, b: 0}, 'the local unsaved fill stayed on top');
  assert.ok(big.persistence.dirty(), 'the local change is still to be saved');
  // The fastest round of each: the least load in it, so the steadiest estimate of what the change itself costs.
  const ratio = Math.min(...bigMs) / Math.max(Math.min(...smallMs), 0.02);
  // Information only: what one remote change takes here (a wall-clock bound would fail under load).
  t.diagnostic(`remote change: median ${median(bigMs).toFixed(2)} ms on 20 041 layers, ${median(smallMs).toFixed(2)} ms on 501; fastest ${ratio.toFixed(1)}× apart`);
  assert.ok(ratio <= RATIO_BOUND, `a remote change on 40× the layers took ${ratio.toFixed(1)}× as long (bound ${RATIO_BOUND}×): it costs O(file)`);
  big.persistence.dispose();
  little.persistence.dispose();
});

for (const kind of TRANSPORTS) {
  test(`live session (${kind}): a developer made a viewer (read-only either way) reopens too; the same role does not`, async () => {
    const doc = createDocument('page');
    const store = createDesignStore({doc, measurer, idle: () => () => {}, readOnly: true});
    const persistence = attachPersistence(store, {fileId: 'f', baseVersion: 1, events: null, timers: {setTimeout: () => 1, clearTimeout: () => {}}, onStatus: () => {}, onConflict: () => {}, request: async () => ({version: 2, updatedAt: ''})});
    const happened: string[] = [];
    const developer = event('hello', {connection: 'c1', token: 'secret-token-0123456789', version: 1, role: 'developer', canEdit: false, user: 'me', name: 'Me', color: 0, peers: []});
    const live = startLiveSession({
      fileId: 'f', store, persistence, version: 1, canEdit: false, role: 'developer', timers: clock().timers, network: null, queue: memoryQueue(), identity: testIdentity(),
      callbacks: {onAccess: access => happened.push(`access:${access.role}:${access.canEdit}`), onEnd: () => {}, onRename: () => {}},
      transport: scriptedTransport(kind, [{events: [developer, event('access', {role: 'developer', canEdit: false}), event('access', {role: 'viewer', canEdit: false})], open: true}], async () => assert.fail('no reload')),
    });
    await flush();
    assert.deepEqual(happened, ['access:viewer:false']);
    live.stop();
    persistence.dispose();
  });

  test(`live session (${kind}): the network coming back reconnects at once instead of after the back-off`, async () => {
    const doc = createDocument('page');
    const store = createDesignStore({doc, measurer, idle: () => () => {}});
    const persistence = attachPersistence(store, {fileId: 'f', baseVersion: 1, events: null, timers: {setTimeout: () => 1, clearTimeout: () => {}}, onStatus: () => {}, onConflict: () => {}, request: async () => ({version: 2, updatedAt: ''})});
    const network = new EventTarget();
    const waits: number[] = [];
    let attempts = 0;
    const live = startLiveSession({
      fileId: 'f', store, persistence, version: 1, canEdit: true, timers: clock().timers, network, queue: memoryQueue(), identity: testIdentity(),
      callbacks: {onAccess: () => {}, onEnd: () => {}, onRename: () => {}},
      transport: scriptedTransport(kind, [new TypeError('Failed to fetch'), {events: [hello()], open: true}], async () => assert.fail('no reload'), {
        onAttempt: () => attempts++,
        // The back-off waits until its time or until it is cut short.
        sleep: (ms, signal) => new Promise(resolve => {
          waits.push(ms);
          signal.addEventListener('abort', () => resolve(), {once: true});
        }),
      }),
    });
    await flush();
    assert.equal(attempts, 1);
    assert.equal(live.status(), 'offline');
    assert.equal(waits.length, 1, 'waiting out the back-off');
    network.dispatchEvent(new Event('online'));
    await flush();
    assert.equal(attempts, 2, 'reconnected as soon as the network came back');
    assert.equal(live.status(), 'live');
    live.stop();
    network.dispatchEvent(new Event('online'));
    await flush();
    assert.equal(attempts, 2, 'a stopped session stays stopped');
    persistence.dispose();
  });
}
