// "Export" of a card (docs/marketplaces.md §One master, three exports), loaded on first use: each frame of the job painted for each
// marketplace (render.ts), one after another so memory holds one picture, then one zip (fflate, pictures stored as they are) handed to the
// browser's downloads as the editor's own export does (src/design/panels/design/layout/export/run.ts).

import {zipSync, type Zippable} from 'fflate';
import {cardFilePath, cardSet, safeName, setFilePath} from '../../../../shared/design/marketplace/export';
import type {CardExport} from '../../../../shared/design/marketplace/meta';
import {MARKETPLACES, type Marketplace} from '../../../../shared/design/marketplace/specs';
import {snapshotDocument} from '../../../../shared/design/table-cache';
import type {NodeId} from '../../../../shared/design/types';
import {downloadFile} from '../../panels/design/layout/export/run';
import {renderCardExport, type CardRenderServices} from './render';

export type CardExportFile = {path: string; marketplace: Marketplace; frameId: NodeId; bytes: number; quality: number | null; oversize: boolean};
export type CardExportResult = {zipName: string; files: CardExportFile[]};

/**
 * Paints the card (`scope: 'card'`, "<card>/WB.jpg") or every frame of its set (`'set'`, "<set>/WB/01 Main photo.jpg"; one marketplace
 * leaves out its folder) for the marketplaces asked, at `settings`, zips them and starts the download. Reports progress as files done of all.
 */
export async function exportCard(
  services: CardRenderServices,
  frameId: NodeId,
  scope: 'card' | 'set',
  marketplaces: readonly Marketplace[],
  settings: CardExport,
  onProgress?: (done: number, total: number) => void,
): Promise<CardExportResult> {
  // One document for the whole export: an edit made meanwhile does not reach half of it.
  const doc = snapshotDocument(services.store.getState().doc);
  const frame = doc.nodes[frameId];
  const members = cardSet(doc, frameId);
  if (!frame || !members.length) throw new Error('The card was deleted.');
  const markets = MARKETPLACES.filter(id => marketplaces.includes(id));
  const frames = scope === 'set' ? members : members.filter(member => member.id === frameId);
  const root = scope === 'set' ? (frames[0].meta.sku ?? frame.name) : frame.name;
  const total = frames.length * markets.length;
  const files: CardExportFile[] = [];
  const entries: Zippable = {};
  onProgress?.(0, total);
  for (const market of markets)
    for (const [index, member] of frames.entries()) {
      const render = await renderCardExport(services, member.id, market, settings, doc);
      const path = scope === 'card'
        ? cardFilePath(root, market, settings.format)
        : setFilePath(root, markets.length > 1 ? market : null, index, member.meta, member.name, settings.format);
      entries[path] = [new Uint8Array(await render.blob.arrayBuffer()), {level: 0}];
      files.push({path, marketplace: market, frameId: member.id, bytes: render.blob.size, quality: render.quality, oversize: render.oversize});
      onProgress?.(files.length, total);
    }
  const zipName = `${safeName(root)}.zip`;
  downloadFile(zipName, new Blob([zipSync(entries) as BlobPart], {type: 'application/zip'}));
  return {zipName, files};
}
