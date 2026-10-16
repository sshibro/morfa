import type {TestContext} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDatabase, type Database} from '../../server/postgresql/client';
import {loadDatabaseConfig} from '../../server/postgresql/config';
import {migrateDatabase, assertDatabaseReady} from '../../server/postgresql/migrations';
import {createPostgresqlTestDatabase, type PostgresqlTestDatabase} from './postgresql';

let runtimeBound = false;

/** One guarded, fully migrated database. Runtime imports are bound once per test process. */
export async function createPostgresqlRuntimeFixture(t: TestContext, options: {bindRuntime?: boolean} = {}) {
  if (options.bindRuntime && runtimeBound) throw Error('Bind the runtime once in a parent test and reuse its subtests.');
  if (options.bindRuntime && process.env.MORFA_DATABASE_URL) throw Error('A runtime fixture must not replace an existing application database configuration.');
  // Claim before the first await so concurrent callers cannot both bind the cached module.
  if (options.bindRuntime) runtimeBound = true;
  let isolated: PostgresqlTestDatabase | undefined;
  let directory: string | undefined;
  let migration: Database | undefined;
  let runtime: Database | undefined;
  let environmentBound = false;
  const previous = {NODE_ENV: process.env.NODE_ENV, DATA_DIR: process.env.DATA_DIR};
  const cleanup = async () => {
    const results = await Promise.allSettled([migration?.close(), runtime?.close()]);
    if (isolated) results.push(...await Promise.allSettled([isolated.close()]));
    if (directory) results.push(...await Promise.allSettled([rm(directory, {recursive: true, force: true})]));
    if (environmentBound) {
      delete process.env.MORFA_DATABASE_URL;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Owned runtime fixture cleanup failed: ' + failures.map(result => String((result.reason as {message?: unknown})?.message ?? result.reason)).join('; '));
  };
  try {
    isolated = await createPostgresqlTestDatabase();
    directory = await mkdtemp(path.join(tmpdir(), 'morfa-pg-runtime-'));
    const env = {...process.env, ...isolated.env, NODE_ENV: 'test', DATA_DIR: directory};
    const roles = {runtimeRole: isolated.roles.runtime, backupRole: isolated.roles.backup};
    migration = createDatabase(loadDatabaseConfig('migration', env));
    await migrateDatabase(migration, {mode: 'fresh', ...roles});
    if (options.bindRuntime) {
      environmentBound = true;
      process.env.MORFA_DATABASE_URL = isolated.runtimeUrl;
      process.env.NODE_ENV = 'test'; process.env.DATA_DIR = directory;
      runtime = (await import('../../server/db')).db;
    } else runtime = createDatabase(loadDatabaseConfig('application', env));
    await assertDatabaseReady(runtime);
    t.after(cleanup);
    return {migration, runtime, roles, isolated, env, dataDir: directory};
  } catch (error) {await cleanup(); throw error;}
}
