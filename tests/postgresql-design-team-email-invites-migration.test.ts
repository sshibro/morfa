import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignTeamEmailInvitesForTest} from './helpers/postgresql-design-team-email-invites-inverse';
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

// SQL014: invites by e-mail (docs/design-tool.md §Teams, "Invite by e-mail"). design_team_invites gains the address an invite
// was made for; such an invite lets one person in.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL014 in the guarded temporary database, so the next migrate is the real upgrade to 14. */
async function before14(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignTeamEmailInvitesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function team(db: Database) {
  const owner = 'sql14:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Owner','')", [owner, randomUUID() + '@example.invalid']);
  const id = randomUUID();
  await db.execute('INSERT INTO design_teams(id,name,owner_id) VALUES($1,$2,$3)', [id, 'Studio', owner]);
  return {id, owner};
}
const invite = (db: Database, teamId: string, fields: {email?: string | null; maxUses?: number} = {}) =>
  db.execute(
    `INSERT INTO design_team_invites(id,team_id,token,role,expires_at,max_uses,email) VALUES($1,$2,$3,'editor',clock_timestamp()+interval '7 days',$4,$5)`,
    [randomUUID(), teamId, createHash('sha256').update(randomBytes(32)).digest('hex'), fields.maxUses ?? 1, fields.email ?? null],
  );

test('should register SQL014 as the ordinary e-mail invites migration after the big files, compatible from 13', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[13]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 14, name: 'design-team-email-invites', kind: 'ordinary', compatibleFrom: 13},
  );
  assert.equal(migrations[12]!.name, 'design-big-files');
  assert.deepEqual(migration.statements.filter(sql => /\bDROP\b/i.test(sql)), [], 'it only adds');
});

test('PostgreSQL SQL014: an invite names one lower-case address and lets one person in; a link stays as it was', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const {id} = await team(db);
  await invite(db, id, {maxUses: 25});
  await invite(db, id, {email: 'boris@example.ru'});
  await assert.rejects(invite(db, id, {email: 'boris@example.ru', maxUses: 5}), code('23514'), 'an e-mail invite lets one person in');
  await assert.rejects(invite(db, id, {email: 'Boris@Example.ru'}), code('23514'), 'stored in lower case');
  await assert.rejects(invite(db, id, {email: 'not an address'}), code('23514'));
  await assert.rejects(invite(db, id, {email: 'a@b@c'}), code('23514'));
  const rows = await db.many<{email: string | null; max_uses: number}>('SELECT email,max_uses FROM design_team_invites WHERE team_id=$1 ORDER BY max_uses DESC', [id]);
  assert.deepEqual(rows, [{email: null, max_uses: 25}, {email: 'boris@example.ru', max_uses: 1}]);
  // The rows go with the team, as before.
  await db.execute('DELETE FROM design_teams WHERE id=$1', [id]);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_team_invites WHERE team_id=$1', [id]))!.n, 0);
});

test('PostgreSQL SQL014: the upgrade keeps the links, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const {id} = await team(db);
  await invite(db, id);
  await f.migration.transaction(tx => before14(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{n: number}>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='design_team_invites' AND column_name='email'"))!.n, 0);
  const before = await db.many('SELECT id,token,role,max_uses,uses FROM design_team_invites ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,token,role,max_uses,uses FROM design_team_invites ORDER BY id'), before, 'links are untouched');
  assert.deepEqual(await db.many('SELECT email FROM design_team_invites'), [{email: null}]);
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-16), [{version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});

test('PostgreSQL SQL014: retained e-mail invites forbid the test inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const {id} = await team(db);
  await invite(db, id, {email: 'vera@example.ru'});
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  await assert.rejects(f.migration.transaction(tx => before14(tx, f.isolated.databaseName)), /Retained e-mail invites forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
