// BIG.md stage B (lane W): the open of a big file from its checkpoint, in Chromium on the web build. One page per run:
// `MorfaDoc.decode` of the checkpoint bytes, then every part through `part_json` + shared/design/parts.ts `readPart`,
// the nodes kept in one table as the store would hold them. Prints the wasm memory after the decode, each part's
// write and parse times (median, p95, max) and the JS heap of the whole node table after garbage collection.
//
//   cargo run --release -p morfa-wasm --example checkpoint -- fixtures/bench/f500k.json fixtures/bench/f500k.mrfa
//   npx tsx scripts/bench/parts.ts [--file fixtures/bench/f500k.mrfa] [--throttle 2] [--count 2000] [--plain] [--json]
//
// `--plain`: parts without shared values (each node's own objects, what a JSON parse gives). `--copy`: `decode` (the bytes
// copied into wasm memory first) instead of `decode_from`. Needs scripts/wasm-build.sh.
// Chromium comes from Playwright's browser cache (PLAYWRIGHT_BROWSERS_PATH); MORFA_SMOKE_CHROMIUM names another one.
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const file = path.resolve(ROOT, option('file', 'fixtures/bench/f500k.mrfa'));
const throttle = Number(option('throttle', '1'));
const count = Number(option('count', '2000'));
const shared = !args.includes('--plain');

/** Cross-origin isolation: performance.now() ticks in 5 µs instead of 100 µs. */
const HEADERS = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'};
const ORIGIN = 'http://localhost:4173';

type Result = {
  error?: string;
  nodes: number;
  parts: number;
  bytes: number;
  memoryBeforeMiB: number;
  memoryAfterDecodeMiB: number;
  memoryAfterPartsMiB: number;
  decodeMs: number;
  writeMs: number[];
  parseMs: number[];
  insertMs: number[];
  textMs: number[];
  jsonParseMs: number[];
  partBytes: number[];
  totalMs: number;
  heapMiB: number | null;
};

async function main() {
  const [{chromium}, {transform}] = await Promise.all([import('playwright-core'), import('esbuild')]);
  const parts = (await transform(readFileSync(path.join(ROOT, 'shared/design/parts.ts'), 'utf8'), {loader: 'ts', format: 'esm'})).code;
  const page = `<!doctype html><script type="module">
import init, {MorfaDoc} from '/wasm/morfa_wasm.js';
import {readPart} from '/parts.js';
const result = {writeMs: [], parseMs: [], insertMs: [], textMs: [], jsonParseMs: [], partBytes: []};
try {
  const wasm = await init({module_or_path: '/wasm/morfa_wasm_bg.wasm'});
  const bytes = new Uint8Array(await (await fetch('/checkpoint')).arrayBuffer());
  result.bytes = bytes.length;
  result.memoryBeforeMiB = wasm.memory.buffer.byteLength / 1048576;
  let t = performance.now();
  const doc = ${args.includes('--copy') ? 'MorfaDoc.decode(bytes)' : 'MorfaDoc.decode_from(bytes)'};
  result.decodeMs = performance.now() - t;
  result.memoryAfterDecodeMiB = doc.stats().memoryBytes / 1048576;
  result.nodes = doc.stats().nodes;
  const table = {};
  const slots = doc.part_slots();
  const started = performance.now();
  for (let start = 0; start < slots; start += ${count}) {
    t = performance.now();
    const json = doc.part_json(start, ${count}, ${shared});
    const written = performance.now();
    const nodes = readPart(json);
    const read = performance.now();
    Object.assign(table, nodes);
    result.insertMs.push(performance.now() - read);
    result.parseMs.push(read - written);
    result.writeMs.push(written - t);
    if (start % (${count} * 25) === 0) {
      // What of part_json is the UTF-8 → string step (wasm-bindgen's TextDecoder), and what of readPart is JSON.parse.
      const utf8 = new TextEncoder().encode(json);
      let at = performance.now();
      new TextDecoder().decode(utf8);
      result.textMs.push(performance.now() - at);
      at = performance.now();
      JSON.parse(json);
      result.jsonParseMs.push(performance.now() - at);
      result.partBytes.push(utf8.length);
    }
  }
  result.totalMs = performance.now() - started;
  result.parts = result.writeMs.length;
  result.memoryAfterPartsMiB = doc.stats().memoryBytes / 1048576;
  window.__table = table;
  if (globalThis.gc) { gc(); gc(); }
  result.heapMiB = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
} catch (error) {
  result.error = String(error && error.stack || error);
}
window.__bench = result;
</script>`;
  // A plain local server: a route's body crosses DevTools as base64, which an 80 MB checkpoint does not survive.
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', ORIGIN);
    const send = (body: string | Buffer, contentType: string) => response.writeHead(200, {...HEADERS, 'Content-Type': contentType}).end(body);
    if (url.pathname === '/') return send(page, 'text/html');
    if (url.pathname === '/parts.js') return send(parts, 'text/javascript');
    if (url.pathname === '/checkpoint') return send(readFileSync(file), 'application/octet-stream');
    if (url.pathname.startsWith('/wasm/')) {
      const name = path.basename(url.pathname);
      return send(readFileSync(path.join(ROOT, 'src/design/wasm', name)), name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(Number(new URL(ORIGIN).port), '127.0.0.1', resolve));
  const browser = await chromium.launch({executablePath: process.env.MORFA_SMOKE_CHROMIUM || undefined, args: ['--js-flags=--expose-gc', '--enable-precise-memory-info']});
  try {
    const tab = await browser.newPage();
    if (throttle > 1) await (await tab.context().newCDPSession(tab)).send('Emulation.setCPUThrottlingRate', {rate: throttle});
    tab.on('crash', () => console.error('page crashed'));
    tab.on('console', message => console.error(`console: ${message.text()}`));
    tab.on('pageerror', error => console.error(`page error: ${error.message}`));
    const profile = args.includes('--profile') ? await tab.context().newCDPSession(tab) : null;
    if (profile) await profile.send('Profiler.enable'), await profile.send('Profiler.setSamplingInterval', {interval: 100}), await profile.send('Profiler.start');
    await tab.goto(`${ORIGIN}/`);
    await tab.waitForFunction(() => (window as unknown as {__bench?: unknown}).__bench, null, {timeout: 1_800_000, polling: 1000});
    if (profile) selfTimes(((await profile.send('Profiler.stop')) as {profile: CpuProfile}).profile);
    const result = (await tab.evaluate(() => (window as unknown as {__bench: Result}).__bench)) as Result;
    if (result.error) throw new Error(result.error);
    report(result, browser.version());
  } finally {
    await browser.close();
    server.close();
  }
}

type CpuProfile = {nodes: {id: number; callFrame: {functionName: string; url: string}}[]; samples: number[]; timeDeltas: number[]};

/** `--profile`: the 25 functions with the most self time (CDP sampling profiler). */
function selfTimes(profile: CpuProfile) {
  const name = new Map(profile.nodes.map(node => [node.id, `${node.callFrame.functionName || '(anonymous)'} ${path.basename(node.callFrame.url)}`]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => self.set(name.get(id)!, (self.get(name.get(id)!) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  for (const [fn, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${ms.toFixed(1).padStart(8)} ms ${((100 * ms) / total).toFixed(1).padStart(5)} %  ${fn}`);
}

const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))];

function report(result: Result, version: string) {
  const each = result.writeMs.map((write, i) => write + result.parseMs[i]);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const row = (name: string, values: number[]) => `${name.padEnd(18)} median ${quantile(values, 0.5).toFixed(2)} ms   p95 ${quantile(values, 0.95).toFixed(2)} ms   max ${Math.max(...values).toFixed(2)} ms`;
  if (args.includes('--json')) return console.log(JSON.stringify({...result, throttle, count, shared, chrome: version}));
  console.log(`chrome ${version} (headless${throttle > 1 ? `, CPU ×${throttle} slower` : ''}); ${path.relative(ROOT, file)}: ${result.nodes} nodes, ${(result.bytes / 1048576).toFixed(1)} MiB; parts of ${count}, ${shared ? 'shared' : 'plain'}`);
  console.log(`decode             ${result.decodeMs.toFixed(0)} ms; wasm memory ${result.memoryBeforeMiB.toFixed(1)} → ${result.memoryAfterDecodeMiB.toFixed(1)} MiB (after every part ${result.memoryAfterPartsMiB.toFixed(1)} MiB)`);
  console.log(row('part (write+read)', each));
  console.log(row('  part_json', result.writeMs));
  console.log(row('  readPart', result.parseMs));
  console.log(`  of which (every 25th part): UTF-8 → string ${quantile(result.textMs, 0.5).toFixed(2)} ms, JSON.parse ${quantile(result.jsonParseMs, 0.5).toFixed(2)} ms; ${(mean(result.partBytes) / 1048576).toFixed(2)} MiB a part`);
  console.log(row('table insert', result.insertMs) + '   (the bench\'s own table, not a part\'s cost)');
  console.log(`all ${result.parts} parts       ${(result.totalMs / 1000).toFixed(2)} s; JS heap after gc ${result.heapMiB === null ? 'n.a.' : `${result.heapMiB.toFixed(0)} MiB`}`);
}

await main();
