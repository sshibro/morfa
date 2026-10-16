// Slide kits (docs/marketplaces.md §Card Canvas, shared/design/marketplace/slide-kits.ts): the six slides every card needs as auto-layout
// frames of the marketplace's card size, laid out by a real commit: each carries its card meta, keeps its content out of the marketplace's
// badges, lets a longer Russian text wrap instead of overflowing, follows a brand kit's colours and fonts, and writes nothing the
// marketplaces refuse or the spelling check would flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {DEFAULT_BRAND_COLORS, type BrandKit} from '../shared/design/marketplace/brand-kit';
import {bannedWordFindings, overlapArea} from '../shared/design/marketplace/lint';
import {cardMeta, descendants, layerRole} from '../shared/design/marketplace/meta';
import {buildSlideKit, nearestWeight, SLIDE_GAP, slidePadding, type SlideKitOptions} from '../shared/design/marketplace/slide-kits';
import {CARD_SLIDE_KINDS, MARKETPLACES, marketplaceSpec, type Marketplace} from '../shared/design/marketplace/specs';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import {spellingIssues} from '../server/marketplace/canvas/spelling';
import {testMeasurer} from './helpers/design-big-files';

const options = (patch: Partial<SlideKitOptions> = {}): SlideKitOptions => ({marketplace: 'wb', slides: CARD_SLIDE_KINDS, origin: {x: 100, y: 200}, group: 'set-1', ...patch});

/** The kit created on a page in one transaction and laid out by its commit, as "Add" does. */
function placed(build: ReturnType<typeof buildSlideKit>, edit?: (doc: DesignDocument) => Record<NodeId, Partial<SceneNode>>): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  for (const node of build.nodes) tx.create(node, node.parentId ?? 'page');
  let doc = tx.commit({measurer: testMeasurer}).doc;
  if (edit) {
    const next = beginTransaction(doc);
    for (const [id, patch] of Object.entries(edit(doc))) next.update(id, patch);
    doc = next.commit({measurer: testMeasurer}).doc;
  }
  return doc;
}
const boxIn = (doc: DesignDocument, frameId: NodeId, id: NodeId) => {
  const frame = worldBox(doc, frameId)!;
  const box = worldBox(doc, id)!;
  return {x: box.x - frame.x, y: box.y - frame.y, width: box.width, height: box.height};
};

test('builds the six slides in swiping order as card frames of the marketplace\'s size, side by side, parents before children', () => {
  const build = buildSlideKit(options());
  assert.equal(build.frameIds.length, 6);
  const frames = build.frameIds.map(id => build.nodes.find(node => node.id === id)!);
  assert.deepEqual(frames.map(frame => cardMeta(frame)), CARD_SLIDE_KINDS.map(slide => ({v: 1, marketplace: 'wb', slide, group: 'set-1'})));
  assert.deepEqual(frames.map(frame => frame.name), ['Main photo', 'Benefits', 'Specs and sizes', 'How to use', 'Reviews and trust', 'In real life']);
  frames.forEach((frame, index) => {
    assert.deepEqual([frame.x, frame.y, frame.width, frame.height, frame.parentId], [100 + index * (900 + SLIDE_GAP), 200, 900, 1200, null]);
    assert.equal(frame.autoLayout?.layoutMode, 'VERTICAL');
  });
  const seen = new Set<NodeId>();
  for (const node of build.nodes) {
    if (node.parentId !== null) assert.ok(seen.has(node.parentId), `${node.name}: its parent comes first`);
    seen.add(node.id);
  }
  assert.equal(new Set(build.nodes.map(node => node.id)).size, build.nodes.length, 'ids are unique');
});

test('builds only the slides asked for, in their order', () => {
  const build = buildSlideKit(options({slides: ['lifestyle', 'specs'], marketplace: 'ozon'}));
  assert.deepEqual(build.frameIds.map(id => cardMeta(build.nodes.find(node => node.id === id))?.slide), ['specs', 'lifestyle']);
  assert.equal(buildSlideKit(options({slides: []})).nodes.length, 0);
});

test('each slide has its product photo placeholder, a headline and the parts its kind needs, with roles', () => {
  const build = buildSlideKit(options());
  const doc = placed(build);
  for (const frameId of build.frameIds) {
    const kind = cardMeta(doc.nodes[frameId])!.slide!;
    const layers = descendants(doc, frameId);
    const roles = layers.map(node => layerRole(node));
    const photo = layers.find(node => layerRole(node) === 'product')!;
    assert.ok(photo, `${kind}: a product placeholder`);
    assert.match(photo.name, /^Product photo|^Lifestyle photo/);
    assert.equal(photo.fills[0]?.type, 'SOLID');
    assert.ok(roles.includes('headline'), `${kind}: a headline`);
    const names = layers.map(node => node.name);
    if (kind === 'main') assert.equal(roles.filter(role => role === 'badge').length, 3);
    if (kind === 'benefits') assert.equal(roles.filter(role => role === 'benefit').length, 3);
    if (kind === 'benefits') assert.equal(names.filter(name => name === 'Checkmark').length, 3, 'an icon per benefit');
    if (kind === 'specs') assert.equal(names.filter(name => name === 'Row').length, 5, 'a table of auto-layout rows');
    if (kind === 'howto') assert.deepEqual(layers.filter(node => node.name === 'Digit').map(node => node.text!.characters), ['1', '2', '3']);
    if (kind === 'proof') assert.equal(layers.filter(node => node.type === 'FRAME' && node.name === 'Review').length, 2, 'two quote cards');
    if (kind === 'proof') assert.equal(layers.filter(node => node.type === 'STAR').length, 15, 'the rating\'s stars and each quote\'s');
    if (kind === 'lifestyle') {
      assert.equal(photo.layoutPositioning, 'ABSOLUTE');
      assert.deepEqual([photo.x, photo.y, photo.width, photo.height], [0, 0, 900, 1200], 'full bleed');
    }
  }
});

test('keeps every slide\'s content inside the frame and out of each marketplace\'s badge zones', () => {
  for (const marketplace of MARKETPLACES as Marketplace[]) {
    const spec = marketplaceSpec(marketplace);
    const build = buildSlideKit(options({marketplace}));
    const doc = placed(build);
    for (const frameId of build.frameIds) {
      const frame = doc.nodes[frameId];
      assert.deepEqual([frame.width, frame.height], [900, 1200], 'the frame keeps its size');
      for (const child of frame.children!) {
        const node = doc.nodes[child];
        const box = boxIn(doc, frameId, child);
        if (node.layoutPositioning === 'ABSOLUTE') continue; // the lifestyle photo fills the card behind everything
        assert.ok(box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= 900.5 && box.y + box.height <= 1200.5, `${marketplace}/${frame.name}/${node.name} stays inside: ${JSON.stringify(box)}`);
        for (const zone of spec.safeZones) {
          const area = {x: zone.x * 900, y: zone.y * 1200, width: zone.width * 900, height: zone.height * 1200};
          assert.equal(overlapArea(box, area), 0, `${marketplace}/${frame.name}/${node.name} is clear of "${zone.label}"`);
        }
      }
    }
    const padding = slidePadding(spec);
    assert.ok(padding.top >= Math.max(...spec.safeZones.filter(zone => zone.y === 0).map(zone => zone.height * 1200)));
  }
});

test('a longer text wraps and grows, the photo gives way, and nothing leaves the frame', () => {
  const build = buildSlideKit(options({slides: ['main', 'benefits']}));
  const long = 'Water-repellent city backpack with a laptop compartment and a soft back, for study, work and travel';
  const short = placed(build);
  const headline = (doc: DesignDocument, frameId: NodeId) => descendants(doc, frameId).find(node => layerRole(node) === 'headline')!;
  const photo = (doc: DesignDocument, frameId: NodeId) => descendants(doc, frameId).find(node => layerRole(node) === 'product')!;
  const doc = placed(build, current => {
    const out: Record<NodeId, Partial<SceneNode>> = {};
    for (const frameId of build.frameIds) {
      const text = headline(current, frameId);
      out[text.id] = {text: {...text.text!, characters: long}};
    }
    return out;
  });
  for (const frameId of build.frameIds) {
    const before = headline(short, frameId), after = headline(doc, frameId);
    assert.equal(after.width, before.width, 'the headline keeps the column\'s width');
    assert.ok(after.height > before.height * 2, 'and wraps onto more lines');
    assert.ok(photo(doc, frameId).height < photo(short, frameId).height, 'the photo gives it room');
    const bottom = Math.max(...doc.nodes[frameId].children!.map(id => boxIn(doc, frameId, id)).map(box => box.y + box.height));
    assert.ok(bottom <= 1200 - slidePadding(marketplaceSpec('wb')).bottom + 0.5, 'nothing reaches the bottom badges');
  }
});

test('follows a brand kit\'s colours and fonts, and falls back to a quiet palette in Inter', () => {
  const brand: BrandKit = {v: 1, name: 'Brand', colors: {...DEFAULT_BRAND_COLORS, background: '#fff8e7', primary: '#0b3d2e', accent: '#ffd23f'}, fonts: {heading: 'manrope', body: 'A font that does not exist'}, logo: null, storeLogo: null, icons: []};
  const branded = buildSlideKit(options({slides: ['main', 'benefits'], brand}));
  const frame = branded.nodes[0];
  assert.deepEqual(frame.fills[0]?.type === 'SOLID' && frame.fills[0].color, {r: 1, g: 248 / 255, b: 231 / 255});
  const texts = branded.nodes.filter(node => node.type === 'TEXT');
  const headline = texts.find(node => layerRole(node) === 'headline')!;
  assert.equal(headline.text!.style.fontFamily, 'Manrope', 'a heading font from the library, matched in any case');
  assert.equal(headline.text!.style.fontWeight, 700);
  assert.deepEqual(headline.fills[0]?.type === 'SOLID' && headline.fills[0].color, {r: 11 / 255, g: 61 / 255, b: 46 / 255});
  const badge = branded.nodes.find(node => layerRole(node) === 'badge')!;
  assert.deepEqual(badge.fills[0]?.type === 'SOLID' && badge.fills[0].color, {r: 1, g: 210 / 255, b: 63 / 255});
  const badgeText = branded.nodes.find(node => node.parentId === badge.id)!;
  assert.deepEqual(badgeText.fills[0]?.type === 'SOLID' && badgeText.fills[0].color, {r: 23 / 255, g: 23 / 255, b: 23 / 255}, 'ink on a light accent');
  assert.equal(badgeText.text!.style.fontFamily, 'Manrope', 'badges are set in the heading face');
  const line = texts.find(node => node.name === 'Description')!;
  assert.equal(line.text!.style.fontFamily, 'Inter', 'a body font Morfa does not have falls back to Inter');

  const plain = buildSlideKit(options({slides: ['main']}));
  assert.ok(plain.nodes.filter(node => node.type === 'TEXT').every(node => node.text!.style.fontFamily === 'Inter'));
  assert.equal(nearestWeight({variable: false, weights: [400, 500, 600]}, 700), 600);
  assert.equal(nearestWeight({variable: true, weights: [200, 800]}, 900), 800);
});

test('its sample texts pass the Russian spelling check and every marketplace\'s banned words', async () => {
  const build = buildSlideKit(options());
  const texts = build.nodes.filter(node => node.type === 'TEXT').map(node => ({id: node.id, name: node.name, characters: node.text!.characters, fontSize: 0, fontWeight: 400, box: {x: 0, y: 0, width: 0, height: 0}}));
  for (const marketplace of MARKETPLACES) assert.deepEqual(bannedWordFindings(marketplaceSpec(marketplace), texts), [], marketplace);
  const issues = await spellingIssues(texts.map(text => ({id: text.id, text: text.characters})));
  assert.deepEqual(Object.values(issues).flat().map(issue => issue.word), []);
});
