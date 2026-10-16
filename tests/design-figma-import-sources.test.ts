import assert from 'node:assert/strict';
import test from 'node:test';
import {pageRunner} from '../src/design/import/figma/import-runner';
import {depsFor, type PageCall} from '../src/design/import/figma/import-deps';
import type {RunDeps} from '../src/design/import/figma/run-import';
import {FigmaApiError} from '../src/figma-import/figma-client';
import {FigFileError} from '../src/figma-import/fig-file';
import {MAX_FIG_BYTES} from '../src/figma-import/fig-file/fig-client';
import type {DesignDocument, ImagePaint} from '../shared/design/types';
import {validateDocument} from '../shared/design/schema';
import {figKit, figZip, sampleFig, SAMPLE_HASH, TINY_PNG} from './helpers/fig-kit';
import {NUXT_LIKE} from './helpers/figma-kit';

// "Import from Figma" through its runner (src/design/import/figma/import-runner.ts), from either source: a .fig is unpacked and kept
// where the import runs (the dialog gets a summary), its pictures come out of the file, and a big kit is saved in parts exactly as it
// would be saved whole. The worker runs this same code (import.worker.ts); here it runs on the page (`pageRunner`).

type Saves = {methods: string[]; doc: DesignDocument | null; uploads: number};

function fakeCalls(parts: boolean): {calls: Pick<RunDeps, PageCall>; saves: Saves} {
  const saves: Saves = {methods: [], doc: null, uploads: 0};
  let version = 1;
  const calls: Pick<RunDeps, PageCall> = {
    createFile: async data => ({file: {id: 'file-1', name: data.name ?? '', version: 1, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}}),
    uploadImage: async () => {
      saves.uploads++;
      const ref = 'dz-' + saves.uploads;
      return {ref, asset: {url: `/uploads/${ref}.png`, width: 1, height: 1}};
    },
    replaceDocument: async (_fileId, baseVersion, document) => {
      assert.equal(baseVersion, version);
      saves.methods.push('PUT');
      saves.doc = structuredClone(document);
      return {version: ++version, updatedAt: ''};
    },
    eraseFile: async () => undefined,
  };
  if (parts)
    calls.patchDocument = async (_fileId, body) => {
      const {baseVersion, patch} = JSON.parse(await body.text()) as {baseVersion: number; patch: {nodes: DesignDocument['nodes']}};
      assert.equal(baseVersion, version);
      saves.methods.push('PATCH');
      Object.assign(saves.doc!.nodes, patch.nodes);
      return {version: ++version, updatedAt: ''};
    };
  return {calls, saves};
}

const blob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]);

test('a .fig: read where the import runs, the dialog gets its pages; pictures come out of the file', async () => {
  const {calls, saves} = fakeCalls(true);
  const runner = pageRunner(calls);
  const stages: string[] = [];
  const read = await runner.read({kind: 'fig', fileKey: 'fig:Layout', file: blob(figZip(sampleFig(), {[SAMPLE_HASH]: TINY_PNG})), fileName: 'Layout.fig'}, undefined, stage => stages.push(stage.stage));
  assert.deepEqual(stages, ['read']);
  assert.equal('file' in read, false, 'the summary carries no file');
  assert.equal(read.name, 'Layout');
  assert.equal(read.whole, true);
  assert.deepEqual(read.pages.map(page => page.name), ['Screens']);
  const outcome = await runner.run(read, read.pages.map(page => page.id), null, undefined, () => undefined);
  assert.equal(outcome.imagesCopied, 1);
  assert.deepEqual(saves.methods, ['PUT'], 'a small file is saved whole');
  assert.equal((saves.doc!.nodes['1:2'].fills[0] as ImagePaint).imageRef, 'dz-1');
});

test('a big kit saved as a .fig is saved in parts, the same document as saved whole', async () => {
  const kit = figKit({...NUXT_LIKE, pages: 14, borrow: true, pictures: 2});
  const whole = fakeCalls(false);
  const inParts = fakeCalls(true);
  for (const {calls} of [whole, inParts]) {
    const runner = pageRunner(calls);
    const read = await runner.read({kind: 'fig', fileKey: 'fig:kit', file: blob(kit.zip), fileName: 'Nuxt UI.fig'}, undefined, () => undefined);
    const outcome = await runner.run(read, read.pages.map(page => page.id), null, undefined, () => undefined);
    assert.equal(outcome.imagesCopied, 2);
    assert.deepEqual(outcome.report.items.filter(item => item.group === 'limits').map(item => item.key), []);
  }
  assert.deepEqual(whole.saves.methods, ['PUT']);
  assert.equal(inParts.saves.methods[0], 'PUT');
  assert.ok(inParts.saves.methods.filter(method => method === 'PATCH').length > 1, inParts.saves.methods.join(' '));
  assert.deepEqual(inParts.saves.doc, whole.saves.doc);
  const layers = Object.values(whole.saves.doc!.nodes).filter(node => node.type !== 'PAGE').length;
  assert.ok(layers >= kit.layers * 0.95, `${layers} of ${kit.layers}`);
  validateDocument(inParts.saves.doc!);
});

test('the runner keeps one file: a new read lets the last go; a link run needs its token', async () => {
  const runner = pageRunner(fakeCalls(true).calls);
  const first = await runner.read({kind: 'fig', fileKey: 'fig:a', file: blob(figZip(sampleFig())), fileName: 'a.fig'}, undefined, () => undefined);
  await runner.read({kind: 'fig', fileKey: 'fig:b', file: blob(figZip(sampleFig())), fileName: 'b.fig'}, undefined, () => undefined);
  await assert.rejects(runner.run(first, ['0:1'], null, undefined, () => undefined), /read again/);
  runner.dispose();
  await assert.rejects(runner.run(first, ['0:1'], null, undefined, () => undefined), /read again/);

  // A link's file is read again from Figma at run time, with the token the dialog has then.
  const held = {read: {fileKey: 'KEY', name: 'Project', file: {document: {children: []}}, whole: true, pages: []}, images: null};
  assert.throws(() => depsFor(held, null, fakeCalls(true).calls), (error: unknown) => error instanceof FigmaApiError && error.kind === 'token');
  assert.ok(depsFor(held, {token: 'figd_x', kind: 'token'}, fakeCalls(true).calls).client);
});

test('a .fig that cannot be read says why; one over the size cap is not read at all', async () => {
  const runner = pageRunner(fakeCalls(true).calls);
  await assert.rejects(runner.read({kind: 'fig', fileKey: 'fig:x', file: blob(new TextEncoder().encode('not a fig')), fileName: 'x.fig'}, undefined, () => undefined), FigFileError);
  const huge = {size: MAX_FIG_BYTES + 1, arrayBuffer: () => assert.fail('a file over the cap is not read')} as unknown as Blob;
  await assert.rejects(runner.read({kind: 'fig', fileKey: 'fig:y', file: huge, fileName: 'y.fig'}, undefined, () => undefined), /larger than 400 MB/);
});
