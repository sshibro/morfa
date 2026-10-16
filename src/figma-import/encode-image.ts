/** A picture to bring from Figma: a photo fill by its ref, or a layer Figma renders as PNG or SVG. The design
 *  tool's import uses `fill`. */
export type FigmaAsset =
  | {index: number; kind: 'fill'; ref: string; maxSide: number}
  | {index: number; kind: 'render'; node: string; format: 'png' | 'svg'; maxSide: number};

export const WEBP_QUALITY = 0.86;
// The second, smaller pass when the request is over its budget.
export const SHRINK_QUALITY = 0.75;
export const SHRINK_SIDE = 1600;
export const MAX_SVG_BYTES = 2 * 1024 * 1024;

export type ImageKind = FigmaAsset['kind'];
export type EncodeOptions = {maxSide?: number; quality?: number};
type Size = {width: number; height: number};
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

// Unknown until the first encode: Safari hands back PNG when asked for WebP.
let webpWorks: boolean | undefined;

/** The drawn size: the longest side at most `maxSide`, never upscaled, never under 1 px. */
export function targetSize(width: number, height: number, maxSide: number): Size {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

/** WebP when the browser encodes it; otherwise a photo fill stays JPEG and anything that may be transparent PNG. */
export function outputType(kind: ImageKind, webp: boolean, sourceIsJpeg: boolean): string {
  if (webp) return 'image/webp';
  return kind === 'fill' && sourceIsJpeg ? 'image/jpeg' : 'image/png';
}

export const isJpeg = (head: Uint8Array) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;

function canvasOf({width, height}: Size): AnyCanvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function blobOf(canvas: AnyCanvas, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({type, quality});
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function draw(source: Blob, maxSide: number): Promise<AnyCanvas | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null;
  }
  try {
    const size = targetSize(bitmap.width, bitmap.height, maxSide);
    const canvas = canvasOf(size);
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/**
 * One fetched Figma file, ready to upload: rasters redrawn at most `maxSide` wide as WebP
 * (JPEG or PNG where WebP is not encoded), SVG renders kept as text. On the main thread:
 * the app's CSP allows no workers. Null when the file cannot be used.
 */
export async function encodeFigmaImage(source: Blob, asset: FigmaAsset, options: EncodeOptions = {}): Promise<Blob | null> {
  if (asset.kind === 'render' && asset.format === 'svg') return source.size <= MAX_SVG_BYTES ? new Blob([source], {type: 'image/svg+xml'}) : null;
  const {maxSide = asset.maxSide, quality = WEBP_QUALITY} = options;
  const jpeg = isJpeg(new Uint8Array(await source.slice(0, 3).arrayBuffer()));
  const canvas = await draw(source, maxSide);
  if (!canvas) return null;
  try {
    const wanted = outputType(asset.kind, webpWorks !== false, jpeg);
    const blob = await blobOf(canvas, wanted, quality);
    if (!blob || wanted !== 'image/webp') return blob;
    webpWorks = blob.type === 'image/webp';
    if (webpWorks) return blob;
    const fallback = outputType(asset.kind, false, jpeg);
    return blob.type === fallback ? blob : blobOf(canvas, fallback, quality);
  } catch {
    return null;
  }
}

/** The smaller second pass for a request over its budget; SVG text cannot shrink. */
export function shrinkFigmaImage(encoded: Blob, asset: FigmaAsset): Promise<Blob | null> {
  if (encoded.type === 'image/svg+xml') return Promise.resolve(null);
  return encodeFigmaImage(encoded, asset, {maxSide: Math.min(asset.maxSide, SHRINK_SIDE), quality: SHRINK_QUALITY});
}
