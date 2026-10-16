import assert from 'node:assert/strict';
import test from 'node:test';
import {zipSync} from 'fflate';
import {decodeMessage, decodeSchema} from '../src/figma-import/fig-file/kiwi';
import {readFigContents} from '../src/figma-import/fig-file/container';
import {FigFileError, readFigFile} from '../src/figma-import/fig-file';
import {figRunParts} from '../src/figma-import/fig-file/fig-client';
import {pathOf} from '../src/figma-import/fig-file/to-rest';
import {runFigmaImport, type RunDeps} from '../src/design/import/figma/run-import';
import {figmaPages, importFigmaFile, type FigmaNode} from '../shared/design/figma-import';
import type {DesignDocument, ImagePaint} from '../shared/design/types';
import {validateDocument} from '../shared/design/schema';
import {at, canvasFig, solid, encodeMessage, encodeSchema, figZip, guid, node, polygonBlob, sampleFig as sample, SAMPLE_HASH as HASH, TINY_PNG} from './helpers/fig-kit';

// "Import from Figma" from a .fig file (src/figma-import/fig-file): the kiwi reader, the ZIP and canvas.fig
// around it, the node changes → Figma's REST shape (tree order, groups, text styles, paths, pictures,
// instances with overrides and component properties), and the whole import run on a .fig without a network.

const read = (value = sample()) => readFigFile(figZip(value, {[HASH]: TINY_PNG}), 'Mockup.fig');
const page = (file: ReturnType<typeof read>) => file.file.document!.children![0];
function find(root: FigmaNode, id: string): FigmaNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return undefined;
}

test('kiwi: a schema and a message read back as written', () => {
  // The layer name stays in Cyrillic (plus an emoji) on purpose: it is a non-ASCII, multi-byte UTF-8 string round trip.
  const schema = decodeSchema(encodeSchema());
  assert.ok(schema.byName.get('NodeChange')!.fields.some(field => field.name === 'symbolData' && field.type === 'SymbolData'));
  const message = decodeMessage(schema, encodeMessage({type: 'NODE_CHANGES', blobs: [{bytes: new Uint8Array([1, 2, 3])}], nodeChanges: [
    {guid: guid('7:3000000'), name: 'Ёлка 🎄', opacity: 0.25, size: {x: -1.5, y: 0}, textData: {characters: 'a', characterStyleIDs: [0, 1, 300]}},
  ]}));
  assert.equal(message.type, 'NODE_CHANGES');
  const [change] = message.nodeChanges as Record<string, unknown>[];
  assert.deepEqual(change.guid, {sessionID: 7, localID: 3000000});
  assert.equal(change.name, 'Ёлка 🎄');
  assert.equal(change.opacity, 0.25);
  assert.deepEqual(change.size, {x: -1.5, y: 0});
  assert.deepEqual((change.textData as {characterStyleIDs: number[]}).characterStyleIDs, [0, 1, 300]);
  assert.deepEqual([...((message.blobs as {bytes: Uint8Array}[])[0].bytes)], [1, 2, 3]);
});

test('the ZIP and a bare canvas.fig both read; other files are refused with a reason', () => {
  const zipped = readFigContents(figZip(sample(), {[HASH]: TINY_PNG}));
  assert.equal(zipped.images.get(HASH)?.length, TINY_PNG.length);
  const bare = readFigContents(canvasFig(sample()));
  assert.equal((bare.message.nodeChanges as unknown[]).length, sample().nodeChanges.length);

  assert.throws(() => readFigContents(new TextEncoder().encode('hello, not a design')), (error: unknown) => error instanceof FigFileError && /not a \.fig file/.test(error.message));
  assert.throws(() => readFigContents(canvasFig(sample(), 'fig-jam.')), (error: unknown) => error instanceof FigFileError && /FigJam/.test(error.message));
  assert.throws(() => readFigContents(zipSync({'meta.json': new Uint8Array([123, 125])})), (error: unknown) => error instanceof FigFileError && /canvas\.fig/.test(error.message));
  assert.throws(() => readFigContents(canvasFig(sample()).slice(0, 40)), (error: unknown) => error instanceof FigFileError);
});

test('paths: commands and float32 points become an SVG path', () => {
  assert.equal(pathOf(polygonBlob([[0, 0], [20, 0], [10, 20]])), 'M0 0 L20 0 L10 20 Z');
  assert.equal(pathOf(new Uint8Array([9, 9, 9])), undefined);
});

test('a union of stroked layers comes in as the shape Figma computed; one of filled layers stays a union', () => {
  const value = sample();
  const union = (id: string, x: number) => node(id, '0:1', ')', 'BOOLEAN_OPERATION', {name: 'Ring', size: {x: 20, y: 20}, transform: at(x, 0), fillPaints: [solid(0, 0, 0)], fillGeometry: [{windingRule: 'NONZERO', commandsBlob: 0}]});
  value.nodeChanges.push(union('9:1', 700), node('9:2', '9:1', '!', 'RECTANGLE', {size: {x: 20, y: 20}, transform: at(0, 0), strokeWeight: 1, strokePaints: [solid(0, 0, 0)]}));
  value.nodeChanges.push(union('9:3', 800), node('9:4', '9:3', '!', 'RECTANGLE', {size: {x: 20, y: 20}, transform: at(0, 0), fillPaints: [solid(0, 0, 0)]}));
  const tree = page(read(value));
  const ring = find(tree, '9:1')!;
  assert.equal(ring.type, 'VECTOR');
  assert.equal(ring.children, undefined);
  assert.equal(ring.fillGeometry![0].path, 'M0 0 L20 0 L10 20 Z');
  const square = find(tree, '9:3')!;
  assert.equal(square.type, 'BOOLEAN_OPERATION');
  assert.deepEqual(square.children!.map(child => child.id), ['9:4']);
});

test('the tree: shown pages only, sibling order, groups in their frame\'s space, auto layout, styles, pictures', () => {
  const fig = read();
  assert.equal(fig.name, 'Mockup');
  assert.deepEqual(fig.file.document!.children!.map(entry => entry.name), ['Screens']);
  const screens = page(fig);
  assert.deepEqual(screens.children!.map(child => child.id), ['1:1', '1:4', '2:1', '4:1', '2:9'], 'soft-deleted layers are left out');

  assert.deepEqual(screens.flowStartingPoints, [{nodeId: '1:1', name: 'Login'}]);
  const card = find(screens, '1:1')!;
  assert.deepEqual(card.children!.map(child => child.id), ['1:2', '1:3']);
  assert.equal(card.layoutMode, 'VERTICAL');
  assert.equal(card.primaryAxisSizingMode, 'AUTO');
  assert.deepEqual([card.paddingLeft, card.paddingTop, card.paddingRight, card.paddingBottom, card.itemSpacing], [16, 12, 20, 24, 8]);
  assert.equal(card.clipsContent, true);
  assert.deepEqual(card.relativeTransform, [[1, 0, 10], [0, 1, 20]]);

  const photo = find(screens, '1:2')!;
  assert.equal(photo.type, 'RECTANGLE');
  assert.equal(photo.layoutAlign, 'STRETCH');
  assert.deepEqual(photo.fills, [{type: 'IMAGE', opacity: 1, imageRef: HASH, scaleMode: 'FILL'}]);

  const title = find(screens, '1:3')!;
  assert.equal(title.characters, 'Hello');
  assert.equal(title.style!.fontFamily, 'Inter');
  assert.equal(title.style!.fontStyle, 'Bold', 'the shared text style wins over the values cached on the layer');
  assert.equal(title.style!.fontSize, 24);
  assert.equal(title.style!.lineHeightUnit, 'INTRINSIC_%');
  assert.ok(Math.abs(title.style!.letterSpacing! - 2.4) < 1e-6, 'percent letter spacing → pixels of the style\'s size');
  assert.equal(title.style!.textAutoResize, 'HEIGHT');
  assert.equal(title.styles!.text, '5:1');
  assert.equal(fig.file.styles!['5:1'].name, 'Heading');

  const group = find(screens, '1:4')!;
  assert.equal(group.type, 'GROUP');
  const triangle = find(screens, '1:5')!;
  assert.deepEqual(triangle.relativeTransform, [[1, 0, 310], [0, 1, 45]], 'a group\'s child sits in the space of the frame above the group');
  assert.deepEqual(triangle.absoluteBoundingBox, {x: 310, y: 45, width: 20, height: 20});
  assert.deepEqual(triangle.fillGeometry, [{path: 'M0 0 L20 0 L10 20 Z', windingRule: 'NONZERO'}]);
});

test('instances: copies of the main with REST ids, overrides, Figma\'s layout and property values', () => {
  const fig = read();
  const screens = page(fig);
  const main = find(screens, '2:1')!;
  assert.equal(main.type, 'COMPONENT');
  assert.deepEqual(main.componentPropertyDefinitions, {'Label#3:1': {type: 'TEXT', defaultValue: 'OK'}, 'Icon#3:2': {type: 'BOOLEAN', defaultValue: true}});
  assert.deepEqual(find(screens, '2:2')!.componentPropertyReferences, {characters: 'Label#3:1'});

  const save = find(screens, '2:9')!;
  assert.equal(save.type, 'INSTANCE');
  assert.equal(save.componentId, '2:1');
  assert.deepEqual(save.componentProperties, {'Label#3:1': {type: 'TEXT', value: 'Save'}, 'Icon#3:2': {type: 'BOOLEAN', value: true}});
  assert.deepEqual(save.children!.map(child => child.id), ['I2:9;2:2', 'I2:9;2:3']);
  assert.equal(find(save, 'I2:9;2:2')!.characters, 'Save');
  const icon = find(save, 'I2:9;2:3')!;
  assert.equal(icon.componentId, '4:1');
  assert.deepEqual(icon.relativeTransform, [[1, 0, 110], [0, 1, 10]], 'Figma\'s derived layout for the stretched instance');
  const dot = find(save, 'I2:9;2:3;4:2')!;
  assert.deepEqual(dot.fills, [{type: 'SOLID', opacity: 1, color: {r: 0, g: 0, b: 1, a: 1}}], 'the override two instances deep');
  // The main's own nested instance copies its main too, without the override.
  assert.deepEqual(find(main, 'I2:3;4:2')!.fills, [{type: 'SOLID', opacity: 1, color: {r: 1, g: 0, b: 0, a: 1}}]);
  assert.deepEqual(fig.file.components!['2:1'], {name: 'Button', description: '', remote: false});
});

test('a component that holds itself and a main from a library: bounded copies, overrides by the library\'s keys', () => {
  const value = sample();
  // Dot now holds an instance of itself, and a new instance points at a main on the hidden page.
  value.nodeChanges.push(node('4:3', '4:1', '"', 'INSTANCE', {size: {x: 10, y: 10}, transform: at(0, 0), symbolData: {symbolID: guid('4:1')}}));
  value.nodeChanges.push(node('8:1', '0:2', '"', 'SYMBOL', {name: 'Library icon', size: {x: 10, y: 10}, transform: at(0, 0)}));
  // A main copied in from a library: its rectangle keeps its library guid as overrideKey, and the instance's override
  // and Figma's derived size name it by that key.
  value.nodeChanges.push(node('8:2', '8:1', '!', 'RECTANGLE', {size: {x: 10, y: 10}, transform: at(0, 0), overrideKey: guid('99:5')}));
  value.nodeChanges.push(node('8:9', '0:1', '\'', 'INSTANCE', {
    size: {x: 40, y: 20}, transform: at(500, 0),
    symbolData: {symbolID: guid('8:1'), symbolOverrides: [{guidPath: {guids: [guid('99:5')]}, fillPaints: [solid(1, 0, 0)]}]},
    derivedSymbolData: [{guidPath: {guids: [guid('99:5')]}, size: {x: 40, y: 20}}],
  }));
  const fig = read(value);
  assert.equal(fig.truncated, false);
  assert.ok(fig.file.components!['8:1'].remote, 'a main off the shown pages is a library one');
  const icon = find(page(fig), '8:9')!;
  assert.deepEqual(icon.children!.map(child => child.id), ['I8:9;8:2'], 'REST ids stay the guids in this file');
  assert.deepEqual(icon.children![0].size, {x: 40, y: 20});
  assert.deepEqual((icon.children![0].fills![0] as {color: unknown}).color, {r: 1, g: 0, b: 0, a: 1});
  const mapped = importFigmaFile(fig.file, {pageIds: figmaPages(fig.file).map(entry => entry.id)});
  assert.ok(validateDocument(structuredClone(mapped.doc)).ok);
});

test('mapped by the Figma importer: the instance stays an instance of its main, with its own text', () => {
  const fig = read();
  const mapped = importFigmaFile(fig.file, {pageIds: figmaPages(fig.file).map(entry => entry.id)});
  assert.ok(validateDocument(structuredClone(mapped.doc)).ok);
  const keys = mapped.report.items.map(item => item.key);
  assert.ok(!keys.some(key => key.startsWith('detached')), keys.join(', '));
  const save = mapped.doc.nodes['2:9'];
  assert.equal(save.type, 'INSTANCE');
  assert.equal(save.componentId, '2:1');
  const label = Object.values(mapped.doc.nodes).find(entry => entry.parentId === '2:9' && entry.type === 'TEXT');
  assert.equal(label?.text?.characters, 'Save');
  assert.deepEqual(mapped.imageRefs, [HASH]);
});

test('the whole run on a .fig: no Figma calls, pictures come from the file', async () => {
  const fig = read();
  const parts = figRunParts(fig.images);
  const saved: DesignDocument[] = [];
  const uploads: Blob[] = [];
  const deps: RunDeps = {
    ...parts,
    shrink: async () => null,
    createFile: async data => ({file: {id: 'file-1', name: data.name ?? '', version: 1, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}}),
    uploadImage: async (_fileId, picture) => {
      uploads.push(picture);
      return {ref: 'dz-1', asset: {url: '/uploads/dz-1.png', width: 1, height: 1}};
    },
    replaceDocument: async (_fileId, _version, document) => {
      saved.push(document);
      return {version: 2, updatedAt: ''};
    },
    eraseFile: async () => undefined,
    yieldToUi: async () => undefined,
  };
  await assert.rejects(parts.client.file('fig', 0), FigFileError);
  const outcome = await runFigmaImport({fileKey: 'fig:Mockup', name: fig.name, file: fig.file, whole: true, pages: figmaPages(fig.file)}, ['0:1'], deps, undefined, () => undefined);
  assert.equal(outcome.imagesCopied, 1);
  assert.equal(outcome.imagesMissing, 0);
  assert.equal(uploads[0].type, 'image/png');
  assert.equal(uploads[0].size, TINY_PNG.length);
  assert.equal((saved[0].nodes['1:2'].fills[0] as ImagePaint).imageRef, 'dz-1');
  assert.equal(outcome.name, 'Mockup');
});
