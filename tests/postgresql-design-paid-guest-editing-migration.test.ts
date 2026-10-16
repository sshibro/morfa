import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removePaidGuestEditingForTest} from './helpers/postgresql-paid-guest-editing-inverse';
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

// SQL029: editing someone else's file needs a paid seat; the guests who could edit when it runs keep editing free for 30 days (design_file_members.free_edit_until). The rule itself is
// tested through the app in tests/postgresql-runtime-design-file-sharing.test.ts.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Test-only inverse of SQL029 in the guarded temporary database, so the next migrate is the real upgrade to 29. */
async function before29(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removePaidGuestEditingForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [
    await databaseStructureFingerprint(tx),
  ]);
}

async function account(db: Database, name: string) {
  const id = 'sql29:' + randomUUID();
  await db.execute('INSERT INTO users(id,email,name,password) VALUES($1,$2,$3,$4)', [id, randomUUID() + '@example.invalid', name, '']);
  return id;
}

async function file(db: Database, owner: string, link: 'none' | 'view' | 'edit') {
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count,link_access) VALUES($1,$2,$3,$4,$5,$6,$7)', [
    id,
    owner,
    'Mockup',
    '{}',
    2,
    0,
    link,
  ]);
  return id;
}

/** The owner's Professional plan, paid until `paidUntil`, as a checkout leaves it. */
const plan = (db: Database, owner: string, state: 'active' | 'past_due', paidUntil: string) =>
  db.execute(
    `INSERT INTO design_subscriptions(user_id,seats,state,interval,paid_until,grace_until,anchor_day,auto_renew,renewal_attempt,consent_version,price_version,source,generation,created_at,updated_at)
     VALUES($1,1,$2,'year',$3,$4,13,0,0,'design-professional-v3','v','payment',$5,$6,$6)`,
    [owner, state, paidUntil, new Date(Date.parse(paidUntil) + 7 * 86_400_000).toISOString(), randomUUID(), new Date().toISOString()],
  );

/** A guest's row: an invite's role, or null for someone who came by the link. */
const guest = (db: Database, fileId: string, userId: string, role: 'editor' | 'viewer' | null) =>
  db.execute('INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,$3)', [fileId, userId, role]);

test('should register SQL029 as the ordinary design-paid-guest-editing migration after 028, compatible from 20: one column, filled once', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[28]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 29, name: 'design-paid-guest-editing', kind: 'ordinary', compatibleFrom: 20},
  );
  assert.equal(migrations[27]!.name, 'design-team-billing');
  const statements = migration.statements.map(sql => sql.replace(/^--.*$/gm, '').trim());
  assert.equal(statements.length, 2);
  assert.match(statements[0]!, /^ALTER TABLE public\.design_file_members ADD COLUMN free_edit_until text COLLATE "C"\s+CHECK\(/);
  assert.match(statements[1]!, /^UPDATE public\.design_file_members x\s+SET free_edit_until=/);
  assert.ok(statements.every(sql => !/\b(DROP|DELETE FROM|CREATE)\b/i.test(sql)), 'it adds a nullable column and fills it, nothing else');
});

test('PostgreSQL SQL029: the upgrade from 28 gives the guests who could edit 30 free days or the owner\'s paid period, once; a second run is a no-op', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await f.migration.transaction(tx => before29(tx, f.isolated.databaseName));
  const owner = await account(db, 'Owner');
  const [invitedEditor, invitedViewer, linkViewer, linkVisitor, viewLinkEditor, viewLinkVisitor] = await Promise.all(
    ['Editor', 'Viewer', 'Viewer by link', 'Passer-by', 'Editor on a view link', 'Passer-by on a view link'].map(name =>
      account(db, name),
    ),
  );
  const closed = await file(db, owner, 'none'),
    editLink = await file(db, owner, 'edit'),
    viewLink = await file(db, owner, 'view');
  await guest(db, closed, invitedEditor, 'editor');
  await guest(db, closed, invitedViewer, 'viewer');
  await guest(db, editLink, linkViewer, 'viewer');
  await guest(db, editLink, linkVisitor, null);
  await guest(db, viewLink, viewLinkEditor, 'editor');
  await guest(db, viewLink, viewLinkVisitor, null);
  // An owner who paid for a year keeps what the plan held until the year ends; one in grace gets the 30 days as anyone.
  const yearOwner = await account(db, 'Yearly owner'), graceOwner = await account(db, 'Grace-period owner');
  const yearEditor = await account(db, 'Yearly editor'), graceEditor = await account(db, 'Overdue editor');
  const yearEnd = new Date(Date.now() + 200 * 86_400_000).toISOString();
  await plan(db, yearOwner, 'active', yearEnd);
  await plan(db, graceOwner, 'past_due', new Date(Date.now() - 86_400_000).toISOString());
  await guest(db, await file(db, yearOwner, 'none'), yearEditor, 'editor');
  await guest(db, await file(db, graceOwner, 'none'), graceEditor, 'editor');
  const members = 'SELECT file_id,user_id,role FROM design_file_members ORDER BY file_id,user_id';
  const before = await db.many(members);

  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const startedAt = Date.now();
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [
    {ready: true, state: 'ready', version: 29},
    {ready: true, state: 'ready', version: 29},
  ]);
  assert.deepEqual(await db.many(members), before, 'the guests and their roles are untouched');
  const freeDays = async () =>
    new Map(
      (await db.many<{user_id: string; free_edit_until: string | null}>('SELECT user_id,free_edit_until FROM design_file_members')).map(row => [
        row.user_id,
        row.free_edit_until,
      ]),
    );
  const given = await freeDays();
  const until = given.get(invitedEditor)!;
  assert.match(until, ISO);
  const days = (Date.parse(until) - startedAt) / 86_400_000;
  assert.ok(days > 29.99 && days < 30.01, `30 days from the migration, not ${days}`);
  // An invite to edit, and every guest of a file whose link lets anyone edit; one clock reading for all.
  for (const who of [invitedEditor, linkViewer, linkVisitor, viewLinkEditor, graceEditor]) assert.equal(given.get(who), until, who);
  assert.equal(given.get(yearEditor), yearEnd, 'until the owner\'s paid year ends');
  for (const who of [invitedViewer, viewLinkVisitor]) assert.equal(given.get(who), null, `${who} could not edit`);
  // A guest added later has none; the column holds the ledger's instants only.
  const later = await account(db, 'Later');
  await guest(db, closed, later, 'editor');
  assert.equal((await freeDays()).get(later), null);
  await assert.rejects(
    db.execute("UPDATE design_file_members SET free_edit_until='2026-11-12' WHERE user_id=$1", [later]),
    code('23514'),
    'ISO-8601 UTC text with milliseconds',
  );

  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.at(-1), {version: 29, name: 'design-paid-guest-editing'});
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  const filled = await freeDays();
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await freeDays(), filled, 'and gives no one new days');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
