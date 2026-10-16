import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignFileSharingForTest, DESIGN_FILE_SHARE_DROP_ORDER} from './helpers/postgresql-design-file-sharing-inverse';
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
import {DESIGN_FILE_SHARE_TABLES} from '../server/postgresql/schema/catalog';

// SQL015: sharing one file (docs/design-tool.md §Teams, "File access"): its guests, the invites waiting for their addresses, and the
// file's link access.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL015 in the guarded temporary database, so the next migrate is the real upgrade to 15. */
async function before15(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignFileSharingForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function user(db: Database) {
  const id = 'sql15:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  return id;
}
async function file(db: Database, owner: string) {
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, 'Mockup', '{}', 2, 0]);
  return id;
}
// 29 days by default: expires_at and created_at take clock_timestamp() a few microseconds apart, so an invite at exactly the 30-day
// bound can fail the bound's CHECK (23514) before the unique index answers (the "one invite per address" flake).
const invite = (db: Database, fileId: string, email: string, role = 'editor', days = 29) =>
  db.execute(
    `INSERT INTO design_file_invites(id,file_id,email,role,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+make_interval(days=>$5::int))`,
    [randomUUID(), fileId, email, role, days],
  );

test('should register SQL015 as the ordinary file-sharing migration after the e-mail invites, compatible from 14', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[14]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 15, name: 'design-file-sharing', kind: 'ordinary', compatibleFrom: 14},
  );
  assert.equal(migrations[13]!.name, 'design-team-email-invites');
  assert.deepEqual([...DESIGN_FILE_SHARE_TABLES].sort(), [...DESIGN_FILE_SHARE_DROP_ORDER].sort());
  assert.deepEqual(migration.statements.filter(sql => /\bDROP\b/i.test(sql)), [], 'it only adds');
});

test('PostgreSQL SQL015: guests, invites by address and the link are checked, and go with the file', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const may = async (table: string, privilege: string) =>
    (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const table of DESIGN_FILE_SHARE_TABLES) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(await may(table, privilege), true, `${table} ${privilege}`);
  const owner = await user(db),
    guest = await user(db);
  const fileId = await file(db, owner);
  assert.equal((await db.one<{link_access: string}>('SELECT link_access FROM design_files WHERE id=$1', [fileId]))!.link_access, 'none');
  await assert.rejects(db.execute("UPDATE design_files SET link_access='public' WHERE id=$1", [fileId]), code('23514'));
  await db.execute("UPDATE design_files SET link_access='view' WHERE id=$1", [fileId]);
  await db.execute("INSERT INTO design_file_members(file_id,user_id,role,invited_by) VALUES($1,$2,'editor',$3)", [fileId, guest, owner]);
  await assert.rejects(db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'admin')", [fileId, owner]), code('23514'), 'a guest views or edits');
  await assert.rejects(db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'viewer')", [fileId, guest]), code('23505'), 'once per file');
  await db.execute('INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,NULL)', [fileId, owner]);
  await invite(db, fileId, 'vera@example.ru');
  await assert.rejects(invite(db, fileId, 'vera@example.ru', 'viewer'), code('23505'), 'one invite per address');
  await assert.rejects(invite(db, fileId, 'Vera@Example.ru'), code('23514'));
  await assert.rejects(invite(db, fileId, 'lev@example.ru', 'owner'), code('23514'));
  await assert.rejects(invite(db, fileId, 'lev@example.ru', 'viewer', 31), code('23514'), 'at most 30 days');
  await db.execute('DELETE FROM design_files WHERE id=$1', [fileId]);
  for (const table of DESIGN_FILE_SHARE_TABLES)
    assert.equal((await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table} WHERE file_id=$1`, [fileId]))!.n, 0, `${table} goes with the file`);
});

test('PostgreSQL SQL015: the upgrade keeps the files, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await file(db, await user(db));
  await f.migration.transaction(tx => before15(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_file_members')::text AS name"))!.name, null);
  const before = await db.many('SELECT id,user_id,name,version,document FROM design_files ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name,version,document FROM design_files ORDER BY id'), before, 'files are untouched');
  assert.deepEqual(await db.many('SELECT DISTINCT link_access FROM design_files'), [{link_access: 'none'}]);
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-15), [{version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});

test('PostgreSQL SQL015: a retained guest forbids the test inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = await user(db);
  const fileId = await file(db, owner);
  await db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'viewer')", [fileId, await user(db)]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  await assert.rejects(f.migration.transaction(tx => before15(tx, f.isolated.databaseName)), /Retained design_file_members forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
