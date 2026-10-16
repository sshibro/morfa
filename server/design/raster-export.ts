import type {CustomerAuthority} from '../customer-authority';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import {textFamilies} from '../../shared/design/pdf-export';
import {storedDocument} from './document-store';
import {designFail} from './errors';
import {designRead, fileAccess} from './file-access';
import {pictureIndex, pictureTable, picturePrinter, picturesUnder, readablePictureNames} from './pdf/export';
import {RenderServiceUnavailable, encodeRenderRequest, rasterJobHeader, refusalOf, renderJob, type RasterKind} from './pdf/service';

// PNG, JPG and WebP exports and the file-card thumbnail painted on the server (docs/BACKEND.md §4): lane L4's vello_cpu
// in lane B4's render service (crates/render-service `vello::Vello`, crates/render `server::render_layers`) — the same
// painter as the canvas, text from the catalogue faces — behind DESIGN_RASTER_ENGINE=service (./pdf/flag.ts). The api
// reads the stored document at the version the editor names, checks what the caller may see (its own pictures) and
// sends the document, the pictures and the faces; the service draws with no database, network or browser. A service
// that is not there answers 503 `design_raster_unavailable`, and the editor paints the export itself, as before.

export type RasterExportFormat = 'png' | 'jpeg' | 'webp';
export type RasterExportInput = {
  version: number;
  nodeIds: readonly string[];
  format: RasterExportFormat;
  /** Device px per px (default 1); the longest side is capped at `maxSide` (the service lowers the scale to fit). */
  scale?: number;
  maxSide?: number;
  /** JPEG quality 1–100 (the service's default is 92; WebP is lossless). */
  quality?: number;
};
export type RasterExportResult = {body: Buffer; contentType: string; missingFonts: string[]; rasterPixels: number; ms: number};

export const RASTER_EXPORT_LIMITS = {
  layers: 100,
  /** The longest a job may take from its arrival (the service's own timeout applies too). */
  renderMs: 60_000,
  maxScale: 64,
  maxSide: 16_384,
} as const;

const CONTENT_TYPES: Record<RasterExportFormat, string> = {png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp'};

/** The stored document of `fileId` at `version` (409 otherwise), the layers drawn together, through the service. */
export async function exportDesignRaster(actor: CustomerAuthority, fileId: string, input: RasterExportInput, options: {timeoutMs?: number} = {}): Promise<RasterExportResult> {
  const doc: DesignDocument = await designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, fileId, 'view');
    if (row.version !== input.version)
      designFail(409, 'version_conflict', 'The file changed on the server. Open it again and repeat the export.', {currentVersion: row.version});
    return storedDocument(tx, row);
  });
  const ids = [...new Set(input.nodeIds)] as NodeId[];
  for (const id of ids) if (!doc.nodes[id]) designFail(400, 'invalid_request', 'Nothing to export: layer not found. Refresh the page.');
  return renderRaster(actor, doc, ids, {kind: input.format, account: actor.ownerId, scale: input.scale, maxSide: input.maxSide, quality: input.quality, timeoutMs: options.timeoutMs ?? RASTER_EXPORT_LIMITS.renderMs});
}

/** `ids` of `doc` drawn by the service as `kind` (a thumbnail: the service's 512 px cap); the pictures the caller may
 *  read go along, the rest paint as the editor's grey. */
export async function renderRaster(actor: CustomerAuthority, doc: DesignDocument, ids: readonly NodeId[], options: {kind: RasterKind; account: string; scale?: number; maxSide?: number; quality?: number; timeoutMs: number}): Promise<RasterExportResult> {
  const table = pictureTable(doc);
  const drawn = new Set<string>();
  for (const ref of picturesUnder(doc, ids)) {
    table.imageHref(ref);
    drawn.add(ref);
  }
  const allowed = await readablePictureNames(actor, doc, table);
  const picture = picturePrinter(table, allowed);
  const refs: {ref: string; href: string; length: number}[] = [];
  const bytes: Uint8Array[] = [];
  for (const ref of drawn) {
    const href = table.imageHref(ref);
    const index = href === undefined ? null : pictureIndex(href);
    if (href === undefined || index === null) continue;
    const printable = await picture(index);
    if (!printable) continue;
    refs.push({ref, href, length: printable.data.length});
    bytes.push(printable.data);
  }
  const {header, missing} = rasterJobHeader(ids, {kind: options.kind, account: options.account, scale: options.scale, maxSide: options.maxSide, quality: options.quality, families: textFamilies(doc, ids), pictures: refs, timeoutMs: options.timeoutMs});
  let answer;
  try {
    answer = await renderJob(encodeRenderRequest(header, JSON.stringify(doc), bytes), options.timeoutMs);
  } catch (error) {
    if (!(error instanceof RenderServiceUnavailable)) throw error;
    console.error('[design] raster export: the render service is unavailable:', error.message);
    designFail(503, 'design_raster_unavailable', 'The render server is unavailable. The export was done in the browser.', {retryable: true});
  }
  if (answer.status === 200) {
    const fonts = (() => {
      try {
        return JSON.parse(answer.headers.get('x-render-missing-fonts') ?? '[]') as string[];
      } catch {
        return [];
      }
    })();
    const contentType = answer.headers.get('content-type') ?? (options.kind === 'thumbnail' ? 'image/png' : CONTENT_TYPES[options.kind]);
    return {body: answer.body, contentType, missingFonts: [...new Set([...missing, ...fonts])], rasterPixels: Number(answer.headers.get('x-render-raster-pixels') ?? 0), ms: Number(answer.headers.get('x-render-ms') ?? 0)};
  }
  const {code, error} = refusalOf(answer);
  if (answer.status === 413) designFail(413, 'design_raster_too_large', error || 'The image is too large for one export. Reduce the scale.');
  if (answer.status === 429) designFail(429, 'design_raster_busy', 'The server is rendering other files right now. Try again in a few seconds.', {retryable: true});
  if (answer.status === 504) designFail(504, 'design_raster_timeout', 'Rendering took too long. Export fewer layers at a time or reduce the scale.');
  if (answer.status === 400 && code === 'invalid_request') designFail(400, 'invalid_request', error || 'Nothing to export.');
  console.error(`[design] raster export: the render service answered ${answer.status} ${code}:`, error);
  designFail(503, 'design_raster_unavailable', 'The render server could not render this file. The export was done in the browser.', {retryable: true});
}
