import {readApi} from '../../../../../api-read';

// Who paints PNG/JPG/WebP exports: the editor (as always), or the render service when the server says so (/api/config
// `designRaster: true`, DESIGN_RASTER_ENGINE=service — lane L4's vello_cpu, the same painter as the canvas with the
// catalogue's glyphs). Read once per page load; until the answer arrives, or when it cannot be read, the editor paints.
// A server answer other than a picture (a 404 or 503: the service is not there) also leaves the export to the editor.

export type RasterPainter = 'browser' | 'service';

let known: RasterPainter | null = null;
let pending: Promise<RasterPainter> | null = null;

export function rasterPainter(): Promise<RasterPainter> {
  if (known) return Promise.resolve(known);
  pending ??= readApi<{designRaster?: boolean}>('/config')
    .then(config => (config.designRaster === true ? 'service' : 'browser') as RasterPainter)
    .catch(() => 'browser' as RasterPainter)
    .then(painter => {
      known = painter;
      return painter;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Tests: forget the answer (the next ask reads /api/config again). */
export function resetRasterPainter(): void {
  known = null;
  pending = null;
}
