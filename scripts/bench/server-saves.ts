// The save bench: the 5-editor scenario of docs/design-tool.md §Saving big files against
// the bench server (scripts/bench/server.ts, today's API with its measurement around it), one process or two on one
// database (`DESIGN_LIVE_FANOUT=postgres`, editors split 3 + 2), on the 20 041-layer page of tests/helpers/design-big-files.ts.
// Five editors each move their own 20 layers of a group about once a second for 30 s, as the editor saves (the patch with
// `before` copies on the version it last saw, waiting 0.7–1.3 s after each answer), each with its live stream open.
//
//   tsx scripts/bench/server-saves.ts [--processes 1|2] [--seconds 30] [--runs 3] [--json out.json] [--label name] [--profile f]
//
// The server's engine comes from the environment, passed to the bench server: MORFA_ENGINE_OPS=ts|wasm|both,
// DESIGN_SERVER_LAYOUT=0|1. The PostgreSQL test cluster: BENCH_PG_STATE (its cluster.env).
// Reports, per run and as medians: saves accepted, save answered p50/p95 (the server's own timing, arrival to last byte),
// server CPU per accepted save, event-loop delay p99, WAL bytes per save, peak RSS, and 409s / resyncs.
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {heavyPage} from '../../tests/helpers/design-big-files';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {parseEvents} from '../../src/design/realtime/stream';
import {Histogram} from './lib/histogram';
import {clusterEnv} from './lib/server';
import type {ServerMetrics} from './lib/fixtures';
import {formatHot, hotSpots, type CpuProfile} from './lib/cpuprofile';

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};
const PROCESSES = Number(option('processes', '1'));
const SECONDS = Number(option('seconds', '30'));
const RUNS = Number(option('runs', '1'));
/** `--profile file.cpuprofile`: a CPU profile of the first process over the window, with its hot spots printed. */
const PROFILE = option('profile', '');
/** `--viewers N`: N more people of the team with the file's stream open (spread over the processes), each receiving every
 *  change: the "at 2 000 streams" condition (with the editors' own five). */
const VIEWERS = Number(option('viewers', '0'));
/** `--per-file 50`: streams per file as production caps them (live/limits.ts): the edited file gets 50 with its editors,
 *  the other viewers watch other files of the team, 50 each (they hold streams but receive no changes). 0: all on one. */
const PER_FILE = Number(option('per-file', '0'));
const EDITORS = 5, LAYERS = 20;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Server = {base: string; key: string; child: ChildProcess; exited: Promise<void>};

async function database() {
  // cluster.env as the test cluster script writes it has `export` lines; clusterEnv reads plain ones.
  const env = process.env.MORFA_TEST_DATABASE_URL ? process.env : clusterEnv(process.env.BENCH_PG_STATE);
  const {createPostgresqlTestDatabase} = await import('../../tests/helpers/postgresql');
  const {createDatabase} = await import('../../server/postgresql/client');
  const {loadDatabaseConfig} = await import('../../server/postgresql/config');
  const {migrateDatabase} = await import('../../server/postgresql/migrations');
  const isolated = await createPostgresqlTestDatabase(env);
  const migration = createDatabase(loadDatabaseConfig('migration', {...isolated.env}));
  await migrateDatabase(migration, {mode: 'fresh', runtimeRole: isolated.roles.runtime, backupRole: isolated.roles.backup});
  await migration.close();
  return isolated;
}

async function startServer(port: number, env: Record<string, string>): Promise<Server> {
  const key = randomBytes(16).toString('hex');
  const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=4096', '--import', 'tsx', 'scripts/bench/server.ts', '--port', String(port)], {
    env: {...process.env, ...env, BENCH_KEY: key},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', chunk => (log += chunk));
  child.stderr!.on('data', chunk => (log += chunk));
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  let gone = false;
  void exited.then(() => (gone = true));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (gone) throw Error(`the bench server exited:\n${log.slice(-3000)}`);
    try {
      if ((await fetch(base + '/__bench/info', {headers: {'x-bench-key': key}})).ok) return {base, key, child, exited};
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw Error('the bench server was not ready');
}

async function bench<T>(server: Server, route: string, body?: unknown): Promise<T> {
  const response = await fetch(server.base + '/__bench/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {'x-bench-key': server.key, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(`/__bench/${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

type Account = {id: string; token: string};
const cookie = (who: Account) => `forma_session=${who.token}`;

/** One editor: its stream (the version it has seen), its layers as it holds them, and its save loop. */
async function editor(server: Server, who: Account, fileId: string, start: number, layers: SceneNode[], until: number, seed: number) {
  let version = start;
  const controller = new AbortController();
  const stream = await fetch(`${server.base}/api/design-files/${fileId}/events?since=${start}`, {headers: {cookie: cookie(who)}, signal: controller.signal});
  let connection: string | null = null;
  let resyncs = 0;
  const reading = (async () => {
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer = parseEvents(buffer + value, event => {
          if (event.event === 'hello') connection = (JSON.parse(event.data) as {connection: string}).connection;
          else if (event.event === 'change') version = Math.max(version, Number(event.id));
          else if (event.event === 'resync') resyncs++;
        });
      }
    } catch {
      // Aborted at the end.
    }
  })();
  const mine = new Map(layers.map(node => [node.id, node]));
  let rng = seed;
  const random = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const statuses: Record<string, number> = {};
  let k = 0;
  while (Date.now() < until) {
    const nodes: Record<NodeId, SceneNode> = {}, before: Record<NodeId, SceneNode> = {};
    for (const [id, node] of mine) {
      before[id] = node;
      nodes[id] = {...node, x: node.x + 1 + (k % 3), y: node.y + (k % 2)};
    }
    k++;
    const response = await fetch(`${server.base}/api/design-files/${fileId}/document`, {
      method: 'PATCH',
      headers: {cookie: cookie(who), 'content-type': 'application/json', origin: server.base},
      body: JSON.stringify({baseVersion: version, patch: {nodes}, before, ...(connection ? {client: connection} : {})}),
    });
    statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    const answer = (await response.json()) as {version?: number; own?: {nodes?: Record<NodeId, SceneNode | null>}};
    if (response.ok) {
      version = Math.max(version, answer.version!);
      for (const id of Object.keys(nodes)) mine.set(id, (answer.own?.nodes?.[id] as SceneNode | undefined) ?? nodes[id]);
    }
    await sleep(700 + random() * 600);
  }
  controller.abort();
  await reading;
  return {statuses, resyncs};
}

/** A small page for the other files viewers watch. */
function smallDocument() {
  const small = heavyPage();
  const page = small.pages[0];
  const keep = small.nodes[page].children!.slice(0, 20);
  const nodes: Record<NodeId, SceneNode> = {[page]: {...small.nodes[page], children: keep}};
  const add = (id: NodeId) => {
    nodes[id] = small.nodes[id];
    for (const child of small.nodes[id].children ?? []) add(child);
  };
  keep.forEach(add);
  return {...small, nodes};
}

async function run(doc: DesignDocument, docText: string) {
  const isolated = await database();
  const env: Record<string, string> = {...isolated.env, ...(PROCESSES > 1 ? {DESIGN_LIVE_FANOUT: 'postgres'} : {})};
  for (const key of ['MORFA_ENGINE', 'MORFA_ENGINE_OPS', 'MORFA_ENGINE_NORMALIZE', 'MORFA_ENGINE_TEXT', 'DESIGN_SERVER_LAYOUT'])
    if (process.env[key]) env[key] = process.env[key]!;
  const servers: Server[] = [];
  try {
    for (let p = 0; p < PROCESSES; p++) servers.push(await startServer(3460 + p, env));
    const main = servers[0];
    const people = (await bench<{accounts: Account[]}>(main, 'accounts', {count: EDITORS})).accounts;
    const viewers = VIEWERS ? (await bench<{accounts: Account[]}>(main, 'accounts', {count: VIEWERS, prefix: 'viewer'})).accounts : [];
    const {teamId} = await bench<{teamId: string}>(main, 'team', {
      owner: people[0].id,
      members: [...people.slice(1).map(person => ({id: person.id, role: 'editor'})), ...viewers.map(person => ({id: person.id, role: 'viewer'}))],
    });
    const created = await fetch(main.base + '/api/design-files', {
      method: 'POST',
      headers: {cookie: cookie(people[0]), 'content-type': 'application/json', origin: main.base},
      body: '{"name":"heavyPage","teamId":' + JSON.stringify(teamId) + ',"document":' + docText + '}',
    });
    if (!created.ok) throw Error(`create: ${created.status} ${(await created.text()).slice(0, 300)}`);
    const file = ((await created.json()) as {file: {id: string; version: number}}).file;
    // Every process holds the document before the window (the first save of a process reads the whole file).
    for (const server of servers) await fetch(`${server.base}/api/design-files/${file.id}`, {headers: {cookie: cookie(people[0])}}).then(r => r.arrayBuffer());
    const groups = Object.values(doc.nodes).filter(node => node.type === 'GROUP');
    // The viewers' streams: open before the window, read and dropped.
    const watching = new AbortController();
    const onMain = PER_FILE ? Math.max(0, PER_FILE - EDITORS) : VIEWERS;
    const others = PER_FILE && VIEWERS > onMain
      ? (await bench<{ids: string[]}>(main, 'bulk-files', {owner: people[0].id, teamId, count: Math.ceil((VIEWERS - onMain) / PER_FILE), document: smallDocument()})).ids
      : [];
    const fileOf = (v: number) => (v < onMain ? file.id : others[Math.floor((v - onMain) / PER_FILE)]);
    let received = 0;
    // In batches: each open checks access in the database (a burst of 2 000 would wait out the pool's timeout).
    const opened: number[] = [];
    const open = (who: Account, v: number) =>
      (async () => {
        const response = await fetch(`${servers[v % servers.length].base}/api/design-files/${fileOf(v)}/events`, {headers: {cookie: cookie(who)}, signal: watching.signal});
        if (!response.ok) throw Error(`viewer stream: ${response.status} ${await response.text()}`);
        void (async () => {
          const reader = response.body!.getReader();
          try {
            for (;;) {
              const {value, done} = await reader.read();
              if (done) break;
              received += value.length;
            }
          } catch {
            // Closed at the end.
          }
        })();
        return response.status;
      })();
    for (let start = 0; start < viewers.length; start += 50) opened.push(...(await Promise.all(viewers.slice(start, start + 50).map((who, k) => open(who, start + k)))));
    if (opened.length) console.log(`${opened.length} viewer streams open`);
    for (const server of servers) await bench(server, 'reset', {});
    if (PROFILE) await bench(main, 'profile/start', {});
    const until = Date.now() + SECONDS * 1000;
    const results = await Promise.all(
      people.map((who, e) =>
        editor(servers[e % servers.length], who, file.id, file.version, groups[e * 7 % groups.length].children!.slice(0, LAYERS).map(id => doc.nodes[id]), until, e + 1),
      ),
    );
    await sleep(500);
    if (PROFILE) {
      const profile = await bench<CpuProfile>(main, 'profile/stop', {});
      writeFileSync(PROFILE, JSON.stringify(profile));
      const hot = hotSpots(profile, 30);
      console.log(`profile of process 1 → ${PROFILE} (${hot.profileMs.toFixed(0)} ms, idle ${(hot.idleShare * 100).toFixed(0)} %)\n${formatHot(hot.self, 'self')}\n${formatHot(hot.total, 'total')}`);
    }
    const metrics = await Promise.all(servers.map(server => bench<ServerMetrics>(server, 'metrics')));
    watching.abort();
    const patch = new Histogram();
    for (const each of metrics) patch.merge(Histogram.from(each.patch));
    const accepted = metrics.reduce((sum, each) => sum + (each.patchByStatus['200'] ?? 0), 0);
    const cpu = metrics.reduce((sum, each) => sum + each.cpuUserMs + each.cpuSystemMs, 0);
    const statuses: Record<string, number> = {};
    for (const result of results) for (const [status, n] of Object.entries(result.statuses)) statuses[status] = (statuses[status] ?? 0) + n;
    const p = patch.summary();
    return {
      accepted,
      statuses,
      resyncs: results.reduce((sum, result) => sum + result.resyncs, 0),
      p50: p.p50,
      p95: p.p95,
      cpuPerSave: cpu / Math.max(1, accepted),
      cpuShare: cpu / metrics.reduce((sum, each) => sum + each.wallMs, 0),
      loopP99: Math.max(...metrics.map(each => each.eventLoop.p99)),
      loopMax: Math.max(...metrics.map(each => each.eventLoop.max)),
      // pg_stat_wal is the cluster's: with two processes both read the same counter.
      walPerSave: (metrics[0].walBytes ?? NaN) / Math.max(1, accepted),
      rssMb: Math.max(...metrics.map(each => each.rssMax)) / 2 ** 20,
      streams: metrics.reduce((sum, each) => sum + each.live.streams, 0),
      viewerMb: received / 2 ** 20,
    };
  } finally {
    for (const server of servers) server.child.kill('SIGTERM');
    await Promise.all(servers.map(server => Promise.race([server.exited, sleep(15_000)])));
    await isolated.close().catch(() => {});
  }
}

const doc = heavyPage();
const docText = JSON.stringify(doc);
const label = option('label', `ops=${process.env.MORFA_ENGINE_OPS ?? process.env.MORFA_ENGINE ?? 'ts'} layout=${process.env.DESIGN_SERVER_LAYOUT === '1' ? 'server' : 'editor'} processes=${PROCESSES}`);
console.log(`server-saves: ${label}; heavyPage ${Object.keys(doc.nodes).length} layers, ${(docText.length / 1e6).toFixed(1)} MB; ${EDITORS} editors × ${LAYERS} layers, ${SECONDS} s, ${RUNS} run(s)`);
const runs: Awaited<ReturnType<typeof run>>[] = [];
for (let r = 0; r < RUNS; r++) {
  const result = await run(doc, docText);
  runs.push(result);
  console.log(JSON.stringify(result));
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const pick = (key: 'accepted' | 'p50' | 'p95' | 'cpuPerSave' | 'cpuShare' | 'loopP99' | 'walPerSave' | 'rssMb') => median(runs.map(each => each[key]));
const summary = {label, runs: runs.length, accepted: pick('accepted'), p50: pick('p50'), p95: pick('p95'), cpuPerSave: pick('cpuPerSave'), cpuShare: pick('cpuShare'), loopP99: pick('loopP99'), walPerSave: pick('walPerSave'), rssMb: pick('rssMb')};
console.log(
  `MEDIAN ${label}: accepted ${summary.accepted}, answered p50/p95 ${summary.p50.toFixed(0)}/${summary.p95.toFixed(0)} ms, CPU/save ${summary.cpuPerSave.toFixed(1)} ms (${summary.cpuShare.toFixed(2)} core), loop p99 ${summary.loopP99.toFixed(1)} ms, WAL/save ${(summary.walPerSave / 1024).toFixed(1)} KB, RSS ${summary.rssMb.toFixed(0)} MB`,
);
const out = option('json', '');
if (out) writeFileSync(out, JSON.stringify({summary, runs}, null, 1));
process.exit(0);
