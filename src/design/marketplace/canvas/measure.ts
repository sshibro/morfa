// Card Canvas: the measurements Spec Lint cannot read off the document (docs/marketplaces.md §Spec Lint) — the encoded picture's
// size, each text's contrast with what is behind it and how much of the product is covered. Run by "Check" only while it is open,
// a moment after the edits stop (use-card-lint.ts). The contrast renders the card twice at a low resolution through the export's
// own painter (engine/export-raster.ts), on a copy of just the card, so nothing it does reaches the document or the canvas.

import {booleanGeometry} from '../../../../shared/design/boolean';
import {collectCardFacts, productCoverage, textInk} from '../../../../shared/design/marketplace/facts';
import type {CardFacts} from '../../../../shared/design/marketplace/lint';
import {measureTextContrast, type ContrastTarget, type Pixels} from '../../../../shared/design/marketplace/contrast';
import {cardExportOf, type CardMeta} from '../../../../shared/design/marketplace/meta';
import type {Marketplace} from '../../../../shared/design/marketplace/specs';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import type {FontRegistry, ImageCache} from '../../engine/contracts';
import {exportRaster} from '../../engine/export-raster';
import type {EditorServices} from '../../editor/services';
import {decodePng} from '../../panels/design/layout/export/png';
import {renderCardImage} from '../export/render';
import {cardRenderDoc, opacityInCard} from './card-doc';

export type CardMeasured = NonNullable<CardFacts['measured']>;

/** The contrast pictures' width: enough for the glyphs of a 24 px caption on a 900 px card, cheap to paint and compare. */
export const CONTRAST_WIDTH = 450;
/** Fonts and pictures that have not arrived by then are painted with what is there (the export waits 20 s). */
const READY_TIMEOUT_MS = 4000;

async function pixelsOf(png: Blob): Promise<Pixels> {
  const exact = decodePng(new Uint8Array(await png.arrayBuffer()));
  if (exact) return exact;
  const bitmap = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {width: data.width, height: data.height, rgba: data.data};
}

export type MeasureDeps = {fonts: FontRegistry; images: ImageCache};

/** Text layer → its contrast ratio on the card's picture for `marketplace` (shared/design/marketplace/contrast.ts). */
export async function measureCardContrast(doc: DesignDocument, frameId: NodeId, marketplace: Marketplace, texts: CardFacts['texts'], deps: MeasureDeps): Promise<Record<NodeId, number>> {
  const frame = doc.nodes[frameId];
  const shown = texts.filter(text => text.characters.trim());
  if (!frame || !shown.length || !(frame.width > 0) || !(frame.height > 0)) return {};
  const settings = {format: 'PNG' as const, constraint: {type: 'WIDTH' as const, value: Math.min(frame.width, CONTRAST_WIDTH)}};
  const exportDeps = {fonts: deps.fonts, images: deps.images, booleanGeometry, timeoutMs: READY_TIMEOUT_MS};
  const withText = await pixelsOf(await exportRaster(cardRenderDoc(doc, frameId, marketplace, false), [frameId], settings, exportDeps));
  const withoutText = await pixelsOf(await exportRaster(cardRenderDoc(doc, frameId, marketplace, true), [frameId], settings, exportDeps));
  const sx = withText.width / frame.width, sy = withText.height / frame.height;
  const targets: ContrastTarget[] = shown.map(text => {
    const node = doc.nodes[text.id];
    const ink = node ? textInk(node, opacityInCard(doc, node, frameId)) : null;
    return {
      id: text.id,
      box: {x: text.box.x * sx, y: text.box.y * sy, width: text.box.width * sx, height: text.box.height * sy},
      colors: ink?.colors ?? null,
      opacity: ink?.opacity ?? 1,
    };
  });
  return measureTextContrast(withText, withoutText, targets);
}

/** The encoded picture's size in bytes at the card's export settings, or undefined while the export cannot make it. */
export async function measureCardBytes(services: EditorServices, frameId: NodeId, meta: CardMeta): Promise<number | undefined> {
  try {
    const blob = await renderCardImage(services, frameId, meta.marketplace, cardExportOf(meta));
    return blob instanceof Blob && blob.size > 0 ? blob.size : undefined;
  } catch {
    return undefined;
  }
}

/** Every measurement of the card on its marketplace. A measurement that fails is left out (its check stays pending). */
export async function measureCard(services: EditorServices, doc: DesignDocument, frameId: NodeId, meta: CardMeta): Promise<CardMeasured> {
  const covered = productCoverage(doc, frameId, meta.marketplace);
  const facts = collectCardFacts(doc, frameId, meta);
  const out: CardMeasured = {covered};
  if (facts) {
    try {
      out.contrast = await measureCardContrast(doc, frameId, meta.marketplace, facts.texts, services);
    } catch {
      // A card the browser cannot paint now (no memory, a picture that failed): contrast stays pending.
    }
  }
  const bytes = await measureCardBytes(services, frameId, meta);
  if (bytes !== undefined) out.bytes = bytes;
  return out;
}

/** The last measurements of each card this visit, for the layer view of a card ("Role on the card"), which never measures. */
const lastMeasured = new Map<NodeId, {marketplace: Marketplace; measured: CardMeasured}>();
export const rememberMeasured = (frameId: NodeId, marketplace: Marketplace, measured: CardMeasured) => {
  lastMeasured.delete(frameId);
  lastMeasured.set(frameId, {marketplace, measured});
  // A long session visits many cards; the oldest are let go.
  if (lastMeasured.size > 64) lastMeasured.delete(lastMeasured.keys().next().value!);
};
export const recalledMeasured = (frameId: NodeId, marketplace: Marketplace): CardMeasured | undefined => {
  const entry = lastMeasured.get(frameId);
  return entry?.marketplace === marketplace ? entry.measured : undefined;
};
