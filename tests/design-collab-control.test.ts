import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {zstdCompressSync} from 'node:zlib';
import {mintTicket, publicKeyFrom, readTicket, ticketKey, ticketPublicKey} from '../server/design/collab/tickets';
import {accountCollabMode, collabConfigFor, collabOverrides, fileCollabMode} from '../server/design/collab/switch';
import {collabNodes} from '../server/design/collab/config';
import {nodeFor, nodeFull} from '../server/design/collab/nodes';
import {decodeCheckpoint, decodeJournalRow, readCheckpointHeader} from '../server/design/collab/checkpoint';
import {canonicalJson, documentHash, firstDifference} from '../server/design/collab/shadow-log';
import {composedOf, composeStored} from '../server/design/document-compose';
import {engineWasm} from '../shared/design/engine-switch';
import {createDocument, createNode} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';
import {ticketKeys} from './helpers/collab-binary';

// The api's control-plane pieces of the Rust collab service that need no database (lane B6): tickets, the DESIGN_COLLAB switch,
// node picking, checkpoint objects and journal rows as collab writes them, and the shadow comparison's oracle.

const withEnv = (values: Record<string, string | undefined>, run: () => void) => {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key];
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

function doc(): DesignDocument {
  const base = createDocument('page');
  const rect = createNode('RECTANGLE', {id: 'r', parentId: 'page', x: 1.5, y: 2, width: 30, height: 40});
  return {...base, nodes: {...base.nodes, page: {...base.nodes.page, children: ['r']}, r: rect}};
}

test('tickets: Ed25519 over the claims bytes, the Rust struct order, 60 s, refused when altered or expired', () => {
  const keys = ticketKeys();
  const key = ticketKey(keys.privateKey)!;
  assert.equal(ticketPublicKey(key), keys.publicKey);
  const claims = {file: 'f-1', user: 'u-1', name: 'Anna', role: 'editor' as const, team: 't-1', origin: 'https://app.morfa.example', exp: Math.floor(Date.now() / 1000) + 60};
  const ticket = mintTicket(key, claims);
  const [payload] = ticket.split('.');
  assert.equal(Buffer.from(payload, 'base64url').toString(), JSON.stringify(claims), 'file, user, name, role, team, origin, exp');
  assert.deepEqual(readTicket(publicKeyFrom(keys.publicKey), ticket), claims);
  const forged = Buffer.from(JSON.stringify({...claims, role: 'owner'})).toString('base64url') + '.' + ticket.split('.')[1];
  assert.equal(readTicket(publicKeyFrom(keys.publicKey), forged), null);
  assert.equal(readTicket(publicKeyFrom(keys.publicKey), mintTicket(key, {...claims, exp: 1})), null, 'expired');
  assert.equal(readTicket(publicKeyFrom(ticketKeys().publicKey), ticket), null, 'another key');
  assert.equal(ticketKey('short'), null);
  // Without team and origin the fields are left out, as serde's skip_serializing_if writes them.
  const bare = mintTicket(key, {file: 'f', user: 'u', name: 'n', role: 'viewer', exp: 5});
  assert.equal(Buffer.from(bare.split('.')[0], 'base64url').toString(), '{"file":"f","user":"u","name":"n","role":"viewer","exp":5}');
});

test('the switch: global, per account and per team; a file follows its team, then its holder; no node means legacy', () => {
  withEnv({DESIGN_COLLAB: 'shadow', DESIGN_COLLAB_ACCOUNTS: 'acc:1=rust, team-9=legacy,bad=fast,=rust', DESIGN_COLLAB_NODES: 'a=http://127.0.0.1:3410'}, () => {
    assert.deepEqual([...collabOverrides()], [['acc:1', 'rust'], ['team-9', 'legacy']]);
    assert.equal(accountCollabMode('acc:1'), 'rust');
    assert.equal(accountCollabMode('someone'), 'shadow');
    assert.equal(fileCollabMode({user_id: 'acc:1', team_id: null}), 'rust');
    assert.equal(fileCollabMode({user_id: 'acc:1', team_id: 'team-9'}), 'legacy', 'the team decides for every member');
    assert.equal(fileCollabMode({user_id: 'other', team_id: 'team-x'}), 'shadow');
    assert.deepEqual(collabConfigFor('acc:1'), {designCollab: 'rust'});
  });
  withEnv({DESIGN_COLLAB: 'rust', DESIGN_COLLAB_ACCOUNTS: undefined, DESIGN_COLLAB_NODES: undefined}, () => {
    assert.equal(accountCollabMode('x'), 'legacy', 'nothing runs on collab without a node');
  });
  withEnv({DESIGN_COLLAB: 'rust', DESIGN_COLLAB_WIRE: 'binary', DESIGN_COLLAB_NODES: 'a=http://127.0.0.1:3410'}, () => {
    assert.deepEqual(collabConfigFor('x'), {designCollab: 'rust', designCollabWire: 'binary'});
  });
});

test('nodes: parsed with their public socket base; a file always hashes to the same node, files spread', () => {
  withEnv({DESIGN_COLLAB_NODES: 'a=http://10.0.0.5:3410|wss://a.collab.example, b=http://10.0.0.6:3410, broken, c=ftp://x'}, () => {
    assert.deepEqual(collabNodes(), [
      {name: 'a', internal: 'http://10.0.0.5:3410', public: 'wss://a.collab.example'},
      {name: 'b', internal: 'http://10.0.0.6:3410', public: 'http://10.0.0.6:3410'},
    ]);
    const picks = Array.from({length: 200}, (_, i) => nodeFor(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`)!.name);
    assert.equal(nodeFor('00000000-0000-0000-0000-000000000007')!.name, picks[7]);
    const a = picks.filter(name => name === 'a').length;
    assert.ok(a > 60 && a < 140, `${a} of 200 on a`);
    // A node over its memory cap gets no idle file while another has room; with every node full, the healthy ones still do.
    nodeFull('a', true);
    try {
      assert.ok(picks.every((_, i) => nodeFor(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`)!.name === 'b'));
      nodeFull('b', true);
      assert.equal(nodeFor('00000000-0000-0000-0000-000000000007')!.name, picks[7]);
    } finally {
      nodeFull('a', false);
      nodeFull('b', false);
    }
  });
});

/** An MRFC object as crates/checkpoint/src/format.rs writes it (header version 2). */
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

test('checkpoints: binary (the model codec, decoded by crates/wasm) and JSON objects; damage refused', () => {
  const document = doc();
  const handle = new (engineWasm().MorfaDoc)(JSON.stringify(document));
  const encoded = Buffer.from(handle.encode());
  handle.free();
  const bin = checkpointObject(encoded, 1, 7, 2);
  assert.deepEqual(readCheckpointHeader(bin), {headerVersion: 2, format: 'bin', version: 7, layers: 2, payloadBytes: encoded.length});
  assert.equal(documentHash(decodeCheckpoint(bin).document), documentHash(document));
  const json = checkpointObject(Buffer.from(JSON.stringify(document)), 2, 3, 2);
  assert.deepEqual(decodeCheckpoint(json).document, document);
  const damaged = Buffer.from(bin);
  damaged[damaged.length - 1] ^= 0xff;
  assert.throws(() => decodeCheckpoint(damaged), /does not match its hash/);
  assert.throws(() => decodeCheckpoint(Buffer.from('nope')), /not an MRFC object/);
});

test('journal rows: Node’s patch text, collab’s JSON op bytes and a whole document inline', () => {
  const document = doc();
  assert.deepEqual(decodeJournalRow('{"nodes":{}}', null, 2), {kind: 'patch', patch: {nodes: {}}});
  assert.deepEqual(decodeJournalRow(null, Buffer.from('{"pages":["page"]}'), 2), {kind: 'patch', patch: {pages: ['page']}});
  const replace = decodeJournalRow(null, checkpointObject(Buffer.from(JSON.stringify(document)), 2, 4, 2), 4);
  assert.equal(replace.kind, 'replace');
  assert.deepEqual(decodeJournalRow(null, Buffer.from('MRFJxxxx'), 5), {kind: 'entry', bytes: Buffer.from('MRFJxxxx')});
  // The paths that patch a held JSON document leave a file with store entries to the store path (composedOf).
  assert.throws(() => composeStored({document: JSON.stringify(document), version: 2, versions: [2], patches: [null], ops: [Buffer.from('MRFJxxxx')]}), /open for co-editing/);
  // A checkpoint as the base, with the rows above it (one a replace).
  const moved = {...document, nodes: {...document.nodes, r: {...document.nodes.r, x: 99}}};
  const composed = composeStored(
    {document: null, version: 6, checkpoint_key: 'ckpt/x/4.bin.zst', checkpoint_version: 4, versions: [5, 6], patches: [null, JSON.stringify({nodes: {r: {...moved.nodes.r, y: 50}}})], ops: [checkpointObject(Buffer.from(JSON.stringify(moved)), 2, 5, 2), null]},
    document,
  );
  assert.deepEqual([composed.nodes.r.x, composed.nodes.r.y], [99, 50]);
  assert.throws(() => composeStored({document: null, version: 7, checkpoint_key: 'k', checkpoint_version: 4, versions: [6], patches: ['{}'], ops: [null]}, document), /not the versions/);
});

test('packed journal rows (MRFZ: a JSON patch in zstd, crates/journal packed) read as their patch, on JSON and on the store', async () => {
  const document = doc();
  const moved = JSON.stringify({nodes: {r: {...document.nodes.r, x: 77, name: 'Layer '.repeat(300)}}});
  const packed = Buffer.concat([Buffer.from('MRFZ'), zstdCompressSync(Buffer.from(moved))]);
  assert.deepEqual(decodeJournalRow(null, packed, 2), {kind: 'patch', patch: JSON.parse(moved)});
  assert.throws(() => decodeJournalRow(null, Buffer.from('MRFZnot zstd'), 3), /row 3/);
  const text = JSON.stringify(document);
  const composed = composeStored({document: text, version: 2, versions: [2], patches: [null], ops: [packed]});
  assert.equal(composed.nodes.r.x, 77);
  // Beside a store entry the whole file is put together on the store, packed rows included.
  const writer = new (engineWasm().MorfaDoc)(text);
  writer.apply_patch(moved);
  const entry = Buffer.from(writer.commit_entry(JSON.stringify({nodes: {r: {...document.nodes.r, x: 78, name: 'Layer '.repeat(300)}}})));
  const expected = JSON.parse(writer.to_json());
  writer.free();
  assert.deepEqual(await composedOf({document: text, version: 3, versions: [2, 3], patches: [null, null], ops: [packed, entry]}), expected);
});

test('store journal entries (MRFJ rows) replay on the store, from the stored text or a checkpoint, between other rows', async () => {
  const document = doc();
  const moved = (x: number, y = 0, name = 'Layer with a new name') => JSON.stringify({nodes: {r: {...document.nodes.r, x, y, name}}});
  // A writer of such rows (as crates/checkpoint loads the file: the stored text parsed into the store), with a JSON patch row
  // and a whole document between its entries.
  const text = JSON.stringify(document);
  const writer = new (engineWasm().MorfaDoc)(text);
  const first = Buffer.from(writer.commit_entry(moved(10)));
  assert.equal(first.subarray(0, 4).toString('latin1'), 'MRFJ');
  writer.apply_patch(moved(20));
  const second = Buffer.from(writer.commit_entry(moved(30, 5)));
  const expected = JSON.parse(writer.to_json());
  writer.free();
  const fromText = await composedOf({document: text, version: 4, versions: [2, 3, 4], patches: [null, moved(20), null], ops: [first, null, second]});
  assert.deepEqual(fromText, expected);
  assert.deepEqual([fromText.nodes.r.x, fromText.nodes.r.y], [30, 5]);
  // Rows in the wrong order are a damaged file, never a document put together anyway (the first entry interned the new name the
  // second one continues from).
  await assert.rejects(composedOf({document: text, version: 3, versions: [2, 3], patches: [null, null], ops: [second, first]}), /row 2/);
  // From a checkpoint (the model codec, decoded as the Rust side decodes it) and entries that continue it.
  const base = new (engineWasm().MorfaDoc)(text);
  base.apply_patch(moved(40));
  const object = checkpointObject(Buffer.from(base.encode()), 1, 6, 2);
  const continued = engineWasm().MorfaDoc.decode(base.encode());
  base.free();
  const third = Buffer.from(continued.commit_entry(moved(50, 7)));
  const fromCheckpoint = JSON.parse(continued.to_json());
  continued.free();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  const key = 'ckpt/00000000-0000-4000-8000-000000000001/6.bin.zst';
  fs.mkdirSync(path.join(dir, path.dirname(key)), {recursive: true});
  fs.writeFileSync(path.join(dir, key), object);
  const saved = process.env.DESIGN_CHECKPOINT_DIR;
  process.env.DESIGN_CHECKPOINT_DIR = dir;
  try {
    const composed = await composedOf({document: null, version: 7, checkpoint_key: key, checkpoint_version: 6, versions: [7], patches: [null], ops: [third]});
    assert.deepEqual(composed, fromCheckpoint);
    assert.deepEqual([composed.nodes.r.x, composed.nodes.r.y], [50, 7]);
  } finally {
    if (saved === undefined) delete process.env.DESIGN_CHECKPOINT_DIR;
    else process.env.DESIGN_CHECKPOINT_DIR = saved;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('the shadow oracle: canonical JSON as schema.json x-documentHash says; the first differing path', () => {
  assert.equal(canonicalJson({b: 1, a: [true, null, 'x'], c: undefined, 'é': 0.5}), '{"a":[true,null,"x"],"b":1,"é":0.5}');
  assert.equal(firstDifference({nodes: {a: {x: 1}}}, {nodes: {a: {x: 2}}}), 'nodes.a.x');
  assert.equal(firstDifference({nodes: {}}, {nodes: {a: {}}}), 'nodes.a');
  assert.equal(firstDifference([1, 2], [1, 2]), null);
});
