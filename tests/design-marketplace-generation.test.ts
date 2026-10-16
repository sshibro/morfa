// Catalog Generation (docs/marketplaces.md §Catalog Generation, shared/design/marketplace/generation*.ts and
// src/design/marketplace/generate/apply.ts): the plan of a variant batch, the colour check of the product, where the product may stand,
// what a brand kit changes, the copies of a card for variants and WB covers, and each editor action as one undo step on a real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, defaultTextStyle, solid} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {DEFAULT_BRAND_COLORS, newBrandKit, type BrandKit} from '../shared/design/marketplace/brand-kit';
import {
  BADGE_SHAPES,
  BADGE_TEXTS,
  badgeTexts,
  kitBackgrounds,
  mixHex,
  planVariants,
} from '../shared/design/marketplace/generation';
import {
  brandKitChanges,
  buildCardCopies,
  CUT_SOURCE_KEY,
  pictureLayers,
  productColorMatch,
  productLayers,
  productRegion,
  readableOn,
  rowOrigin,
  zoneBoxes,
} from '../shared/design/marketplace/generation-layers';
import {overlapArea} from '../shared/design/marketplace/lint';
import {cardMeta, descendants, layerRole, withCardMeta, withLayerRole, type CardMeta} from '../shared/design/marketplace/meta';
import {MARKETPLACES, marketplaceSpec, type Marketplace} from '../shared/design/marketplace/specs';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, ImagePaint, NodeId, Paint, SceneNode} from '../shared/design/types';
import {applyBrandKit, cutOutLayer, insertCopies, insertProductPhoto, placeCutOut} from '../src/design/marketplace/generate/apply';
import {createDesignStore} from '../src/design/engine/store';
import {testMeasurer} from './helpers/design-big-files';

// ── A card to work on ─────────────────────────────────────────────────────────────────────────────

const image = (ref: string, extra: Partial<ImagePaint> = {}): ImagePaint => ({type: 'IMAGE', imageRef: ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL', ...extra});
const text = (id: string, characters: string, role: Parameters<typeof withLayerRole>[1], props: Partial<SceneNode> = {}) =>
  createNode('TEXT', {id, name: characters, x: 63, y: 160, width: 600, height: 70, pluginData: withLayerRole(undefined, role),
    text: {...defaultTextProps(characters), style: {...defaultTextStyle(), fontSize: 60, fontWeight: 700}}, ...props});

type CardOptions = {marketplace?: Marketplace; meta?: Partial<CardMeta>; layers?: SceneNode[]; images?: Record<string, {width: number; height: number}>};
/** A WB card 900 × 1200 at (100, 100): a background, the seller's photo (1000 × 1000 shown in 600 × 600), a headline and a badge. */
function cardDoc(options: CardOptions = {}): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  const meta: CardMeta = {v: 1, marketplace: options.marketplace ?? 'wb', ...options.meta};
  tx.create(createNode('FRAME', {id: 'card', name: 'Cover', x: 100, y: 100, width: 900, height: 1200, fills: [solid({r: 1, g: 1, b: 1})], pluginData: withCardMeta(undefined, meta)}), 'page');
  for (const [ref, size] of Object.entries({'image-photo': {width: 1000, height: 1000}, ...options.images})) tx.setImage(ref, {url: `/uploads/${ref}.png`, ...size});
  const layers = options.layers ?? [
    createNode('RECTANGLE', {id: 'bg', name: 'Background', x: 0, y: 0, width: 900, height: 1200, fills: [solid({r: 0.9, g: 0.9, b: 0.9})], pluginData: withLayerRole(undefined, 'background')}),
    createNode('RECTANGLE', {id: 'photo', name: 'Photo', x: 150, y: 300, width: 600, height: 600, fills: [image('image-photo')]}),
    text('headline', 'Thermo mug 450 ml', 'headline'),
    createNode('FRAME', {id: 'badge', name: 'Badge', x: 63, y: 250, width: 180, height: 50, fills: [solid({r: 1, g: 0, b: 0})], pluginData: withLayerRole(undefined, 'badge')}),
    createNode('TEXT', {id: 'badge-text', parentId: 'badge', name: 'Hit', x: 10, y: 10, width: 100, height: 30, text: {...defaultTextProps('Hit'), style: {...defaultTextStyle(), fontSize: 24}}}),
  ];
  for (const layer of layers) tx.create(layer, layer.parentId && layer.parentId !== 'card' && layers.some(each => each.id === layer.parentId) ? layer.parentId : 'card');
  return tx.commit({measurer: testMeasurer}).doc;
}
const storeOf = (doc: DesignDocument) => createDesignStore({doc, measurer: testMeasurer});
const weights = () => [400, 700];
const KIT: BrandKit = {...newBrandKit('Primary'), colors: {primary: '#1d3557', secondary: '#457b9d', accent: '#e63946', background: '#f1faee', text: '#1d1d1d'}, fonts: {heading: 'Montserrat', body: 'Inter'}};
const hexOf = (paint: Paint | undefined) => (paint?.type === 'SOLID' ? '#' + [paint.color.r, paint.color.g, paint.color.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('') : null);

test('every badge text passes every marketplace\'s word rules', () => {
  for (const marketplace of MARKETPLACES) {
    assert.deepEqual(badgeTexts(marketplace), [...BADGE_TEXTS], marketplace);
  }
});

// ── The variant plan ─────────────────────────────────────────────────────────────────────────────

test('a batch plan: N variants on the kit\'s colours, each with its badge and composition', () => {
  const plans = planVariants({count: 10, colors: KIT.colors, marketplace: 'wb', products: 2});
  assert.equal(plans.length, 10);
  assert.deepEqual(plans.map(plan => plan.variant), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(plans.slice(0, 6).map(plan => plan.background), kitBackgrounds(KIT.colors));
  assert.deepEqual(plans.slice(0, 4).map(plan => plan.badge.shape), BADGE_SHAPES);
  assert.deepEqual(plans.map(plan => plan.composition.product), [0, 1, 0, 1, 0, 1, 0, 1, 0, 1], 'rotates among the product layers');
  assert.ok(plans.some(plan => plan.composition.mirror) && plans.some(plan => plan.composition.rotation !== 0) && plans.some(plan => plan.composition.scale !== 1));
  assert.deepEqual(planVariants({count: 10, colors: KIT.colors, marketplace: 'wb', products: 2}), plans, 'deterministic');
  assert.equal(planVariants({count: 1, colors: KIT.colors, marketplace: 'ozon', products: 1}).length, 2);
  assert.equal(planVariants({count: 40, colors: KIT.colors, marketplace: 'ozon', products: 1}).length, 12);
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
});

// ── The colour check ─────────────────────────────────────────────────────────────────────────────

const productCard = (product: Partial<SceneNode> = {}, above: SceneNode[] = [], wrap: Partial<SceneNode> | null = null) =>
  cardDoc({layers: [
    ...(wrap ? [createNode('GROUP', {id: 'group', name: 'Group', x: 150, y: 300, width: 600, height: 600, ...wrap})] : []),
    createNode('RECTANGLE', {id: 'product', name: 'Product', parentId: wrap ? 'group' : 'card', x: wrap ? 0 : 150, y: wrap ? 0 : 300, width: 600, height: 600, fills: [image('image-photo')], locked: true, pluginData: withLayerRole(undefined, 'product'), ...product}),
    ...above,
  ]});

test('"Product colour as in the photo": the product as shot, with only plain layers above', () => {
  const doc = productCard({}, [text('t', 'Heading over the product', 'headline', {x: 150, y: 300, width: 600, height: 600}),
    createNode('RECTANGLE', {id: 'corner', name: 'Corner', x: 700, y: 850, width: 100, height: 100, blendMode: 'MULTIPLY'})]);
  assert.deepEqual(productColorMatch(doc, 'card', 'product'), {ok: true, issues: []});
});

test('the colour check names filters, opacity and blend modes on the product, its groups and the layers above it', () => {
  const filtered = productColorMatch(productCard({fills: [image('image-photo', {filters: {saturation: 0.3}})]}), 'card', 'product');
  assert.match(filtered.issues.join(), /Filters are applied/);
  assert.match(productColorMatch(productCard({opacity: 0.8}), 'card', 'product').issues.join(), /The product layer is semi-transparent/);
  assert.match(productColorMatch(productCard({blendMode: 'MULTIPLY'}), 'card', 'product').issues.join(), /not in the Normal blend mode/);
  assert.match(productColorMatch(productCard({fills: [image('image-photo', {opacity: 0.5})]}), 'card', 'product').issues.join(), /The product photo is semi-transparent/);
  assert.match(productColorMatch(productCard({}, [], {opacity: 0.7}), 'card', 'product').issues.join(), /The group "Group" with the product is semi-transparent/);
  const blended = productCard({}, [createNode('RECTANGLE', {id: 'glow', name: 'Glare', x: 150, y: 300, width: 400, height: 400, blendMode: 'SCREEN'})]);
  assert.deepEqual(productColorMatch(blended, 'card', 'product').issues, ['The layer "Glare" above the product blends with it and changes its colour.']);
  const tinted = productCard({}, [createNode('RECTANGLE', {id: 'veil', name: 'Veil', x: 0, y: 0, width: 900, height: 1200, fills: [solid({r: 1, g: 0, b: 0}, 0.3)]})]);
  assert.deepEqual(productColorMatch(tinted, 'card', 'product').issues, ['The semi-transparent layer "Veil" above the product tints it.']);
  const small = productCard({}, [createNode('RECTANGLE', {id: 'veil', name: 'Veil', x: 150, y: 300, width: 100, height: 100, fills: [solid({r: 1, g: 0, b: 0}, 0.3)]})]);
  assert.equal(productColorMatch(small, 'card', 'product').ok, true, 'a small tint over a corner is fine');
  // Layers below it change nothing.
  const below = cardDoc({layers: [createNode('RECTANGLE', {id: 'light', name: 'Light', x: 0, y: 0, width: 900, height: 1200, blendMode: 'SOFT_LIGHT', opacity: 0.5}),
    createNode('RECTANGLE', {id: 'product', name: 'Product', x: 150, y: 300, width: 600, height: 600, fills: [image('image-photo')], pluginData: withLayerRole(undefined, 'product')})]});
  assert.equal(productColorMatch(below, 'card', 'product').ok, true);
});

// ── Where the product stands ─────────────────────────────────────────────────────────────────────

test('the product\'s region clears the marketplace\'s badge zones and the card\'s texts', () => {
  const frame = {width: 900, height: 1200};
  const region = productRegion('wb', frame);
  assert.deepEqual(region, {x: 54, y: 156, width: 792, height: 900});
  for (const zone of zoneBoxes('wb', frame)) assert.equal(overlapArea(region, zone), 0);
  const withText = productRegion('wb', frame, [{x: 63, y: 160, width: 600, height: 120}]);
  assert.equal(withText.y, 160 + 120 + 24);
  // Too little room left by the texts: the frame inside the margin.
  assert.equal(productRegion('wb', frame, [{x: 0, y: 0, width: 900, height: 500}, {x: 0, y: 700, width: 900, height: 400}]).height, 1200 - 2 * 54);
});

// ── Brand kit ────────────────────────────────────────────────────────────────────────────────────

test('a brand kit restyles the card by role: headline and badge fonts and colours, a plain background, the logo picture', () => {
  const doc = cardDoc({images: {'image-logo': {width: 200, height: 100}}, layers: [
    createNode('RECTANGLE', {id: 'bg', name: 'Background', x: 0, y: 0, width: 900, height: 1200, fills: [solid({r: 0.9, g: 0.9, b: 0.9})], pluginData: withLayerRole(undefined, 'background')}),
    text('headline', 'Thermo mug', 'headline'),
    text('benefit', 'Keeps drinks hot', 'benefit', {y: 900}),
    createNode('FRAME', {id: 'badge', name: 'Badge', x: 63, y: 250, width: 180, height: 50, fills: [solid({r: 1, g: 0, b: 0})], pluginData: withLayerRole(undefined, 'badge')}),
    createNode('TEXT', {id: 'badge-text', parentId: 'badge', name: 'Hit', x: 10, y: 10, width: 100, height: 30, text: {...defaultTextProps('Hit'), style: {...defaultTextStyle(), fontSize: 24}}}),
    createNode('RECTANGLE', {id: 'logo', name: 'Logo', x: 700, y: 1100, width: 150, height: 75, fills: [], pluginData: withLayerRole(undefined, 'logo')}),
    createNode('RECTANGLE', {id: 'plain', name: 'No role', x: 0, y: 0, width: 10, height: 10}),
  ]});
  const kit = {...KIT, logo: {url: '/uploads/kit-logo.png', width: 200, height: 100}};
  const changes = new Map(brandKitChanges(doc, 'card', kit, family => (family === 'Montserrat' ? [400, 600, 800] : [400, 700]), new Map([['/uploads/kit-logo.png', {ref: 'image-logo', asset: {url: '/uploads/image-logo.png', width: 200, height: 100}}]])).map(each => [each.id, each.change]));
  assert.deepEqual([...changes.keys()].sort(), ['badge', 'badge-text', 'benefit', 'bg', 'headline', 'logo']);
  assert.equal(changes.get('headline')!.text!.style.fontFamily, 'Montserrat');
  assert.equal(changes.get('headline')!.text!.style.fontWeight, 800, 'bold becomes the nearest weight the family has');
  assert.equal(hexOf(changes.get('headline')!.fills![0]), '#1d1d1d');
  assert.equal(changes.get('benefit')!.text!.style.fontFamily, 'Inter');
  assert.equal(hexOf(changes.get('badge')!.fills![0]), '#e63946');
  assert.equal(hexOf(changes.get('badge-text')!.fills![0]), readableOn('#e63946', KIT.colors));
  assert.equal(hexOf(changes.get('bg')!.fills![0]), '#f1faee');
  assert.deepEqual(changes.get('logo')!.fills, [image('image-logo', {scaleMode: 'FIT'})]);
  assert.equal(readableOn('#111111', DEFAULT_BRAND_COLORS), '#f4f4f6');
  assert.equal(readableOn('#ffffff', DEFAULT_BRAND_COLORS), '#141414');
  // A kit picture the file cannot hold leaves the logo as it is.
  assert.ok(!brandKitChanges(doc, 'card', kit, weights).some(change => change.id === 'logo'));
});

test('"Apply to card" is one undo step', () => {
  const store = storeOf(cardDoc());
  const before = store.getState().doc;
  assert.equal(applyBrandKit(store, 'card', KIT, weights), 4);
  assert.equal(store.getState().doc.nodes.headline.text!.style.fontFamily, 'Montserrat');
  assert.equal(hexOf(store.getState().doc.nodes.bg.fills[0]), '#f1faee');
  assert.ok(store.undo());
  assert.equal(store.getState().doc.nodes.headline.text!.style.fontFamily, before.nodes.headline.text!.style.fontFamily);
  assert.equal(hexOf(store.getState().doc.nodes.bg.fills[0]), hexOf(before.nodes.bg.fills[0]));
});

// ── Cut-outs ─────────────────────────────────────────────────────────────────────────────────────

const CUT = {ref: 'image-cut', asset: {url: '/uploads/image-cut.png', width: 400, height: 500}, box: {x: 0.3, y: 0.2, width: 0.4, height: 0.5}, source: {width: 1000, height: 1000}};

test('a cut-out stands where its pixels stood in the photo, through the photo\'s fill and the layer\'s mirror', () => {
  const doc = cardDoc();
  const layer = cutOutLayer(doc, 'photo', CUT, 'cut')!;
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [150 + 180, 300 + 120, 240, 300]);
  assert.equal(layer.name, 'Product');
  assert.equal(layer.locked, true);
  assert.equal(layerRole(layer), 'product');
  assert.equal(layer.pluginData?.[CUT_SOURCE_KEY], 'photo');
  assert.deepEqual(layer.fills, [image('image-cut')]);
  // A wide photo filling a square layer is cropped at its sides: the box maps through the crop.
  const wide = cardDoc({images: {'image-photo': {width: 2000, height: 1000}}});
  const fill = cutOutLayer(wide, 'photo', {...CUT, box: {x: 0.25, y: 0, width: 0.5, height: 1}, source: {width: 2000, height: 1000}}, 'cut')!;
  assert.deepEqual([fill.x, fill.y, fill.width, fill.height], [150, 300, 600, 600]);
  // Mirrored: the box lands on the mirrored side, and the cut-out is mirrored as the photo was.
  const mirrored = cardDoc({layers: [createNode('RECTANGLE', {id: 'photo', name: 'Photo', x: 150, y: 300, width: 600, height: 600, flipX: true, fills: [image('image-photo')]})]});
  const flipped = cutOutLayer(mirrored, 'photo', {...CUT, box: {x: 0, y: 0, width: 0.5, height: 0.5}}, 'cut')!;
  assert.deepEqual([flipped.x, flipped.y, flipped.flipX], [450, 300, true]);
  const box = worldBox(mirrored, 'photo');
  assert.equal(box.x + box.width, 100 + 450 + 300, 'the right half of the mirrored layer');
  assert.equal(cutOutLayer(doc, 'headline', CUT), null, 'a text has no photo');
});

test('placing a cut-out is one undo step; cutting the same photo again replaces it', () => {
  const store = storeOf(cardDoc());
  store.setSelection(['card']);
  const first = placeCutOut(store, 'photo', CUT)!;
  let doc = store.getState().doc;
  assert.equal(doc.nodes.photo.visible, false, 'the photo is hidden under its cut-out');
  assert.deepEqual(doc.nodes.card.children!.slice(0, 3), ['bg', 'photo', first], 'just above the photo');
  assert.deepEqual(doc.images['image-cut'], CUT.asset);
  assert.deepEqual(store.getState().selection, ['card'], 'the card stays selected, so "Generation" stays open');
  const second = placeCutOut(store, 'photo', {...CUT, ref: 'image-cut2', asset: {...CUT.asset, url: '/uploads/image-cut2.png'}})!;
  doc = store.getState().doc;
  assert.equal(doc.nodes[first], undefined, 'the earlier cut-out of this photo is gone');
  assert.deepEqual(productLayers(doc, 'card').map(node => node.id), [second]);
  // Cutting the cut-out itself replaces it too.
  const third = placeCutOut(store, second, {...CUT, ref: 'image-cut3', asset: {...CUT.asset, url: '/uploads/image-cut3.png'}})!;
  doc = store.getState().doc;
  assert.deepEqual(productLayers(doc, 'card').map(node => node.id), [third]);
  assert.equal(doc.nodes[third].pluginData?.[CUT_SOURCE_KEY], 'photo', 'still from the seller\'s photo');
  store.undo();
  store.undo();
  store.undo();
  doc = store.getState().doc;
  assert.equal(doc.nodes.photo.visible, true);
  assert.equal(productLayers(doc, 'card').length, 0);
});

test('an uploaded product photo goes into the card where a product stands', () => {
  const store = storeOf(cardDoc({layers: []}));
  const id = insertProductPhoto(store, 'card', {ref: 'image-new', asset: {url: '/uploads/image-new.png', width: 1000, height: 2000, name: 'mug.png'}})!;
  const node = store.getState().doc.nodes[id];
  assert.equal(node.parentId, 'card');
  assert.equal(node.name, 'mug.png');
  assert.deepEqual([node.height, node.y + node.height], [900, 156 + 900]);
  assert.deepEqual(pictureLayers(store.getState().doc, 'card').map(layer => layer.id), [id]);
});

// ── Copies: variants and WB covers ───────────────────────────────────────────────────────────────

test('variant copies: a row of card frames to the right, each its own meta, background, badge and product placement', () => {
  const doc = cardDoc({layers: [
    createNode('RECTANGLE', {id: 'bg', name: 'Background', x: 0, y: 0, width: 900, height: 1200, pluginData: withLayerRole(undefined, 'background')}),
    createNode('ELLIPSE', {id: 'shadow', name: 'Product shadow', x: 200, y: 860, width: 500, height: 40, pluginData: withLayerRole(undefined, 'shadow')}),
    createNode('RECTANGLE', {id: 'product', name: 'Product', x: 150, y: 300, width: 600, height: 600, fills: [image('image-photo')], locked: true, pluginData: withLayerRole(undefined, 'product')}),
    createNode('RECTANGLE', {id: 'product2', name: 'Product 2', x: 150, y: 300, width: 300, height: 300, visible: false, fills: [image('image-photo')], locked: true, pluginData: withLayerRole(undefined, 'product')}),
    text('headline', 'Thermo mug', 'headline'),
  ]});
  const meta = cardMeta(doc.nodes.card)!;
  let n = 0;
  const built = buildCardCopies({
    doc, cardId: 'card', origin: rowOrigin(doc, 'card', 2, 80), gap: 80, kit: KIT, weightsOf: weights, makeId: () => `n${++n}`,
    copies: [
      {meta: {...meta, group: 'card', variant: 1}, name: 'Cover · variant 1', background: {kind: 'solid', color: '#ffffff'}, badge: {shape: 'pill', text: 'New'},
        composition: {scale: 1, dx: 0, dy: 0, rotation: 0, mirror: true, product: 0}},
      {meta: {...meta, group: 'card', variant: 2}, name: 'Cover · variant 2', background: {kind: 'linear', from: '#ffffff', to: '#000000'}, badge: {shape: 'tag', text: 'Eco'},
        composition: {scale: 1.1, dx: 0.05, dy: 0, rotation: 3, mirror: false, product: 1}},
    ],
  });
  assert.equal(built.frameIds.length, 2);
  const tx = beginTransaction(doc);
  for (const node of built.nodes) tx.create(node, node.parentId ?? 'page');
  const after = tx.commit({measurer: testMeasurer}).doc;
  const [one, two] = built.frameIds.map(id => after.nodes[id]);
  assert.deepEqual([one.x, one.y, two.x, two.y], [100 + 900 + 80, 100, 100 + 2 * 900 + 2 * 80, 100]);
  assert.deepEqual(cardMeta(one), {v: 1, marketplace: 'wb', group: 'card', variant: 1});
  assert.equal(one.name, 'Cover · variant 1');
  const layersOf = (id: NodeId) => descendants(after, id);
  const role = (id: NodeId, wanted: string) => layersOf(id).filter(node => layerRole(node) === wanted);
  assert.deepEqual(role(one.id, 'background')[0].fills, [solid({r: 1, g: 1, b: 1})]);
  assert.equal(role(two.id, 'background')[0].fills[0].type, 'GRADIENT_LINEAR');
  assert.equal(role(one.id, 'headline')[0].text!.characters, 'Thermo mug', 'the copy keeps the master\'s headline');
  assert.equal(role(two.id, 'headline')[0].text!.style.fontSize, 60, 'with its style');
  // A card without a badge gets one, in the kit's accent, with the badge's words.
  const badge = role(one.id, 'badge')[0];
  assert.equal(hexOf(badge.fills[0]), '#e63946');
  assert.equal(descendants(after, badge.id)[0].text!.characters, 'New');
  // Product: the first variant mirrored in place; the second shows the other product layer, turned and moved, the first hidden.
  const products = (id: NodeId) => role(id, 'product');
  const [p1a, p1b] = products(one.id);
  assert.deepEqual([p1a.visible, p1a.flipX, p1a.x, p1a.width, p1a.locked, p1b.visible], [true, true, 150, 600, true, false]);
  const [p2a, p2b] = products(two.id);
  assert.deepEqual([p2a.visible, p2b.visible, p2b.rotation, p2b.width], [false, true, 3, 660]);
  // The shadow follows the product: centred under it, moved right by 5 % of the card.
  const shadow = role(two.id, 'shadow')[0];
  assert.ok(Math.abs(shadow.x + shadow.width / 2 - (450 + 45)) <= 1);
  // Every node's parent comes before it; the master is untouched.
  const seen = new Set<NodeId>(['page']);
  for (const node of built.nodes) {
    assert.ok(seen.has(node.parentId ?? 'page'), node.name);
    seen.add(node.id);
  }
  assert.deepEqual(after.nodes.card, doc.nodes.card);
});

test('copies land in one undo step, beside anything already right of the card, and the master joins their set', () => {
  const doc = cardDoc();
  const tx = beginTransaction(doc);
  tx.create(createNode('FRAME', {id: 'other', name: 'Other', x: 1100, y: 100, width: 300, height: 300}), 'page');
  const store = storeOf(tx.commit({measurer: testMeasurer}).doc);
  const meta = cardMeta(store.getState().doc.nodes.card)!;
  const copies = [1, 2, 3].map(variant => ({meta: {...meta, group: 'card', variant}, name: `Cover · variant ${variant}`, background: null, badge: null, composition: null}));
  store.setSelection(['card']);
  const made = insertCopies(store, 'card', copies, KIT, weights, 'Cover variants · 3');
  const after = store.getState().doc;
  assert.equal(made.length, 3);
  assert.equal(after.nodes[made[0]].x, 1100 + 300 + 80, 'past the frame standing there');
  assert.deepEqual(cardMeta(after.nodes.card), {...meta, group: 'card'});
  assert.deepEqual(store.getState().selection, ['card'], 'the selection stays; "Show" selects the copies');
  store.undo();
  assert.equal(made.some(id => store.getState().doc.nodes[id]), false);
  assert.deepEqual(cardMeta(store.getState().doc.nodes.card), meta);
});

test('the WB cover pair is two copies named for their audience', () => {
  const store = storeOf(cardDoc());
  const meta = cardMeta(store.getState().doc.nodes.card)!;
  const made = insertCopies(store, 'card', [
    {meta: {...meta, group: 'card', audience: 'new'}, name: 'For new buyers', background: null, badge: null, composition: null},
    {meta: {...meta, group: 'card', audience: 'returning'}, name: 'For returning buyers', background: null, badge: {shape: 'pill', text: 'New'}, composition: null},
  ], KIT, weights, 'Pair of WB covers');
  const doc = store.getState().doc;
  assert.deepEqual(made.map(id => [doc.nodes[id].name, cardMeta(doc.nodes[id])?.audience]), [['For new buyers', 'new'], ['For returning buyers', 'returning']]);
  assert.equal(descendants(doc, made[1]).find(node => node.type === 'TEXT' && node.parentId !== made[1])!.text!.characters, 'New', 'the badge says so');
  assert.equal(marketplaceSpec('wb').short, 'WB');
});
