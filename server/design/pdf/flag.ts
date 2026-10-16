import {designToolAvailable} from '../flag';
import {renderServiceUrl} from './service';

// The vector PDF's switches (docs/design-tool.md §Export). It needs the server's Chromium headless shell, which
// the production image installs for the site importer, so it is on wherever the design tool is: set
// ENABLE_DESIGN_PDF_EXPORT=0 where that browser cannot run. Off, POST /:id/export/pdf answers 404
// `design_pdf_unavailable` and /api/config says `designPdf: false`; the editor then saves "PDF (raster)".

type Account = {id: string; email?: string | null};

export const designPdfExportEnabled = () => process.env.ENABLE_DESIGN_PDF_EXPORT !== '0';

/** Who prints the vector PDF (docs/BACKEND.md §4, §5): `chromium` (this server's Chromium, any value but `0` and `rust`) or `rust`
 *  (lane B4's render service, POST /internal/render, no Chromium). The render service is not built yet: with `rust` the route
 *  answers 503 `design_pdf_unavailable` and /api/config says `designPdf: false`, so the editor saves "PDF (raster)" until it is. */
export const designPdfRenderer = (): 'chromium' | 'rust' => (process.env.ENABLE_DESIGN_PDF_EXPORT === 'rust' ? 'rust' : 'chromium');

/** The vector PDF is open to this account: the design tool is, the switch is not off, and its renderer exists. */
export const designPdfAvailable = (account: Account | null | undefined) =>
  designToolAvailable(account) && designPdfExportEnabled() && designPdfRenderer() === 'chromium';

/** DESIGN_PDF_RENDER_MS: the longest one print may take (60 s by default; a slower server may need more). */
export function designPdfRenderMs(): number {
  const value = Number(process.env.DESIGN_PDF_RENDER_MS || 60_000);
  return Number.isSafeInteger(value) && value > 0 && value <= 600_000 ? value : 60_000;
}

/** DESIGN_PDF_ENGINE: who writes the vector PDF. `chromium` (the default): the print flavour printed by the server's
 *  Chromium (./browser.ts). `wasm`: lane L5's crates/export writes it directly, no browser (shared/design/pdf-wasm.ts;
 *  a document the Rust model refuses still goes to Chromium). `service`: the same writer natively in lane B4's render
 *  service (crates/render-service, DESIGN_RENDER_URL; ./service.ts), its rasters on every core, off the api's event
 *  loop; a document it refuses, or a service that does not answer, goes to Chromium. Anything else is refused at the
 *  first export. */
export function designPdfEngine(): 'chromium' | 'wasm' | 'service' {
  const value = (process.env.DESIGN_PDF_ENGINE ?? 'chromium').trim().toLowerCase();
  if (value === 'chromium' || value === '') return 'chromium';
  if (value === 'wasm') return 'wasm';
  if (value === 'service') return 'service';
  throw new Error(`DESIGN_PDF_ENGINE is '${process.env.DESIGN_PDF_ENGINE}'; expected chromium, wasm or service`);
}

/** DESIGN_RASTER_ENGINE: who paints PNG/JPG/WebP exports and the file-card thumbnails on the server. `browser`: the
 *  editor's own painter, as today. `service`: lane L4's vello_cpu in lane B4's render service (crates/render-service,
 *  POST /:id/export/raster — the same painter as the canvas, text from the catalogue faces). Unset, it follows
 *  DESIGN_PDF_ENGINE: `service` there means `service` here (one switch for the service). The editor paints itself whenever
 *  the server says the service is not there (/api/config `designRaster: false`, or a 503). */
export function designRasterEngine(): 'browser' | 'service' {
  const value = (process.env.DESIGN_RASTER_ENGINE ?? '').trim().toLowerCase();
  if (value === 'browser') return 'browser';
  if (value === 'service') return 'service';
  if (value === '') return designPdfEngine() === 'service' ? 'service' : 'browser';
  throw new Error(`DESIGN_RASTER_ENGINE is '${process.env.DESIGN_RASTER_ENGINE}'; expected browser or service`);
}

/** Server-side rasters are open to this account: the design tool is, the engine is the service and the service is named. */
export const designRasterAvailable = (account: Account | null | undefined) =>
  designToolAvailable(account) && designRasterEngine() === 'service' && renderServiceUrl() !== null;
