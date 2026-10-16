import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignBoardsForTest} from './helpers/postgresql-design-boards-inverse';
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

// SQL039: "Board" (docs/board.md §File kind): a file of the design tool is a design file or a board, fixed when it is made. Every file made
// before the migration is a design file.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL040 and SQL039 in the guarded temporary database, so the next migrate is the real upgrade to 39 (and 40 after it). */
async function before39(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignBoardsForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const user = (db: Database, id: string) => db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Facilitator','')", [id, randomUUID() + '@example.invalid']);
async function file(db: Database, owner: string, kind?: string): Promise<string> {
  const id = randomUUID();
  if (kind === undefined) await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, 'Mockup', '{}', 2, 0]);
  else await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count,kind) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, owner, 'Board', '{}', 2, 0, kind]);
  return id;
}

test('should register SQL039 as the ordinary design-boards migration after the saved changes of large files, declared compatible from 24', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[9]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 10, name: 'design-boards', kind: 'ordinary', compatibleFrom: 10});
  assert.equal(migrations[8]!.name, 'design-file-changes');
  assert.deepEqual(migration.statements.filter(sql => /\bDROP\b/i.test(sql)), [], 'nothing goes');
});

test('PostgreSQL SQL039: a file is a design file unless made a board; no other kind', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = 'sql39:' + randomUUID();
  await user(db, owner);
  const plain = await file(db, owner);
  const board = await file(db, owner, 'board');
  const kindOf = async (id: string) => (await db.one<{kind: string}>('SELECT kind FROM design_files WHERE id=$1', [id]))!.kind;
  assert.equal(await kindOf(plain), 'design', 'the default');
  assert.equal(await kindOf(board), 'board');
  await assert.rejects(file(db, owner, 'whiteboard'), code('23514'));
  await assert.rejects(file(db, owner, 'Board'), code('23514'));
  await assert.rejects(db.execute('UPDATE design_files SET kind=NULL WHERE id=$1', [plain]), code('23502'));
});

test('PostgreSQL SQL039: the upgrade keeps every existing file a design file and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = 'sql39:keep:' + randomUUID();
  await user(db, owner);
  await f.migration.transaction(tx => before39(tx, f.isolated.databaseName));
  const existing = [await file(db, owner), await file(db, owner)];
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual((await db.many<{id: string; kind: string}>('SELECT id,kind FROM design_files WHERE user_id=$1 ORDER BY id', [owner])), existing.sort().map(id => ({id, kind: 'design'})));
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-20), [{version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
