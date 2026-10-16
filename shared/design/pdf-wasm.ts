import type {DesignDocument, ImageRef} from './types';
import type {TextMeasurer} from './text-layout';
import type {PdfPagePlan} from './pdf-export';
import {exportCall, exportDocument, fixedWidthMeasurer, type ExportWasm} from './export-wasm';

// The vector PDF written directly by crates/export (lane L5, DESIGN_PDF_ENGINE=wasm on the server): the pages of
// pdf-export.ts's plans, each the SVG exporter's print flavour (`pdfPageSvg`, the very page Chromium prints today)
// drawn as PDF content — vectors, text as real glyphs in embedded subsets of the registered fonts (selectable,
// searchable), pictures as their own bytes — with only shadows and blurs rasterised (300 dpi). No Chromium.
//
// The fonts the pages use must be registered with the module first (shared/design/export-fonts.ts
// `registerExportFonts`); a family without faces is drawn in Inter and named in `stats.missingFamilies`.

/** The module's report of one PDF. */
export type PdfWasmStats = {
  pages: number;
  shapes: number;
  textSpans: number;
  images: number;
  rasters: number;
  rasterPixels: number;
  missingFamilies: string[];
  /** Each page's [width, height] in points (pdfPageSize). */
  sizes: Float64Array[];
};

interface PdfDocHandle {
  pdf(pages: string, title: string, measurer: TextMeasurer | 'fonts' | null, pictures: {href?: (ref: string) => string | undefined} | null, bytes: ((href: string) => Uint8Array | undefined) | null): {pdf: Uint8Array; stats: PdfWasmStats};
}

export type PdfWasmOptions = {
  /** The editor's measurements replayed (pdf-export.ts `replayMeasurements`), or 'fonts': the module measures with
   *  its own fonts (lane L3's shaper, the widths Chrome's canvas gives). */
  measurer: TextMeasurer | 'fonts';
  /** As pdfPageSvg's: an https: URL per stored picture, which `bytes` then answers. */
  imageHref?: (ref: ImageRef) => string | undefined;
  /** A picture's bytes (JPEG or PNG) by the URL `imageHref` gave. */
  bytes?: (href: string) => Uint8Array | undefined;
  title?: string;
};

/** The PDF of `plans` (in page order) in Rust. Throws EngineUnsupported when the document is one the model refuses. */
export function exportPdfWasm(doc: DesignDocument, plans: readonly PdfPagePlan[], options: PdfWasmOptions): {pdf: Uint8Array; stats: PdfWasmStats} {
  return exportCall('exportPdf', (module: ExportWasm) => {
    if (!module.hasFonts()) throw new Error('export-wasm: this build of the export module has no fonts (the nodejs build has; scripts/wasm-export-build.sh)');
    const handle = exportDocument(module, doc) as unknown as PdfDocHandle & {free(): void};
    try {
      const measurer = options.measurer === 'fonts' ? 'fonts' : fixedWidthMeasurer(options.measurer) ? null : options.measurer;
      const pages = JSON.stringify(plans.map(plan => ({ids: plan.ids, crop: plan.crop})));
      return handle.pdf(pages, options.title ?? '', measurer, options.imageHref ? {href: options.imageHref} : null, options.bytes ?? null);
    } finally {
      handle.free();
    }
  });
}
