// SSIM compare for the goldens: structural similarity (Wang et al. 2004: 11 × 11 Gaussian
// window, σ 1.5, K1 0.01, K2 0.03) on 8-bit luma, reported per region of two masks: outside both (the sharp
// bar, ≥ 0.995), inside the effect mask (shadows and blurs, ≥ 0.98) and inside the text mask (the text engine's, reported
// but never judged). A window belongs to a region by its centre pixel; text wins over effect.
//
//   npx tsx scripts/goldens/ssim.ts <a.png> <b.png> [--text mask.png] [--effect mask.png] [--outside 0.995] [--effects 0.98]
//   npx tsx scripts/goldens/ssim.ts --golden fixtures/goldens/effects/page@2 <candidate.png>
//
// Exit 1 when a judged region is under its bar. Images of different sizes compare over their common
// top-left part and the size difference is reported. Pure TypeScript apart from PNG decoding (sharp).

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

export type Gray = {width: number; height: number; data: Float32Array};
export type RegionScore = {windows: number; ssim: number};
export type SsimReport = {
  width: number;
  height: number;
  sizeMismatch: string | null;
  overall: RegionScore;
  outside: RegionScore;
  effect: RegionScore;
  text: RegionScore;
  /** Fraction of pixels whose luma differs by more than 8/255 (a coarse second opinion). */
  differentPixels: number;
};
export const DEFAULT_BARS = {outside: 0.995, effects: 0.98};

const WINDOW = 11;
const SIGMA = 1.5;
const L = 255;
const C1 = (0.01 * L) ** 2;
const C2 = (0.03 * L) ** 2;

export async function readGray(file: string | Buffer): Promise<Gray> {
  const {data, info} = await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const gray = new Float32Array(info.width * info.height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // Composited over white where translucent, like a page shown on a light canvas.
    const a = data[p + 3] / 255;
    const r = data[p] * a + 255 * (1 - a), g = data[p + 1] * a + 255 * (1 - a), b = data[p + 2] * a + 255 * (1 - a);
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return {width: info.width, height: info.height, data: gray};
}

/** A mask as booleans (luma > 127), or null. */
export async function readMask(file: string | undefined): Promise<Uint8Array | null> {
  if (!file) return null;
  const gray = await readGray(file);
  const out = new Uint8Array(gray.data.length);
  for (let i = 0; i < out.length; i++) out[i] = gray.data[i] > 127 ? 1 : 0;
  return out;
}

function gaussianKernel(): Float32Array {
  const k = new Float32Array(WINDOW);
  const half = (WINDOW - 1) / 2;
  let sum = 0;
  for (let i = 0; i < WINDOW; i++) {
    k[i] = Math.exp(-((i - half) ** 2) / (2 * SIGMA * SIGMA));
    sum += k[i];
  }
  for (let i = 0; i < WINDOW; i++) k[i] /= sum;
  return k;
}
const KERNEL = gaussianKernel();

/** Separable Gaussian filter over the valid area (no padding): output is (w − 10) × (h − 10). */
function blur(src: Float32Array, width: number, height: number): {data: Float32Array; width: number; height: number} {
  const w2 = width - WINDOW + 1, h2 = height - WINDOW + 1;
  const tmp = new Float32Array(w2 * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < w2; x++) {
      let s = 0;
      for (let k = 0; k < WINDOW; k++) s += src[row + x + k] * KERNEL[k];
      tmp[y * w2 + x] = s;
    }
  }
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    let s = 0;
    for (let k = 0; k < WINDOW; k++) s += tmp[(y + k) * w2 + x] * KERNEL[k];
    out[y * w2 + x] = s;
  }
  return {data: out, width: w2, height: h2};
}

/** Per-window SSIM map of two equally sized luma images. */
export function ssimMap(a: Gray, b: Gray): {data: Float32Array; width: number; height: number} {
  if (a.width !== b.width || a.height !== b.height) throw new Error('ssimMap: sizes differ');
  const n = a.data.length;
  const aa = new Float32Array(n), bb = new Float32Array(n), ab = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    aa[i] = a.data[i] * a.data[i];
    bb[i] = b.data[i] * b.data[i];
    ab[i] = a.data[i] * b.data[i];
  }
  const muA = blur(a.data, a.width, a.height), muB = blur(b.data, a.width, a.height);
  const sAA = blur(aa, a.width, a.height), sBB = blur(bb, a.width, a.height), sAB = blur(ab, a.width, a.height);
  const out = new Float32Array(muA.data.length);
  for (let i = 0; i < out.length; i++) {
    const ma = muA.data[i], mb = muB.data[i];
    const varA = sAA.data[i] - ma * ma, varB = sBB.data[i] - mb * mb, cov = sAB.data[i] - ma * mb;
    out[i] = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (varA + varB + C2));
  }
  return {data: out, width: muA.width, height: muA.height};
}

function crop(gray: Gray, width: number, height: number): Gray {
  if (gray.width === width && gray.height === height) return gray;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) data.set(gray.data.subarray(y * gray.width, y * gray.width + width), y * width);
  return {width, height, data};
}
function cropMask(mask: Uint8Array | null, from: {width: number; height: number}, width: number, height: number): Uint8Array | null {
  if (!mask) return null;
  if (from.width === width && from.height === height) return mask;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(mask.subarray(y * from.width, y * from.width + width), y * width);
  return out;
}

export function compareGray(a: Gray, b: Gray, masks: {text: Uint8Array | null; effect: Uint8Array | null; maskSize: {width: number; height: number}}): SsimReport {
  const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height);
  const sizeMismatch = a.width === b.width && a.height === b.height ? null : `${a.width}×${a.height} vs ${b.width}×${b.height}`;
  const ca = crop(a, width, height), cb = crop(b, width, height);
  const text = cropMask(masks.text, masks.maskSize, width, height), effect = cropMask(masks.effect, masks.maskSize, width, height);
  const map = ssimMap(ca, cb);
  const half = (WINDOW - 1) / 2;
  const sums = {overall: [0, 0], outside: [0, 0], effect: [0, 0], text: [0, 0]};
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const v = map.data[y * map.width + x];
    const centre = (y + half) * width + (x + half);
    const region = text?.[centre] ? 'text' : effect?.[centre] ? 'effect' : 'outside';
    sums.overall[0] += v;
    sums.overall[1]++;
    sums[region][0] += v;
    sums[region][1]++;
  }
  const score = ([s, n]: number[]): RegionScore => ({windows: n, ssim: n ? s / n : 1});
  let different = 0;
  for (let i = 0; i < ca.data.length; i++) if (Math.abs(ca.data[i] - cb.data[i]) > 8) different++;
  return {width, height, sizeMismatch, overall: score(sums.overall), outside: score(sums.outside), effect: score(sums.effect), text: score(sums.text), differentPixels: different / ca.data.length};
}

export async function compareFiles(a: string | Buffer, b: string | Buffer, masks: {text?: string; effect?: string} = {}): Promise<SsimReport> {
  const [ga, gb, text, effect] = await Promise.all([readGray(a), readGray(b), readMask(masks.text), readMask(masks.effect)]);
  return compareGray(ga, gb, {text, effect, maskSize: {width: ga.width, height: ga.height}});
}

export function judge(report: SsimReport, bars = DEFAULT_BARS): {ok: boolean; failures: string[]} {
  const failures: string[] = [];
  if (report.outside.windows && report.outside.ssim < bars.outside) failures.push(`outside ${report.outside.ssim.toFixed(4)} < ${bars.outside}`);
  if (report.effect.windows && report.effect.ssim < bars.effects) failures.push(`effect ${report.effect.ssim.toFixed(4)} < ${bars.effects}`);
  return {ok: !failures.length, failures};
}

export function formatReport(report: SsimReport): string {
  const line = (name: string, s: RegionScore) => `  ${name.padEnd(8)} ${s.ssim.toFixed(4)}  (${s.windows} windows)`;
  return [
    `size ${report.width}×${report.height}${report.sizeMismatch ? ` (mismatch: ${report.sizeMismatch})` : ''}; pixels differing > 8/255: ${(report.differentPixels * 100).toFixed(2)} %`,
    line('overall', report.overall), line('outside', report.outside), line('effect', report.effect), line('text', report.text),
  ].join('\n');
}

async function main(argv: string[]): Promise<void> {
  const files: string[] = [];
  const opts: {text?: string; effect?: string; golden?: string} = {};
  const bars = {...DEFAULT_BARS};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--text') opts.text = argv[++i];
    else if (arg === '--effect') opts.effect = argv[++i];
    else if (arg === '--golden') opts.golden = argv[++i];
    else if (arg === '--outside') bars.outside = Number(argv[++i]);
    else if (arg === '--effects') bars.effects = Number(argv[++i]);
    else files.push(arg);
  }
  if (opts.golden) {
    files.unshift(`${opts.golden}.png`);
    opts.text ??= `${opts.golden}.text.png`;
    opts.effect ??= `${opts.golden}.effect.png`;
  }
  if (files.length !== 2) throw new Error('usage: ssim.ts <a.png> <b.png> [--text m.png] [--effect m.png] | --golden <stem> <b.png>');
  const report = await compareFiles(files[0], files[1], opts);
  console.log(`${path.basename(files[0])} vs ${path.basename(files[1])}`);
  console.log(formatReport(report));
  const verdict = judge(report, bars);
  console.log(verdict.ok ? `ok (outside ≥ ${bars.outside}, effect ≥ ${bars.effects})` : `below the bar: ${verdict.failures.join('; ')}`);
  if (!verdict.ok) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
