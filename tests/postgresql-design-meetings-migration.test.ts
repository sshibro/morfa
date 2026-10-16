import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignMeetingsForTest, DESIGN_MEETING_DROP_ORDER} from './helpers/postgresql-design-meetings-inverse';
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
import {APPLICATION_TABLES, DESIGN_MEETING_TABLES} from '../server/postgresql/schema/catalog';

// SQL040: "Morfa Design" and "Board" meetings (docs/board-meeting.md): a file's shared timer and voting session (design_meetings) and the
// ballots (design_meeting_votes). Derived, outside the SQLite import inventory; the rows belong to the file.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL040 in the guarded temporary database, so the next migrate is the real upgrade to 40. */
async function before40(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignMeetingsForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const user = async (db: Database) => {
  const id = 'sql40:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Host','')", [id, randomUUID() + '@example.invalid']);
  return id;
};
const file = async (db: Database, owner: string) => {
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, 'Board', '{}', 2, 0]);
  return id;
};
const meeting = (db: Database, fileId: string, fields: Record<string, unknown> = {}) => {
  const columns = ['file_id', 'revision', ...Object.keys(fields)];
  return db.execute(`INSERT INTO design_meetings(${columns.join(',')}) VALUES(${columns.map((_, i) => '$' + (i + 1)).join(',')})`, [fileId, 1, ...Object.values(fields)]);
};

test('should register SQL040 as the ordinary design-meetings migration after the board file kind, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[10]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 11, name: 'design-meetings', kind: 'ordinary', compatibleFrom: 11});
  assert.equal(migrations[9]!.name, 'design-boards');
  assert.deepEqual([...DESIGN_MEETING_TABLES].sort(), [...DESIGN_MEETING_DROP_ORDER].sort());
  for (const table of DESIGN_MEETING_TABLES) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
  assert.deepEqual(migration.statements.filter(sql => /\b(DROP|ALTER)\b/i.test(sql)), [], 'it only adds');
});

test('PostgreSQL SQL040: the runtime reads and writes meetings and ballots; the checks keep a timer and a vote whole; rows go with the file', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const table of DESIGN_MEETING_TABLES)
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal(await may(table, privilege), ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), `${table} ${privilege}`);

  const owner = await user(db);
  const fileId = await file(db, owner);
  const at = '2026-10-07T10:00:00.000Z';
  // A timer is none, running (an end, no remainder) or paused (a remainder, no end).
  await assert.rejects(meeting(db, fileId, {timer_state: 'running', timer_duration_ms: 60_000}), code('23514'), 'running needs its end');
  await assert.rejects(meeting(db, fileId, {timer_state: 'paused', timer_duration_ms: 60_000, timer_ends_at: at, timer_remaining_ms: 5}), code('23514'));
  await assert.rejects(meeting(db, fileId, {timer_music: 'lofi'}), code('23514'), 'no music without a timer');
  await assert.rejects(meeting(db, fileId, {timer_state: 'running', timer_duration_ms: 60_000, timer_ends_at: at, timer_music: 'jazz'}), code('23514'));
  await assert.rejects(meeting(db, fileId, {timer_state: 'running', timer_duration_ms: 6_000_000, timer_ends_at: at}), code('23514'), 'at most 99:59');
  await assert.rejects(meeting(db, fileId, {vote_id: randomUUID(), vote_per_person: 3, vote_with_timer: false}), code('23514'), 'a vote has its start');
  await assert.rejects(meeting(db, fileId, {vote_id: 'not-a-uuid', vote_per_person: 3, vote_with_timer: false, vote_started_at: at}), code('23514'));
  await assert.rejects(meeting(db, fileId, {vote_id: randomUUID(), vote_per_person: 21, vote_with_timer: false, vote_started_at: at}), code('23514'));
  await assert.rejects(meeting(db, fileId, {vote_ended_at: at}), code('23514'), 'no end without a vote');
  const voteId = randomUUID();
  await meeting(db, fileId, {timer_state: 'running', timer_duration_ms: 180_000, timer_ends_at: at, timer_music: 'rain', timer_by: owner, vote_id: voteId, vote_by: owner, vote_per_person: 3, vote_with_timer: true, vote_started_at: at, vote_ends_at: at});
  await assert.rejects(meeting(db, fileId), code('23505'), 'one meeting per file');
  const ballot = (fields: Record<string, unknown> = {}) =>
    db.execute('INSERT INTO design_meeting_votes(file_id,vote_id,user_id,node_id,count) VALUES($1,$2,$3,$4,$5)', [fields.file_id ?? fileId, fields.vote_id ?? voteId, fields.user_id ?? owner, fields.node_id ?? '1:2', fields.count ?? 1]);
  await ballot();
  await ballot({node_id: 'r0123456789abcdef:3;4'});
  await assert.rejects(ballot(), code('23505'));
  await assert.rejects(ballot({node_id: '<script>'}), code('23514'));
  await assert.rejects(ballot({node_id: '1:3', count: 0}), code('23514'));
  await assert.rejects(ballot({node_id: '1:3', count: 21}), code('23514'));
  await assert.rejects(ballot({node_id: '1:3', user_id: 'nobody'}), code('23503'));
  await assert.rejects(ballot({file_id: await file(db, owner)}), code('23503'), 'a ballot needs its file’s meeting');
  await db.execute('DELETE FROM design_files WHERE id=$1', [fileId]);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_meetings WHERE file_id=$1', [fileId]))!.n, 0);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_meeting_votes WHERE file_id=$1', [fileId]))!.n, 0, 'the ballots go with the file');
});

test('PostgreSQL SQL040: the upgrade adds the tables once, keeps the design files and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await file(db, await user(db));
  const before = await db.many('SELECT id,user_id,name FROM design_files ORDER BY id');
  await f.migration.transaction(tx => before40(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_meetings')::text AS name"))!.name, null);
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name FROM design_files ORDER BY id'), before, 'files are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.at(-19), {version: 11, name: 'design-meetings'});
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
