// Writes the golden images: every fixture page of fixtures.ts painted by today's
// Canvas2D `paintNodeTree` in headless Chromium (software rasterization, so the bytes are the same run to run)
// at DPR 1 / 1.5 / 2, to fixtures/goldens/<fixture>/<page>@<dpr>.png, with <page>@<dpr>.text.png and
// <page>@<dpr>.effect.png (white where text is drawn / where shadows and blurs reach) and <page>@<dpr>.json.
// Goldens are build outputs (fixtures/goldens is gitignored); regenerate them from the fixtures.
//
//   npx tsx scripts/goldens/render.ts                 every fixture, DPR 1, 1.5, 2
//   npx tsx scripts/goldens/render.ts --only effects  one fixture (prefix match)
//   npx tsx scripts/goldens/render.ts --dpr 2 --max-side 2048 --out some/dir
//
// Serves the repository with a bare Vite dev server (configFile: false), /fonts from public/fonts (run
// `npx tsx scripts/copy-fonts.ts` first) on 127.0.0.1:5404 or the next free port; Chromium comes from
// Playwright's browser cache, or MORFA_GOLDENS_CHROMIUM names an executable (the cloud image's older build, as
// scripts/wasm-smoke.mjs's MORFA_SMOKE_CHROMIUM does).

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {chromium} from 'playwright-core';
import sharp from 'sharp';
import {createServer} from 'vite';
import type {GoldenMeta, GoldenResult} from './harness';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GOLDENS_DIR = path.join(repo, 'fixtures', 'goldens');
export const DPRS = [1, 1.5, 2];
const DEFAULT_MAX_SIDE = 4096;
const PORT = 5404;

type Args = {only?: string; dprs: number[]; maxSide: number; out: string};
function parseArgs(argv: string[]): Args {
  const args: Args = {dprs: DPRS, maxSide: DEFAULT_MAX_SIDE, out: GOLDENS_DIR};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--only') args.only = value();
    else if (flag === '--dpr') args.dprs = value().split(',').map(Number);
    else if (flag === '--max-side') args.maxSide = Number(value());
    else if (flag === '--out') args.out = path.resolve(value());
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

/** The picture the `effects` fixture shows: a deterministic 400 × 300 PNG (stripes, a disc, a gradient). */
export async function writeEffectsPhoto(dir: string): Promise<string> {
  const width = 400, height = 300;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const inDisc = (x - 260) ** 2 + (y - 120) ** 2 < 80 ** 2;
    const stripe = Math.floor(x / 25) % 2 === 0;
    data[i] = inDisc ? 255 : stripe ? 40 + (y / height) * 120 : 220;
    data[i + 1] = inDisc ? 110 : stripe ? 60 + (x / width) * 160 : 230 - (y / height) * 100;
    data[i + 2] = inDisc ? 90 : stripe ? 200 : 80 + (x / width) * 150;
    data[i + 3] = 255;
  }
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'photo.png');
  await sharp(data, {raw: {width, height, channels: 4}}).png({compressionLevel: 9}).toFile(file);
  return file;
}

export type HarnessServer = {url: string; close(): Promise<void>};

/** The bare Vite server with /fonts; used by render.ts and by the renderer spikes' benches. */
export async function startHarnessServer(port = PORT): Promise<HarnessServer> {
  const fontsDir = path.join(repo, 'public', 'fonts');
  if (!fs.existsSync(fontsDir) || !fs.readdirSync(fontsDir).length) throw new Error('public/fonts is empty: run `npx tsx scripts/copy-fonts.ts` first');
  const server = await createServer({
    root: repo,
    configFile: false,
    appType: 'mpa',
    logLevel: 'warn',
    clearScreen: false,
    cacheDir: path.join(repo, '.vite', 'goldens'),
    optimizeDeps: {noDiscovery: true, include: []},
    server: {host: '127.0.0.1', port, strictPort: false, fs: {allow: [repo, fs.realpathSync(path.join(repo, 'node_modules'))]}},
  });
  // connect's handler type and express's static middleware disagree on `next`; the middleware runs fine.
  server.middlewares.use('/fonts', express.static(fontsDir, {setHeaders: res => res.setHeader('Access-Control-Allow-Origin', '*')}) as never);
  await server.listen();
  return {url: server.resolvedUrls!.local[0].replace(/\/$/, ''), close: () => server.close()};
}

const fileStem = (out: string, meta: GoldenMeta) => path.join(out, meta.fixture, `${meta.page}@${meta.dpr}`);

async function writeResult(out: string, result: GoldenResult): Promise<void> {
  const stem = fileStem(out, result.meta);
  fs.mkdirSync(path.dirname(stem), {recursive: true});
  fs.writeFileSync(`${stem}.png`, Buffer.from(result.png, 'base64'));
  fs.writeFileSync(`${stem}.text.png`, Buffer.from(result.textMask, 'base64'));
  fs.writeFileSync(`${stem}.effect.png`, Buffer.from(result.effectMask, 'base64'));
  fs.writeFileSync(`${stem}.json`, JSON.stringify(result.meta, null, 2) + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await writeEffectsPhoto(path.join(GOLDENS_DIR, 'assets'));
  const server = await startHarnessServer();
  const browser = await chromium.launch({executablePath: process.env.MORFA_GOLDENS_CHROMIUM || undefined});
  const problems: string[] = [];
  try {
    const page = await browser.newPage({viewport: {width: 800, height: 600}, deviceScaleFactor: 1});
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    page.on('console', message => message.type() === 'error' && problems.push(`console error: ${message.text()}`));
    await page.goto(`${server.url}/scripts/goldens/harness.html`);
    await page.locator('#out[data-state="ready"]').waitFor({timeout: 20_000});
    const fixtures = await page.evaluate(() => window.goldens.listFixtures());
    const chosen = fixtures.filter(f => !args.only || f.name.startsWith(args.only));
    if (!chosen.length) throw new Error(`no fixture matches ${args.only}`);
    console.log(`goldens: ${chosen.length} fixtures × ${args.dprs.join('/')} DPR → ${path.relative(repo, args.out)} (${browser.browserType().name()} ${browser.version()})`);
    console.log(['fixture', 'page', 'nodes', 'dpr', 'size', 'text', 'effect', 'paint ms'].join('\t'));
    const index: GoldenMeta[] = [];
    for (const fixture of chosen) {
      for (const pageInfo of fixture.pages) {
        for (const dpr of args.dprs) {
          const result = await page.evaluate(({name, pageId, dpr, maxSide}) => window.goldens.renderGolden(name, pageId, dpr, maxSide), {name: fixture.name, pageId: pageInfo.id, dpr, maxSide: args.maxSide});
          await writeResult(args.out, result);
          const m = result.meta;
          index.push(m);
          console.log([m.fixture, m.page, m.nodes, m.dpr, `${m.width}×${m.height}`, m.textRects, m.effectRects, m.paintMs.toFixed(1)].join('\t'));
        }
      }
    }
    fs.writeFileSync(path.join(args.out, 'index.json'), JSON.stringify({generated: new Date().toISOString(), browser: `${browser.browserType().name()} ${browser.version()}`, goldens: index}, null, 2) + '\n');
  } finally {
    await browser.close();
    await server.close();
    for (const problem of problems) console.error(`goldens: ${problem}`);
  }
  if (problems.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
