import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutosave, type AutosaveOptions, type AutosaveStatus} from '../src/design/persistence/autosave';
import {createNode} from '../shared/design/defaults';
import type {DocumentPatch} from '../shared/design/patch';
import type {DesignSaved} from '../shared/design/api';

// src/design/persistence/autosave.ts with a fake clock and an injected request: debounce, coalescing, one request
// in flight, conflict stop, offline retry, flush and the keepalive hand-off when the page hides.

type Call = {fileId: string; baseVersion: number; patch: DocumentPatch; init?: RequestInit; resolve: (saved: DesignSaved) => void; reject: (error: unknown) => void};

function harness(overrides: Partial<AutosaveOptions> = {}) {
  let clock = 0,
    nextId = 1;
  const due = new Map<number, {at: number; run: () => void}>();
  const calls: Call[] = [],
    statuses: AutosaveStatus[] = [],
    conflicts: (number | null)[] = [];
  const pageWindow = new EventTarget(),
    pageDocument = Object.assign(new EventTarget(), {visibilityState: 'visible'});
  const autosave = createAutosave({
    fileId: 'file-1',
    baseVersion: 1,
    onStatus: status => statuses.push(status),
    onConflict: version => conflicts.push(version),
    request: (fileId, baseVersion, patch, init) =>
      new Promise<DesignSaved>((resolve, reject) => calls.push({fileId, baseVersion, patch, init, resolve, reject})),
    events: {window: pageWindow, document: pageDocument},
    timers: {
      setTimeout: (run, ms) => {
        const id = nextId++;
        due.set(id, {at: clock + ms, run});
        return id;
      },
      clearTimeout: id => void due.delete(id as number),
    },
    now: () => clock,
    ...overrides,
  });
  /** Moves the clock, running each timer at its time, and lets promise callbacks settle. */
  async function advance(ms: number) {
    const end = clock + ms;
    for (;;) {
      const next = [...due.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at;
      due.delete(next[0]);
      next[1].run();
      await settle();
    }
    clock = end;
    await settle();
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };
  const answer = async (call: Call, version: number) => {
    call.resolve({version, updatedAt: '2026-10-06T12:00:00.000Z'});
    await settle();
  };
  const fail = async (call: Call, error: unknown) => {
    call.reject(error);
    await settle();
  };
  return {autosave, calls, statuses, conflicts, advance, answer, fail, settle, pageWindow, pageDocument, pending: () => due.size};
}

const node = (id: string, name = id) => createNode('RECTANGLE', {id, parentId: 'page', name});
const change = (id: string, name?: string): DocumentPatch => ({nodes: {[id]: node(id, name)}});
const apiError = (status: number, details?: Record<string, unknown>) => Object.assign(new Error('Error'), {status, details});

test('changes wait for a quiet moment and go as one composed patch', async () => {
  const h = harness();
  h.autosave.push(change('a'));
  assert.deepEqual(h.statuses, ['saving']);
  await h.advance(500);
  h.autosave.push(change('b'));
  h.autosave.push(change('a', 'a again'));
  await h.advance(700);
  assert.equal(h.calls.length, 0, 'the timer restarts on every change');
  await h.advance(100);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].baseVersion, 1);
  assert.deepEqual(Object.keys(h.calls[0].patch.nodes!).sort(), ['a', 'b']);
  assert.equal(h.calls[0].patch.nodes!.a!.name, 'a again', 'later changes win');
  await h.answer(h.calls[0], 2);
  assert.equal(h.autosave.version, 2);
  assert.deepEqual(h.statuses, ['saving', 'saved']);
  assert.equal(h.autosave.unsaved(), null);
  h.autosave.push({});
  assert.equal(h.pending(), 0, 'an empty patch schedules nothing');
});

test('continuous editing still saves within the longest wait', async () => {
  const h = harness();
  for (let i = 0; i < 12; i++) {
    h.autosave.push(change('n' + i));
    await h.advance(500);
  }
  assert.equal(h.calls.length, 1, 'one save went while changes kept coming');
  assert.ok(Object.keys(h.calls[0].patch.nodes!).length >= 9);
});

test('one request at a time; changes made meanwhile follow on the new version', async () => {
  const h = harness();
  h.autosave.push(change('a'));
  await h.advance(800);
  assert.equal(h.calls.length, 1);
  h.autosave.push(change('b'));
  h.autosave.push(change('c'));
  await h.advance(5_000);
  assert.equal(h.calls.length, 1, 'nothing else goes while a save is in flight');
  assert.deepEqual(Object.keys(h.autosave.unsaved()!.nodes!).sort(), ['a', 'b', 'c']);
  await h.answer(h.calls[0], 2);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].baseVersion, 2);
  assert.deepEqual(Object.keys(h.calls[1].patch.nodes!).sort(), ['b', 'c']);
  await h.answer(h.calls[1], 3);
  assert.equal(h.autosave.status, 'saved');
  assert.equal(h.autosave.version, 3);
});

test('a version conflict stops autosave and keeps the changes', async () => {
  const h = harness();
  h.autosave.push(change('a'));
  await h.advance(800);
  await h.fail(h.calls[0], apiError(409, {code: 'version_conflict', currentVersion: 7}));
  assert.deepEqual(h.conflicts, [7]);
  assert.equal(h.autosave.status, 'conflict');
  h.autosave.push(change('b'));
  await h.advance(60_000);
  assert.equal(h.calls.length, 1, 'nothing is sent after a conflict');
  assert.deepEqual(Object.keys(h.autosave.unsaved()!.nodes!).sort(), ['a', 'b']);
  assert.equal(await h.autosave.flush(), false);
  // Another 409 (the account changed in another tab) is an error, not a conflict.
  const other = harness();
  other.autosave.push(change('a'));
  await other.advance(800);
  await other.fail(other.calls[0], apiError(409, {code: 'account_changed'}));
  assert.deepEqual(other.conflicts, []);
  assert.equal(other.autosave.status, 'error');
});

test('a lost connection retries with backoff, sending everything since', async () => {
  const h = harness({retryDelays: [1_000, 4_000]});
  h.autosave.push(change('a'));
  await h.advance(800);
  await h.fail(h.calls[0], new TypeError('Failed to fetch'));
  assert.equal(h.autosave.status, 'offline');
  h.autosave.push(change('b'));
  await h.advance(999);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(Object.keys(h.calls[1].patch.nodes!).sort(), ['a', 'b']);
  assert.equal(h.calls[1].baseVersion, 1);
  await h.fail(h.calls[1], apiError(503));
  assert.equal(h.autosave.status, 'offline');
  await h.advance(3_999);
  assert.equal(h.calls.length, 2, 'the second wait is longer');
  // The browser says it is back online: no need to wait for the timer.
  h.pageWindow.dispatchEvent(new Event('online'));
  await h.settle();
  assert.equal(h.calls.length, 3);
  await h.answer(h.calls[2], 2);
  assert.equal(h.autosave.status, 'saved');
  assert.deepEqual(h.statuses, ['saving', 'offline', 'saved']);
  // A server error retries too, shown as an error.
  h.autosave.push(change('c'));
  await h.advance(800);
  await h.fail(h.calls[3], apiError(500));
  assert.equal(h.autosave.status, 'error');
  await h.advance(1_000);
  assert.equal(h.calls.length, 5);
});

test('another refusal is not repeated by itself; the next change tries again with everything', async () => {
  const h = harness();
  h.autosave.push(change('a'));
  await h.advance(800);
  await h.fail(h.calls[0], apiError(403, {code: 'design_access_denied'}));
  assert.equal(h.autosave.status, 'error');
  await h.advance(60_000);
  assert.equal(h.calls.length, 1);
  h.autosave.push(change('b'));
  assert.equal(h.autosave.status, 'saving');
  await h.advance(800);
  assert.deepEqual(Object.keys(h.calls[1].patch.nodes!).sort(), ['a', 'b']);
});

test('a change too big for one PATCH goes as the whole document; what changes meanwhile follows on its version', async () => {
  const wholes: {base: number; resolve: (saved: DesignSaved) => void; reject: (error: unknown) => void}[] = [];
  const stored: number[] = [];
  const doc = {pages: [], nodes: {}} as never;
  const h = harness({whole: {
    document: () => doc,
    request: (_file, base) => new Promise<DesignSaved>((resolve, reject) => wholes.push({base, resolve, reject})),
    onStored: saved => stored.push(saved.version),
  }});
  h.autosave.push(change('a'));
  await h.advance(800);
  await h.fail(h.calls[0], apiError(413, {code: 'design_document_too_large'}));
  assert.equal(wholes.length, 1, 'the whole document goes at once');
  assert.equal(wholes[0].base, 1);
  assert.equal(h.autosave.status, 'saving');
  h.autosave.push(change('b'));
  await h.advance(800);
  assert.equal(h.calls.length, 1, 'one request at a time');
  wholes[0].resolve({version: 5, updatedAt: ''});
  await h.settle();
  assert.deepEqual(stored, [5]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].baseVersion, 5, 'later changes go on the stored version');
  assert.deepEqual(Object.keys(h.calls[1].patch.nodes!), ['b'], 'only what changed since');
  await h.answer(h.calls[1], 6);
  assert.equal(h.autosave.status, 'saved');
  assert.equal(h.autosave.unsaved(), null);
});

test('a document too big even whole stops saving with the server’s words; without the fallback, so does a big change', async () => {
  const stops: {message: string | null}[] = [];
  const wholes: {reject: (error: unknown) => void}[] = [];
  const h = harness({
    onStopped: stop => stops.push(stop),
    whole: {document: () => ({pages: [], nodes: {}}) as never, request: () => new Promise<DesignSaved>((_resolve, reject) => wholes.push({reject}))},
  });
  h.autosave.push(change('a'));
  await h.advance(800);
  await h.fail(h.calls[0], apiError(413, {code: 'design_document_too_large'}));
  wholes[0].reject(Object.assign(apiError(413, {code: 'design_document_too_large'}), {message: 'The file is larger than 20 MB. Split it into several files.'}));
  await h.settle();
  assert.equal(h.autosave.status, 'stopped', 'never a silent loop of refused saves');
  assert.equal(stops[0]?.message, 'The file is larger than 20 MB. Split it into several files.');
  assert.deepEqual(Object.keys(h.autosave.unsaved()!.nodes!), ['a'], 'the changes stay readable for the copy');
  const bare = harness({onStopped: stop => stops.push(stop)});
  bare.autosave.push(change('a'));
  await bare.advance(800);
  await bare.fail(bare.calls[0], Object.assign(apiError(413, {code: 'design_document_too_large'}), {message: 'The change is too large for one save.'}));
  assert.equal(bare.autosave.status, 'stopped');
  assert.equal(stops[1]?.message, 'The change is too large for one save.');
});

test('a refused value with nothing to put it back stops saving instead of carrying it into every later save', async () => {
  const stops: unknown[] = [];
  const h = harness({onStopped: stop => stops.push(stop)});
  h.autosave.push(change('a'));
  await h.advance(800);
  await h.fail(h.calls[0], Object.assign(apiError(400, {code: 'design_document_invalid', path: 'nodes.a.fills', entry: {table: 'nodes', key: 'a'}}), {message: 'File not saved: Invalid value.'}));
  assert.equal(h.autosave.status, 'stopped');
  assert.equal(stops.length, 1);
  h.autosave.push(change('b'));
  await h.advance(60_000);
  assert.equal(h.calls.length, 1, 'nothing is sent once stopped');
  assert.equal(await h.autosave.flush(), false);
  assert.deepEqual(Object.keys(h.autosave.unsaved()!.nodes!).sort(), ['a', 'b'], 'the changes stay readable for the copy');
  // This side's check stops before a request when an entry has a shape the server refuses.
  const local = harness();
  local.autosave.push({nodes: {bad: {...node('bad'), opacity: 2}}});
  await local.advance(800);
  assert.equal(local.calls.length, 0);
  assert.equal(local.autosave.status, 'stopped');
  assert.equal(local.autosave.stop?.issues[0]?.key, 'bad');
});

test('flush sends at once and resolves when everything is stored', async () => {
  const h = harness();
  assert.equal(await h.autosave.flush(), true, 'nothing to save');
  h.autosave.push(change('a'));
  const flushed = h.autosave.flush();
  await h.settle();
  assert.equal(h.calls.length, 1, 'no debounce wait');
  h.autosave.push(change('b'));
  await h.answer(h.calls[0], 2);
  assert.equal(h.calls.length, 2, 'what came meanwhile follows at once');
  let done: boolean | undefined;
  void flushed.then(value => (done = value));
  await h.settle();
  assert.equal(done, undefined, 'not stored yet');
  await h.answer(h.calls[1], 3);
  assert.equal(done, true);
  h.autosave.push(change('c'));
  const failed = h.autosave.flush();
  await h.settle();
  await h.fail(h.calls[2], new TypeError('offline'));
  assert.equal(await failed, false);
});

test('when the page hides, a small patch goes with keepalive; a large one as an ordinary request', async () => {
  const h = harness();
  h.autosave.push(change('a'));
  h.pageWindow.dispatchEvent(new Event('pagehide'));
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].init, {keepalive: true});
  // A save already in flight carries on; a second request would conflict with it.
  h.autosave.push(change('b'));
  h.autosave.flushOnHide();
  await h.settle();
  assert.equal(h.calls.length, 1);
  await h.answer(h.calls[0], 2);
  await h.answer(h.calls[1], 3);
  const big = harness();
  big.autosave.push({nodes: {big: {...node('big'), name: 'x'.repeat(400), pluginData: {a: 'x'.repeat(10_000), b: 'x'.repeat(10_000), c: 'x'.repeat(10_000), d: 'x'.repeat(10_000), e: 'x'.repeat(10_000), f: 'x'.repeat(10_000), g: 'x'.repeat(10_000), h: 'x'.repeat(10_000)}}}});
  big.pageDocument.visibilityState = 'hidden';
  big.pageDocument.dispatchEvent(new Event('visibilitychange'));
  await big.settle();
  assert.equal(big.calls.length, 1);
  assert.equal(big.calls[0].init, undefined, 'over 60 KB: no keepalive');
  // A visible page that changes visibility does not send.
  const visible = harness();
  visible.autosave.push(change('a'));
  visible.pageDocument.dispatchEvent(new Event('visibilitychange'));
  await visible.settle();
  assert.equal(visible.calls.length, 0);
});

test('dispose stops timers and listeners', async () => {
  const h = harness();
  h.autosave.push(change('a'));
  h.autosave.dispose();
  assert.equal(h.pending(), 0);
  await h.advance(10_000);
  h.pageWindow.dispatchEvent(new Event('pagehide'));
  h.autosave.push(change('b'));
  await h.settle();
  assert.equal(h.calls.length, 0);
});
