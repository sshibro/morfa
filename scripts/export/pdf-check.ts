// The PDF check (TARGETS X4): per fixture, the vector PDF written by
// crates/export (DESIGN_PDF_ENGINE=wasm) and today's, printed by the server's Chromium pipeline
// (server/design/pdf/), both opened in MuPDF (PyMuPDF) and pdf.js:
//   - page count and every page's size against pdfPageSize (±0.01 pt);
//   - MuPDF and pdf.js warnings (none allowed for ours);
//   - text extraction: ours against Chromium's, whitespace-insensitive, and every visible text layer found in it;
//   - rasterised at 144 dpi: SSIM per page against Chromium's (≥ 0.98); at 150 dpi the share of pixels that differ
//     by more than 16/255 in a channel (X4: ≤ 0.5 %);
//   - file size against Chromium's (≤ 1.5×), and the time each engine took.
// Chromium refuses to run as root with its sandbox: run this as an ordinary user.
//
//   PDFJS_DIST=… IMPORT_CHROMIUM_PATH=… npx tsx scripts/export/pdf-check.ts [--only social,fuzz3] [--out output/L5/pdf]
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type {DesignDocument, ImageAsset, NodeId} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {pdfPagePlan, pdfPageSize, readingOrder, PDF_EXPORT_LIMITS} from '../../shared/design/pdf-export';
import {exportSvgPage} from '../../shared/design/svg-export';
import {DESIGN_TEMPLATES} from '../../shared/design/templates';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';
import {fuzzDocument} from '../../tests/helpers/design-fuzz';
import {pictureTable, plannedPages, renderWasm} from '../../server/design/pdf/export';
import type {PrintablePicture} from '../../server/design/pdf/pictures';
import {chromiumPdf, closePdfBrowser} from './chromium-pdf';
import {ROOT, differingShare, exportModuleFor, mupdf, readPng, ssim} from './lib';

const arg = (name: string, fallback?: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const only = arg('only')?.split(',');
const out = path.resolve(arg('out', 'output/L5/pdf')!);
fs.mkdirSync(out, {recursive: true});

// ── Pictures: a photo-like JPEG and a PNG with transparency per image ref, as the server would read them ───────────

async function makePictures(count: number): Promise<{assets: Record<string, ImageAsset>; files: Map<string, PrintablePicture>}> {
  const assets: Record<string, ImageAsset> = {};
  const files = new Map<string, PrintablePicture>();
  for (let i = 0; i < count; i++) {
    const width = 320 + i * 40, height = 240 + i * 30;
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const k = (y * width + x) * 4;
        raw[k] = (x * 255) / width;
        raw[k + 1] = (y * 255) / height;
        raw[k + 2] = 128 + 127 * Math.sin((x + y + i * 37) / 23);
        raw[k + 3] = i % 2 && x < width / 4 ? Math.round((255 * x) / (width / 4)) : 255;
      }
    const image = sharp(raw, {raw: {width, height, channels: 4}});
    const png = i % 2 === 1;
    const data = png ? await image.png().toBuffer() : await image.flatten({background: '#ffffff'}).jpeg({quality: 90}).toBuffer();
    const name = `l5-picture-${i}.${png ? 'png' : 'jpg'}`;
    assets[`img${i}`] = {url: `/uploads/${name}`, width, height};
    files.set(name, {type: png ? 'image/png' : 'image/jpeg', data});
  }
  return {assets, files};
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Fixture = {name: string; doc: DesignDocument; frames: NodeId[]; measurer: TextMeasurer};

function frameIds(doc: DesignDocument, limit: number = PDF_EXPORT_LIMITS.pages): NodeId[] {
  const ids: NodeId[] = [];
  for (const page of doc.pages) {
    const children = (doc.nodes[page]?.children ?? []).filter(id => {
      const node = doc.nodes[id];
      return node && node.visible && node.type !== 'SLICE' && node.width > 0 && node.height > 0;
    });
    ids.push(...readingOrder(doc, children));
  }
  for (const node of Object.values(doc.nodes)) if (node.type === 'SLICE') ids.push(node.id);
  return ids.filter(id => pdfPagePlan(doc, id)).slice(0, limit);
}

async function fixtures(): Promise<{list: Fixture[]; files: Map<string, PrintablePicture>}> {
  const {assets, files} = await makePictures(6);
  const list: Fixture[] = [];
  for (const template of DESIGN_TEMPLATES) {
    if (template.id === 'blank') continue;
    const doc = template.build({measurer: testMeasurer});
    list.push({name: template.id, doc, frames: frameIds(doc), measurer: testMeasurer});
  }
  const product = productFile(assets);
  list.push({name: 'productFile', doc: product, frames: frameIds(product), measurer: testMeasurer});
  const heavy = heavyPage();
  list.push({name: 'heavyPage', doc: heavy, frames: frameIds(heavy, 10), measurer: testMeasurer});
  for (let seed = 1; seed <= 6; seed++) {
    const doc = fuzzDocument(seed, {nodes: 260});
    // The fuzz documents' pictures point at /uploads/<ref>: give each a real file.
    const refs = Object.keys(doc.images);
    refs.forEach((ref, i) => {
      const source = [...files.keys()][i % files.size];
      doc.images[ref] = {...doc.images[ref], url: `/uploads/${source}`};
    });
    list.push({name: `fuzz${seed}`, doc, frames: frameIds(doc), measurer: testMeasurer});
  }
  return {list: only ? list.filter(f => only.includes(f.name)) : list, files};
}

// ── The check ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Row = {
  name: string;
  pages: number;
  chromiumPages: number;
  sizesOk: boolean;
  mupdfWarnings: string;
  chromiumMupdfWarnings: string;
  pdfjsWarnings: string[];
  textEqual: boolean;
  textLayersFound: string;
  ssimMean: number;
  ssimMin: number;
  ssimPagesOk: string;
  differ150: number;
  differ150Worst: number;
  bytes: number;
  chromiumBytes: number;
  wasmMs: number;
  chromiumMs: number;
};

const normalize = (text: string) => text.replace(/\s+/g, '');

function pdfjs(files: string[]): {file: string; pages: number; warnings: string[]; text: string[]; error: string | null}[] {
  if (!process.env.PDFJS_DIST) return files.map(file => ({file, pages: -1, warnings: ['PDFJS_DIST not set'], text: [], error: null}));
  return JSON.parse(execFileSync('node', [path.join(ROOT, 'scripts/export/pdfjs-check.mjs'), ...files], {maxBuffer: 1 << 28, env: process.env}).toString());
}

async function check(fixture: Fixture, files: Map<string, PrintablePicture>): Promise<Row> {
  const {doc, frames, measurer, name} = fixture;
  exportModuleFor(doc);
  const picture = async (fileName: string) => files.get(fileName) ?? null;

  let started = performance.now();
  const pages = plannedPages(doc, frames, measurer);
  const table = pictureTable(doc);
  const ours = await renderWasm(doc, pages, measurer, table, async index => {
    const fileName = table.nameOf(index);
    return fileName ? picture(fileName) : null;
  }, name);
  const wasmMs = performance.now() - started;

  started = performance.now();
  const theirs = await chromiumPdf(doc, frames, measurer, picture, name);
  const chromiumMs = performance.now() - started;

  const dir = path.join(out, name);
  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
  const oursFile = path.join(dir, 'wasm.pdf'), theirsFile = path.join(dir, 'chromium.pdf');
  fs.writeFileSync(oursFile, ours.pdf);
  fs.writeFileSync(theirsFile, theirs);

  // Expected sizes: pdfPageSize of each non-empty page's SVG bounds (the TypeScript exporter's).
  const expected: {width: number; height: number}[] = [];
  let index = 0;
  for (const id of frames) {
    const plan = pdfPagePlan(doc, id);
    if (!plan) continue;
    const {bounds} = exportSvgPage(doc, plan.ids, {measurer, print: true, idPrefix: `p${index}_`, crop: plan.crop});
    if (!(bounds.width > 0 && bounds.height > 0)) continue;
    expected.push(pdfPageSize(bounds));
    index++;
  }

  const a = mupdf(oursFile, 144, path.join(dir, 'wasm-144'));
  const b = mupdf(theirsFile, 144, path.join(dir, 'chromium-144'));
  const a150 = mupdf(oursFile, 150, path.join(dir, 'wasm-150'));
  const b150 = mupdf(theirsFile, 150, path.join(dir, 'chromium-150'));
  const sizesOk = a.pages.length === expected.length && a.pages.every((p, i) => Math.abs(p.width - expected[i].width) < 0.01 && Math.abs(p.height - expected[i].height) < 0.01);
  let total = 0, worst = 1, sum = 0, differ = 0, differWorst = 0, ok = 0;
  const count = Math.min(a.pages.length, b.pages.length);
  for (let i = 0; i < count; i++) {
    const [pa, pb] = await Promise.all([readPng(a.pages[i].png), readPng(b.pages[i].png)]);
    const value = ssim(pa, pb);
    sum += value;
    worst = Math.min(worst, value);
    if (value >= 0.98) ok++;
    total++;
    const [qa, qb] = await Promise.all([readPng(a150.pages[i].png), readPng(b150.pages[i].png)]);
    const share = differingShare(qa, qb, 16);
    differ += share;
    differWorst = Math.max(differWorst, share);
  }
  const ourText = a.pages.map(p => p.text).join('\n'), theirText = b.pages.map(p => p.text).join('\n');
  // Every visible text layer of the pages appears in our extracted text (in order within its page).
  const layers: string[] = [];
  for (const id of frames) {
    const stack = [id];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node || !node.visible) continue;
      if (node.text?.characters.trim()) layers.push(node.text.characters);
      stack.push(...(node.children ?? []));
    }
  }
  const flat = normalize(ourText), theirFlat = normalize(theirText);
  const found = layers.filter(text => flat.includes(normalize(text).slice(0, 40))).length;
  const theirFound = layers.filter(text => theirFlat.includes(normalize(text).slice(0, 40))).length;
  // The same words (Chromium writes a text that is both a clip and a stroke twice; spacing between runs differs).
  const words = (text: string) => [...new Set(text.split(/\s+/).filter(Boolean))].sort().join(' ');
  const viewers = pdfjs([oursFile]);
  return {
    name,
    pages: a.pages.length,
    chromiumPages: b.pages.length,
    sizesOk,
    mupdfWarnings: a.warnings + (a.error ? ` error: ${a.error}` : ''),
    chromiumMupdfWarnings: b.warnings,
    pdfjsWarnings: [...viewers[0].warnings, ...(viewers[0].error ? [viewers[0].error] : [])],
    textEqual: normalize(ourText) === normalize(theirText) || words(ourText) === words(theirText),
    textLayersFound: `${found}/${layers.length} (chromium ${theirFound})`,
    ssimMean: total ? sum / total : 0,
    ssimMin: total ? worst : 0,
    ssimPagesOk: `${ok}/${total}`,
    differ150: total ? differ / total : 1,
    differ150Worst: differWorst,
    bytes: ours.pdf.length,
    chromiumBytes: theirs.length,
    wasmMs,
    chromiumMs,
  };
}

const {list, files} = await fixtures();
const rows: Row[] = [];
for (const fixture of list) {
  try {
    const row = await check(fixture, files);
    rows.push(row);
    console.log(
      `${row.name.padEnd(13)} pages ${row.pages}/${row.chromiumPages} sizes ${row.sizesOk ? 'ok' : 'DIFF'} · SSIM144 mean ${row.ssimMean.toFixed(4)} min ${row.ssimMin.toFixed(4)} (${row.ssimPagesOk} ≥ 0.98) · differ150 ${(row.differ150 * 100).toFixed(2)} % (worst ${(row.differ150Worst * 100).toFixed(2)} %) · text ${row.textEqual ? '=' : '≠'} chromium, layers ${row.textLayersFound} · ${(row.bytes / 1024).toFixed(0)} KiB vs ${(row.chromiumBytes / 1024).toFixed(0)} (${(row.bytes / row.chromiumBytes).toFixed(2)}×) · ${row.wasmMs.toFixed(0)} ms vs ${row.chromiumMs.toFixed(0)} ms · mupdf '${row.mupdfWarnings.slice(0, 80)}' pdf.js ${row.pdfjsWarnings.length}`,
    );
  } catch (error) {
    console.log(`${fixture.name}: FAILED ${(error as Error).stack}`);
  }
}
await closePdfBrowser();
fs.writeFileSync(path.join(out, 'rows.json'), JSON.stringify(rows, null, 1));
