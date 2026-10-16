import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {textBoxSize, type TextMeasurer} from '../shared/design/text-layout';
import type {DesignDocument, ImagePaint, NodeId, SceneNode} from '../shared/design/types';
import {cardMeta, withCardMeta, withLayerRole, type LayerRole} from '../shared/design/marketplace/meta';
import {
  autoMapping,
  catalogBatchRows,
  catalogCapacity,
  catalogGrid,
  catalogPageName,
  catalogRows,
  findPhotoColumn,
  insertCard,
  mappingProblem,
  matchPhotoFiles,
  parseTableText,
  photoFills,
  photoUrlOf,
  planCard,
  slotText,
  templateSlots,
  utf8Length,
  type CatalogMapping,
  type CatalogTable,
} from '../shared/design/marketplace/catalog';

// Catalog run (docs/marketplaces.md §Catalog run): a card as the template, a table's rows as cards — what is matched to what
// automatically, what one row's copy looks like (texts in their styles, long ones wrapped, photos, meta), and what the file has
// room for. Cards go through real transactions with a fixed-width measurer.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const measure = (node: SceneNode) => textBoxSize({...node, text: {...node.text!, textAutoResize: 'WIDTH_AND_HEIGHT'}}, measurer).width;
const ink = [solid({r: 0.1, g: 0.1, b: 0.1})];

/** A 900 × 1200 WB card: a headline showing "Title", a price with a placeholder, a column of two benefits and the product. */
function template(): DesignDocument {
  const tx = beginTransaction(createDocument('page', 'Templates'));
  const role = (value: LayerRole) => withLayerRole(undefined, value);
  tx.create(createNode('FRAME', {id: 'card', name: 'Card', width: 900, height: 1200, fills: [solid({r: 1, g: 1, b: 1})], pluginData: withCardMeta(undefined, {v: 1, marketplace: 'wb', slide: 'main', variant: 3})}), 'page');
  // The headline is bold from its second word on: replacing it keeps the style of its first character.
  tx.create(createNode('TEXT', {id: 'title', name: 'Headline', parentId: 'card', x: 60, y: 60, fills: ink, pluginData: role('headline'),
    text: {...defaultTextProps('Title'), style: {...defaultTextProps().style, fontSize: 48, fontWeight: 700}}}), 'card');
  tx.create(createNode('TEXT', {id: 'price', name: 'Price', parentId: 'card', x: 60, y: 160, fills: ink, text: {...defaultTextProps('{{Цена}} ₽'), runs: [{start: 0, end: 8, style: {fontWeight: 700}}]}}), 'card');
  tx.create(createNode('FRAME', {id: 'list', name: 'Benefits', parentId: 'card', x: 60, y: 240, width: 400, height: 100, fills: [],
    autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 12}, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG'}), 'card');
  tx.create(createNode('TEXT', {id: 'b1', name: 'Benefit', parentId: 'list', fills: ink, pluginData: role('benefit'), text: defaultTextProps('Item')}), 'list');
  tx.create(createNode('TEXT', {id: 'b2', name: 'Benefit', parentId: 'list', fills: ink, pluginData: role('benefit'), text: defaultTextProps('Item')}), 'list');
  tx.create(createNode('RECTANGLE', {id: 'photo', name: 'Product photo', parentId: 'card', x: 300, y: 500, width: 500, height: 600, pluginData: role('product'),
    fills: [{type: 'IMAGE', imageRef: '', scaleMode: 'CROP', imageTransform: [[1, 0, 0], [0, 1, 0]], opacity: 1, visible: true, blendMode: 'NORMAL'}]}), 'card');
  tx.create(createNode('TEXT', {id: 'note', name: 'Footnote', parentId: 'card', x: 60, y: 1150, fills: ink, text: defaultTextProps('Stays the same')}), 'card');
  return tx.commit({measurer}).doc;
}

// The table headers (and the {{Цена}} placeholder) stay Russian on purpose: sellers' catalogs for Wildberries and Ozon have Russian
// headers, and column matching knows those words. Cell values and layer names are English sample data.
const table = (): CatalogTable => parseTableText([
  'Артикул;Название;Цена;Преимущество 1;Преимущество 2;Фото',
  'A-1;Cream;490;Moisturizes;;https://cdn.example.ru/a-1.jpg',
  'A-2;An extra long name of a hand cream with shea butter and vitamin E;1 290;Nourishes;Unscented;https://cdn.example.ru/a-2.jpg',
  ';No SKU;1;;;',
].join('\n'));

/** Every planned card of `rows` on a new page, in one transaction. */
function run(doc: DesignDocument, mapping: CatalogMapping, rows: number[], photo: (row: number) => string | null = () => null) {
  const tx = beginTransaction(doc);
  tx.addPage(createNode('PAGE', {id: 'catalog', name: 'Catalog'}));
  const grid = catalogGrid(rows.length, doc.nodes.card);
  const plans = rows.map((row, index) => planCard({doc, frameId: 'card', table: tableData, mapping, row, position: grid.position(index), measure, photoFor: () => photo(row)}));
  for (const plan of plans) insertCard(tx, plan, 'catalog', doc.variableModes);
  return {doc: tx.commit({measurer}).doc, plans};
}
const tableData = table();
const textOf = (doc: DesignDocument, id: NodeId) => doc.nodes[id].text!;

test('should list the template\'s texts in reading order, then its pictures, hidden layers left out', () => {
  const doc = template();
  const hidden = beginTransaction(doc);
  hidden.create(createNode('TEXT', {id: 'ghost', name: 'Hidden', parentId: 'card', visible: false, text: defaultTextProps('x')}), 'card');
  const slots = templateSlots(hidden.commit({measurer}).doc, 'card');
  assert.deepEqual(slots.map(slot => [slot.id, slot.kind]), [['title', 'text'], ['price', 'text'], ['b1', 'text'], ['b2', 'text'], ['note', 'text'], ['photo', 'image']]);
  assert.deepEqual(slots[1].placeholders, ['Цена']);
  assert.equal(slots[0].role, 'headline');
});

test('should map the SKU, a sample text to its column, placeholders, benefits in order and the product photo', () => {
  const doc = template();
  const slots = templateSlots(doc, 'card');
  const mapping: CatalogMapping = autoMapping(tableData, slots);
  assert.equal(mapping.sku, 0);
  assert.deepEqual({...mapping.bindings}, {
    title: {kind: 'column', column: 1},
    price: {kind: 'template'},
    b1: {kind: 'column', column: 3},
    b2: {kind: 'column', column: 4},
    photo: {kind: 'column', column: 5},
  });
  assert.equal(mappingProblem(mapping, slots, tableData), null);
  assert.equal(mappingProblem({...mapping, sku: null}, slots, tableData), 'Choose the column with the article number.');
  assert.equal(mappingProblem({sku: 0, bindings: {}}, slots, tableData), 'Choose which layers to fill from the table.');
  assert.equal(slotText(slots[1], mapping.bindings.price, tableData, 1, '{{Цена}} ₽'), '1 290 ₽');

  // Without a photo column, dropped files fill the product; with a layer named like a column, that column wins.
  const noPhoto = parseTableText('SKU;Заголовок;Состав\n1;Cream;Water');
  const loose = autoMapping(noPhoto, slots, {files: true});
  assert.equal(loose.sku, 0);
  assert.deepEqual(loose.bindings.title, {kind: 'column', column: 1});
  assert.deepEqual(loose.bindings.photo, {kind: 'files'});
  assert.equal(loose.bindings.b1, undefined);
});

test('should find photo addresses in a column and pick the first https address of a cell', () => {
  assert.equal(findPhotoColumn(parseTableText('a;Картинки\n1;https://x.ru/1.jpg; https://x.ru/2.jpg\n2;')), 1);
  assert.equal(findPhotoColumn(parseTableText('a;b\n1;https://x.ru/1.jpg\n2;https://x.ru/2.jpg')), 1);
  assert.equal(findPhotoColumn(parseTableText('a;b\n1;none\n2;https://x.ru/2.jpg\n3;none')), null);
  assert.equal(photoUrlOf('see https://cdn.ru/a b.jpg'), 'https://cdn.ru/a');
  assert.equal(photoUrlOf('https://cdn.ru/1.jpg;https://cdn.ru/2.jpg'), 'https://cdn.ru/1.jpg');
  assert.equal(photoUrlOf('no photo'), null);
});

test('should match dropped photos to SKUs by file name: exact, then prefix, then a whole word, never inside a longer number', () => {
  const files = ['1234.jpg', 'cream-123-white.webp', '123_2.png', '123_1.png', 'A-7.JPG', 'misc.png', 'x99y.png'];
  assert.deepEqual(matchPhotoFiles(['1234', '123', 'a-7', '99', ''], files), [0, 3, 4, -1, -1]);
  assert.deepEqual(matchPhotoFiles(['456'], ['folder/456 (copy).jpg']), [0]);
});

test('should make one card per row: texts in their styles, placeholders filled, the SKU and set in its meta, empty cells hidden', () => {
  const doc = template();
  const mapping = autoMapping(tableData, templateSlots(doc, 'card'));
  const {rows, withoutSku} = catalogRows(tableData, mapping);
  assert.deepEqual(rows, [0, 1]);
  assert.deepEqual(withoutSku, [2]);
  const {doc: out, plans} = run(doc, mapping, rows, row => (row === 0 ? 'ref-a1' : null));
  const page = out.nodes.catalog;
  assert.equal(page.children!.length, 2);
  const [first, second] = plans;
  const card = out.nodes[first.rootId];
  assert.equal(card.name, 'A-1');
  assert.deepEqual(cardMeta(card), {v: 1, marketplace: 'wb', slide: 'main', group: 'card', sku: 'A-1'});
  assert.notEqual(first.rootId, 'card');
  assert.equal(out.nodes[second.rootId].x, 900 + catalogGrid(2, {width: 900, height: 1200}).gap);

  const title = textOf(out, first.ids.get('title')!);
  assert.equal(title.characters, 'Cream');
  assert.equal(title.style.fontSize, 48);
  assert.equal(title.style.fontWeight, 700);
  const price = textOf(out, first.ids.get('price')!);
  assert.equal(price.characters, '490 ₽');
  // The placeholder was bold, the « ₽» after it was not.
  assert.deepEqual(price.runs, [{start: 0, end: 3, style: {fontWeight: 700}}]);
  assert.equal(textOf(out, first.ids.get('b1')!).characters, 'Moisturizes');
  const empty = out.nodes[first.ids.get('b2')!];
  assert.equal(empty.visible, false);
  assert.equal(empty.text!.characters, '');
  assert.equal(textOf(out, first.ids.get('note')!).characters, 'Stays the same');
  // The template is untouched.
  assert.equal(out.nodes.title.text!.characters, 'Title');
  assert.deepEqual(cardMeta(out.nodes.card)?.variant, 3);

  // The photo replaced the placeholder (its crop dropped); a row without one keeps the placeholder and says so.
  const fill = out.nodes[first.ids.get('photo')!].fills[0] as ImagePaint;
  assert.equal(fill.imageRef, 'ref-a1');
  assert.equal(fill.scaleMode, 'FILL');
  assert.equal(fill.imageTransform, undefined);
  assert.equal(first.missingPhoto, false);
  assert.equal(second.missingPhoto, true);
  assert.equal((out.nodes[second.ids.get('photo')!].fills[0] as ImagePaint).imageRef, '');
});

test('should wrap a long text inside the card\'s margins instead of widening it, and fill a column of benefits', () => {
  const doc = template();
  const mapping = autoMapping(tableData, templateSlots(doc, 'card'));
  const {doc: out, plans} = run(doc, mapping, [0, 1]);
  const short = out.nodes[plans[0].ids.get('title')!];
  assert.equal(short.text!.textAutoResize, 'WIDTH_AND_HEIGHT');
  const long = out.nodes[plans[1].ids.get('title')!];
  assert.equal(long.text!.textAutoResize, 'HEIGHT');
  // 60 px in from the left: wraps 60 px before the right edge, and grows down.
  assert.equal(long.width, 900 - 60 - 60);
  assert.equal(long.x, 60);
  assert.ok(long.height >= 48 * 2, `two lines or more, got ${long.height}`);
  const card = out.nodes[plans[1].rootId];
  assert.equal(card.width, 900);

  // A benefit too long for its column fills the column's width and wraps.
  const wide = parseTableText(`Артикул;Преимущество 1\nX;${'Very '.repeat(30)}`);
  const benefits = autoMapping(wide, templateSlots(doc, 'card'));
  const tx = beginTransaction(doc);
  tx.addPage(createNode('PAGE', {id: 'catalog', name: 'Catalog'}));
  const plan = planCard({doc, frameId: 'card', table: wide, mapping: benefits, row: 0, position: {x: 0, y: 0}, measure});
  insertCard(tx, plan, 'catalog');
  const filled = tx.commit({measurer}).doc;
  const benefit = filled.nodes[plan.ids.get('b1')!];
  assert.equal(benefit.layoutSizingHorizontal, 'FILL');
  assert.equal(benefit.text!.textAutoResize, 'HEIGHT');
  assert.equal(benefit.width, 400);
  assert.equal(filled.nodes[plan.ids.get('list')!].width, 400);
});

test('should keep a centred text centred when it changes length on one line', () => {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'card', width: 600, height: 600, pluginData: withCardMeta(undefined, {v: 1, marketplace: 'ozon'})}), 'page');
  tx.create(createNode('TEXT', {id: 'badge', parentId: 'card', x: 250, y: 20, text: {...defaultTextProps('Hit'), textAlignHorizontal: 'CENTER'}}), 'card');
  const doc = tx.commit({measurer}).doc;
  const before = doc.nodes.badge;
  const centre = before.x + before.width / 2;
  const small = parseTableText('Артикул;Плашка\n1;New season');
  const plan = planCard({doc, frameId: 'card', table: small, mapping: {sku: 0, bindings: {badge: {kind: 'column', column: 1}}}, row: 0, position: {x: 0, y: 0}, measure});
  const out = beginTransaction(doc);
  out.addPage(createNode('PAGE', {id: 'catalog', name: 'Catalog'}));
  insertCard(out, plan, 'catalog');
  const after = out.commit({measurer}).doc.nodes[plan.ids.get('badge')!];
  assert.equal(after.text!.textAutoResize, 'WIDTH_AND_HEIGHT');
  assert.ok(Math.abs(after.x + after.width / 2 - centre) < 0.01, `centre ${after.x + after.width / 2} vs ${centre}`);

  // Too long for one line: it wraps around the same centre, 6 % of the width in from the nearer edge (nothing else sets a margin).
  const long = parseTableText(`Артикул;Плашка\n1;${'Discount '.repeat(20)}`);
  const wrapped = planCard({doc, frameId: 'card', table: long, mapping: {sku: 0, bindings: {badge: {kind: 'column', column: 1}}}, row: 0, position: {x: 0, y: 0}, measure});
  const second = beginTransaction(doc);
  second.addPage(createNode('PAGE', {id: 'catalog', name: 'Catalog'}));
  insertCard(second, wrapped, 'catalog');
  const box = second.commit({measurer}).doc.nodes[wrapped.ids.get('badge')!];
  assert.equal(box.text!.textAutoResize, 'HEIGHT');
  assert.equal(box.width, 2 * (250 - 36));
  assert.ok(Math.abs(box.x + box.width / 2 - centre) < 0.01);
});

test('should give a product place without an image fill a fitted picture', () => {
  assert.deepEqual(photoFills([solid({r: 0.9, g: 0.9, b: 0.9})], 'r1'), [{type: 'IMAGE', imageRef: 'r1', scaleMode: 'FIT', opacity: 1, visible: true, blendMode: 'NORMAL'}]);
  const hidden: ImagePaint = {type: 'IMAGE', imageRef: 'old', scaleMode: 'FIT', opacity: 1, visible: false, blendMode: 'NORMAL'};
  const shown: ImagePaint = {...hidden, imageRef: 'old2', visible: true, scaleMode: 'TILE'};
  assert.deepEqual(photoFills([hidden, shown], 'new').map(paint => (paint as ImagePaint).imageRef), ['old', 'new']);
});

test('should say how many rows fit under the caps and which cap stops the rest', () => {
  const doc = template();
  const nodes = Object.keys(doc.nodes).length;
  const perCard = 8;
  const caps = {nodes: nodes + 1 + perCard * 3, bytes: 1e9, pages: 200};
  const room = catalogCapacity({doc, frameId: 'card', rows: 10, caps, docBytes: 1000});
  assert.equal(room.perCard.nodes, perCard);
  assert.deepEqual([room.fits, room.limit], [3, 'nodes']);
  assert.deepEqual(catalogCapacity({doc, frameId: 'card', rows: 2, caps, docBytes: 1000}).limit, null);
  const bytes = catalogCapacity({doc, frameId: 'card', rows: 10, caps: {nodes: 1e6, bytes: 1000 + 1024 + room.perCard.bytes * 4 + 10, pages: 200}, docBytes: 1000});
  assert.deepEqual([bytes.fits, bytes.limit], [4, 'bytes']);
  assert.deepEqual(catalogCapacity({doc, frameId: 'card', rows: 10, caps: {nodes: 1e6, bytes: 1e9, pages: 1}, docBytes: 0}).limit, 'pages');
  const full = {...doc, images: Object.fromEntries(Array.from({length: 9_998}, (_, i) => [`i${i}`, {url: `/uploads/${i}.png`, width: 1, height: 1}]))};
  assert.deepEqual(catalogCapacity({doc: full, frameId: 'card', rows: 10, caps: {nodes: 1e6, bytes: 1e9, pages: 200}, docBytes: 0, photos: true}).fits, 2);
  assert.equal(catalogBatchRows({nodes: 8, bytes: 4000}), 50);
  assert.equal(catalogBatchRows({nodes: 500, bytes: 4000}), 10);
  assert.equal(catalogBatchRows({nodes: 8, bytes: 1_000_000}), 3);
  // Cyrillic on purpose: the byte count of 1-, 2-, 3- and 4-byte UTF-8 characters.
  assert.equal(utf8Length('aЖ€😀'), 1 + 2 + 3 + 4);
});

test('should name the catalog page by the date and lay out a grid at most ten across', () => {
  const date = new Date(2026, 9, 12);
  assert.equal(catalogPageName(date, []), 'Catalog — 12.10.2026');
  assert.equal(catalogPageName(date, ['Catalog — 12.10.2026', 'Catalog — 12.10.2026 (2)']), 'Catalog — 12.10.2026 (3)');
  assert.equal(catalogGrid(5, {width: 900, height: 1200}).columns, 3);
  const big = catalogGrid(300, {width: 900, height: 1200});
  assert.equal(big.columns, 10);
  assert.deepEqual(big.position(11), {x: 900 + big.gap, y: 1200 + big.gap});
});

test('should make 300 cards of a simple template in batches of 50 transactions', () => {
  const doc = template();
  const lines = ['Артикул;Название;Цена;Преимущество 1;Преимущество 2;Фото'];
  for (let i = 0; i < 300; i++) lines.push(`SKU-${i};Product number ${i};${100 + i};Plus ${i};More ${i};https://cdn.example.ru/${i}.jpg`);
  const big = parseTableText(lines.join('\n'));
  const mapping = autoMapping(big, templateSlots(doc, 'card'));
  const capacity = catalogCapacity({doc, frameId: 'card', rows: big.rows.length, caps: {nodes: 50_000, bytes: 20 * 1024 * 1024, pages: 200}, docBytes: JSON.stringify(doc).length});
  assert.equal(capacity.fits, 300);
  const batch = catalogBatchRows(capacity.perCard);
  assert.equal(batch, 50);
  const grid = catalogGrid(300, doc.nodes.card);
  const started = performance.now();
  let current = doc;
  for (let start = 0; start < 300; start += batch) {
    const tx = beginTransaction(current);
    if (start === 0) tx.addPage(createNode('PAGE', {id: 'catalog', name: 'Catalog'}));
    for (let row = start; row < Math.min(300, start + batch); row++) {
      insertCard(tx, planCard({doc: current, frameId: 'card', table: big, mapping, row, position: grid.position(row), measure, photoFor: () => `ref-${row}`}), 'catalog');
    }
    current = tx.commit({measurer}).doc;
  }
  const elapsed = performance.now() - started;
  const cards = current.nodes.catalog.children!;
  assert.equal(cards.length, 300);
  assert.equal(Object.keys(current.nodes).length, Object.keys(doc.nodes).length + 1 + 300 * capacity.perCard.nodes);
  const last = current.nodes[cards[299]];
  assert.equal(cardMeta(last)?.sku, 'SKU-299');
  assert.ok(elapsed < 20_000, `300 cards took ${Math.round(elapsed)} ms`);
});
