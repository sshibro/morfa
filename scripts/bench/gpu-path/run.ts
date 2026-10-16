// The GPU path's editor-side frame cost (lane K, for lane L4's renderer in the editor): pans of a generated page with
// frame titles on, through the GPU scene renderer on a stub GPU and through Canvas2D, in Chromium; prints per-frame
// p50/p95 of the whole render call and of each phase the renderers report (`RenderStats.phases`).
//
//   npx tsx scripts/bench/gpu-path/run.ts [--layers 100000] [--frames 240] [--throttle 2] [--profile]
//   npx tsx scripts/bench/gpu-path/run.ts --sprites      sprites on a reused canvas against a new one, byte for byte
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {startExactServer} from '../../canvas-exact/run';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const value = (flag: string, fallback: number) => (argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : fallback);
const layers = value('--layers', 100_000), frames = value('--frames', 240);
const throttle = value('--throttle', 1);
const server = await startExactServer(null);
const browser = await chromium.launch({executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined});
try {
  if (argv.includes('--sprites')) {
    const page = await browser.newPage();
    await page.addInitScript({content: 'globalThis.__name = (fn) => fn;'});
    await page.goto(`${server.url}/scripts/bench/gpu-path/harness.html`);
    await page.locator('#out[data-state="ready"]').waitFor({timeout: 120_000});
    const check = await page.evaluate(() => window.gpuPath.spriteCheck());
    console.log(`sprites on a reused canvas vs a new one: ${check.sprites} compared, ${check.differing.length} differ ${check.differing.slice(0, 10).join(' ')}`);
    if (check.differing.length) process.exitCode = 1;
  }
  for (const engine of argv.includes('--sprites') ? [] : ['gpu', 'canvas2d'] as const) {
    const page = await browser.newPage({viewport: {width: 1500, height: 1000}});
    await page.addInitScript({content: 'globalThis.__name = (fn) => fn;'});
    if (throttle !== 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', {rate: throttle});
    page.on('pageerror', error => console.error(`page error: ${error.message}`));
    await page.goto(`${server.url}/scripts/bench/gpu-path/harness.html`);
    await page.locator('#out[data-state="ready"]').waitFor({timeout: 120_000});
    const cdp = argv.includes('--profile') && engine === 'gpu' ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', {interval: 100});
      await cdp.send('Profiler.start');
    }
    const run = await page.evaluate(({engine, layers, frames}) => window.gpuPath.pan(engine, layers, frames), {engine, layers, frames});
    if (cdp) {
      const {profile} = (await cdp.send('Profiler.stop')) as {profile: unknown};
      const file = path.join(ROOT_DIR, 'output/bench', `gpu-path-${Date.now()}.cpuprofile`);
      mkdirSync(path.dirname(file), {recursive: true});
      writeFileSync(file, JSON.stringify(profile));
      console.log(`profile: ${path.relative(ROOT_DIR, file)}`);
    }
    const q = (values: number[], p: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
    };
    const line = (name: string, values: number[]) => `${name.padEnd(8)} p50 ${q(values, 0.5).toFixed(2).padStart(6)}  p95 ${q(values, 0.95).toFixed(2).padStart(6)}  p99 ${q(values, 0.99).toFixed(2).padStart(6)}  max ${Math.max(...values).toFixed(1).padStart(6)} ms`;
    console.log(`\n${engine}, ${layers} layers, ${run.total.length} frames, throttle ${throttle}×`);
    console.log(line('render', run.total));
    for (const phase of ['sync', 'raster', 'sprites', 'frame', 'titles']) {
      const values = run.phases.map(p => p[phase]).filter(v => v !== undefined);
      if (values.length) console.log(line(phase, values));
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
