import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {DESIGN_FAVOURITE_DROP_ORDER, removeDesignFavouritesForTest} from './helpers/postgresql-design-favourites-inverse';
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
import {DESIGN_FAVOURITE_TABLES} from '../server/postgresql/schema/catalog';

// SQL018: "Favorites", the files and projects an account starred (docs/figma-parity-shell.md).

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL018 in the guarded temporary database, so the next migrate is the real upgrade to 18. */
async function before18(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignFavouritesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function account(db: Database) {
  const id = 'sql18:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  return id;
}

async function file(db: Database, owner: string) {
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, 'Mockup', '{}', 2, 0]);
  return id;
}

async function project(db: Database, owner: string) {
  const teamId = randomUUID(),
    id = randomUUID();
  await db.execute("INSERT INTO design_teams(id,owner_id,name) VALUES($1,$2,'Studio')", [teamId, owner]);
  await db.execute("INSERT INTO design_projects(id,team_id,name) VALUES($1,$2,'Website')", [id, teamId]);
  return id;
}

test('should register SQL018 as the ordinary favourites migration after the proven addresses, compatible from 17', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[17]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 18, name: 'design-favourites', kind: 'ordinary', compatibleFrom: 17},
  );
  assert.equal(migrations[16]!.name, 'proven-addresses');
  assert.deepEqual([...DESIGN_FAVOURITE_TABLES], [...DESIGN_FAVOURITE_DROP_ORDER]);
  assert.deepEqual(migration.statements.filter(sql => /\b(DROP|ALTER)\b/i.test(sql)), [], 'it only adds tables');
});

test('PostgreSQL SQL018: a star is the account\'s, once per file or project, and goes with what it marks', {timeout: 180000}, async t => {
  // The server's own modules (the export, the erasure) read the runtime database.
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  for (const table of DESIGN_FAVOURITE_TABLES)
    for (const [privilege, granted] of [['SELECT', true], ['INSERT', true], ['DELETE', true], ['UPDATE', false]] as const)
      assert.equal(
        (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok,
        granted,
        `${table} ${privilege}`,
      );
  const owner = await account(db);
  const fileId = await file(db, owner),
    projectId = await project(db, owner);
  await db.execute('INSERT INTO design_favourite_files(user_id,file_id) VALUES($1,$2)', [owner, fileId]);
  await assert.rejects(db.execute('INSERT INTO design_favourite_files(user_id,file_id) VALUES($1,$2)', [owner, fileId]), code('23505'), 'once per file');
  await assert.rejects(db.execute('INSERT INTO design_favourite_files(user_id,file_id) VALUES($1,$2)', [owner, randomUUID()]), code('23503'), 'only of a file');
  await db.execute('INSERT INTO design_favourite_projects(user_id,project_id) VALUES($1,$2)', [owner, projectId]);
  await assert.rejects(db.execute('INSERT INTO design_favourite_projects(user_id,project_id) VALUES($1,$2)', [owner, randomUUID()]), code('23503'), 'only of a project');
  // The account's data export lists its stars; its erasure takes them (the account row stays, anonymised).
  const {prepareExportMetadata} = await import('../server/launch/export-json');
  const {exportDesignFavourites, eraseDesignFavouritesOf} = await import('../server/design/favourites');
  const chunks: string[] = [];
  await prepareExportMetadata({favourites: exportDesignFavourites(owner)})(db, async text => void chunks.push(text));
  const exported = (JSON.parse('{' + chunks.join('') + '}') as {favourites: Array<{kind: string; id: string}>}).favourites;
  assert.deepEqual(exported.map(row => [row.kind, row.id]).sort(), [['file', fileId], ['project', projectId]].sort());
  const other = await account(db);
  await db.execute('INSERT INTO design_favourite_files(user_id,file_id) VALUES($1,$2)', [other, fileId]);
  await db.transaction(tx => eraseDesignFavouritesOf(tx, other));
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_favourite_files WHERE user_id=$1', [other]))!.n, 0, 'erased with its account');
  await db.execute('DELETE FROM design_files WHERE id=$1', [fileId]);
  await db.execute('DELETE FROM design_projects WHERE id=$1', [projectId]);
  for (const table of DESIGN_FAVOURITE_TABLES)
    assert.equal((await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [owner]))!.n, 0, `${table} goes with what it marks`);
});

test('PostgreSQL SQL018: the upgrade keeps the files, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await file(db, await account(db));
  await f.migration.transaction(tx => before18(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_favourite_files')::text AS name"))!.name, null);
  const before = await db.many('SELECT id,user_id,name,document FROM design_files ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name,document FROM design_files ORDER BY id'), before, 'files are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.at(-12), {version: 18, name: 'design-favourites'});
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
