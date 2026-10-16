import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignFileChangesForTest, DESIGN_FILE_CHANGE_DROP_ORDER} from './helpers/postgresql-design-file-changes-inverse';
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
import {APPLICATION_TABLES, DESIGN_FILE_CHANGE_TABLES} from '../server/postgresql/schema/catalog';

// SQL038: "Morfa Design" saved changes of large files (docs/design-tool.md §Performance, "Saving large files"): the changes a large
// file's saves made after the version its stored text holds (design_file_changes). Derived, outside the SQLite import inventory; the rows
// go with their file.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL040–SQL038 in the guarded temporary database, so the next migrate is the real upgrade to 38 (and 39, 40 after it). */
async function before38(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignFileChangesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const user = async (db: Database, prefix: string) => {
  const id = prefix + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  return id;
};
const file = async (db: Database, owner: string) => {
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, 'Large mockup', '{}', 2, 0]);
  return id;
};
const change = (db: Database, fileId: string, version: number | string, patch = '{"ops":[]}') =>
  db.execute('INSERT INTO design_file_changes(file_id,version,patch) VALUES($1,$2,$3)', [fileId, String(version), patch]);

test('should register SQL038 as the ordinary design-file-changes migration after the AI pauses, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[8]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 9, name: 'design-file-changes', kind: 'ordinary', compatibleFrom: 9});
  assert.equal(migrations[7]!.name, 'design-ai-pauses');
  assert.deepEqual([...DESIGN_FILE_CHANGE_TABLES], [...DESIGN_FILE_CHANGE_DROP_ORDER]);
  for (const table of DESIGN_FILE_CHANGE_TABLES) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
  assert.deepEqual(migration.statements.filter(sql => /\b(DROP|ALTER)\b/i.test(sql)), [], 'it only adds');
});

test('PostgreSQL SQL038: the runtime adds and deletes saved changes but never rewrites one; the checks bound a change; rows go with the file', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const table of DESIGN_FILE_CHANGE_TABLES)
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal(await may(table, privilege), ['SELECT', 'INSERT', 'DELETE'].includes(privilege), `${table} ${privilege}`);

  const owner = await user(db, 'sql38:');
  const fileId = await file(db, owner);
  await change(db, fileId, 2);
  await change(db, fileId, 3, '{"ops":[{"op":"set"}]}');
  await assert.rejects(change(db, fileId, 2), code('23505'), 'one change per file version');
  await assert.rejects(change(db, fileId, 1), code('23514'), 'the first version is the stored text, never a change');
  await assert.rejects(change(db, fileId, 0), code('23514'));
  await assert.rejects(change(db, fileId, '9007199254740992'), code('23514'), 'versions stay within a safe JavaScript integer');
  await change(db, fileId, '9007199254740991');
  await assert.rejects(change(db, fileId, 4, '{'), code('23514'), 'a change is at least an empty JSON object');
  await assert.rejects(change(db, randomUUID(), 2), code('23503'), 'a change needs its file');
  await assert.rejects(db.execute('UPDATE design_file_changes SET patch=$2 WHERE file_id=$1', [fileId, '{}']), code('42501'), 'a saved change is never rewritten');
  const bound = await f.migration.one<{def: string}>(
    "SELECT string_agg(pg_get_constraintdef(oid),' ') AS def FROM pg_constraint WHERE conrelid='public.design_file_changes'::regclass AND contype='c'",
  );
  assert.match(bound!.def, /octet_length\(patch\) >= 2\) AND \(octet_length\(patch\) <= 20971520\)/, 'a change is at most 20 MB, the largest document');
  // The text catches up: the runtime deletes the changes it wrote into the file's text.
  await db.execute('DELETE FROM design_file_changes WHERE file_id=$1 AND version<=3', [fileId]);
  assert.deepEqual(await db.many('SELECT version::text AS version FROM design_file_changes WHERE file_id=$1', [fileId]), [{version: '9007199254740991'}]);
  const other = await file(db, owner);
  await change(db, other, 2);
  await db.execute('DELETE FROM design_files WHERE id=$1', [fileId]);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_file_changes WHERE file_id=$1', [fileId]))!.n, 0, 'the changes go with the file');
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_file_changes WHERE file_id=$1', [other]))!.n, 1, 'another file keeps its own');
});

test('PostgreSQL SQL038: the upgrade adds the table once, keeps the design files and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await file(db, await user(db, 'sql38:keep:'));
  const before = await db.many('SELECT id,user_id,name,version,document FROM design_files ORDER BY id');
  await f.migration.transaction(tx => before38(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_file_changes')::text AS name"))!.name, null);
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name,version,document FROM design_files ORDER BY id'), before, 'files are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-21), [{version: 9, name: 'design-file-changes'}, {version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});

test('PostgreSQL SQL038: retained saved changes forbid the test inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await change(db, await file(db, await user(db, 'sql38:retained:')), 2);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  await assert.rejects(f.migration.transaction(tx => before38(tx, f.isolated.databaseName)), /Retained saved changes forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
