// Starts and stops the bench server (scripts/bench/server.ts): on this machine, or in the dev-4 container (TARGETS §0:
// Docker limited to 4 CPUs, `docker run --cpus 4 -m 5g`). The PostgreSQL test cluster is the lane's own (docs/dev.md):
// state in BENCH_PG_STATE (default ~/.cache/morfa-pg/B0). In dev-4 the host makes and migrates the database, and the
// container reaches the cluster over the cluster's Docker network through a loopback forward (the server's config refuses
// a non-loopback database without TLS).
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {ROOT} from './targets';
import {sleep} from './machine';

const exec = promisify(execFile);
export const PG_STATE = process.env.BENCH_PG_STATE || path.join(homedir(), '.cache/morfa-pg/B0');
export const NODE_IMAGE = process.env.BENCH_DEV4_IMAGE || 'morfa-b0-dev4:1';
export const LINUX_MODULES_VOLUME = process.env.BENCH_LINUX_MODULES || 'morfa-b0-nm-linux';
export const DEV4_CONTAINER = process.env.BENCH_DEV4_CONTAINER || 'morfa-b0-dev4';
export const DEV4_CPUS = process.env.BENCH_DEV4_CPUS || '4';
export const DEV4_MEMORY = process.env.BENCH_DEV4_MEMORY || '5g';

/** `bench-ru` (lane B5): this machine is bench-ru; the server runs here pinned to the Morfa slice's cores (BENCH_SERVER_CPUS,
 *  taskset) on the VM's guarded bench cluster, listening on every interface so loadgen on the ru-net VM reaches it (ufw lets only
 *  ru-net in). */
export type ServerTarget = 'local' | 'dev-4' | 'bench-ru';
export type BenchServer = {
  target: ServerTarget;
  base: string;
  benchKey: string;
  pid?: number;
  container?: string;
  /** The resources the server had: "local", or "dev-4 (--cpus 4 -m 5g)". */
  shape: string;
  /** The runtime role's URL of the server's database as this machine reaches it (lane B6: collab runs beside the bench on it). */
  databaseUrl: string;
  /** ru-net's tc netem on or off (bench-ru: ssh to the ru-net VM); undefined where the target has no ru-net. */
  netem?(on: boolean): Promise<boolean>;
  /** kill -9 of the server process (TARGETS D2); `restart` brings it back on the same database. */
  kill(): Promise<void>;
  restart(): Promise<void>;
  stop(): Promise<void>;
};
export type StartOptions = {
  target: ServerTarget;
  port?: number;
  appDir?: string;
  /** DESIGN_* overrides for this server (operator settings). */
  env?: Record<string, string>;
  /** The checkout the server runs from (close.sh passes a clean checkout of the hash); default this worktree. */
  source?: string;
  log?: (line: string) => void;
};

export function clusterEnv(state = PG_STATE): Record<string, string> {
  const file = path.join(state, 'cluster.env');
  if (!existsSync(file)) throw Error(`No PostgreSQL test cluster env at ${file}: npm run db:test-cluster -- up --port 5450 --state-dir ${state}`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

export function clusterContainer(state = PG_STATE): {container: string; network: string} {
  const parsed = JSON.parse(readFileSync(path.join(state, 'state.json'), 'utf8')) as {containerName: string};
  return {container: parsed.containerName, network: `${parsed.containerName}_default`};
}

async function waitReady(base: string, benchKey: string, timeoutMs: number, alive: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) throw Error('the bench server exited before it was ready');
    try {
      const response = await fetch(base + '/__bench/info', {headers: {'x-bench-key': benchKey}});
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw Error(`the bench server at ${base} was not ready in ${timeoutMs / 1000} s`);
}

export async function startServer(options: StartOptions): Promise<BenchServer> {
  return options.target === 'dev-4' ? startDev4(options) : startLocal(options);
}

/** bench-ru: the server's CPU pin (`taskset -c` with the Morfa slice's cores, scripts/deploy/bench-run.sh sets it). */
export const SERVER_CPUS = process.env.BENCH_SERVER_CPUS || '';

/** ru-net's netem over SSH (scripts/deploy/provision-bench.sh installs /usr/local/sbin/morfa-netem there). */
export async function ruNetNetem(on: boolean): Promise<boolean> {
  const target = process.env.BENCH_NETEM_SSH;
  if (!target) return false;
  try {
    await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, 'sudo', '-n', '/usr/local/sbin/morfa-netem', on ? 'on' : 'off'], {timeout: 30_000});
    return on;
  } catch {
    return false;
  }
}

/** A new database in the lane's cluster, migrated, made from this process (the guarded helper of the test suites). */
async function benchDatabase() {
  const env = clusterEnv();
  const {createPostgresqlTestDatabase} = await import('../../../tests/helpers/postgresql');
  const {createDatabase} = await import('../../../server/postgresql/client');
  const {loadDatabaseConfig} = await import('../../../server/postgresql/config');
  const {migrateDatabase} = await import('../../../server/postgresql/migrations');
  const isolated = await createPostgresqlTestDatabase(env);
  const migration = createDatabase(loadDatabaseConfig('migration', {...isolated.env}));
  await migrateDatabase(migration, {mode: 'fresh', runtimeRole: isolated.roles.runtime, backupRole: isolated.roles.backup});
  await migration.close();
  return isolated;
}

async function startLocal(options: StartOptions): Promise<BenchServer> {
  const port = options.port ?? 3410;
  const benchKey = randomBytes(16).toString('hex');
  const source = options.source ?? ROOT;
  const isolated = await benchDatabase();
  // BENCH_NODE_FLAGS: extra V8/Node flags of the server process (lane B6 tried the young generation's size for TARGETS A1).
  const extraFlags = (process.env.BENCH_NODE_FLAGS ?? '').split(/\s+/).filter(Boolean);
  const args = ['--expose-gc', '--max-old-space-size=4096', ...extraFlags, '--import', 'tsx', 'scripts/bench/server.ts', '--port', String(port)];
  if (options.appDir) args.push('--app-dir', options.appDir);
  const benchRu = options.target === 'bench-ru';
  // bench-ru: every interface (loadgen comes from the ru-net VM; ufw admits only it), the slice's cores.
  if (benchRu) args.push('--host', '0.0.0.0');
  const command = benchRu && SERVER_CPUS ? ['taskset', '-c', SERVER_CPUS, process.execPath, ...args] : [process.execPath, ...args];
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let exited = true;
  const launch = async () => {
    const env: NodeJS.ProcessEnv = {...process.env, ...isolated.env, ...options.env, BENCH_KEY: benchKey};
    for (const key of ['MORFA_TEST_DATABASE_URL', 'MORFA_TEST_CLUSTER_ID', 'MORFA_TEST_CLUSTER_TOKEN', 'MORFA_TEST_ENDPOINT']) delete env[key];
    const started = spawn(command[0], command.slice(1), {cwd: source, env, stdio: ['ignore', 'pipe', 'pipe']});
    child = started;
    exited = false;
    started.once('exit', () => {
      if (child === started) exited = true;
    });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) options.log?.(`[server] ${line}`);
    };
    started.stdout?.on('data', forward);
    started.stderr?.on('data', forward);
    await waitReady(base, benchKey, 120_000, () => !exited);
  };
  const waitExit = async () => {
    for (let i = 0; i < 80 && !exited; i++) await sleep(250);
  };
  try {
    await launch();
  } catch (error) {
    await isolated.close().catch(() => {});
    throw error;
  }
  return {
    target: options.target === 'bench-ru' ? 'bench-ru' : 'local',
    base,
    benchKey,
    get pid() {
      return child?.pid;
    },
    shape: benchRu ? `bench-ru (${process.env.BENCH_PROFILE || 'cores?'}: taskset -c ${SERVER_CPUS || 'all'}, PostgreSQL in morfa.slice)` : 'local (this Mac, no limits)',
    ...(benchRu ? {netem: ruNetNetem} : {}),
    databaseUrl: isolated.runtimeUrl,
    async kill() {
      child?.kill('SIGKILL');
      await waitExit();
    },
    restart: launch,
    async stop() {
      if (!exited) {
        child?.kill('SIGTERM');
        await waitExit();
        if (!exited) child?.kill('SIGKILL');
      }
      await isolated.close().catch(error => options.log?.(`database cleanup failed: ${String(error)}`));
    },
  };
}

export async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const {stdout} = await exec('docker', args, {timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024});
  return stdout.trim();
}

/** Linux node_modules for the container (the shared install is macOS's): `npm ci` into a Docker volume, redone when the
 *  source's package-lock.json differs from the one the volume was installed from (its sha in /nm/.lock-sha). */
async function ensureLinuxModules(source: string, log?: (line: string) => void) {
  const {createHash} = await import('node:crypto');
  const lock = readFileSync(path.join(source, 'package-lock.json'));
  const sha = createHash('sha1').update(lock).digest('hex').slice(0, 10);
  const installed = await docker(['run', '--rm', '-v', `${LINUX_MODULES_VOLUME}:/nm`, NODE_IMAGE, 'sh', '-c', 'cat /nm/.lock-sha 2>/dev/null || true']).catch(() => '');
  if (installed.trim() === sha) return;
  log?.(`installing Linux node_modules for package-lock ${sha} into the volume ${LINUX_MODULES_VOLUME} (npm ci in a container)`);
  await docker(['run', '--rm', '--cpus', '2', '-m', '3g', '-v', `${LINUX_MODULES_VOLUME}:/nm`, '-v', `${source}:/src:ro`, NODE_IMAGE, 'sh', '-c',
    `cp /src/package.json /src/package-lock.json /nm/ && cd /nm && rm -rf node_modules && npm ci --no-audit --no-fund --loglevel=error && echo ${sha} > /nm/.lock-sha`], 30 * 60_000);
}

/** The dev-4 image (scripts/bench/dev4.Dockerfile), built when missing. */
async function ensureImage(log?: (line: string) => void) {
  if (await docker(['image', 'inspect', NODE_IMAGE]).then(() => true, () => false)) return;
  log?.(`building ${NODE_IMAGE} from scripts/bench/dev4.Dockerfile`);
  await docker(['build', '-t', NODE_IMAGE, '-f', path.join(ROOT, 'scripts/bench/dev4.Dockerfile'), path.join(ROOT, 'scripts/bench')], 600_000);
}

async function startDev4(options: StartOptions): Promise<BenchServer> {
  const port = options.port ?? 3410;
  await ensureImage(options.log);
  await ensureLinuxModules(options.source ?? ROOT, options.log);
  const benchKey = randomBytes(16).toString('hex');
  const source = options.source ?? ROOT;
  const pg = clusterContainer();
  // The database: made and migrated from the host, with the guarded test-cluster helper.
  const isolated = await benchDatabase();
  const inside = (url: string) => url.replace(/@127\.0\.0\.1:\d+\//, '@127.0.0.1:15450/');
  await docker(['rm', '-f', DEV4_CONTAINER]).catch(() => '');
  // The checkout is copied into the container once (a restart after kill -9 starts at once); node_modules is the Linux install.
  const copy = [
    'set -e',
    'if [ ! -e /work/.copied ]; then mkdir -p /work && cd /repo && tar --exclude=./node_modules --exclude=./dist --exclude=./fixtures --exclude=./output --exclude=./.git --exclude=./target -cf - . | tar -C /work -xf - && ln -sfn /nm/node_modules /work/node_modules && touch /work/.copied; fi',
    'cd /work',
    `exec node --expose-gc --max-old-space-size=4096 ${process.env.BENCH_NODE_FLAGS ?? ''} --import tsx scripts/bench/server.ts --host 0.0.0.0 --port ${port}`,
  ].join('; ');
  const envArgs = Object.entries({
    MORFA_DATABASE_URL: inside(isolated.runtimeUrl),
    MORFA_MIGRATION_DATABASE_URL: inside(isolated.migrationUrl),
    MORFA_BACKUP_DATABASE_URL: inside(isolated.backupUrl),
    BENCH_PG_FORWARD: `${pg.container}:5432`,
    BENCH_KEY: benchKey,
    BENCH_APP_ORIGIN: `http://127.0.0.1:${port}`,
    ...(process.env.BENCH_API_PROCESSES ? {BENCH_API_PROCESSES: process.env.BENCH_API_PROCESSES} : {}),
    ...options.env,
  }).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const run = (memory: string) =>
    docker(['run', '-d', '--name', DEV4_CONTAINER, '--cpus', DEV4_CPUS, '-m', memory, '--memory-swap', memory, '--cap-add', 'NET_ADMIN',
      '--network', pg.network, '-p', `127.0.0.1:${port}:${port}`, '--ulimit', 'nofile=65536:65536',
      '-v', `${source}:/repo:ro`, '-v', `${LINUX_MODULES_VOLUME}:/nm:ro`, ...envArgs, NODE_IMAGE, 'sh', '-c', copy]);
  let memory = DEV4_MEMORY;
  try {
    await run(memory);
  } catch (error) {
    options.log?.(`dev-4 with -m ${memory} failed (${String(error).slice(0, 200)}); trying -m 4g`);
    await docker(['rm', '-f', DEV4_CONTAINER]).catch(() => '');
    memory = '4g';
    await run(memory);
  }
  const base = `http://127.0.0.1:${port}`;
  const alive = async () => (await docker(['inspect', '-f', '{{.State.Running}}', DEV4_CONTAINER]).catch(() => 'false')) === 'true';
  let running = true;
  const poll = setInterval(() => void alive().then(state => (running = state)), 2000);
  try {
    await waitReady(base, benchKey, 180_000, () => running);
  } catch (error) {
    const logs = await docker(['logs', '--tail', '40', DEV4_CONTAINER]).catch(() => '');
    clearInterval(poll);
    await docker(['rm', '-f', DEV4_CONTAINER]).catch(() => '');
    await isolated.close().catch(() => {});
    throw Error(`${String(error)}\n${logs}`);
  }
  clearInterval(poll);
  return {
    target: 'dev-4',
    base,
    benchKey,
    container: DEV4_CONTAINER,
    shape: `dev-4 (docker --cpus ${DEV4_CPUS} -m ${memory}, ${NODE_IMAGE})`,
    databaseUrl: isolated.runtimeUrl,
    async kill() {
      await docker(['kill', '-s', 'KILL', DEV4_CONTAINER]).catch(() => '');
    },
    async restart() {
      await docker(['start', DEV4_CONTAINER]);
      await waitReady(base, benchKey, 180_000, () => true);
    },
    async stop() {
      await docker(['stop', '-t', '20', DEV4_CONTAINER]).catch(() => '');
      await docker(['rm', '-f', DEV4_CONTAINER]).catch(() => '');
      await isolated.close().catch(error => options.log?.(`database cleanup failed: ${String(error)}`));
    },
  };
}

export function scratchDir(prefix = 'morfa-bench-'): {dir: string; remove(): void} {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {dir, remove: () => rmSync(dir, {recursive: true, force: true})};
}
