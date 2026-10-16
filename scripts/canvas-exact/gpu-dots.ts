// The board's dot grid on the GPU path against Canvas2D's (lane K), and a board section with "hide contents" drawn as the
// same section empty on both paths: an empty board page's tiles at 50 / 100 / 200 % and
// 1× / 2×, a few tiles on either side of the origin, with and without a raster margin, on two board colours. Every pixel
// must be equal. Chromium with WebGPU (SwiftShader where MORFA_GPU_SWIFTSHADER is set, as scripts/goldens/gpu.ts).
//
//   npx tsx scripts/canvas-exact/gpu-dots.ts
//
// Needs the web build of the renderer (scripts/wasm-render-build.sh). Exit 1 on any differing pixel.

import {chromium} from 'playwright-core';
import {startHarnessServer} from '../goldens/render';
import type {DotCase, DotResult, HiddenResult} from './gpu-dots-harness';

const FLAGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist'];
const SWIFTSHADER = ['--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'];

const cases: DotCase[] = [];
for (const background of [{r: 245 / 255, g: 245 / 255, b: 245 / 255}, {r: 1, g: 1, b: 1}])
  for (const dpr of [1, 2])
    for (const zoom of [0.5, 1, 2])
      for (const [i, j] of [[0, 0], [-1, 2], [3, -2]])
        for (const margin of [0, 7]) cases.push({zoom, dpr, i, j, margin, background});

const server = await startHarnessServer();
const executablePath = process.env.MORFA_GOLDENS_CHROMIUM || undefined;
const browser = await chromium.launch({executablePath, channel: executablePath ? undefined : 'chromium', headless: true, args: [...FLAGS, ...(process.env.MORFA_GPU_SWIFTSHADER ? SWIFTSHADER : [])]});
let failed = 0;
try {
  const page = await browser.newPage();
  page.on('console', message => message.type() === 'error' && console.error(message.text()));
  await page.addInitScript({content: 'globalThis.__name = (fn) => fn;'});
  await page.goto(`${server.url}/scripts/canvas-exact/gpu-dots.html`);
  await page.waitForFunction(() => document.title.endsWith('ready'), null, {timeout: 120_000});
  const results = await page.evaluate(all => (globalThis as unknown as {compareDots(c: DotCase[]): Promise<DotResult[]>}).compareDots(all), cases);
  for (const r of results) {
    const bg = Math.round(r.background.r * 255);
    const line = `zoom ${r.zoom * 100}% @${r.dpr}× tile (${r.i}, ${r.j}) margin ${r.margin} bg ${bg}: ${r.dots} dots (${r.dotPixels} px), ${r.differing} px differ`;
    // A tile without dots would compare equal for nothing: every case has dots on the Canvas2D side.
    if (r.differing || !r.dotPixels) {
      failed++;
      console.log(`✗ ${line} (max Δ ${r.maxDelta}; first ${r.first})`);
    } else console.log(`✓ ${line}`);
  }
  console.log(failed ? `gpu-dots: ${failed} of ${results.length} tiles differ` : `gpu-dots: all ${results.length} tiles pixel-equal`);
  // Lane G's hidden section: it draws as the same section empty, on both paths (and shown, its layers do draw).
  const hidden = await page.evaluate(() => (globalThis as unknown as {compareHiddenSection(): Promise<HiddenResult[]>}).compareHiddenSection());
  for (const r of hidden) {
    const ok = r.hiddenVsEmpty === 0 && r.shownVsEmpty > 0;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} hidden section, ${r.path}: hidden with layers vs empty ${r.hiddenVsEmpty} px differ; shown vs empty ${r.shownVsEmpty} px differ`);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
