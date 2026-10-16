// One master, three exports (docs/marketplaces.md §Card Canvas): the copy of a card each marketplace's picture is painted from
// (shared/design/marketplace/export.ts `reflowForMarketplace`), the qualities a picture over the file limit steps down through, and what the
// files of a card and of its set are called. The painting itself (src/design/marketplace/export/render.ts) runs in the browser:
// tests/e2e/design-marketplace-export.spec.ts exports through it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../shared/design/defaults';
import {
  cardFilePath,
  cardSet,
  formatFileSize,
  frameBoxFor,
  qualitySteps,
  reflowForMarketplace,
  refusedRoles,
  safeName,
  setFilePath,
  slideFileStem,
} from '../shared/design/marketplace/export';
import {withCardMeta, withLayerRole, withLayerShownOn, type CardMeta, type LayerRole} from '../shared/design/marketplace/meta';
import {marketplaceSpec, type Marketplace} from '../shared/design/marketplace/specs';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../shared/design/types';
import {testMeasurer} from './helpers/design-big-files';

type Extra = Partial<SceneNode> & {id: NodeId; parentId: NodeId; role?: LayerRole; shown?: Marketplace[]};

function documentWith(build: (add: (type: NodeType, props: Extra) => void) => void): DesignDocument {
  let doc = createDocument('page');
  build((type, {role, shown, ...props}) => {
    const node = createNode(type, props);
    if (role) node.pluginData = withLayerRole(node.pluginData, role);
    if (shown) node.pluginData = withLayerShownOn(node.pluginData, shown);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  });
  return doc;
}
const cardData = (meta: Omit<CardMeta, 'v'>) => withCardMeta(undefined, {v: 1, ...meta});

function master(size = {width: 900, height: 1200}): DesignDocument {
  return documentWith(add => {
    add('FRAME', {id: 'card', parentId: 'page', name: 'Sneakers', x: 100, y: 50, ...size, pluginData: cardData({marketplace: 'wb'})});
    add('RECTANGLE', {id: 'bg', parentId: 'card', width: size.width, height: size.height, constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}, role: 'background'});
    add('RECTANGLE', {id: 'logo', parentId: 'card', x: 20, y: 20, width: 120, height: 60, role: 'logo'});
    add('RECTANGLE', {id: 'store', parentId: 'card', x: 760, y: 20, width: 120, height: 60, role: 'store-logo'});
    add('RECTANGLE', {id: 'mark', parentId: 'card', x: 760, y: 1100, width: 100, height: 60, role: 'watermark', shown: ['ozon']});
    add('RECTANGLE', {id: 'wbLogo', parentId: 'card', x: 20, y: 1100, width: 100, height: 60, role: 'logo', shown: ['wb', 'ym']});
    add('TEXT', {id: 'ymOnly', parentId: 'card', x: 40, y: 600, text: defaultTextProps('Yandex Market only'), shown: ['ym']});
    add('FRAME', {id: 'promo', parentId: 'card', x: 40, y: 700, width: 300, height: 100, shown: ['ozon', 'ym']});
    add('RECTANGLE', {id: 'promoInner', parentId: 'promo', width: 50, height: 50, role: 'store-logo'});
    add('RECTANGLE', {id: 'foot', parentId: 'card', x: 0, y: size.height - 100, width: size.width, height: 100, constraints: {horizontal: 'STRETCH', vertical: 'MAX'}});
  });
}

test('refuses every logo on WB and the store\'s logo on Ozon and Yandex Market', () => {
  assert.deepEqual([...refusedRoles(marketplaceSpec('wb'))].sort(), ['logo', 'store-logo', 'watermark']);
  assert.deepEqual([...refusedRoles(marketplaceSpec('ozon'))], ['store-logo']);
  assert.deepEqual([...refusedRoles(marketplaceSpec('ym'))], ['store-logo']);
});

test('reflows a copy per marketplace: hidden layers hidden, refused logos dropped unless listed on purpose, the input untouched', () => {
  const doc = master();
  const before = JSON.stringify(doc.nodes);
  const wb = reflowForMarketplace(doc, 'card', 'wb', testMeasurer);
  assert.deepEqual(wb.dropped.sort(), ['logo', 'mark', 'store']);
  assert.deepEqual(wb.hidden.sort(), ['promo', 'ymOnly']);
  assert.ok(!wb.doc.nodes.logo && !wb.doc.nodes.store && !wb.doc.nodes.mark, 'refused logos are gone from WB\'s copy');
  assert.ok(wb.doc.nodes.wbLogo, 'a logo whose "Show on" names WB stays (Spec Lint then fails the card)');
  assert.equal(wb.doc.nodes.ymOnly.visible, false);
  assert.equal(wb.doc.nodes.promo.visible, false);
  assert.ok(wb.doc.nodes.promoInner, 'a layer inside a hidden one stays as it is');
  assert.equal(JSON.stringify(doc.nodes), before, 'the editor\'s document is never changed');

  const ozon = reflowForMarketplace(doc, 'card', 'ozon', testMeasurer);
  assert.deepEqual(ozon.dropped.sort(), ['promoInner', 'store']);
  assert.deepEqual(ozon.hidden.sort(), ['wbLogo', 'ymOnly']);
  assert.ok(ozon.doc.nodes.logo && ozon.doc.nodes.mark, 'Ozon keeps the brand logo and its watermark');

  const ym = reflowForMarketplace(doc, 'card', 'ym', testMeasurer);
  assert.deepEqual(ym.dropped.sort(), ['promoInner', 'store']);
  assert.deepEqual(ym.hidden, ['mark']);
  assert.equal(ym.doc.nodes.ymOnly.visible, true);
  assert.equal(ym.resized, false);
});

test('a card with nothing to change comes back as it is', () => {
  const doc = documentWith(add => {
    add('FRAME', {id: 'card', parentId: 'page', width: 900, height: 1200, pluginData: cardData({marketplace: 'wb'})});
    add('RECTANGLE', {id: 'photo', parentId: 'card', width: 600, height: 600, role: 'product'});
  });
  const out = reflowForMarketplace(doc, 'card', 'ozon', testMeasurer);
  assert.equal(out.doc, doc);
  assert.deepEqual([out.width, out.height, out.resized], [900, 1200, false]);
});

test('re-boxes a square card to 3:4 for WB and YM, its layers following their constraints; Ozon keeps the square (Ozon fresh)', () => {
  const doc = master({width: 1200, height: 1200});
  const wb = reflowForMarketplace(doc, 'card', 'wb', testMeasurer);
  assert.deepEqual([wb.width, wb.height, wb.resized], [1200, 1600, true]);
  assert.deepEqual([wb.doc.nodes.card.x, wb.doc.nodes.card.y], [100, 50], 'the frame keeps its place');
  assert.deepEqual([wb.doc.nodes.bg.width, wb.doc.nodes.bg.height], [1200, 1600], 'a stretched background grows with the frame');
  assert.equal(wb.doc.nodes.foot.y, 1500, 'a layer pinned to the bottom stays at the bottom');
  assert.equal(wb.doc.nodes.wbLogo.y, 1100, 'a layer pinned to the top stays');
  const ozon = reflowForMarketplace(doc, 'card', 'ozon', testMeasurer);
  assert.equal(ozon.resized, false);
  assert.deepEqual(frameBoxFor(marketplaceSpec('ym'), 1600, 900), {width: 1600, height: 2133});
  assert.deepEqual(frameBoxFor(marketplaceSpec('wb'), 900, 1200), {width: 900, height: 1200});
});

test('runs auto layout again in the re-boxed frame: a filling child takes the new height', () => {
  const doc = documentWith(add => {
    add('FRAME', {
      id: 'card', parentId: 'page', width: 900, height: 900, pluginData: cardData({marketplace: 'ozon'}),
      autoLayout: {...defaultAutoLayout('VERTICAL'), paddingTop: 100, paddingBottom: 100, itemSpacing: 20},
    });
    add('TEXT', {id: 'title', parentId: 'card', width: 900, height: 40, text: {...defaultTextProps('Heading'), textAutoResize: 'HEIGHT'}, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG'});
    add('RECTANGLE', {id: 'photo', parentId: 'card', width: 900, height: 660, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL', fills: [solid({r: 0.9, g: 0.9, b: 0.9})], role: 'product'});
  });
  const wb = reflowForMarketplace(doc, 'card', 'wb', testMeasurer);
  assert.equal(wb.doc.nodes.card.height, 1200);
  const title = wb.doc.nodes.title;
  assert.equal(wb.doc.nodes.photo.y, 100 + title.height + 20);
  assert.equal(wb.doc.nodes.photo.height, 1200 - 200 - title.height - 20, 'the photo fills what the text leaves');
});

test('steps a lossy picture\'s quality down by 10, never under the marketplace\'s least (WB 65 %) or 50 where it sets none', () => {
  assert.deepEqual(qualitySteps(90, marketplaceSpec('wb')), [90, 80, 70, 65]);
  assert.deepEqual(qualitySteps(100, marketplaceSpec('ozon')), [100, 90, 80, 70, 60, 50]);
  assert.deepEqual(qualitySteps(65, marketplaceSpec('wb')), [65]);
  assert.deepEqual(qualitySteps(40, marketplaceSpec('ym')), [40], 'a setting under the floor is tried as it is');
  assert.deepEqual(qualitySteps(72.4, marketplaceSpec('wb')), [72, 65]);
});

test('names a card\'s files by marketplace and a set\'s by slide, in the order a buyer swipes them', () => {
  assert.equal(cardFilePath('Sneakers', 'wb', 'jpg'), 'Sneakers/WB.jpg');
  assert.equal(cardFilePath('Sneakers', 'ym', 'webp'), 'Sneakers/YM.webp');
  assert.equal(cardFilePath('a/b: c?', 'ozon', 'png'), 'a_b_ c_/Ozon.png');
  assert.equal(safeName('   '), 'Card');
  assert.equal(slideFileStem(0, {slide: 'main'}, 'Frame'), '01 Main photo');
  assert.equal(slideFileStem(11, null, 'Cover/for new'), '12 Cover_for new');
  assert.equal(setFilePath('Set', 'ozon', 2, {slide: 'specs'}, 'x', 'jpg'), 'Set/Ozon/03 Specs and sizes.jpg');
  assert.equal(setFilePath('Set', null, 0, {slide: 'main'}, 'x', 'png'), 'Set/01 Main photo.png');

  const doc = documentWith(add => {
    add('FRAME', {id: 'howto', parentId: 'page', name: 'Instructions', x: 2000, pluginData: cardData({marketplace: 'wb', slide: 'howto', group: 'g'})});
    add('FRAME', {id: 'free', parentId: 'page', name: 'Free', x: 0, pluginData: cardData({marketplace: 'wb', group: 'g'})});
    add('FRAME', {id: 'main', parentId: 'page', name: 'Main', x: 3000, pluginData: cardData({marketplace: 'wb', slide: 'main', group: 'g'})});
    add('FRAME', {id: 'other', parentId: 'page', name: 'Another set', x: 500, pluginData: cardData({marketplace: 'wb', slide: 'benefits', group: 'h'})});
    add('FRAME', {id: 'plain', parentId: 'page', name: 'Not a card', x: 600});
    add('SECTION', {id: 'section', parentId: 'page', x: 5000});
    add('FRAME', {id: 'benefits', parentId: 'section', name: 'Benefits', x: 0, pluginData: cardData({marketplace: 'wb', slide: 'benefits', group: 'g'})});
  });
  assert.deepEqual(cardSet(doc, 'free').map(member => member.id), ['main', 'benefits', 'howto', 'free']);
  assert.deepEqual(cardSet(doc, 'other').map(member => member.id), ['other']);
  assert.deepEqual(cardSet(doc, 'plain'), []);
});

test('says file sizes the way the marketplaces do', () => {
  assert.equal(formatFileSize(1_258_291), '1.2 MB');
  assert.equal(formatFileSize(860_160), '840 KB');
  assert.equal(formatFileSize(200), '1 KB');
});
