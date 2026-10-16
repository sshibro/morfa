import type {DesignDocument, NodeId} from '../types';
import {buildSlideKit} from '../marketplace/slide-kits';
import {CARD_SLIDE_KINDS, CARD_SLIDE_LABELS, marketplaceSpec, type CardSlideKind, type Marketplace} from '../marketplace/specs';
import {marketplaceCardName, newCardMeta, withCardMeta, withLayerRole} from '../marketplace/meta';
import {TemplateBuilder, type BuildOptions} from './kit';

// "Marketplace card" (docs/marketplaces.md §Frames and the new card): a file that opens on a product card for Wildberries,
// Ozon or Yandex Market — one main photo at the marketplace's 900 × 1200, or the six slides of a slide kit
// (shared/design/marketplace/slide-kits.ts). The main photo is laid out to pass Spec Lint as it stands: the headline and the
// product keep out of the badge zones, the product fills two thirds of the frame (Yandex Market's rule) and the grey text keeps
// 4.5:1 on white (WB's).

const SANS = 'Inter';

// The frame's name and meta live with the card markers (the frame presets use them without the builders).
export {marketplaceCardName, newCardMeta};

/** The main photo: the headline, one line of the main benefit and a place for the product photo. Returns the frame's id. */
export function buildMainCard(b: TemplateBuilder, pageId: NodeId, marketplace: Marketplace, group: string, at = {x: 0, y: 0}): NodeId {
  const {width, height} = marketplaceSpec(marketplace).frame;
  const card = b.frame(pageId, {name: marketplaceCardName(marketplace), x: at.x, y: at.y, w: width, h: height, fill: '#FFFFFF', clip: true});
  b.update(card, {pluginData: withCardMeta(undefined, newCardMeta(marketplace, group))});
  const k = width / 900;
  const s = (value: number) => Math.round(value * k);
  const headline = b.text(card, 'Product name', {family: SANS, weight: 700, size: s(60), line: s(68), tracking: -2}, {name: 'Heading', x: s(64), y: s(156), w: s(772), color: '#141414'});
  b.update(headline, {pluginData: withLayerRole(undefined, 'headline')});
  const benefit = b.text(card, 'Main benefit in one line', {family: SANS, weight: 500, size: s(30), line: s(40)}, {name: 'Benefit', x: s(64), y: s(236), w: s(772), color: '#5B5B66'});
  b.update(benefit, {pluginData: withLayerRole(undefined, 'benefit')});
  const shadow = b.ellipse(card, {name: 'Shadow', x: s(210), y: s(1028), w: s(480), h: s(40), fill: {hex: '#141414', opacity: 0.08}});
  b.update(shadow, {pluginData: withLayerRole(undefined, 'shadow')});
  // The product: a placeholder the seller swaps for their photo. 640 of 900 wide is 71 % of the frame, past Yandex Market's two thirds.
  const product = b.rect(card, {name: 'Product — replace with your photo', x: s(130), y: s(300), w: s(640), h: s(740), radius: s(32), fill: '#F1F1F4'});
  b.update(product, {pluginData: withLayerRole(undefined, 'product')});
  return card;
}

/** "Marketplace card": one main photo, or the six slides of a slide kit (one main photo when the kit gives none). */
export function buildMarketplaceCard(options: BuildOptions): DesignDocument {
  const {marketplace, set} = options.marketplaceCard ?? {marketplace: 'wb' as const, set: 'single' as const};
  const b = new TemplateBuilder(options);
  const page = b.page('Cards', '#EDEDF0');
  const group = b.id();
  const kit = set === 'kit' ? safeKit(marketplace, group) : null;
  if (kit?.nodes.length) {
    for (const node of kit.nodes) b.insertNode(node, node.parentId ?? page);
  } else {
    buildMainCard(b, page, marketplace, group);
  }
  return b.finish();
}

/** The slide kit's nodes, or none when it cannot build them (the kit module is not there yet, or failed). */
function safeKit(marketplace: Marketplace, group: string) {
  try {
    return buildSlideKit({marketplace, slides: CARD_SLIDE_KINDS, origin: {x: 0, y: 0}, group, brand: null});
  } catch {
    return null;
  }
}
