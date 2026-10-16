// What makes a frame a marketplace card and a layer one of its parts. Kept in the layers' `pluginData` (saved, synced and undone
// like any field; the renderer never reads it), under `morfa.mp.*` keys, so a card is an ordinary frame any tool can edit.

import type {DesignDocument, NodeId, SceneNode} from '../types';
import {isMarketplace, marketplaceSpec, type CardSlideKind, type CoverAudience, type Marketplace, CARD_SLIDE_KINDS, CARD_SLIDE_LABELS, MARKETPLACES} from './specs';

export const MP_CARD_KEY = 'morfa.mp.card';
export const MP_ROLE_KEY = 'morfa.mp.role';
export const MP_SHOW_KEY = 'morfa.mp.show';

/** On a top-level frame: this frame is a card for `marketplace`. */
export type CardMeta = {
  v: 1;
  marketplace: Marketplace;
  /** Which of the six slides it is; absent for a free-form card. */
  slide?: CardSlideKind;
  /** Frames made from one master (variants, cover sets, catalog runs) share the master's id here. */
  group?: string;
  /** WB personalized covers: which buyers this cover is for. */
  audience?: CoverAudience;
  /** The seller's article (SKU) the card is for, from a catalog run or typed in. */
  sku?: string;
  /** Variant number inside a batch, 1-based. */
  variant?: number;
  /** How the card is exported and published; absent: DEFAULT_CARD_EXPORT. */
  export?: CardExport;
};

/** The picture a card becomes: its format, quality (JPEG and WebP, 1..100) and scale over the frame's size. */
export type CardExport = {format: 'jpg' | 'png' | 'webp'; quality: number; scale: number};
export const DEFAULT_CARD_EXPORT: CardExport = {format: 'jpg', quality: 90, scale: 1};
export const cardExportOf = (meta: CardMeta): CardExport => meta.export ?? DEFAULT_CARD_EXPORT;

/** What a layer is on the card. Spec Lint reads these; generation sets them. */
export type LayerRole =
  /** The seller's real product, cut out of their photo. AI never redraws it; the layer is locked. */
  | 'product'
  /** The brand's logo. WB: refused; Ozon: only as a watermark; YM: allowed. */
  | 'logo'
  /** The store's (seller's) logo: refused by YM and WB. */
  | 'store-logo'
  /** A brand watermark (Ozon allows one off-centre, under half the area). */
  | 'watermark'
  | 'headline'
  | 'badge'
  | 'benefit'
  | 'background'
  | 'shadow'
  | 'light';

export const LAYER_ROLES: readonly LayerRole[] = ['product', 'logo', 'store-logo', 'watermark', 'headline', 'badge', 'benefit', 'background', 'shadow', 'light'];
export const LAYER_ROLE_LABELS: Readonly<Record<LayerRole, string>> = {
  product: 'Product',
  logo: 'Brand logo',
  'store-logo': 'Store logo',
  watermark: 'Watermark',
  headline: 'Headline',
  badge: 'Badge',
  benefit: 'Benefit',
  background: 'Background',
  shadow: 'Shadow',
  light: 'Light',
};

const parseJson = (raw: string | undefined): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The card's meta, or null when the frame is not a card (or its meta is from a newer version or broken). */
export function cardMeta(node: Pick<SceneNode, 'pluginData'> | undefined | null): CardMeta | null {
  const raw = parseJson(node?.pluginData?.[MP_CARD_KEY]);
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || !isMarketplace(value.marketplace)) return null;
  const meta: CardMeta = {v: 1, marketplace: value.marketplace};
  if (typeof value.slide === 'string' && (CARD_SLIDE_KINDS as readonly string[]).includes(value.slide)) meta.slide = value.slide as CardSlideKind;
  if (typeof value.group === 'string' && value.group.length <= 64) meta.group = value.group;
  if (value.audience === 'new' || value.audience === 'returning') meta.audience = value.audience;
  if (typeof value.sku === 'string' && value.sku.length <= 64) meta.sku = value.sku;
  if (typeof value.variant === 'number' && Number.isInteger(value.variant) && value.variant > 0 && value.variant < 1000) meta.variant = value.variant;
  const out = value.export as Record<string, unknown> | undefined;
  if (out && typeof out === 'object' && (out.format === 'jpg' || out.format === 'png' || out.format === 'webp')
    && typeof out.quality === 'number' && out.quality >= 1 && out.quality <= 100
    && typeof out.scale === 'number' && out.scale >= 0.25 && out.scale <= 8)
    meta.export = {format: out.format, quality: Math.round(out.quality), scale: out.scale};
  return meta;
}

/** `pluginData` with the card's meta set (or removed with `null`); the other keys kept. */
export function withCardMeta(pluginData: Record<string, string> | undefined, meta: CardMeta | null): Record<string, string> {
  const next = {...pluginData};
  if (meta) next[MP_CARD_KEY] = JSON.stringify(meta);
  else delete next[MP_CARD_KEY];
  return next;
}

/** "WB · Main photo": what a card frame is called on the page. */
export const marketplaceCardName = (marketplace: Marketplace, slide: CardSlideKind = 'main') => `${marketplaceSpec(marketplace).short} · ${CARD_SLIDE_LABELS[slide]}`;

/** The meta of a new card: the main photo of a new set. */
export const newCardMeta = (marketplace: Marketplace, group: string, slide: CardSlideKind = 'main'): CardMeta => ({v: 1, marketplace, slide, group});

export function layerRole(node: Pick<SceneNode, 'pluginData'> | undefined | null): LayerRole | null {
  const raw = node?.pluginData?.[MP_ROLE_KEY];
  return raw && (LAYER_ROLES as readonly string[]).includes(raw) ? (raw as LayerRole) : null;
}

export function withLayerRole(pluginData: Record<string, string> | undefined, role: LayerRole | null): Record<string, string> {
  const next = {...pluginData};
  if (role) next[MP_ROLE_KEY] = role;
  else delete next[MP_ROLE_KEY];
  return next;
}

/** The marketplaces a layer shows on in the card's exports. Null: every one (the default). */
export function layerShownOn(node: Pick<SceneNode, 'pluginData'> | undefined | null): Marketplace[] | null {
  const raw = node?.pluginData?.[MP_SHOW_KEY];
  if (raw === undefined) return null;
  return raw.split(',').filter(isMarketplace);
}

export function withLayerShownOn(pluginData: Record<string, string> | undefined, shown: readonly Marketplace[] | null): Record<string, string> {
  const next = {...pluginData};
  if (!shown || MARKETPLACES.every(id => shown.includes(id))) delete next[MP_SHOW_KEY];
  else next[MP_SHOW_KEY] = MARKETPLACES.filter(id => shown.includes(id)).join(',');
  return next;
}

export const isShownOn = (node: Pick<SceneNode, 'pluginData'>, marketplace: Marketplace) => {
  const shown = layerShownOn(node);
  return !shown || shown.includes(marketplace);
};

/** The card frame a layer belongs to: the nearest ancestor (or the layer itself) with card meta. */
export function cardOf(doc: Pick<DesignDocument, 'nodes'>, id: NodeId): {id: NodeId; meta: CardMeta} | null {
  let node: SceneNode | undefined = doc.nodes[id];
  for (let depth = 0; node && depth < 256; depth++) {
    const meta = cardMeta(node);
    if (meta) return {id: node.id, meta};
    node = node.parentId ? doc.nodes[node.parentId] : undefined;
  }
  return null;
}

/** Every card frame on a page, in layer order. */
export function cardsOnPage(doc: Pick<DesignDocument, 'nodes'>, pageId: NodeId): {id: NodeId; meta: CardMeta}[] {
  const out: {id: NodeId; meta: CardMeta}[] = [];
  const visit = (id: NodeId, depth: number) => {
    const node = doc.nodes[id];
    if (!node || depth > 2) return;
    const meta = cardMeta(node);
    if (meta) {
      out.push({id, meta});
      return;
    }
    // Cards may sit directly on the page or inside a section.
    if (node.type === 'PAGE' || node.type === 'SECTION') for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(pageId, 0);
  return out;
}

/** Descendants of `rootId` (itself excluded), depth first, in layer order. */
export function descendants(doc: Pick<DesignDocument, 'nodes'>, rootId: NodeId): SceneNode[] {
  const out: SceneNode[] = [];
  const stack = [...(doc.nodes[rootId]?.children ?? [])].reverse();
  while (stack.length) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    out.push(node);
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}
