// Browser smoke for the web build of crates/wasm (docs/dev.md §Rust). Plain JavaScript on
// purpose: the smoke adds no TypeScript.
//
// Serves the repository with a bare Vite dev server (configFile: false, so vite.config.ts is not loaded), opens
// scripts/wasm-smoke.html in Playwright's Chromium and checks that the page prints `morfa-wasm <version>`, the
// version in src/design/wasm/package.json. Run scripts/wasm-build.sh first.
//
//   node scripts/wasm-smoke.mjs
//
// Chromium comes from Playwright's browser cache (PLAYWRIGHT_BROWSERS_PATH when set); MORFA_SMOKE_CHROMIUM names
// another Chromium executable. The dev server listens on 127.0.0.1:5499 or the next free port.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
let expected;
try {
  expected = `morfa-wasm ${JSON.parse(readFileSync(new URL('../src/design/wasm/package.json', import.meta.url), 'utf8')).version}`;
} catch (error) {
  console.error(`wasm-smoke: no web build (${error.message}); run scripts/wasm-build.sh first`);
  process.exit(1);
}

const server = await createServer({
  root,
  configFile: false,
  appType: 'mpa', // a missing file is a 404, not index.html
  logLevel: 'warn',
  clearScreen: false,
  optimizeDeps: {noDiscovery: true, include: []},
  server: {host: '127.0.0.1', port: 5499, strictPort: false},
});
let browser;
try {
  await server.listen();
  const url = new URL('/scripts/wasm-smoke.html', server.resolvedUrls.local[0]).href;
  browser = await chromium.launch({executablePath: process.env.MORFA_SMOKE_CHROMIUM || undefined});
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  // Warnings count too: wasm-bindgen warns when the .wasm is served without the application/wasm MIME type.
  page.on(
    'console',
    message =>
      ['error', 'warning'].includes(message.type()) && problems.push(`console ${message.type()}: ${message.text()}`),
  );
  page.on('requestfailed', request => problems.push(`request failed: ${request.url()}`));
  page.on(
    'response',
    response => response.status() >= 400 && problems.push(`HTTP ${response.status()}: ${response.url()}`),
  );
  await page.goto(url);
  const out = page.locator('#out[data-state]');
  await out.waitFor({timeout: 15_000});
  const [state, text] = [await out.getAttribute('data-state'), await out.textContent()];
  console.log(`wasm-smoke: ${url} → "${text}" (${browser.browserType().name()} ${browser.version()})`);
  for (const problem of problems) console.error(`wasm-smoke: ${problem}`);
  if (state !== 'ok' || text !== expected) throw new Error(`expected "${expected}", got "${text}" (state ${state})`);
  if (problems.length) throw new Error(`the page reported ${problems.length} problem(s), listed above`);
  console.log('wasm-smoke: ok');
} catch (error) {
  console.error(`wasm-smoke: FAILED: ${error.message}`);
  if (/Executable doesn't exist/.test(error.message))
    console.error(
      'wasm-smoke: point MORFA_SMOKE_CHROMIUM at a Chromium executable, or install the browser named above',
    );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
