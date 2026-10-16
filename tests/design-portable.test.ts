import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import type {DesignDocument, ImagePaint} from '../shared/design/types';
import type {DesignFileSummary, DesignPortableFile} from '../shared/design/api';
import {exportPortable, importPortable, openPortableAsNewFile, PortableFileError, portableFilename, readPortable, type PortableDeps} from '../src/design/persistence/portable';

// src/design/persistence/portable.ts: "Save to computer" and opening the file in another account.

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const picture = (ref: string): ImagePaint => ({type: 'IMAGE', imageRef: ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'});

function documentWithPictures(): DesignDocument {
  const doc = createDocument('page');
  doc.nodes.photo = createNode('RECTANGLE', {id: 'photo', parentId: 'page', fills: [picture('dz-old')], strokes: [picture('dz-gone')]});
  doc.nodes.page.children!.push('photo');
  doc.images['dz-old'] = {url: '/uploads/dz-old.webp', width: 1, height: 1, name: 'Coffee.png'};
  doc.images['dz-gone'] = {url: '/uploads/dz-gone.webp', width: 1, height: 1};
  doc.styles.s = {id: 's', type: 'FILL', name: 'Photo', description: '', paints: [picture('dz-old')]};
  return doc;
}
const asFile = (value: unknown, name = 'Mockup.rdesign') => Object.assign(new Blob([typeof value === 'string' ? value : JSON.stringify(value)]), {name});

test('export inlines every readable picture and names the file', async () => {
  const doc = documentWithPictures();
  const blob = await exportPortable('Coffee shop: landing', doc, {read: async url => (url.includes('dz-old') ? PNG : Promise.reject(new Error('404')))});
  const file = JSON.parse(await blob.text()) as DesignPortableFile;
  assert.equal(file.format, 'morfa-design');
  assert.equal(file.formatVersion, 1);
  assert.equal(file.name, 'Coffee shop: landing');
  assert.deepEqual(Object.keys(file.imageData), ['dz-old'], 'an unreadable picture is left out');
  assert.equal(portableFilename('Coffee shop: landing'), 'Coffee shop landing.rdesign');
  assert.equal(portableFilename('  '), 'Untitled.rdesign');
});

test('opening checks the file: format, version, document, pictures, size', async () => {
  const doc = documentWithPictures();
  const valid = {format: 'morfa-design', formatVersion: 1, name: 'Mockup', document: doc, imageData: {'dz-old': PNG}};
  assert.equal((await readPortable(asFile(valid))).name, 'Mockup');
  const refusals: [unknown, RegExp][] = [
    ['not json', /not a Morfa file/],
    [{format: 'figma'}, /not a Morfa file/],
    [{...valid, formatVersion: 2}, /newer version/],
    [{...valid, document: {...doc, pages: []}}, /damaged.*pages/],
    [{...valid, imageData: {'dz-old': 'data:text/html;base64,PHNjcmlwdD4='}}, /not PNG/],
    [{...valid, imageData: {'dz-old': 'https://evil.example/x.png'}}, /not PNG/],
  ];
  const link = structuredClone(doc);
  link.nodes.photo.reactions = [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'javascript:alert(1)', openInNewTab: false}]}];
  refusals.push([{...valid, document: link}, /damaged/]);
  const foreign = structuredClone(doc);
  foreign.images['dz-old'].url = 'https://evil.example/x.png';
  refusals.push([{...valid, document: foreign}, /damaged/]);
  for (const [value, message] of refusals) await assert.rejects(readPortable(asFile(value)), (error: unknown) => error instanceof PortableFileError && message.test(error.message), JSON.stringify(value).slice(0, 80));
  const huge = Object.assign(new Blob([new Uint8Array(51 * 1024 * 1024)]), {name: 'big.rdesign'});
  await assert.rejects(readPortable(huge), /50 MB/);
  // A file without a name takes the name of the file on disk.
  assert.equal((await readPortable(asFile({...valid, name: ''}, 'My mockup.rdesign'))).name, 'My mockup');
});

test('importing uploads each inlined picture into the file and rewrites every reference', async () => {
  const doc = documentWithPictures();
  const uploads: {fileId: string; type: string; name?: string}[] = [];
  const result = await importPortable(asFile({format: 'morfa-design', formatVersion: 1, name: 'Mockup', document: doc, imageData: {'dz-old': PNG}}), 'file-9', {
    upload: async (fileId, image, name) => {
      uploads.push({fileId, type: image.type, name});
      return {ref: 'dz-new', asset: {url: '/uploads/dz-new.png', width: 1, height: 1}};
    },
  });
  assert.deepEqual(uploads, [{fileId: 'file-9', type: 'image/png', name: 'Coffee.png'}]);
  assert.deepEqual(result.document.images, {'dz-new': {url: '/uploads/dz-new.png', width: 1, height: 1, name: 'Coffee.png'}});
  assert.equal((result.document.nodes.photo.fills[0] as ImagePaint).imageRef, 'dz-new');
  assert.equal((result.document.nodes.photo.strokes[0] as ImagePaint).imageRef, '', 'a picture without data points at nothing');
  assert.equal((result.document.styles.s.paints![0] as ImagePaint).imageRef, 'dz-new');
});

test('opening as a new file: create, upload into it, then store the document; a failure erases the new file', async () => {
  const doc = documentWithPictures();
  const file = asFile({format: 'morfa-design', formatVersion: 1, name: 'Mockup', document: doc, imageData: {'dz-old': PNG}});
  const steps: string[] = [];
  const summary: DesignFileSummary = {id: 'new-file', name: 'Mockup', version: 1, createdAt: 'c', updatedAt: 'c', thumbnailUrl: null, trashedAt: null};
  const deps = (failAt?: string): PortableDeps => ({
    create: async data => {
      steps.push('create:' + data.name);
      return {file: summary};
    },
    upload: async fileId => {
      steps.push('upload:' + fileId);
      if (failAt === 'upload') throw new Error('Image storage is full');
      return {ref: 'dz-new', asset: {url: '/uploads/dz-new.png', width: 1, height: 1}};
    },
    replace: async (id, baseVersion, document) => {
      steps.push(`replace:${id}:${baseVersion}:${Object.keys(document.images).join()}`);
      return {version: 2, updatedAt: 'u'};
    },
    erase: async id => void steps.push('erase:' + id),
  });
  const opened = await openPortableAsNewFile(file, deps());
  assert.deepEqual(steps, ['create:Mockup', 'upload:new-file', 'replace:new-file:1:dz-new']);
  assert.deepEqual([opened.file.version, opened.file.updatedAt], [2, 'u']);
  steps.length = 0;
  await assert.rejects(openPortableAsNewFile(file, deps('upload')), /Image storage/);
  assert.deepEqual(steps, ['create:Mockup', 'upload:new-file', 'erase:new-file']);
  steps.length = 0;
  await assert.rejects(openPortableAsNewFile(asFile('{}'), deps()), PortableFileError);
  assert.deepEqual(steps, [], 'nothing is made for a file that does not pass the checks');
});

test('a picture the server calls busy (its 60 a minute) waits and goes again: the file still opens', async () => {
  // Arrange: a file of three pictures, the server refusing the second upload twice with 429 before it takes it.
  const doc = documentWithPictures();
  doc.images['dz-gone'] = {url: '/uploads/dz-gone.webp', width: 1, height: 1, name: 'Second.png'};
  doc.images['dz-third'] = {url: '/uploads/dz-third.webp', width: 1, height: 1, name: 'Third.png'};
  const file = asFile({format: 'morfa-design', formatVersion: 1, name: 'Many pictures', document: doc, imageData: {'dz-old': PNG, 'dz-gone': PNG, 'dz-third': PNG}});
  const summary: DesignFileSummary = {id: 'busy-file', name: 'Many pictures', version: 1, createdAt: 'c', updatedAt: 'c', thumbnailUrl: null, trashedAt: null};
  let calls = 0, waits = 0;
  const steps: string[] = [];
  const deps: PortableDeps = {
    create: async () => ({file: summary}),
    upload: async (_fileId, _image, name) => {
      calls++;
      if (name === 'Second.png' && calls <= 3) throw Object.assign(new Error('Too many requests. Wait a minute and try again.'), {status: 429, details: {code: 'rate_limited'}});
      steps.push('upload:' + name);
      return {ref: 'dz-' + calls, asset: {url: `/uploads/dz-${calls}.png`, width: 1, height: 1}};
    },
    replace: async () => ({version: 2, updatedAt: 'u'}),
    erase: async id => void steps.push('erase:' + id),
    sleep: async () => void waits++,
  };

  // Act
  const opened = await openPortableAsNewFile(file, deps);

  // Assert: every picture is uploaded once it is let in, nothing is erased, and the document points at the uploads.
  assert.deepEqual(steps, ['upload:Coffee.png', 'upload:Second.png', 'upload:Third.png']);
  assert.equal(waits, 2);
  assert.equal(Object.keys(opened.document.images).length, 3);
});

test('a board\'s copy says it is a board and opens again as a board; a design file\'s says nothing (docs/board.md)', async () => {
  const doc = documentWithPictures();
  const read = async () => PNG;
  const board = JSON.parse(await (await exportPortable('Retro', doc, {read, kind: 'board'})).text()) as DesignPortableFile;
  const design = JSON.parse(await (await exportPortable('Mockup', doc, {read, kind: 'design'})).text()) as DesignPortableFile;
  assert.equal(board.kind, 'board');
  assert.equal('kind' in design, false, 'a design file\'s copy is what it always was');
  assert.equal((await readPortable(asFile(board))).kind, 'board');
  assert.equal((await readPortable(asFile(design))).kind, 'design');
  assert.equal((await readPortable(asFile({...design, kind: 'whiteboard'}))).kind, 'design', 'an unknown kind opens as a design file');
  const made: unknown[] = [];
  const summary: DesignFileSummary = {id: 'b', name: 'Retro', version: 1, createdAt: 'c', updatedAt: 'c', thumbnailUrl: null, trashedAt: null, kind: 'board'};
  await openPortableAsNewFile(asFile(board), {
    create: async data => (made.push(data), {file: summary}),
    upload: async () => ({ref: 'dz-new', asset: {url: '/uploads/dz-new.png', width: 1, height: 1}}),
    replace: async () => ({version: 2, updatedAt: 'u'}),
    erase: async () => undefined,
  });
  assert.deepEqual(made, [{name: 'Retro', kind: 'board'}]);
});
