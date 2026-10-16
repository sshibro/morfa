// The picture a card becomes on one marketplace (docs/marketplaces.md §One master, three exports): the frame re-flowed for that
// marketplace (layers hidden there dropped, the frame resized to its proportions: shared/design/marketplace/export.ts) and encoded with the
// card's export settings by the editor's raster exporter. A JPEG or WebP over the marketplace's file limit is encoded again at lower
// quality, never under the marketplace's least quality (WB 65%). Owned by the Card Canvas module. Used by "Export", Spec Lint (the file
// size) and publishing.

import {isLossy, qualitySteps, reflowForMarketplace, type MarketplaceReflow} from '../../../../shared/design/marketplace/export';
import type {CardExport} from '../../../../shared/design/marketplace/meta';
import {marketplaceSpec, type Marketplace} from '../../../../shared/design/marketplace/specs';
import {booleanGeometry} from '../../../../shared/design/boolean';
import {snapshotDocument} from '../../../../shared/design/table-cache';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {ExportError, exportRaster, whenExportReady, type ExportDeps, type RasterFormat} from '../../engine/export-raster';
import type {EditorServices} from '../../editor/services';

/** What painting a card needs of the editor. */
export type CardRenderServices = Pick<EditorServices, 'store' | 'fonts' | 'images'>;

export type CardRender = {
  blob: Blob;
  /** The quality the file was encoded at (lower than the setting when the file had to fit the limit); null for PNG. */
  quality: number | null;
  /** The picture's size in pixels. */
  width: number;
  height: number;
  /** The file is still over the marketplace's limit at the least quality allowed (or as a PNG). */
  oversize: boolean;
  reflow: Pick<MarketplaceReflow, 'hidden' | 'dropped' | 'resized'>;
};

const FORMAT: Record<CardExport['format'], RasterFormat> = {jpg: 'JPG', png: 'PNG', webp: 'WEBP'};
const deps = (services: CardRenderServices): ExportDeps => ({images: services.images, fonts: services.fonts, booleanGeometry});

/**
 * Paints `frameId` for `marketplace` at `settings`. `doc` is the document to paint from (a snapshot several renders share); by default the
 * store's document, taken once. Throws the raster exporter's Russian ExportError.
 */
export async function renderCardExport(services: CardRenderServices, frameId: NodeId, marketplace: Marketplace, settings: CardExport, doc?: DesignDocument): Promise<CardRender> {
  const source = doc ?? snapshotDocument(services.store.getState().doc);
  if (!source.nodes[frameId]) throw new ExportError('Nothing to export: the card was deleted.', 'empty');
  const spec = marketplaceSpec(marketplace);
  // Text re-wraps in the resized frame: its faces are measured for real, not with their fallbacks.
  await whenExportReady(source, [frameId], deps(services));
  const reflow = reflowForMarketplace(source, frameId, marketplace, services.fonts.measurer);
  const constraint = {type: 'SCALE' as const, value: settings.scale};
  const encode = (quality: number | null) => exportRaster(reflow.doc, [frameId], {format: FORMAT[settings.format], constraint, ...(quality === null ? {} : {quality: quality / 100})}, deps(services));
  const size = {width: Math.max(1, Math.round(reflow.width * settings.scale)), height: Math.max(1, Math.round(reflow.height * settings.scale))};
  const summary = {hidden: reflow.hidden, dropped: reflow.dropped, resized: reflow.resized};
  if (!isLossy(settings.format)) {
    const blob = await encode(null);
    return {blob, quality: null, ...size, oversize: blob.size > spec.maxFileBytes, reflow: summary};
  }
  let last: {blob: Blob; quality: number} | null = null;
  for (const quality of qualitySteps(settings.quality, spec)) {
    const blob = await encode(quality);
    last = {blob, quality};
    if (blob.size <= spec.maxFileBytes) break;
  }
  return {blob: last!.blob, quality: last!.quality, ...size, oversize: last!.blob.size > spec.maxFileBytes, reflow: summary};
}

/** The encoded picture of the card on one marketplace (the contract Spec Lint and publishing call). */
export async function renderCardImage(services: EditorServices, frameId: NodeId, marketplace: Marketplace, settings: CardExport): Promise<Blob> {
  return (await renderCardExport(services, frameId, marketplace, settings)).blob;
}
