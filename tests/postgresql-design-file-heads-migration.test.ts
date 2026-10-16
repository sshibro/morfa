import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignFileHeadsForTest, DESIGN_FILE_HEAD_DROP_ORDER} from './helpers/postgresql-design-file-heads-inverse';
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
import {DESIGN_FILE_HEAD_TABLES} from '../server/postgresql/schema/catalog';

// SQL016: the collab journal's version counter beside the file, written only by a collab node run with
// MORFA_JOURNAL_VERSION_HEADS=1.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL016 in the guarded temporary database, so the next migrate is the real upgrade to 16. */
async function before16(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignFileHeadsForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function file(db: Database) {
  const owner = 'sql16:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [owner, randomUUID() + '@example.invalid']);
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, 'Mockup', '{}', 2, 0]);
  return id;
}

test('should register SQL016 as the ordinary version-head migration after file sharing, compatible from 15', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[15]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 16, name: 'design-file-heads', kind: 'ordinary', compatibleFrom: 15},
  );
  assert.equal(migrations[14]!.name, 'design-file-sharing');
  assert.deepEqual([...DESIGN_FILE_HEAD_TABLES], [...DESIGN_FILE_HEAD_DROP_ORDER]);
  assert.deepEqual(migration.statements.filter(sql => /\b(DROP|ALTER)\b/i.test(sql)), [], 'it only adds a table');
});

test('PostgreSQL SQL016: a head is checked, moved by the runtime role, and goes with its file', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
    assert.equal(
      (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.design_file_heads', privilege]))!.ok,
      true,
      privilege,
    );
  const id = await file(db);
  await assert.rejects(db.execute('INSERT INTO design_file_heads(file_id,version) VALUES($1,0)', [id]), code('23514'));
  await assert.rejects(db.execute('INSERT INTO design_file_heads(file_id,version) VALUES($1,1)', [randomUUID()]), code('23503'), 'only of a file');
  await db.execute('INSERT INTO design_file_heads(file_id,version) VALUES($1,7)', [id]);
  await assert.rejects(db.execute('INSERT INTO design_file_heads(file_id,version) VALUES($1,8)', [id]), code('23505'), 'one per file');
  await db.execute('UPDATE design_file_heads SET version=9 WHERE file_id=$1', [id]);
  await db.execute('DELETE FROM design_files WHERE id=$1', [id]);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_file_heads WHERE file_id=$1', [id]))!.n, 0, 'goes with the file');
});

test('PostgreSQL SQL016: the upgrade keeps the files, and is a no-op the second time; a retained head forbids the inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await file(db);
  await f.migration.transaction(tx => before16(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_file_heads')::text AS name"))!.name, null);
  const before = await db.many('SELECT id,user_id,name,version,document FROM design_files ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name,version,document FROM design_files ORDER BY id'), before, 'files are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-14), [{version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
  const id = (await db.one<{id: string}>('SELECT id FROM design_files LIMIT 1'))!.id;
  await db.execute('INSERT INTO design_file_heads(file_id,version) VALUES($1,3)', [id]);
  await assert.rejects(f.migration.transaction(tx => before16(tx, f.isolated.databaseName)), /Retained design_file_heads forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
});
