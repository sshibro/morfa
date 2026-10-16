// The pixel-diff harness: two PDFs of the same pages — ours (the render
// service / crates/export) and a reference (today's Chromium print, or another engine's) — rasterised by poppler's
// pdftoppm at 150 dpi, then per page the share of pixels with a channel more than 16/255 apart over white (the export check's
// `differingShare`, scripts/export/lib.ts). Prints a markdown table and the mean and worst page; exits 1 when a page is
// over --max (percent, default 0.5) and --strict is given.
//
// --cache dir keeps each PDF's pages by the file's SHA-256 (poppler takes ~25 min on a 33 MB Chromium print of 50 pages).
//
//   npx tsx scripts/bench/pdf-diff.ts <ours.pdf> <reference.pdf> [--dpi 150] [--max 0.5] [--strict] [--keep dir] [--cache dir]
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {differingShare, readPng} from '../export/lib';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--dpi', '--max', '--keep', '--cache'].includes(args[i - 1])));
if (files.length !== 2) {
  console.error('usage: pdf-diff.ts <ours.pdf> <reference.pdf> [--dpi 150] [--max 0.5] [--strict] [--keep dir]');
  process.exit(2);
}
const [ours, reference] = files;
const dpi = Number(option('dpi', '150'));
const max = Number(option('max', '0.5'));
const keep = option('keep', '');
const cache = option('cache', '');
const dir = keep ? path.resolve(keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-diff-'));
fs.mkdirSync(dir, {recursive: true});

const pages = (pdf: string) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf]).toString())?.[1] ?? 0);

/** pdftoppm writes `<prefix>-<n>.png` with n zero-padded to the page count's width. */
function rasterise(pdf: string, prefix: string): string[] {
  let into = dir;
  if (cache) {
    const hash = createHash('sha256').update(fs.readFileSync(pdf)).digest('hex').slice(0, 24);
    into = path.resolve(cache, `${hash}-${dpi}`);
    if (!fs.existsSync(path.join(into, 'done'))) {
      fs.mkdirSync(into, {recursive: true});
      execFileSync('pdftoppm', ['-r', String(dpi), '-png', pdf, path.join(into, prefix)], {stdio: ['ignore', 'ignore', 'ignore']});
      fs.writeFileSync(path.join(into, 'done'), '');
    }
    prefix = fs.readdirSync(into).find(f => f.endsWith('.png'))?.replace(/-\d+\.png$/, '') ?? prefix;
  } else execFileSync('pdftoppm', ['-r', String(dpi), '-png', pdf, path.join(dir, prefix)], {stdio: ['ignore', 'ignore', 'ignore']});
  return fs
    .readdirSync(into)
    .filter(f => f.startsWith(prefix + '-') && f.endsWith('.png'))
    .sort((a, b) => Number(/-(\d+)\.png$/.exec(a)![1]) - Number(/-(\d+)\.png$/.exec(b)![1]))
    .map(f => path.join(into, f));
}

const [countA, countB] = [pages(ours), pages(reference)];
const a = rasterise(ours, 'ours');
const b = rasterise(reference, 'ref');
console.log(`| page | size (px at ${dpi} dpi) | differing |`);
console.log('|---|---|---|');
const shares: number[] = [];
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  const [x, y] = [await readPng(a[i]), await readPng(b[i])];
  const share = differingShare(x, y) * 100;
  shares.push(share);
  const size = x.width === y.width && x.height === y.height ? `${x.width}×${x.height}` : `${x.width}×${x.height} vs ${y.width}×${y.height}`;
  console.log(`| ${i + 1} | ${size} | ${share.toFixed(2)} % |`);
}
const mean = shares.reduce((s, v) => s + v, 0) / Math.max(1, shares.length);
const worst = Math.max(0, ...shares);
console.log(`\npages ${countA} / ${countB}; mean ${mean.toFixed(2)} %, worst ${worst.toFixed(2)} % (page ${shares.indexOf(worst) + 1}); over ${max} %: ${shares.filter(s => s > max).length}`);
if (!keep) fs.rmSync(dir, {recursive: true, force: true});
if (flag('strict') && (countA !== countB || worst > max)) process.exit(1);
