// The TARGETS rows on the Rust collab path (lane B5, at the coordinator's request of 2026-10-08): what the closing run
// measures with `--path collab`. Every scenario runs the bench api (scripts/bench/server.ts) with DESIGN_COLLAB=rust and
// one or two `morfa-collab` nodes on the same fresh database (B2's journal, leases and checkpoint records in PostgreSQL;
// checkpoints in S3 when BENCH_S3_* is set — bench-ru's MinIO — else in a directory). Editors get their tickets from
// GET /api/design-files/:id/session and speak the socket's JSON wire (crates/loadgen `ws`, or lib/collab-editor.ts where a
// client must reconnect). Server numbers come from the node's /metrics over the measured window; CPU and memory from its
// process_* metrics. Rows the collab service cannot do yet stay n.a. and say what refuses them; nothing falls back to the
// legacy path (that is `--path legacy`, a separate report).
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {applyNetem} from './collab-load';
import {pgFreezer} from './durability';
import {CollabEditor, missingAcks} from './lib/collab-editor';
import {fillNa, wants, type Bench, type BenchContext} from './lib/context';
import {accounts, api, cookieOf, fixtureDocument, fixtureText, layersFor, sharedFile, type Account, type SharedFile} from './lib/fixtures';
import {LOADGEN_BOUND_SHARE, LOADGEN_HOST_CORES, runLoadgen, type LoadgenConfig, type LoadgenReport} from './lib/loadgen';
import {LoadWatch, sleep} from './lib/machine';
import {difference, parsePrometheus, quantile} from './lib/prometheus';
import {startServer, type BenchServer} from './lib/server';
import {median} from './lib/stats';
import type {RowResult} from './lib/targets';
import {freePort, startCollab, ticketKeys, type Collab} from '../../tests/helpers/collab-binary';

export const COLLAB_PATH = 'collab: DESIGN_COLLAB=rust, /session tickets, the node\'s WebSocket (JSON wire), journal in PostgreSQL';
const RUB_PER_VM = Number(process.env.BENCH_RUB_PER_8x16 || 4300);
const EDITORS_K1 = 1000, PER_FILE = 5;

type Scrape = {histograms: ReturnType<typeof parsePrometheus>['histograms']; values: Map<string, number>; at: number};
type Window = {p50: number; p95: number; p99: number; count: number};

export type Rig = {server: BenchServer; nodes: Collab[]; s3: boolean; restart(index: number): Promise<Collab>; stop(): Promise<void>};

/** The api in rust mode and `count` collab nodes (named a, b, …) on one fresh database. */
async function rig(ctx: BenchContext, count = 1): Promise<Rig> {
  if (ctx.target === 'dev-4') throw Object.assign(Error('collab path'), {na: 'the collab path runs on bench-ru (or locally), not in dev-4'});
  const names = 'abcdefgh'.slice(0, count).split('');
  // bench-ru: fixed ports inside 3400–3499, the range ufw opens to ru-net (loadgen connects to the nodes from there).
  const ports = ctx.target === 'bench-ru' ? names.map((_, i) => 3430 + i) : await Promise.all(names.map(() => freePort()));
  const secret = 'bench-' + randomUUID();
  const keys = ticketKeys();
  const s3 = process.env.BENCH_S3_ENDPOINT
    ? {endpoint: process.env.BENCH_S3_ENDPOINT, region: process.env.BENCH_S3_REGION || 'ru-1', bucket: process.env.BENCH_S3_BUCKET || '', access: process.env.BENCH_S3_ACCESS_KEY || '', secret: process.env.BENCH_S3_SECRET_KEY || ''}
    : null;
  const checkpointDir = s3 ? null : mkdtempSync(path.join(tmpdir(), 'b5-collab-ckpt-'));
  const store: Record<string, string> = s3
    ? {DESIGN_BLOBS: 's3', DESIGN_S3_ENDPOINT: s3.endpoint, DESIGN_S3_REGION: s3.region, DESIGN_S3_BUCKET: s3.bucket, DESIGN_S3_ACCESS_KEY: s3.access, DESIGN_S3_SECRET_KEY: s3.secret}
    : {DESIGN_CHECKPOINT_DIR: checkpointDir!};
  const server = await startServer({
    target: ctx.target, source: ctx.source, log: ctx.log,
    env: {
      DESIGN_COLLAB: 'rust',
      DESIGN_COLLAB_NODES: names.map((name, i) => `${name}=http://127.0.0.1:${ports[i]}|ws://127.0.0.1:${ports[i]}`).join(','),
      DESIGN_COLLAB_INTERNAL_SECRET: secret,
      DESIGN_COLLAB_TICKET_KEY: keys.privateKey,
      ...store,
    },
  });
  const start = (i: number) => startCollab({
    port: ports[i], secret, keys, node: names[i], pgUrl: server.databaseUrl, apiUrl: server.base, ...(checkpointDir ? {checkpointDir} : {}),
    env: {
      // bench-ru: every interface, so loadgen on ru-net reaches the node (ufw admits only ru-net); one shard per core.
      MORFA_COLLAB_ADDR: `${ctx.target === 'bench-ru' ? '0.0.0.0' : '127.0.0.1'}:${ports[i]}`,
      MORFA_COLLAB_SHARDS: '',
      MORFA_COLLAB_DRAIN_NOTICE_MS: '0',
      ...(s3 ? {MORFA_COLLAB_S3_ENDPOINT: s3.endpoint, MORFA_COLLAB_S3_REGION: s3.region, MORFA_COLLAB_S3_BUCKET: s3.bucket, MORFA_COLLAB_S3_ACCESS_KEY: s3.access, MORFA_COLLAB_S3_SECRET_KEY: s3.secret} : {}),
    },
  });
  const nodes: Collab[] = [];
  try {
    for (let i = 0; i < names.length; i++) nodes.push(await start(i));
  } catch (error) {
    await server.stop();
    throw error;
  }
  return {
    server, nodes, s3: !!s3,
    /** kill -9 of node `index` (no drain, no checkpoint), then the same node (name, port, keys) started again. */
    async restart(index: number) {
      const child = nodes[index].child;
      const exited = new Promise(resolve => (child.exitCode !== null || child.signalCode !== null ? resolve(null) : child.once('exit', resolve)));
      child.kill('SIGKILL');
      await exited;
      nodes[index] = await start(index);
      return nodes[index];
    },
    async stop() {
      // D5: the checkpoints this rig's files point at, read back and checked (and the nodes' own failure counters, when the
      // commit has them).
      const verified = await verifyCheckpoints(server, store).catch(error => ({total: 0, ok: 0, failures: [String((error as Error).message ?? error).slice(0, 120)]}));
      const tally = (ctx.shared.get('collab-path:checkpoints') as {total: number; ok: number; failed: number; failures: string[]} | undefined) ?? {total: 0, ok: 0, failed: 0, failures: []};
      tally.total += verified.total;
      tally.ok += verified.ok;
      tally.failures.push(...verified.failures);
      for (const node of nodes) {
        const scraped = await scrape(node).catch(() => null);
        tally.failed += scraped?.values.get('collab_checkpoint_failures_total') ?? 0;
      }
      ctx.shared.set('collab-path:checkpoints', tally);
      for (const node of nodes) await node.stop().catch(() => {});
      await server.stop();
      if (checkpointDir) rmSync(checkpointDir, {recursive: true, force: true});
    },
  };
}

/** CPU seconds and resident bytes of a process from /proc (Linux): the node's own process_* metrics exist only from lane B5's
 *  collab on, and the commit under test may predate them. */
function procUsage(pid: number | undefined): {cpu: number; rss: number} | null {
  if (!pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cpu = (Number(fields[11]) + Number(fields[12])) / 100;
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]);
    return {cpu, rss: rssKb * 1024};
  } catch {
    return null;
  }
}

async function scrape(node: Collab): Promise<Scrape> {
  const text = await (await fetch(node.url + '/metrics')).text();
  const {histograms, values} = parsePrometheus(text);
  const usage = procUsage(node.child.pid);
  if (usage && !values.has('process_cpu_seconds_total')) values.set('process_cpu_seconds_total', usage.cpu);
  if (usage && !values.has('process_resident_memory_bytes')) values.set('process_resident_memory_bytes', usage.rss);
  return {histograms, values, at: performance.now()};
}

/** D5: every checkpoint the run's files point at, read back and checked as api reads it (server/design/collab/checkpoint.ts:
 *  the MRFC header's sha256 over the stored body, the decode, the recorded version). */
async function verifyCheckpoints(server: BenchServer, store: Record<string, string>): Promise<{total: number; ok: number; failures: string[]}> {
  const saved = Object.fromEntries(Object.keys(store).map(key => [key, process.env[key]]));
  Object.assign(process.env, store);
  process.env.MORFA_DATABASE_URL ||= server.databaseUrl;
  const pg = (await import('pg')).default;
  const client = new pg.Client({connectionString: server.databaseUrl});
  await client.connect();
  const failures: string[] = [];
  let total = 0, ok = 0;
  try {
    const {loadCheckpoint} = await import('../../server/design/collab/checkpoint');
    const rows = (await client.query('SELECT id, checkpoint_key, checkpoint_version FROM design_files WHERE checkpoint_key IS NOT NULL')).rows as {id: string; checkpoint_key: string; checkpoint_version: string}[];
    for (const row of rows) {
      total++;
      try {
        await loadCheckpoint(row.checkpoint_key, Number(row.checkpoint_version));
        ok++;
      } catch (error) {
        if (failures.length < 3) failures.push(`${row.checkpoint_key}: ${String((error as Error).message ?? error).slice(0, 80)}`);
      }
    }
  } finally {
    await client.end();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return {total, ok, failures};
}
function window(before: Scrape | null, after: Scrape, name: string): Window {
  const h = after.histograms.get(name);
  if (!h) return {p50: NaN, p95: NaN, p99: NaN, count: 0};
  const d = difference(h, before?.histograms.get(name));
  return {p50: quantile(d, 50) * 1000, p95: quantile(d, 95) * 1000, p99: quantile(d, 99) * 1000, count: d.count};
}
const cores = (before: Scrape, after: Scrape) =>
  ((after.values.get('process_cpu_seconds_total') ?? NaN) - (before.values.get('process_cpu_seconds_total') ?? NaN)) / ((after.at - before.at) / 1000);
const rss = (s: Scrape) => s.values.get('process_resident_memory_bytes') ?? NaN;

async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(width, items.length)}, async () => {
    for (let index = next++; index < items.length; index = next++) out[index] = await work(items[index]);
  }));
  return out;
}

type Session = {wsUrl: string; ticket: string; node: string};
async function session(server: BenchServer, who: Account, fileId: string): Promise<Session> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = await api(server, who, 'GET', `/api/design-files/${fileId}/session`);
    if (answer.status === 200) return JSON.parse(answer.text) as Session;
    await sleep(200 * (attempt + 1));
  }
  throw Error(`/session for ${fileId} failed`);
}

// ── Load scenarios (crates/loadgen ws) ────────────────────────────────────────────────────────────

type Spec = {name: string; fixture: string; files: number; editors: number; viewers?: number; cursorHz: number; ops: boolean; presenceProbe?: boolean; slowViewer?: boolean; durationMs?: number; netem?: boolean};
const SPECS = {
  pair: {name: 'pair', fixture: 'f20k', files: 1, editors: 5, cursorHz: 30, ops: true, presenceProbe: true},
  ruNet: {name: 'ru-net', fixture: 'f20k', files: 1, editors: 5, cursorHz: 30, ops: true, presenceProbe: true, netem: true},
  slow: {name: 'slow', fixture: 'f20k', files: 1, editors: 5, cursorHz: 30, ops: true, slowViewer: true},
  crowd: {name: 'crowd', fixture: 'f20k', files: 1, editors: 100, viewers: 400, cursorHz: 30, ops: true, durationMs: 20_000},
  many: {name: 'many', fixture: 'f2k', files: 400, editors: 5, cursorHz: 30, ops: true},
  cursors: {name: 'cursors', fixture: 'f2k', files: 200, editors: 5, cursorHz: 30, ops: false},
} satisfies Record<string, Spec>;

export type LoadResult = {spec: Spec; loadgen: LoadgenReport; fanout: Window; ack: Window; commit: Window; cores: number; rssMb: number; walBytes: number | null; netem: boolean; load: ReturnType<LoadWatch['result']>; s3: boolean};

function windows(ctx: BenchContext, spec: Spec) {
  const people = spec.files * (spec.editors + (spec.viewers ?? 0));
  if (ctx.quick) return {durationMs: 8_000, rampMs: Math.min(4_000, 500 + people), warmupMs: 2_000};
  return {durationMs: spec.durationMs ?? 30_000, rampMs: Math.min(15_000, 2_000 + people * 5), warmupMs: 5_000};
}

async function walBytes(databaseUrl: string): Promise<number | null> {
  const pg = (await import('pg')).default;
  const client = new pg.Client({connectionString: databaseUrl});
  try {
    await client.connect();
    return Number((await client.query('SELECT wal_bytes FROM pg_stat_wal')).rows[0].wal_bytes);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function loadScenario(ctx: BenchContext, spec: Spec): Promise<LoadResult> {
  const key = `collab-path:${spec.name}`;
  const cached = ctx.shared.get(key) as LoadResult | undefined;
  if (cached) return cached;
  const r = await rig(ctx);
  const [node] = r.nodes;
  let netem = false;
  try {
    ctx.log(`collab-path: ${spec.name} — ${spec.files} × (${spec.editors} editors + ${spec.viewers ?? 0} viewers${spec.slowViewer ? ' + a 64 kbit/s viewer' : ''}) on ${spec.fixture}, ${r.server.shape}`);
    const perFile = spec.editors + (spec.viewers ?? 0) + (spec.slowViewer ? 1 : 0);
    const people = await accounts(r.server, spec.files * perFile, spec.name);
    const files: SharedFile[] = await pool(Array.from({length: spec.files}, (_, i) => i), 8, i =>
      sharedFile(r.server, spec.fixture, spec.editors, (spec.viewers ?? 0) + (spec.slowViewer ? 1 : 0), people.slice(i * perFile, (i + 1) * perFile)));
    const doc = fixtureDocument(spec.fixture);
    const {durationMs, rampMs, warmupMs} = windows(ctx, spec);
    // Tickets live 60 s: they are taken right before loadgen starts (/session also takes each file's lease for the node).
    const sessions = await pool(files.flatMap(file => [...file.editors, ...file.viewers].map(who => ({file, who}))), 32, async ({file, who}) => ({file, who, s: await session(r.server, who, file.id)}));
    const wsBase = sessions[0].s.wsUrl.replace(/\/collab\/.*$/, '');
    const config: LoadgenConfig = {
      mode: 'ws', base: wsBase, wsPath: '/collab/{file}?wire=json', durationMs, rampMs, warmupMs, opIntervalMs: 1000, cursorHz: spec.cursorHz,
      presenceProbe: spec.presenceProbe, threads: 2,
      files: files.map(file => {
        const mine = sessions.filter(entry => entry.file === file);
        return {
          id: file.id, version: file.version,
          editors: mine.map((entry, k) => {
            const editor = k < spec.editors;
            const slow = spec.slowViewer && k === mine.length - 1;
            return {role: editor ? 'editor' as const : 'viewer' as const, ticket: entry.s.ticket, clientId: `lg-${k}-${file.id.slice(0, 8)}`,
              nodes: editor && spec.ops ? layersFor(doc, k) : [], ...(slow ? {readBytesPerSecond: 8_000, quiet: true} : {})};
          }),
        };
      }),
    };
    if (spec.netem) {
      netem = await applyNetem(r.server, true);
      if (!netem) throw Object.assign(Error('netem unavailable'), {na: 'needs ru-net (bench-ru) for the netem profile'});
    }
    const load = new LoadWatch();
    let before: Scrape | null = null, wal0: number | null = null;
    const windowStart = setTimeout(() => {
      void scrape(node).then(s => (before = s));
      void walBytes(r.server.databaseUrl).then(w => (wal0 = w));
    }, rampMs + warmupMs);
    const loadgen = await runLoadgen(config, path.join(ctx.outDir, `loadgen-collab-${spec.name}.json`), ctx.log);
    clearTimeout(windowStart);
    const after = await scrape(node);
    const wal1 = await walBytes(r.server.databaseUrl);
    const start = before ?? after;
    const result: LoadResult = {
      spec, loadgen, netem, s3: r.s3, load: load.stop(),
      fanout: window(before, after, 'collab_op_fanout_seconds'),
      ack: window(before, after, 'collab_op_ack_seconds'),
      commit: window(before, after, 'collab_journal_commit_seconds'),
      cores: before ? cores(start, after) : NaN,
      rssMb: rss(after) / 2 ** 20,
      walBytes: wal0 !== null && wal1 !== null ? wal1 - wal0 : null,
    };
    writeFileSync(path.join(ctx.outDir, `collab-${spec.name}.json`), JSON.stringify({...result, loadgen: undefined}, null, 1));
    ctx.log(`  ${spec.name}: acked ${loadgen.opsAcked}/${loadgen.opsSent}, statuses ${JSON.stringify(loadgen.statuses)}, byes ${JSON.stringify(loadgen.byes)}, fan-out p99 ${result.fanout.p99.toFixed(2)} ms, ack p99 ${result.ack.p99.toFixed(2)} ms, arrival p95 ${loadgen.arrival.p95.toFixed(1)} ms, collab ${result.cores.toFixed(2)} cores, ${result.rssMb.toFixed(0)} MB, peak sockets ${loadgen.peakStreams}`);
    ctx.shared.set(key, result);
    return result;
  } finally {
    if (netem) await applyNetem(r.server, false);
    await r.stop();
  }
}

// ── Memory, catch-up (lib/collab-editor) ─────────────────────────────────────────────────────────────

export type Memory = {docs: number; jsonMb: number; perDocMb: number; residentMb: number; rss0: number; rss1: number};
async function memory(ctx: BenchContext): Promise<Memory> {
  const cached = ctx.shared.get('collab-path:memory') as Memory | undefined;
  if (cached) return cached;
  const r = await rig(ctx);
  try {
    const docs = ctx.quick ? 3 : 8;
    const files: SharedFile[] = [];
    for (let i = 0; i < docs; i++) files.push(await sharedFile(r.server, 'f20k', 1));
    await sleep(1000);
    const before = await scrape(r.nodes[0]);
    const editors = files.map(file => Object.assign(new CollabEditor(r.server, file.owner, file.id), {known: file.version}));
    for (const editor of editors) await editor.connect();
    await sleep(3000);
    const after = await scrape(r.nodes[0]);
    for (const editor of editors) editor.leave();
    const jsonMb = Buffer.byteLength(fixtureText('f20k')) / 2 ** 20;
    const result = {docs, jsonMb, perDocMb: (rss(after) - rss(before)) / docs / 2 ** 20, residentMb: (after.values.get('collab_doc_resident_bytes') ?? NaN) / docs / 2 ** 20, rss0: rss(before), rss1: rss(after)};
    ctx.shared.set('collab-path:memory', result);
    return result;
  } finally {
    await r.stop();
  }
}

/** M8/M9: an editor away while another makes `ops` edits, then back with `since`: catch-up from the node, or a reload. */
async function catchUp(ctx: BenchContext): Promise<{small: {ops: number; serverMs: number; convergedMs: number; resync: boolean; bytes: number}; large: {ops: number; resync: boolean; mb: number}}> {
  const r = await rig(ctx);
  try {
    const file = await sharedFile(r.server, 'f20k', 2);
    const doc = fixtureDocument('f20k');
    const [watcherAccount, senderAccount] = file.editors;
    const sender = Object.assign(new CollabEditor(r.server, senderAccount, file.id), {known: file.version});
    await sender.connect();
    let sentBytes = 0;
    const away = async (ops: number, layers: number) => {
      sentBytes = 0;
      const watcher = Object.assign(new CollabEditor(r.server, watcherAccount, file.id), {known: sender.known});
      await watcher.connect();
      const since = watcher.known;
      watcher.leave();
      let nodes = layersFor(doc, 1, layers);
      // Under the node's 50 ops a second per client.
      for (let i = 0; i < ops; i++) {
        sender.move(nodes);
        sentBytes += sender.unacked.get(sender.seq)?.length ?? 0;
        nodes = nodes.map(node => ({...node, x: sender.seq}));
        await sleep(25);
      }
      await sender.settled(60_000);
      return {since, target: sender.known, bytes: 0};
    };
    // (a) 1 000 one-layer edits: a catch-up from the node (TARGETS M8).
    const a = await away(ctx.quick ? 200 : 1000, 1);
    const before = await scrape(r.nodes[0]);
    const back = new CollabEditor(r.server, watcherAccount, file.id);
    back.known = a.since;
    // From the hello to the last missed change applied at the client.
    let converged = NaN;
    const reached = new Promise<void>(resolve => {
      back.onVersion = (version, at) => {
        if (version >= a.target && Number.isNaN(converged)) {
          converged = at - back.helloAt;
          resolve();
        }
      };
    });
    await back.connect();
    await Promise.race([reached, sleep(30_000)]);
    const after = await scrape(r.nodes[0]);
    const small = {ops: ctx.quick ? 200 : 1000, serverMs: window(before, after, 'collab_catchup_seconds').p50, convergedMs: converged, resync: back.resyncs > 0, bytes: 0};
    back.leave();
    // (b) 800 edits of 48 layers each (well over 5 MB of changes): the node answers with the whole document (TARGETS M9).
    const largeOps = 800;
    const b = await away(largeOps, 48);
    const largeMb = sentBytes / 2 ** 20;
    const again = new CollabEditor(r.server, watcherAccount, file.id);
    again.known = b.since;
    await again.connect();
    const large = {ops: largeOps, resync: again.resyncs > 0, mb: largeMb};
    again.leave();
    sender.leave();
    return {small, large};
  } finally {
    await r.stop();
  }
}

const net = (result: LoadResult) => (result.netem ? `over ru-net (${process.env.BENCH_NETEM_NOTE || 'netem 30 ms RTT, 0.1 % loss'})` : 'loadgen on ru-net without netem');
/** A row is provisional when its own scenario's loadgen used more than 70 % of ru-net's cores (or the load was high). */
const provOf = (...results: LoadResult[]) => {
  const reasons: string[] = [];
  for (const result of results) {
    const used = result.loadgen.time?.cores ?? result.loadgen.selfCores ?? 0;
    if (used / LOADGEN_HOST_CORES > LOADGEN_BOUND_SHARE) reasons.push(`loadgen-bound (${result.spec.name}: ${used.toFixed(2)} of ${LOADGEN_HOST_CORES} cores)`);
    if (result.load.provisional) reasons.push(`load average up to ${result.load.max.toFixed(1)}`);
  }
  return reasons.length ? [...new Set(reasons)].join('; ') : undefined;
};
/** What loadgen received a second over the window (ru-net's link carries about 120 MB/s, iperf3: 981 Mbit/s). */
const inbound = (result: LoadResult) => `loadgen received ${(result.loadgen.bytesIn / (result.loadgen.wallMs / 1000) / 2 ** 20).toFixed(0)} MB/s`;
// `loadgenMarked`: this module marks loadgen-bound rows per scenario, so scripts/bench/targets.ts does not mark the whole bench.
const tag = (results: RowResult[]) => results.map(result => ({...result, path: result.path ?? 'collab', extra: {...result.extra, loadgenMarked: true}}));

const collabLoad: Bench = async ctx => {
  const results: RowResult[] = [];
  const failed = (ids: string[], error: unknown) => {
    const reason = String((error as {na?: string}).na ?? (error as Error).message ?? error).slice(0, 200);
    ctx.log(`collab-path failed: ${String((error as Error).stack ?? error)}`);
    for (const id of ids) if (wants(ctx, id)) results.push({id, na: (error as {na?: string}).na ?? `run failed: ${reason}`});
  };
  const attempt = async <T>(ids: string[], work: () => Promise<T>): Promise<T | undefined> => {
    if (!wants(ctx, ...ids)) return undefined;
    try {
      return await work();
    } catch (error) {
      failed(ids, error);
      return undefined;
    }
  };
  const pair = await attempt(['M1', 'M1b', 'M4', 'M12', 'K1', 'K2', 'K3'], () => loadScenario(ctx, SPECS.pair));
  if (pair) {
    const note = `${COLLAB_PATH}; 5 editors on one f20k file, 1 op/s of 20 moved layers each and cursors at 30 Hz, ${net(pair)}; ${pair.loadgen.opsAcked}/${pair.loadgen.opsSent} acked, byes ${JSON.stringify(pair.loadgen.byes)}`;
    if (wants(ctx, 'M1')) results.push(pair.fanout.count ? {id: 'M1', values: {p50: pair.fanout.p50, p95: pair.fanout.p95, p99: pair.fanout.p99}, provisional: provOf(pair), notes: [`M1: ${note}; collab_op_fanout_seconds over the window (${pair.fanout.count} ops; Prometheus buckets, interpolated)`]} : {id: 'M1', na: 'no op reached the node'});
    if (wants(ctx, 'M1b')) results.push(pair.ack.count ? {id: 'M1b', values: {p50: pair.ack.p50, p95: pair.ack.p95, p99: pair.ack.p99}, provisional: provOf(pair), notes: [`M1b: collab_op_ack_seconds (ack after the group commit to PostgreSQL), ${pair.ack.count} acks; journal commit p50/p99 ${pair.commit.p50.toFixed(2)}/${pair.commit.p99.toFixed(2)} ms`]} : {id: 'M1b', na: 'no ack'});
  }
  const ruNet = await attempt(['M2', 'M3', 'M11'], () => loadScenario(ctx, SPECS.ruNet));
  if (ruNet) {
    const ack = ruNet.loadgen.ack, arrival = ruNet.loadgen.arrival, delivery = ruNet.loadgen.presenceDelivery;
    if (wants(ctx, 'M2')) results.push({id: 'M2', values: {p50: ack.p50, p95: ack.p95, p99: ack.p99}, provisional: provOf(ruNet), notes: [`M2: op sent → ack at the editor, ${COLLAB_PATH}, ${net(ruNet)}; ${ack.count} acks`]});
    if (wants(ctx, 'M3')) results.push({id: 'M3', values: {p95: arrival.p95, p99: arrival.p99}, provisional: provOf(ruNet), notes: [`M3: op sent → change read at each other editor, ${net(ruNet)}; ${arrival.count} arrivals${pair ? `; without netem p95 ${pair.loadgen.arrival.p95.toFixed(1)} ms` : ''}`]});
    if (wants(ctx, 'M11')) results.push(delivery.count ? {id: 'M11', values: {p95: delivery.p95}, provisional: provOf(ruNet), notes: [`M11: cursor sent → seen by the others (the node coalesces presence ≤ 30 Hz per receiver), ${net(ruNet)}; ${delivery.count} deliveries`]} : {id: 'M11', na: 'no presence delivered'});
  }
  const crowd = await attempt(['M4'], () => loadScenario(ctx, SPECS.crowd));
  if (crowd && pair && wants(ctx, 'M4'))
    results.push({id: 'M4', values: {m1p99Ratio: crowd.fanout.p99 / pair.fanout.p99, m3p95Ratio: crowd.loadgen.arrival.p95 / pair.loadgen.arrival.p95}, provisional: provOf(crowd, pair),
      notes: [`M4: 100 editors + 400 viewers on one f20k (${COLLAB_PATH}): M1 p99 ${crowd.fanout.p99.toFixed(2)} vs ${pair.fanout.p99.toFixed(2)} ms (pair), arrival p95 ${crowd.loadgen.arrival.p95.toFixed(1)} vs ${pair.loadgen.arrival.p95.toFixed(1)} ms; ${crowd.loadgen.opsAcked}/${crowd.loadgen.opsSent} acked, byes ${JSON.stringify(crowd.loadgen.byes)}; collab ${crowd.cores.toFixed(2)} cores; loadgen held ${crowd.loadgen.peakStreams} sockets, ${inbound(crowd)} (500 receivers of 100 changes a second on the JSON wire need far more than the bench link; the binary wire is 0.19× of it, W3)`]});
  const many = await attempt(['M5', 'D1'], () => loadScenario(ctx, SPECS.many));
  if (many && wants(ctx, 'M5'))
    results.push({id: 'M5', values: {m1p99: many.fanout.p99, cpu: many.cores}, provisional: provOf(many),
      notes: [`M5: 2 000 editors over 400 f2k files (${COLLAB_PATH}; f2k as in the legacy run: 400 × f20k = 6.4 GB of documents); ${many.loadgen.opsAcked}/${many.loadgen.opsSent} acked (${JSON.stringify(many.loadgen.statuses)}), byes ${JSON.stringify(many.loadgen.byes)}; collab ${many.cores.toFixed(2)} cores, ${many.rssMb.toFixed(0)} MB; loadgen held ${many.loadgen.peakStreams} sockets, ${inbound(many)}`]});
  const mem = await attempt(['M6', 'M7', 'K1', 'K2'], () => memory(ctx));
  if (mem) {
    const note = `M6/M7: ${mem.docs} f20k files (${mem.jsonMb.toFixed(1)} MB JSON each) opened on one node by one editor each (${COLLAB_PATH}): node RSS ${(mem.rss0 / 2 ** 20).toFixed(0)} → ${(mem.rss1 / 2 ** 20).toFixed(0)} MB, ${mem.perDocMb.toFixed(1)} MB a document (the engine's own estimate collab_doc_resident_bytes: ${mem.residentMb.toFixed(1)} MB)`;
    if (wants(ctx, 'M6')) results.push({id: 'M6', values: {residentRatio: mem.perDocMb / mem.jsonMb}, notes: [note]});
    if (wants(ctx, 'M7')) results.push({id: 'M7', values: {docsPerGB: 1024 / mem.perDocMb}, notes: wants(ctx, 'M6') ? [] : [note]});
  }
  const caught = await attempt(['M8', 'M9'], () => catchUp(ctx));
  if (caught) {
    if (wants(ctx, 'M8')) results.push({id: 'M8', values: {catchUp: caught.small.serverMs, converged: caught.small.convergedMs},
      provisional: 'the reconnecting client runs on bench-ru (loopback), not over ru-net: add ~1 RTT (30 ms) for the hello and the stream\'s transfer at ru-net\'s 1 Gbit/s',
      notes: [`M8: an editor away while ${caught.small.ops} one-layer edits landed on f20k, back with \`since\` (${COLLAB_PATH}): collab_catchup_seconds ${caught.small.serverMs.toFixed(2)} ms, hello → the last change applied ${caught.small.convergedMs.toFixed(0)} ms, ${caught.small.resync ? 'answered with a reload (resync)' : 'served from the node\'s tail (no reload)'}`]});
    // The rule: a reload ONLY past 5 MB / 20 000 ops of missed changes. Below it the node must catch up; above it a catch-up is
    // still allowed (the node keeps up to 64 MB / 20 000 entries in memory), so the large case is reported, not judged.
    if (wants(ctx, 'M9')) results.push({id: 'M9', pass: !caught.small.resync,
      text: `${caught.small.ops} one-layer edits away → ${caught.small.resync ? 'reload' : 'catch-up'}; ${caught.large.ops} edits of 48 layers away (${caught.large.mb.toFixed(1)} MB as sent) → ${caught.large.resync ? 'reload' : 'catch-up'}; the node's limits: CATCHUP_MAX_BYTES 5 MB of stored changes, CATCHUP_MAX_OPS 20 000 (crates/collab/src/catchup.rs)`});
  }
  const cursors = await attempt(['M10'], () => loadScenario(ctx, SPECS.cursors));
  if (cursors && wants(ctx, 'M10'))
    results.push({id: 'M10', values: {cpu: cursors.cores, receiverHz: cursors.loadgen.receiverHzMedian ?? NaN}, provisional: provOf(cursors),
      notes: [`M10: 1 000 people in 200 f2k files of 5, cursors at 30 Hz, no ops (${COLLAB_PATH}): collab ${cursors.cores.toFixed(2)} cores; receiver rate median ${cursors.loadgen.receiverHzMedian?.toFixed(1)} / max ${cursors.loadgen.receiverHzMax?.toFixed(1)} Hz per peer`]});
  const slow = await attempt(['M12'], () => loadScenario(ctx, SPECS.slow));
  if (slow && pair && wants(ctx, 'M12')) {
    const m1 = slow.fanout.p99 / pair.fanout.p99, m3 = slow.loadgen.arrival.p95 / pair.loadgen.arrival.p95;
    results.push({id: 'M12', pass: m1 <= 1.2 && m3 <= 1.2, provisional: provOf(slow, pair),
      text: `others' M1 p99 ×${m1.toFixed(2)}, M3 p95 ×${m3.toFixed(2)} of the pair run; the 64 kbit/s viewer: byes ${JSON.stringify(slow.loadgen.byes)} (${COLLAB_PATH}; loadgen ws reads that socket at 8 KB/s)`});
  }
  return tag(fillNa(ctx, results, 'not run'));
};

// ── Durability ───────────────────────────────────────────────────────────────────────────────────

/** Editors moving their own layer once a second on `files` (the first f20k, the rest f2k), through lib/collab-editor. */
async function editing(r: Rig, files: number, perFile: number) {
  const shared: SharedFile[] = [];
  for (let i = 0; i < files; i++) shared.push(await sharedFile(r.server, i === 0 ? 'f20k' : 'f2k', perFile));
  const editors = shared.flatMap(file => file.editors.map((who, k) => ({editor: Object.assign(new CollabEditor(r.server, who, file.id), {known: file.version}), layer: layersFor(fixtureDocument(file.fixture), k, 1), file})));
  await Promise.all(editors.map(e => e.editor.connect()));
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const e of editors) {
        e.editor.move(e.layer);
        e.layer = e.layer.map(node => ({...node, x: e.editor.seq}));
      }
      await sleep(1000);
    }
  })();
  return {editors, shared, stop: async () => {
    running = false;
    await loop;
  }};
}

/** D2: kill -9 of the node holding most files while 50 editors edit; their clients come back through /session. */
async function killUnderLoad(ctx: BenchContext): Promise<RowResult> {
  const r = await rig(ctx, 2);
  try {
    const work = await editing(r, ctx.quick ? 4 : 10, 5);
    await sleep(ctx.quick ? 4_000 : 10_000);
    const byNode = new Map<string, number>();
    for (const e of work.editors) byNode.set(e.editor.node, (byNode.get(e.editor.node) ?? 0) + 1);
    const victimName = [...byNode.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const victim = r.nodes.find(node => node.node === victimName)!;
    const affected = work.editors.filter(e => e.editor.node === victimName);
    const killedAt = performance.now();
    victim.child.kill('SIGKILL');
    await sleep(ctx.quick ? 10_000 : 20_000);
    await work.stop();
    await Promise.all(work.editors.map(e => e.editor.settled(60_000)));
    const gaps = affected.map(e => {
      const back = e.editor.reconnects.find(c => c.downAt >= killedAt - 1000 && c.upAt);
      return back ? back.upAt! - killedAt : Infinity;
    });
    const reconverged = Math.max(...gaps) / 1000;
    const check = await missingAcks(r.server.databaseUrl, work.editors.map(e => e.editor));
    for (const e of work.editors) e.editor.leave();
    return {id: 'D2', values: {lost: check.missing, reconverged},
      notes: [`D2: kill -9 of collab node ${victimName} holding ${affected.length} of ${work.editors.length} editors' sockets (${COLLAB_PATH}; 2 nodes, ${work.shared.length} files: one f20k, the rest f2k); every editor back on the other node through /session ${gaps.every(Number.isFinite) ? `${(Math.min(...gaps) / 1000).toFixed(1)}–${reconverged.toFixed(1)} s after the kill` : 'NOT for all of them'} (api's health check marks a node dead after 3 failed checks 2 s apart and expires its leases; the new owner loads checkpoint + journal tail); ${check.acked} acked ops checked in the journal, ${check.missing} missing${check.examples.length ? ` (${check.examples.join(', ')})` : ''}`]};
  } finally {
    await r.stop();
  }
}

/** D3: PostgreSQL frozen 30 s under 5 editors: acks pause, nothing is refused or lost, acks resume. */
async function databaseOutage(ctx: BenchContext): Promise<RowResult> {
  const r = await rig(ctx);
  const freezer = pgFreezer();
  let frozen = false;
  try {
    const work = await editing(r, 1, 5);
    const outageMs = ctx.quick ? 10_000 : 30_000;
    await sleep(5_000);
    const frozenAt = performance.now();
    await freezer.pause();
    frozen = true;
    await sleep(outageMs);
    await freezer.unpause();
    frozen = false;
    const thawedAt = performance.now();
    await sleep(15_000);
    await work.stop();
    await Promise.all(work.editors.map(e => e.editor.settled(60_000)));
    const acks = work.editors.flatMap(e => e.editor.acked);
    const during = acks.filter(a => a.at > frozenAt + 1000 && a.at < thawedAt).length;
    const firstAfter = Math.min(...acks.filter(a => a.at >= thawedAt).map(a => a.at)) - thawedAt;
    const refused = work.editors.reduce((sum, e) => sum + Object.values(e.editor.refused).reduce((a, b) => a + b, 0), 0);
    const byes = work.editors.reduce<Record<string, number>>((all, e) => {
      for (const [k, v] of Object.entries(e.editor.byes)) all[k] = (all[k] ?? 0) + v;
      return all;
    }, {});
    const check = await missingAcks(r.server.databaseUrl, work.editors.map(e => e.editor));
    const unacked = work.editors.reduce((sum, e) => sum + e.editor.unacked.size, 0);
    for (const e of work.editors) e.editor.leave();
    const pass = check.missing === 0 && refused === 0 && !Object.keys(byes).length && unacked === 0 && firstAfter < 10_000;
    return {id: 'D3', pass,
      text: `PostgreSQL frozen ${outageMs / 1000} s under 5 editors on f20k (${COLLAB_PATH}): ${during} acks during it, the first ack ${(firstAfter / 1000).toFixed(1)} s after the thaw; ${refused} refused, byes ${JSON.stringify(byes)}, ${unacked} never acked; ${check.missing} of ${check.acked} acked ops missing`,
      notes: [`D3: ${freezer.name}`]};
  } finally {
    if (frozen) await freezer.unpause().catch(() => {});
    await r.stop();
  }
}

const collabDurability: Bench = async ctx => {
  const results: RowResult[] = [];
  const na = (id: string, error: unknown) => results.push({id, na: (error as {na?: string}).na ?? `run failed: ${String((error as Error).message ?? error).slice(0, 200)}`});
  if (wants(ctx, 'D1')) {
    try {
      const many = await loadScenario(ctx, SPECS.many);
      results.push({id: 'D1', values: {p50: many.commit.p50, p99: many.commit.p99}, provisional: provOf(many),
        notes: [`D1: collab_journal_commit_seconds at 2 000 editors over 400 f2k files (${COLLAB_PATH}: one group-committed INSERT per batch, B2's PgJournal), ${many.commit.count} commits in the window`]});
    } catch (error) {
      na('D1', error);
    }
  }
  if (wants(ctx, 'D2')) {
    try {
      results.push(await killUnderLoad(ctx));
    } catch (error) {
      ctx.log(`D2 failed: ${String((error as Error).stack ?? error)}`);
      na('D2', error);
    }
  }
  if (wants(ctx, 'D3')) {
    try {
      results.push(await databaseOutage(ctx));
    } catch (error) {
      ctx.log(`D3 failed: ${String((error as Error).stack ?? error)}`);
      na('D3', error);
    }
  }
  if (wants(ctx, 'D4')) results.push({id: 'D4', na: 'the operator\'s replica/backup choice (★, BACKEND §8): bench-ru has the WAL archive (archive_timeout 60 s) and a nightly base backup, no replica; the restore drill is scripts/deploy/restore-drill.sh'});
  if (wants(ctx, 'D5')) {
    const tally = ctx.shared.get('collab-path:checkpoints') as {total: number; ok: number; failed: number; failures: string[]} | undefined;
    results.push(tally && tally.total
      ? {id: 'D5', values: {checked: (100 * tally.ok) / tally.total}, notes: [`D5: the latest checkpoint of every file this run's nodes checkpointed (${tally.total}) read back from the store and checked as api reads it (MRFC header, sha256 of the stored body, decode, recorded version): ${tally.ok} good${tally.failures.length ? `; ${tally.failures.join('; ')}` : ''}; the nodes reported ${tally.failed} failed checkpoint writes (B2 re-reads every checkpoint before recording its pointer)`]}
      : {id: 'D5', na: 'no file of this run was checkpointed (run D5 after the M or S rows)'});
  }
  return tag(fillNa(ctx, results, 'not run'));
};

// ── Load, save, checkpoints ──────────────────────────────────────────────────────────────────────

const CAP = 'the 50 000-layer cap refuses f100k on this path: api answers 413 design_document_too_large (DESIGN_DOCUMENT_CAPS in shared/design/schema.ts: 20 MB / 50 000 layers) and crates/model refuses more than 50 000 layers ("The file has more than 50000 layers.")';

const collabOpenSave: Bench = async ctx => {
  const results: RowResult[] = [];
  let r: Rig | null = null;
  try {
    r = await rig(ctx);
    const rigged = r;
    const doc = fixtureDocument('f20k');
    const stateOf = async (fileId: string) => {
      const pg = (await import('pg')).default;
      const client = new pg.Client({connectionString: rigged.server.databaseUrl});
      await client.connect();
      try {
        const row = (await client.query('SELECT version, checkpoint_version FROM design_files WHERE id=$1', [fileId])).rows[0];
        return {version: Number(row.version), checkpoint: row.checkpoint_version === null ? null : Number(row.checkpoint_version)};
      } finally {
        await client.end();
      }
    };
    /** `count` one-layer edits by `editor`, under the node's 50 ops a second per client, all acked. */
    const edits = async (editor: CollabEditor, count: number) => {
      let nodes = layersFor(doc, 0, 1);
      for (let i = 0; i < count; i++) {
        editor.move(nodes);
        nodes = nodes.map(node => ({...node, x: editor.seq}));
        await sleep(22);
      }
      await editor.settled(60_000);
    };
    const tail = ctx.quick ? 200 : 1000;

    // S4 on its own file: 1 000 edits → a checkpoint; the last socket leaving → a checkpoint of the last version.
    const cadenceFile = await sharedFile(rigged.server, 'f20k', 1);
    const cadence = Object.assign(new CollabEditor(rigged.server, cadenceFile.owner, cadenceFile.id), {known: cadenceFile.version});
    await cadence.connect();
    await edits(cadence, 1000);
    await sleep(3000);
    const afterThousand = await stateOf(cadenceFile.id);
    await edits(cadence, 50);
    cadence.leave();
    await sleep(3000);
    const afterLeave = await stateOf(cadenceFile.id);
    if (wants(ctx, 'S4')) results.push({id: 'S4', pass: (afterThousand.checkpoint ?? 0) >= 1000 && afterLeave.checkpoint === afterLeave.version,
      text: `after 1 000 edits: checkpoint at ${afterThousand.checkpoint ?? 'none'} (version ${afterThousand.version}); 50 edits later the last socket left: checkpoint at ${afterLeave.checkpoint ?? 'none'} of version ${afterLeave.version} (${COLLAB_PATH}); the 60 s trigger is the actor's CHECKPOINT_EVERY, not timed here`});

    // S1's cold load on another file: a checkpoint, then a journal tail above it, the node killed (no drain, so no new
    // checkpoint) and started again under the same name; a socket joins and the node loads checkpoint + tail.
    const coldFile = await sharedFile(rigged.server, 'f20k', 2);
    const writer = Object.assign(new CollabEditor(rigged.server, coldFile.owner, coldFile.id), {known: coldFile.version});
    await writer.connect();
    await edits(writer, 1000);
    await sleep(3000);
    await edits(writer, tail - 1);
    const beforeKill = await stateOf(coldFile.id);
    const checkpointScrape = await scrape(rigged.nodes[0]);
    writer.leave();
    await rigged.restart(0);
    const cold = Object.assign(new CollabEditor(rigged.server, coldFile.editors[1], coldFile.id), {known: beforeKill.version});
    const coldStarted = performance.now();
    await cold.connect();
    const coldMs = performance.now() - coldStarted;
    const coldNote = `f20k cold load after kill -9 + restart of the node: checkpoint at ${beforeKill.checkpoint ?? 'none'} + a journal tail of ${beforeKill.version - (beforeKill.checkpoint ?? 0)} ops; hello → welcome at version ${cold.known}${cold.resyncs ? ' (with a reload)' : ''} in ${(cold.welcomeAt - cold.helloAt).toFixed(0)} ms (lease, the checkpoint from ${rigged.s3 ? 'S3 (MinIO stand-in)' : 'a directory'}, decode, tail applied), ${coldMs.toFixed(0)} ms with /session (loopback)`;
    cold.leave();
    const ckpt = window(null, checkpointScrape, 'collab_checkpoint_seconds');
    if (wants(ctx, 'S1')) results.push({id: 'S1', na: `${CAP}. ${coldNote}`});
    if (wants(ctx, 'S2')) results.push({id: 'S2', na: 'collab answers a far-behind client with a `document` frame through the node; the zstd checkpoint stream from S3 by a signed URL (`snapshotUrl`) is not built (crates/collab sets snapshot_url: None; B1/B2/B3)'});
    if (wants(ctx, 'S3')) results.push({id: 'S3', na: `${CAP}. ${ckpt.count ? `f20k checkpoints on this node (serialize + zstd + upload + integrity re-read, off the actor's thread, to ${rigged.s3 ? 'S3 (MinIO stand-in)' : 'a directory'}): ${ckpt.count} written, p50 ${ckpt.p50.toFixed(0)} ms, p95 ${ckpt.p95.toFixed(0)} ms` : 'the node under test exports no collab_checkpoint_seconds (lane B5 adds it)'}`});
    if (wants(ctx, 'S5')) results.push({id: 'S5', na: `${CAP}; a PUT of f20k while collab holds the file goes through /internal/replace only up to collab's 2 MiB body limit, larger documents make the node let go first`});
    if (wants(ctx, 'S6')) {
      const named = await api(rigged.server, cadenceFile.owner, 'POST', `/api/design-files/${cadenceFile.id}/versions`, {label: 'Measurement'});
      const listed = await api(rigged.server, cadenceFile.owner, 'GET', `/api/design-files/${cadenceFile.id}/versions`);
      const versions = (JSON.parse(listed.text) as {versions?: {id: string}[]}).versions ?? [];
      if (named.status >= 300 || !versions.length) results.push({id: 'S6', na: `version not made: ${named.status} ${named.text.slice(0, 120)}`});
      else {
        const times: number[] = [];
        for (let i = 0; i < 5; i++) times.push((await api(rigged.server, cadenceFile.owner, 'GET', `/api/design-files/${cadenceFile.id}/versions/${versions[0].id}`)).ms);
        results.push({id: 'S6', values: {wall: median(times)}, notes: [`S6: a named version of f20k after 1 050 collab edits read with GET /:id/versions/:id (api reads checkpoint + journal through document-store.ts; ${COLLAB_PATH}), median of 5 on loopback, ${rigged.server.shape}`]});
      }
    }
  } catch (error) {
    ctx.log(`collab-path open-save failed: ${String((error as Error).stack ?? error)}`);
    for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) if (wants(ctx, id) && !results.some(result => result.id === id)) results.push({id, na: `run failed: ${String((error as Error).message ?? error).slice(0, 200)}`});
  } finally {
    await r?.stop();
  }
  return tag(fillNa(ctx, results, 'not run'));
};

// ── Cost ─────────────────────────────────────────────────────────────────────────────────────────

const collabCost: Bench = async ctx => {
  const results: RowResult[] = [];
  let pair: LoadResult | undefined, mem: Memory | undefined;
  try {
    pair = await loadScenario(ctx, SPECS.pair);
    mem = await memory(ctx);
  } catch (error) {
    return tag(fillNa(ctx, [], `run failed: ${String((error as Error).message ?? error).slice(0, 200)}`));
  }
  const coresPerEditor = pair.cores / pair.spec.editors;
  const k1cores = coresPerEditor * EDITORS_K1;
  const ramGb = ((EDITORS_K1 / PER_FILE) * mem.perDocMb + mem.rss0 / 2 ** 20) / 1024;
  if (wants(ctx, 'K1')) results.push({id: 'K1', values: {cores: k1cores, ram: ramGb}, provisional: provOf(pair),
    notes: [`K1: the pair run on collab (5 editors on f20k, 1 op/s, cursors 30 Hz: ${pair.cores.toFixed(3)} cores ⇒ ${(coresPerEditor * 1000).toFixed(1)} millicores an editor) scaled to 1 000 editors in 200 files; RAM = 200 open f20k documents × ${mem.perDocMb.toFixed(1)} MB + the node (${(mem.rss0 / 2 ** 20).toFixed(0)} MB); ${COLLAB_PATH}`]});
  if (wants(ctx, 'K2')) {
    const vms = Math.max(k1cores / 8, ramGb / 16);
    results.push({id: 'K2', values: {rub: (vms * RUB_PER_VM) / EDITORS_K1}, provisional: provOf(pair),
      notes: [`K2: ${vms.toFixed(2)} VMs of 8 vCPU / 16 GB at ${RUB_PER_VM} ₽ a month (a Russian cloud provider's price list, 2026-10-06) for K1's collab cores and RAM, over 1 000 editors; the database, api and S3 are not in it`]});
  }
  if (wants(ctx, 'K3')) {
    const ops = pair.ack.count;
    results.push(pair.walBytes !== null && ops ? {id: 'K3', values: {wal: pair.walBytes / ops / 1024}, provisional: provOf(pair),
      notes: [`K3: ${(pair.walBytes / 2 ** 20).toFixed(2)} MB of WAL (pg_stat_wal of the bench cluster) over ${ops} acked ops of 20 moved layers on f20k in the pair window (collab's journal rows, lease renewals, checkpoint pointers)`]} : {id: 'K3', na: 'pg_stat_wal not readable'});
  }
  return tag(fillNa(ctx, results, 'not run'));
};

/** The api rows: scripts/bench/api.ts already measures A2 and A4 on collab (and A1/A5 are the same api on either path);
 *  A3 is collab's own. */
const collabApi: Bench = async ctx => {
  const results = await (await import('./api')).default(ctx);
  return results.map(result => (result.id === 'A3'
    ? {id: 'A3', path: 'collab', na: 'collab checks the role cached on each connection (a field read per op; api pushes changes, the node re-validates every 20 s through api) and exports no per-check timing to measure (crates/collab acl.rs; B1)'}
    : result));
};

/** The collab path's benches by TARGETS bench name (scripts/bench/targets.ts --path collab). */
export const benches: Partial<Record<string, Bench>> = {
  'collab-load': collabLoad,
  durability: collabDurability,
  'open-save': collabOpenSave,
  cost: collabCost,
  api: collabApi,
};
void cookieOf;
