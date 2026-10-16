import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignAiPausesForTest, DESIGN_AI_PAUSE_DROP_ORDER} from './helpers/postgresql-design-ai-pauses-inverse';
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
import {APPLICATION_TABLES, DESIGN_AI_PAUSE_TABLES} from '../server/postgresql/schema/catalog';

// SQL037: "Morfa Design" never spends more on a person than they paid (docs/design-tool.md §AI "Rails", §Billing "Refunds"): the pause of an
// action whose usage outgrew its price table, and the operator's refund of our own error (`our_error`, with a note). Derived, outside the
// SQLite import inventory.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL040–SQL037 in the guarded temporary database, so the next migrate is the real upgrade to 37 (and 38, 39, 40 after it). */
async function before37(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignAiPausesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const pause = (db: Database, fields: Record<string, unknown> = {}) =>
  db.execute(
    'INSERT INTO design_ai_pauses(id,action,tier,price_version,request_id,usage_usd,ceiling_usd,created_at,cleared_at,cleared_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      fields.id ?? randomUUID(),
      fields.action ?? 'generate',
      fields.tier ?? 'high.portrait',
      fields.price_version ?? 'v1',
      randomUUID(),
      fields.usage_usd ?? 0.21,
      fields.ceiling_usd ?? 0.194,
      '2026-10-07T10:00:00.000Z',
      fields.cleared_at ?? null,
      fields.cleared_by ?? null,
    ],
  );
async function payment(db: Database, user: string): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO design_payments(id,user_id,kind,interval,sku,amount,renewal,terms_version,price_version,generation,intent,provider_id,status,applied,outcome,period_start,period_end,request,created_at,paid_at)
     VALUES($1,$2,'checkout','month','design_pro_month',99000,'manual','design-professional-v1','v',$3,$4,$5,'succeeded',1,'extended','2026-10-07T10:00:00.000Z','2026-11-07T10:00:00.000Z','x','2026-10-07T10:00:00.000Z','2026-10-07T10:00:00.000Z')`,
    [id, user, randomUUID(), 'checkout:' + id, 'p' + id.replaceAll('-', '')],
  );
  return id;
}
const refund = (db: Database, paymentId: string, fields: Record<string, unknown> = {}) =>
  db.execute(
    "INSERT INTO design_refunds(id,payment_id,amount,reason,source,effect,operator_id,note,request,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'x','2026-10-08T10:00:00.000Z')",
    [randomUUID(), paymentId, fields.amount ?? 99000, fields.reason ?? 'our_error', fields.source ?? 'operator', fields.effect ?? 'preserve', fields.source === 'auto' ? null : 'operator-1', fields.note ?? null],
  );

test('should register SQL037 as the ordinary design-ai-pauses migration after the libraries, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[7]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 8, name: 'design-ai-pauses', kind: 'ordinary', compatibleFrom: 8});
  assert.equal(migrations[6]!.name, 'design-libraries');
  assert.deepEqual([...DESIGN_AI_PAUSE_TABLES], [...DESIGN_AI_PAUSE_DROP_ORDER]);
  for (const table of DESIGN_AI_PAUSE_DROP_ORDER) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
  assert.deepEqual(
    migration.statements.filter(sql => /\bDROP\b/i.test(sql)),
    ['ALTER TABLE public.design_refunds DROP CONSTRAINT design_refunds_reason_check;'],
    'only the reason check is replaced (by a wider one), nothing else goes',
  );
});

test('PostgreSQL SQL037: the runtime adds and clears pauses but never deletes them; one pause holds per action and price; our error needs a note', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
    assert.equal(await may('design_ai_pauses', privilege), ['SELECT', 'INSERT', 'UPDATE'].includes(privilege), `design_ai_pauses ${privilege}`);
  assert.equal(await may('design_refunds', 'DELETE'), false, 'refunds stay evidence');

  const id = randomUUID();
  await pause(db, {id});
  await assert.rejects(pause(db), code('23505'), 'one pause holds per action and price version');
  await pause(db, {tier: 'high.landscape'});
  await pause(db, {price_version: 'v2'});
  await assert.rejects(pause(db, {action: 'draw', tier: 'x'}), code('23514'));
  await assert.rejects(pause(db, {tier: 'High.Portrait'}), code('23514'));
  await assert.rejects(pause(db, {usage_usd: 0.1}), code('23514'), 'only usage above the ceiling pauses');
  await assert.rejects(pause(db, {cleared_at: '2026-10-07T11:00:00.000Z'}), code('23514'), 'a clearing names the operator');
  await assert.rejects(db.execute('DELETE FROM design_ai_pauses WHERE id=$1', [id]), code('42501'));
  await db.execute("UPDATE design_ai_pauses SET cleared_at='2026-10-07T11:00:00.000Z',cleared_by='operator-1' WHERE id=$1", [id]);
  await pause(db);
  assert.equal((await db.one<{n: number}>("SELECT count(*)::int AS n FROM design_ai_pauses WHERE tier='high.portrait' AND price_version='v1'"))!.n, 2, 'a cleared pause stays as evidence');

  const user = 'sql37:' + randomUUID();
  const paid = await payment(db, user);
  await assert.rejects(refund(db, paid), code('23514'), 'our error needs the operator\'s note');
  await assert.rejects(refund(db, paid, {note: 'oh'}), code('23514'), 'a note of a few words at least');
  await assert.rejects(refund(db, paid, {reason: 'goodwill', note: 'Just because.'}), code('23514'));
  await refund(db, paid, {note: 'Charged twice in one month.'});
  const second = await payment(db, user);
  await refund(db, second, {reason: 'owner_request', effect: 'end_access'});
  const row = await db.one<{reason: string; note: string | null}>('SELECT reason,note FROM design_refunds WHERE payment_id=$1', [paid]);
  assert.deepEqual(row, {reason: 'our_error', note: 'Charged twice in one month.'});
});

test('PostgreSQL SQL037: the upgrade adds the table once, keeps the design refunds and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const user = 'sql37:keep:' + randomUUID();
  await refund(db, await payment(db, user), {reason: 'owner_request', effect: 'end_access'});
  const before = await db.many('SELECT id,payment_id,amount,reason FROM design_refunds ORDER BY id');
  await f.migration.transaction(tx => before37(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_ai_pauses')::text AS name"))!.name, null);
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,payment_id,amount,reason FROM design_refunds ORDER BY id'), before, 'refunds are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-22), [{version: 8, name: 'design-ai-pauses'}, {version: 9, name: 'design-file-changes'}, {version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
