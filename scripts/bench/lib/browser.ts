// The laptop stand-in for the canvas and edit benches (docs/TARGETS.md §0): Playwright's Chromium (new headless) on this Mac at
// 1440×900 CSS px, DPR 2, CPU throttled 2× through CDP; the built app (dist/app) served by the bench server on the same origin
// with COOP/COEP. Only one browser bench runs on the Mac at a time: ~/.cache/morfa-e2e.lock.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {chromium, type Browser, type BrowserContext, type CDPSession, type Page} from 'playwright-core';
import {accounts, api, bench, cookieOf, type Account} from './fixtures';
import {sleep} from './machine';
import {startServer, type BenchServer} from './server';
import {ROOT} from './targets';

export const LOCK = path.join(homedir(), '.cache/morfa-e2e.lock');
export const CPU_THROTTLE = Number(process.env.BENCH_CPU_THROTTLE || 2);
export const VIEWPORT = {width: 1440, height: 900};
export const APP_PORT = Number(process.env.BENCH_APP_PORT || 5410);

/** Takes the Mac's one browser-bench slot; waits while another live process holds it (a dead holder's lock is taken over). */
export async function takeBrowserLock(owner: string, log: (line: string) => void, waitMs = 45 * 60_000): Promise<() => void> {
  mkdirSync(path.dirname(LOCK), {recursive: true});
  const deadline = Date.now() + waitMs;
  for (let announced = false; ; ) {
    try {
      writeFileSync(LOCK, JSON.stringify({pid: process.pid, owner, since: new Date().toISOString()}), {flag: 'wx'});
      const release = () => {
        try {
          const held = JSON.parse(readFileSync(LOCK, 'utf8')) as {pid: number};
          if (held.pid === process.pid) rmSync(LOCK);
        } catch {
          // Already gone.
        }
      };
      process.once('exit', release);
      return release;
    } catch {
      let holder: {pid?: number; owner?: string} = {};
      try {
        holder = JSON.parse(readFileSync(LOCK, 'utf8'));
      } catch {
        // Being written: try again.
      }
      let alive = false;
      try {
        if (holder.pid) process.kill(holder.pid, 0);
        alive = !!holder.pid;
      } catch {
        alive = false;
      }
      if (!alive && holder.pid) {
        log(`browser lock: holder pid ${holder.pid} (${holder.owner}) is gone; taking the lock`);
        rmSync(LOCK, {force: true});
        continue;
      }
      if (Date.now() > deadline) throw Error(`browser lock ${LOCK} held by ${JSON.stringify(holder)} for too long`);
      if (!announced) {
        log(`browser lock held by ${JSON.stringify(holder)}; waiting`);
        announced = true;
      }
      await sleep(10_000);
    }
  }
}

/** dist/app with the bench hook (src/design/editor/bench-hook.ts), built when missing or older than src/. */
export function ensureAppBuild(log: (line: string) => void): string {
  const dir = path.join(ROOT, 'dist/app');
  const index = path.join(dir, 'index.html');
  const built = existsSync(index) ? statSync(index).mtimeMs : 0;
  const newest = Number(execFileSync('sh', ['-c', `find '${path.join(ROOT, 'src')}' '${path.join(ROOT, 'shared')}' -type f -newer '${index}' 2>/dev/null | head -1 | wc -l`], {encoding: 'utf8'}).trim());
  if (!built || newest > 0) {
    log('building the app (npm run build:app)');
    execFileSync('npm', ['run', 'build:app'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  }
  if (!existsSync(path.join(ROOT, 'public/fonts'))) execFileSync('npm', ['run', 'fonts'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  return dir;
}

export type Stand = {server: BenchServer; browser: Browser; account: Account; gpu: string; close(): Promise<void>};

/** BENCH_APP_DIR serves another build (profile.ts: an unminified one, so the profiles name the functions). */
export async function openStand(log: (line: string) => void): Promise<Stand> {
  const appDir = process.env.BENCH_APP_DIR ? path.resolve(ROOT, process.env.BENCH_APP_DIR) : ensureAppBuild(log);
  const server = await startServer({target: 'local', port: APP_PORT, appDir, log});
  try {
    const [account] = await accounts(server, 1, 'canvas');
    const browser = await chromium.launch({
      // PLAYWRIGHT_CHROMIUM: another Chromium when Playwright's own build is missing (as in playwright.config.ts).
      ...(process.env.PLAYWRIGHT_CHROMIUM ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM} : {channel: 'chromium'}),
      headless: true,
      // BENCH_GPU_PATH=1 on a machine without a GPU: SwiftShader behind ANGLE for compositing and 2D canvas too, so Chromium takes
      // the code path a real GPU takes (its work runs in the GPU process) rather than software compositing, whose per-commit
      // copy of every canvas would swamp what is measured.
      ...(process.env.BENCH_GPU_PATH === '1' ? {ignoreDefaultArgs: ['--use-angle=swiftshader-webgl']} : {}),
      // WebGPU for the GPU renderer (BENCH_ENGINE=wasm): the new headless mode on the Mac runs it on the real GPU
      // with these flags; Canvas2D runs ignore them.
      args: [
        '--enable-blink-features=ForceEagerMeasureMemory', '--js-flags=--expose-gc', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist',
        ...(process.env.BENCH_GPU_PATH === '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
      ],
    });
    const probe = await browser.newPage();
    const gpu = await probe.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no WebGL';
    }).catch(() => 'unknown');
    await probe.close();
    return {
      server, browser, account, gpu,
      async close() {
        await browser.close().catch(() => {});
        await server.stop();
      },
    };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

/** A file to open: a placeholder made through the API, its document the bench file `fixture` (scripts/bench/server.ts override). */
export async function benchFile(stand: Stand, fixture: string, kind: 'design' | 'board' = 'design'): Promise<string> {
  const answer = await api(stand.server, stand.account, 'POST', '/api/design-files', {name: fixture, ...(kind === 'board' ? {kind} : {})});
  if (answer.status !== 201) throw Error(`placeholder: ${answer.status} ${answer.text.slice(0, 200)}`);
  const id = (JSON.parse(answer.text) as {file: {id: string}}).file.id;
  await bench(stand.server, 'override', {fileId: id, fixture});
  return id;
}

export type Tab = {context: BrowserContext; page: Page; cdp: CDPSession};

export async function newTab(stand: Stand, options: {throttle?: number; network?: {downloadMbps: number; latencyMs: number}} = {}): Promise<Tab> {
  const context = await stand.browser.newContext({viewport: VIEWPORT, deviceScaleFactor: 2, locale: 'ru-RU'});
  await context.addCookies([{name: 'forma_session', value: stand.account.token, url: stand.server.base, httpOnly: true, sameSite: 'Lax'}]);
  // tsx compiles with keepNames: functions defined inside page.evaluate callbacks call esbuild's __name helper, which the page lacks.
  await context.addInitScript({content: 'globalThis.__name = (fn) => fn;'});
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: options.throttle ?? CPU_THROTTLE});
  if (options.network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: options.network.latencyMs, downloadThroughput: (options.network.downloadMbps * 1e6) / 8, uploadThroughput: (options.network.downloadMbps * 1e6) / 8 / 5});
  }
  return {context, page, cdp};
}

export type Opened = {firstPaint: number; interactive: number; documentLoaded: number; editorReady: number};

/** Opens `#design/<id>?bench=1` and waits for the first scene paint; the times are from navigation start (ms). */
export async function openFile(tab: Tab, stand: Stand, fileId: string, _kind: 'design' | 'board' = 'design', timeoutMs = 180_000): Promise<Opened> {
  const started = Date.now();
  // Boards open through the same route; the file's kind picks the editor.
  // BENCH_ENGINE=ts|wasm|both rides along as `?engine=` for the engine switch (S2); main has the TS engine only.
  const engine = process.env.BENCH_ENGINE ? `&engine=${encodeURIComponent(process.env.BENCH_ENGINE)}` : '';
  // BENCH_TABLE=copy|in-place rides along as `?table=` (lane N1 step 14): how the store gets its node table per commit.
  const table = process.env.BENCH_TABLE ? `&table=${encodeURIComponent(process.env.BENCH_TABLE)}` : '';
  await tab.page.goto(`${stand.server.base}/?bench=1${engine}${table}#design/${fileId}`, {waitUntil: 'commit'});
  try {
    await tab.page.waitForFunction(() => performance.getEntriesByName('morfa:first-paint').length > 0 && !!(window as unknown as {__morfaBench?: unknown}).__morfaBench, undefined, {timeout: timeoutMs, polling: 100});
  } catch (error) {
    const state = await tab.page.evaluate(() => ({marks: performance.getEntriesByType('mark').map(m => m.name), text: document.body.innerText.slice(0, 300), resources: performance.getEntriesByType('resource').filter(r => r.name.includes('/api/design-files/')).map(r => `${r.name.split('/api/')[1]} ${(r as PerformanceResourceTiming).responseEnd.toFixed(0)}`)})).catch(() => null);
    throw Error(`the file did not open in ${((Date.now() - started) / 1000).toFixed(0)} s: ${JSON.stringify(state)}`);
  }
  // Interactive: the first moment after the first paint when a task queued on the main thread runs within 50 ms.
  return tab.page.evaluate(async id => {
    const paint = performance.getEntriesByName('morfa:first-paint')[0].startTime;
    let interactive = NaN;
    for (let i = 0; i < 600 && Number.isNaN(interactive); i++) {
      const queued = performance.now();
      await new Promise(resolve => setTimeout(resolve, 0));
      if (performance.now() - queued < 50) interactive = queued;
    }
    const resource = performance.getEntriesByType('resource').find(entry => entry.name.endsWith(`/api/design-files/${id}`)) as PerformanceResourceTiming | undefined;
    const ready = performance.getEntriesByName('morfa:editor-ready')[0]?.startTime ?? NaN;
    return {firstPaint: paint, interactive: Math.max(paint, interactive), documentLoaded: resource?.responseEnd ?? NaN, editorReady: ready};
  }, fileId);
}

/** Waits until the editor's frames are idle (two quiet frames in a row), up to `ms`. */
export async function settle(tab: Tab, ms = 15_000) {
  await tab.page.evaluate(async limit => {
    const end = performance.now() + limit;
    let quiet = 0, last = performance.now();
    while (performance.now() < end && quiet < 10) {
      const now = await new Promise<number>(resolve => requestAnimationFrame(resolve));
      quiet = now - last < 20 ? quiet + 1 : 0;
      last = now;
    }
  }, ms);
}

export {cookieOf};
