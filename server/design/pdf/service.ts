import type {PdfMeasurements, PdfPagePlan} from '../../../shared/design/pdf-export';
import {catalogueFamily, familyFaces} from '../../../shared/design/export-fonts';

// api → lane B4's render service (crates/render-service, `morfa-render`, docs/BACKEND.md §4) over the private network:
// POST /internal/render with `Authorization: Bearer <DESIGN_RENDER_SECRET>`. One binary body (crates/render-service
// src/request.rs): "MRR1", the header's length and JSON, the document's length and JSON, then the pictures' bytes in the
// header's order — the service reads nothing else (no network, no database): the api decides what the caller may see.
//
//   DESIGN_RENDER_URL     the service's base URL (http://127.0.0.1:3440); unset: DESIGN_PDF_ENGINE=service is refused
//   DESIGN_RENDER_SECRET  its MORFA_RENDER_INTERNAL_SECRET (at least 16 characters)

export class RenderServiceUnavailable extends Error {}

export type RenderKind = 'pdf' | 'svg' | 'png' | 'jpeg' | 'webp' | 'thumbnail';

export type RenderFace = {family: string; weight: [number, number]; italic: boolean; unicodeRange: string; file: string};

export type RenderHeader = {
  kind: RenderKind;
  account: string;
  title?: string;
  pages?: {ids: string[]; crop?: {x: number; y: number; width: number; height: number}}[];
  ids?: string[];
  svg?: {precision?: number; idPrefix?: string; layerIds?: boolean; print?: boolean; crop?: {x: number; y: number; width: number; height: number}; outlineText?: boolean};
  scale?: number;
  maxSide?: number;
  quality?: number;
  measure: 'table' | 'fonts' | 'fixed';
  measurements?: PdfMeasurements;
  fonts: RenderFace[];
  pictures: {ref: string; href: string; length: number}[];
  timeoutMs?: number;
};

export type RenderAnswer = {status: number; body: Buffer; headers: Headers};

export function renderServiceUrl(): string | null {
  const url = (process.env.DESIGN_RENDER_URL ?? '').trim();
  return url ? url.replace(/\/+$/, '') : null;
}

function renderSecret(): string {
  const secret = process.env.DESIGN_RENDER_SECRET ?? '';
  if (secret.length < 16) throw new RenderServiceUnavailable('DESIGN_RENDER_SECRET is not set (at least 16 characters)');
  return secret;
}

/** The catalogue faces of `families` as the service reads them (files below its fonts directory); families outside the
 *  catalogue are returned as missing. */
export function renderFaces(families: Iterable<string>): {faces: RenderFace[]; missing: string[]} {
  const faces: RenderFace[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const name of families) {
    const font = catalogueFamily(name);
    if (!font) {
      if (!missing.includes(name)) missing.push(name);
      continue;
    }
    if (seen.has(font.family)) continue;
    seen.add(font.family);
    for (const face of familyFaces(font)) {
      const [low, high = low] = face.weight.split(' ').map(Number);
      faces.push({family: font.family, weight: [low, high], italic: face.style === 'italic', unicodeRange: face.unicodeRange ?? '', file: face.file});
    }
  }
  return {faces, missing};
}

/** The request body (MRR1). `pictures` in the header's order. */
export function encodeRenderRequest(header: RenderHeader, documentJson: string, pictures: readonly Uint8Array[]): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const doc = Buffer.from(documentJson, 'utf8');
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32LE(head.length, 0);
  lengths.writeUInt32LE(doc.length, 4);
  return Buffer.concat([Buffer.from('MRR1'), lengths.subarray(0, 4), head, lengths.subarray(4, 8), doc, ...pictures]);
}

/** A PDF job's header for `plans` (the editor's measurements replayed when it sent any, else the service's own fonts). */
export function pdfJobHeader(plans: readonly PdfPagePlan[], options: {account: string; title?: string; measurements?: PdfMeasurements | null; families: Iterable<string>; pictures: RenderHeader['pictures']; timeoutMs?: number}): {header: RenderHeader; missing: string[]} {
  const {faces, missing} = renderFaces(new Set(['Inter', ...options.families]));
  const measured = !!options.measurements && (options.measurements.fonts.length > 0 || options.measurements.widths.length > 0);
  return {
    header: {
      kind: 'pdf',
      account: options.account,
      title: options.title,
      pages: plans.map(plan => (plan.crop ? {ids: [...plan.ids], crop: plan.crop} : {ids: [...plan.ids]})),
      measure: measured ? 'table' : 'fonts',
      measurements: measured ? options.measurements! : undefined,
      fonts: faces,
      pictures: options.pictures,
      timeoutMs: options.timeoutMs,
    },
    missing,
  };
}

export type RasterKind = 'png' | 'jpeg' | 'webp' | 'thumbnail';

/** A raster job's header (lane L4's vello_cpu in the service, docs/BACKEND.md §4): `ids` drawn together at `scale` device
 *  px per px, the longest side capped at `maxSide` (thumbnails: the service's own 512), JPEG `quality` 1–100; text laid
 *  out by the service's own fonts (lane L3's shaper), which is what the canvas measures too. */
export function rasterJobHeader(ids: readonly string[], options: {kind: RasterKind; account: string; scale?: number; maxSide?: number; quality?: number; families: Iterable<string>; pictures: RenderHeader['pictures']; timeoutMs?: number}): {header: RenderHeader; missing: string[]} {
  const {faces, missing} = renderFaces(new Set(['Inter', ...options.families]));
  return {
    header: {
      kind: options.kind,
      account: options.account,
      ids: [...ids],
      scale: options.scale,
      maxSide: options.maxSide,
      quality: options.quality,
      measure: 'fonts',
      fonts: faces,
      pictures: options.pictures,
      timeoutMs: options.timeoutMs,
    },
    missing,
  };
}

/** Posts one job. Throws RenderServiceUnavailable when the service is not configured or does not answer in time. */
export async function renderJob(body: Buffer, timeoutMs: number): Promise<RenderAnswer> {
  const base = renderServiceUrl();
  if (!base) throw new RenderServiceUnavailable('DESIGN_RENDER_URL is not set');
  let response: Response;
  try {
    response = await fetch(`${base}/internal/render`, {
      method: 'POST',
      headers: {authorization: `Bearer ${renderSecret()}`, 'content-type': 'application/octet-stream'},
      // Buffer.concat's buffer is a plain ArrayBuffer; the DOM typing only asks for that.
      body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
      // The service answers 504 itself at the job's deadline; this one only covers a service that stopped answering.
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
  } catch (error) {
    if (error instanceof RenderServiceUnavailable) throw error;
    throw new RenderServiceUnavailable(`render service: ${(error as Error).message}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status === 403) throw new RenderServiceUnavailable('the render service refused the secret (DESIGN_RENDER_SECRET)');
  return {status: response.status, body: bytes, headers: response.headers};
}

/** The `{code, error}` of a refusal. */
export function refusalOf(answer: RenderAnswer): {code: string; error: string} {
  try {
    const parsed = JSON.parse(answer.body.toString('utf8')) as {code?: unknown; error?: unknown};
    return {code: typeof parsed.code === 'string' ? parsed.code : 'render_failed', error: typeof parsed.error === 'string' ? parsed.error : ''};
  } catch {
    return {code: 'render_failed', error: ''};
  }
}
