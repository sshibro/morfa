import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument} from './helpers/collab-app';
import type {SceneNode} from '../shared/design/types';

// TARGETS S5 on the api path: a whole document's PUT and a version restore go through the Rust fast path
// (server/design/document-fast.ts) when it accepts the document, and the way they went before when it declines: the stored row
// is what the TypeScript path stores, and every refusal is today's.

test('a whole-document PUT and a restore through the fast path; what it declines is answered as before', {timeout: 180_000}, async t => {
  const c = await collabApp(t);
  const {fastDocumentReads} = await import('../server/design/document-fast');
  const counted = async (expected: {accepted: number; declined: number}, work: () => Promise<void>) => {
    const before = fastDocumentReads();
    await work();
    const after = fastDocumentReads();
    assert.deepEqual({accepted: after.accepted - before.accepted, declined: after.declined - before.declined}, expected);
  };
  const {db, files, ok} = c;
  const owner = await c.account('owner', 'Anna');
  const sharp = (await import('sharp')).default;
  const png = await sharp({create: {width: 4, height: 4, channels: 3, background: '#0f0'}}).png().toBuffer();
  const doc = smallDocument();
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Fast', document: doc}}), 201).file.id as string;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], {type: 'image/png'}), 'Photo.png');
  const picture = ok(await c.fetchAs(owner, `/api/design-files/${id}/images`, {method: 'POST', body: form})).asset;
  const row = async () =>
    (await db.one<{version: number; bytes: number; node_count: number; image_files: string[]; document: string}>(
      'SELECT version,bytes,node_count,image_files,document FROM design_files WHERE id=$1',
      [id],
    ))!;
  const put = (baseVersion: number, body: string, contentType = 'application/json') =>
    c.fetchAs(owner, `/api/design-files/${id}/document`, {method: 'PUT', body, headers: {'content-type': contentType}});
  const node = (key: string) => doc.nodes[key] as SceneNode;
  const next = {...doc, nodes: {...doc.nodes, a: {...node('a'), x: 321, fills: [{type: 'IMAGE', imageRef: 'pic', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]}}, images: {pic: {url: picture.url, width: 4, height: 4}}};

  await t.test('the fast path stores the row the TypeScript path stores', () => counted({accepted: 1, declined: 0}, async () => {
    const before = await row();
    const saved = ok(await put(Number(before.version), JSON.stringify({baseVersion: Number(before.version), document: next, ignored: true})));
    assert.equal(saved.version, Number(before.version) + 1);
    const stored = await row();
    assert.deepStrictEqual(JSON.parse(stored.document), JSON.parse(JSON.stringify(next)));
    assert.equal(stored.bytes, Buffer.byteLength(JSON.stringify(next)));
    assert.equal(stored.node_count, Object.keys(next.nodes).length);
    assert.deepEqual(stored.image_files, [picture.url.slice('/uploads/'.length)]);
    const opened = ok(await files(owner, `/${id}`));
    assert.equal(opened.document.nodes.a.x, 321);
  }));

  await t.test('declined bodies are read and refused as before', () => counted({accepted: 2, declined: 4}, async () => {
    const version = Number((await row()).version);
    // Not JSON, or JSON that express.json's strict mode refuses: 400 invalid_request.
    for (const body of ['{"baseVersion":', '"text"', '   ']) {
      const answer = await put(version, body);
      assert.equal(answer.status, 400, body);
      assert.equal(answer.data.code, 'invalid_request', body);
    }
    // An invalid document: validateDocument's 400 with its path, as before.
    const broken = {...next, nodes: {...next.nodes, a: {...next.nodes.a, opacity: 7}}};
    const refused = await put(version, JSON.stringify({baseVersion: version, document: broken}));
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(refused.data), /opacity/);
    // A version that is not one: the route's schema answers.
    assert.equal((await put(version, JSON.stringify({baseVersion: 0, document: next}))).status, 400);
    // A stale version: 409 with the file's version.
    const stale = await put(version - 1, JSON.stringify({baseVersion: version - 1, document: next}));
    assert.equal(stale.status, 409);
    assert.equal(stale.data.currentVersion, version);
    // Another content type: no body, as express.json left it.
    assert.equal((await put(version, JSON.stringify({baseVersion: version, document: next}), 'text/plain')).status, 400);
    assert.equal(Number((await row()).version), version, 'nothing was written');
  }));

  await t.test('a BOM and a UTF-16 body read as express.json read them', async () => {
    let version = Number((await row()).version);
    const moved = (x: number) => ({...next, nodes: {...next.nodes, b: {...node('b'), x}}});
    ok(await put(version, '\uFEFF' + JSON.stringify({baseVersion: version, document: moved(11)})));
    version++;
    const utf16 = Buffer.from('\uFEFF' + JSON.stringify({baseVersion: version, document: moved(12)}), 'utf16le');
    const answer = await c.fetchAs(owner, `/api/design-files/${id}/document`, {method: 'PUT', body: utf16, headers: {'content-type': 'application/json; charset=utf-16le'}});
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.equal(ok(await files(owner, `/${id}`)).document.nodes.b.x, 12);
  });

  await t.test('a version restore goes through the fast path too', () => counted({accepted: 2, declined: 0}, async () => {
    const named = ok(await files(owner, `/${id}/versions`, {method: 'POST', json: {label: 'Checkpoint'}}), 201).version;
    const version = Number((await row()).version);
    ok(await put(version, JSON.stringify({baseVersion: version, document: doc})));
    const restored = ok(await files(owner, `/${id}/versions/${named.id}/restore`, {method: 'POST', json: {baseVersion: version + 1}}));
    assert.equal(restored.version, version + 2);
    const stored = await row();
    assert.deepEqual([JSON.parse(stored.document).nodes.b.x, stored.node_count, stored.image_files], [12, Object.keys(next.nodes).length, [picture.url.slice('/uploads/'.length)]]);
  }));
});
