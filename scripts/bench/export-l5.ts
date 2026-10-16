// The export Node benches:
//   SVG of heavyPage() and productFile(): TypeScript, Rust with the document sent as JSON (a document the shadow does
//   not hold), and Rust reading the shadow document's frame (the editor's case: the shadow follows the store);
//   the vector PDF (crates/export, DESIGN_PDF_ENGINE=wasm) of every starter template, of the 10 largest frames of
//   the templates and productFile, and of two 50-page files (X4: Cyrillic text, pictures, shadows, blurs).
// Medians of --runs (default 5) after one warm-up. Fonts are registered before timing (the server does it once).
//
//   npx tsx scripts/bench/export-l5.ts [--runs 5] [--only svg,pdf,x4]
import fs from 'node:fs';
import sharp from 'sharp';
import {exportSvg} from '../../shared/design/svg-export';
import {exportTransfers} from '../../shared/design/export-wasm';
import {followStore, setEngine, shadowFor} from '../../shared/design/engine-switch';
import {createDesignStore} from '../../src/design/engine/store';
import {pdfPagePlan, readingOrder} from '../../shared/design/pdf-export';
import {exportPdfWasm} from '../../shared/design/pdf-wasm';
import type {DesignDocument, ImageAsset, NodeId} from '../../shared/design/types';
import {DESIGN_TEMPLATES} from '../../shared/design/templates';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';
import {generate} from './gen-file';
import {exportModuleFor} from '../export/lib';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const runs = Number(arg('runs', '5'));
const only = arg('only', 'svg,pdf,x4').split(',');

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function time(run: () => void): number {
  run();
  const values: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    run();
    values.push(performance.now() - started);
  }
  return median(values);
}
const ms = (v: number) => `${v.toFixed(1)} ms`;
const layers = (doc: DesignDocument, id: NodeId): number => 1 + (doc.nodes[id]?.children ?? []).reduce((s, c) => s + layers(doc, c), 0);

async function pictures(count: number): Promise<{assets: Record<string, ImageAsset>; bytes: Map<string, Uint8Array>}> {
  const assets: Record<string, ImageAsset> = {};
  const bytes = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const width = 800, height = 600;
    const raw = Buffer.alloc(width * height * 3);
    for (let p = 0; p < width * height; p++) raw.set([(p * 7) % 256, (p / width) % 256, (i * 40) % 256], p * 3);
    const data = await sharp(raw, {raw: {width, height, channels: 3}}).jpeg({quality: 88}).toBuffer();
    assets[`img${i}`] = {url: `/uploads/bench-${i}.jpg`, width, height};
    bytes.set(`https://pdf.l5.invalid/p/${i}`, data);
  }
  return {assets, bytes};
}

function pdfOf(doc: DesignDocument, frames: NodeId[], bytes?: Map<string, Uint8Array>) {
  const plans = frames.map(id => pdfPagePlan(doc, id)).filter(plan => !!plan);
  const refs = Object.keys(doc.images);
  return exportPdfWasm(doc, plans, {
    measurer: testMeasurer,
    imageHref: ref => (bytes ? `https://pdf.l5.invalid/p/${refs.indexOf(ref)}` : undefined),
    bytes: href => bytes?.get(href),
  });
}

const lines: string[] = [];
const say = (line: string) => {
  console.log(line);
  lines.push(line);
};

if (only.includes('svg')) {
  say('| file | layers | TypeScript | Rust, JSON in | Rust, shadow frame | TS / frame |');
  say('|---|---|---|---|---|---|');
  for (const [name, make] of [['heavyPage', heavyPage], ['productFile', productFile]] as const) {
    const doc = make();
    const ids = doc.nodes[doc.pages[0]].children!;
    setEngine('export', 'ts');
    const ts = time(() => exportSvg(doc, ids, {measurer: testMeasurer}));
    setEngine('export', 'wasm');
    const json = time(() => exportSvg(doc, ids, {measurer: testMeasurer}));
    // As the editor keeps it: a store's document, the shadow following it (shadowIsAt trusts only those).
    const store = createDesignStore({doc, measurer: testMeasurer});
    followStore(store, {force: true});
    const held = store.getState().doc;
    shadowFor(held);
    const before = exportTransfers.frames;
    const frame = time(() => exportSvg(held, ids, {measurer: testMeasurer}));
    if (exportTransfers.frames === before) throw new Error('the frame path did not run');
    setEngine('export', null);
    say(`| ${name} | ${Object.keys(doc.nodes).length} | ${ms(ts)} | ${ms(json)} | ${ms(frame)} | ${(ts / frame).toFixed(2)}× |`);
  }
}

if (only.includes('pdf')) {
  say('');
  say('| PDF (wasm engine) | pages | layers | time | bytes |');
  say('|---|---|---|---|---|');
  const frames: {name: string; doc: DesignDocument; id: NodeId; layers: number}[] = [];
  for (const template of DESIGN_TEMPLATES) {
    if (template.id === 'blank') continue;
    const doc = template.build({measurer: testMeasurer});
    exportModuleFor(doc);
    const ids = doc.pages.flatMap(page => readingOrder(doc, doc.nodes[page].children ?? []));
    let out = pdfOf(doc, ids);
    const t = time(() => (out = pdfOf(doc, ids)));
    say(`| template ${template.id} | ${out.stats.pages} | ${ids.reduce((s, id) => s + layers(doc, id), 0)} | ${ms(t)} | ${out.pdf.length} |`);
    for (const id of ids) frames.push({name: template.id, doc, id, layers: layers(doc, id)});
  }
  const product = productFile();
  exportModuleFor(product);
  for (const id of product.nodes[product.pages[0]].children!) frames.push({name: 'productFile', doc: product, id, layers: layers(product, id)});
  frames.sort((a, b) => b.layers - a.layers);
  for (const frame of frames.slice(0, 10)) {
    let out = pdfOf(frame.doc, [frame.id]);
    const t = time(() => (out = pdfOf(frame.doc, [frame.id])));
    say(`| largest frame: ${frame.name} ${frame.doc.nodes[frame.id].name} | 1 | ${frame.layers} | ${ms(t)} | ${out.pdf.length} |`);
  }
}

if (only.includes('x4')) {
  say('');
  say('| X4-like 50-page PDF | pages | layers | time | bytes | rasters | raster MP |');
  say('|---|---|---|---|---|---|---|');
  const {assets, bytes} = await pictures(6);
  const product = productFile(assets);
  exportModuleFor(product);
  const productFrames = product.pages.flatMap(page => readingOrder(product, product.nodes[page].children ?? [])).slice(0, 50);
  const page = generate({kind: 'page', layers: 50 * 501, seed: 7});
  exportModuleFor(page);
  const pageFrames = readingOrder(page, page.nodes[page.pages[0]].children ?? []).slice(0, 50);
  for (const [name, doc, ids] of [['productFile (pictures, shadows, blurs)', product, productFrames], ['page generator, 50 screens of 501', page, pageFrames]] as const) {
    let out = pdfOf(doc, ids, bytes);
    const t = time(() => (out = pdfOf(doc, ids, bytes)));
    say(`| ${name} | ${out.stats.pages} | ${ids.reduce((s, id) => s + layers(doc, id), 0)} | ${ms(t)} | ${out.pdf.length} | ${out.stats.rasters} | ${(out.stats.rasterPixels / 1e6).toFixed(1)} |`);
  }
}

fs.mkdirSync('output/L5', {recursive: true});
fs.writeFileSync('output/L5/bench.md', lines.join('\n') + '\n');
