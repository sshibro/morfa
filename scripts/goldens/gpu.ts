// The GPU renderer against the goldens, in a browser with WebGPU: drives gpu-harness.html
// (the editor's GPU path — the renderer's document shadow, pictures, Canvas2D text sprites, 512 px tiles rasterized
// by vello and read back) over the fixtures at DPR 1 / 1.5 / 2 and scores every picture with scripts/goldens/ssim.ts;
// then the seam check: one frame of the real scene renderer at zoom 37 / 66 / 133 / 150 % and DPR 1.25 / 1.5 / 2,
// screenshot by Playwright, with the tile boundary columns measured for a line of background showing through.
//
//   npx tsx scripts/goldens/gpu.ts                           goldens (every fixture) and seams
//   npx tsx scripts/goldens/gpu.ts --only effects --dpr 2 --no-seams
//   npx tsx scripts/goldens/gpu.ts --seams-only --out output/L4
//
// Needs the web build (scripts/wasm-render-build.sh) and the goldens (scripts/goldens/render.ts). Chromium: Playwright's
// new headless mode with WebGPU flags; MORFA_GOLDENS_CHROMIUM names an executable (the cloud image's, where WebGPU
// runs on SwiftShader; on the Mac the real GPU). Writes output/L4/gpu/<fixture>/<page>@<dpr>.png and
// output/L4/seams/<zoom>@<dpr>.png. Exit 1 when a golden is under its bar or a seam shows.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import sharp from 'sharp';
import type {GoldenMeta} from './harness';
import type {GpuGoldenResult} from './gpu-harness';
import {startHarnessServer, writeEffectsPhoto} from './render';
import {compareFiles, DEFAULT_BARS, judge, type SsimReport} from './ssim';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDENS_DIR = path.join(repo, 'fixtures', 'goldens');
const FLAGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist'];
// Software WebGPU in the cloud; its GPU process compiles and runs our compute on its main thread, so the watchdog is off.
const SWIFTSHADER = ['--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'];

type Args = {only?: string; dprs: number[]; out: string; seams: boolean; goldens: boolean; maxSide: number; sprites: boolean};
function parseArgs(argv: string[]): Args {
  const args: Args = {dprs: [1, 1.5, 2], out: path.join(repo, 'output', 'L4'), seams: true, goldens: true, maxSide: 4096, sprites: true};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--only') args.only = value();
    else if (flag === '--dpr') args.dprs = value().split(',').map(Number);
    else if (flag === '--out') args.out = path.resolve(value());
    else if (flag === '--max-side') args.maxSide = Number(value());
    else if (flag === '--no-seams') args.seams = false;
    else if (flag === '--no-sprites') args.sprites = false; // debugging: the picture without text
    else if (flag === '--seams-only') args.goldens = false;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

export type GpuRow = {fixture: string; page: string; dpr: number; width: number; height: number; tiles: number; tileMs: number; sprites: number; report: SsimReport; ok: boolean; failures: string[]};
export type SeamRow = {zoom: number; dpr: number; file: string; boundaries: number; seamColumns: number; worst: number; frames: number};

/** A seam is a tile boundary column where the background shows through between two drawn columns: the share of rows
 *  along the column whose pixel is the background while both neighbours are not. */
async function seamScore(file: string, columns: number[], background: [number, number, number]): Promise<{seamColumns: number; worst: number}> {
  const {data, info} = await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]] as [number, number, number];
  };
  const isBg = (c: [number, number, number]) => Math.abs(c[0] - background[0]) < 4 && Math.abs(c[1] - background[1]) < 4 && Math.abs(c[2] - background[2]) < 4;
  let seamColumns = 0, worst = 0;
  for (const x of columns) {
    if (x < 1 || x >= info.width - 1) continue;
    let seam = 0, drawn = 0;
    for (let y = 0; y < info.height; y++) {
      const left = px(x - 1, y), here = px(x, y), right = px(x + 1, y);
      if (isBg(left) || isBg(right)) continue;
      drawn++;
      if (isBg(here)) seam++;
    }
    const share = drawn ? seam / drawn : 0;
    worst = Math.max(worst, share);
    if (share > 0.02 && drawn > 50) seamColumns++;
  }
  return {seamColumns, worst};
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(repo, 'src', 'design', 'wasm-render', 'morfa_render_wasm.js'))) throw new Error('src/design/wasm-render is missing: run scripts/wasm-render-build.sh');
  await writeEffectsPhoto(path.join(GOLDENS_DIR, 'assets'));
  const server = await startHarnessServer();
  const executablePath = process.env.MORFA_GOLDENS_CHROMIUM || undefined;
  const browser = await chromium.launch({executablePath, channel: executablePath ? undefined : 'chromium', headless: true, args: [...FLAGS, ...(process.env.MORFA_GPU_SWIFTSHADER ? SWIFTSHADER : [])]});
  const problems: string[] = [];
  const rows: GpuRow[] = [];
  const seams: SeamRow[] = [];
  try {
    const page = await browser.newPage({viewport: {width: 1200, height: 800}, deviceScaleFactor: 1});
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    page.on('console', message => message.type() === 'error' && problems.push(`console error: ${message.text()}`));
    page.on('response', response => response.status() >= 400 && problems.push(`${response.status()} ${response.url()}`));
    await page.goto(`${server.url}/scripts/goldens/gpu-harness.html`);
    await page.locator('#out[data-state="ready"]').waitFor({timeout: 30_000});
    const adapter = await page.evaluate(() => window.gpuHarness.ready());
    console.log(`gpu: ${adapter} (${browser.browserType().name()} ${browser.version()})`);
    if (args.goldens) {
      const index = JSON.parse(fs.readFileSync(path.join(GOLDENS_DIR, 'index.json'), 'utf8')) as {goldens: GoldenMeta[]};
      const metas = index.goldens.filter(m => (!args.only || m.fixture.startsWith(args.only)) && args.dprs.includes(m.dpr));
      console.log(['fixture', 'page', 'dpr', 'size', 'tiles', 'tile ms', 'sprites', 'outside', 'effect', 'text', 'verdict'].join('\t'));
      for (const meta of metas) {
        const result: GpuGoldenResult = await page.evaluate(({name, pageId, dpr, maxSide, sprites}) => window.gpuHarness.renderGoldenGpu(name, pageId, dpr, maxSide, {sprites}), {name: meta.fixture, pageId: meta.page, dpr: meta.dpr, maxSide: args.maxSide, sprites: args.sprites});
        const dir = path.join(args.out, 'gpu', meta.fixture);
        fs.mkdirSync(dir, {recursive: true});
        const file = path.join(dir, `${meta.page}@${meta.dpr}.png`);
        fs.writeFileSync(file, Buffer.from(result.png, 'base64'));
        const stem = path.join(GOLDENS_DIR, meta.fixture, `${meta.page}@${meta.dpr}`);
        const report = await compareFiles(`${stem}.png`, file, {text: `${stem}.text.png`, effect: `${stem}.effect.png`});
        const verdict = judge(report, DEFAULT_BARS);
        rows.push({fixture: meta.fixture, page: meta.page, dpr: meta.dpr, width: result.meta.width, height: result.meta.height, tiles: result.tiles, tileMs: result.tileMs, sprites: result.sprites, report, ok: verdict.ok, failures: verdict.failures});
        console.log([meta.fixture, meta.page, meta.dpr, `${result.meta.width}×${result.meta.height}`, result.tiles, (result.tileMs / Math.max(1, result.tiles)).toFixed(1), result.sprites, report.outside.ssim.toFixed(4), report.effect.windows ? report.effect.ssim.toFixed(4) : '—', report.text.windows ? report.text.ssim.toFixed(4) : '—', verdict.ok ? 'ok' : verdict.failures.join('; ')].join('\t'));
      }
    }
    if (args.seams) {
      const dir = path.join(args.out, 'seams');
      fs.mkdirSync(dir, {recursive: true});
      const fixture = 'template-site', pageId = 't1';
      const size = {width: 1200, height: 800};
      console.log(['zoom', 'dpr', 'frames', 'tile boundaries', 'seam columns', 'worst share', 'file'].join('\t'));
      for (const dpr of [1.25, 1.5, 2]) {
        const seamPage = await browser.newPage({viewport: size, deviceScaleFactor: dpr});
        seamPage.on('pageerror', error => problems.push(`page error: ${error.message}`));
        seamPage.on('console', message => message.type() === 'error' && problems.push(`console error: ${message.text()}`));
        await seamPage.goto(`${server.url}/scripts/goldens/gpu-harness.html`);
        await seamPage.locator('#out[data-state="ready"]').waitFor({timeout: 30_000});
        for (const zoom of [0.37, 0.66, 1.33, 1.5]) {
          // A pan: the view moves a fractional number of pixels per frame, then the screenshot.
          let result: {frames: number; stats: unknown; tilePx: number[]; png?: string} = {frames: 0, stats: null, tilePx: []};
          for (let step = 0; step < 3; step++) {
            result = await seamPage.evaluate(({fixture, pageId, zoom, dpr, step, size, slow}) => window.gpuHarness.seamFrame(fixture, pageId, zoom, dpr, 40.37 + step * 3.3, 60.61 + step * 2.7, size, slow), {fixture, pageId, zoom, dpr, step, size, slow: !!process.env.MORFA_GPU_SWIFTSHADER});
          }
          const file = path.join(dir, `${Math.round(zoom * 100)}@${dpr}.png`);
          // The frame as presented (a screenshot), or on the software adapter the off-screen frame the harness read back.
          if (result.png) fs.writeFileSync(file, Buffer.from(result.png, 'base64'));
          else await seamPage.locator('#scene').screenshot({path: file});
          const score = await seamScore(file, result.tilePx, [255, 255, 255]);
          seams.push({zoom, dpr, file: path.relative(repo, file), boundaries: result.tilePx.length, seamColumns: score.seamColumns, worst: score.worst, frames: result.frames});
          console.log([`${Math.round(zoom * 100)} %`, dpr, result.frames, result.tilePx.length, score.seamColumns, score.worst.toFixed(3), path.relative(repo, file)].join('\t'));
        }
        await seamPage.close();
      }
    }
    fs.mkdirSync(args.out, {recursive: true});
    fs.writeFileSync(path.join(args.out, 'gpu-results.json'), JSON.stringify({generated: new Date().toISOString(), adapter, browser: `${browser.browserType().name()} ${browser.version()}`, rows, seams}, null, 2) + '\n');
  } finally {
    await browser.close();
    await server.close();
    for (const problem of problems) console.error(`gpu: ${problem}`);
  }
  const failed = rows.filter(r => !r.ok);
  const seamed = seams.filter(s => s.seamColumns > 0);
  console.log(failed.length ? `below the bar: ${failed.length} of ${rows.length}` : `ok: ${rows.length} of ${rows.length} goldens within the bars`);
  if (seams.length) console.log(seamed.length ? `seams: ${seamed.length} of ${seams.length} frames show a seam column` : `seams: none in ${seams.length} frames`);
  if (failed.length || seamed.length || problems.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
