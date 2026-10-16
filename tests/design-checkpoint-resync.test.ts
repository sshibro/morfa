import test from 'node:test';
import assert from 'node:assert/strict';
import {engineWasm} from '../shared/design/engine-switch';
import type {DesignFileOpened} from '../shared/design/api';
import {browserWsIo, checkpointDocument, jsonCodec, wsTransport, type WsIo} from '../src/design/realtime/transport/ws';
import {FIXTURES} from '../scripts/goldens/fixtures';

// BIG.md stage E (lane W): a reload through the file's checkpoint. collab's `welcome`/`resync` name api's
// `GET /api/design-files/:id/checkpoint` (crates/collab tests/resync_checkpoint.rs: when, and the changes after it); the
// client reads its bytes (`application/vnd.morfa.mrfa`, `X-Design-Version`) into the document, and opens the api's copy
// when the checkpoint is not served.

const fixture = () => FIXTURES.find(f => f.name === 'product-file')!.build();

function bytesOf(doc: unknown): {bytes: Uint8Array; json: unknown} {
  const handle = new (engineWasm().MorfaDoc)(JSON.stringify(doc));
  try {
    return {bytes: handle.encode(), json: JSON.parse(handle.to_json())};
  } finally {
    handle.free();
  }
}

test('checkpoint bytes read back as the document the codec holds', async () => {
  const {bytes, json} = bytesOf(fixture());
  assert.deepEqual(await checkpointDocument(bytes), json);
});

test('the snapshot fetch reads the checkpoint route: the codec at X-Design-Version, or JSON as before', async () => {
  const {bytes, json} = bytesOf(fixture());
  const original = globalThis.fetch;
  let answer: () => Response = () => new Response(bytes as unknown as BodyInit, {headers: {'Content-Type': 'application/vnd.morfa.mrfa', 'X-Design-Version': '42'}});
  globalThis.fetch = (async () => answer()) as typeof fetch;
  try {
    assert.deepEqual(await browserWsIo.snapshot('/api/design-files/f/checkpoint'), {version: 42, document: json});
    answer = () => new Response(JSON.stringify({version: 7, document: json}), {headers: {'Content-Type': 'application/json'}});
    assert.deepEqual(await browserWsIo.snapshot('/x'), {version: 7, document: json});
    answer = () => new Response(bytes as unknown as BodyInit, {headers: {'Content-Type': 'application/vnd.morfa.mrfa'}});
    await assert.rejects(browserWsIo.snapshot('/x'), /X-Design-Version/);
    answer = () => new Response(JSON.stringify({error: 'none', code: 'design_checkpoint_unavailable'}), {status: 503, headers: {'Content-Type': 'application/json'}});
    await assert.rejects(browserWsIo.snapshot('/x'));
  } finally {
    globalThis.fetch = original;
  }
});

test('a reload whose checkpoint is not served opens the api copy instead', async () => {
  const doc = fixture();
  const opened = {file: {version: 9}, document: doc} as unknown as DesignFileOpened;
  const calls: string[] = [];
  const io = {
    snapshot: async (url: string) => {
      calls.push(`snapshot ${url}`);
      throw new Error('503');
    },
    open: async (fileId: string) => {
      calls.push(`open ${fileId}`);
      return opened;
    },
  } as unknown as WsIo;
  const transport = wsTransport({codec: jsonCodec, io});
  assert.equal(await transport.open('f', {version: 5, snapshotUrl: '/api/design-files/f/checkpoint'}), opened);
  assert.deepEqual(calls, ['snapshot /api/design-files/f/checkpoint', 'open f']);
});
