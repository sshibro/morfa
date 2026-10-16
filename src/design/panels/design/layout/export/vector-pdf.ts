import type {DesignDocument, NodeId} from '../../../../../../shared/design/types';
import {pdfPagePlan, pdfPageSvg, readingOrder, recordMeasurements, textFamilies, PDF_EXPORT_LIMITS} from '../../../../../../shared/design/pdf-export';
import {PRODUCT_NAME} from '../../../../../../shared/design/product';
import {ApiError} from '../../../../../api';
import {exportDesignPdf} from '../../../../api';
import {ExportError, fontSpecsUnder} from '../../../../engine/export-raster';
import {catalogueFamilies} from '../../../../engine/fonts';
import type {EditorPersistence} from '../../../../editor/services';
import type {FontRegistry} from '../../../../engine/contracts';

// The vector PDF from the editor's side (docs/design-tool.md §Export). The server prints the stored document, so
// the editor first stores what it has (autosave flush), then runs the same export the server will run with a
// recording measurer, and sends the frames, the version and its measurements: the server lays text out with them
// and gets the editor's exact lines. The answer is the PDF.

export type VectorPdfServices = {
  fileId: string;
  fonts: FontRegistry;
  persistence?: EditorPersistence;
  /** The document as the editor holds it now (after the flush it is the stored one). */
  document(): DesignDocument;
};
export type VectorPdfPhase = 'saving' | 'printing' | 'waiting';

const FONT_WAIT_MS = 20_000;
const BUSY_RETRIES = [2_000, 4_000, 6_000];

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Export cancelled', 'AbortError'));
    }, {once: true});
  });

/** Families of the text in the layers that the server does not have (fonts from this computer). */
export function localOnlyFamilies(doc: DesignDocument, ids: readonly NodeId[]): string[] {
  const catalogue = new Set(catalogueFamilies().map(font => font.family));
  return [...textFamilies(doc, ids)].filter(family => !catalogue.has(family)).sort((a, b) => a.localeCompare(b, 'en'));
}

/** One multi-page vector PDF of the layers, pages in reading order. `onPhase` tells the caller what it waits for. */
export async function exportVectorPdf(services: VectorPdfServices, ids: readonly NodeId[], options: {title?: string; signal?: AbortSignal; onPhase?: (phase: VectorPdfPhase) => void} = {}): Promise<{blob: Blob; localFonts: string[]}> {
  const {signal, onPhase} = options;
  const measurer = services.fonts.measurer;
  if (ids.length > PDF_EXPORT_LIMITS.pages) throw new ExportError(`A single PDF holds at most ${PDF_EXPORT_LIMITS.pages} pages. Export the frames in parts.`, 'too_large');
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    onPhase?.('saving');
    try {
      await services.persistence?.flush();
    } catch (error) {
      throw new ExportError(`The PDF is built from the saved file, and saving it failed: ${error instanceof Error ? error.message.replace(/\.$/, '') : 'no connection'}. Try again once the file is saved.`, 'format');
    }
    // Right after the flush the editor's document is the stored one, at this version.
    const doc = services.document();
    const version = services.persistence?.version();
    if (!version) throw new ExportError('Could not prepare the PDF: the file has not finished opening.', 'format');
    const order = readingOrder(doc, ids);
    if (!order.length) throw new ExportError('Nothing to export: the layer was deleted.', 'empty');
    // The faces the text uses, loaded, so the measurements are the ones the canvas shows.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(order.flatMap(id => fontSpecsUnder(doc, id).map(spec => services.fonts.ensure(spec)))),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, FONT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    const recorder = recordMeasurements(measurer);
    for (const [index, id] of order.entries()) {
      // A frame at a time, the editor painting in between (a frame of 20 000 layers takes about a second).
      if (index) await new Promise(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      const plan = pdfPagePlan(doc, id);
      if (plan) pdfPageSvg(doc, plan, index, {measurer: recorder.measurer});
    }
    onPhase?.('printing');
    try {
      const answer = await exportDesignPdf(services.fileId, {version, nodeIds: order, title: options.title, measurements: recorder.table()}, signal);
      return {blob: answer.blob, localFonts: localOnlyFamilies(doc, order)};
    } catch (error) {
      if (error instanceof TypeError) throw new ExportError(`No connection to the server, and the PDF is built on the ${PRODUCT_NAME} server. Check your connection and try again.`, 'format');
      if (!(error instanceof ApiError)) throw error;
      const code = error.details?.code;
      // The server prints two PDFs at a time: wait a little and ask again.
      if (error.status === 429 && code === 'design_pdf_busy' && attempt < BUSY_RETRIES.length) {
        onPhase?.('waiting');
        await pause(BUSY_RETRIES[attempt], signal);
        continue;
      }
      // Saved meanwhile (another tab, a teammate, a change made while this one waited): once more from the start.
      if (error.status === 409 && code === 'version_conflict' && attempt === 0) continue;
      throw new ExportError(pdfErrorMessage(error), error.status === 413 ? 'too_large' : 'format');
    }
  }
}

/** The server's refusal in the words the export shows. */
export function pdfErrorMessage(error: ApiError): string {
  const code = error.details?.code;
  if (error.status === 409 && code === 'version_conflict') return 'The file was changed elsewhere. Reload the page and export again.';
  if (error.status === 404 && code === 'design_pdf_unavailable') return 'Vector PDF is turned off on this server. Reload the page: PDF will be saved as an image.';
  if (error.status === 429 && code === 'design_pdf_busy') return 'The server is building many PDFs right now. Try again in a minute.';
  if (error.status === 0 || error.status >= 500) return error.message || 'The server could not build the PDF. Try again in a minute.';
  return error.message;
}
