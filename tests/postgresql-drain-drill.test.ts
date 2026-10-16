import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:net';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';

// Lane D step 5: scripts/deploy/drain-drill.ts removes what it made. The run of 2026-10-08 left 800 accounts, 121 teams, 120 files and
// 14 195 changes in production. Here the drill runs against the app on the test cluster (no collab nodes, so a run never gets past
// connecting its editors: every run here is stopped midway, the case that matters) and the counts of accounts, sessions, teams,
// memberships, files and changes must be what they were before it. A run killed with SIGKILL is removed by --cleanup-only; accounts
// that are not the run's stay; a production APP_ORIGIN is refused before any database connection.

const ROOT = path.resolve(import.meta.dirname, '..');
const DRILL = path.join(ROOT, 'scripts/deploy/drain-drill.ts');
const TABLES = ['users', 'sessions', 'design_teams', 'design_team_members', 'design_files', 'design_file_changes'] as const;

test('drain drill: removes what it made when it fails, is stopped or is cleaned up later; refuses production', {timeout: 300_000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true});
  const saved = {ENABLE_DESIGN_TOOL: process.env.ENABLE_DESIGN_TOOL, DESIGN_TOOL_ACCOUNTS: process.env.DESIGN_TOOL_ACCOUNTS, APP_ORIGIN: process.env.APP_ORIGIN};
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  process.env.ENABLE_DESIGN_TOOL = '1';
  const {app, drainAppTasks} = await import('../server/app');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const dir = mkdtempSync(path.join(tmpdir(), 'morfa-drill-'));
  const children = new Set<ChildProcess>();
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
    rmSync(dir, {recursive: true, force: true});
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const envFile = (name: string, values: Record<string, string>) => {
    const file = path.join(dir, name);
    writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
    return file;
  };
  const env = envFile('api.env', {
    APP_ORIGIN: base,
    MORFA_DATABASE_URL: f.isolated.runtimeUrl,
    MORFA_MIGRATION_DATABASE_URL: f.isolated.migrationUrl,
  });
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(TABLES.map(async table => [table, Number((await f.migration.one<{n: string}>(`SELECT count(*) AS n FROM ${table}`))!.n)] as const)),
    );
  const runAccounts = async (run: string) =>
    Number((await f.migration.one<{n: string}>("SELECT count(*) AS n FROM users WHERE id LIKE $1", [`drill-${run}-%`]))!.n);
  const runFiles = async (run: string) =>
    Number((await f.migration.one<{n: string}>("SELECT count(*) AS n FROM design_files WHERE user_id LIKE $1", [`drill-${run}-%`]))!.n);
  /** The drill as the operator runs it, against this app (the test app's cookie has no __Host- prefix). */
  const drill = (args: string[], file = env) => {
    const child = spawn(process.execPath, ['--import', 'tsx', DRILL, '--env', file, '--base', base, '--cookie', 'forma_session', '--out', path.join(dir, 'out.json'), ...args], {
      cwd: ROOT,
      env: {...process.env, MORFA_DATABASE_URL: ''},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '';
    child.stdout!.on('data', chunk => (output += chunk));
    child.stderr!.on('data', chunk => (output += chunk));
    const done = new Promise<{code: number | null; signal: NodeJS.Signals | null; output: string}>(resolve =>
      child.on('close', (code, signal) => {
        children.delete(child);
        resolve({code, signal, output});
      }),
    );
    return {child, done, output: () => output};
  };
  const until = async (what: string, check: () => Promise<boolean>, ms = 60_000) => {
    for (const start = Date.now(); !(await check()); await new Promise(resolve => setTimeout(resolve, 100)))
      if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
  };
  const run = () => randomBytes(5).toString('hex');

  // Accounts that are not a run's: a person, an old run's (no run id) and a run-shaped id outside .invalid. None may go.
  await f.migration.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Person',''),($3,$4,'Old drill',''),($5,$6,'Not a drill','')", [
    `person-${randomUUID()}`, `${randomUUID()}@example.com`,
    `drill-${randomUUID()}`, `old-${randomUUID()}@drill.invalid`,
    'drill-keepme1-1', 'drill-keepme1-1@example.com',
  ]);
  const before = await counts();

  await t.test('a run that fails after making its accounts removes them', async () => {
    const id = run();
    const failed = await drill(['--run', id, '--files', '2', '--editors', '2', '--big', '1', '--big-fixture', path.join(dir, 'missing.json')]).done;
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, new RegExp(`run ${id}: failed`));
    assert.match(failed.output, new RegExp(`run ${id}: removed 4 accounts, 4 sessions, \\d+ teams, 0 files, 0 changes`));
    assert.deepEqual(await counts(), before);
  });

  await t.test('a run stopped midway (SIGTERM while its editors connect) removes everything it made', async () => {
    const id = run();
    const running = drill(['--run', id, '--files', '3', '--editors', '2', '--big', '0']);
    await until('the run\'s files', async () => (await runFiles(id)) === 3);
    const during = await counts();
    assert.equal(during.users, before.users + 6);
    assert.ok(during.design_files >= before.design_files + 3 && during.design_teams >= before.design_teams + 3);
    running.child.kill('SIGTERM');
    const stopped = await running.done;
    assert.equal(stopped.code, 130, stopped.output);
    assert.match(stopped.output, new RegExp(`run ${id}: removed 6 accounts, 6 sessions, 3 teams, 3 files`));
    assert.deepEqual(await counts(), before);
  });

  await t.test('a run killed outright (SIGKILL) leaves its rows; --cleanup-only removes them and nothing else', async () => {
    const id = run();
    const running = drill(['--run', id, '--files', '2', '--editors', '2', '--big', '0']);
    await until('the run\'s files', async () => (await runFiles(id)) === 2);
    running.child.kill('SIGKILL');
    await running.done;
    assert.equal(await runAccounts(id), 4, 'no handler runs on SIGKILL');
    const cleaned = await drill(['--cleanup-only', id]).done;
    assert.equal(cleaned.code, 0, cleaned.output);
    const removed = JSON.parse(cleaned.output.trim().split('\n').at(-1)!);
    assert.equal(removed.run, id);
    assert.equal(removed.removed.accounts, 4);
    assert.equal(removed.removed.files, 2);
    assert.deepEqual(await counts(), before);
    // A run id that matches only the decoy outside .invalid removes nothing.
    const decoy = await drill(['--cleanup-only', 'keepme1']).done;
    assert.equal(JSON.parse(decoy.output.trim().split('\n').at(-1)!).removed.accounts, 0);
    assert.deepEqual(await counts(), before);
  });

  await t.test('production is refused before any connection, unless --allow-production', async () => {
    // A "database" that counts connections: the refusal must come before the drill opens one.
    let connections = 0;
    const listener: Server = createServer(socket => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as AddressInfo).port;
    try {
      const production = envFile('production.env', {
        APP_ORIGIN: 'https://app.example.com', // a public name (reserved .example names count as test hosts)
        MORFA_DATABASE_URL: `postgresql://morfa_runtime:unused@127.0.0.1:${port}/morfa`,
        MORFA_MIGRATION_DATABASE_URL: `postgresql://morfa_migration:unused@127.0.0.1:${port}/morfa`,
      });
      for (const args of [['--files', '1'], ['--cleanup-only', run()]]) {
        const refused = await drill(args, production).done;
        assert.equal(refused.code, 2, refused.output);
        assert.match(refused.output, /refusing app\.example\.com: it is a production database/);
        assert.match(refused.output, /--allow-production/);
      }
      assert.equal(connections, 0);
      // With the flag it goes on (here to a database that does not answer: the attempt is what shows the check passed).
      const allowed = await drill(['--cleanup-only', run(), '--allow-production'], production).done;
      assert.notEqual(allowed.code, 2);
      assert.ok(connections > 0);
      // Staging, bench-ru and the test cluster are not production.
      for (const origin of ['https://app.morfa.test', 'http://203.0.113.10', 'https://203.0.113.10', 'http://127.0.0.1:3000', 'http://localhost:5173']) {
        const other = envFile('other.env', {APP_ORIGIN: origin, MORFA_DATABASE_URL: f.isolated.runtimeUrl, MORFA_MIGRATION_DATABASE_URL: f.isolated.migrationUrl});
        const answer = await drill(['--cleanup-only', run()], other).done;
        assert.equal(answer.code, 0, `${origin}: ${answer.output}`);
      }
    } finally {
      await new Promise(resolve => listener.close(resolve));
    }
  });
});
