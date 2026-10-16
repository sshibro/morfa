import type {CustomerAuthority} from '../../customer-authority';
import type {DesignDocument, ImageRef, NodeId, Paint} from '../../../shared/design/types';
import type {TextMeasurer} from '../../../shared/design/text-layout';
import type {Rect} from '../../../shared/design/geometry';
import {IDENTITY, unionRects, worldMatrix} from '../../../shared/design/geometry';
import {subtreeRenderBounds} from '../../../shared/design/bounds';
import {DESIGN_IMAGE_URL} from '../../../shared/design/schema';
import {
  PDF_EXPORT_LIMITS,
  effectRasters,
  pdfPagePlan,
  pdfPageSize,
  pdfPageSvg,
  rasterMegapixels,
  replayMeasurements,
  textFamilies,
  type PdfMeasurements,
  type PdfPagePlan,
} from '../../../shared/design/pdf-export';
import {EngineUnsupported} from '../../../shared/design/engine-switch';
import {exportWasm} from '../../../shared/design/export-wasm';
import {registerExportFonts} from '../../../shared/design/export-fonts';
import {exportPdfWasm} from '../../../shared/design/pdf-wasm';
import {storedDocument} from '../document-store';
import {designFail, isDesignFailure} from '../errors';
import {designRead, fileAccess} from '../file-access';
import {PDF_ORIGIN, PdfBrowserUnavailable, PdfRenderTimeout, printPdf} from './browser';
import {designPdfEngine} from './flag';
import {RenderServiceUnavailable, encodeRenderRequest, pdfJobHeader, refusalOf, renderJob} from './service';
import {fontFaceCss, readCatalogueFont, readCatalogueFontSync} from './fonts';
import {setPageSizes} from './page-boxes';
import {missingPicture, printablePicture, readablePictures, type PrintablePicture} from './pictures';

// POST /api/design-files/:id/export/pdf (docs/design-tool.md §Export): the frames of the stored document as
// one vector PDF, a page per frame in the order asked. The document is the stored one at the version the
// editor measured (409 otherwise); the editor's text measurements lay the text out exactly as its canvas
// does (shared/design/pdf-export.ts). Nothing from the request reaches the PDF but numbers.
//
// Two engines (DESIGN_PDF_ENGINE, flag.ts):
//   chromium  the SVG exporter's print flavour per page, printed by the sandboxed browser of ./browser.ts (the
//             server writes every byte of the page it prints: SVG, catalogue fonts, the caller's own pictures);
//   wasm      lane L5's crates/export writes the PDF itself (shared/design/pdf-wasm.ts): the same print flavour drawn
//             as PDF content, text in embedded subsets of the catalogue fonts, no browser. A document the Rust
//             model cannot represent falls back to chromium (logged).
//   service   the same writer, native, in lane B4's render service (./service.ts, crates/render-service): the api sends
//             the document, the pages, the measurements and the caller's own pictures; the service enforces the
//             limits (pages, raster megapixels of what it draws, its queue, the deadline) and answers the PDF.
//             A document it refuses (422) or a service that does not answer falls back to chromium (logged).

export type PdfExportInput = {version: number; nodeIds: string[]; title?: string; measurements: PdfMeasurements};
export type PdfExportResult = {pdf: Buffer; pages: number; unmeasured: number; missingFonts: string[]; engine: 'chromium' | 'wasm' | 'service'};

/** The longest a print may take, from opening the page to the last byte. */
export const PDF_RENDER_MS = 60_000;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const points = (value: number) => String(Math.round(value * 1000) / 1000);

/** The stored pictures the PDF may draw, numbered as the page refers to them (`${PDF_ORIGIN}/pictures/<n>`). */
export type PictureTable = {imageHref: (ref: ImageRef) => string | undefined; names: () => string[]; nameOf: (index: number) => string | undefined};

export function pictureTable(doc: DesignDocument): PictureTable {
  const pictures = new Map<string, number>();
  return {
    imageHref(ref) {
      const url = doc.images[ref]?.url;
      if (!url || !DESIGN_IMAGE_URL.test(url)) return undefined;
      const name = url.slice('/uploads/'.length);
      let index = pictures.get(name);
      if (index === undefined) pictures.set(name, (index = pictures.size));
      return `${PDF_ORIGIN}/pictures/${index}`;
    },
    names: () => [...pictures.keys()],
    nameOf(index) {
      for (const [name, at] of pictures) if (at === index) return name;
      return undefined;
    },
  };
}

export const pictureIndex = (href: string) => {
  const match = /^\/pictures\/(\d{1,6})$/.exec(href.startsWith(PDF_ORIGIN) ? href.slice(PDF_ORIGIN.length) : href);
  return match ? Number(match[1]) : null;
};

export type PdfPage = {plan: PdfPagePlan; bounds: Rect; size: {width: number; height: number; scale: number}};
export type PrintedPage = PdfPage & {svg: string};

const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Each page's SVG (the print flavour) for Chromium; empty pages are left out. */
export async function printedPages(doc: DesignDocument, ids: readonly NodeId[], measurer: TextMeasurer, imageHref: PictureTable['imageHref']): Promise<PrintedPage[]> {
  // Each page's SVG and text layout run on the event loop (about a second for a frame of 20 000 layers): other requests
  // get their turn between pages.
  const pages: PrintedPage[] = [];
  for (const id of ids) {
    if (pages.length) await yieldTurn();
    const plan = pdfPagePlan(doc, id);
    if (!plan) designFail(400, 'invalid_request', 'Nothing to export: layer not found. Refresh the page.');
    const {svg, bounds} = pdfPageSvg(doc, plan, pages.length, {measurer, imageHref});
    if (!(bounds.width > 0 && bounds.height > 0)) continue;
    pages.push({plan, svg, bounds, size: pdfPageSize(bounds)});
  }
  if (!pages.length) designFail(400, 'invalid_request', 'Nothing to export: the layers have no visible content.');
  return pages;
}

/** Shadows and blurs are the one thing either engine rasterizes (300 dpi): a bound on that memory and time. */
export async function checkRasters(doc: DesignDocument, pages: readonly PdfPage[], measurer: TextMeasurer): Promise<void> {
  let total = 0;
  for (const page of pages) {
    await yieldTurn();
    for (const area of effectRasters(doc, page.plan, page.bounds, measurer)) {
      const megapixels = rasterMegapixels(area, page.size.scale);
      total += megapixels;
      if (megapixels > PDF_EXPORT_LIMITS.rasterMegapixels || total > PDF_EXPORT_LIMITS.rasterMegapixelsTotal)
        designFail(413, 'design_pdf_too_large', 'Shadows and blurs cover too large an area for a PDF. Remove the shadow or blur from large layers or export fewer frames at a time.');
    }
  }
}

/** The page Chromium prints: every page's SVG on paper of its own size, the catalogue fonts it names. */
export function printHtml(doc: DesignDocument, pages: readonly PrintedPage[], title: string | undefined): {html: string; paper: {width: string; height: string}; missingFonts: string[]} {
  const families = new Set<string>();
  for (const page of pages) for (const family of textFamilies(doc, page.plan.ids)) families.add(family);
  const fonts = fontFaceCss(families, `${PDF_ORIGIN}/fonts`);
  // Chromium takes a CSS page size in whole points only and rounds it to its print grid: each page is asked a
  // little larger than the frame, the frame in its top-left corner, and page-boxes.ts cuts it to size.
  const css = pages.map((page, index) => `@page p${index}{size:${Math.ceil(page.size.width + 0.25)}pt ${Math.ceil(page.size.height + 0.25)}pt;margin:0}`).join('\n');
  const body = pages.map((page, index) => {
    const paper = `width:${Math.ceil(page.size.width + 0.25)}pt;height:${Math.ceil(page.size.height + 0.25)}pt`;
    return `<div class="p" style="page:p${index};${paper}"><div class="f" style="width:${points(page.size.width)}pt;height:${points(page.size.height)}pt">${page.svg}</div></div>`;
  }).join('');
  const heading = (title ?? '').trim().slice(0, PDF_EXPORT_LIMITS.titleLength) || 'Export';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title><style>
${fonts.css}
@page{margin:0}
${css}
html,body{margin:0;padding:0;background:transparent}
.p{position:relative;overflow:hidden;break-after:page;break-inside:avoid}
.p:last-child{break-after:auto}
.f{position:absolute;left:0;top:0;overflow:hidden}
.f>svg{display:block;width:100%;height:100%}
svg text{white-space:pre}
</style></head><body>${body}</body></html>`;
  const widest = Math.max(...pages.map(page => Math.ceil(page.size.width + 0.25)));
  const tallest = Math.max(...pages.map(page => Math.ceil(page.size.height + 0.25)));
  return {html, paper: {width: `${(widest + 1) / 72}in`, height: `${(tallest + 1) / 72}in`}, missingFonts: fonts.missing};
}

/** Prints `pages` with Chromium; pictures by their number. Page boxes are set to the frames' exact sizes. */
export async function printChromium(doc: DesignDocument, pages: readonly PrintedPage[], title: string | undefined, picture: (index: number) => Promise<PrintablePicture | null>, timeoutMs: number): Promise<{pdf: Buffer; missingFonts: string[]}> {
  const {html, paper, missingFonts} = printHtml(doc, pages, title);
  const printed = await printPdf({
    timeoutMs,
    paper,
    async serve(path) {
      if (path === '/') return {type: 'text/html; charset=utf-8', body: html};
      if (path.startsWith('/fonts/')) {
        const data = await readCatalogueFont(path.slice('/fonts/'.length));
        return data ? {type: 'font/woff2', body: data} : null;
      }
      const index = pictureIndex(path);
      if (index === null) return null;
      const printable = await picture(index);
      return printable ? {type: printable.type, body: printable.data} : null;
    },
  });
  return {pdf: setPageSizes(printed, pages.map(page => page.size)) ?? printed, missingFonts};
}

/** Image refs the layers of `ids` (and their subtrees) paint with. */
export function picturesUnder(doc: DesignDocument, ids: readonly NodeId[]): ImageRef[] {
  const refs = new Set<ImageRef>();
  const add = (paints: readonly Paint[] | undefined) => {
    for (const paint of paints ?? []) if (paint.type === 'IMAGE' && paint.imageRef) refs.add(paint.imageRef);
  };
  const stack = [...ids];
  let guard = 0;
  while (stack.length && guard++ < 1_000_000) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    add(node.fills);
    add(node.strokes);
    for (const run of node.text?.runs ?? []) add(run.fills);
    stack.push(...(node.children ?? []));
  }
  return [...refs];
}

/** The page plans and their bounds without the SVG (the wasm engine draws them itself): what each page shows. */
export function plannedPages(doc: DesignDocument, ids: readonly NodeId[], measurer: TextMeasurer): PdfPage[] {
  const pages: PdfPage[] = [];
  for (const id of ids) {
    const plan = pdfPagePlan(doc, id);
    if (!plan) designFail(400, 'invalid_request', 'Nothing to export: layer not found. Refresh the page.');
    const boxes = plan.ids.map(each => {
      const node = doc.nodes[each];
      return node ? subtreeRenderBounds(doc, node, node.type === 'PAGE' ? IDENTITY : worldMatrix(doc, each), {measurer}) : null;
    });
    const bounds = plan.crop ?? unionRects(boxes.filter((box): box is Rect => !!box));
    if (!bounds || !(bounds.width > 0 && bounds.height > 0)) continue;
    pages.push({plan, bounds, size: pdfPageSize(bounds)});
  }
  if (!pages.length) designFail(400, 'invalid_request', 'Nothing to export: the layers have no visible content.');
  return pages;
}

/** Writes the PDF in Rust: the catalogue fonts of the pages registered, every picture read first (its bytes by
 *  number). Throws EngineUnsupported for a document the Rust model refuses. */
export async function renderWasm(doc: DesignDocument, pages: readonly PdfPage[], measurer: TextMeasurer | 'fonts', table: PictureTable, picture: (index: number) => Promise<PrintablePicture | null>, title: string | undefined): Promise<{pdf: Buffer; pages: number; missingFonts: string[]}> {
  const module = exportWasm();
  const families = new Set<string>(['Inter']);
  for (const page of pages) for (const family of textFamilies(doc, page.plan.ids)) families.add(family);
  const {missing} = registerExportFonts(module, families, readCatalogueFontSync);
  for (const page of pages) for (const ref of picturesUnder(doc, page.plan.ids)) table.imageHref(ref);
  const bytes = new Map<number, Uint8Array>();
  for (let index = 0; index < table.names().length; index++) {
    const printable = await picture(index);
    if (printable) bytes.set(index, printable.data);
  }
  await yieldTurn();
  const heading = (title ?? '').trim().slice(0, PDF_EXPORT_LIMITS.titleLength) || 'Export';
  const {pdf, stats} = exportPdfWasm(doc, pages.map(page => page.plan), {
    measurer,
    imageHref: table.imageHref,
    bytes: href => {
      const index = pictureIndex(href);
      return index === null ? undefined : bytes.get(index);
    },
    title: heading,
  });
  if (!stats.pages) designFail(400, 'invalid_request', 'Nothing to export: the layers have no visible content.');
  return {pdf: Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength), pages: stats.pages, missingFonts: [...new Set([...missing, ...stats.missingFamilies])]};
}

/** The PDF from the render service: the plans, the measurements (or the service's own fonts), the caller's pictures.
 *  Null when the service cannot write this document (422) or does not answer: the caller prints with Chromium. */
export async function renderService(doc: DesignDocument, ids: readonly NodeId[], input: PdfExportInput, account: string, table: PictureTable, picture: (index: number) => Promise<PrintablePicture | null>, allowed: () => Promise<void>, timeoutMs: number): Promise<{pdf: Buffer; pages: number; missingFonts: string[]; unmeasured: number} | null> {
  const plans: PdfPagePlan[] = [];
  for (const id of ids) {
    const plan = pdfPagePlan(doc, id);
    if (!plan) designFail(400, 'invalid_request', 'Nothing to export: layer not found. Refresh the page.');
    plans.push(plan);
  }
  const families = new Set<string>();
  const drawn = new Set<string>();
  for (const plan of plans) {
    for (const family of textFamilies(doc, plan.ids)) families.add(family);
    for (const ref of picturesUnder(doc, plan.ids)) {
      table.imageHref(ref);
      drawn.add(ref);
    }
  }
  await allowed();
  // Every picture the pages draw, by the URL the exporter writes for it; one the caller may not read prints as grey.
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
  const {header, missing} = pdfJobHeader(plans, {account, title: (input.title ?? '').trim().slice(0, PDF_EXPORT_LIMITS.titleLength), measurements: input.measurements, families, pictures: refs, timeoutMs});
  let answer;
  try {
    answer = await renderJob(encodeRenderRequest(header, JSON.stringify(doc), bytes), timeoutMs);
  } catch (error) {
    if (!(error instanceof RenderServiceUnavailable)) throw error;
    console.error('[design] PDF export: the render service is unavailable, Chromium prints it:', error.message);
    return null;
  }
  if (answer.status === 200) {
    const fonts = (() => {
      try {
        return JSON.parse(answer.headers.get('x-render-missing-fonts') ?? '[]') as string[];
      } catch {
        return [];
      }
    })();
    return {pdf: answer.body, pages: Number(answer.headers.get('x-render-pages') ?? 0), missingFonts: [...new Set([...missing, ...fonts])], unmeasured: Number(answer.headers.get('x-render-unmeasured') ?? 0)};
  }
  const {code, error} = refusalOf(answer);
  if (answer.status === 413) designFail(413, 'design_pdf_too_large', error || 'Shadows and blurs cover too large an area for a PDF. Remove the shadow or blur from large layers or export fewer frames at a time.');
  if (answer.status === 429) designFail(429, 'design_pdf_busy', 'The server is building other PDFs right now. Try again in a few seconds.', {retryable: true});
  if (answer.status === 504) designFail(504, 'design_pdf_timeout', 'The PDF took too long to build. Export fewer frames at a time or simplify shadows and blurs.', {retryable: false});
  if (answer.status === 400 && code === 'invalid_request' && error.startsWith('Nothing to export')) designFail(400, 'invalid_request', error);
  console.error(`[design] PDF export: the render service answered ${answer.status} ${code}, Chromium prints it:`, error);
  return null;
}

/** The caller's own pictures among the document's, by file name (GET /uploads's rule); a picture of another account
 *  refuses the export (403 design_document_invalid, naming the ref). Shared by the PDF and raster exports. */
export async function readablePictureNames(actor: CustomerAuthority, doc: DesignDocument, table: PictureTable): Promise<Set<string>> {
  const names = table.names();
  if (!names.length) return new Set<string>();
  return designRead(actor, async tx => {
    const allowed = await readablePictures(tx, actor.ownerId, names);
    const refused = names.filter(name => !allowed.has(name));
    if (refused.length) {
      const known = await tx.many<{filename: string}>(
        'SELECT filename FROM uploads WHERE filename=ANY($1::text[]) UNION SELECT filename FROM design_images WHERE filename=ANY($1::text[])',
        [refused],
      );
      const foreign = known[0]?.filename;
      if (foreign !== undefined) {
        const ref = Object.entries(doc.images).find(([, asset]) => asset?.url === '/uploads/' + foreign)?.[0] ?? '';
        designFail(403, 'design_document_invalid', 'The image is not available to this account. Upload your own copy.', {path: `images.${ref}`, entry: {table: 'images', key: ref}});
      }
    }
    return allowed;
  });
}

/** The picture at `index` of the table, printable, when the caller may read it; the editor's grey otherwise. */
export const picturePrinter = (table: PictureTable, allowed: Set<string>) => async (index: number): Promise<PrintablePicture | null> => {
  const name = table.nameOf(index);
  if (name === undefined) return null;
  return allowed.has(name) ? printablePicture(name) : missingPicture();
};

export async function exportDesignPdf(actor: CustomerAuthority, fileId: string, input: PdfExportInput, options: {timeoutMs?: number; engine?: 'chromium' | 'wasm' | 'service'} = {}): Promise<PdfExportResult> {
  // The document at that version: the cache, or the stored text with the changes waiting after it (document-store.ts).
  const doc: DesignDocument = await designRead(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, fileId, 'view');
    if (row.version !== input.version)
      designFail(409, 'version_conflict', 'The file changed on the server. Open it again and repeat the export.', {currentVersion: row.version});
    return storedDocument(tx, row);
  });

  // Pages: each asked layer once, in the order asked.
  const ids = [...new Set(input.nodeIds)];
  const measurer = replayMeasurements(input.measurements);
  const table = pictureTable(doc);

  // Pictures: only the caller's own, as GET /uploads decides; a picture that is gone prints as the editor's grey.
  const readable = () => readablePictureNames(actor, doc, table);
  const pictureOf = (allowed: Set<string>) => picturePrinter(table, allowed);

  const engine = options.engine ?? designPdfEngine();
  let result: Omit<PdfExportResult, 'unmeasured'> | null = null;
  let unmeasured: number | null = null;
  if (engine === 'service') {
    let allowed = new Set<string>();
    const out = await renderService(doc, ids, input, actor.ownerId, table, index => pictureOf(allowed)(index), async () => void (allowed = await readable()), options.timeoutMs ?? PDF_RENDER_MS);
    if (out) {
      result = {pdf: out.pdf, pages: out.pages, missingFonts: out.missingFonts, engine: 'service'};
      unmeasured = out.unmeasured;
    }
  }
  if (engine === 'wasm') {
    try {
      const pages = plannedPages(doc, ids, measurer);
      await checkRasters(doc, pages, measurer);
      for (const page of pages) for (const ref of picturesUnder(doc, page.plan.ids)) table.imageHref(ref);
      const allowed = await readable();
      // The editor's measurements, replayed; an editor that sent none gets the module's own fonts (lane L3's shaper:
      // the widths Chrome's canvas measures), so the measurement step becomes optional with this engine.
      const measured = input.measurements.fonts.length > 0 || input.measurements.widths.length > 0;
      const out = await renderWasm(doc, pages, measured ? measurer : 'fonts', table, pictureOf(allowed), input.title);
      result = {...out, engine: 'wasm'};
    } catch (error) {
      if (!(error instanceof EngineUnsupported)) throw error;
      console.error('[design] PDF export: the wasm engine cannot write this document, Chromium prints it:', error.message);
    }
  }
  if (!result) {
    const pages = await printedPages(doc, ids, measurer, table.imageHref);
    await checkRasters(doc, pages, measurer);
    const allowed = await readable();
    try {
      const printed = await printChromium(doc, pages, input.title, pictureOf(allowed), options.timeoutMs ?? PDF_RENDER_MS);
      result = {pdf: printed.pdf, pages: pages.length, missingFonts: printed.missingFonts, engine: 'chromium'};
    } catch (error) {
      if (isDesignFailure(error)) throw error;
      if (error instanceof PdfRenderTimeout)
        designFail(504, 'design_pdf_timeout', 'The PDF took too long to build. Export fewer frames at a time or simplify shadows and blurs.', {retryable: false});
      if (!(error instanceof PdfBrowserUnavailable)) console.error('[design] PDF export failed:', error instanceof Error ? error.message : error);
      designFail(503, 'design_pdf_unavailable', 'Vector PDF is temporarily unavailable on the server. Try again in a minute or choose PNG.', {retryable: true});
    }
  }
  // The session is checked again before any byte leaves (the print took a while).
  await designRead(actor, async () => undefined);
  return {...result, unmeasured: unmeasured ?? measurer.misses};
}
