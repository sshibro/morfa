import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignAgentCreditsForTest} from './helpers/postgresql-design-agent-credits-inverse';
import {createDatabase, type Database, type TransactionContext} from '../server/postgresql/client';
import {loadDatabaseConfig} from '../server/postgresql/config';
import {
  DATABASE_SCHEMA_VERSION,
  acquireMigrationLock,
  databaseStructureFingerprint,
  loadDatabaseMigrations,
  migrateDatabase,
  readDatabaseReadiness,
} from '../server/postgresql/migrations';

// SQL024: "Agent" in the AI credits' ledger: the design AI's requests and pauses take the action
// 'agent'. Numbered after release 2's 022 and 023 when the two were combined.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL024 in the guarded temporary database, so the next migrate is the real upgrade to 24. */
async function before24(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignAgentCreditsForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const pause = (db: Database, action: string) =>
  db.execute(
    "INSERT INTO design_ai_pauses(id,action,tier,price_version,request_id,usage_usd,ceiling_usd,created_at) VALUES($1,$2,'leg',$3,$4,2,1,'2026-10-11T12:00:00.000Z')",
    [randomUUID(), action, 'sql24-' + randomUUID().slice(0, 8), randomUUID()],
  );

test('should register SQL024 as the ordinary design-agent-credits migration after the AI analyst, compatible from 20', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[23]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 24, name: 'design-agent-credits', kind: 'ordinary', compatibleFrom: 20},
  );
  assert.equal(migrations[22]!.name, 'admin-analyst');
  const changes = migration.statements.map(sql => sql.replace(/^--.*$/gm, '').trim()).filter(Boolean);
  for (const sql of changes) assert.match(sql, /^ALTER TABLE public\.design_ai_(requests|pauses) (DROP|ADD) CONSTRAINT design_ai_(requests|pauses)_action_check\b/, sql);
  assert.equal(changes.length, 4);
});

test('PostgreSQL SQL024: the upgrade lets the design AI record "Agent", and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await f.migration.transaction(tx => before24(tx, f.isolated.databaseName));
  await assert.rejects(pause(db, 'agent'), code('23514'), 'before 24 the agent is not an action');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  await pause(db, 'agent');
  await assert.rejects(pause(db, 'chat'), code('23514'), 'still only the known actions');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.at(-6), {version: 24, name: 'design-agent-credits'});
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
