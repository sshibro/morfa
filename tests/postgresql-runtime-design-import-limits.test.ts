import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument} from './helpers/collab-app';
import {createNode, defaultTextProps} from '../shared/design/defaults';
import {DESIGN_DOCUMENT_CAPS} from '../shared/design/limits';
import type {DesignDocument} from '../shared/design/types';

// The server's answers to an import over the caps name the file's number against the cap: a body
// over the reader's limit, a document over 20 MB that the reader let through (both PUT readers: the Rust fast path and the
// TypeScript one). An import saves the whole document with one PUT, so these are what it shows.

const MB = 1024 * 1024;
const digits = (text: string) => text.replace(/[\s ]/g, '');

/** smallDocument with `texts` text layers of 100 000 characters each (about 100 KB of JSON apiece). */
function heavy(texts: number): DesignDocument {
  const doc = smallDocument();
  const page = doc.pages[0]!;
  for (let k = 0; k < texts; k++) {
    const id = 'long' + k;
    doc.nodes[id] = createNode('TEXT', {id, parentId: page, name: 'Text', text: defaultTextProps('x'.repeat(100_000))});
    doc.nodes[page]!.children!.push(id);
  }
  return doc;
}

test('an import over the caps is refused with the file\'s size or layers against the cap', {timeout: 240_000}, async t => {
  const c = await collabApp(t);
  const {files, ok} = c;
  const owner = await c.account('owner', 'Anna');
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Import', document: smallDocument()}}), 201).file.id as string;
  const put = (document: unknown, contentType = 'application/json') =>
    c.fetchAs(owner, `/api/design-files/${id}/document`, {method: 'PUT', body: JSON.stringify({baseVersion: 1, document}), headers: {'content-type': contentType}});
  // The fixed caps, whatever DESIGN_BIG_FILES says (the server reads it at each request): the gate may run with big files on.
  const saved = process.env.DESIGN_BIG_FILES;
  delete process.env.DESIGN_BIG_FILES;
  t.after(() => {
    if (saved === undefined) delete process.env.DESIGN_BIG_FILES;
    else process.env.DESIGN_BIG_FILES = saved;
  });

  await t.test('a document over 20 MB within the reader\'s limit: 413 with its size, on both readers', async () => {
    const doc = heavy(215);
    const bytes = Buffer.byteLength(JSON.stringify(doc));
    assert.ok(bytes > DESIGN_DOCUMENT_CAPS.bytes && bytes < DESIGN_DOCUMENT_CAPS.bytes + MB, `${bytes}`);
    const answer = await put(doc);
    assert.equal(answer.status, 413);
    assert.equal(answer.data.code, 'design_document_too_large');
    assert.equal(answer.data.message ?? answer.data.error, `The file is ${(bytes / MB).toLocaleString('en-US', {maximumFractionDigits: 1})} MB, the limit is 20 MB. Split it into several files.`);
    assert.deepEqual([answer.data.bytes, answer.data.limit], [bytes, DESIGN_DOCUMENT_CAPS.bytes]);
    // The TypeScript reader (a body the fast path declines: an escaped surrogate in a name) says the same.
    const declined = structuredClone(doc);
    declined.nodes.long0!.name = '\ud83d';
    const typescript = await put(declined);
    assert.equal(typescript.status, 413);
    assert.match(typescript.data.error, /^The file is 2\d(\.\d)? MB, the limit is 20 MB\./);
  });

  await t.test('a body over the reader\'s limit: 413 with the body\'s size', async () => {
    const answer = await put(heavy(240));
    assert.equal(answer.status, 413);
    assert.equal(answer.data.code, 'design_document_too_large');
    assert.match(answer.data.error, /^The file is 2[34]\.\d MB, the limit is 20 MB\. Split it into several files\.$/);
  });
  // The layer cap is not reached through a PUT on the fixed caps: 50 000 layers of a few hundred bytes each are over 20 MB, so the
  // size refusal above answers first (tests/design-figma-import-limits.test.ts checks the layer cap's message).
});
