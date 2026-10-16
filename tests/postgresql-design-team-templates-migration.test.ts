import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {DESIGN_TEAM_TEMPLATE_DROP_ORDER, removeDesignTeamTemplatesForTest} from './helpers/postgresql-design-team-templates-inverse';
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
import {DESIGN_MEETING_SESSION_TABLES, DESIGN_TEMPLATE_TABLES, DESIGN_TEMPLATE_VERSION_TABLES} from '../server/postgresql/schema/catalog';

// SQL021: custom team templates (a team's board published for its people) and the voting sessions' history.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;
const TABLES = [...DESIGN_MEETING_SESSION_TABLES, ...DESIGN_TEMPLATE_VERSION_TABLES, ...DESIGN_TEMPLATE_TABLES];

/** Test-only inverse of SQL021 in the guarded temporary database, so the next migrate is the real upgrade to 21. */
async function before21(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignTeamTemplatesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function account(db: Database) {
  const id = 'sql21:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  return id;
}

/** A team of `owner` and a board in it. */
async function teamBoard(db: Database, owner: string) {
  const teamId = randomUUID(),
    fileId = randomUUID();
  await db.execute("INSERT INTO design_teams(id,owner_id,name) VALUES($1,$2,'Studio')", [teamId, owner]);
  await db.execute("INSERT INTO design_files(id,user_id,team_id,name,document,bytes,node_count,kind) VALUES($1,$2,$3,'Board','{}',2,0,'board')", [fileId, owner, teamId]);
  return {teamId, fileId};
}

test('should register SQL021 as the ordinary team templates migration after the launch deal, compatible from 20', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[20]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 21, name: 'design-team-templates', kind: 'ordinary', compatibleFrom: 20},
  );
  assert.equal(migrations[19]!.name, 'launch-deal');
  assert.deepEqual([...TABLES].sort(), [...DESIGN_TEAM_TEMPLATE_DROP_ORDER].sort());
  assert.deepEqual(
    migration.statements.filter(sql => /\b(DROP|ALTER)\b/i.test(sql)).map(sql => sql.replace(/\s+/g, ' ').trim().slice(0, 40)),
    ['ALTER TABLE public.design_meetings ADD C'],
    'it adds tables, and two columns with defaults to the meetings',
  );
});

test('PostgreSQL SQL021: a template is one per board, of its team, its versions and past sessions go with what holds them', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  for (const table of TABLES)
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      assert.equal(
        (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok,
        true,
        `${table} ${privilege}`,
      );
  const owner = await account(db),
    publisher = await account(db);
  const {teamId, fileId} = await teamBoard(db, owner);
  const templateId = randomUUID();
  const insert = (id: string, fields: {file?: string; name?: string; scope?: string; description?: string} = {}) =>
    db.execute('INSERT INTO design_templates(id,file_id,team_id,name,description,scope,version,published_by) VALUES($1,$2,$3,$4,$5,$6,1,$7)', [
      id,
      fields.file ?? fileId,
      teamId,
      fields.name ?? 'Retro',
      fields.description ?? '',
      fields.scope ?? 'team',
      publisher,
    ]);
  await assert.rejects(insert(randomUUID(), {name: ''}), code('23514'), 'a name');
  await assert.rejects(insert(randomUUID(), {name: 'x'.repeat(81)}), code('23514'), 'at most 80 characters');
  await assert.rejects(insert(randomUUID(), {description: 'x'.repeat(301)}), code('23514'), 'a description of at most 300');
  await assert.rejects(insert(randomUUID(), {scope: 'world'}), code('23514'), 'team or organization');
  await insert(templateId);
  await assert.rejects(insert(randomUUID()), code('23505'), 'one template per board');
  await db.execute("INSERT INTO design_template_versions(template_id,version,file_version,snapshot,bytes,published_by) VALUES($1,1,1,'{}',2,$2)", [templateId, publisher]);
  await assert.rejects(
    db.execute("INSERT INTO design_template_versions(template_id,version,file_version,snapshot,bytes) VALUES($1,2,1,'{}',6000000)", [templateId]),
    code('23514'),
    'a snapshot of at most 5 MB',
  );
  // The meeting's new columns: a prompt of at most 120 characters, the flag off by default.
  await db.execute('INSERT INTO design_meetings(file_id,revision) VALUES($1,1)', [fileId]);
  assert.deepEqual(await db.one('SELECT vote_prompt,vote_hide_cursors FROM design_meetings WHERE file_id=$1', [fileId]), {vote_prompt: null, vote_hide_cursors: false});
  await assert.rejects(db.execute('UPDATE design_meetings SET vote_prompt=$2 WHERE file_id=$1', [fileId, 'x'.repeat(121)]), code('23514'));
  const voteId = randomUUID();
  await db.execute(
    'INSERT INTO design_meeting_sessions(file_id,vote_id,prompt,per_person,started_by,started_at,ended_at) VALUES($1,$2,$3,3,$4,clock_timestamp(),clock_timestamp())',
    [fileId, voteId, 'Ideas', publisher],
  );
  await assert.rejects(
    db.execute('INSERT INTO design_meeting_sessions(file_id,vote_id,per_person,started_at,ended_at) VALUES($1,$2,0,clock_timestamp(),clock_timestamp())', [fileId, randomUUID()]),
    code('23514'),
    'one to 20 votes each',
  );
  // An account's row gone (the migration role deletes it here; the app anonymises and erases its rows) forgets it as the publisher
  // and the starter.
  await f.migration.execute('DELETE FROM users WHERE id=$1', [publisher]);
  assert.deepEqual(await db.one('SELECT published_by FROM design_templates WHERE id=$1', [templateId]), {published_by: null});
  assert.deepEqual(await db.one('SELECT published_by FROM design_template_versions WHERE template_id=$1', [templateId]), {published_by: null});
  assert.deepEqual(await db.one('SELECT started_by FROM design_meeting_sessions WHERE vote_id=$1', [voteId]), {started_by: null});
  // The board's erasure takes its template, the versions and its meeting's past sessions.
  await db.execute('DELETE FROM design_files WHERE id=$1', [fileId]);
  for (const [table, column, value] of [
    ['design_templates', 'id', templateId],
    ['design_template_versions', 'template_id', templateId],
    ['design_meeting_sessions', 'vote_id', voteId],
  ] as const)
    assert.equal((await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [value]))!.n, 0, `${table} goes with the board`);
});

test('PostgreSQL SQL021: the upgrade keeps the files and meetings, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = await account(db);
  const {fileId} = await teamBoard(db, owner);
  await db.execute('INSERT INTO design_meetings(file_id,revision) VALUES($1,4)', [fileId]);
  await f.migration.transaction(tx => before21(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_templates')::text AS name"))!.name, null);
  const before = await db.many('SELECT id,user_id,name,document FROM design_files ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name,document FROM design_files ORDER BY id'), before, 'files are untouched');
  assert.deepEqual(await db.one('SELECT revision,vote_prompt,vote_hide_cursors FROM design_meetings WHERE file_id=$1', [fileId]), {revision: 4, vote_prompt: null, vote_hide_cursors: false});
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.at(-9), {version: 21, name: 'design-team-templates'});
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
