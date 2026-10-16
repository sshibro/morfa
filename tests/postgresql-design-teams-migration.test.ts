import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignTeamsForTest, DESIGN_TEAM_DROP_ORDER} from './helpers/postgresql-design-teams-inverse';
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
import {APPLICATION_TABLES, DESIGN_TEAM_TABLES} from '../server/postgresql/schema/catalog';

// SQL034: "Morfa Design" teams (docs/design-tool.md §Teams): workspaces, members and roles, invite links, projects, and the team columns of
// the design files and pictures. Derived tables, outside the SQLite import inventory.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL034 (and of what follows it) in the guarded temporary database, so the next migrate is the real upgrade from 33. */
async function schema33(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignTeamsForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const row = {
  user: (db: Database, id: string) => db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']),
  team: async (db: Database, owner: string, fields: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.execute('INSERT INTO design_teams(id,name,owner_id) VALUES($1,$2,$3)', [id, fields.name ?? 'Studio', owner]);
    return id;
  },
  member: (db: Database, team: string, user: string, role: string) =>
    db.execute('INSERT INTO design_team_members(team_id,user_id,role) VALUES($1,$2,$3)', [team, user, role]),
  invite: (db: Database, team: string, fields: Record<string, unknown> = {}) =>
    db.execute(
      `INSERT INTO design_team_invites(id,team_id,token,role,created_at,expires_at,max_uses,uses) VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz+make_interval(days=>$6::int),$7,$8)`,
      [randomUUID(), team, fields.token ?? 'a'.repeat(64), fields.role ?? 'viewer', '2026-10-07T00:00:00Z', fields.days ?? 7, fields.max_uses ?? 1, fields.uses ?? 0],
    ),
  file: (db: Database, user: string, fields: Record<string, unknown> = {}) =>
    db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count,team_id,project_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
      randomUUID(), user, 'Mockup', '{}', 2, 0, fields.team_id ?? null, fields.project_id ?? null,
    ]),
};

test('should register SQL034 as the ordinary design-teams migration after the AI credits, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[4]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 5, name: 'design-teams', kind: 'ordinary', compatibleFrom: 5});
  assert.equal(migrations[3]!.name, 'design-ai');
  assert.deepEqual([...DESIGN_TEAM_TABLES].sort(), [...DESIGN_TEAM_DROP_ORDER].sort());
  for (const table of DESIGN_TEAM_TABLES) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
  assert.ok(!migration.statements.some(sql => /CASCADE\s*;?\s*$/i.test(sql) && /DROP/i.test(sql)), 'nothing is dropped');
});

test('PostgreSQL SQL034: the runtime manages teams, the checks keep one owner, invites in bounds and projects inside their team', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const table of DESIGN_TEAM_TABLES)
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal(await may(table, privilege), ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), `${table} ${privilege}`);

  const owner = 'sql34:owner:' + randomUUID(),
    other = 'sql34:other:' + randomUUID();
  await row.user(db, owner);
  await row.user(db, other);
  const team = await row.team(db, owner);
  await row.member(db, team, owner, 'owner');
  await assert.rejects(row.member(db, team, other, 'owner'), code('23505'), 'one owner per team');
  await assert.rejects(row.member(db, team, other, 'boss'), code('23514'), 'a known role');
  await row.member(db, team, other, 'viewer');
  await assert.rejects(row.member(db, team, other, 'editor'), code('23505'), 'one membership per account');
  await assert.rejects(row.team(db, owner, {name: ''}), code('23514'), 'a name');
  await assert.rejects(row.team(db, owner, {name: 'x'.repeat(101)}), code('23514'), 'at most 100 characters');

  await row.invite(db, team);
  await assert.rejects(row.invite(db, team), code('23505'), 'a token is unique');
  for (const [why, fields] of [
    ['an owner invite', {token: 'b'.repeat(64), role: 'owner'}],
    ['a raw token', {token: 'not-a-hash'}],
    ['longer than 30 days', {token: 'c'.repeat(64), days: 31}],
    ['already expired', {token: 'd'.repeat(64), days: 0}],
    ['more uses than allowed', {token: 'e'.repeat(64), max_uses: 2, uses: 3}],
    ['over 100 uses', {token: 'f'.repeat(64), max_uses: 101}],
  ] as const) await assert.rejects(row.invite(db, team, fields), code('23514'), why);

  const project = randomUUID(),
    otherTeam = await row.team(db, other);
  await db.execute('INSERT INTO design_projects(id,team_id,name) VALUES($1,$2,$3)', [project, team, 'Website']);
  await row.file(db, owner, {team_id: team, project_id: project});
  await assert.rejects(row.file(db, owner, {project_id: project}), code('23514'), 'a project file is a team file');
  await assert.rejects(row.file(db, owner, {team_id: otherTeam, project_id: project}), code('23503'), 'of the project\'s own team');
  await assert.rejects(row.file(db, owner, {team_id: randomUUID()}), code('23503'), 'of a team that exists');
  // Deleting a project row keeps the file in its team; deleting a team row takes its files, projects, members and invites.
  await db.execute('DELETE FROM design_projects WHERE id=$1', [project]);
  assert.deepEqual(await db.many('SELECT team_id,project_id FROM design_files WHERE user_id=$1', [owner]), [{team_id: team, project_id: null}]);
  await db.execute(
    "INSERT INTO design_images(filename,user_id,team_id,kind,bytes,width,height) VALUES('dz-sql34.webp',$1,$2,'image',10,1,1)",
    [owner, team],
  );
  await db.execute('DELETE FROM design_teams WHERE id=$1', [team]);
  for (const table of ['design_files', 'design_team_members', 'design_team_invites', 'design_images'])
    assert.equal((await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'design_team_members' || table === 'design_team_invites' ? 'team_id' : 'user_id'}=$1`, [table === 'design_team_members' || table === 'design_team_invites' ? team : owner]))!.n, 0, table);
});

test('PostgreSQL SQL034: 33 → 34 adds the tables and columns once, keeps the design files and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = 'sql34:keep:' + randomUUID();
  await row.user(db, owner);
  await row.file(db, owner);
  const before = await db.many('SELECT id,user_id,name FROM design_files ORDER BY id');
  await f.migration.transaction(tx => schema33(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_teams')::text AS name"))!.name, null);
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name FROM design_files ORDER BY id'), before, 'files are untouched');
  assert.deepEqual(await db.many('SELECT team_id,project_id FROM design_files'), [{team_id: null, project_id: null}], 'and stay personal');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-26), [{version: 4, name: 'design-ai'}, {version: 5, name: 'design-teams'}, {version: 6, name: 'design-comments'}, {version: 7, name: 'design-libraries'}, {version: 8, name: 'design-ai-pauses'}, {version: 9, name: 'design-file-changes'}, {version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
