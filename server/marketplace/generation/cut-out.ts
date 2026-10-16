// Product cut-outs for marketplace cards (docs/marketplaces.md §Catalog Generation): the seller's own pixels on a transparent
// background (Ozon refuses images without the actual item). "Remove background" is free: the background is the colour at the photo's
// border; it is flood-filled in from the edges within a tolerance the border's own spread sets, specks are dropped, and the edge is
// feathered by a pixel or two. Made for studio photos on an even background; a photo whose border is not one colour is refused with a
// sentence saying so.
//
// The result is cropped to the product with a small margin and stored as PNG with its alpha. The mask is worked out on a copy at most
// MASK_SIDE pixels long and laid over the original at full size. Pure sharp and typed arrays: no database here.
import sharp from 'sharp';
import type {CutOutBox} from '../../../shared/design/marketplace/generation';

const PIXELS = 64_000_000;
/** The longest side the mask is worked out at. */
const MASK_SIDE = 1600;
/** The margin kept around the product: a share of its longer side, at least MIN_MARGIN pixels. */
const MARGIN = 0.03,
  MIN_MARGIN = 4;
/** A cut-out keeps at least this share of the photo, and leaves at least this share see-through. */
const LEAST_PRODUCT = 0.005,
  LEAST_CLEAR = 0.005;

export const CUT_OUT_TEXTS = {
  unevenBackground:
    'This photo has an uneven background at the edges. "Remove background" works for studio shots on a plain background.',
  noBackground: 'Could not find a background around the product: the product fills the whole photo.',
  noProduct: 'Could not find a product in the photo: it is almost all one colour.',
  unreadable: 'Could not read the photo. Upload it again.',
} as const;

/** A refusal the owner reads, answered as {error, code} with its status. */
export class CutOutRefusal extends Error {
  readonly status = 422;
  readonly code = 'marketplace_cut_out_refused';
}
const cutOutRefused = (message: string) => new CutOutRefusal(message);

export type CutOut = {image: Buffer; box: CutOutBox; source: {width: number; height: number}};

type Raw = {data: Buffer; width: number; height: number};
async function rawRgba(input: Buffer, side?: number): Promise<Raw> {
  let image = sharp(input, {limitInputPixels: PIXELS}).rotate();
  if (side) image = image.resize(side, side, {fit: 'inside', withoutEnlargement: true});
  const {data, info} = await image.ensureAlpha().raw().toBuffer({resolveWithObject: true});
  return {data, width: info.width, height: info.height};
}

const distance = (data: Buffer | Uint8ClampedArray, at: number, color: readonly number[]) =>
  Math.hypot(data[at] - color[0], data[at + 1] - color[1], data[at + 2] - color[2]);

/** The border ring (two pixels wide) of a picture: its pixel indexes. */
function borderPixels(width: number, height: number): number[] {
  const out: number[] = [];
  const ring = Math.min(2, Math.floor(Math.min(width, height) / 2));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (x < ring || y < ring || x >= width - ring || y >= height - ring) out.push(y * width + x);
  return out;
}

/** The background as the border shows it: the median colour of its opaque pixels, and how far they spread around it. */
export function borderBackground(raw: Raw): {color: [number, number, number]; spread: number; clear: number} {
  const pixels = borderPixels(raw.width, raw.height);
  const opaque = pixels.filter(pixel => raw.data[pixel * 4 + 3] >= 128);
  const median = (channel: number) => {
    const values = opaque.map(pixel => raw.data[pixel * 4 + channel]).sort((a, b) => a - b);
    return values.length ? values[values.length >> 1] : 255;
  };
  const color: [number, number, number] = [median(0), median(1), median(2)];
  const distances = opaque.map(pixel => distance(raw.data, pixel * 4, color)).sort((a, b) => a - b);
  // The spread of the background's own noise: the 80th percentile, so a product that touches the edge does not count.
  const spread = distances.length ? distances[Math.floor(distances.length * 0.8)] : 0;
  return {color, spread, clear: pixels.length ? (pixels.length - opaque.length) / pixels.length : 1};
}

/**
 * The product's mask (255 keeps a pixel) of a raw picture: everything reached from the border through pixels near the background colour
 * is background; a gentle gradient (a soft shadow, a lit sweep) is followed while each step stays small. Islands under a percent of the
 * largest part are dropped. Throws the owner's refusal when the border is not one colour or nothing (or everything) is left.
 */
export function floodMask(raw: Raw): Uint8Array {
  const {width, height, data} = raw;
  const total = width * height;
  const background = borderBackground(raw);
  const tolerance = Math.max(18, Math.min(64, background.spread * 2.5 + 14));
  const border = borderPixels(width, height);
  const off = border.filter(
    pixel => data[pixel * 4 + 3] >= 128 && distance(data, pixel * 4, background.color) > tolerance,
  ).length;
  if (off / border.length > 0.35) throw cutOutRefused(CUT_OUT_TEXTS.unevenBackground);
  const near = (pixel: number) => data[pixel * 4 + 3] < 128 || distance(data, pixel * 4, background.color) <= tolerance;
  const soft = (pixel: number, from: number) =>
    distance(data, pixel * 4, background.color) <= tolerance * 1.6 &&
    Math.hypot(
      data[pixel * 4] - data[from * 4],
      data[pixel * 4 + 1] - data[from * 4 + 1],
      data[pixel * 4 + 2] - data[from * 4 + 2],
    ) <=
      tolerance * 0.3;
  // 1: background. A queue over a typed array: millions of pixels without allocations.
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0,
    tail = 0;
  for (const pixel of border)
    if (!seen[pixel] && near(pixel)) {
      seen[pixel] = 1;
      queue[tail++] = pixel;
    }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const visit = (next: number) => {
      if (seen[next]) return;
      if (near(next) || soft(next, pixel)) {
        seen[next] = 1;
        queue[tail++] = next;
      }
    };
    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel < total - width) visit(pixel + width);
  }
  const mask = new Uint8Array(total);
  for (let pixel = 0; pixel < total; pixel++) mask[pixel] = seen[pixel] ? 0 : 255;
  dropSpecks(mask, width, height);
  let kept = 0;
  for (let pixel = 0; pixel < total; pixel++) if (mask[pixel]) kept++;
  if (kept < total * LEAST_PRODUCT) throw cutOutRefused(CUT_OUT_TEXTS.noProduct);
  if (kept > total * (1 - LEAST_CLEAR)) throw cutOutRefused(CUT_OUT_TEXTS.noBackground);
  return mask;
}

/** Clears the mask's islands smaller than a percent of its largest part (dust, noise on the backdrop). */
function dropSpecks(mask: Uint8Array, width: number, height: number) {
  const total = width * height;
  const label = new Int32Array(total);
  const sizes: number[] = [0];
  const queue = new Int32Array(total);
  for (let start = 0; start < total; start++) {
    if (!mask[start] || label[start]) continue;
    const id = sizes.length;
    let head = 0,
      tail = 0,
      size = 0;
    label[start] = id;
    queue[tail++] = start;
    while (head < tail) {
      const pixel = queue[head++];
      size++;
      const x = pixel % width;
      const visit = (next: number) => {
        if (mask[next] && !label[next]) {
          label[next] = id;
          queue[tail++] = next;
        }
      };
      if (x > 0) visit(pixel - 1);
      if (x < width - 1) visit(pixel + 1);
      if (pixel >= width) visit(pixel - width);
      if (pixel < total - width) visit(pixel + width);
    }
    sizes.push(size);
  }
  const least = Math.max(24, Math.max(...sizes) * 0.01);
  for (let pixel = 0; pixel < total; pixel++) if (mask[pixel] && sizes[label[pixel]] < least) mask[pixel] = 0;
}

/** The original at full size with `alpha` (one channel, its size) as its transparency, cropped to the product with a margin. */
async function finish(original: Raw, alpha: Buffer): Promise<CutOut> {
  const {width, height, data} = original;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const value = Math.min(alpha[pixel], data[pixel * 4 + 3]);
    data[pixel * 4 + 3] = value;
    if (value <= 8) continue;
    const x = pixel % width,
      y = (pixel - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw cutOutRefused(CUT_OUT_TEXTS.noProduct);
  const margin = Math.max(MIN_MARGIN, Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * MARGIN));
  const left = Math.max(0, minX - margin),
    top = Math.max(0, minY - margin);
  const kept = {
    left,
    top,
    width: Math.min(width, maxX + margin + 1) - left,
    height: Math.min(height, maxY + margin + 1) - top,
  };
  const image = await sharp(data, {raw: {width, height, channels: 4}})
    .extract(kept)
    .png({compressionLevel: 6})
    .toBuffer();
  return {
    image,
    box: {x: kept.left / width, y: kept.top / height, width: kept.width / width, height: kept.height / height},
    source: {width, height},
  };
}

/** A mask worked out at a smaller size, laid over `size` with a feather of a pixel or two. */
async function maskAt(
  mask: Uint8Array,
  from: {width: number; height: number},
  size: {width: number; height: number},
): Promise<Buffer> {
  let image = sharp(Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength), {
    raw: {width: from.width, height: from.height, channels: 1},
  });
  if (from.width !== size.width || from.height !== size.height)
    image = image.resize(size.width, size.height, {fit: 'fill', kernel: 'cubic'});
  // One band out: sharp would hand a blurred grey picture back as sRGB.
  return image.blur(0.8).toColourspace('b-w').raw().toBuffer();
}

/** "Remove background": the free cut-out of a studio photo. */
export async function floodCutOut(input: Buffer): Promise<CutOut> {
  const original = await rawRgba(input).catch(() => {
    throw cutOutRefused(CUT_OUT_TEXTS.unreadable);
  });
  const small = original.width > MASK_SIDE || original.height > MASK_SIDE ? await rawRgba(input, MASK_SIDE) : original;
  const mask = floodMask(small);
  return finish(original, await maskAt(mask, small, original));
}
