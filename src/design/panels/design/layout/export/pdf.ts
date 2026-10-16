import {PRODUCT_NAME} from '../../../../../../shared/design/product';

// A small PDF 1.4 writer for "PDF (raster)", the PDF "Export" writes where the server's vector PDF is
// off (vector-pdf.ts, docs/design-tool.md §Export): one page per layer, each page one lossless picture
// (the layer painted at the chosen scale) drawn over the whole page. The pixels are stored as
// /FlateDecode RGB with an 8-bit /SMask for transparency, compressed with the browser's own
// CompressionStream('deflate') (zlib, which is what FlateDecode reads). Text and vectors are not
// kept as such — the panel then names the format "PDF (raster)".
//
// Pages are sized in points, 1 px = 1 pt as design tools do, so a 1440 px frame prints 1440 pt wide
// whatever the scale; a larger scale only packs more pixels into the same page. Acrobat's page
// limit is 14 400 pt; a larger layer is shrunk to fit it, keeping its proportions.

export type PdfImage = {width: number; height: number; rgba: Uint8Array | Uint8ClampedArray};
export type PdfPage = {width: number; height: number; image: PdfImage};
export type Deflate = (bytes: Uint8Array) => Promise<Uint8Array>;

export const PDF_MAX_PAGE = 14_400;

/** zlib-wrapped deflate (RFC 1950) through CompressionStream, as FlateDecode expects. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const encoder = new TextEncoder();
const ascii = (text: string) => encoder.encode(text);

/** A number as PDF writes it: at most 4 decimals, no exponent, no "-0". */
export function pdfNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10_000) / 10_000;
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return rounded.toFixed(4).replace(/\.?0+$/, '');
}

/** A text string as UTF-16BE hex with a byte-order mark: any language, nothing to escape. */
export function pdfText(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/** Splits RGBA into RGB and alpha planes; alpha is null when every pixel is opaque. */
export function splitAlpha(image: PdfImage): {rgb: Uint8Array; alpha: Uint8Array | null} {
  const count = image.width * image.height;
  if (image.rgba.length < count * 4) throw new Error('PDF: the picture has fewer pixels than its size says');
  const rgb = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);
  let opaque = true;
  for (let i = 0, j = 0, k = 0; i < count; i++, j += 4, k += 3) {
    rgb[k] = image.rgba[j];
    rgb[k + 1] = image.rgba[j + 1];
    rgb[k + 2] = image.rgba[j + 2];
    const a = image.rgba[j + 3];
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }
  return {rgb, alpha: opaque ? null : alpha};
}

/** The page size in points, shrunk proportionally when a side passes the PDF 1.4 limit. */
export function pageSize(width: number, height: number): {width: number; height: number} {
  const w = Math.max(1, width), h = Math.max(1, height);
  const k = Math.min(1, PDF_MAX_PAGE / Math.max(w, h));
  return {width: w * k, height: h * k};
}

/** Writes a PDF 1.4 file with one page per entry. */
export async function writePdf(pages: readonly PdfPage[], options: {title?: string; deflate?: Deflate} = {}): Promise<Uint8Array> {
  if (!pages.length) throw new Error('PDF: no pages');
  const squeeze = options.deflate ?? deflate;
  // Object numbers: 1 catalog, 2 page tree, 3 info, then per page: page, contents, image, [mask].
  type Obj = {id: number; parts: Uint8Array[]};
  const objects: Obj[] = [];
  const kids: number[] = [];
  let next = 4;
  for (const page of pages) {
    const {rgb, alpha} = splitAlpha(page.image);
    const pageId = next++, contentsId = next++, imageId = next++, maskId = alpha ? next++ : 0;
    kids.push(pageId);
    const size = pageSize(page.width, page.height);
    const w = pdfNumber(size.width), h = pdfNumber(size.height);
    objects.push({id: pageId, parts: [ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentsId} 0 R >>`)]});
    const drawing = ascii(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    objects.push({id: contentsId, parts: [ascii(`<< /Length ${drawing.length} >>\nstream\n`), drawing, ascii('\nendstream')]});
    const pixels = await squeeze(rgb);
    const smask = maskId ? ` /SMask ${maskId} 0 R` : '';
    objects.push({id: imageId, parts: [
      ascii(`<< /Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask} /Length ${pixels.length} >>\nstream\n`),
      pixels, ascii('\nendstream'),
    ]});
    if (alpha) {
      const mask = await squeeze(alpha);
      objects.push({id: maskId, parts: [
        ascii(`<< /Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${mask.length} >>\nstream\n`),
        mask, ascii('\nendstream'),
      ]});
    }
  }
  const title = options.title ? ` /Title ${pdfText(options.title)}` : '';
  objects.unshift(
    {id: 1, parts: [ascii('<< /Type /Catalog /Pages 2 0 R >>')]},
    {id: 2, parts: [ascii(`<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`)]},
    {id: 3, parts: [ascii(`<< /Producer (${PRODUCT_NAME})${title} >>`)]},
  );

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  // The binary comment tells transfer tools the file is binary (PDF 1.4 §3.4.1).
  push(ascii('%PDF-1.4\n'));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets = new Array<number>(next).fill(0);
  for (const object of [...objects].sort((a, b) => a.id - b.id)) {
    offsets[object.id] = length;
    push(ascii(`${object.id} 0 obj\n`));
    for (const part of object.parts) push(part);
    push(ascii('\nendobj\n'));
  }
  const xref = length;
  // Each entry is exactly 20 bytes: 10 digits, space, 5 digits, space, n/f, space, newline.
  let table = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(ascii(table));
  push(ascii(`trailer\n<< /Size ${next} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
