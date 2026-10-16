import assert from 'node:assert/strict';
import test from 'node:test';
import {FigmaApiError} from '../src/figma-import/figma-client';
import {readFigmaFile, runFigmaImport, type ImportStage, type RunDeps} from '../src/design/import/figma/run-import';
import type {FigmaFile, FigmaNode} from '../shared/design/figma-import';
import type {DesignDocument, ImagePaint} from '../shared/design/types';
import {validateDocument} from '../shared/design/schema';

// The import flow with fake Figma and "Design" APIs: reading (whole, rate-limited, page by page),
// pictures, saving, and cleaning up after a failure or a cancel.

type T = [[number, number, number], [number, number, number]];
const at = (x: number, y: number): T => [[1, 0, x], [0, 1, y]];
const N = (type: string, id: string, x: number, y: number, w: number, h: number, extra: Partial<FigmaNode> = {}): FigmaNode =>
  ({id, name: `${type} ${id}`, type, relativeTransform: at(x, y), size: {x: w, y: h}, absoluteBoundingBox: {x, y, width: w, height: h}, fills: [], strokes: [], effects: [], ...extra}) as FigmaNode;
const image = (ref: string) => ({type: 'IMAGE', scaleMode: 'FILL', imageRef: ref});

function figmaFile(): FigmaFile {
  return {
    name: 'Project',
    document: {children: [
      {id: '0:1', name: 'Screens', type: 'CANVAS', children: [
        N('FRAME', '1:1', 0, 0, 400, 300, {children: [
          N('RECTANGLE', '1:2', 0, 0, 200, 100, {fills: [image('aaa111')]}),
          N('RECTANGLE', '1:3', 0, 120, 200, 100, {fills: [image('bbb222')]}),
          N('RECTANGLE', '1:4', 0, 240, 200, 50, {fills: [image('ccc333')]}),
          N('INSTANCE', '1:5', 220, 0, 40, 40, {componentId: '2:1', children: [N('ELLIPSE', 'I1:5;2:2', 0, 0, 40, 40)]}),
        ]}),
      ]} as FigmaNode,
      {id: '0:2', name: 'Components', type: 'CANVAS', children: [N('COMPONENT', '2:1', 0, 0, 40, 40, {children: [N('ELLIPSE', '2:2', 0, 0, 40, 40)]})]} as FigmaNode,
    ]},
    components: {'2:1': {key: 'k', name: 'Dot'}},
  };
}

type Calls = {file: number[]; nodes: string[][]; uploads: string[]; erased: string[]; saved: DesignDocument[]; created: number};

function fakes(overrides: Partial<RunDeps> = {}, file = figmaFile()) {
  const calls: Calls = {file: [], nodes: [], uploads: [], erased: [], saved: [], created: 0};
  const deps: RunDeps = {
    client: {
      async file(_key, depth) {
        calls.file.push(depth);
        return structuredClone(file);
      },
      async nodes(_key, ids) {
        calls.nodes.push(ids);
        return {nodes: {}};
      },
      async imageFills() {
        return {aaa111: 'https://s3-alpha-sig.figma.com/img/aaa', bbb222: 'https://s3-alpha-sig.figma.com/img/bbb'};
      },
    },
    download: async url => new Blob([url], {type: 'image/png'}),
    shrink: async () => null,
    createFile: async data => {
      calls.created++;
      return {file: {id: 'file-1', name: data.name ?? 'Untitled', version: 1, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}};
    },
    uploadImage: async (_fileId, _picture, name) => {
      calls.uploads.push(name);
      const ref = 'dz-' + calls.uploads.length;
      return {ref, asset: {url: `/uploads/${ref}.png`, width: 10, height: 10}};
    },
    replaceDocument: async (_fileId, _version, document) => {
      calls.saved.push(document);
      return {version: 2, updatedAt: ''};
    },
    eraseFile: async id => {
      calls.erased.push(id);
    },
    sleep: async () => undefined,
    yieldToUi: async () => undefined,
    ...overrides,
  };
  return {deps, calls};
}

test('a whole file: read once with geometry, map, copy pictures, save into a new file', async () => {
  const {deps, calls} = fakes();
  const stages: ImportStage[] = [];
  const read = await readFigmaFile('KEY1234567890', deps, undefined, stage => stages.push(stage));
  assert.equal(read.whole, true);
  assert.deepEqual(read.pages.map(page => page.name), ['Screens', 'Components']);
  assert.deepEqual(calls.file, [0]);
  const outcome = await runFigmaImport(read, ['0:1'], deps, undefined, stage => stages.push(stage));
  assert.equal(outcome.fileId, 'file-1');
  assert.equal(outcome.imagesCopied, 2);
  assert.equal(outcome.imagesMissing, 1, 'Figma had no link for the third picture');
  assert.equal(calls.saved.length, 1);
  const saved = calls.saved[0];
  assert.ok(validateDocument(structuredClone(saved)).ok);
  assert.equal((saved.nodes['1:2'].fills[0] as ImagePaint).imageRef, 'dz-1');
  assert.equal(saved.nodes['1:4'].fills[0].type, 'SOLID', 'the missing picture became a grey fill');
  assert.deepEqual(Object.keys(saved.images).sort(), ['dz-1', 'dz-2']);
  assert.equal(saved.nodes['1:5'].type, 'INSTANCE', 'its main came along on the "Components" page');
  assert.ok(outcome.report.items.some(item => item.key === 'images-missing'));
  const kinds = stages.map(stage => stage.stage);
  for (const kind of ['read', 'map', 'create', 'images', 'save']) assert.ok(kinds.includes(kind as ImportStage['stage']), kind);
  assert.deepEqual(calls.erased, []);
});

test('Figma\'s rate limit is waited out with a countdown', async () => {
  let refused = false;
  const {deps, calls} = fakes();
  const inner = deps.client.file;
  deps.client.file = async (key, depth, signal, geometry) => {
    if (!refused) {
      refused = true;
      throw new FigmaApiError({kind: 'rate', status: 429, retryAfter: 3});
    }
    return inner(key, depth, signal, geometry);
  };
  const stages: ImportStage[] = [];
  const read = await readFigmaFile('KEY1234567890', deps, undefined, stage => stages.push(stage));
  assert.equal(read.whole, true);
  assert.deepEqual(stages.filter(stage => stage.stage === 'wait').map(stage => (stage as {seconds: number}).seconds), [3, 2, 1]);
  assert.equal(calls.file.length, 1);

  const {deps: slow} = fakes();
  slow.client.file = async () => {
    throw new FigmaApiError({kind: 'rate', status: 429, retryAfter: 4000, rateType: 'low'});
  };
  await assert.rejects(readFigmaFile('KEY1234567890', slow, undefined, () => undefined), (error: unknown) => error instanceof FigmaApiError && /limited requests/.test(error.message));
});

test('a file too big for one answer is read page by page, with the mains it needs', async () => {
  const full = figmaFile();
  const {deps, calls} = fakes();
  deps.client.file = async (_key, depth) => {
    calls.file.push(depth);
    if (depth === 0) throw new FigmaApiError({kind: 'bad', status: 200, tooLarge: true});
    return {name: full.name, document: {children: full.document!.children!.map(page => ({id: page.id, name: page.name, type: 'CANVAS'}))}, components: full.components};
  };
  deps.client.nodes = async (_key, ids) => {
    calls.nodes.push(ids);
    const all = new Map<string, FigmaNode>();
    const stack = [...full.document!.children!];
    while (stack.length) {
      const node = stack.pop()!;
      all.set(node.id, node);
      stack.push(...(node.children ?? []));
    }
    return {nodes: Object.fromEntries(ids.map(id => [id, all.has(id) ? {document: structuredClone(all.get(id)), components: full.components} : null]))};
  };
  const read = await readFigmaFile('KEY1234567890', deps, undefined, () => undefined);
  assert.equal(read.whole, false);
  assert.deepEqual(read.pages.map(page => page.layers), [null, null]);
  const outcome = await runFigmaImport(read, ['0:1'], deps, undefined, () => undefined);
  assert.deepEqual(calls.file, [0, 1]);
  assert.deepEqual(calls.nodes, [['0:1'], ['2:1']]);
  const saved = calls.saved[0];
  assert.equal(saved.nodes['1:5'].type, 'INSTANCE');
  assert.ok(saved.nodes['2:1']);
  assert.ok(validateDocument(structuredClone(saved)).ok);
  assert.equal(outcome.report.pages, 2);
});

test('no room for pictures: the file is still saved, the report says why', async () => {
  const {deps, calls} = fakes({
    uploadImage: async () => {
      throw Object.assign(new Error('Not enough room'), {status: 413, details: {code: 'design_storage_limit'}});
    },
  });
  const read = await readFigmaFile('KEY1234567890', deps, undefined, () => undefined);
  const outcome = await runFigmaImport(read, ['0:1', '0:2'], deps, undefined, () => undefined);
  assert.equal(outcome.imagesCopied, 0);
  assert.equal(calls.saved.length, 1);
  const item = outcome.report.items.find(entry => entry.key === 'images-missing');
  assert.ok(item && /Not enough room/.test(item.message));
});

test('a picture refused as too big is redrawn smaller once; the server\'s upload limit is waited out', async () => {
  let refusals = 0, limited = 0, shrunk = 0;
  const {deps, calls} = fakes({
    uploadImage: async (_fileId, picture, name) => {
      if (picture.size > 3 && refusals++ < 1) throw Object.assign(new Error('The image is too large'), {status: 413});
      if (limited++ < 1) throw Object.assign(new Error('Too many requests'), {status: 429});
      calls.uploads.push(name);
      return {ref: 'dz-' + calls.uploads.length, asset: {url: `/uploads/dz-${calls.uploads.length}.png`, width: 1, height: 1}};
    },
    shrink: async () => {
      shrunk++;
      return new Blob(['abc'], {type: 'image/webp'});
    },
  });
  const read = await readFigmaFile('KEY1234567890', deps, undefined, () => undefined);
  const outcome = await runFigmaImport(read, ['0:1'], deps, undefined, () => undefined);
  assert.equal(shrunk, 1);
  assert.equal(outcome.imagesCopied, 2);
});

test('a failed save or a cancel erases the half-made file; a file limit creates nothing', async () => {
  const failing = fakes({
    replaceDocument: async () => {
      throw Object.assign(new Error('The file is larger than 20 MB.'), {status: 413, details: {code: 'design_document_too_large'}});
    },
  });
  const read = await readFigmaFile('KEY1234567890', failing.deps, undefined, () => undefined);
  await assert.rejects(runFigmaImport(read, ['0:1'], failing.deps, undefined, () => undefined), /20 MB/);
  assert.deepEqual(failing.calls.erased, ['file-1']);

  const controller = new AbortController();
  const cancelled = fakes({
    download: async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    },
  });
  await assert.rejects(runFigmaImport(read, ['0:1'], cancelled.deps, controller.signal, () => undefined));
  assert.deepEqual(cancelled.calls.erased, ['file-1']);
  assert.equal(cancelled.calls.saved.length, 0);

  const refused = fakes({
    createFile: async () => {
      throw Object.assign(new Error('The server is unavailable.'), {status: 503});
    },
  });
  await assert.rejects(runFigmaImport(read, ['0:1'], refused.deps, undefined, () => undefined), /The server is unavailable/);
  assert.deepEqual(refused.calls.erased, []);
});
