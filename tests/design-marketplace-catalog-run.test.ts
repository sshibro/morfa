// These tests assume a host that is not a Mac (as the other store tests): pin it before any design module loads.
import './helpers/linux-platform';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {DesignDocument, ImagePaint, NodeId} from '../shared/design/types';
import {cardMeta, withCardMeta, withLayerRole} from '../shared/design/marketplace/meta';
import type {CatalogFetchAnswer} from '../shared/design/marketplace/catalog-api';
import {autoMapping, catalogRows, parseTableText, templateSlots, type CatalogMapping} from '../shared/design/marketplace/catalog';
import {createDesignStore} from '../src/design/engine/store';
import {runCatalog, type CatalogProgress} from '../src/design/marketplace/catalog/run';

// The editor's side of a catalog run (docs/marketplaces.md §Catalog run) on a real store: batches of 50 rows as undo steps with their
// pictures, photos fetched once per address before the batch that needs them, dropped files matched by SKU, rows without a photo
// reported with why, "Stop" keeping what was made, a refused change reported.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

// The spreadsheet headers "Артикул;Название;Фото" and the title layer "Название" are Cyrillic on purpose: Russian-style marketplace
// catalogs (Wildberries/Ozon) name their columns this way and the automatic mapping recognizes them.
function template(): DesignDocument {
  const tx = beginTransaction(createDocument('page', 'Templates'));
  tx.create(createNode('FRAME', {id: 'card', name: 'Card', width: 900, height: 1200, pluginData: withCardMeta(undefined, {v: 1, marketplace: 'ozon', group: 'set-1'})}), 'page');
  tx.create(createNode('TEXT', {id: 'title', name: 'Название', parentId: 'card', x: 60, y: 60, fills: [solid({r: 0, g: 0, b: 0})], text: defaultTextProps('Название')}), 'card');
  tx.create(createNode('RECTANGLE', {id: 'photo', name: 'Product', parentId: 'card', x: 200, y: 300, width: 500, height: 600, pluginData: withLayerRole(undefined, 'product'),
    fills: [{type: 'IMAGE', imageRef: '', scaleMode: 'FIT', opacity: 1, visible: true, blendMode: 'NORMAL'}]}), 'card');
  return tx.commit({measurer}).doc;
}

function setup(rows: number, photo: (row: number) => string) {
  const store = createDesignStore({doc: template(), measurer});
  const lines = ['Артикул;Название;Фото'];
  for (let i = 0; i < rows; i++) lines.push(`S${i};Product ${i};${photo(i)}`);
  const table = parseTableText(lines.join('\n'));
  const mapping = autoMapping(table, templateSlots(store.getState().doc, 'card'));
  return {store, table, mapping, rows: catalogRows(table, mapping).rows};
}

const fakeFetch = (calls: string[][]) => async (_fileId: string, urls: readonly string[]): Promise<CatalogFetchAnswer> => {
  calls.push([...urls]);
  return {results: urls.map(url => (url.includes('/bad/') ? {url, error: 'The site with the photo answered with error 404.', code: 'http_error'} : {url, ref: `ref:${url.slice(-8)}`, asset: {url: `/uploads/${url.length}.webp`, width: 100, height: 100}}))};
};
const photoOf = (store: ReturnType<typeof createDesignStore>, cardId: NodeId) => {
  const doc = store.getState().doc;
  const photo = doc.nodes[cardId].children!.map(id => doc.nodes[id]).find(node => node.name === 'Product')!;
  return (photo.fills[0] as ImagePaint).imageRef;
};

test('should make the cards in batches of 50, one undo step each, with their photos and the rows without one', async () => {
  // Every third row has no link, every fifth links to a page that fails; rows 0 and 51 share a link.
  const link = (row: number) => (row % 3 === 2 ? '' : row % 5 === 4 ? `https://cdn.test/bad/${row}.jpg` : `https://cdn.test/p/${row === 51 ? 0 : row}.jpg`);
  const {store, table, mapping, rows} = setup(120, link);
  const calls: string[][] = [];
  const progress: CatalogProgress[] = [];
  const outcome = await runCatalog({
    store, fileId: 'file', frameId: 'card', table, mapping, rows, files: [], signal: new AbortController().signal,
    onProgress: step => progress.push(step), fetchImages: fakeFetch(calls), now: () => new Date(2026, 9, 12),
  });
  assert.equal(outcome.failure, null);
  assert.equal(outcome.stopped, false);
  assert.equal(outcome.pageName, 'Catalog — 12.10.2026');
  assert.equal(outcome.cardIds.length, 120);
  const doc = store.getState().doc;
  assert.deepEqual(doc.nodes[outcome.pageId!].children, outcome.cardIds);
  assert.equal(cardMeta(doc.nodes[outcome.cardIds[7]])?.sku, 'S7');
  assert.equal(cardMeta(doc.nodes[outcome.cardIds[7]])?.group, 'set-1');
  // One request per batch, each address once in the whole run.
  assert.equal(calls.length, 3);
  const asked = calls.flat();
  assert.equal(new Set(asked).size, asked.length);
  assert.ok(!asked.includes('https://cdn.test/p/0.jpg') || asked.filter(url => url === 'https://cdn.test/p/0.jpg').length === 1);
  assert.equal(photoOf(store, outcome.cardIds[0]), 'ref:/p/0.jpg');
  assert.equal(photoOf(store, outcome.cardIds[51]), 'ref:/p/0.jpg');
  assert.ok(doc.images['ref:/p/0.jpg']);
  assert.equal(photoOf(store, outcome.cardIds[2]), '');
  const missing = new Map(outcome.withoutPhoto.map(entry => [entry.sku, entry.reason]));
  assert.equal(missing.get('S2'), 'no photo link');
  assert.equal(missing.get('S4'), 'The site with the photo answered with error 404.');
  assert.equal(missing.size, rows.filter(row => row % 3 === 2 || row % 5 === 4).length);
  assert.ok(progress.some(step => step.phase === 'photos') && progress.at(-1)!.phase === 'cards' && progress.at(-1)!.done === 120);

  // Three batches, three undo steps; the first takes the page away too.
  assert.equal(store.getState().history.undo, 'Catalog from a table');
  store.undo();
  assert.equal(store.getState().doc.nodes[outcome.pageId!].children!.length, 100);
  store.undo();
  store.undo();
  assert.equal(store.getState().doc.nodes[outcome.pageId!], undefined);
  assert.equal(store.getState().doc.images['ref:/p/0.jpg'], undefined);
  assert.equal(store.getState().doc.nodes.card.children!.length, 2);
});

test('should match dropped files to rows by SKU and upload each once', async () => {
  const {store, table, rows} = setup(4, () => '');
  const mapping: CatalogMapping = {sku: 0, bindings: {title: {kind: 'column', column: 1}, photo: {kind: 'files'}}};
  const uploads: string[] = [];
  const files = [new File([new Uint8Array([1])], 'S1.jpg'), new File([new Uint8Array([2])], 'S3_front.png'), new File([new Uint8Array([3])], 'other.png')];
  const outcome = await runCatalog({
    store, fileId: 'file', frameId: 'card', table, mapping, rows, files, signal: new AbortController().signal, onProgress: () => {},
    uploadImage: async (_fileId, _image, name) => {
      uploads.push(name);
      return {ref: `up:${name}`, asset: {url: '/uploads/a.webp', width: 1, height: 1}};
    },
  });
  assert.deepEqual(uploads.sort(), ['S1.jpg', 'S3_front.png']);
  assert.equal(photoOf(store, outcome.cardIds[1]), 'up:S1.jpg');
  assert.equal(photoOf(store, outcome.cardIds[3]), 'up:S3_front.png');
  assert.deepEqual(outcome.withoutPhoto, [{sku: 'S0', reason: 'no file with the article number in its name'}, {sku: 'S2', reason: 'no file with the article number in its name'}]);
});

test('should stop after the current step and keep what was made', async () => {
  const {store, table, mapping, rows} = setup(130, () => '');
  const stop = new AbortController();
  const outcome = await runCatalog({
    store, fileId: 'file', frameId: 'card', table, mapping: {...mapping, bindings: {title: {kind: 'column', column: 1}}}, rows, files: [], signal: stop.signal,
    onProgress: step => {
      if (step.phase === 'cards' && step.done === 50) stop.abort();
    },
  });
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.cardIds.length, 50);
  assert.equal(store.getState().doc.nodes[outcome.pageId!].children!.length, 50);
});

test('should say why when the store refuses the change', async () => {
  const doc = template();
  const store = createDesignStore({doc, measurer, readOnly: true});
  const table = parseTableText('Артикул;Название\nA;Cream');
  const outcome = await runCatalog({store, fileId: 'file', frameId: 'card', table, mapping: {sku: 0, bindings: {title: {kind: 'column', column: 1}}}, rows: [0], files: [], signal: new AbortController().signal, onProgress: () => {}});
  assert.equal(outcome.cardIds.length, 0);
  assert.equal(outcome.failure, 'The file is open for viewing only: no cards were created.');
  const missing = await runCatalog({store: createDesignStore({doc, measurer}), fileId: 'file', frameId: 'gone', table, mapping: {sku: 0, bindings: {}}, rows: [0], files: [], signal: new AbortController().signal, onProgress: () => {}});
  assert.match(missing.failure ?? '', /The template was deleted/);
});
