import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignTeamsForTest} from './helpers/postgresql-design-teams-inverse';
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
import {APPLICATION_TABLES, DESIGN_TABLES} from '../server/postgresql/schema/catalog';
import {prepareExportMetadata} from '../server/launch/export-json';

// SQL031: "Morfa Design" files, their versions and pictures (docs/design-tool.md §Server API). Derived tables, outside the
// SQLite import inventory, erased explicitly with the account.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;
/** Referencing tables first. */
const DROP_ORDER = ['design_images', 'design_file_versions', 'design_files'] as const;
/** SQL032 (the "Morfa Design Pro" ledger) comes later: its empty tables go first, refunds before the payments they reference. */
const LATER = ['design_ai_ledger', 'design_ai_requests', 'design_ai_balances', 'design_refunds', 'design_payments', 'design_subscriptions'] as const;

/** Test-only inverse of SQL032 and SQL031 in the guarded temporary database: the empty tables and the ledger rows go, so the next migrate is the real 30 → 31 → 32 upgrade. */
async function schema30(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  // SQL034 (teams) first: it added columns to the design tables.
  await removeDesignTeamsForTest(tx);
  for (const table of [...LATER, ...DROP_ORDER]) {
    assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.' + table))!.n, 0);
    await tx.execute('DROP TABLE public.' + table);
  }
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version IN(2,3,4,5,6,7,8,9,10,11)');
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const row = {
  user: (db: Database, id: string) => db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']),
  file: (db: Database, user: string, patch: Partial<Record<'id' | 'name' | 'client_id' | 'thumbnail_filename', string | null>> = {}) => {
    const value = {id: randomUUID(), name: 'Mockup', client_id: null, thumbnail_filename: null, ...patch};
    return db.execute(
      "INSERT INTO design_files(id,user_id,name,document,bytes,node_count,image_files,client_id,thumbnail_filename) VALUES($1,$2,$3,'{\"pages\":[]}',13,1,$4,$5,$6)",
      [value.id, user, value.name, ['dz-a.webp'], value.client_id, value.thumbnail_filename],
    );
  },
  image: (db: Database, user: string, filename: string, file: string | null, kind = 'image') =>
    db.execute('INSERT INTO design_images(filename,user_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,$4,10,4,4)', [filename, user, file, kind]),
  version: (db: Database, user: string, file: string, label: string | null = null) =>
    db.execute("INSERT INTO design_file_versions(id,file_id,user_id,version,label,document,bytes) VALUES($1,$2,$3,1,$4,'{}',2)", [randomUUID(), file, user, label]),
};

async function seed(db: Database, user: string) {
  const file = randomUUID();
  await row.file(db, user, {id: file});
  await row.version(db, user, file);
  await row.version(db, user, file, 'Final');
  await row.image(db, user, 'dz-' + randomUUID() + '.webp', file);
  await row.image(db, user, 'dzt-' + randomUUID() + '.webp', file, 'thumbnail');
  return file;
}
const counts = async (db: Database, user: string) => {
  const result: Record<string, number> = {};
  for (const table of DESIGN_TABLES) result[table] = (await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [user]))!.n;
  return result;
};

test('should register SQL031 as the ordinary design-files migration, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[1];
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 2, name: 'design-files', kind: 'ordinary', compatibleFrom: 2});
  assert.equal(migration.statements.length, 9);
  assert.equal(migration.statements.filter(statement => /(^|\n)CREATE TABLE public\./.test(statement)).length, 3);
  assert.ok(migration.statements.every(statement => /(^|\n)(CREATE|ALTER) /.test(statement)), 'no statement is only a comment');
  assert.deepEqual([...DESIGN_TABLES].sort(), [...DROP_ORDER].sort());
  for (const table of DESIGN_TABLES) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
  // No table name clashes with the site designs or the Figma connection tables.
  for (const table of DESIGN_TABLES) assert.ok(!['design', 'designs'].includes(table) && !table.startsWith('figma_'), table);
});

test('PostgreSQL SQL031: a fresh install has the three tables, and the runtime role may use them but not change them', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const tables = (await f.migration.many<{table_name: string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name", [[...DESIGN_TABLES]])).map(r => r.table_name);
  assert.deepEqual(tables, [...DESIGN_TABLES].sort());
  for (const table of DESIGN_TABLES) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      assert.equal((await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok, true, `${table} ${privilege}`);
    for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal((await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok, false, `${table} ${privilege}`);
  }
  await row.user(db, 'sql31:owner');
  const file = await seed(db, 'sql31:owner');
  assert.deepEqual(await counts(db, 'sql31:owner'), {design_files: 1, design_file_versions: 2, design_images: 2});
  await db.execute("UPDATE design_files SET version=version+1,trashed_at=clock_timestamp() WHERE id=$1", [file]);
  // Erasing a file takes its versions; its pictures stay until the server decides (file_id is cleared).
  await db.execute('DELETE FROM design_files WHERE id=$1', [file]);
  assert.deepEqual(await counts(db, 'sql31:owner'), {design_files: 0, design_file_versions: 0, design_images: 2});
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_images WHERE file_id IS NOT NULL AND user_id=$1', ['sql31:owner']))!.n, 0);
});

test('PostgreSQL SQL031: the checks refuse malformed ids, names, filenames, kinds and a repeated client key', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime,
    user = 'sql31:checks';
  await row.user(db, user);
  await assert.rejects(row.file(db, user, {id: 'not-a-uuid'}), code('23514'));
  await assert.rejects(row.file(db, user, {name: ''}), code('23514'));
  // Cyrillic on purpose: the limit counts characters, not bytes.
  await assert.rejects(row.file(db, user, {name: 'я'.repeat(201)}), code('23514'));
  await assert.rejects(row.file(db, user, {client_id: 'bad key!'}), code('23514'));
  await assert.rejects(row.file(db, user, {thumbnail_filename: '../escape.webp'}), code('23514'));
  await assert.rejects(row.file(db, user, {thumbnail_filename: 'x.png'}), code('23514'), 'a thumbnail is a WebP');
  await row.file(db, user, {client_id: 'client-key-1'});
  await assert.rejects(row.file(db, user, {client_id: 'client-key-1'}), code('23505'), 'one file per account and client key');
  await row.file(db, user);
  await row.file(db, user);
  await assert.rejects(row.file(db, 'sql31:nobody'), code('23503'));
  await assert.rejects(row.image(db, user, '../users.db', null), code('23514'));
  await assert.rejects(row.image(db, user, 'dz-x.svg', null), code('23514'));
  await assert.rejects(row.image(db, user, 'dz-x.webp', null, 'font'), code('23514'));
  await assert.rejects(db.execute("INSERT INTO design_images(filename,user_id,kind,bytes,width,height) VALUES('dz-y.png',$1,'image',30000000,1,1)", [user]), code('23514'), 'a picture is at most 20 MB');
  await assert.rejects(db.execute("INSERT INTO design_file_versions(id,file_id,user_id,version,document,bytes) VALUES($1,$2,$3,0,'{}',2)", [randomUUID(), randomUUID(), user]), code('23514'));
  // SQL013 moved the fixed layer cap into the application; the database keeps the big-file ceiling (docs/decisions/big-files.md).
  await assert.rejects(db.execute("UPDATE design_files SET node_count=2000001 WHERE user_id=$1", [user]), code('23514'));
});

test('PostgreSQL SQL031: 30 → 31 adds the tables once, keeps the accounts and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await row.user(db, 'sql31:upgrade');
  const before = await db.many('SELECT id,email,name FROM users ORDER BY id');
  await f.migration.transaction(tx => schema30(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_files')::text AS name"))!.name, null);
  await assert.rejects(readDatabaseReadiness(f.migration), /schema version and readiness state disagree/, 'a database one migration behind is not ready');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,email,name FROM users ORDER BY id'), before, 'accounts are untouched');
  const ledger = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledger.length, 29);
  assert.deepEqual(ledger.slice(-28), [{version: 2, name: 'design-files'}, {version: 3, name: 'design-billing'}, {version: 4, name: 'design-ai'}, {version: 5, name: 'design-teams'}, {version: 6, name: 'design-comments'}, {version: 7, name: 'design-libraries'}, {version: 8, name: 'design-ai-pauses'}, {version: 9, name: 'design-file-changes'}, {version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  await seed(db, 'sql31:upgrade');
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});

test("PostgreSQL SQL031: erasing an account removes its design rows and picture files, keeps another account's, and the export has its section", {timeout: 300000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const values: NodeJS.ProcessEnv = {ERASURE_LEDGER_PATH: path.join(f.dataDir, 'ledger', 'erasure.jsonl'), BACKUP_ENCRYPTION_KEY: 'ab'.repeat(32)};
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const lifecycle = await import('../server/launch/lifecycle');
  const {exportDesignAccount} = await import('../server/design/lifecycle');
  await row.user(db, 'sql31:leaving');
  await row.user(db, 'sql31:staying');
  await seed(db, 'sql31:leaving');
  await seed(db, 'sql31:staying');
  const uploads = path.join(f.dataDir, 'uploads');
  await mkdir(uploads, {recursive: true});
  const files = await db.many<{filename: string; user_id: string}>('SELECT filename,user_id FROM design_images ORDER BY filename');
  for (const file of files) await writeFile(path.join(uploads, file.filename), 'picture');

  const chunks: string[] = [];
  await prepareExportMetadata({design: exportDesignAccount('sql31:leaving')})(db, async text => {
    chunks.push(text);
  });
  const exported = JSON.parse('{' + chunks.join('') + '}').design;
  assert.deepEqual(Object.keys(exported), ['files', 'versions', 'libraries', 'teams', 'comments', 'meetingVotes', 'favourites', 'pictures']);
  assert.equal(exported.files.length, 1);
  assert.equal(exported.files[0].document, '{"pages":[]}');
  assert.deepEqual(exported.versions.map((v: {label: string | null}) => v.label).sort(), ['Final', null].sort());
  assert.equal(exported.pictures.length, 2);
  assert.ok(exported.pictures.every((p: {url: string}) => p.url.startsWith('/uploads/dz')));

  const one = {design_files: 1, design_file_versions: 2, design_images: 2};
  assert.deepEqual(await counts(db, 'sql31:leaving'), one);
  await db.execute('UPDATE users SET deletion_requested_at=$1 WHERE id=$2', [new Date().toISOString().replace('T', ' ').slice(0, 19), 'sql31:leaving']);
  await lifecycle.launchMaintenance();
  assert.notEqual((await db.one<{erasure_completed_at: string | null}>('SELECT erasure_completed_at FROM users WHERE id=$1', ['sql31:leaving']))!.erasure_completed_at, null, 'the account was erased');
  assert.deepEqual(await counts(db, 'sql31:leaving'), {design_files: 0, design_file_versions: 0, design_images: 0});
  assert.deepEqual(await counts(db, 'sql31:staying'), one);
  for (const file of files) assert.equal(existsSync(path.join(uploads, file.filename)), file.user_id === 'sql31:staying', file.filename);
});
