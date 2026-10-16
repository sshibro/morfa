import {zipSync, type Zippable} from 'fflate';
import type {DesignDocument, ImageRef, NodeId} from '../../../../../../shared/design/types';
import {exportSvg} from '../../../../../../shared/design/svg-export';
import {pdfPagePlan} from '../../../../../../shared/design/pdf-export';
import {booleanGeometry} from '../../../../../../shared/design/boolean';
import {worldBox} from '../../../../../../shared/design/geometry';
import {snapshotDocument} from '../../../../../../shared/design/table-cache';
import {ExportError, exportBounds, exportPixelSize, exportRaster, whenExportReady, type ExportDeps, type RasterExportSettings} from '../../../../engine/export-raster';
import type {FontRegistry, ImageCache} from '../../../../engine/contracts';
import {imageRefsUnder, isAllowedImageUrl} from '../../../../engine/images';
import {FORMAT_MIME, groupPdfJobs, zipName, type ExportJob, type PdfKind} from './files';
import {writePdf, type PdfImage} from './pdf';
import {decodePng} from './png';
import {exportVectorPdf, type VectorPdfPhase} from './vector-pdf';
import {rasterPainter} from './raster-mode';
import {exportDesignRaster} from '../../../../api';
import {ApiError} from '../../../../../api';
import type {EditorPersistence} from '../../../../editor/services';
import type {DesignStore} from '../../../../engine/store';

// Runs export jobs in the browser (the panel and the export dialog load this module on demand):
// PNG, JPG and WEBP through the raster exporter, SVG through `exportSvg` with every picture fetched
// and embedded as a data URL, PDF as the vector PDF the server prints (vector-pdf.ts: the PDF settings
// of one export go into one multi-page file), or where the server's vector PDF is off, the raster
// picture inside a PDF page (pdf.ts). One file is handed over as is; several go into a zip (fflate),
// stored without recompressing pictures.

export type ExportServices = {
  images: ImageCache;
  fonts: FontRegistry;
  /** For the vector PDF: the file, its autosave and the store (the editor's services carry all three). */
  fileId?: string;
  persistence?: EditorPersistence;
  store?: DesignStore;
};
export type ExportedFile = {path: string; blob: Blob};
export type ExportOptions = {
  /** What PDF settings write (pdf-mode.ts). */
  pdf?: PdfKind;
  /** The name several layers' PDF pages are saved under (the zip's name). */
  base?: string;
  /** The vector PDF's phases, for a progress line. */
  onPdfPhase?: (phase: VectorPdfPhase) => void;
  /** Fonts the vector PDF could not embed (from this computer only). */
  onLocalFonts?: (families: string[]) => void;
};

const deps = (services: ExportServices): ExportDeps => ({images: services.images, fonts: services.fonts, booleanGeometry});

/** Every picture under the node as a data URL, fetched with the session cookie from its own /uploads URL. */
async function pictureData(doc: DesignDocument, id: NodeId): Promise<Map<ImageRef, string>> {
  const out = new Map<ImageRef, string>();
  await Promise.all([...imageRefsUnder(doc, id)].map(async ref => {
    const url = doc.images[ref]?.url;
    if (!url || !isAllowedImageUrl(url)) return;
    try {
      const response = await fetch(url, {credentials: 'same-origin'});
      if (!response.ok) return;
      out.set(ref, await blobToDataUrl(await response.blob()));
    } catch {
      // A picture that cannot be read exports as the neutral grey exportSvg draws for it.
    }
  }));
  return out;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Pixels of an exported PNG: decoded exactly, or through a canvas for anything unusual. */
async function pixelsOf(png: Blob): Promise<PdfImage> {
  const exact = decodePng(new Uint8Array(await png.arrayBuffer()));
  if (exact) return exact;
  const bitmap = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExportError('Could not save the PDF: the browser ran out of memory.', 'too_large');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {width: data.width, height: data.height, rgba: data.data};
}


/** The layer painted by the render service (raster-mode.ts: `designRaster` on, the file saved at a known version), or
 *  null when the editor should paint it itself: the service is off or not there, the file is not saved yet, or the
 *  server refused for a reason a local export would not share (a size cap the editor also enforces is reported). */
async function rasterOnServer(doc: DesignDocument, id: NodeId, settings: {format: 'PNG' | 'JPG' | 'WEBP'; constraint: RasterExportSettings['constraint']}, services: ExportServices): Promise<Blob | null> {
  if (!services.fileId || !services.persistence) return null;
  // A slice exports what its page draws under it (exportRegion): the editor's own path.
  if (doc.nodes[id]?.type === 'SLICE') return null;
  if ((await rasterPainter()) !== 'service') return null;
  const bounds = exportBounds(doc, [id], services.fonts);
  if (!bounds) return null;
  const {scale} = exportPixelSize(bounds, settings.constraint);
  try {
    await services.persistence.flush();
  } catch {
    return null;
  }
  const version = services.persistence.version();
  if (!version) return null;
  // JPEG quality: the service's default 92 is the browser export's 0.92.
  const format = settings.format === 'PNG' ? 'png' : settings.format === 'JPG' ? 'jpeg' : 'webp';
  try {
    const answer = await exportDesignRaster(services.fileId, {version, nodeIds: [id], format, scale});
    return answer.blob;
  } catch (error) {
    // The service is not there (404, 503), the file moved on (409) or the server is busy: the editor paints.
    const status = error instanceof ApiError ? error.status : 0;
    if (status === 413) throw new ExportError('The image is too large for one export. Reduce the scale.', 'too_large');
    return null;
  }
}

/** One file of one layer. */
export async function renderJob(doc: DesignDocument, job: ExportJob, services: ExportServices): Promise<Blob> {
  const node = doc.nodes[job.nodeId];
  if (!node) throw new ExportError('Nothing to export: the layer was deleted.', 'empty');
  const {format, constraint} = job.setting;
  if (format === 'PNG' || format === 'JPG' || format === 'WEBP') {
    const served = await rasterOnServer(doc, node.id, {format, constraint}, services);
    return served ?? exportRaster(doc, [node.id], {format, constraint}, deps(services));
  }
  if (format === 'SVG') {
    // A slice is what its page draws inside it, cropped to the slice (as its PDF page is).
    const plan = node.type === 'SLICE' ? pdfPagePlan(doc, node.id) : {id: node.id, ids: [node.id]};
    if (!plan) throw new ExportError('Nothing to export: the slice has no size.', 'empty');
    await whenExportReady(doc, plan.ids, deps(services));
    const pictures = new Map<ImageRef, string>();
    for (const id of plan.ids) for (const [ref, data] of await pictureData(doc, id)) pictures.set(ref, data);
    const svg = exportSvg(doc, plan.ids, {measurer: services.fonts.measurer, imageData: ref => pictures.get(ref), crop: plan.crop, layerIds: !!job.setting.svgIdAttribute});
    return new Blob([svg], {type: FORMAT_MIME.SVG});
  }
  // PDF: the layer painted losslessly at the chosen scale, on a page of the layer's own size.
  const png = await exportRaster(doc, [node.id], {format: 'PNG', constraint}, deps(services));
  const bounds = node.type === 'SLICE' ? worldBox(doc, node.id) : exportBounds(doc, [node.id], services.fonts);
  if (!bounds) throw new ExportError('Nothing to export: the layer has no visible content.', 'empty');
  const image = await pixelsOf(png);
  const bytes = await writePdf([{width: bounds.width, height: bounds.height, image}], {title: node.name});
  return new Blob([bytes as BlobPart], {type: FORMAT_MIME.PDF});
}

/** Runs the jobs one after another (memory stays at one picture), reporting progress as jobs done of all. */
export async function runExport(input: DesignDocument, jobs: readonly ExportJob[], services: ExportServices, onProgress?: (done: number, total: number) => void, signal?: AbortSignal, options: ExportOptions = {}): Promise<ExportedFile[]> {
  // The document of the whole export, taken once: the jobs span awaits (fonts, pictures, encoding), and the store's
  // table may be written in place meanwhile — an edit that lands during the export does not reach it.
  const doc = snapshotDocument(input);
  const vector = (options.pdf ?? 'vector') === 'vector' && !!services.fileId && jobs.some(job => job.setting.format === 'PDF');
  const {pdf, other} = vector ? groupPdfJobs(jobs, options.base ?? 'Export') : {pdf: [], other: jobs};
  const files: ExportedFile[] = [];
  let done = 0;
  onProgress?.(0, jobs.length);
  for (const job of other) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    files.push({path: job.path, blob: await renderJob(doc, job, services)});
    onProgress?.(++done, jobs.length);
  }
  for (const group of pdf) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const ids = group.jobs.map(job => job.nodeId);
    const single = ids.length === 1 ? doc.nodes[ids[0]]?.name : undefined;
    const {blob, localFonts} = await exportVectorPdf(
      // The vector PDF is built from the stored file, so it reads the editor's document right after autosave's flush — its
      // own copy of it, taken at that moment.
      {fileId: services.fileId!, fonts: services.fonts, persistence: services.persistence, document: () => (services.store ? snapshotDocument(services.store.getState().doc) : doc)},
      ids,
      {title: single || options.base || 'Export', signal, onPhase: options.onPdfPhase},
    );
    if (localFonts.length) options.onLocalFonts?.(localFonts);
    files.push({path: group.path, blob});
    done += jobs.filter(job => job.setting.format === 'PDF' && job.setting.suffix === group.suffix).length;
    onProgress?.(done, jobs.length);
  }
  return files;
}

const STORED = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);

/** Several files → one zip; one file stays itself. */
export async function packFiles(files: readonly ExportedFile[], zipBase: string): Promise<{name: string; blob: Blob}> {
  if (files.length === 1) return {name: files[0].path.split('/').pop() || files[0].path, blob: files[0].blob};
  const entries: Zippable = {};
  for (const file of files) {
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    entries[file.path] = [bytes, {level: STORED.has(file.blob.type) ? 0 : 6}];
  }
  const zipped = zipSync(entries);
  return {name: zipName(zipBase), blob: new Blob([zipped as BlobPart], {type: 'application/zip'})};
}

/** Hands a file to the browser's downloads. */
export function downloadFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A small picture of a layer for previews: PNG at most `maxWidth` × `maxHeight` CSS px (× dpr). */
export async function renderPreview(doc: DesignDocument, id: NodeId, services: ExportServices, maxWidth: number, maxHeight: number, dpr = 1): Promise<Blob | null> {
  const node = doc.nodes[id];
  if (!node) return null;
  const bounds = node.type === 'SLICE' ? worldBox(doc, id) : exportBounds(doc, [id], services.fonts);
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const scale = Math.min(maxWidth / bounds.width, maxHeight / bounds.height, 4) * dpr;
  return exportRaster(doc, [id], {format: 'PNG', constraint: {type: 'SCALE', value: scale}}, {...deps(services), timeoutMs: 8000});
}

/** The note for text set in fonts only this computer has: the server could not embed them. */
export function localFontsNote(families: readonly string[]): string {
  const list = families.slice(0, 3).map(family => `"${family}"`).join(', ') + (families.length > 3 ? ` and ${families.length - 3} more` : '');
  return `${families.length === 1 ? 'Font' : 'Fonts'} ${list} ${families.length === 1 ? 'is' : 'are'} only on this computer: in the PDF this text is set in a fallback font.`;
}

/** A message for a failed export, in Russian. */
export function exportErrorMessage(error: unknown): string {
  if (error instanceof ExportError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return 'Export cancelled.';
  return 'Could not export. Try again or choose another format.';
}
