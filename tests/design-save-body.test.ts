import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {patchDesignDocument, replaceDesignDocument} from '../src/design/api';

// Autosave's requests carry their JSON as a Blob (src/design/api.ts): a string body is copied and encoded on the main
// thread when the request starts — 80 ms for a 4 MB patch of 5 000 recoloured layers, 400 ms at a quarter of the speed
// (measured in Chromium on 2026-10-07) — a Blob's bytes are taken as they are. The server receives the same bytes.

async function captured(run: () => Promise<unknown>) {
  const sent: {url: string; init: RequestInit}[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({url, init});
    return new Response(JSON.stringify({version: 2, updatedAt: '2026-10-07T00:00:00.000Z'}), {status: 200, headers: {'Content-Type': 'application/json'}});
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

test('a patch and a whole document go as JSON Blobs with the bytes a string body had', async () => {
  // The Cyrillic name is kept on purpose: the body must carry non-ASCII text as the same UTF-8 bytes the string had.
  const patch = {nodes: {r: createNode('RECTANGLE', {id: 'r', parentId: 'page', name: 'Прямоугольник «один»'})}};
  const [patched] = await captured(() => patchDesignDocument('file', 3, patch, {keepalive: true}, {before: {r: null}}));
  assert.equal(patched.url, '/api/design-files/file/document');
  assert.equal(patched.init.method, 'PATCH');
  assert.equal(patched.init.keepalive, true);
  assert.ok(patched.init.body instanceof Blob);
  assert.equal(await (patched.init.body as Blob).text(), JSON.stringify({baseVersion: 3, patch, before: {r: null}}));
  assert.equal((patched.init.headers as Record<string, string>)['Content-Type'], 'application/json');

  const document = createDocument('page');
  const [replaced] = await captured(() => replaceDesignDocument('file', 4, document));
  assert.equal(replaced.init.method, 'PUT');
  assert.ok(replaced.init.body instanceof Blob);
  assert.equal(await (replaced.init.body as Blob).text(), JSON.stringify({baseVersion: 4, document}));
  assert.equal((replaced.init.body as Blob).size, new TextEncoder().encode(JSON.stringify({baseVersion: 4, document})).length);
});
