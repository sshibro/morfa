import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignLibrariesForTest, DESIGN_LIBRARY_DROP_ORDER} from './helpers/postgresql-design-libraries-inverse';
import {removeDesignAiPausesForTest} from './helpers/postgresql-design-ai-pauses-inverse';
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
import {APPLICATION_TABLES, DESIGN_LIBRARY_PICTURE_TABLES, DESIGN_LIBRARY_TABLES} from '../server/postgresql/schema/catalog';

// SQL036: "Morfa Design" shared libraries (docs/design-tool.md §Teams): libraries, their immutable versions, the files that enabled
// them, and picture copies for files of another place. Derived tables, outside the SQLite import inventory.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL040–SQL036 in the guarded temporary database, so the next migrate is the real upgrade to 36 (and 37–40 after it). */
async function before36(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  await removeDesignAiPausesForTest(tx);
  assert.equal(await removeDesignLibrariesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const row = {
  user: (db: Database, id: string) => db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']),
  file: async (db: Database, user: string) => {
    const id = randomUUID();
    await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, user, 'Library', '{}', 2, 0]);
    return id;
  },
  library: async (db: Database, file: string, user: string) => {
    const id = randomUUID();
    await db.execute('INSERT INTO design_libraries(id,file_id,user_id,version) VALUES($1,$2,$3,1)', [id, file, user]);
    return id;
  },
  version: (db: Database, library: string, user: string, fields: Record<string, unknown> = {}) =>
    db.execute(
      'INSERT INTO design_library_versions(id,library_id,user_id,version,file_version,description,manifest,snapshot,bytes,image_files) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [randomUUID(), library, user, fields.version ?? 1, 1, fields.description ?? '', '{}', '{}', 4, fields.image_files ?? []],
    ),
};

test('should register SQL036 as the ordinary design-libraries migration after the comments, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[6]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 7, name: 'design-libraries', kind: 'ordinary', compatibleFrom: 7});
  assert.equal(migrations[4]!.name, 'design-teams');
  assert.equal(migrations[5]!.name, 'design-comments');
  assert.deepEqual([...DESIGN_LIBRARY_TABLES, ...DESIGN_LIBRARY_PICTURE_TABLES].sort(), [...DESIGN_LIBRARY_DROP_ORDER].sort());
  for (const table of DESIGN_LIBRARY_DROP_ORDER) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
  assert.ok(!migration.statements.some(sql => /\bDROP\b/i.test(sql)), 'nothing is dropped');
});

test('PostgreSQL SQL036: the runtime publishes, enables and erases libraries; checks keep versions unique and in bounds; rows go with their file', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const table of DESIGN_LIBRARY_TABLES)
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal(await may(table, privilege), ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), `${table} ${privilege}`);
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
    assert.equal(await may('design_library_pictures', privilege), ['SELECT', 'INSERT', 'DELETE'].includes(privilege), `design_library_pictures ${privilege}`);

  const owner = 'sql36:owner:' + randomUUID();
  await row.user(db, owner);
  const file = await row.file(db, owner),
    other = await row.file(db, owner);
  const library = await row.library(db, file, owner);
  await assert.rejects(row.library(db, file, owner), code('23505'), 'one library per file');
  await row.version(db, library, owner);
  await assert.rejects(row.version(db, library, owner), code('23505'), 'a version number once');
  await assert.rejects(row.version(db, library, owner, {version: 0}), code('23514'), 'versions from 1');
  await assert.rejects(row.version(db, library, owner, {version: 2, description: 'x'.repeat(1001)}), code('23514'), 'a short description');
  await row.version(db, library, owner, {version: 2});
  await db.execute('INSERT INTO design_library_subscriptions(file_id,library_id,seen_version) VALUES($1,$2,1)', [other, library]);
  await assert.rejects(db.execute('INSERT INTO design_library_subscriptions(file_id,library_id) VALUES($1,$2)', [other, library]), code('23505'), 'enabled once');
  await assert.rejects(db.execute('UPDATE design_library_subscriptions SET seen_version=0 WHERE file_id=$1', [other]), code('23514'));
  await assert.rejects(db.execute('INSERT INTO design_library_subscriptions(file_id,library_id) VALUES($1,$2)', [other, randomUUID()]), code('23503'), 'of a library that exists');

  // A picture copy goes with its picture.
  await db.execute("INSERT INTO design_images(filename,user_id,file_id,kind,bytes,width,height) VALUES('dz-sql36.webp',$1,$2,'image',10,1,1)", [owner, other]);
  await db.execute("INSERT INTO design_library_pictures(filename,source) VALUES('dz-sql36.webp','dz-source.webp')");
  await assert.rejects(db.execute("INSERT INTO design_library_pictures(filename,source) VALUES('dz-missing.webp','x')"), code('23503'));
  await assert.rejects(db.execute("INSERT INTO design_library_pictures(filename,source) VALUES('dz-sql36.webp','../x')"), code('23514'));
  await db.execute("DELETE FROM design_images WHERE filename='dz-sql36.webp'");
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_library_pictures'))!.n, 0);

  // The subscribing file goes: its subscription with it. The library's file goes: the library, its versions and every subscription.
  await db.execute('DELETE FROM design_files WHERE id=$1', [other]);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_library_subscriptions'))!.n, 0);
  const third = await row.file(db, owner);
  await db.execute('INSERT INTO design_library_subscriptions(file_id,library_id) VALUES($1,$2)', [third, library]);
  await db.execute('DELETE FROM design_files WHERE id=$1', [file]);
  for (const table of ['design_libraries', 'design_library_versions', 'design_library_subscriptions'])
    assert.equal((await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table}`))!.n, 0, table);
});

test('PostgreSQL SQL036: the upgrade adds the tables once, keeps the design files and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = 'sql36:keep:' + randomUUID();
  await row.user(db, owner);
  await row.file(db, owner);
  const before = await db.many('SELECT id,user_id,name FROM design_files ORDER BY id');
  await f.migration.transaction(tx => before36(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_libraries')::text AS name"))!.name, null);
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name FROM design_files ORDER BY id'), before, 'files are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-23), [{version: 7, name: 'design-libraries'}, {version: 8, name: 'design-ai-pauses'}, {version: 9, name: 'design-file-changes'}, {version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  assert.deepEqual(ledgerRows[4], {version: 5, name: 'design-teams'});
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
