// M-rows of docs/TARGETS.md §3 (and the load numbers D1/K1–K3 reuse): synthetic editors from crates/loadgen against a bench
// server, server-side timings from its /__bench/metrics, `tc netem` in the dev-4 container for the ru-net stand-in.
//
//   tsx scripts/bench/collab-load.ts --machine dev-4 [--only M1,M5] [--quick] [--no-netem]
//
// Today (legacy) the editors use SSE + PATCH (loadgen --mode legacy). With lane B1's collab service running (BENCH_COLLAB_WS
// =ws://host:port and tickets from BENCH_COLLAB_TICKETS), the same scenarios run over the WebSocket (`ws` mode).
//
// Scenarios, each on a fresh server and database:
//   pair      5 editors on f20k, 1 op/s of 20 moved layers each, cursors 30 Hz → M1, M1b, M3 (loopback), K1/K3 per-op costs
//   ru-net    the same with netem 30 ms + 0.1 % loss on the server's answers → M2, M3, M11
//   slow      the pair plus a viewer reading at 64 kbit/s → M12
//   crowd     100 editors + 400 viewers on one f20k → M4 (ratios to the pair)
//   many      2 000 editors over 400 files of f2k (5 a file) → M5, D1 (f20k × 400 does not fit dev-4: 6.4 GB of documents)
//   cursors   1 000 people over 200 files moving cursors at 30 Hz, no ops → M10
//   memory    f20k files opened and saved once, server RSS after GC → M6, M7
//   catch-up  1 000 changes, then a stream that resumes 1 000 versions back → M8 (M9 from the legacy limits)
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fillNa, runStandalone, wants, type Bench, type BenchContext} from './lib/context';
import {accounts, api, cookieOf, fixtureDocument, gc, layersFor, metrics, resetMetrics, sharedFile, type ServerMetrics, type SharedFile} from './lib/fixtures';
import {Histogram} from './lib/histogram';
import {runLoadgen, type LoadgenConfig, type LoadgenReport} from './lib/loadgen';
import {LoadWatch, sleep} from './lib/machine';
import {docker, startServer, type BenchServer} from './lib/server';
import {difference, parsePrometheus, quantile} from './lib/prometheus';
import {randomUUID} from 'node:crypto';
import type {RowResult} from './lib/targets';

export type Scenario = {
  name: string;
  fixture: string;
  files: number;
  editors: number;
  viewers?: number;
  cursorHz: number;
  ops: boolean;
  netem?: boolean;
  slowViewer?: boolean;
  presenceProbe?: boolean;
  recordAcked?: boolean;
  durationMs?: number;
};
export type ScenarioResult = {scenario: Scenario; loadgen: LoadgenReport; server: ServerMetrics; serverShape: string; load: ReturnType<LoadWatch['result']>; netemApplied: boolean; files: SharedFile[]};

const NETEM = {delayMs: 30, loss: '0.1%'};

export async function applyNetem(server: BenchServer, on: boolean): Promise<boolean> {
  // bench-ru (lane B5): the ru-net VM's own netem toward bench-ru (scripts/deploy/provision-bench.sh).
  if (server.netem) return server.netem(on);
  if (!server.container) return false;
  const port = new URL(server.base).port;
  const script = on
    ? `tc qdisc del dev eth0 root 2>/dev/null; tc qdisc add dev eth0 root handle 1: prio && tc qdisc add dev eth0 parent 1:3 handle 30: netem delay ${NETEM.delayMs}ms loss ${NETEM.loss} && tc filter add dev eth0 protocol ip parent 1:0 prio 3 u32 match ip sport ${port} 0xffff flowid 1:3`
    : 'tc qdisc del dev eth0 root 2>/dev/null; true';
  try {
    await docker(['exec', server.container, 'sh', '-c', script]);
    return on;
  } catch {
    return false;
  }
}

async function pool<T, R>(items: readonly T[], width: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(width, items.length)}, async () => {
    for (let index = next++; index < items.length; index = next++) out[index] = await work(items[index], index);
  }));
  return out;
}

function windows(ctx: BenchContext, scenario: Scenario) {
  const people = scenario.files * (scenario.editors + (scenario.viewers ?? 0));
  if (ctx.quick) return {durationMs: 8_000, rampMs: Math.min(4_000, 500 + people), warmupMs: 2_000};
  return {durationMs: scenario.durationMs ?? 30_000, rampMs: Math.min(15_000, 2_000 + people * 5), warmupMs: 5_000};
}

/** Sets up `scenario` on `server`, runs loadgen, reads the server's numbers for the measurement window. */
export async function runScenario(ctx: BenchContext, server: BenchServer, scenario: Scenario): Promise<ScenarioResult> {
  ctx.log(`collab-load: ${scenario.name} — ${scenario.files} × (${scenario.editors} editors + ${scenario.viewers ?? 0} viewers) on ${scenario.fixture}, server ${server.shape}`);
  const perFile = scenario.editors + (scenario.viewers ?? 0) + (scenario.slowViewer ? 1 : 0);
  const people = await accounts(server, scenario.files * perFile, scenario.name);
  const files = await pool(Array.from({length: scenario.files}, (_, i) => i), 8, i =>
    sharedFile(server, scenario.fixture, scenario.editors, (scenario.viewers ?? 0) + (scenario.slowViewer ? 1 : 0), people.slice(i * perFile, (i + 1) * perFile)));
  const doc = fixtureDocument(scenario.fixture);
  const {durationMs, rampMs, warmupMs} = windows(ctx, scenario);
  const config: LoadgenConfig = {
    mode: 'legacy',
    base: server.base,
    origin: server.base,
    durationMs,
    rampMs,
    warmupMs,
    opIntervalMs: 1000,
    cursorHz: scenario.cursorHz,
    presenceProbe: scenario.presenceProbe,
    recordAcked: scenario.recordAcked,
    threads: 2,
    files: files.map(file => ({
      id: file.id,
      version: file.version,
      editors: [
        ...file.editors.map((account, k) => ({cookie: cookieOf(account), role: 'editor' as const, nodes: scenario.ops ? layersFor(doc, k) : []})),
        ...file.viewers.map((account, k) => ({
          cookie: cookieOf(account), role: 'viewer' as const,
          ...(scenario.slowViewer && k === file.viewers.length - 1 ? {readBytesPerSecond: 8_000, quiet: true} : {}),
        })),
      ],
    })),
  };
  const netemApplied = scenario.netem ? await applyNetem(server, true) : false;
  if (scenario.netem && !netemApplied) {
    await applyNetem(server, false);
    throw Object.assign(Error('netem unavailable'), {na: 'needs tc netem in the dev-4 container (run with --machine dev-4)'});
  }
  const load = new LoadWatch();
  // The server's numbers cover the loadgen's measurement window only.
  let serverNumbers: Promise<ServerMetrics> | null = null;
  const windowStart = setTimeout(() => {
    void resetMetrics(server);
    serverNumbers = sleep(durationMs).then(() => metrics(server));
  }, rampMs + warmupMs);
  try {
    const loadgen = await runLoadgen(config, path.join(ctx.outDir, `loadgen-${scenario.name}.json`), ctx.log);
    clearTimeout(windowStart);
    const serverMetrics = await (serverNumbers ?? metrics(server));
    writeFileSync(path.join(ctx.outDir, `server-${scenario.name}.json`), JSON.stringify(serverMetrics));
    const result: ScenarioResult = {scenario, loadgen, server: serverMetrics, serverShape: server.shape, load: load.stop(), netemApplied, files};
    ctx.log(`  ${scenario.name}: acked ${loadgen.opsAcked}/${loadgen.opsSent}, statuses ${JSON.stringify(loadgen.statuses)}, ack p95 ${loadgen.ack.p95?.toFixed(1)} ms, arrival p95 ${loadgen.arrival.p95?.toFixed(1)} ms, server cpu ${serverCores(serverMetrics).toFixed(2)} cores, loadgen ${loadgen.time?.cores.toFixed(2) ?? loadgen.selfCores?.toFixed(2)} cores, peak streams ${loadgen.peakStreams}, load ${load.result().max.toFixed(1)}`);
    return result;
  } finally {
    if (netemApplied) await applyNetem(server, false);
  }
}

export const serverCores = (m: ServerMetrics) => (m.cpuUserMs + m.cpuSystemMs) / m.wallMs;
const h = (json: Parameters<typeof Histogram.from>[0]) => Histogram.from(json);

/** A scenario on its own fresh server (and database); results kept in ctx.shared for D1/K. */
export async function scenario(ctx: BenchContext, spec: Scenario): Promise<ScenarioResult> {
  const key = `collab:${spec.name}`;
  const cached = ctx.shared.get(key) as ScenarioResult | undefined;
  if (cached) return cached;
  const server = await startServer({target: ctx.target, source: ctx.source, log: ctx.log});
  try {
    const result = await runScenario(ctx, server, spec);
    ctx.shared.set(key, result);
    return result;
  } finally {
    await server.stop();
  }
}

export const SCENARIOS = {
  pair: {name: 'pair', fixture: 'f20k', files: 1, editors: 5, cursorHz: 30, ops: true, presenceProbe: true},
  ruNet: {name: 'ru-net', fixture: 'f20k', files: 1, editors: 5, cursorHz: 30, ops: true, presenceProbe: true, netem: true},
  slow: {name: 'slow', fixture: 'f20k', files: 1, editors: 5, cursorHz: 30, ops: true, slowViewer: true},
  crowd: {name: 'crowd', fixture: 'f20k', files: 1, editors: 100, viewers: 400, cursorHz: 30, ops: true, durationMs: 20_000},
  many: {name: 'many', fixture: 'f2k', files: 400, editors: 5, cursorHz: 30, ops: true},
  cursors: {name: 'cursors', fixture: 'f2k', files: 200, editors: 5, cursorHz: 30, ops: false},
} satisfies Record<string, Scenario>;

const legacyNote = 'legacy SSE + PATCH (Node): the change goes to the peers after its commit, so M1 here includes the journal';

function provisional(...results: (ScenarioResult | undefined)[]): string | undefined {
  const loads = results.filter(Boolean).map(r => r!.load.max);
  if (!loads.length) return undefined;
  const max = Math.max(...loads);
  return max > 4 ? `load average up to ${max.toFixed(1)} on the shared Mac` : undefined;
}

/** M6/M7: f20k files opened (GET) and saved once each with their stream open; resident memory after GC per document. */
export async function memoryPerDocument(ctx: BenchContext): Promise<{perDocMb: number; jsonMb: number; docs: number; rss0: number; rss1: number; held0: number; held1: number}> {
  const server = await startServer({target: ctx.target, source: ctx.source, log: ctx.log});
  try {
    const docs = 3;
    const held = (memory: NodeJS.MemoryUsage) => memory.heapUsed + memory.external;
    const settle = async () => {
      let memory = (await gc(server)).memory;
      for (let i = 0; i < 3; i++) memory = (await gc(server)).memory;
      return memory;
    };
    // The process before any document: V8's heap and the memory outside it (Buffers, the parsed JSON's strings).
    const before = await settle();
    const files: SharedFile[] = [];
    for (let i = 0; i < docs; i++) files.push(await sharedFile(server, 'f20k', 1));
    const doc = fixtureDocument('f20k');
    const streams: AbortController[] = [];
    for (const file of files) {
      const controller = new AbortController();
      streams.push(controller);
      void fetch(`${server.base}/api/design-files/${file.id}/events?since=${file.version}`, {headers: {cookie: cookieOf(file.owner)}, signal: controller.signal}).then(r => r.body?.getReader().read()).catch(() => {});
      const opened = await api(server, file.owner, 'GET', `/api/design-files/${file.id}`);
      if (opened.status !== 200) throw Error(`open: ${opened.status}`);
      const node = layersFor(doc, 0, 1)[0];
      const saved = await api(server, file.owner, 'PATCH', `/api/design-files/${file.id}/document`, {baseVersion: file.version, patch: {nodes: {[node.id]: {...node, x: node.x + 1}}}, before: {[node.id]: node}});
      if (saved.status !== 200) throw Error(`save: ${saved.status} ${saved.text.slice(0, 200)}`);
    }
    await sleep(1000);
    const after = await settle();
    for (const controller of streams) controller.abort();
    const jsonMb = Buffer.byteLength(JSON.stringify(doc)) / 2 ** 20;
    return {perDocMb: (held(after) - held(before)) / docs / 2 ** 20, jsonMb, docs, rss0: before.rss, rss1: after.rss, held0: held(before), held1: held(after)};
  } finally {
    await server.stop();
  }
}

/** M8: 1 000 changes, then a stream resuming 1 000 versions back: the server's answer (changes or resync) and, on resync, the
 *  whole document read again (legacy's only way back). */
async function catchUp(ctx: BenchContext): Promise<{catchUpMs: number; convergedMs: number; resync: boolean; missed: number; netem: boolean}> {
  const server = await startServer({target: ctx.target, source: ctx.source, log: ctx.log});
  try {
    const file = await sharedFile(server, 'f20k', 3);
    const doc = fixtureDocument('f20k');
    const missed = ctx.quick ? 200 : 1000;
    let version = file.version;
    // Three editors take turns (600 document writes per 10 minutes per account); one layer each, every change kept.
    const nodes = file.editors.map((_, k) => layersFor(doc, k, 1)[0]);
    for (let i = 0; i < missed; i++) {
      const k = i % file.editors.length, node = nodes[k];
      const moved = {...node, x: node.x + i + 1};
      const answer = await api(server, file.editors[k], 'PATCH', `/api/design-files/${file.id}/document`, {baseVersion: version, patch: {nodes: {[node.id]: moved}}, before: {[node.id]: nodes[k]}});
      if (answer.status !== 200) throw Error(`catch-up writes: ${answer.status} ${answer.text.slice(0, 200)}`);
      nodes[k] = moved;
      version = (JSON.parse(answer.text) as {version: number}).version;
    }
    const since = version - missed;
    // The resume goes over the ru-net stand-in when there is one (TARGETS M8: "over ru-net").
    const netem = ctx.netem ? await applyNetem(server, true) : false;
    const started = performance.now();
    const controller = new AbortController();
    const response = await fetch(`${server.base}/api/design-files/${file.id}/events?since=${since}`, {headers: {cookie: cookieOf(file.owner)}, signal: controller.signal});
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '', resync = false, last = since, catchUpMs = NaN;
    while (Number.isNaN(catchUpMs)) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += value;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith('event: resync')) resync = true;
        const id = /\nid: (\d+)/.exec(block);
        if (id) last = Number(id[1]);
        if (resync || last >= version) catchUpMs = performance.now() - started;
      }
    }
    let convergedMs = catchUpMs;
    if (resync) {
      const opened = await api(server, file.owner, 'GET', `/api/design-files/${file.id}`);
      JSON.parse(opened.text);
      convergedMs = performance.now() - started;
    }
    controller.abort();
    if (netem) await applyNetem(server, false);
    return {catchUpMs, convergedMs, resync, missed, netem};
  } finally {
    await server.stop();
  }
}

/** An unsigned dev ticket of lane B1's collab (`MORFA_COLLAB_DEV_TICKETS=1`): `dev.` + base64url of the claims. */
export const devTicket = (claims: {file: string; user: string; name: string; role: string}) =>
  'dev.' + Buffer.from(JSON.stringify({...claims, exp: Math.floor(Date.now() / 1000) + 3600})).toString('base64url');

export type WsPair = {loadgen: LoadgenReport; fanout: {p50: number; p95: number; p99: number; count: number}; ack: {p50: number; p95: number; p99: number; count: number}; load: ReturnType<LoadWatch['result']>};

/** A scenario over the collab socket of lane B1 (`BENCH_COLLAB_WS=ws://host:port`; the service runs with
 *  MORFA_COLLAB_DEV_TICKETS=1 and MORFA_COLLAB_SEED=fixtures/bench/<the scenario's file>.json, so an unknown file opens as it). */
export async function wsScenario(ctx: BenchContext, wsBase: string, spec: Scenario = SCENARIOS.pair): Promise<WsPair> {
  const doc = fixtureDocument(spec.fixture);
  const {durationMs, rampMs, warmupMs} = windows(ctx, spec);
  const httpBase = wsBase.replace(/^ws/, 'http');
  const scrape = async () => parsePrometheus(await (await fetch(httpBase + '/metrics')).text()).histograms;
  const config: LoadgenConfig = {
    mode: 'ws', base: wsBase, durationMs, rampMs, warmupMs, opIntervalMs: 1000, cursorHz: spec.cursorHz, presenceProbe: spec.presenceProbe, threads: 2,
    files: Array.from({length: spec.files}, () => {
      const fileId = randomUUID();
      return {id: fileId, version: 0, editors: Array.from({length: spec.editors}, (_, k) => ({
        role: 'editor' as const, ticket: devTicket({file: fileId, user: `loadgen-${k}`, name: `Editor ${k + 1}`, role: k ? 'editor' : 'owner'}), clientId: `loadgen-${k}-${fileId.slice(0, 8)}`, nodes: spec.ops ? layersFor(doc, k) : [],
      }))};
    }),
  };
  const load = new LoadWatch();
  let before: Awaited<ReturnType<typeof scrape>> | null = null;
  const windowStart = setTimeout(() => void scrape().then(h => (before = h)), rampMs + warmupMs);
  const loadgen = await runLoadgen(config, path.join(ctx.outDir, `loadgen-ws-${spec.name}.json`), ctx.log);
  clearTimeout(windowStart);
  const after = await scrape();
  const read = (name: string) => {
    const h = after.get(name);
    if (!h) return {p50: NaN, p95: NaN, p99: NaN, count: 0};
    const d = difference(h, before?.get(name));
    return {p50: quantile(d, 50) * 1000, p95: quantile(d, 95) * 1000, p99: quantile(d, 99) * 1000, count: d.count};
  };
  ctx.log(`  ws ${spec.name}: acked ${loadgen.opsAcked}/${loadgen.opsSent}, statuses ${JSON.stringify(loadgen.statuses)}, fan-out p99 ${read('collab_op_fanout_seconds').p99.toFixed(2)} ms, arrival p95 ${loadgen.arrival.p95.toFixed(2)} ms, loadgen ${loadgen.time?.cores.toFixed(2)} cores, peak sockets ${loadgen.peakStreams}`);
  return {loadgen, fanout: read('collab_op_fanout_seconds'), ack: read('collab_op_ack_seconds'), load: load.stop()};
}
export const wsPair = (ctx: BenchContext, wsBase: string) => wsScenario(ctx, wsBase, SCENARIOS.pair);

type Attempt = {ok: true; result: ScenarioResult} | {ok: false; error: unknown};
const reasonOf = (error: unknown) => String((error as {na?: string})?.na ?? (error as Error)?.message ?? error).slice(0, 200);

const run: Bench = async ctx => {
  const results: RowResult[] = [];
  const failed = (id: string, error: unknown) => results.push({id, na: `run failed: ${reasonOf(error)}`});
  const attempt = async (spec: Scenario): Promise<Attempt> => {
    try {
      return {ok: true, result: await scenario(ctx, spec)};
    } catch (error) {
      ctx.log(`collab-load: ${spec.name} failed: ${String((error as Error).stack ?? error)}`);
      return {ok: false, error};
    }
  };

  const collabWs = process.env.BENCH_COLLAB_WS;
  if (collabWs && wants(ctx, 'M1', 'M1b', 'M3')) {
    // Lane B1's collab service instead of the legacy server for the pair rows.
    try {
      const ws = await wsPair(ctx, collabWs);
      const prov = ws.load.provisional ? `load average up to ${ws.load.max.toFixed(1)}` : undefined;
      const note = `collab over WebSocket (${collabWs}, lane B1's service, JSON frames, in-memory journal until B2); 5 editors on f20k, loadgen statuses ${JSON.stringify(ws.loadgen.statuses)}, ${ws.loadgen.opsAcked}/${ws.loadgen.opsSent} acked`;
      if (wants(ctx, 'M1')) results.push(ws.fanout.count ? {id: 'M1', values: {p50: ws.fanout.p50, p95: ws.fanout.p95, p99: ws.fanout.p99}, provisional: prov, notes: [`M1: ${note}; collab_op_fanout_seconds, ${ws.fanout.count} ops`]} : {id: 'M1', na: `collab answered no fan-out (${note})`});
      if (wants(ctx, 'M1b')) results.push(ws.ack.count ? {id: 'M1b', values: {p50: ws.ack.p50, p95: ws.ack.p95, p99: ws.ack.p99}, provisional: prov, notes: [`M1b: collab_op_ack_seconds (in-memory journal: no PostgreSQL commit yet), ${ws.ack.count} ops`]} : {id: 'M1b', na: `collab answered no ack (${note})`});
      if (wants(ctx, 'M3')) results.push(ws.loadgen.arrival.count ? {id: 'M3', values: {p95: ws.loadgen.arrival.p95, p99: ws.loadgen.arrival.p99}, provisional: prov, notes: [`M3: loopback, no netem: op sent → change at each other editor over the socket, ${ws.loadgen.arrival.count} arrivals`]} : {id: 'M3', na: 'no change arrived over the socket'});
    } catch (error) {
      for (const id of ['M1', 'M1b', 'M3']) if (wants(ctx, id)) failed(id, error);
    }
    ctx.rows = ctx.rows.filter(row => !['M1', 'M1b', 'M3'].includes(row.id));
  }
  const pairAttempt = wants(ctx, 'M1', 'M1b', 'M3', 'M4', 'M12') ? await attempt(SCENARIOS.pair) : undefined;
  const pair = pairAttempt?.ok ? pairAttempt.result : undefined;
  if (pair) {
    const fan = h(pair.server.fanout).summary(), patch = h(pair.server.patch).summary();
    const prov = provisional(pair);
    if (wants(ctx, 'M1'))
      results.push(fan.count ? {id: 'M1', values: {p50: fan.p50, p95: fan.p95, p99: fan.p99}, provisional: prov, notes: [`M1: ${legacyNote}; ${fan.count} changes timed, server ${pair.serverShape}`], extra: {fanout: fan, fanoutFirst: h(pair.server.fanoutFirst).summary()}} : {id: 'M1', na: 'no change reached a peer'});
    if (wants(ctx, 'M1b'))
      results.push({id: 'M1b', values: {p50: patch.p50, p95: patch.p95, p99: patch.p99}, provisional: prov, notes: [`M1b: PATCH arrival → answer sent, server side (${patch.count} saves; statuses ${JSON.stringify(pair.server.patchByStatus)})`], extra: {patch, commit: h(pair.server.commit).summary()}});
  } else if (pairAttempt && !pairAttempt.ok) for (const id of ['M1', 'M1b']) if (wants(ctx, id)) failed(id, pairAttempt.error);

  if (wants(ctx, 'M2', 'M3', 'M11')) {
    const ruNetAttempt = ctx.netem && ctx.target !== 'local' ? await attempt(SCENARIOS.ruNet) : undefined;
    const ruNet = ruNetAttempt?.ok ? ruNetAttempt.result : undefined;
    if (ruNet) {
      const ack = ruNet.loadgen.ack, arrival = ruNet.loadgen.arrival, delivery = ruNet.loadgen.presenceDelivery;
      const prov = provisional(ruNet);
      const note = ctx.target === 'bench-ru'
        ? `ru-net VM: loadgen there, tc netem on its egress to bench-ru (${process.env.BENCH_NETEM_NOTE || '30 ms RTT, 0.1 % loss'})`
        : `ru-net stand-in: tc netem ${NETEM.delayMs} ms + ${NETEM.loss} loss on the server's answers in the dev-4 container; loadgen on the Mac host through Docker's port forward`;
      if (wants(ctx, 'M2')) results.push({id: 'M2', values: {p50: ack.p50, p95: ack.p95, p99: ack.p99}, provisional: prov, notes: [`M2: ${note}; ${ack.count} acks, statuses ${JSON.stringify(ruNet.loadgen.statuses)}`]});
      if (wants(ctx, 'M3')) results.push({id: 'M3', values: {p95: arrival.p95, p99: arrival.p99}, provisional: prov, notes: [`M3: op sent → change read at each other editor, ${arrival.count} arrivals; loopback without netem: p95 ${pair ? pair.loadgen.arrival.p95.toFixed(1) : '–'} ms`]});
      if (wants(ctx, 'M11')) results.push(delivery.count ? {id: 'M11', values: {p95: delivery.p95}, provisional: prov, notes: [`M11: cursor posted → seen by the others (legacy flushes presence every 40 ms), ${delivery.count} deliveries`]} : {id: 'M11', na: 'no presence delivered'});
    } else {
      const reason = ruNetAttempt && !ruNetAttempt.ok ? `run failed: ${reasonOf(ruNetAttempt.error)}` : 'needs the ru-net stand-in: tc netem in the dev-4 container (--machine dev-4)';
      for (const id of ['M2', 'M3', 'M11']) if (wants(ctx, id)) results.push({id, na: reason});
    }
  }

  if (wants(ctx, 'M4')) {
    const crowdAttempt = await attempt(SCENARIOS.crowd);
    const crowd = crowdAttempt.ok ? crowdAttempt.result : undefined;
    if (crowd && pair) {
      const m1 = h(crowd.server.fanout).summary(), base = h(pair.server.fanout).summary();
      const arrival = crowd.loadgen.arrival.p95, baseArrival = pair.loadgen.arrival.p95;
      results.push({id: 'M4', values: {m1p99Ratio: m1.p99 / base.p99, m3p95Ratio: arrival / baseArrival}, provisional: provisional(crowd, pair),
        notes: [`M4: 100 editors + 400 viewers on one f20k: M1 p99 ${m1.p99.toFixed(1)} ms vs ${base.p99.toFixed(1)} ms (pair); arrival p95 ${Number.isFinite(arrival) ? `${arrival.toFixed(1)} vs ${baseArrival.toFixed(1)} ms (loopback)` : `none of the window's acked changes reached the others before the run ended (${crowd.loadgen.changesReceived} changes and ${crowd.loadgen.presenceEntries} presence entries read, ${(crowd.server.sse.bytes / 2 ** 20).toFixed(0)} MB of stream written)`}; saves ${JSON.stringify(crowd.loadgen.statuses)}; stream drops ${crowd.loadgen.streamEnds}, byes ${JSON.stringify(crowd.loadgen.byes)}; per-file stream cap raised from 50 for the run`]});
    } else failed('M4', !crowdAttempt.ok ? crowdAttempt.error : 'the pair run failed');
  }

  if (wants(ctx, 'M5')) {
    const manyAttempt = await attempt(SCENARIOS.many);
    const many = manyAttempt.ok ? manyAttempt.result : undefined;
    if (many) {
      const fan = h(many.server.fanout).summary();
      results.push({id: 'M5', values: {m1p99: fan.count ? fan.p99 : NaN, cpu: serverCores(many.server)}, provisional: provisional(many),
          text: fan.count ? undefined : 'no change reached a peer',
          notes: [`M5: 2 000 editors over 400 f2k files (f20k × 400 = 6.4 GB does not fit dev-4); one Node process; saves ${JSON.stringify(many.loadgen.statuses)}; acked ${many.loadgen.opsAcked} of ${many.loadgen.opsSent} sent (${(many.loadgen.opsAcked / (windows(ctx, SCENARIOS.many).durationMs / 1000) ).toFixed(0)}/s); loadgen held ${many.loadgen.peakStreams} streams at ${(many.loadgen.time?.cores ?? many.loadgen.selfCores ?? NaN).toFixed(2)} cores`]});
    } else if (!manyAttempt.ok) failed('M5', manyAttempt.error);
  }

  if (wants(ctx, 'M6', 'M7')) {
    try {
      const memory = await memoryPerDocument(ctx);
      const ratio = memory.perDocMb / memory.jsonMb;
      const note = `M6/M7: ${memory.docs} f20k files (${memory.jsonMb.toFixed(1)} MB JSON each) created, opened and saved once, each with its stream open: V8 heap + external after GC ${(memory.held0 / 2 ** 20).toFixed(0)} → ${(memory.held1 / 2 ** 20).toFixed(0)} MB, ${memory.perDocMb.toFixed(1)} MB a document (RSS ${(memory.rss0 / 2 ** 20).toFixed(0)} → ${(memory.rss1 / 2 ** 20).toFixed(0)} MB: the allocator keeps what the 16 MB bodies took); legacy keeps at most 64 MB of parsed documents (DESIGN_DOCUMENT_CACHE_BYTES), so past 4 open f20k files every save reads and parses 16 MB again`;
      if (wants(ctx, 'M6')) results.push({id: 'M6', values: {residentRatio: ratio}, notes: [note]});
      if (wants(ctx, 'M7')) results.push({id: 'M7', values: {docsPerGB: 1024 / memory.perDocMb}, notes: wants(ctx, 'M6') ? [] : [note]});
      ctx.shared.set('collab:memory', memory);
    } catch (error) {
      for (const id of ['M6', 'M7']) if (wants(ctx, id)) failed(id, error);
    }
  }

  if (wants(ctx, 'M8')) {
    try {
      const caught = await catchUp(ctx);
      results.push({id: 'M8', values: {catchUp: caught.catchUpMs, converged: caught.convergedMs},
        provisional: caught.netem ? undefined : 'loopback, no ru-net stand-in (needs dev-4)',
        notes: [`M8: a stream resuming ${caught.missed} versions back on f20k, ${caught.netem ? `over the ru-net stand-in (netem ${NETEM.delayMs} ms + ${NETEM.loss})` : 'loopback'}: ${caught.resync ? 'legacy answers resync (its log keeps 512 changes), the editor reads the whole 16 MB file again (converged = that GET parsed)' : 'served from the log'}`]});
    } catch (error) {
      failed('M8', error);
    }
  }
  if (wants(ctx, 'M9')) results.push({id: 'M9', pass: false, text: 'legacy reloads whenever its log lacks the changes: past 512 changes or 8 MB per file (DESIGN_LIVE_LIMITS), not 20 000 ops / 5 MB'});

  if (wants(ctx, 'M10')) {
    const cursorsAttempt = await attempt(SCENARIOS.cursors);
    const cursors = cursorsAttempt.ok ? cursorsAttempt.result : undefined;
    if (cursors) {
      results.push({id: 'M10', values: {cpu: serverCores(cursors.server), receiverHz: cursors.loadgen.receiverHzMedian ?? NaN}, provisional: provisional(cursors),
        notes: [`M10: 1 000 people in 200 files of 5, cursors at 30 Hz, no ops: posts ${JSON.stringify(cursors.loadgen.presenceStatuses)}, ${cursors.loadgen.presenceCoalesced} ticks coalesced behind a post in flight; receiver rate median ${cursors.loadgen.receiverHzMedian?.toFixed(1)} / max ${cursors.loadgen.receiverHzMax?.toFixed(1)} Hz per peer`]});
    } else if (!cursorsAttempt.ok) failed('M10', cursorsAttempt.error);
  }

  if (wants(ctx, 'M12')) {
    const slowAttempt = await attempt(SCENARIOS.slow);
    const slow = slowAttempt.ok ? slowAttempt.result : undefined;
    if (slow && pair) {
      const m1 = h(slow.server.fanout).summary().p99 / h(pair.server.fanout).summary().p99;
      const m3 = slow.loadgen.arrival.p95 / pair.loadgen.arrival.p95;
      const pass = m1 <= 1.2 && m3 <= 1.2;
      results.push({id: 'M12', pass, provisional: provisional(slow, pair), text: `others' M1 p99 ×${m1.toFixed(2)}, M3 p95 ×${m3.toFixed(2)} of the pair run; slow viewer: ${JSON.stringify(slow.loadgen.byes)} byes, ${slow.loadgen.streamEnds} stream ends`});
    } else failed('M12', !slowAttempt.ok ? slowAttempt.error : 'the pair run failed');
  }
  return fillNa(ctx, results, 'not run');
};

export default run;
await runStandalone('collab-load', run, import.meta.url);
