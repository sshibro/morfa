import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {FIXED_DOCUMENT_BYTES, FIXED_NODE_COUNT, removeDesignBigFilesForTest} from './helpers/postgresql-design-big-files-inverse';
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
import {DESIGN_BIG_FILE_CAPS} from '../shared/design/limits';

// SQL013: the document caps leave the database (docs/decisions/big-files.md §1, lane BF). design_files and design_file_versions keep
// a check on what PostgreSQL can hold (1 GiB of text) and on the memory budget's ceiling (2 000 000 layers); the fixed 20 MB /
// 50 000-layer caps are the application's (shared/design/big-files.ts), in force while DESIGN_BIG_FILES is off.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL013 in the guarded temporary database, so the next migrate is the real upgrade to 13. */
async function before13(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignBigFilesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const user = async (db: Database, prefix: string) => {
  const id = prefix + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  return id;
};
const file = (db: Database, owner: string, bytes: number, nodeCount: number, document = '{}') =>
  db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), owner, 'Large mockup', document, bytes, nodeCount]);

test('should register SQL013 as the ordinary big-files migration after the collab one, compatible from 12', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[12]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 13, name: 'design-big-files', kind: 'ordinary', compatibleFrom: 12});
  assert.equal(migrations[11]!.name, 'design-collab');
  assert.deepEqual(migration.statements.filter(sql => /\b(DROP (TABLE|COLUMN)|DELETE|TRUNCATE)\b/i.test(sql)), [], 'it only loosens constraints');
});

test('PostgreSQL SQL013: files and versions may hold up to the big-file caps, not past them', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = await user(db, 'sql13:');
  await file(db, owner, FIXED_DOCUMENT_BYTES + 1, FIXED_NODE_COUNT + 1);
  await file(db, owner, DESIGN_BIG_FILE_CAPS.bytes, DESIGN_BIG_FILE_CAPS.nodes);
  await assert.rejects(file(db, owner, DESIGN_BIG_FILE_CAPS.bytes + 1, 1), code('23514'), 'bytes past the big cap');
  await assert.rejects(file(db, owner, 2, DESIGN_BIG_FILE_CAPS.nodes + 1), code('23514'), 'layers past the big cap');
  await assert.rejects(file(db, owner, 1, 0), code('23514'), 'the lower bound stays');
  const fileId = (await db.one<{id: string}>('SELECT id FROM design_files WHERE user_id=$1 LIMIT 1', [owner]))!.id;
  const version = (bytes: number) =>
    db.execute('INSERT INTO design_file_versions(id,file_id,user_id,version,document,bytes) VALUES($1,$2,$3,1,$4,$5)', [randomUUID(), fileId, owner, '{}', bytes]);
  await version(FIXED_DOCUMENT_BYTES + 1);
  await assert.rejects(version(DESIGN_BIG_FILE_CAPS.bytes + 1), code('23514'));
});

test('PostgreSQL SQL013: the upgrade keeps files and versions, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = await user(db, 'sql13:keep:');
  await file(db, owner, 2, 0);
  await f.migration.transaction(tx => before13(tx, f.isolated.databaseName));
  await assert.rejects(file(db, owner, FIXED_NODE_COUNT + 1, FIXED_NODE_COUNT + 1), code('23514'), 'the fixed caps are back before the upgrade');
  const before = await db.many('SELECT id,user_id,name,version,document,bytes,node_count FROM design_files ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name,version,document,bytes,node_count FROM design_files ORDER BY id'), before, 'files are untouched');
  await file(db, owner, FIXED_NODE_COUNT + 1, FIXED_NODE_COUNT + 1);
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.deepEqual(ledgerRows.slice(-17), [{version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});

test('PostgreSQL SQL013: a retained big file forbids the test inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await file(db, await user(db, 'sql13:retained:'), 2, FIXED_NODE_COUNT + 1);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  await assert.rejects(f.migration.transaction(tx => before13(tx, f.isolated.databaseName)), /Retained big files forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
