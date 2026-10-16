import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {gunzipSync, zstdCompressSync, zstdDecompressSync} from 'node:zlib';
import {collabApp, smallDocument, type Account} from './helpers/collab-app';
import {createNode, defaultTextProps} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {applyPatch} from '../shared/design/patch';

// Big-file checkpoints, the server half: GET /api/design-files/:id/checkpoint answers the document in the model's binary codec
// The bytes decode — with the editor's own web build of crates/wasm, as the editor's
// open will — to the document GET /:id answers, field for field; a second read of a version is served from what the first kept;
// access is the GET's for every kind of caller; an api-path file over the threshold is refused with 413 and a reason; a
// collab-path file is answered from its checkpoint object, at the object's version, the tail left to the join.

type Raw = {status: number; headers: http.IncomingHttpHeaders; body: Buffer};

/** The bytes as the server sent them (fetch would undo Content-Encoding). */
function raw(base: string, cookie: string, url: string, encoding?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const request = http.get(base + url, {headers: {cookie, ...(encoding !== undefined ? {'accept-encoding': encoding} : {})}}, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks)}));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

/** The codec bytes of an answer, its Content-Encoding undone. */
function codecOf(answer: Raw): Buffer {
  const encoding = answer.headers['content-encoding'];
  if (encoding === 'zstd') return zstdDecompressSync(answer.body);
  if (encoding === 'gzip') return gunzipSync(answer.body);
  assert.equal(encoding, undefined);
  return answer.body;
}

/** An MRFC object (crates/checkpoint/src/format.rs, header version 2). */
function checkpointObject(payload: Buffer, format: 1 | 2, version: number, layers: number): Buffer {
  const body = zstdCompressSync(payload);
  const header = Buffer.alloc(64);
  header.write('MRFC', 0, 'latin1');
  header[4] = 2;
  header[5] = format;
  header.writeBigUInt64LE(BigInt(version), 8);
  header.writeUInt32LE(layers, 16);
  header.writeBigUInt64LE(BigInt(payload.length), 24);
  createHash('sha256').update(body).digest().copy(header, 32);
  return Buffer.concat([header, body]);
}

/** A document with text, fills and strokes besides smallDocument's layers. */
function richDocument(): DesignDocument {
  const doc = smallDocument();
  const page = doc.pages[0]!;
  for (let k = 0; k < 40; k++) {
    const id = `t${k}`;
    // The text is Cyrillic on purpose: multi-byte characters must survive the binary checkpoint.
    doc.nodes[id] = createNode('TEXT', {id, parentId: page, name: `Text ${k} 😀`, x: k * 3.25, y: k * 0.1, width: 120, height: 18, text: defaultTextProps('Привет, мир ' + k)});
    doc.nodes[page]!.children!.push(id);
  }
  doc.nodes.box = createNode('RECTANGLE', {
    id: 'box',
    parentId: page,
    name: 'Card',
    fills: [{type: 'SOLID', color: {r: 0.1, g: 0.2, b: 0.3}, opacity: 0.5, visible: true, blendMode: 'NORMAL'}],
    strokes: [{type: 'SOLID', color: {r: 1, g: 0, b: 0}, opacity: 1, visible: true, blendMode: 'NORMAL'}],
  });
  doc.nodes[page]!.children!.push('box');
  return doc;
}

test('GET /:id/checkpoint: the codec bytes of the document, cached by version, with the GET\'s access; 413 past the api\'s threshold; collab objects as they are', {timeout: 240_000}, async t => {
  const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), 'morfa-ckpt-'));
  t.after(() => fs.rmSync(checkpointDir, {recursive: true, force: true}));
  const c = await collabApp(t, {env: {DESIGN_CHECKPOINT_DIR: checkpointDir, DESIGN_CHECKPOINT_API_BYTES: '', DESIGN_CHECKPOINT_CACHE_BYTES: ''}});
  const {db, files, ok, base, cookie} = c;
  const {checkpointReads, forgetCheckpoints} = await import('../server/design/document-checkpoint');
  const {engineWasm} = await import('../shared/design/engine-switch');
  // The editor's build (the web target), as lane O's open decodes the bytes.
  const web = await import('../src/design/wasm/morfa_wasm.js');
  web.initSync({module: fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'design', 'wasm', 'morfa_wasm_bg.wasm'))});
  const decodeWeb = (bytes: Buffer): DesignDocument => {
    const handle = web.MorfaDoc.decode(new Uint8Array(bytes));
    try {
      return JSON.parse(handle.to_json()) as DesignDocument;
    } finally {
      handle.free();
    }
  };
  const owner = await c.account('owner', 'Anna');
  const get = (who: Account, id: string, encoding = 'zstd, gzip;q=0.8, br') => raw(base, cookie(who), `/api/design-files/${id}/checkpoint`, encoding);
  const fileHeader = (answer: Raw) => JSON.parse(Buffer.from(String(answer.headers['x-design-file']), 'base64url').toString('utf8'));
  const doc = richDocument();
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Binary', document: doc}}), 201).file.id as string;

  await t.test('an api-path file: the bytes decode to the GET\'s document, in every encoding, with its version, file and access', async () => {
    const opened = ok(await files(owner, `/${id}`));
    for (const [accept, encoding] of [['zstd, gzip;q=0.8', 'zstd'], ['gzip, deflate, br', 'gzip'], ['identity', undefined], ['zstd;q=0, gzip', 'gzip']] as const) {
      const answer = await get(owner, id, accept);
      assert.equal(answer.status, 200, answer.body.toString());
      assert.equal(answer.headers['content-encoding'], encoding, accept);
      assert.equal(answer.headers['content-type'], 'application/vnd.morfa.mrfa');
      assert.equal(answer.headers.vary, 'Accept-Encoding');
      assert.equal(answer.headers['x-design-version'], String(opened.file.version));
      assert.equal(answer.headers['x-design-file-version'], String(opened.file.version));
      assert.equal(answer.headers['x-design-checkpoint-source'], 'encoded');
      assert.deepStrictEqual(fileHeader(answer), {file: opened.file, access: opened.access});
      const codec = codecOf(answer);
      assert.equal(codec.subarray(0, 4).toString('latin1'), 'MRFA');
      assert.deepStrictEqual(decodeWeb(codec), opened.document, `${accept}: the bytes are the GET's document`);
    }
  });

  await t.test('a second read of the same version is served from what the first kept; a save makes the next version', async () => {
    forgetCheckpoints();
    const first = checkpointReads();
    const one = await get(owner, id);
    const two = await get(owner, id);
    assert.deepEqual(checkpointReads(), {built: first.built + 1, cached: first.cached + 1});
    assert.ok(one.body.equals(two.body), 'the same bytes');
    const version = Number(one.headers['x-design-version']);
    const moved = {...doc.nodes.box, x: 321} as SceneNode;
    const saved = ok(await files(owner, `/${id}/document`, {method: 'PATCH', json: {baseVersion: version, patch: {nodes: {box: moved}}, before: {box: doc.nodes.box}}}));
    const three = await get(owner, id);
    assert.equal(three.headers['x-design-version'], String(saved.version));
    assert.equal(decodeWeb(codecOf(three)).nodes.box.x, 321);
    assert.deepStrictEqual(decodeWeb(codecOf(three)), ok(await files(owner, `/${id}`)).document);
    assert.deepEqual(checkpointReads(), {built: first.built + 2, cached: first.cached + 1});
  });

  await t.test('access: owner, team viewer, guest, link holder, stranger — the same answer as GET /:id', async () => {
    const viewer = await c.account('viewer', 'Vera');
    const guest = await c.account('guest', 'George');
    const linked = await c.account('linked', 'Lena');
    const stranger = await c.account('stranger');
    const teamId = ok(await c.teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
    const invite = ok(await c.teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role: 'viewer', days: 7, maxUses: 1}}), 201);
    ok(await c.teams(viewer, `/invites/${invite.token}/accept`, {method: 'POST'}));
    const teamFile = ok(await files(owner, '', {method: 'POST', json: {name: 'Team file', document: doc, teamId}}), 201).file.id as string;
    await db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'viewer')", [teamFile, guest.id]);
    const linkFile = ok(await files(owner, '', {method: 'POST', json: {name: 'By link', document: doc}}), 201).file.id as string;
    await db.execute("UPDATE design_files SET link_access='view' WHERE id=$1", [linkFile]);
    const cases: [string, Account, string, number][] = [
      ['the owner', owner, teamFile, 200],
      ['a viewer of the team', viewer, teamFile, 200],
      ['a guest of the file', guest, teamFile, 200],
      ['a stranger', stranger, teamFile, 404],
      ['a link holder', linked, linkFile, 200],
      ['a stranger to a personal file', stranger, id, 404],
    ];
    for (const [who, account, fileId, status] of cases) {
      const opened = await files(account, `/${fileId}`);
      const answer = await get(account, fileId);
      assert.equal(opened.status, status, `${who}: GET`);
      assert.equal(answer.status, opened.status, `${who}: the checkpoint answers as the GET`);
      if (status === 200) {
        assert.deepStrictEqual(fileHeader(answer), {file: opened.data.file, access: opened.data.access}, who);
        assert.deepStrictEqual(decodeWeb(codecOf(answer)), opened.data.document, who);
      } else assert.deepEqual(JSON.parse(answer.body.toString()).code, opened.data.code, who);
    }
    // Without a session: 401, as the GET.
    const anonymous = await raw(base, '', `/api/design-files/${id}/checkpoint`);
    assert.equal(anonymous.status, (await fetch(`${base}/api/design-files/${id}`)).status);
  });

  await t.test('an api-path file over DESIGN_CHECKPOINT_API_BYTES: 413 with a reason, before its document is read', async () => {
    const bytes = Number((await db.one<{bytes: number}>('SELECT bytes FROM design_files WHERE id=$1', [id]))!.bytes);
    forgetCheckpoints();
    process.env.DESIGN_CHECKPOINT_API_BYTES = String(bytes - 1);
    try {
      const before = checkpointReads();
      const answer = await get(owner, id);
      assert.equal(answer.status, 413);
      const body = JSON.parse(answer.body.toString());
      assert.equal(body.code, 'design_checkpoint_too_large');
      assert.match(body.reason, /collab path/);
      assert.deepEqual([body.bytes, body.limit], [bytes, bytes - 1]);
      assert.deepEqual(checkpointReads(), before, 'nothing was made');
    } finally {
      process.env.DESIGN_CHECKPOINT_API_BYTES = '';
    }
    assert.equal((await get(owner, id)).status, 200, 'at the default threshold it is served');
  });

  await t.test('a collab-path file: its checkpoint object as it is, at the object\'s version; the tail after it stays the join\'s', async () => {
    const collabFile = ok(await files(owner, '', {method: 'POST', json: {name: 'Shared', document: doc}}), 201).file.id as string;
    // The checkpoint a collab node wrote at version 5, and one journal row after it (version 6).
    const handle = new (engineWasm().MorfaDoc)(JSON.stringify(doc));
    handle.apply_patch(JSON.stringify({nodes: {box: {...doc.nodes.box, y: 55}}}));
    const atFive = JSON.parse(handle.to_json()) as DesignDocument;
    const codec = Buffer.from(handle.encode());
    handle.free();
    const object = checkpointObject(codec, 1, 5, Object.keys(atFive.nodes).length);
    const key = `ckpt/${collabFile}/5.bin.zst`;
    fs.mkdirSync(path.join(checkpointDir, path.dirname(key)), {recursive: true});
    fs.writeFileSync(path.join(checkpointDir, key), object);
    const tail = {nodes: {t0: {...atFive.nodes.t0, x: 999}}};
    await db.execute('UPDATE design_files SET checkpoint_key=$2,checkpoint_version=5,checkpoint_format=$3,version=6 WHERE id=$1', [collabFile, key, 'bin']);
    await db.execute('INSERT INTO design_file_changes(file_id,version,patch) VALUES($1,6,$2)', [collabFile, JSON.stringify(tail)]);
    const opened = ok(await files(owner, `/${collabFile}`));
    assert.equal(opened.file.version, 6);
    const zstd = await get(owner, collabFile, 'zstd');
    assert.equal(zstd.status, 200, zstd.body.toString());
    assert.deepEqual([zstd.headers['x-design-version'], zstd.headers['x-design-file-version'], zstd.headers['x-design-checkpoint-source']], ['5', '6', 'object']);
    assert.ok(zstd.body.equals(object.subarray(64)), 'a zstd client gets the object\'s body as it is');
    assert.deepStrictEqual(fileHeader(zstd), {file: opened.file, access: opened.access});
    for (const accept of ['gzip', 'identity']) {
      const answer = await get(owner, collabFile, accept);
      assert.ok(codecOf(answer).equals(codec), `${accept}: the object's codec bytes`);
    }
    // The bytes are version 5; the row after it makes the GET's version 6.
    const decoded = decodeWeb(codecOf(zstd));
    assert.deepStrictEqual(decoded, atFive);
    assert.deepStrictEqual(applyPatch(decoded, tail), opened.document);
    // A JSON checkpoint object (format 2) is written in the codec, still at the object's version.
    const jsonKey = `ckpt/${collabFile}/7.json.zst`;
    fs.writeFileSync(path.join(checkpointDir, jsonKey), checkpointObject(Buffer.from(JSON.stringify(opened.document)), 2, 7, Object.keys(opened.document.nodes).length));
    await db.execute('DELETE FROM design_file_changes WHERE file_id=$1', [collabFile]);
    await db.execute("UPDATE design_files SET checkpoint_key=$2,checkpoint_version=7,checkpoint_format='json',version=7 WHERE id=$1", [collabFile, jsonKey]);
    const fromJson = await get(owner, collabFile);
    assert.deepEqual([fromJson.status, fromJson.headers['x-design-version'], fromJson.headers['x-design-checkpoint-source']], [200, '7', 'object']);
    assert.deepStrictEqual(decodeWeb(codecOf(fromJson)), ok(await files(owner, `/${collabFile}`)).document);
    // A missing object: 503, as the GET answers it.
    fs.rmSync(path.join(checkpointDir, jsonKey));
    forgetCheckpoints();
    assert.equal((await get(owner, collabFile)).status, 503);
  });
});
