// The bench server (lane B0): today's Morfa API (server/app.ts, the legacy SSE + PATCH path) on a freshly migrated database,
// with bench-only measurement around it and, with --app-dir, the built app on the same origin (COOP/COEP, so the canvas
// bench can read performance.measureUserAgentSpecificMemory). Nothing in server/ changes: the timings come from wrappers here.
//
//   tsx scripts/bench/server.ts --port 3410 [--host 127.0.0.1] [--app-dir dist/app] [--ready-file f.json]
//
// Database: MORFA_DATABASE_URL (+ _MIGRATION_, _BACKUP_) when given (the dev-4 container: the host made and migrated it),
// otherwise a new database in the isolated test cluster of MORFA_TEST_* (docs/dev.md), dropped when the server stops.
// BENCH_PG_FORWARD=host:port opens 127.0.0.1:15450 → that address inside the container (the server's config only allows a
// loopback database without TLS). BENCH_KEY guards /__bench/* (header x-bench-key).
//
// /__bench/metrics answers what the server measured since the last /__bench/reset:
//   patch      PATCH /:id/document from arrival to the last byte of the answer (the legacy ack, M1b's analog), by status
//   fanout     arrival of the PATCH → its `change` written to every other open stream (M1's analog: in legacy the change
//              goes out after the commit, so it includes the journal); fanoutFirst → the first stream
//   commit     every COMMIT the app's pool runs (D1's analog), timed around pg's query
//   presence   POST /:id/presence, by status; cpu, memory, event-loop delay, streams, SSE bytes, WAL bytes (pg_stat_wal)
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, writeFileSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
import {AsyncLocalStorage} from 'node:async_hooks';
import cluster from 'node:cluster';
import {Histogram} from './lib/histogram';

const argv = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const port = Number(option('port', '3410'));
const host = option('host', '127.0.0.1')!;
const appDir = option('app-dir');
const readyFile = option('ready-file');
const benchKey = process.env.BENCH_KEY || randomBytes(16).toString('hex');

// ── Environment: only what the API needs, the way scripts/e2e-server.ts cuts it ───────────────────
const keep = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR', 'FORCE_COLOR',
  'MORFA_TEST_DATABASE_URL', 'MORFA_TEST_CLUSTER_ID', 'MORFA_TEST_CLUSTER_TOKEN', 'MORFA_TEST_ENDPOINT',
  'MORFA_DATABASE_URL', 'MORFA_MIGRATION_DATABASE_URL', 'MORFA_BACKUP_DATABASE_URL', 'MORFA_DATABASE_POOL_MAX', 'BENCH_PG_FORWARD', 'BENCH_KEY', 'BENCH_APP_ORIGIN',
  'BENCH_API_PROCESSES', 'BENCH_DATA_DIR',
  'PLAYWRIGHT_BROWSERS_PATH', 'NODE_OPTIONS']);
// MORFA_ENGINE*, MORFA_WASM_PATH, MORFA_TEXT_*: the engine switch's choice for this server (lane L6's rows).
const overrides = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(DESIGN_|BENCH_ENV_|MORFA_ENGINE|MORFA_WASM_PATH$|MORFA_TEXT_)/.test(key)));
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
const appOrigin = process.env.BENCH_APP_ORIGIN || `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  NODE_ENV: 'test',
  APP_ORIGIN: appOrigin,
  ENABLE_DESIGN_TOOL: '1',
  HOSTING_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  // The load harness: 30 Hz cursors (TARGETS §3) and every synthetic editor's stream; the legacy defaults (25/s, 50 per file,
  // 2 000 per process) would refuse the load instead of measuring it. Operator settings of server/design/live/limits.ts.
  DESIGN_LIVE_PRESENCE_PER_SECOND: '30',
  DESIGN_LIVE_STREAMS_PER_FILE: '1000',
  DESIGN_LIVE_STREAMS: '6000',
  DESIGN_LIVE_STREAMS_PER_ACCOUNT: '64',
  ...overrides,
});
// BENCH_API_PROCESSES' workers share their primary's data directory (pictures and thumbnails one process wrote, another serves).
const dataDir = cluster.isWorker && process.env.BENCH_DATA_DIR ? process.env.BENCH_DATA_DIR : mkdtempSync(path.join(tmpdir(), 'morfa-bench-'));
process.env.DATA_DIR = dataDir;

// ── BENCH_API_PROCESSES=N (lane A7): N api processes on this one port, as production runs morfa-api@1..N behind Caddy
// (deploy/systemd/morfa-api@.service, two by default). This process forks them (node:cluster hands each new connection to the
// next one) on the database it was given, and only relays. Legacy co-editing streams fan out through PostgreSQL then
// (DESIGN_LIVE_FANOUT=postgres, as production's api.env). /__bench/metrics and /__bench/profile/* answer for whichever process
// the request reaches: use them with one process. ─────────────────────────────────────────────────────────────────────────
const apiProcesses = Number(process.env.BENCH_API_PROCESSES || 1);
if (!Number.isInteger(apiProcesses) || apiProcesses < 1 || apiProcesses > 16) throw Error('BENCH_API_PROCESSES must be 1..16');
if (apiProcesses > 1) process.env.DESIGN_LIVE_FANOUT ??= 'postgres';
if (apiProcesses > 1 && cluster.isPrimary) {
  if (!process.env.MORFA_DATABASE_URL) throw Error('BENCH_API_PROCESSES > 1 needs the database made by its caller (MORFA_DATABASE_URL)');
  const workers = Array.from({length: apiProcesses}, () => cluster.fork({...process.env, BENCH_DATA_DIR: dataDir}));
  let exiting = false;
  for (const worker of workers)
    worker.on('exit', code => {
      if (!exiting) {
        console.error(`bench api process ${worker.process.pid} exited (${code}); stopping`);
        process.exit(1);
      }
    });
  await Promise.all(workers.map(worker => new Promise<void>(resolve => worker.once('listening', () => resolve()))));
  const ready = {pid: process.pid, port, host, benchKey, appOrigin, appDir: appDir ?? null, processes: workers.map(worker => worker.process.pid)};
  if (readyFile) writeFileSync(readyFile, JSON.stringify(ready));
  console.log('BENCH_READY ' + JSON.stringify({...ready, benchKey: undefined}));
  const stopAll = async () => {
    exiting = true;
    await Promise.all(workers.map(worker => new Promise<void>(resolve => (worker.isDead() ? resolve() : (worker.once('exit', () => resolve()), worker.kill('SIGTERM'))))));
    process.exit(0);
  };
  process.on('SIGTERM', () => void stopAll());
  process.on('SIGINT', () => void stopAll());
  // The primary serves nothing itself: everything below runs in the workers.
  await new Promise(() => {});
}

// ── The database ──────────────────────────────────────────────────────────────────────────────────
if (process.env.BENCH_PG_FORWARD) {
  const [targetHost, targetPort] = process.env.BENCH_PG_FORWARD.split(':');
  const proxy = net.createServer(socket => {
    const upstream = net.connect(Number(targetPort), targetHost);
    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    socket.pipe(upstream).pipe(socket);
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', close);
    upstream.on('error', close);
  });
  await new Promise<void>(resolve => proxy.listen(15450, '127.0.0.1', resolve));
}
let dropDatabase: (() => Promise<void>) | null = null;
if (!process.env.MORFA_DATABASE_URL) {
  const {createPostgresqlTestDatabase} = await import('../../tests/helpers/postgresql');
  const {createDatabase} = await import('../../server/postgresql/client');
  const {loadDatabaseConfig} = await import('../../server/postgresql/config');
  const {migrateDatabase} = await import('../../server/postgresql/migrations');
  const isolated = await createPostgresqlTestDatabase();
  const migration = createDatabase(loadDatabaseConfig('migration', {...process.env, ...isolated.env}));
  await migrateDatabase(migration, {mode: 'fresh', runtimeRole: isolated.roles.runtime, backupRole: isolated.roles.backup});
  await migration.close();
  Object.assign(process.env, isolated.env);
  dropDatabase = () => isolated.close();
}
for (const key of ['MORFA_TEST_DATABASE_URL', 'MORFA_TEST_CLUSTER_ID', 'MORFA_TEST_CLUSTER_TOKEN', 'MORFA_TEST_ENDPOINT']) delete process.env[key];

// ── Measurement: COMMIT timing, installed before the pool makes a client ──────────────────────────
const pg = (await import('pg')).default;
type Metrics = ReturnType<typeof freshMetrics>;
function freshMetrics() {
  return {
    since: Date.now(),
    sinceHr: performance.now(),
    cpu: process.cpuUsage(),
    patch: new Histogram(),
    patchByStatus: {} as Record<string, number>,
    fanout: new Histogram(),
    fanoutFirst: new Histogram(),
    commit: new Histogram(),
    /** COMMITs run while a PATCH /:id/document is handled: the save's own transaction. */
    commitSave: new Histogram(),
    presence: new Histogram(),
    presenceByStatus: {} as Record<string, number>,
    get: new Histogram(),
    sseBytes: 0,
    changeWrites: 0,
    presenceWrites: 0,
    wal0: NaN,
    rssMax: 0,
  };
}
let metrics: Metrics = freshMetrics();
const requestKind = new AsyncLocalStorage<'save'>();
const originalQuery = pg.Client.prototype.query as (...args: unknown[]) => unknown;
pg.Client.prototype.query = function patchedQuery(this: unknown, ...args: unknown[]) {
  const config = args[0] as string | {text?: string} | undefined;
  const text = typeof config === 'string' ? config : config?.text;
  if (text !== 'COMMIT') return originalQuery.apply(this, args);
  const started = performance.now();
  const save = requestKind.getStore() === 'save';
  const result = originalQuery.apply(this, args) as Promise<unknown> | undefined;
  if (result && typeof (result as Promise<unknown>).then === 'function')
    (result as Promise<unknown>).then(() => {
      const ms = performance.now() - started;
      metrics.commit.record(ms);
      if (save) metrics.commitSave.record(ms);
    }, () => {});
  return result;
} as typeof pg.Client.prototype.query;

// ── The application ───────────────────────────────────────────────────────────────────────────────
const storage = await import('../../server/db');
await storage.initializeDatabase();
// The engine the environment asks for, loaded before any request (as server/index.ts does).
(await import('../../server/design/wasm-engine')).startServerEngines();
const {app, drainAppTasks} = await import('../../server/app');
// With collab nodes configured, the same watches server/index.ts runs (lane B5: the collab path's D2 measures api's
// health check expiring a dead node's leases, as production does).
if (process.env.DESIGN_COLLAB_NODES) {
  (await import('../../server/design/collab/leases')).watchCollabHealth();
  (await import('../../server/design/collab/reconcile')).watchCollabSwitch();
}
const hub = await import('../../server/design/live/hub');
const {digest} = await import('../../server/auth');
const {default: express} = await import('express');
const db = storage.db;

const loop = monitorEventLoopDelay({resolution: 1});
loop.enable();
const rssTimer = setInterval(() => {
  const rss = process.memoryUsage.rss();
  if (rss > metrics.rssMax) metrics.rssMax = rss;
}, 250);
rssTimer.unref();

async function walBytes(): Promise<number> {
  try {
    const row = await db.one<{bytes: string}>('SELECT wal_bytes::text AS bytes FROM pg_stat_wal');
    return Number(row?.bytes);
  } catch {
    return NaN;
  }
}
metrics.wal0 = await walBytes();

/** (file, version) → when its change was written to the first and the last open stream. */
const fanouts = new Map<string, {first: number; last: number}>();
const pruneFanouts = setInterval(() => {
  const old = performance.now() - 120_000;
  for (const [key, value] of fanouts) if (value.last < old) fanouts.delete(key);
}, 30_000);
pruneFanouts.unref();
let openStreams = 0;

const harness = express();
harness.disable('x-powered-by');
harness.use('/__bench', (req, res, next) => {
  if (req.get('x-bench-key') !== benchKey) {
    res.sendStatus(403);
    return;
  }
  next();
}, express.json({limit: '64mb'}));

const designPath = /^\/api\/design-files\/([^/]+)(\/[^?]*)?$/;
harness.use((req, res, next) => {
  const match = designPath.exec(req.path);
  if (!match) return next();
  const [, fileId, rest = ''] = match;
  const started = performance.now();
  if (req.method === 'PATCH' && rest === '/document') {
    let version: number | undefined;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      version = (body as {version?: number} | null)?.version;
      return json(body);
    };
    res.once('finish', () => {
      const now = performance.now();
      metrics.patch.record(now - started);
      metrics.patchByStatus[res.statusCode] = (metrics.patchByStatus[res.statusCode] ?? 0) + 1;
      if (res.statusCode === 200 && version !== undefined) {
        const fan = fanouts.get(fileId + ':' + version);
        if (fan) {
          metrics.fanout.record(fan.last - started);
          metrics.fanoutFirst.record(fan.first - started);
        }
      }
    });
    requestKind.run('save', next);
    return;
  } else if (req.method === 'POST' && rest === '/presence') {
    res.once('finish', () => {
      metrics.presence.record(performance.now() - started);
      metrics.presenceByStatus[res.statusCode] = (metrics.presenceByStatus[res.statusCode] ?? 0) + 1;
    });
  } else if (req.method === 'GET' && rest === '/events') {
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    let counted = false;
    res.write = ((chunk: unknown, ...more: unknown[]) => {
      if (typeof chunk === 'string') {
        if (!counted && res.statusCode === 200) {
          counted = true;
          openStreams++;
          res.once('close', () => openStreams--);
        }
        metrics.sseBytes += Buffer.byteLength(chunk);
        let at = chunk.indexOf('event: change\nid: ');
        if (at >= 0) metrics.changeWrites++;
        if (chunk.includes('event: presence')) metrics.presenceWrites++;
        const now = performance.now();
        while (at >= 0) {
          const end = chunk.indexOf('\n', at + 18);
          const key = fileId + ':' + chunk.slice(at + 18, end);
          const seen = fanouts.get(key);
          if (seen) seen.last = now;
          else fanouts.set(key, {first: now, last: now});
          at = chunk.indexOf('event: change\nid: ', end);
        }
      }
      return write(chunk, ...more);
    }) as typeof res.write;
  } else if (req.method === 'GET' && rest === '') {
    res.once('finish', () => metrics.get.record(performance.now() - started));
  }
  next();
});

// ── Client benches: a file's document from disk ──────────────────────────────────────────────────
// The canvas and edit benches open files past the legacy caps (f100k: 80 MB, 100 000 layers; the server stores ≤ 20 MB and
// 50 000). A placeholder file is made through the API; /__bench/override points it at a bench file, then its GET answers the
// placeholder's file and access with that document streamed from disk, its saves are answered without storing (a version
// more each), and its live stream is off (503 design_live_off), so the editor works as on a file nobody else has open.
const fileOverrides = new Map<string, {path: string; version: number}>();
harness.use((req, res, next) => {
  const match = designPath.exec(req.path);
  const override = match && req.get('x-bench-real') !== '1' ? fileOverrides.get(match[1]) : undefined;
  if (!match || !override) return next();
  const rest = match[2] ?? '';
  if (req.method === 'GET' && rest === '') {
    void (async () => {
      const real = await fetch(`http://127.0.0.1:${port}${req.originalUrl}`, {headers: {cookie: req.get('cookie') ?? '', 'x-bench-real': '1'}});
      if (!real.ok) {
        res.status(real.status).type('application/json').send(await real.text());
        return;
      }
      const opened = (await real.json()) as {file: {version: number}; access?: unknown};
      const file = {...opened.file, version: override.version};
      // The warm open (lane O): a client holding this version gets the file without its document, as server/design/router.ts.
      if (req.query.have === String(override.version)) {
        res.status(200).json({file, access: opened.access ?? null, current: true});
        return;
      }
      res.status(200).type('application/json; charset=utf-8');
      res.write('{"file":' + JSON.stringify(file) + ',"access":' + JSON.stringify(opened.access ?? null) + ',"document":');
      const stream = (await import('node:fs')).createReadStream(override.path);
      stream.on('end', () => res.end('}'));
      stream.on('error', error => res.destroy(error));
      stream.pipe(res, {end: false});
    })().catch(next);
    return;
  }
  if ((req.method === 'PATCH' || req.method === 'PUT') && rest === '/document') {
    req.resume();
    req.on('end', () => {
      override.version++;
      res.json({version: override.version, updatedAt: new Date().toISOString()});
    });
    return;
  }
  if (req.method === 'GET' && rest === '/events') {
    res.status(503).json({error: 'off for bench files', code: 'design_live_off'});
    return;
  }
  next();
});

// ── /__bench: accounts, teams, files, metrics ─────────────────────────────────────────────────────
const asyncRoute = (handler: (req: import('express').Request, res: import('express').Response) => Promise<void>) => (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
  handler(req, res).catch(next);
};
/** {count, prefix?} → [{id, token}]: accounts with a signed-in session each (as scripts/e2e-server.ts /__e2e/fixtures). */
harness.post('/__bench/accounts', asyncRoute(async (req, res) => {
  const count = Math.min(10_000, Math.max(1, Number(req.body?.count) || 1));
  const prefix = String(req.body?.prefix ?? 'bench').replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'bench';
  const accounts = Array.from({length: count}, (_, i) => ({id: `${prefix}-${randomUUID()}`, token: randomBytes(32).toString('hex'), name: `Editor ${i + 1}`}));
  const expires = Date.now() + 24 * 3_600_000;
  for (let start = 0; start < accounts.length; start += 1000) {
    const part = accounts.slice(start, start + 1000);
    await db.transaction(async tx => {
      await tx.execute('INSERT INTO users(id,email,name,password) SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[])',
        [part.map(a => a.id), part.map(a => `${a.id}@bench.invalid`), part.map(a => a.name), part.map(() => '')]);
      await tx.execute('INSERT INTO sessions(token,user_id,expires) SELECT * FROM unnest($1::text[],$2::text[],$3::bigint[])',
        [part.map(a => digest(a.token)), part.map(a => a.id), part.map(() => expires)]);
    });
  }
  res.json({accounts: accounts.map(({id, token}) => ({id, token}))});
}));
/** {owner, members: [{id, role}]} → {teamId}: a team written directly (invites are not what is measured). */
harness.post('/__bench/team', asyncRoute(async (req, res) => {
  const owner = String(req.body.owner);
  const members = (req.body.members ?? []) as {id: string; role: string}[];
  const teamId = randomUUID();
  await db.transaction(async tx => {
    await tx.execute('INSERT INTO design_teams(id,name,owner_id) VALUES($1,$2,$3)', [teamId, 'Load', owner]);
    const rows = [{id: owner, role: 'owner'}, ...members.filter(member => member.id !== owner)];
    await tx.execute('INSERT INTO design_team_members(team_id,user_id,role) SELECT $1, * FROM unnest($2::text[],$3::text[])', [teamId, rows.map(r => r.id), rows.map(r => r.role)]);
  });
  res.json({teamId});
}));
/** {owner, teamId, count, document} → {ids}: file rows written directly with a small document (the listing bench, A1). */
harness.post('/__bench/bulk-files', asyncRoute(async (req, res) => {
  const owner = String(req.body.owner), teamId = req.body.teamId ? String(req.body.teamId) : null;
  const count = Math.min(5000, Math.max(1, Number(req.body.count) || 1));
  const text = JSON.stringify(req.body.document);
  const ids = Array.from({length: count}, () => randomUUID());
  await db.execute(
    `INSERT INTO design_files(id,user_id,team_id,name,document,bytes,node_count)
     SELECT id, $2, $3, 'File ' || n, $4, $5, $6 FROM unnest($1::text[]) WITH ORDINALITY AS t(id, n)`,
    [ids, owner, teamId, text, Buffer.byteLength(text), Object.keys((req.body.document as {nodes?: object}).nodes ?? {}).length],
  );
  res.json({ids});
}));
/** {fileId, fixture} → the file opens with that bench file's document (see above); fixture: a path or a fixtures/bench name. */
harness.post('/__bench/override', (req, res) => {
  const fixture = String(req.body.fixture);
  const file = path.isAbsolute(fixture) ? fixture : path.resolve('fixtures/bench', `${fixture}.json`);
  if (!existsSync(file)) {
    res.status(404).json({error: `no bench file ${file}`});
    return;
  }
  fileOverrides.set(String(req.body.fileId), {path: file, version: Number(req.body.version) || 1});
  res.json({ok: true, path: file});
});
harness.post('/__bench/reset', asyncRoute(async (_req, res) => {
  metrics = freshMetrics();
  loop.reset();
  metrics.wal0 = await walBytes();
  res.json({ok: true});
}));
harness.post('/__bench/gc', (_req, res) => {
  const gc = (globalThis as {gc?: () => void}).gc;
  if (gc) {
    gc();
    gc();
  }
  res.json({gc: !!gc, memory: process.memoryUsage()});
});
harness.get('/__bench/metrics', asyncRoute(async (_req, res) => {
  const cpu = process.cpuUsage(metrics.cpu);
  const memory = process.memoryUsage();
  const wal = await walBytes();
  res.json({
    pid: process.pid,
    wallMs: performance.now() - metrics.sinceHr,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    memory,
    rssMax: Math.max(metrics.rssMax, memory.rss),
    eventLoop: {p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6},
    patch: metrics.patch.toJSON(),
    patchByStatus: metrics.patchByStatus,
    fanout: metrics.fanout.toJSON(),
    fanoutFirst: metrics.fanoutFirst.toJSON(),
    commit: metrics.commit.toJSON(),
    commitSave: metrics.commitSave.toJSON(),
    presence: metrics.presence.toJSON(),
    presenceByStatus: metrics.presenceByStatus,
    get: metrics.get.toJSON(),
    sse: {open: openStreams, bytes: metrics.sseBytes, changeWrites: metrics.changeWrites, presenceWrites: metrics.presenceWrites},
    walBytes: Number.isFinite(wal) && Number.isFinite(metrics.wal0) ? wal - metrics.wal0 : null,
    live: hub.liveState(),
  });
}));
// A CPU profile of this process between start and stop (node:inspector): the §10 "further wins" profiles of a load window.
let profiler: import('node:inspector').Session | null = null;
harness.post('/__bench/profile/start', asyncRoute(async (_req, res) => {
  const inspector = await import('node:inspector');
  profiler?.disconnect();
  profiler = new inspector.Session();
  profiler.connect();
  const post = (method: string, params?: object) => new Promise<unknown>((resolve, reject) => profiler!.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result))));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', {interval: 200});
  await post('Profiler.start');
  res.json({ok: true});
}));
harness.post('/__bench/profile/stop', asyncRoute(async (_req, res) => {
  if (!profiler) {
    res.status(409).json({error: 'not profiling'});
    return;
  }
  const session = profiler;
  const result = await new Promise<{profile: unknown}>((resolve, reject) => session.post('Profiler.stop', (error, value) => (error ? reject(error) : resolve(value as {profile: unknown}))));
  session.disconnect();
  profiler = null;
  res.json(result.profile);
}));
harness.get('/__bench/info', (_req, res) => {
  res.json({pid: process.pid, node: process.version, arch: process.arch, platform: process.platform, appOrigin, appDir: appDir ?? null, dataDir});
});

// Fonts the way scripts/e2e-server.ts serves them (production puts them behind the web server, not the API).
const fontsDir = path.resolve('public/fonts');
if (existsSync(fontsDir))
  harness.use('/fonts', express.static(fontsDir, {setHeaders: res => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }}));
harness.use(app);

// The built app on the same origin, cross-origin isolated (performance.measureUserAgentSpecificMemory needs it).
if (appDir) {
  const root = path.resolve(appDir);
  if (!existsSync(path.join(root, 'index.html'))) throw Error(`${root} has no index.html: run npm run build:app first`);
  const isolate = (res: import('express').Response) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  };
  harness.use((_req, res, next) => {
    isolate(res);
    next();
  });
  harness.use(express.static(root, {index: false, setHeaders: res => isolate(res)}));
  const index = readFileSync(path.join(root, 'index.html'));
  harness.get(/.*/, (_req, res) => {
    res.type('html').send(index);
  });
}

const server = harness.listen(port, host);
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
server.keepAliveTimeout = 65_000;
server.requestTimeout = (await import('../../server/request-window')).SERVER_REQUEST_TIMEOUT_MS;
const ready = {pid: process.pid, port, host, benchKey, appOrigin, appDir: appDir ?? null};
if (readyFile) writeFileSync(readyFile, JSON.stringify(ready));
console.log('BENCH_READY ' + JSON.stringify({...ready, benchKey: undefined}));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  hub.closeDesignLiveStreams();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await (await import('../../server/design/document-store')).flushDocumentWrites().catch(() => {});
  await drainAppTasks().catch(() => {});
  await storage.closeDatabase().catch(() => {});
  await dropDatabase?.().catch(error => console.error('database cleanup failed', error));
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
