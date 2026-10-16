import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument} from './helpers/collab-app';
import type {SceneNode} from '../shared/design/types';

// TARGETS S5 is a fast path only: a process without the server's wasm (a dev machine or the Mac gate, which build none; a module
// that failed to load; a build without the `server` feature) stores a whole document's PUT and a version restore the TypeScript
// way, exactly as before S5. The module path points nowhere before anything loads it, as on a machine where it was never built.

test('without the server wasm a whole-document PUT and a restore go the TypeScript way', {timeout: 180_000}, async t => {
  const saved = process.env.MORFA_WASM_PATH;
  process.env.MORFA_WASM_PATH = '/nonexistent/morfa-wasm/morfa_wasm.js';
  t.after(() => {
    if (saved === undefined) delete process.env.MORFA_WASM_PATH;
    else process.env.MORFA_WASM_PATH = saved;
  });
  const c = await collabApp(t);
  const {fastDocumentReads, readFastDocument, readFastPut} = await import('../server/design/document-fast');
  const {engineWasmLoaded, setEngineWasm} = await import('../shared/design/engine-switch');
  const {db, files, ok} = c;
  const owner = await c.account('owner', 'Anna');
  const doc = smallDocument();
  const node = (key: string) => doc.nodes[key] as SceneNode;
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'No wasm', document: doc}}), 201).file.id as string;
  const row = async () => (await db.one<{version: number; bytes: number; node_count: number; document: string}>('SELECT version,bytes,node_count,document FROM design_files WHERE id=$1', [id]))!;
  const put = (body: string) => c.fetchAs(owner, `/api/design-files/${id}/document`, {method: 'PUT', body, headers: {'content-type': 'application/json'}});
  const before = fastDocumentReads();

  await t.test('a PUT is stored, and a stale or invalid one refused, as before', async () => {
    const version = Number((await row()).version);
    const next = {...doc, nodes: {...doc.nodes, a: {...node('a'), x: 777}}};
    const answer = await put(JSON.stringify({baseVersion: version, document: next}));
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.equal(answer.data.version, version + 1);
    const stored = await row();
    assert.deepStrictEqual(JSON.parse(stored.document), next);
    assert.equal(stored.bytes, Buffer.byteLength(JSON.stringify(next)));
    assert.equal(stored.node_count, Object.keys(next.nodes).length);
    assert.equal((await put(JSON.stringify({baseVersion: version, document: next}))).status, 409);
    assert.equal((await put(JSON.stringify({baseVersion: version + 1, document: {...next, nodes: {...next.nodes, a: {...next.nodes.a, opacity: 7}}}}))).status, 400);
  });

  await t.test('a named version is restored', async () => {
    const named = ok(await files(owner, `/${id}/versions`, {method: 'POST', json: {label: 'Checkpoint'}}), 201).version;
    const version = Number((await row()).version);
    ok(await put(JSON.stringify({baseVersion: version, document: doc})));
    const restored = ok(await files(owner, `/${id}/versions/${named.id}/restore`, {method: 'POST', json: {baseVersion: version + 1}}));
    assert.equal(restored.version, version + 2);
    assert.equal(ok(await files(owner, `/${id}`)).document.nodes.a.x, 777);
  });

  await t.test('nothing went through the fast path, and no wasm was loaded', () => {
    assert.equal(engineWasmLoaded(), false);
    const after = fastDocumentReads();
    assert.equal(after.accepted, before.accepted);
    assert.ok(after.declined > before.declined);
  });

  await t.test('GET /:id/checkpoint answers 503 design_checkpoint_unavailable: the editor opens with GET /:id', async () => {
    const answer = await files(owner, `/${id}/checkpoint`);
    assert.equal(answer.status, 503);
    assert.equal(answer.data.code, 'design_checkpoint_unavailable');
  });

  await t.test('a loaded module without the server build declines too', () => {
    setEngineWasm({} as Parameters<typeof setEngineWasm>[0]);
    try {
      assert.equal(readFastDocument(JSON.stringify(doc)), undefined);
      assert.equal(readFastPut(Buffer.from(JSON.stringify({baseVersion: 1, document: doc}))), undefined);
    } finally {
      setEngineWasm(null);
    }
  });
});
