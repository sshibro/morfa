// The GPU renderer's own frame timing (TARGETS C1–C4 and C11 from the renderer's side): drives
// gpu-harness.ts `benchScene` in a browser with WebGPU over generated pages of 20 041 (f20k), 100 000 (f100k) and
// 500 000 (f500k) layers — the real scene renderer (tiles, atlas, hole filling) panning at 25 % and pinching 1× → 4× → 1×,
// without the editor's React, store or input path around it. canvas.ts measures the whole editor; this gives the
// renderer's ceiling and the only number f500k has while the TS editor cannot load it (C3/C11 n.a. in canvas.ts).
//
//   npx tsx scripts/goldens/gpu-bench.ts                                   f20k, f100k, f500k; pan and zoom; 10 s each
//   npx tsx scripts/goldens/gpu-bench.ts --layers 20041,100000 --ms 5000 --modes pan
//   MORFA_GPU_SWIFTSHADER=1 npx tsx scripts/goldens/gpu-bench.ts --layers 2004 --ms 2000   (the cloud: a smoke run only)
//
// Needs the web build (scripts/wasm-render-build.sh). Chromium: Playwright's new headless mode with the WebGPU flags of
// gpu.ts (the real GPU on the Mac; MORFA_GOLDENS_CHROMIUM names another executable). Writes
// output/l4-gpu/gpu-bench-<time>.json (every row `provisional` unless MORFA_BENCH_CLOSING=1 names a quiet reference
// machine, with the load average beside it) and prints the rows against docs/TARGETS.md §1.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import type {BenchFrames} from './gpu-harness';
import {startHarnessServer} from './render';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FLAGS = ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
const SWIFTSHADER = ['--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'];

type Args = {layers: number[]; modes: ('pan' | 'zoom')[]; dpr: number; size: {width: number; height: number}; ms: number; out: string};
function parseArgs(argv: string[]): Args {
  const args: Args = {layers: [20_041, 100_000, 500_000], modes: ['pan', 'zoom'], dpr: 2, size: {width: 1440, height: 900}, ms: 10_000, out: path.join(repo, 'output', 'l4-gpu')};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--layers') args.layers = value().split(',').map(Number);
    else if (flag === '--modes') args.modes = value().split(',') as ('pan' | 'zoom')[];
    else if (flag === '--dpr') args.dpr = Number(value());
    else if (flag === '--ms') args.ms = Number(value());
    else if (flag === '--size') {
      const [w, h] = value().split('x').map(Number);
      args.size = {width: w, height: h};
    } else if (flag === '--out') args.out = path.resolve(value());
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

/** The TARGETS row a measurement answers (renderer side): C1 pan f20k, C2 pan f100k, C3 pan f500k, C4 zoom f100k, C11 memory f500k. */
function rowOf(layers: number, mode: string): string {
  if (mode === 'pan' && layers === 20_041) return 'C1';
  if (mode === 'pan' && layers === 100_000) return 'C2';
  if (mode === 'pan' && layers === 500_000) return 'C3 (+ C11 memory)';
  if (mode === 'zoom' && layers === 100_000) return 'C4';
  return '—';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(repo, 'src', 'design', 'wasm-render', 'morfa_render_wasm.js'))) throw new Error('src/design/wasm-render is missing: run scripts/wasm-render-build.sh');
  const server = await startHarnessServer();
  const executablePath = process.env.MORFA_GOLDENS_CHROMIUM || undefined;
  const software = !!process.env.MORFA_GPU_SWIFTSHADER;
  const browser = await chromium.launch({executablePath, channel: executablePath ? undefined : 'chromium', headless: true, args: [...FLAGS, ...(software ? SWIFTSHADER : [])]});
  const problems: string[] = [];
  const rows: (BenchFrames & {row: string})[] = [];
  let adapter = '';
  try {
    const page = await browser.newPage({viewport: args.size, deviceScaleFactor: args.dpr});
    page.on('pageerror', error => problems.push(`page error: ${error.stack ?? error.message}`));
    page.on('console', message => message.type() === 'error' && problems.push(`console error: ${message.text()}`));
    await page.goto(`${server.url}/scripts/goldens/gpu-harness.html`);
    await page.locator('#out[data-state="ready"]').waitFor({timeout: 30_000});
    adapter = await page.evaluate(() => window.gpuHarness.ready());
    console.log(`gpu: ${adapter} (${browser.browserType().name()} ${browser.version()}); ${args.size.width}×${args.size.height} at DPR ${args.dpr}; load ${os.loadavg().map(l => l.toFixed(1)).join(' ')}${software ? '; software adapter: off-screen frames, one tile a frame — plumbing only' : ''}`);
    console.log(['row', 'layers', 'mode', 'build ms', 'sync ms', 'first paint ms', 'complete ms', 'frames', 'fps', 'p95 ms', 'p99 ms', 'longest ms', 'work p95 ms', 'tiles', 'atlas MB', 'JS heap MB'].join('\t'));
    for (const layers of args.layers) {
      for (const mode of args.modes) {
        const result: BenchFrames = await page.evaluate(({layers, mode, dpr, size, ms, slow}) => window.gpuHarness.benchScene(layers, mode, dpr, size, ms, slow), {layers, mode, dpr: args.dpr, size: args.size, ms: args.ms, slow: software});
        const row = rowOf(layers, mode);
        rows.push({...result, row});
        console.log([row, layers, mode, result.buildMs.toFixed(0), result.syncMs.toFixed(0), result.firstPaintMs.toFixed(0), result.completeMs.toFixed(0), result.frames, result.fps.toFixed(1), result.p95.toFixed(1), result.p99.toFixed(1), result.longest.toFixed(0), result.workP95.toFixed(1), result.tiles, (result.atlasBytes / 2 ** 20).toFixed(0), result.jsHeapMb === null ? '—' : result.jsHeapMb.toFixed(0)].join('\t'));
      }
    }
  } finally {
    await browser.close();
    await server.close();
    for (const problem of problems) console.error(`gpu-bench: ${problem}`);
  }
  fs.mkdirSync(args.out, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(args.out, `gpu-bench-${stamp}.json`);
  const provisional = !process.env.MORFA_BENCH_CLOSING || software;
  fs.writeFileSync(file, JSON.stringify({generated: new Date().toISOString(), adapter, software, browser: `${browser.browserType().name()} ${browser.version()}`, host: `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} cores`, loadavg: os.loadavg(), provisional, args, rows}, null, 2) + '\n');
  console.log(`${provisional ? 'provisional' : 'closing'} numbers written to ${path.relative(repo, file)}`);
  if (problems.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
