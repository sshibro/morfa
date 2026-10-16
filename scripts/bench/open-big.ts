// Where the editor's open of a very big file goes (lane O; the coordinator's "f500k in the editor"): one cold open per file and
// big-files setting, unthrottled, with every stage's end (navigation-relative ms), the renderer process's resident memory sampled
// from outside the page every 200 ms (it keeps coming while the main thread is stuck in a parse), the JS heap from CDP, whether
// the tab died, and a CPU profile with its top costs per stage (unminified build: BENCH_APP_DIR=dist/app-profile).
//
//   tsx scripts/bench/open-big.ts [--files f100k,f500k] [--big off,on] [--query checkpoint=1] [--timeout 900] [--out …]
//
// big off: the file is the bench server's override (streamed from disk past the legacy caps); big on: DESIGN_BIG_FILES=1 on the
// api, the file stored for real, the editor opens its skeleton and first page (these files are one page each).
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {chromium, type Browser} from 'playwright-core';
import {accounts, bench, createFile, type Account} from './lib/fixtures';
import {ensureAppBuild, newTab, takeBrowserLock, type Stand} from './lib/browser';
import {startServer, type BenchServer} from './lib/server';
import {ROOT} from './lib/targets';

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const FILES = arg('files', 'f100k,f500k').split(',');
const BIG = arg('big', 'off,on').split(',');
const TIMEOUT_S = Number(arg('timeout', '900'));
const OUT = path.resolve(ROOT, arg('out', 'output/bench/open-big.json'));
/** Extra query for the editor's address (`checkpoint=1`: the open from checkpoint bytes). */
const QUERY = arg('query', '');
const log = (line: string) => console.error(line);

/** Resident memory (MB) of every Chromium renderer process now. */
function rendererRss(): number[] {
  const out = execFileSync('ps', ['-eo', 'rss=,args='], {encoding: 'utf8', maxBuffer: 1 << 24});
  return out.split('\n').filter(line => line.includes('--type=renderer')).map(line => Number(line.trim().split(/\s+/)[0]) / 1024);
}

type CpuProfile = {nodes: {id: number; callFrame: {functionName: string; url: string; lineNumber: number}}[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[]};
type Stage = {name: string; end: number};
type Result = {
  file: string; big: string; crashed: boolean; error?: string;
  stages: Stage[]; reads: {url: string; responseEnd: number; bytes: number}[];
  rss: [number, number][]; heap: [number, number][]; peakRss: number; peakHeap: number;
  heapAtEnd?: number; top: {stage: string; busy: number; items: [string, number][]}[];
};

async function openOnce(browser: Browser, server: BenchServer, account: Account, fileId: string, file: string, big: string): Promise<Result> {
  const stand = {server, browser, account, gpu: '', close: async () => {}} as Stand;
  const tab = await newTab(stand, {throttle: 1});
  await tab.context.addInitScript(() => performance.setResourceTimingBufferSize(100_000));
  const result: Result = {file, big, crashed: false, stages: [], reads: [], rss: [], heap: [], peakRss: 0, peakHeap: 0, top: []};
  tab.page.on('crash', () => {
    result.crashed = true;
  });
  await tab.cdp.send('Profiler.enable');
  await tab.cdp.send('Profiler.setSamplingInterval', {interval: 1000});
  await tab.cdp.send('Profiler.start');
  const started = Date.now();
  // Outside the page: the renderer's RSS (the largest renderer: the editor's tab), and the JS heap when CDP answers.
  const sampler = setInterval(() => {
    const t = Date.now() - started;
    const rss = Math.max(0, ...rendererRss());
    result.rss.push([t, rss]);
    result.peakRss = Math.max(result.peakRss, rss);
  }, 200);
  let heapBusy = false;
  const heapSampler = setInterval(() => {
    if (heapBusy || result.crashed) return;
    heapBusy = true;
    const asked = Date.now() - started;
    void tab.cdp
      .send('Runtime.getHeapUsage')
      .then(({usedSize}) => {
        const mb = usedSize / 2 ** 20;
        result.heap.push([asked, mb]);
        result.peakHeap = Math.max(result.peakHeap, mb);
      })
      .catch(() => {})
      .finally(() => (heapBusy = false));
  }, 500);
  try {
    await tab.page.goto(`${server.base}/?bench=1${QUERY ? '&' + QUERY : ''}#design/${fileId}`, {waitUntil: 'commit'});
    const deadline = Date.now() + TIMEOUT_S * 1000;
    for (;;) {
      if (result.crashed) throw Error('the tab crashed');
      const state = await tab.page
        .evaluate(() => ({painted: performance.getEntriesByName('morfa:first-paint').length > 0, text: document.body?.innerText.slice(0, 200) ?? ''}))
        .catch(() => null);
      if (state?.painted) break;
      if (state && /Could not open the file|Couldn.t open the file/i.test(state.text)) throw Error(`the editor gave up: ${state.text.replace(/\s+/g, ' ')}`);
      if (Date.now() > deadline) throw Error(`no first paint in ${TIMEOUT_S} s`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    // A quiet main thread after the first paint (as open.ts's "interactive"), up to two minutes.
    const timings = await tab.page.evaluate(async id => {
      const mark = (name: string) => performance.getEntriesByName('morfa:' + name)[0]?.startTime ?? NaN;
      const paint = mark('first-paint');
      let interactive = NaN;
      const end = performance.now() + 120_000;
      while (Number.isNaN(interactive) && performance.now() < end) {
        const queued = performance.now();
        await new Promise(resolve => setTimeout(resolve, 0));
        if (performance.now() - queued < 50) interactive = queued;
      }
      // The document's reads: the file (whole or skeleton) and its pages.
      const own = new RegExp(`/api/design-files/${id}(?:\\?[^/]*|/pages/[^/?]+|/checkpoint)?$`);
      const reads = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(entry => own.test(entry.name));
      return {
        reads: reads.map(entry => ({url: entry.name.replace(/^.*\/api\/design-files\/[^/?]+/, '') || '/', responseEnd: entry.responseEnd, bytes: entry.decodedBodySize})),
        stages: [
          {name: 'request start', end: reads[0]?.requestStart ?? NaN},
          {name: 'download done', end: reads.length ? Math.max(...reads.map(read => read.responseEnd)) : NaN},
          {name: 'document (parse done)', end: mark('open:document')},
          {name: 'engines + fonts', end: mark('open:engines')},
          {name: 'session (store built)', end: mark('open:session')},
          {name: 'first paint', end: paint},
          {name: 'interactive', end: Math.max(paint, interactive)},
        ],
      };
    }, fileId);
    result.stages = timings.stages;
    result.reads = timings.reads;
    // A few seconds more for the idle work after the first paint (the shadow's load), then the heap once more.
    await new Promise(resolve => setTimeout(resolve, 5000));
    result.heapAtEnd = ((await tab.cdp.send('Runtime.getHeapUsage')) as {usedSize: number}).usedSize / 2 ** 20;
  } catch (error) {
    result.error = String((error as Error).message).slice(0, 300);
    if (!result.stages.length) {
      result.stages = (await tab.page
        .evaluate(() => performance.getEntriesByType('mark').map(entry => ({name: entry.name, end: entry.startTime})))
        .catch(() => [])) as Stage[];
    }
  } finally {
    clearInterval(sampler);
    clearInterval(heapSampler);
  }
  try {
    const {profile} = (await tab.cdp.send('Profiler.stop')) as {profile: CpuProfile};
    writeFileSync(OUT.replace(/\.json$/, `-${file}-${big}.cpuprofile`), JSON.stringify(profile));
    result.top = costs(profile, result);
  } catch {
    // The tab is gone.
  }
  await tab.context.close().catch(() => {});
  return result;
}

/** Self time per function between consecutive stage ends (profile lined up by its end with the page's clock ≈ wall clock here). */
function costs(profile: CpuProfile, result: Result): Result['top'] {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const ends = result.stages.filter(stage => Number.isFinite(stage.end));
  const windows = ends.map((stage, i) => ({stage: stage.name, from: i ? ends[i - 1].end : 0, to: stage.end, items: new Map<string, number>()}));
  const total = profile.endTime - profile.startTime;
  let t = profile.startTime;
  profile.samples.forEach((id, i) => {
    t += profile.timeDeltas[i];
    // Profile start ≈ navigation start (it started just before the goto).
    const at = (t - profile.startTime) / 1000;
    const frame = byId.get(id)!.callFrame;
    if (frame.functionName === '(idle)' || frame.functionName === '(program)') return;
    const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()?.replace(/-[\w-]{8}\.js$/, '.js') ?? ''}`;
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    for (const window of windows) if (at >= window.from && at < window.to) window.items.set(key, (window.items.get(key) ?? 0) + dt);
  });
  void total;
  return windows.map(window => ({stage: window.stage, busy: [...window.items.values()].reduce((a, b) => a + b, 0), items: [...window.items].sort((a, b) => b[1] - a[1]).slice(0, 12)}));
}

/** The highest RSS and heap sampled up to each stage's end (since the previous one). */
function peaks(result: Result) {
  const ends = result.stages.filter(stage => Number.isFinite(stage.end));
  return ends.map((stage, i) => {
    const from = i ? ends[i - 1].end : 0;
    const inWindow = (series: [number, number][]) => Math.max(0, ...series.filter(([t]) => t >= from && t <= stage.end + 200).map(([, v]) => v));
    return {stage: stage.name, end: stage.end, rss: inWindow(result.rss), heap: inWindow(result.heap)};
  });
}

async function main() {
  const appDir = process.env.BENCH_APP_DIR ? path.resolve(ROOT, process.env.BENCH_APP_DIR) : ensureAppBuild(log);
  const release = await takeBrowserLock('O open-big.ts', log);
  const results: Result[] = [];
  try {
    for (const big of BIG) {
      const server = await startServer({target: 'local', port: 5420, appDir, log, env: {DESIGN_BIG_FILES: big === 'on' ? '1' : '0'}});
      let browser: Browser | null = null;
      try {
        const [account] = await accounts(server, 1, 'open-big');
        browser = await chromium.launch({
          ...(process.env.PLAYWRIGHT_CHROMIUM ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM} : {channel: 'chromium'}),
          headless: true,
          args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
        });
        for (const file of FILES) {
          let fileId: string;
          const made = Date.now();
          if (big === 'off') {
            fileId = (await createFile(server, account, 'f2k')).id;
            await bench(server, 'override', {fileId, fixture: file});
          } else {
            fileId = (await createFile(server, account, file)).id;
          }
          log(`open-big: ${file} big=${big}: file ready in ${((Date.now() - made) / 1000).toFixed(1)} s; opening`);
          const result = await openOnce(browser, server, account, fileId, file, big);
          results.push(result);
          log(`open-big: ${file} big=${big}: ${result.error ?? 'opened'}; crashed=${result.crashed}; peak RSS ${result.peakRss.toFixed(0)} MB, peak heap ${result.peakHeap.toFixed(0)} MB`);
          for (const row of peaks(result)) log(`  ${row.stage.padEnd(24)} ${(row.end / 1000).toFixed(2).padStart(7)} s   RSS ≤ ${row.rss.toFixed(0)} MB   heap ≤ ${row.heap.toFixed(0)} MB`);
          for (const window of result.top) log(`  [${window.stage}] busy ${window.busy.toFixed(0)} ms: ${window.items.slice(0, 6).map(([key, ms]) => `${key} ${ms.toFixed(0)}`).join(' · ')}`);
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
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  for (const result of results) {
    console.log(`\n### ${result.file}, big files ${result.big}${result.crashed ? ' — TAB CRASHED' : ''}${result.error ? ` — ${result.error}` : ''}`);
    console.log(`reads: ${result.reads.map(read => `${read.url} ${(read.bytes / 1e6).toFixed(1)} MB`).join(', ') || '—'}; peak RSS ${result.peakRss.toFixed(0)} MB, peak heap ${result.peakHeap.toFixed(0)} MB, heap 5 s after interactive ${result.heapAtEnd?.toFixed(0) ?? '—'} MB`);
    console.log('| stage | ends at (s) | renderer RSS peak (MB) | JS heap peak (MB) | top self time in the stage |\n|---|---|---|---|---|');
    const tops = new Map(result.top.map(window => [window.stage, window]));
    for (const row of peaks(result)) {
      const top = tops.get(row.stage);
      console.log(`| ${row.stage} | ${(row.end / 1000).toFixed(2)} | ${row.rss.toFixed(0)} | ${row.heap ? row.heap.toFixed(0) : '—'} | ${top ? `busy ${(top.busy / 1000).toFixed(2)} s: ` + top.items.slice(0, 4).map(([key, ms]) => `${key} ${(ms / 1000).toFixed(2)}`).join(', ') : ''} |`);
    }
  }
}

await main();
