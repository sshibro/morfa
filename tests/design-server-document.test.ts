import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {documentImageFiles, validateDocument} from '../shared/design/schema';
import type {DesignDocument} from '../shared/design/types';
import {documentNodeCount} from '../server/design/document-text';
import {readFastDocument, readFastPut, type FastDocument} from '../server/design/document-fast';
import {engineWasm} from '../shared/design/engine-switch';
import {ensureFixtures, FIXTURES_DIR} from '../scripts/fixtures/design-documents';
import {documentMutants, specialDocuments, type Base} from '../scripts/model/mutate';

// TARGETS S5's fast path (crates/wasm/src/server_document.rs): the model's reader decides a whole document first, and the
// TypeScript schema decides whatever it declines. The fast path must never accept what `validateDocument` refuses, and what it
// accepts must be stored as today: the same value (its text parses to zod's stripped value), the same byte length (the caps,
// `design_files.bytes`), the same layer count and the same pictures. Every fixture, seeded mutants of them
// (scripts/model/mutate.ts; MORFA_S5_MUTANTS, default 1 500) and the documents at the caps.

const read = readFastDocument;

// The fast path declines quietly without the server build (a dev machine, document-fast.ts), so a stale or missing
// server/design/wasm would read here as «the fast path accepted nothing». Each test checks the build first and says so.
function serverBuild() {
  const wasm = engineWasm() as unknown as Record<string, unknown>;
  assert.equal(
    typeof wasm.read_server_document,
    'function',
    'server/design/wasm is not the server build of crates/wasm (stale or built without `--features server`): run scripts/wasm-build.sh',
  );
}

type Verdict = {accepted: number; declined: number};

/** `fast` against `validateDocument`'s reading of `value` (what the route parsed from the same text). */
function same(name: string, fast: FastDocument, value: unknown) {
  const ts = validateDocument(value);
  assert.ok(ts.ok, `${name}: the fast path accepted a document validateDocument refuses${ts.ok ? '' : `: ${ts.error} at ${ts.path}`}`);
  const doc = ts.value as DesignDocument;
  const stored = JSON.stringify(doc);
  assert.deepStrictEqual(JSON.parse(fast.text.toString('utf8')), JSON.parse(stored), `${name}: the fast path's text is another document`);
  assert.equal(fast.bytes, Buffer.byteLength(stored), `${name}: the byte length differs`);
  assert.equal(fast.text.length, fast.bytes);
  assert.equal(fast.nodeCount, documentNodeCount(doc), `${name}: the layer count differs`);
  assert.deepStrictEqual(fast.imageFiles, documentImageFiles(doc), `${name}: the pictures differ`);
  assert.deepStrictEqual(fast.images, Object.fromEntries(Object.entries(doc.images).map(([ref, asset]) => [ref, {url: asset.url}])), `${name}: the picture table differs`);
}

const parsed = (name: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    return assert.fail(`${name}: the fast path accepted a text JSON.parse refuses (${(error as Error).message})`);
  }
};

/** The fast path's verdict on `text` against `validateDocument`'s: as a stored text (a restore), and inside a PUT body's UTF-8
 *  bytes (what the route would otherwise decode and parse). */
function check(name: string, text: string, verdict: Verdict) {
  const fast = read(text);
  if (fast) {
    verdict.accepted++;
    same(name, fast, parsed(name, text));
  } else verdict.declined++;
  const body = Buffer.from(`{"baseVersion":7,"document":${text}}`);
  const put = readFastPut(body);
  if (put) {
    assert.equal(put.baseVersion, 7);
    same(`${name} (PUT)`, put.document, (parsed(name, body.toString('utf8')) as {document: unknown}).document);
  }
}

test('S5 fast path: every fixture is read as validateDocument reads it', {timeout: 300_000}, async () => {
  serverBuild();
  const fixtures = await ensureFixtures();
  const verdict = {accepted: 0, declined: 0};
  for (const entry of fixtures) check(entry.name, fs.readFileSync(path.join(FIXTURES_DIR, entry.file), 'utf8'), verdict);
  // The fixtures are documents the app wrote: the fast path takes them all.
  assert.deepEqual(verdict, {accepted: fixtures.length, declined: 0});
});

test('S5 fast path: seeded mutants and the documents at the caps never get past it when validateDocument refuses them', {timeout: 600_000}, async () => {
  serverBuild();
  const fixtures = await ensureFixtures();
  const bases: Base[] = fixtures
    .filter(entry => entry.size !== 'heavy')
    .map(entry => ({name: entry.name, doc: JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, entry.file), 'utf8')) as DesignDocument}));
  const count = Number(process.env.MORFA_S5_MUTANTS ?? 1_500);
  const verdict = {accepted: 0, declined: 0};
  for (const mutant of documentMutants(bases, {seed: 5, count})) check(`mutant ${mutant.id} (${mutant.kinds.join(', ')})`, mutant.text, verdict);
  for (const special of specialDocuments()) check(special.name, special.build(), verdict);
  // Both sides are exercised: some mutants are valid documents, most are not.
  assert.ok(verdict.accepted > 0 && verdict.declined > 0, JSON.stringify(verdict));
});

test('S5 fast path: what it declines on purpose, and what it strips as the schema does', () => {
  serverBuild();
  const doc = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'template-blank.json'), 'utf8')) as DesignDocument;
  const verdict = {accepted: 0, declined: 0};
  // An escaped surrogate: the model would read a lone one as U+FFFD, JSON.parse keeps it. Declined, paired or not.
  const named = (name: string) => JSON.stringify({...doc, nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, node]) => [id, {...node, name}]))});
  assert.equal(read(named('\ud83d')), undefined);
  assert.equal(read(named('😀').replace('😀', '\\ud83d\\ude00')), undefined);
  // A picture outside /uploads/ (the api refuses it as another account's): declined, the TypeScript path answers.
  const picture = {...doc, images: {ref: {url: 'https://example.com/a.png', width: 1, height: 1}}};
  if (validateDocument(JSON.parse(JSON.stringify(picture))).ok) assert.equal(read(JSON.stringify(picture)), undefined);
  // Keys the schema does not know are dropped by both.
  check('unknown keys', JSON.stringify({...doc, extra: 1, nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, node]) => [id, {...node, unknown: [1]}]))}), verdict);
  // A repeated key: JSON.parse keeps the last value.
  const text = JSON.stringify(doc);
  check('repeated key', text.replace('{"schemaVersion"', '{"schemaVersion":0,"schemaVersion"'), verdict);
  check('not JSON', text.slice(0, -1), verdict);
  check('empty', '', verdict);
  assert.ok(verdict.accepted >= 1, JSON.stringify(verdict));
});
