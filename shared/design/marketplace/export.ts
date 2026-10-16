// One master, three exports (docs/marketplaces.md §Card Canvas): the card a seller designs once becomes a picture for each marketplace.
// `reflowForMarketplace` makes the copy of the document that marketplace's picture is painted from: layers the card hides there are
// hidden, logos and watermarks it refuses are taken out, and the frame takes its proportions, with constraints and auto layout run again.
// The rest is what the files are called and in which order a set goes. Pure: the editor paints (src/design/marketplace/export/render.ts),
// tests read it directly.

import {resizeUpdates} from '../constraints';
import {beginTransaction} from '../transaction';
import type {TextMeasurer} from '../text-layout';
import type {DesignDocument, NodeId, SceneNode} from '../types';
import {pageIdOf} from '../tree';
import {cardMeta, cardsOnPage, descendants, layerRole, layerShownOn, type CardExport, type CardMeta, type LayerRole} from './meta';
import {CARD_SLIDE_KINDS, CARD_SLIDE_LABELS, marketplaceSpec, type Marketplace, type MarketplaceSpec} from './specs';

/** The roles a marketplace refuses on the picture: WB every logo and watermark, Ozon and Yandex Market the store's logo. */
export function refusedRoles(spec: Pick<MarketplaceSpec, 'logo'>): ReadonlySet<LayerRole> {
  if (spec.logo === 'forbidden') return new Set<LayerRole>(['logo', 'store-logo', 'watermark']);
  return new Set<LayerRole>(['store-logo']);
}

/** Width:height the frame takes on a marketplace: its card frame, or one of its other frames (Ozon fresh 1:1) when the card has that. */
export function frameBoxFor(spec: Pick<MarketplaceSpec, 'frame' | 'altFrames'>, width: number, height: number): {width: number; height: number} {
  if (!(width > 0) || !(height > 0)) return {width, height};
  const ratio = width / height;
  const fits = (frame: {width: number; height: number}) => Math.abs(frame.width / frame.height - ratio) <= 0.01;
  if (fits(spec.frame) || spec.altFrames.some(fits)) return {width, height};
  // The width stays (the layout across keeps its columns); the height follows the marketplace's proportions.
  return {width, height: Math.round((width * spec.frame.height) / spec.frame.width)};
}

/** A rough measurer (half an em and a little per character) for callers without fonts; the editor passes its own. */
export const APPROXIMATE_MEASURER: TextMeasurer = {
  width: (text, font) => text.length * font.size * 0.55,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

export type MarketplaceReflow = {
  /** The document the marketplace's picture is painted from; the input is never changed. */
  doc: DesignDocument;
  /** Layers hidden because "Show on" leaves this marketplace out. */
  hidden: NodeId[];
  /** Logos and watermarks taken out because the marketplace refuses them. */
  dropped: NodeId[];
  /** The frame's size on this marketplace. */
  width: number;
  height: number;
  resized: boolean;
};

/**
 * The card `frameId` as `marketplace` gets it, as a copy of `doc`: every layer whose "Show on" leaves the marketplace out is hidden;
 * a logo, store logo or watermark the marketplace refuses is taken out unless its "Show on" names this marketplace on purpose (then
 * it stays, and Spec Lint fails the card); the frame is re-boxed to the marketplace's proportions when they differ, its layers following
 * their constraints and auto layout laid out again. When nothing applies the input document comes back as it is.
 */
export function reflowForMarketplace(doc: DesignDocument, frameId: NodeId, marketplace: Marketplace, measurer: TextMeasurer = APPROXIMATE_MEASURER): MarketplaceReflow {
  const frame = doc.nodes[frameId];
  if (!frame) throw new Error(`reflowForMarketplace: no layer ${frameId}`);
  const spec = marketplaceSpec(marketplace);
  const refused = refusedRoles(spec);
  const hidden: NodeId[] = [];
  const dropped: NodeId[] = [];
  const gone = new Set<NodeId>();
  for (const node of descendants(doc, frameId)) {
    if (gone.has(node.parentId ?? '')) {
      gone.add(node.id);
      continue;
    }
    const shown = layerShownOn(node);
    const role = layerRole(node);
    if (role && refused.has(role) && !shown?.includes(marketplace)) {
      dropped.push(node.id);
      gone.add(node.id);
    } else if (shown && !shown.includes(marketplace)) {
      if (node.visible) hidden.push(node.id);
      // Its layers go with it: nothing under a hidden layer is checked again.
      gone.add(node.id);
    }
  }
  const box = frameBoxFor(spec, frame.width, frame.height);
  const resized = box.width !== frame.width || box.height !== frame.height;
  if (!hidden.length && !dropped.length && !resized) return {doc, hidden, dropped, width: frame.width, height: frame.height, resized};

  const tx = beginTransaction(doc);
  try {
    for (const id of dropped) tx.remove(id);
    for (const id of hidden) tx.update(id, {visible: false});
    if (resized) {
      const updates = resizeUpdates(tx.doc, frameId, {x: frame.x, y: frame.y, width: box.width, height: box.height});
      for (const [id, patch] of updates) if (tx.get(id)) tx.update(id, patch);
    }
    const result = tx.commit({measurer});
    const after = result.doc.nodes[frameId];
    return {doc: result.doc, hidden, dropped, width: after?.width ?? box.width, height: after?.height ?? box.height, resized};
  } catch (error) {
    tx.abort();
    throw error;
  }
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────────

/** "WB", "Ozon", "YM": what a marketplace's file is called. */
export const marketplaceFileStem = (marketplace: Marketplace) => marketplaceSpec(marketplace).short;
export const EXPORT_EXTENSION: Readonly<Record<CardExport['format'], string>> = {jpg: 'jpg', png: 'png', webp: 'webp'};
export const EXPORT_FORMAT_LABEL: Readonly<Record<CardExport['format'], string>> = {jpg: 'JPG', png: 'PNG', webp: 'WebP'};

/** JPEG and WebP have a quality; PNG is lossless. */
export const isLossy = (format: CardExport['format']) => format !== 'png';

/** Where quality steps down to when a lossy picture is over the marketplace's file limit, when the marketplace sets no least quality. */
export const QUALITY_FLOOR = 50;
/** The qualities tried, in order, until the file fits: the setting, then 10 lower each time, never under the marketplace's least
 *  quality (WB 65 %) or QUALITY_FLOOR where it has none. A setting already under the floor is tried alone. */
export function qualitySteps(quality: number, spec: Pick<MarketplaceSpec, 'minJpegQuality'>): number[] {
  const start = Math.max(1, Math.min(100, Math.round(quality)));
  const floor = spec.minJpegQuality ?? QUALITY_FLOOR;
  const steps = [start];
  for (let next = start - 10; next > floor; next -= 10) steps.push(next);
  if (start > floor) steps.push(floor);
  return steps;
}

/** Characters zip readers and file systems refuse in a name, and control characters. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
/** One segment of a path inside the zip: unsafe characters become "_", ≤ 80 characters, never empty. */
export function safeName(text: string, fallback = 'Card'): string {
  const out = text.replace(UNSAFE, '_').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').trim().slice(0, 80).trim();
  return out || fallback;
}

/** "Sneakers/WB.jpg": one card exported for one marketplace. */
export const cardFilePath = (cardName: string, marketplace: Marketplace, format: CardExport['format']) =>
  `${safeName(cardName)}/${marketplaceFileStem(marketplace)}.${EXPORT_EXTENSION[format]}`;

/** "01 Main photo", or the frame's name for a card that is not one of the six slides. */
export const slideFileStem = (index: number, meta: Pick<CardMeta, 'slide'> | null, name: string) =>
  `${String(index + 1).padStart(2, '0')} ${safeName(meta?.slide ? CARD_SLIDE_LABELS[meta.slide] : name)}`;

/** "Sneakers/WB/01 Main photo.jpg": a frame of the set for one marketplace; one marketplace leaves out its folder. */
export function setFilePath(setName: string, marketplace: Marketplace | null, index: number, meta: Pick<CardMeta, 'slide'> | null, name: string, format: CardExport['format']): string {
  const folder = marketplace ? `${marketplaceFileStem(marketplace)}/` : '';
  return `${safeName(setName)}/${folder}${slideFileStem(index, meta, name)}.${EXPORT_EXTENSION[format]}`;
}

export type CardSetMember = {id: NodeId; meta: CardMeta; name: string};

/** The card's set: every card frame of its page with the same `group`, in the order a buyer swipes them (the six slides in their order,
 *  then the others left to right, top to bottom). A card without a group is a set of one. */
export function cardSet(doc: Pick<DesignDocument, 'nodes'>, frameId: NodeId): CardSetMember[] {
  const frame = doc.nodes[frameId];
  const meta = cardMeta(frame);
  if (!frame || !meta) return [];
  if (!meta.group) return [{id: frameId, meta, name: frame.name}];
  const pageId = pageIdOf(doc as DesignDocument, frameId);
  const members = (pageId ? cardsOnPage(doc, pageId) : [{id: frameId, meta}]).filter(card => card.meta.group === meta.group);
  const rank = (card: {meta: CardMeta}) => (card.meta.slide ? CARD_SLIDE_KINDS.indexOf(card.meta.slide) : CARD_SLIDE_KINDS.length);
  const node = (id: NodeId): SceneNode => doc.nodes[id]!;
  return members
    .sort((a, b) => rank(a) - rank(b) || node(a.id).x - node(b.id).x || node(a.id).y - node(b.id).y)
    .map(card => ({id: card.id, meta: card.meta, name: node(card.id).name}));
}

/** "1.2 MB", "840 KB". */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
