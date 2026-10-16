import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, Paint, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {cardImagesInSet, cardLayers, collectCardFacts, largestType, productCoverage, textInk} from '../shared/design/marketplace/facts';
import {lintCard, type CardFacts, type LintReport} from '../shared/design/marketplace/lint';
import {cardMeta, withCardMeta, withLayerRole, withLayerShownOn, type CardMeta, type LayerRole} from '../shared/design/marketplace/meta';
import {contrastRatio, measureTextContrast, percentile, relativeLuminance, type Pixels} from '../shared/design/marketplace/contrast';
import {MARKETPLACES, type Marketplace} from '../shared/design/marketplace/specs';
import {buildMarketplaceCard} from '../shared/design/templates/marketplace';
import {templateById} from '../shared/design/templates';

// Spec Lint's facts and measurements (docs/marketplaces.md §Spec Lint): what collectCardFacts reads off a card — only what the
// marketplace's picture shows, in the frame's own space —, how the product's cover and the text contrast are measured, and
// that the starter card passes every marketplace's rules as it stands.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const solid = (hex: string, opacity = 1): Paint => ({
  type: 'SOLID', visible: true, opacity, blendMode: 'NORMAL',
  color: {r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255},
});
const image: Paint = {type: 'IMAGE', imageRef: 'photo', scaleMode: 'FILL', visible: true, opacity: 1, blendMode: 'NORMAL'};
const role = (value: LayerRole, data?: Record<string, string>) => withLayerRole(data, value);
const WB: CardMeta = {v: 1, marketplace: 'wb', slide: 'main', group: 'set'};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}
const text = (characters: string, size = 32, props: Partial<SceneNode> = {}): Partial<SceneNode> => ({
  text: {...defaultTextProps(characters), style: {...defaultTextProps().style, fontSize: size}, textAutoResize: 'NONE'}, ...props,
});

/** A WB card at (100, 50) with the layers each test reads. */
function card(extra: (add: Add) => void = () => {}): DesignDocument {
  return build(add => {
    add('FRAME', 'card', 'page', {x: 100, y: 50, width: 900, height: 1200, pluginData: withCardMeta(undefined, WB)});
    add('RECTANGLE', 'photo', 'card', {x: 130, y: 300, width: 640, height: 740, fills: [image], pluginData: role('product')});
    add('TEXT', 'title', 'card', {x: 64, y: 156, width: 700, height: 70, ...text('Product title', 60)});
    extra(add);
  });
}

test('facts: texts and layers in the frame\'s own space, only what the marketplace\'s picture shows', () => {
  const doc = card(add => {
    add('TEXT', 'mixed', 'card', {x: 64, y: 400, width: 300, height: 50, ...text('Big and small', 20)});
    add('TEXT', 'hidden', 'card', {x: 64, y: 500, width: 300, height: 50, visible: false, ...text('Hidden')});
    add('TEXT', 'ozon-only', 'card', {x: 64, y: 600, width: 300, height: 50, ...text('Ozon only'), pluginData: withLayerShownOn(undefined, ['ozon'])});
    add('RECTANGLE', 'outside', 'card', {x: 950, y: 0, width: 100, height: 100, pluginData: role('badge')});
    add('GROUP', 'group', 'card', {x: 600, y: 20, width: 200, height: 100});
    add('RECTANGLE', 'logo', 'group', {x: 0, y: 0, width: 200, height: 100, pluginData: role('logo')});
  });
  // A run in a larger, bolder size: the text's largest type is the run's.
  const mixed = doc.nodes.mixed;
  doc.nodes.mixed = {...mixed, text: {...mixed.text!, runs: [{start: 0, end: 6, style: {fontSize: 40, fontWeight: 700}}]}};
  const facts = collectCardFacts(doc, 'card', WB)!;
  assert.deepEqual(facts.frame, {id: 'card', width: 900, height: 1200});
  assert.deepEqual(facts.export, {format: 'jpg', scale: 1, quality: 90});
  assert.deepEqual(facts.texts.map(t => t.id), ['title', 'mixed'], 'hidden and Ozon-only texts are not on the WB picture');
  assert.deepEqual(facts.texts[0].box, {x: 64, y: 156, width: 700, height: 70}, 'boxes in the frame\'s space, not the page\'s');
  assert.deepEqual([facts.texts[1].fontSize, facts.texts[1].fontWeight], [40, 700]);
  assert.deepEqual(facts.layers.map(layer => [layer.id, layer.role, layer.image ?? false]), [['photo', 'product', true], ['logo', 'logo', false]], 'a layer outside the frame is cut away');
  assert.deepEqual(collectCardFacts(doc, 'card', {...WB, marketplace: 'ozon'})!.texts.map(t => t.id), ['title', 'mixed', 'ozon-only']);
  assert.equal(collectCardFacts(doc, 'photo', WB), null, 'only a frame is a card');
  // Clipped by the frame: a layer half outside counts with the half inside.
  const half = card(add => add('RECTANGLE', 'half', 'card', {x: 850, y: 0, width: 100, height: 100, pluginData: role('badge')}));
  assert.deepEqual(collectCardFacts(half, 'card', WB)!.layers.find(layer => layer.id === 'half')!.box, {x: 850, y: 0, width: 50, height: 100});
});

test('facts: the largest type scales with the layer and a text\'s ink is one solid colour or nothing', () => {
  const doc = build(add => add('TEXT', 't', 'page', text('Text', 24, {fills: [solid('#336699', 0.5)], opacity: 0.8})));
  assert.deepEqual(largestType(doc.nodes.t, 2), {fontSize: 48, fontWeight: 400});
  const ink = textInk(doc.nodes.t)!;
  assert.deepEqual(ink.colors.map(color => Math.round(color.r * 255)), [0x33]);
  assert.ok(Math.abs(ink.opacity - 0.4) < 1e-9);
  assert.equal(textInk({...doc.nodes.t, fills: [image]}), null);
  // A word in another colour: both colours count; a run in a gradient makes the colour unknown.
  const accent = textInk({...doc.nodes.t, text: {...doc.nodes.t.text!, runs: [{start: 0, end: 1, style: {}, fills: [solid('#ff0000')]}]}})!;
  assert.deepEqual(accent.colors.map(color => Math.round(color.r * 255)), [0x33, 0xff]);
  assert.equal(textInk({...doc.nodes.t, text: {...doc.nodes.t.text!, runs: [{start: 0, end: 1, style: {}, fills: [image]}]}}), null);
});

test('facts: the set\'s pictures are its slides for one marketplace and SKU; variants and covers of a slide are one', () => {
  const meta = (marketplace: Marketplace, slide?: CardMeta['slide'], extra: Partial<CardMeta> = {}) => withCardMeta(undefined, {v: 1, marketplace, group: 'set', ...(slide ? {slide} : {}), ...extra});
  const doc = build(add => {
    add('FRAME', 'main', 'page', {pluginData: meta('wb', 'main')});
    add('FRAME', 'main-2', 'page', {pluginData: meta('wb', 'main', {variant: 2})});
    add('FRAME', 'cover-returning', 'page', {pluginData: meta('wb', 'main', {audience: 'returning'})});
    add('FRAME', 'benefits', 'page', {pluginData: meta('wb', 'benefits')});
    add('FRAME', 'free', 'page', {pluginData: meta('wb')});
    add('FRAME', 'ozon', 'page', {pluginData: meta('ozon', 'specs')});
    add('FRAME', 'other-sku', 'page', {pluginData: meta('wb', 'howto', {sku: 'A-2'})});
    add('FRAME', 'alone', 'page', {pluginData: withCardMeta(undefined, {v: 1, marketplace: 'wb'})});
  });
  assert.equal(cardImagesInSet(doc, 'main', cardMeta(doc.nodes.main)!), 3, 'main, benefits and the free card');
  assert.equal(cardImagesInSet(doc, 'ozon', cardMeta(doc.nodes.ozon)!), 1);
  assert.equal(cardImagesInSet(doc, 'alone', cardMeta(doc.nodes.alone)!), 1);
});

test('product cover: boxes painted above the product, not its own children, shadows or faint layers', () => {
  const doc = card(add => {
    add('RECTANGLE', 'under', 'card', {x: 0, y: 0, width: 900, height: 1200});
    add('RECTANGLE', 'pack', 'card', {x: 130, y: 300, width: 320, height: 740});
    add('ELLIPSE', 'light', 'card', {x: 130, y: 300, width: 640, height: 740, pluginData: role('light')});
    add('RECTANGLE', 'faint', 'card', {x: 450, y: 300, width: 320, height: 740, opacity: 0.1});
  });
  // `under` is created after the product, so it is above it in paint order: move it to the bottom first.
  const tx = beginTransaction(doc);
  tx.reorder('under', 0);
  const ordered = tx.commit({measurer}).doc;
  const covered = productCoverage(ordered, 'card', 'wb');
  assert.ok(Math.abs(covered.photo - 0.5) < 0.03, `half covered by the packaging: ${covered.photo}`);
  const free = productCoverage(card(), 'card', 'wb');
  assert.equal(free.photo, 0);
  // The packaging hidden for WB covers nothing there.
  const hidden = beginTransaction(ordered);
  hidden.update('pack', {pluginData: withLayerShownOn(undefined, ['ozon'])});
  assert.equal(productCoverage(hidden.commit({measurer}).doc, 'card', 'wb').photo, 0);
  // A product made of a group: its own parts never cover it.
  const grouped = build(add => {
    add('FRAME', 'card', 'page', {width: 900, height: 1200, pluginData: withCardMeta(undefined, WB)});
    add('GROUP', 'product', 'card', {x: 100, y: 100, width: 400, height: 400, pluginData: role('product')});
    add('RECTANGLE', 'bottle', 'product', {x: 100, y: 100, width: 400, height: 400});
    add('RECTANGLE', 'label', 'product', {x: 150, y: 150, width: 300, height: 300});
  });
  assert.equal(productCoverage(grouped, 'card', 'wb').product, 0);
  assert.deepEqual(cardLayers(grouped, 'card', 'wb').map(layer => layer.node.id), ['product', 'bottle', 'label']);
});

// ── Contrast ──────────────────────────────────────────────────────────────────────────────────

/** A picture `width` × `height` filled by `paint(x, y)` → [r, g, b] (opaque). */
function pixels(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Pixels {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = paint(x, y);
    rgba.set([r, g, b, 255], (y * width + x) * 4);
  }
  return {width, height, rgba};
}
const glyph = (x: number, y: number) => x % 4 < 2 && y % 3 < 2;

test('contrast: WCAG ratios and the low percentile of what is behind the glyphs', () => {
  assert.equal(Math.round(contrastRatio({r: 0, g: 0, b: 0}, {r: 1, g: 1, b: 1}) * 10) / 10, 21);
  assert.ok(Math.abs(relativeLuminance({r: 1, g: 1, b: 1}) - 1) < 1e-9);
  assert.equal(percentile([5, 1, 4, 2, 3], 0), 1);
  assert.ok(Number.isNaN(percentile([], 0.1)));
  const white = (): [number, number, number] => [255, 255, 255];
  // Black text on white: 21:1, read off the picture and from its colour alike.
  const black = pixels(40, 20, (x, y) => (glyph(x, y) ? [0, 0, 0] : [255, 255, 255]));
  const plain = pixels(40, 20, white);
  const box = {x: 0, y: 0, width: 40, height: 20};
  assert.deepEqual(measureTextContrast(black, plain, [{id: 'read', box, colors: null}, {id: 'ink', box, colors: [{r: 0, g: 0, b: 0}]}]), {read: 21, ink: 21});
  // Grey #777 on white is 4.48:1, under WB's 4.5.
  const grey = pixels(40, 20, (x, y) => (glyph(x, y) ? [0x77, 0x77, 0x77] : [255, 255, 255]));
  const ratio = measureTextContrast(grey, plain, [{id: 't', box, colors: null}]).t;
  assert.ok(ratio > 4.4 && ratio < 4.5, String(ratio));
  // White text over a photo that is dark on the left and white on the right: the mean would pass, the low percentile fails it.
  const photo = (x: number): [number, number, number] => (x < 28 ? [20, 20, 20] : [250, 250, 250]);
  const over = pixels(40, 20, (x, y) => (glyph(x, y) ? [255, 255, 255] : photo(x)));
  const behind = pixels(40, 20, x => photo(x));
  assert.ok(measureTextContrast(over, behind, [{id: 't', box, colors: [{r: 1, g: 1, b: 1}]}]).t < 1.1);
  // Read off the picture, the glyphs lost on the white part change nothing and are not seen: known colours are safer.
  assert.ok(measureTextContrast(over, behind, [{id: 't', box, colors: null}]).t > 10);
  // Text the colour of its background changes no pixel: judged on its box, 1:1. Outside the picture: no answer.
  assert.deepEqual(measureTextContrast(plain, plain, [{id: 'lost', box, colors: null}, {id: 'off', box: {x: 50, y: 0, width: 10, height: 10}, colors: null}]), {lost: 1});
  // A half-transparent black fill is greyer than black.
  assert.ok(measureTextContrast(black, plain, [{id: 't', box, colors: [{r: 0, g: 0, b: 0}], opacity: 0.3}]).t < 3);
});

// ── Lint over the facts ──────────────────────────────────────────────────────────────────────

const statusOf = (report: LintReport, id: string) => report.checks.find(check => check.id === id)?.status;

test('lint: banned words, logos, badge zones and the contrast WB measures', () => {
  // The texts "Скидка 50 %, доставка завтра" and "Новинка сезона" are Russian on purpose: they are what WB's banned-word list and promo
  // badge zones are checked against.
  const doc = card(add => {
    add('TEXT', 'sale', 'card', {x: 64, y: 260, width: 400, height: 40, ...text('Скидка 50 %, доставка завтра')});
    add('RECTANGLE', 'logo', 'card', {x: 700, y: 1100, width: 150, height: 60, pluginData: role('logo')});
    add('TEXT', 'badge', 'card', {x: 10, y: 10, width: 300, height: 60, ...text('Новинка сезона')});
  });
  const measured = {bytes: 1_000_000, contrast: {title: 12, sale: 2.1, badge: 9}, covered: {photo: 0}};
  const wb = lintCard(collectCardFacts(doc, 'card', WB, {measured, proofing: {}})!);
  assert.equal(statusOf(wb, 'words'), 'fail');
  assert.equal(statusOf(wb, 'logo'), 'fail');
  assert.equal(statusOf(wb, 'contrast'), 'fail');
  assert.deepEqual(wb.checks.find(check => check.id === 'contrast')!.findings.map(f => f.nodeIds), [['sale']]);
  assert.equal(statusOf(wb, 'safe-zones'), 'warn', 'the badge text sits under WB\'s promo badges');
  const ozon = lintCard(collectCardFacts(doc, 'card', {...WB, marketplace: 'ozon'}, {measured})!);
  assert.ok(ozon.checks.find(check => check.id === 'words')!.findings.some(f => f.message.includes('Delivery terms')));
  assert.equal(statusOf(ozon, 'logo'), 'pass', 'Ozon takes a brand logo off-centre');
  // Hidden for WB, the logo is no longer WB's problem.
  const tx = beginTransaction(doc);
  tx.update('logo', {pluginData: withLayerShownOn(role('logo'), ['ozon', 'ym'])});
  assert.equal(statusOf(lintCard(collectCardFacts(tx.commit({measurer}).doc, 'card', WB, {measured})!), 'logo'), 'pass');
  // Not measured yet: contrast and the file wait.
  const waiting = lintCard(collectCardFacts(doc, 'card', WB)!);
  assert.equal(statusOf(waiting, 'file-size'), 'pending');
  assert.equal(statusOf(waiting, 'product'), 'pending');
});

test('lint: with no product marked, Ozon and YM point at the largest picture', () => {
  const doc = build(add => {
    add('FRAME', 'card', 'page', {width: 900, height: 1200, pluginData: withCardMeta(undefined, {v: 1, marketplace: 'ozon'})});
    add('RECTANGLE', 'small', 'card', {x: 0, y: 0, width: 100, height: 100, fills: [image]});
    add('RECTANGLE', 'big', 'card', {x: 100, y: 200, width: 700, height: 800, fills: [image]});
  });
  const report = lintCard(collectCardFacts(doc, 'card', cardMeta(doc.nodes.card)!)!);
  const product = report.checks.find(check => check.id === 'product')!;
  assert.equal(product.status, 'warn');
  assert.deepEqual(product.findings[0].nodeIds, ['big']);
});

test('the starter card passes Spec Lint on every marketplace as it stands', () => {
  let seq = 0;
  for (const marketplace of MARKETPLACES) {
    const doc = buildMarketplaceCard({measurer, newId: () => `m${seq++}`, marketplaceCard: {marketplace, set: 'single'}});
    const page = doc.nodes[doc.pages[0]];
    const frameId = page.children![0];
    const meta = cardMeta(doc.nodes[frameId])!;
    assert.equal(meta.marketplace, marketplace);
    assert.equal(meta.slide, 'main');
    assert.equal(doc.nodes[frameId].name, `${{wb: 'WB', ozon: 'Ozon', ym: 'YM'}[marketplace]} · Main photo`);
    const facts: CardFacts = collectCardFacts(doc, frameId, meta, {proofing: {}})!;
    const contrast = Object.fromEntries(facts.texts.map(t => [t.id, 6.5]));
    const product = facts.layers.find(layer => layer.role === 'product')!;
    const report = lintCard({...facts, measured: {bytes: 400_000, contrast, covered: productCoverage(doc, frameId, marketplace)}});
    assert.equal(productCoverage(doc, frameId, marketplace)[product.id], 0);
    // WB counts a card of one picture out of search: the only remark, and the one a slide set answers.
    const remarks = report.checks.filter(check => check.status !== 'pass').map(check => `${check.id}:${check.status}`);
    assert.deepEqual(remarks, marketplace === 'wb' ? ['images-count:warn'] : [], marketplace);
  }
});

test('the starter: six slides from the slide kit, or one main photo while the kit gives none', () => {
  const doc = templateById('marketplace')!.build({measurer, newId: (() => {
    let n = 0;
    return () => `k${n++}`;
  })(), marketplaceCard: {marketplace: 'ozon', set: 'kit'}});
  const frames = doc.nodes[doc.pages[0]].children!.filter(id => cardMeta(doc.nodes[id]));
  assert.ok(frames.length === 1 || frames.length === 6, `${frames.length} cards`);
  const groups = new Set(frames.map(id => cardMeta(doc.nodes[id])!.group));
  assert.equal(groups.size, 1, 'one set');
  for (const id of frames) assert.equal(cardMeta(doc.nodes[id])!.marketplace, 'ozon');
});
