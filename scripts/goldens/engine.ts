// The renderer against the goldens: every fixture page rendered by crates/render-wasm's CPU
// path (vello_cpu, the nodejs build of scripts/wasm-render-build.sh) at DPR 1 / 1.5 / 2 from the same documents, and
// scored by scripts/goldens/ssim.ts against fixtures/goldens (run scripts/goldens/render.ts first). Text is the host's job:
// without a host to paint sprites, the text mask is reported and never judged.
//
//   npx tsx scripts/goldens/engine.ts                       every fixture, DPR 1, 1.5, 2
//   npx tsx scripts/goldens/engine.ts --only effects --dpr 2 --out /tmp/renders
//   npx tsx scripts/goldens/engine.ts --json results.json    the table as JSON too
//   npx tsx scripts/goldens/engine.ts --goldens output/L4/goldens3 --dpr 3    against goldens rendered elsewhere (export parity at scale 3)
//
// Exit 1 when a judged region of any golden is under its bar (outside ≥ 0.995, effect ≥ 0.98).

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import {pageBackground} from '../../shared/design/defaults';
import {renderWasm, type RenderWasmDoc, type RenderCounters} from '../../shared/design/render-engine';
import {FIXTURES} from './fixtures';
import {compareGray, DEFAULT_BARS, judge, readGray, readMask, type SsimReport} from './ssim';
import type {GoldenMeta} from './harness';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GOLDENS_DIR = path.join(repo, 'fixtures', 'goldens');
/** The goldens to score against: fixtures/goldens, or another directory render.ts wrote (`--goldens`, e.g. DPR 3). */
let goldensDir = GOLDENS_DIR;

export type EngineRow = {fixture: string; page: NodeId; dpr: number; width: number; height: number; renderMs: number; counters: RenderCounters; report: SsimReport; ok: boolean; failures: string[]};

/** The pictures the fixtures use, decoded for the renderer (straight-alpha RGBA8). */
async function registerPictures(doc: RenderWasmDoc, document: DesignDocument): Promise<void> {
  for (const [ref, asset] of Object.entries(document.images ?? {})) {
    const file = path.join(repo, asset.url.replace(/^\//, ''));
    if (!fs.existsSync(file)) continue;
    const {data, info} = await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    doc.register_image(ref, info.width, info.height, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
}

/** Renders one golden's page through the CPU path, the golden's own framing (`meta.area`, `meta.dpr`). */
export function renderLikeGolden(doc: RenderWasmDoc, document: DesignDocument, meta: GoldenMeta): {rgba: Uint8Array; width: number; height: number; renderMs: number; counters: RenderCounters} {
  if (!doc.render) throw new Error('engine.ts: this renderer build has no CPU path (the nodejs build has)');
  const page = document.nodes[meta.page];
  const bg = pageBackground(page);
  const started = performance.now();
  const rgba = doc.render(meta.page, meta.area.x, meta.area.y, meta.area.width, meta.area.height, meta.dpr, bg.r, bg.g, bg.b, JSON.stringify({minSize: 0.5, spriteScale: meta.dpr}));
  const renderMs = performance.now() - started;
  const [width, height] = Array.from(doc.last_size());
  return {rgba, width, height, renderMs, counters: JSON.parse(doc.last_counters()) as RenderCounters};
}

/** A renderer document of a fixture, with its pictures. */
export async function renderDocOf(document: DesignDocument): Promise<RenderWasmDoc> {
  const {RenderDoc} = renderWasm();
  const doc = new RenderDoc(JSON.stringify(document));
  await registerPictures(doc, document);
  return doc;
}

/** Scores a render against a golden: the PNG, its text and effect masks. */
export async function scoreAgainstGolden(stem: string, rgba: Uint8Array, width: number, height: number): Promise<SsimReport> {
  const candidate = {width, height, data: new Float32Array(width * height)};
  for (let i = 0, p = 0; i < candidate.data.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const r = rgba[p] * a + 255 * (1 - a), g = rgba[p + 1] * a + 255 * (1 - a), b = rgba[p + 2] * a + 255 * (1 - a);
    candidate.data[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const [golden, text, effect] = await Promise.all([readGray(`${stem}.png`), readMask(`${stem}.text.png`), readMask(`${stem}.effect.png`)]);
  return compareGray(golden, candidate, {text, effect, maskSize: {width: golden.width, height: golden.height}});
}

export function goldenMetas(only?: string, dprs?: number[]): GoldenMeta[] {
  const index = path.join(goldensDir, 'index.json');
  if (!fs.existsSync(index)) return [];
  const {goldens} = JSON.parse(fs.readFileSync(index, 'utf8')) as {goldens: GoldenMeta[]};
  return goldens.filter(m => (!only || m.fixture.startsWith(only)) && (!dprs || dprs.includes(m.dpr)));
}

export async function runEngine(options: {only?: string; dprs?: number[]; out?: string; goldens?: string} = {}): Promise<EngineRow[]> {
  if (options.goldens) goldensDir = options.goldens;
  const metas = goldenMetas(options.only, options.dprs);
  const rows: EngineRow[] = [];
  const docs = new Map<string, {document: DesignDocument; doc: RenderWasmDoc}>();
  try {
    for (const meta of metas) {
      let entry = docs.get(meta.fixture);
      if (!entry) {
        const fixture = FIXTURES.find(f => f.name === meta.fixture);
        if (!fixture) continue;
        const document = fixture.build();
        entry = {document, doc: await renderDocOf(document)};
        docs.set(meta.fixture, entry);
      }
      const {rgba, width, height, renderMs, counters} = renderLikeGolden(entry.doc, entry.document, meta);
      if (options.out) {
        fs.mkdirSync(path.join(options.out, meta.fixture), {recursive: true});
        await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {raw: {width, height, channels: 4}}).png().toFile(path.join(options.out, meta.fixture, `${meta.page}@${meta.dpr}.png`));
      }
      const report = await scoreAgainstGolden(path.join(goldensDir, meta.fixture, `${meta.page}@${meta.dpr}`), rgba, width, height);
      const verdict = judge(report, DEFAULT_BARS);
      rows.push({fixture: meta.fixture, page: meta.page, dpr: meta.dpr, width, height, renderMs, counters, report, ok: verdict.ok, failures: verdict.failures});
    }
  } finally {
    for (const {doc} of docs.values()) doc.free();
  }
  return rows;
}

export function formatRows(rows: EngineRow[]): string {
  const lines = [['fixture', 'page', 'dpr', 'size', 'render ms', 'outside', 'effect', 'text', 'nodes', 'bitmaps', 'verdict'].join('\t')];
  for (const r of rows) {
    lines.push([r.fixture, r.page, r.dpr, `${r.width}×${r.height}`, r.renderMs.toFixed(1), r.report.outside.ssim.toFixed(4), r.report.effect.windows ? r.report.effect.ssim.toFixed(4) : '—', r.report.text.windows ? r.report.text.ssim.toFixed(4) : '—', r.counters.nodes, r.counters.effectBitmaps + r.counters.backdrops, r.ok ? 'ok' : r.failures.join('; ')].join('\t'));
  }
  return lines.join('\n');
}

async function main(argv: string[]): Promise<void> {
  const options: {only?: string; dprs?: number[]; out?: string; json?: string; goldens?: string} = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--only') options.only = value();
    else if (flag === '--dpr') options.dprs = value().split(',').map(Number);
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--json') options.json = path.resolve(value());
    else if (flag === '--goldens') goldensDir = options.goldens = path.resolve(value());
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!goldenMetas().length) throw new Error(`no goldens in ${path.relative(repo, goldensDir)}: run npx tsx scripts/goldens/render.ts first`);
  const started = performance.now();
  const rows = await runEngine(options);
  console.log(`engine: ${renderWasm().version()} (crates/render-wasm, vello_cpu) against ${rows.length} goldens; bars outside ≥ ${DEFAULT_BARS.outside}, effect ≥ ${DEFAULT_BARS.effects}; ${((performance.now() - started) / 1000).toFixed(1)} s`);
  console.log(formatRows(rows));
  if (options.json) fs.writeFileSync(options.json, JSON.stringify({generated: new Date().toISOString(), rows}, null, 2) + '\n');
  const failed = rows.filter(r => !r.ok);
  console.log(failed.length ? `below the bar: ${failed.length} of ${rows.length}` : `ok: ${rows.length} of ${rows.length} goldens within the bars`);
  if (failed.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
