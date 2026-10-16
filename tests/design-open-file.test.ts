import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setApiAccount} from '../src/api';
import {readApi, type ReadProgress} from '../src/api-read';
import {createDocument, createNode} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';
import {evict, keepCheckpoint, memoryCheckpoints, type CheckpointStore} from '../src/design/editor/checkpoint-cache';
import {keepCheckpointFresh, openEarly, openForEditing, openWhole} from '../src/design/editor/open-file';

// Whole-document reads have no fixed deadline while bytes keep arriving (src/api-read.ts), and the
// editor opens a file from this browser's checkpoint only when the server says that is still its version
// (src/design/editor/checkpoint-cache.ts, open-file.ts) — the document shown is the server's.

const encoder = new TextEncoder();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A response whose body arrives in `pieces`, `gapMs` apart; `stallAfter` pieces in, it stops sending. */
function trickle(text: string, pieces: number, gapMs: number, stallAfter = Infinity, headers: Record<string, string> = {}): Response {
  const bytes = encoder.encode(text);
  const size = Math.ceil(bytes.length / pieces);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= stallAfter) return new Promise<void>(() => {});
      await delay(gapMs);
      const chunk = bytes.subarray(sent * size, (sent + 1) * size);
      sent++;
      if (chunk.length) controller.enqueue(chunk);
      if (sent * size >= bytes.length) controller.close();
    },
  });
  return new Response(body, {status: 200, headers: {'Content-Type': 'application/json', ...headers}});
}

async function withFetch<T>(handler: (url: string, init: RequestInit) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('a whole-document read outlasts its deadline while bytes keep arriving, with progress', async () => {
  const value = {document: {name: 'Large file', fill: 'x'.repeat(4000)}};
  const text = JSON.stringify(value);
  const progress: ReadProgress[] = [];
  const started = Date.now();
  const answer = await withFetch(
    () => trickle(text, 10, 25, Infinity, {'Content-Length': String(encoder.encode(text).length)}),
    () => readApi('/design-files/f', {timeoutMs: 60, stallMs: 60, retryDelays: [], onProgress: next => progress.push(next)}),
  );
  assert.ok(Date.now() - started >= 200, 'the body took longer than the deadline to arrive');
  assert.deepEqual(answer, value);
  assert.equal(progress.at(-1)?.loaded, encoder.encode(text).length);
  assert.equal(progress.at(-1)?.total, encoder.encode(text).length);
  assert.ok(progress.length >= 5);
});

test('a compressed answer reports progress without a total', async () => {
  const progress: ReadProgress[] = [];
  await withFetch(() => trickle('{"a":1}', 2, 1, Infinity, {'Content-Encoding': 'zstd', 'Content-Length': '3'}), () => readApi('/x', {stallMs: 100, onProgress: next => progress.push(next)}));
  assert.equal(progress.at(-1)?.total, null);
});

test('a read whose body stops arriving fails with a clear message once the stall deadline passes, and is retried first', async () => {
  let requests = 0;
  await assert.rejects(
    withFetch(() => {
      requests++;
      return trickle('{"document":"' + 'x'.repeat(1000) + '"}', 10, 5, 3);
    }, () => readApi('/design-files/f', {timeoutMs: 1000, stallMs: 50, retryDelays: [1]})),
    (error: Error & {status?: number}) => error.status === 408 && /stopped loading/.test(error.message),
  );
  assert.equal(requests, 2);
});

test('without a stall deadline a read keeps its fixed deadline (small reads as before)', async () => {
  await assert.rejects(
    withFetch(() => trickle('{"a":"' + 'x'.repeat(100) + '"}', 10, 30), () => readApi('/x', {timeoutMs: 60, retryDelays: []})),
    (error: Error & {status?: number}) => error.status === 408 && /taking too long to respond/.test(error.message),
  );
});

// ── The warm open ────────────────────────────────────────────────────────────────────────────────

function documentAt(version: number): DesignDocument {
  const doc = createDocument('page');
  for (let i = 0; i < version; i++) {
    const id = `r${i}`;
    doc.nodes[id] = createNode('RECTANGLE', {id, parentId: 'page', name: `Layer ${i}`});
    doc.nodes.page.children = [...(doc.nodes.page.children ?? []), id];
  }
  return doc;
}

/** The api's GET /:id as the server answers it (server/design/router.ts), `have` honoured unless `ignoresHave` (an old server). */
function fakeServer(options: {ignoresHave?: boolean} = {}) {
  const state = {version: 3, document: documentAt(3), wholeAnswers: 0, currentAnswers: 0, bytes: 0};
  const handler = (url: string) => {
    const have = /[?&]have=(\d+)/.exec(url)?.[1];
    const file = {id: 'f', name: 'File', version: state.version, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null};
    const access = {role: 'owner', canEdit: true};
    let text: string;
    if (!options.ignoresHave && have !== undefined && Number(have) === state.version) {
      state.currentAnswers++;
      text = JSON.stringify({file, access, current: true});
    } else {
      state.wholeAnswers++;
      text = '{"file":' + JSON.stringify(file) + ',"access":' + JSON.stringify(access) + ',"document":' + JSON.stringify(state.document) + '}';
    }
    state.bytes += encoder.encode(text).length;
    return new Response(text, {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  return {state, handler};
}

/** What the editor writes once it shows `doc` at `version` with nothing unsaved (keepCheckpointFresh). */
const kept = (store: CheckpointStore, version: number, doc: DesignDocument) => keepCheckpoint(store, {account: 'acc', fileId: 'f', version, body: JSON.stringify(doc)});

test('a warm open shows the server’s document: the checkpoint when the server says it is current, the download otherwise', async () => {
  setApiAccount('acc');
  const checkpoints = memoryCheckpoints();
  const server = fakeServer();
  await withFetch(server.handler, async () => {
    const cold = await openWhole('f', undefined, undefined, checkpoints);
    assert.deepEqual(cold.document, server.state.document);
    assert.equal(await checkpoints.meta('acc', 'f'), null, 'an open never writes the cache itself');
    await kept(checkpoints, 3, cold.document);

    // Unchanged on the server: no document on the wire, the checkpoint's document, equal to the server's.
    const before = server.state.bytes;
    const warm = await openWhole('f', undefined, undefined, checkpoints);
    assert.equal(server.state.currentAnswers, 1);
    assert.ok(server.state.bytes - before < 300, 'the warm answer carries no document');
    assert.deepEqual(warm.document, server.state.document);
    assert.equal(warm.file.version, 3);

    // Changed on the server since: the whole file again, equal to the server's, and the checkpoint follows it.
    server.state.version = 5;
    server.state.document = documentAt(5);
    const behind = await openWhole('f', undefined, undefined, checkpoints);
    assert.deepEqual(behind.document, server.state.document);
    assert.equal(behind.file.version, 5);
    await kept(checkpoints, 5, behind.document);
    const again = await openWhole('f', undefined, undefined, checkpoints);
    assert.deepEqual(again.document, documentAt(5));
    assert.equal(server.state.currentAnswers, 2);
  });
});

test('another account never reads the checkpoint; an old server and an unreadable checkpoint open whole', async () => {
  const checkpoints = memoryCheckpoints();
  const old = fakeServer({ignoresHave: true});
  setApiAccount('acc');
  await withFetch(old.handler, async () => {
    await kept(checkpoints, 3, (await openWhole('f', undefined, undefined, checkpoints)).document);
    const opened = await openWhole('f', undefined, undefined, checkpoints);
    assert.deepEqual(opened.document, old.state.document);
    assert.equal(old.state.wholeAnswers, 2);
  });

  const server = fakeServer();
  setApiAccount('other');
  await withFetch(server.handler, async () => {
    await openWhole('f', undefined, undefined, checkpoints);
    assert.equal(server.state.currentAnswers, 0, 'the other account asked without `have`');
  });

  setApiAccount('acc');
  const entry = (await checkpoints.get('acc', 'f'))!;
  await checkpoints.put({...entry, body: '{"nodes":', usedAt: Date.now()});
  await withFetch(server.handler, async () => {
    const opened = await openWhole('f', undefined, undefined, checkpoints);
    assert.deepEqual(opened.document, server.state.document);
    assert.equal(server.state.currentAnswers, 1);
    assert.equal(server.state.wholeAnswers, 2, 'the unreadable checkpoint was dropped and the file downloaded');
  });
  setApiAccount(null);
});

test('the cache stays within its bytes: least recently used first, old entries dropped, a too-large file not kept', async () => {
  const store = memoryCheckpoints();
  const body = (bytes: number) => 'x'.repeat(bytes);
  const now = 1_000_000_000_000;
  assert.equal(await keepCheckpoint(store, {account: 'a', fileId: '1', version: 1, body: body(40)}, now, 100), true);
  assert.equal(await keepCheckpoint(store, {account: 'a', fileId: '2', version: 1, body: body(40)}, now + 1, 100), true);
  await store.touch('a', '1', now + 2);
  assert.equal(await keepCheckpoint(store, {account: 'a', fileId: '3', version: 1, body: body(40)}, now + 3, 100), true);
  assert.deepEqual((await store.list()).map(entry => entry.fileId).sort(), ['1', '3'], 'file 2 was used least recently');
  assert.equal(await keepCheckpoint(store, {account: 'a', fileId: '4', version: 1, body: body(60)}, now + 4, 100), false);
  assert.equal(await store.get('a', '4'), null);
  await evict(store, 0, now + 31 * 24 * 3600_000, 100);
  assert.deepEqual(await store.list(), [], 'a month later nothing is kept');
});

test('a read started early is taken over by the editor, also after a first mount aborted (StrictMode), and read once', async () => {
  setApiAccount('acc');
  const server = fakeServer();
  await withFetch(server.handler, async () => {
    openEarly('f');
    const first = new AbortController();
    const aborted = openForEditing('f', first.signal, undefined, null);
    first.abort(new Error('unmounted'));
    await assert.rejects(aborted, /unmounted/);
    const progress: ReadProgress[] = [];
    const opened = await openForEditing('f', new AbortController().signal, next => progress.push(next), null);
    assert.deepEqual(opened.document, server.state.document);
    assert.equal(server.state.wholeAnswers, 1, 'one read for both mounts');
    // Taken: the next open reads again.
    await openForEditing('f', undefined, undefined, null);
    assert.equal(server.state.wholeAnswers, 2);
  });
  setApiAccount(null);
});

test('the editor keeps the checkpoint at a saved version only: hidden, closed, idle; never with changes unsaved', async () => {
  const listeners = new Set<() => void>();
  const page = {visibilityState: 'visible', addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)};
  (globalThis as {document?: unknown}).document = page;
  setApiAccount('acc');
  try {
    const checkpoints = memoryCheckpoints();
    let doc = documentAt(2);
    const state = {version: 2, dirty: false, status: 'saved'};
    const store = {getState: () => ({doc, pages: null})} as unknown as Parameters<typeof keepCheckpointFresh>[0]['store'];
    const persistence = {version: () => state.version, dirty: () => state.dirty, status: () => state.status};
    const stop = keepCheckpointFresh({fileId: 'f', store, persistence, checkpoints});
    const hide = async () => {
      page.visibilityState = 'hidden';
      listeners.forEach(listener => listener());
      page.visibilityState = 'visible';
      await delay(5);
    };
    // Unsaved changes: nothing is written.
    doc = documentAt(3);
    state.dirty = true;
    state.status = 'saving';
    await hide();
    assert.equal(await checkpoints.meta('acc', 'f'), null);
    // Saved at 3: the store's document is the server's at 3.
    state.version = 3;
    state.dirty = false;
    state.status = 'saved';
    await hide();
    assert.equal((await checkpoints.meta('acc', 'f'))?.version, 3);
    assert.deepEqual(JSON.parse((await checkpoints.body('acc', 'f')) as string), documentAt(3));
    // Closing the file writes the last saved version.
    doc = documentAt(4);
    state.version = 4;
    stop();
    await delay(5);
    assert.equal((await checkpoints.meta('acc', 'f'))?.version, 4);
    assert.equal(listeners.size, 0);
  } finally {
    delete (globalThis as {document?: unknown}).document;
    setApiAccount(null);
  }
});

test('replacing a checkpoint never leaves the file without one, even with evictions in the same write', async () => {
  const inner = memoryCheckpoints();
  const seen: (number | null)[] = [];
  // Every step of a write, as a page loaded in between would see it.
  const watched: CheckpointStore = {
    ...inner,
    put: async (entry, evicted) => {
      await inner.put(entry, evicted);
      seen.push((await inner.meta('acc', 'f'))?.version ?? null);
    },
    remove: async (account, fileId) => {
      await inner.remove(account, fileId);
      seen.push((await inner.meta('acc', 'f'))?.version ?? null);
    },
  };
  const now = 1_000_000_000_000;
  await keepCheckpoint(watched, {account: 'acc', fileId: 'oldest', version: 1, body: 'x'.repeat(30)}, now, 100);
  await keepCheckpoint(watched, {account: 'acc', fileId: 'other', version: 1, body: 'x'.repeat(30)}, now + 1, 100);
  await keepCheckpoint(watched, {account: 'acc', fileId: 'f', version: 2, body: 'y'.repeat(20)}, now + 2, 100);
  seen.length = 0;
  // A bigger version 3 (30 + 30 + 45 > 100): the least recently used goes, in the same write as the replacement.
  await keepCheckpoint(watched, {account: 'acc', fileId: 'f', version: 3, body: 'z'.repeat(45)}, now + 3, 100);
  assert.deepEqual(seen, [3], 'one write; never a moment without the file’s entry');
  assert.equal(await inner.meta('acc', 'oldest'), null);
  assert.equal((await inner.meta('acc', 'other'))?.version, 1);
  assert.equal(await inner.body('acc', 'f'), 'z'.repeat(45));
});

test('big files: a skeleton answered `whole` (a file the server would parse again per read) is opened whole, warm cache included', async () => {
  const {setBigFiles} = await import('../shared/design/big-files');
  setBigFiles(true);
  setApiAccount('acc');
  try {
    const server = fakeServer();
    const asked: string[] = [];
    const handler = (url: string) => {
      asked.push(url.replace(/^.*\/design-files\/f/, '') || '/');
      // No checkpoint on this server (lane S answers 503 design_checkpoint_unavailable): the whole JSON open.
      if (url.endsWith('/checkpoint')) return new Response(JSON.stringify({error: 'No', code: 'design_checkpoint_unavailable'}), {status: 503, headers: {'Content-Type': 'application/json'}});
      if (url.endsWith('?pages=skeleton')) {
        const file = {id: 'f', name: 'File', version: server.state.version, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null};
        return new Response(JSON.stringify({file, access: {role: 'owner', canEdit: true}, whole: 'big'}), {status: 200, headers: {'Content-Type': 'application/json'}});
      }
      return server.handler(url);
    };
    const checkpoints = memoryCheckpoints();
    await withFetch(handler, async () => {
      const opened = await openForEditing('f', undefined, undefined, checkpoints);
      assert.deepEqual(opened.document, server.state.document);
      assert.equal(opened.partial, undefined, 'a whole document: no pages on demand');
      assert.deepEqual(asked, ['?pages=skeleton', '/checkpoint', '/']);
      await kept(checkpoints, server.state.version, opened.document);
      asked.length = 0;
      const warm = await openForEditing('f', undefined, undefined, checkpoints);
      assert.deepEqual(warm.document, server.state.document);
      assert.deepEqual(asked, ['?pages=skeleton', '/checkpoint', `?have=${server.state.version}`]);
    });
  } finally {
    setBigFiles(null);
    setApiAccount(null);
  }
});

test('a file opened from checkpoint bytes keeps bytes: the shadow encoded at the saved version, on hide and close, never JSON', async () => {
  const listeners = new Set<() => void>();
  const page = {visibilityState: 'visible', addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)};
  (globalThis as {document?: unknown}).document = page;
  setApiAccount('acc');
  try {
    const checkpoints = memoryCheckpoints();
    let doc = documentAt(2);
    const state = {version: 2, dirty: false, status: 'saved'};
    const store = {getState: () => ({doc, pages: null})} as unknown as Parameters<typeof keepCheckpointFresh>[0]['store'];
    const persistence = {version: () => state.version, dirty: () => state.dirty, status: () => state.status};
    // The engine's shadow, as far as this goes: at the document it was brought to, or not there.
    let shadowAt: DesignDocument | null = null;
    const encode = (at: DesignDocument) => (at === shadowAt ? new TextEncoder().encode(`bytes of ${JSON.stringify(at).length}`) : null);
    const stop = keepCheckpointFresh({fileId: 'f', store, persistence, checkpoints, binary: true, encode});
    const hide = async () => {
      page.visibilityState = 'hidden';
      listeners.forEach(listener => listener());
      page.visibilityState = 'visible';
      await delay(5);
    };
    // The shadow not at the document: nothing written (no JSON in its place).
    doc = documentAt(3);
    state.version = 3;
    await hide();
    assert.equal(await checkpoints.meta('acc', 'f'), null);
    // At it: its bytes.
    shadowAt = doc;
    await hide();
    assert.equal((await checkpoints.meta('acc', 'f'))?.version, 3);
    const body = await checkpoints.body('acc', 'f');
    assert.ok(body instanceof Uint8Array, 'bytes, not a string');
    assert.equal(new TextDecoder().decode(body), `bytes of ${JSON.stringify(documentAt(3)).length}`);
    // Closing writes the last saved version's bytes.
    doc = documentAt(4);
    shadowAt = doc;
    state.version = 4;
    stop();
    await delay(5);
    assert.equal((await checkpoints.meta('acc', 'f'))?.version, 4);
    assert.ok((await checkpoints.body('acc', 'f')) instanceof Uint8Array);
  } finally {
    delete (globalThis as {document?: unknown}).document;
    setApiAccount(null);
  }
});
