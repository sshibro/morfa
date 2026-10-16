// Product cut-outs (server/marketplace/generation/cut-out.ts): "Remove background" flood-fills a studio photo's even background from its border
// and keeps the seller's own pixels with a feathered alpha; a photo whose border is not one colour is refused in words. Synthetic
// pictures made with sharp; nothing is sent anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {CUT_OUT_TEXTS, floodCutOut} from '../server/marketplace/generation/cut-out';

type Rect = {x: number; y: number; width: number; height: number};
const RED = [200, 30, 40] as const;

/** A photo: `background(x, y)` everywhere, a red product in `product` (with a darker stripe, so it is not one colour). */
async function photo(width: number, height: number, product: Rect, background: (x: number, y: number) => readonly number[] = () => [250, 250, 250]): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside = x >= product.x && x < product.x + product.width && y >= product.y && y < product.y + product.height;
      const color = inside ? (y - product.y < 6 ? [120, 20, 30] : RED) : background(x, y);
      data.set(color, (y * width + x) * 3);
    }
  return sharp(data, {raw: {width, height, channels: 3}}).png().toBuffer();
}
const pixels = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject: true});
const at = (raw: {data: Buffer; info: {width: number}}, x: number, y: number) => [...raw.data.subarray((y * raw.info.width + x) * 4, (y * raw.info.width + x) * 4 + 4)];
const refusal = (message: string) => (error: unknown) => {
  assert.equal((error as {status?: number}).status, 422);
  assert.equal((error as {code?: string}).code, 'marketplace_cut_out_refused');
  assert.equal((error as Error).message, message);
  return true;
};

test('"Remove background": the product of a studio photo on a PNG with alpha, cropped with a margin, its pixels the seller\'s', async () => {
  const product = {x: 100, y: 80, width: 200, height: 140};
  const cut = await floodCutOut(await photo(400, 300, product));
  assert.deepEqual(cut.source, {width: 400, height: 300});
  const meta = await sharp(cut.image).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.hasAlpha, true);
  // A margin of 3 % of the product's longer side (6 px) around it, past the feather's pixel.
  const box = [cut.box.x * 400, cut.box.y * 300, cut.box.width * 400, cut.box.height * 300].map(Math.round);
  [94, 74, 212, 152].forEach((value, i) => assert.ok(Math.abs(box[i] - value) <= 2, `${box}`));
  const raw = await pixels(cut.image);
  const [left, top] = [product.x - box[0], product.y - box[1]];
  assert.deepEqual(at(raw, 0, 0)[3], 0, 'the corner is clear');
  assert.deepEqual(at(raw, left + 50, top + 60), [...RED, 255], 'the inside is the original, solid');
  assert.deepEqual(at(raw, left + 50, top + 2).slice(0, 3), [120, 20, 30], 'the stripe at the top edge is kept');
  // The edge is feathered by a pixel or two: some partial alpha along it, none far from it.
  const row = Array.from({length: raw.info.width}, (_, x) => at(raw, x, top + 70)[3]);
  assert.ok(row.some(alpha => alpha > 0 && alpha < 255), 'a soft edge');
  assert.equal(row.filter(alpha => alpha > 0 && alpha < 255).length <= 8, true, 'only at the edges');
});

test('a soft gradient backdrop and noise on it are still background', async () => {
  const product = {x: 150, y: 100, width: 100, height: 120};
  const noise = (x: number, y: number) => ((x * 7919 + y * 104729) % 9) - 4;
  const sweep = (x: number, y: number) => {
    const v = Math.round(235 + (y / 300) * 15) + noise(x, y);
    return [v, v, v - 2];
  };
  const cut = await floodCutOut(await photo(400, 300, product, sweep));
  const box = [cut.box.x * 400, cut.box.y * 300, cut.box.width * 400, cut.box.height * 300].map(Math.round);
  assert.ok(Math.abs(box[0] - (150 - 4)) <= 1 && Math.abs(box[1] - (100 - 4)) <= 1, `${box}`);
  assert.ok(Math.abs(box[2] - (100 + 8)) <= 2 && Math.abs(box[3] - (120 + 8)) <= 2, `${box}`);
});

test('a photo whose border is not one colour, or with nothing on it, is refused in words', async () => {
  const split = await photo(400, 300, {x: 150, y: 100, width: 50, height: 50}, x => (x < 200 ? [20, 20, 20] : [240, 240, 240]));
  await assert.rejects(floodCutOut(split), refusal(CUT_OUT_TEXTS.unevenBackground));
  const empty = await photo(400, 300, {x: 0, y: 0, width: 0, height: 0});
  await assert.rejects(floodCutOut(empty), refusal(CUT_OUT_TEXTS.noProduct));
  await assert.rejects(floodCutOut(Buffer.from('not a picture')), refusal(CUT_OUT_TEXTS.unreadable));
});

test('a large photo: the mask is worked out smaller and laid over the full size', async () => {
  const cut = await floodCutOut(await photo(2400, 1800, {x: 600, y: 500, width: 1200, height: 800}));
  assert.deepEqual(cut.source, {width: 2400, height: 1800});
  const meta = await sharp(cut.image).metadata();
  assert.ok(Math.abs((meta.width ?? 0) - (1200 + 2 * 36)) <= 4, `${meta.width}`);
  const raw = await pixels(cut.image);
  assert.deepEqual(at(raw, 600, 400), [...RED, 255]);
});
