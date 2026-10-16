// Lane S2's bench: the engine switch's overhead, the shadow document's upkeep on the 20 041-layer page, and the proof
// module per call in ts and wasm (scripts/bench/engine-core.ts says what each row is). Needs scripts/wasm-build.sh.
//
//   npx tsx scripts/bench/engine.ts            Node (run with node --expose-gc for the heap row)
//   npx tsx scripts/bench/engine.ts --chrome   headless Chromium through a bare Vite server (the web build)
//   ... --core <name>                           another lane's scripts/bench/<name>-core.ts (exports `bench(options)`)
//   ... --json                                  rows as JSON
//   ... --chrome --throttle 2                   Chromium's CPU slowed down 2× (DevTools' throttling: the laptop stand-in)
//   ... --only <text> --commits <n> --rounds <n> a lane core's subset and sample sizes (modules-core)
//
// Chromium comes from Playwright's browser cache (PLAYWRIGHT_BROWSERS_PATH); MORFA_SMOKE_CHROMIUM names another one.
import {fileURLToPath} from 'node:url';
import {formatRows, type EngineBenchOptions, type Row} from './engine-core';

const args = process.argv.slice(2);
const json = args.includes('--json');
const core = args.includes('--core') ? args[args.indexOf('--core') + 1] : 'engine';
if (!/^[\w-]+$/.test(core)) throw new Error(`--core: '${core}' is not a bench name`);

/** Cross-origin isolation: Chromium's performance.now() then ticks in 5 µs instead of 100 µs (sub-millisecond rows). */
const ISOLATED = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'};

async function inChrome(): Promise<Row[]> {
  const [{chromium}, {createServer}] = await Promise.all([import('playwright-core'), import('vite')]);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const server = await createServer({root, configFile: false, appType: 'mpa', logLevel: 'warn', clearScreen: false, server: {host: '127.0.0.1', port: 5498, strictPort: false, headers: ISOLATED}});
  const browser = await chromium.launch({executablePath: process.env.MORFA_SMOKE_CHROMIUM || undefined, args: [`--js-flags=--expose-gc ${process.env.MORFA_BENCH_JS_FLAGS ?? ''}`.trim(), '--enable-precise-memory-info']});
  try {
    await server.listen();
    const page = await browser.newPage();
    const throttle = args.includes('--throttle') ? Number(args[args.indexOf('--throttle') + 1]) : 1;
    if (throttle > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', {rate: throttle});
    page.on('pageerror', error => console.error(`page error: ${error.message}`));
    const extra = ['only', 'commits', 'rounds'].filter(name => args.includes(`--${name}`)).map(name => `&${name}=${encodeURIComponent(args[args.indexOf(`--${name}`) + 1])}`).join('');
    await page.goto(new URL(`/scripts/bench/engine.html?core=${core}${extra}`, server.resolvedUrls!.local[0]).href);
    await page.waitForFunction(() => (window as unknown as {__bench?: unknown}).__bench, null, {timeout: 600_000});
    const result = (await page.evaluate(() => (window as unknown as {__bench: {rows?: Row[]; error?: string}}).__bench)) as {rows?: Row[]; error?: string};
    if (result.error) throw new Error(result.error);
    console.error(`chrome: ${browser.version()}`);
    return result.rows!;
  } finally {
    await browser.close();
    await server.close();
  }
}

const gc = (globalThis as {gc?: () => void}).gc;
const {bench} = (await import(`./${core}-core.ts`)) as {bench: (options: EngineBenchOptions) => Row[]};
const option = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const rows = args.includes('--chrome')
  ? await inChrome()
  : bench({heapUsed: () => process.memoryUsage().heapUsed, gc, only: option('only'), commits: option('commits') ? Number(option('commits')) : undefined, rounds: option('rounds') ? Number(option('rounds')) : undefined} as EngineBenchOptions);
if (json) console.log(JSON.stringify(rows, null, 1));
else
  console.log(
    formatRows(
      rows,
      args.includes('--chrome')
        ? `chrome (headless${args.includes('--throttle') ? `, CPU ×${args[args.indexOf('--throttle') + 1]} slower` : ''}): ${core}`
        : `${core}: node ${process.version}${gc ? '' : ' (no --expose-gc: heap rows approximate)'}`,
    ),
  );
