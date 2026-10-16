// Lane L5's checking tools: Chromium (Playwright's, `--no-sandbox` for these local renders) rasterising SVG with the
// catalogue fonts, PDF rasterisation through MuPDF (PyMuPDF, scripts/export/pdf-tool.py), and SSIM / pixel difference
// of RGBA images.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {chromium, type Browser} from 'playwright-core';
import {fontFaceCss} from '../../server/design/pdf/fonts';
import {exportWasm, type ExportWasm} from '../../shared/design/export-wasm';
import {registerExportFonts} from '../../shared/design/export-fonts';
import type {DesignDocument, NodeId} from '../../shared/design/types';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const FONT_ROOT = path.join(ROOT, 'public/fonts');

export const readFont = (file: string): Uint8Array | null => {
  try {
    return fs.readFileSync(path.join(FONT_ROOT, file));
  } catch {
    return null;
  }
};

/** Families the text of `ids` (and their subtrees) sets type in. */
export function familiesOf(doc: DesignDocument, ids: readonly NodeId[] = doc.pages): Set<string> {
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    if (node.text) {
      out.add(node.text.style.fontFamily);
      for (const run of node.text.runs) if (run.style.fontFamily) out.add(run.style.fontFamily);
    }
    stack.push(...(node.children ?? []));
  }
  return out;
}

/** The export module with the catalogue faces of `doc`'s families registered. */
export function exportModuleFor(doc: DesignDocument): ExportWasm {
  const module = exportWasm();
  registerExportFonts(module, familiesOf(doc), readFont);
  return module;
}

/** Chromium for these checks: IMPORT_CHROMIUM_PATH (the server's own setting), else the container's headless shell
 *  when Playwright's pinned build is not installed, else Playwright's. */
export function chromiumPath(): string | undefined {
  if (process.env.IMPORT_CHROMIUM_PATH) return process.env.IMPORT_CHROMIUM_PATH;
  const shell = '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
  return fs.existsSync(shell) ? shell : undefined;
}

let browser: Promise<Browser> | null = null;
export function launch(): Promise<Browser> {
  const executablePath = chromiumPath();
  return (browser ??= chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(executablePath ? {executablePath} : {})}));
}
export async function closeBrowser(): Promise<void> {
  if (browser) await (await browser).close();
  browser = null;
}

/** An SVG rasterised by Chromium at `scale` device pixels per px, on white, with the catalogue fonts it names. */
export async function renderSvg(svg: string, width: number, height: number, scale: number, families: Iterable<string>): Promise<{data: Buffer; width: number; height: number}> {
  const b = await launch();
  const w = Math.max(1, Math.ceil(width)), h = Math.max(1, Math.ceil(height));
  const page = await b.newPage({viewport: {width: w, height: h}, deviceScaleFactor: scale});
  try {
    await page.route('https://fonts.l5.invalid/**', async route => {
      const file = new URL(route.request().url()).pathname.slice(1);
      const data = readFont(file);
      if (data) await route.fulfill({status: 200, contentType: 'font/woff2', body: Buffer.from(data)});
      else await route.abort();
    });
    const css = fontFaceCss(families, 'https://fonts.l5.invalid').css;
    await page.setContent(`<!doctype html><html><head><style>${css}
html,body{margin:0;padding:0;background:${process.env.L5_BACKGROUND ?? "#fff"}} svg{display:block} svg text{white-space:pre}${process.env.L5_TEXT_CSS ?? ""}</style></head><body>${svg}</body></html>`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      // Faces load on first use: ask for every face the page declares, then wait again.
      await Promise.all([...document.fonts].map(face => face.load().catch(() => null)));
      await document.fonts.ready;
    });
    const png = await page.screenshot({type: 'png', clip: {x: 0, y: 0, width: w, height: h}});
    const raw = await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    return {data: raw.data, width: raw.info.width, height: raw.info.height};
  } finally {
    await page.close();
  }
}

export type Image = {data: Buffer | Uint8Array; width: number; height: number};

/** Grey of an RGBA image composited on white (BT.601 luma). */
function grey(image: Image, x0: number, y0: number, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * image.width + (x0 + x)) * 4;
      const a = image.data[i + 3] / 255;
      const r = image.data[i] * a + 255 * (1 - a), g = image.data[i + 1] * a + 255 * (1 - a), b = image.data[i + 2] * a + 255 * (1 - a);
      out[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  return out;
}

/** Mean SSIM (Wang et al. 2004: 11×11 Gaussian window, σ 1.5, K1 0.01, K2 0.03, L 255) of a region of two images of
 *  the same size. A region smaller than the window is compared over its whole area. */
export function ssim(a: Image, b: Image, region?: {x: number; y: number; width: number; height: number}): number {
  const x0 = Math.max(0, Math.floor(region?.x ?? 0)), y0 = Math.max(0, Math.floor(region?.y ?? 0));
  const w = Math.min(a.width, b.width, Math.ceil((region?.x ?? 0) + (region?.width ?? a.width))) - x0;
  const h = Math.min(a.height, b.height, Math.ceil((region?.y ?? 0) + (region?.height ?? a.height))) - y0;
  if (w <= 0 || h <= 0) return 1;
  const ga = grey(a, x0, y0, w, h), gb = grey(b, x0, y0, w, h);
  const radius = Math.min(5, Math.floor((Math.min(w, h) - 1) / 2));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * 1.5 * 1.5));
    kernel.push(v);
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const blur = (src: Float64Array): Float64Array => {
    const tmp = new Float64Array(w * h), out = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = radius; x < w - radius; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += src[y * w + x + k] * kernel[k + radius];
        tmp[y * w + x] = s;
      }
    for (let y = radius; y < h - radius; y++)
      for (let x = radius; x < w - radius; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += tmp[(y + k) * w + x] * kernel[k + radius];
        out[y * w + x] = s;
      }
    return out;
  };
  const mul = (p: Float64Array, q: Float64Array) => p.map((v, i) => v * q[i]);
  const ma = blur(ga), mb = blur(gb), saa = blur(mul(ga, ga)), sbb = blur(mul(gb, gb)), sab = blur(mul(ga, gb));
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let total = 0, count = 0;
  for (let y = radius; y < h - radius; y++)
    for (let x = radius; x < w - radius; x++) {
      const i = y * w + x;
      const va = saa[i] - ma[i] * ma[i], vb = sbb[i] - mb[i] * mb[i], cov = sab[i] - ma[i] * mb[i];
      total += ((2 * ma[i] * mb[i] + c1) * (2 * cov + c2)) / ((ma[i] * ma[i] + mb[i] * mb[i] + c1) * (va + vb + c2));
      count++;
    }
  return count ? total / count : 1;
}

/** Share of pixels whose channels differ by more than `threshold` (0–255) between two images of the same size. */
export function differingShare(a: Image, b: Image, threshold = 16): number {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  let differ = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const va = a.data[i + c] * (a.data[i + 3] / 255) + 255 * (1 - a.data[i + 3] / 255);
        const vb = b.data[j + c] * (b.data[j + 3] / 255) + 255 * (1 - b.data[j + 3] / 255);
        if (Math.abs(va - vb) > threshold) {
          differ++;
          break;
        }
      }
    }
  return differ / Math.max(1, w * h) + Math.abs(a.width * a.height - b.width * b.height) / Math.max(1, w * h);
}

/** MuPDF (PyMuPDF) on a PDF: per page its size, rasterisation at `dpi` (PNG files in `dir`), extracted text and
 *  MuPDF's warnings. */
export type PdfInfo = {pages: {width: number; height: number; png: string; text: string}[]; warnings: string; error?: string};
export function mupdf(pdf: string, dpi: number, dir: string): PdfInfo {
  const out = execFileSync('python3', ['-I', path.join(ROOT, 'scripts/export/pdf-tool.py'), pdf, String(dpi), dir], {maxBuffer: 1 << 28}).toString();
  return JSON.parse(out) as PdfInfo;
}

export async function readPng(file: string): Promise<Image> {
  const raw = await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  return {data: raw.data, width: raw.info.width, height: raw.info.height};
}
