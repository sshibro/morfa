// Opening files over a real link (C8; C9): the built editor opens a bench file in Chromium
// with the network shaped through CDP (50 Mbit/s down, 30 ms round trip by default), cold (a new browser profile) and warm (a
// reload in the same profile: HTTP cache, the compiled wasm cache and whatever the editor keeps in IndexedDB), and records what
// the open waited on: the document's request (to its first byte and its last), the parse and the store's document
// (`morfa:open:document`), the engines and the first page's fonts (`morfa:open:engines`), the session (`morfa:open:session`),
// the first scene paint and the first quiet main thread after it (interactive).
//
//   tsx scripts/bench/open.ts [--files f20k,f100k] [--big off,on] [--encode none,zstd] [--runs 1] [--mbps 50] [--rtt 30]
//                             [--out output/bench/open.json]
//
// --mbps 0: no network shaping (loopback, as B0's C9).
// --big: DESIGN_BIG_FILES on the api (the editor reads it from /api/config), never the default; off opens f100k through the
//   bench server's override (scripts/bench/server.ts: past the legacy caps, streamed from disk), on stores it for real.
// --encode zstd: a proxy in front of the bench server compresses what production's Caddy compresses (deploy/caddy/morfa-sites.caddy:
//   `encode zstd gzip` on JSON, scripts, CSS, wasm, SVG and fonts; never the live stream), at zstd's default level as Caddy does.
//   Chromium sends `Accept-Encoding: … zstd`; the CDP shaping counts the bytes on the wire.
// Needs the PostgreSQL test cluster (BENCH_PG_STATE, as every bench server) and dist/app (built when older than src/).
import {once} from 'node:events';
import {createServer, request, type IncomingMessage, type ServerResponse} from 'node:http';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {constants, createGzip, createZstdCompress} from 'node:zlib';
import {chromium, type Browser} from 'playwright-core';
import {accounts, bench, createFile, type Account} from './lib/fixtures';
import {CPU_THROTTLE, ensureAppBuild, newTab, settle, takeBrowserLock, type Stand, type Tab} from './lib/browser';
import {startServer, type BenchServer} from './lib/server';
import {ROOT} from './lib/targets';

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const list = (name: string, fallback: string) => arg(name, fallback).split(',').filter(Boolean);
const FILES = list('files', 'f20k,f100k');
const BIG = list('big', 'off,on');
const ENCODE = list('encode', 'none,zstd');
const RUNS = Number(arg('runs', '1'));
const MBPS = Number(arg('mbps', '50'));
const RTT = Number(arg('rtt', '30'));
const OUT = path.resolve(ROOT, arg('out', 'output/bench/open.json'));
/** --profile: a CPU profile of each cold open (navigation to interactive) next to --out, and its top costs by phase on stderr. */
const PROFILE = process.argv.includes('--profile');
const log = (line: string) => console.error(line);

/** What production's Caddy compresses (deploy/caddy/morfa-sites.caddy, app.morfa.example). */
const COMPRESSIBLE = /^(text\/html|text\/css|text\/plain|text\/javascript|application\/javascript|application\/json|application\/wasm|image\/svg\+xml|font\/ttf)/;

/** A Caddy stand-in on `port` in front of `target`: streams through, compressing the types above with zstd (or gzip). */
async function encodingProxy(target: string, port: number): Promise<{base: string; close(): Promise<void>}> {
  const upstream = new URL(target);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const out = request({host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: {...req.headers, host: upstream.host, 'accept-encoding': 'identity'}}, answer => {
      const type = String(answer.headers['content-type'] ?? '');
      const accepts = String(req.headers['accept-encoding'] ?? '');
      const coding = COMPRESSIBLE.test(type) && !answer.headers['content-encoding'] ? (/\bzstd\b/.test(accepts) ? 'zstd' : /\bgzip\b/.test(accepts) ? 'gzip' : null) : null;
      const headers = {...answer.headers};
      if (coding) {
        delete headers['content-length'];
        headers['content-encoding'] = coding;
        headers.vary = 'Accept-Encoding';
      }
      res.writeHead(answer.statusCode ?? 502, headers);
      if (!coding) {
        answer.pipe(res);
        return;
      }
      // Caddy's zstd default is SpeedDefault (level 3); its gzip default is 5.
      const encoder = coding === 'zstd' ? createZstdCompress({params: {[constants.ZSTD_c_compressionLevel]: 3}}) : createGzip({level: 5});
      answer.pipe(encoder).pipe(res);
    });
    out.on('error', () => res.destroy());
    req.pipe(out);
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {base: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve()))};
}

type Phases = {
  /** ms from navigation start. */
  requestStart: number; firstByte: number; responseEnd: number; document: number; engines: number; session: number; firstPaint: number; interactive: number;
  /** Bytes on the wire and decoded, of the document's requests. */
  transferred: number; decoded: number;
  /** Every document read the open made (skeleton, pages). */
  reads: string[];
};

async function open(tab: Tab, base: string, fileId: string, timeoutMs: number): Promise<Phases> {
  const started = Date.now();
  await tab.page.goto(`${base}/?bench=1#design/${fileId}`, {waitUntil: 'commit'});
  try {
    await tab.page.waitForFunction(() => performance.getEntriesByName('morfa:first-paint').length > 0 && !!(window as unknown as {__morfaBench?: unknown}).__morfaBench, undefined, {timeout: timeoutMs, polling: 50});
  } catch {
    const state = await tab.page.evaluate(() => ({marks: performance.getEntriesByType('mark').map(m => `${m.name} ${m.startTime.toFixed(0)}`), text: document.body.innerText.slice(0, 300)})).catch(() => null);
    throw Error(`the file did not open in ${((Date.now() - started) / 1000).toFixed(0)} s: ${JSON.stringify(state)}`);
  }
  return tab.page.evaluate(async id => {
    const mark = (name: string) => performance.getEntriesByName('morfa:' + name)[0]?.startTime ?? NaN;
    const paint = mark('first-paint');
    let interactive = NaN;
    for (let i = 0; i < 600 && Number.isNaN(interactive); i++) {
      const queued = performance.now();
      await new Promise(resolve => setTimeout(resolve, 0));
      if (performance.now() - queued < 50) interactive = queued;
    }
    // The document's reads only: the file (whole, `?have=`, the skeleton) and its pages.
    const own = new RegExp(`/api/design-files/${id}(?:\\?[^/]*|/pages/[^/?]+)?$`);
    const reads = performance.getEntriesByType('resource').filter(entry => own.test(entry.name)) as PerformanceResourceTiming[];
    const first = reads[0], last = reads[reads.length - 1];
    return {
      requestStart: first?.requestStart ?? NaN, firstByte: first?.responseStart ?? NaN, responseEnd: last?.responseEnd ?? NaN,
      document: mark('open:document'), engines: mark('open:engines'), session: mark('open:session'), firstPaint: paint, interactive: Math.max(paint, interactive),
      transferred: reads.reduce((sum, entry) => sum + entry.transferSize, 0), decoded: reads.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      reads: reads.map(entry => entry.name.replace(/^.*\/api\/design-files\/[^/?]+/, '') || '/'),
    };
  }, fileId);
}

/** Leaves the file for the file list in the app (the editor closes and keeps its checkpoint, src/design/editor/open-file.ts),
 *  then waits until the checkpoint is in IndexedDB; answers its version, or null when none came within a minute. */
async function leaveAndKeep(tab: Tab): Promise<number | null> {
  await tab.page.evaluate(() => {
    location.hash = '#designs';
  });
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const version = await tab.page.evaluate(() => new Promise<number | null>(resolve => {
      const request = indexedDB.open('morfa-checkpoints');
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) return resolve(null);
        const all = db.transaction('meta').objectStore('meta').getAll();
        all.onsuccess = () => resolve((all.result as {version: number}[])[0]?.version ?? null);
        all.onerror = () => resolve(null);
      };
    }));
    if (version !== null) return version;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

type Row = {file: string; big: string; encode: string; run: number; cold: Phases | {error: string}; warm: Phases | {error: string}};

async function main() {
  const appDir = process.env.BENCH_APP_DIR ? path.resolve(ROOT, process.env.BENCH_APP_DIR) : ensureAppBuild(log);
  const release = await takeBrowserLock('O open.ts', log);
  const rows: Row[] = [];
  try {
    for (const big of BIG) {
      const server: BenchServer = await startServer({target: 'local', port: 5420, appDir, log, env: {DESIGN_BIG_FILES: big === 'on' ? '1' : '0'}});
      let browser: Browser | null = null;
      try {
        const [account]: Account[] = await accounts(server, 1, 'open');
        browser = await chromium.launch({
          ...(process.env.PLAYWRIGHT_CHROMIUM ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM} : {channel: 'chromium'}),
          headless: true,
          args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
        });
        const files = new Map<string, string>();
        for (const name of FILES) {
          if (big === 'off' && name !== 'f20k') {
            // Past the legacy caps: a placeholder whose GET streams the bench file from disk.
            const placeholder = await createFile(server, account, 'f2k');
            await bench(server, 'override', {fileId: placeholder.id, fixture: name});
            files.set(name, placeholder.id);
          } else files.set(name, (await createFile(server, account, name)).id);
        }
        for (const encode of ENCODE) {
          const proxy = encode === 'none' ? null : await encodingProxy(server.base, 5421);
          const base = proxy?.base ?? server.base;
          try {
            for (const name of FILES)
              for (let run = 0; run < RUNS; run++) {
                const stand = {server: {...server, base}, browser, account, gpu: '', close: async () => {}} as Stand;
                const tab = await newTab(stand, MBPS > 0 ? {network: {downloadMbps: MBPS, latencyMs: RTT}} : {});
                // Every request in the timings (Chromium keeps 250 by default; the document's read must not fall off the end).
                await tab.context.addInitScript(() => performance.setResourceTimingBufferSize(100_000));
                if (process.env.BENCH_CONSOLE === '1') tab.page.on('console', message => log(`console ${message.type()}: ${message.text()}`));
                const attempt = async () => open(tab, base, files.get(name)!, 120_000).catch(error => ({error: String((error as Error).message).slice(0, 400)}));
                try {
                  if (PROFILE) {
                    await tab.cdp.send('Profiler.enable');
                    await tab.cdp.send('Profiler.setSamplingInterval', {interval: 200});
                    await tab.cdp.send('Profiler.start');
                  }
                  const cold = await attempt();
                  if (PROFILE) {
                    const nowAtStop = await tab.page.evaluate(() => performance.now());
                    const {profile} = (await tab.cdp.send('Profiler.stop')) as {profile: CpuProfile};
                    profile.pageNowAtEnd = nowAtStop;
                    const file = OUT.replace(/\.json$/, `-${name}-${big}-${encode}.cpuprofile`);
                    mkdirSync(path.dirname(file), {recursive: true});
                    writeFileSync(file, JSON.stringify(profile));
                    if (!('error' in cold)) log(costs(profile, cold));
                  }
                  if (!('error' in cold)) {
                    await settle(tab, 30_000);
                    log(`open: checkpoint kept: ${await leaveAndKeep(tab)}`);
                  }
                  await tab.page.goto('about:blank');
                  const warm = await attempt();
                  rows.push({file: name, big, encode, run, cold, warm});
                  log(`open: ${name} big=${big} encode=${encode} run ${run}: ${JSON.stringify({cold, warm})}`);
                } finally {
                  await tab.context.close();
                }
              }
          } finally {
            await proxy?.close();
          }
        }
      } finally {
        await browser?.close().catch(() => {});
        await server.stop();
      }
    }
  } finally {
    release();
  }
  mkdirSync(path.dirname(OUT), {recursive: true});
  writeFileSync(OUT, JSON.stringify({at: new Date().toISOString(), mbps: MBPS, rtt: RTT, cpuThrottle: CPU_THROTTLE, rows}, null, 2));
  console.log(table(rows));
}

type CpuProfile = {nodes: {id: number; callFrame: {functionName: string; url: string; lineNumber: number}; children?: number[]}[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[]; pageNowAtEnd?: number};

/** Self time per function in each phase of the open (profile time is µs on the trace clock; the phases are ms from navigation,
 *  so the profile's first sample is lined up with navigation start: the profiler started just before it). */
function costs(profile: CpuProfile, phases: Phases): string {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const edges: [string, number, number][] = [['to the document', 0, phases.document], ['document → session', phases.document, phases.session], ['session → first paint', phases.session, phases.firstPaint], ['first paint → interactive', phases.firstPaint, phases.interactive]];
  const tables = edges.map(() => new Map<string, number>());
  // Lined up by the end: the page's clock read just before the profiler stopped.
  let t = profile.startTime;
  const offset = (profile.pageNowAtEnd ?? 0) * 1000 - profile.endTime;
  profile.samples.forEach((id, i) => {
    t += profile.timeDeltas[i];
    const node = byId.get(id)!;
    const frame = node.callFrame;
    if (frame.functionName === '(idle)' || frame.functionName === '(program)') return;
    const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber}`;
    const at = (t + offset) / 1000;
    edges.forEach(([, from, to], k) => {
      if (at >= from && at < to) tables[k].set(key, (tables[k].get(key) ?? 0) + (profile.timeDeltas[i + 1] ?? 0) / 1000);
    });
  });
  return edges.map(([label, from, to], k) => {
    const top = [...tables[k]].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const busy = [...tables[k].values()].reduce((a, b) => a + b, 0);
    return `${label} (${(from / 1000).toFixed(2)}–${(to / 1000).toFixed(2)} s, busy ${busy.toFixed(0)} ms):\n` + top.map(([key, value]) => `  ${value.toFixed(0).padStart(6)} ms  ${key}`).join('\n');
  }).join('\n');
}

const ms = (value: number) => (Number.isFinite(value) ? (value / 1000).toFixed(2) : '—');
const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
function cells(phases: Phases | {error: string}): string {
  if ('error' in phases) return `never: ${phases.error.slice(0, 80)} | | | | | | |`;
  const p = phases;
  return `${ms(p.firstByte)} | ${ms(p.responseEnd)} (${mb(p.transferred)} of ${mb(p.decoded)} MB) | ${ms(p.document)} | ${ms(p.engines)} | ${ms(p.session)} | **${ms(p.firstPaint)}** | **${ms(p.interactive)}** |`;
}
function table(rows: Row[]): string {
  const head = '| file | big | encode | open | first byte | body done (wire of decoded) | document | engines + fonts | session | first paint | interactive |\n|---|---|---|---|---|---|---|---|---|---|---|';
  return [head, ...rows.flatMap(row => [`| ${row.file} | ${row.big} | ${row.encode} | cold | ${cells(row.cold)}`, `| ${row.file} | ${row.big} | ${row.encode} | warm | ${cells(row.warm)}`])].join('\n');
}

await main();
