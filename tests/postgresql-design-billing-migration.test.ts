import test from 'node:test';
import assert from 'node:assert/strict';
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
import {APPLICATION_TABLES, DESIGN_BILLING_LEDGER_TABLES, DESIGN_BILLING_SUBSCRIPTION_TABLES} from '../server/postgresql/schema/catalog';

// SQL032: "Morfa Design Pro", the subscription to the design tool, its payments and refunds (docs/design-tool.md §Billing). Derived tables,
// outside the SQLite import inventory. Payments and refunds are evidence: the runtime creates and updates them and never deletes one.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;
/** Referencing tables first. */
const DROP_ORDER = ['design_refunds', 'design_payments', 'design_subscriptions'] as const;
const TABLES = [...DESIGN_BILLING_LEDGER_TABLES, ...DESIGN_BILLING_SUBSCRIPTION_TABLES];

/** SQL033 (the AI credits) comes later: its empty tables go first, and with design_payments its widened checks go too. */
const LATER = ['design_ai_ledger', 'design_ai_requests', 'design_ai_balances'] as const;
/** Test-only inverse of SQL033 and SQL032 in the guarded temporary database: the empty tables and the ledger rows go, so the next migrate is the real 31 → 32 → 33 upgrade. */
async function schema31(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  // SQL034 (teams) first: it added columns to the design tables, which stay.
  await removeDesignTeamsForTest(tx);
  for (const table of [...LATER, ...DROP_ORDER]) {
    assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.' + table))!.n, 0);
    await tx.execute('DROP TABLE public.' + table);
  }
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version IN(3,4,5,6,7,8,9,10,11)');
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

/** A payment row as checkout writes it; `fields` changes any column. */
function payment(db: Database, user: string, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: randomUUID(), user_id: user, kind: 'checkout', interval: 'month', sku: 'design_pro_month', amount: 69000, renewal: 'manual', terms_version: 'design-pro-v1',
    price_version: 'p1', generation: randomUUID(), intent: 'checkout:' + randomUUID(), request: '{}', created_at: new Date().toISOString(), ...fields,
  };
  const keys = Object.keys(row);
  return db.execute(`INSERT INTO design_payments(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`, keys.map(key => row[key]));
}

test('should register SQL032 as the ordinary design-billing migration after the design files, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29, 'SQL033 (the AI credits) follows');
  const migration = migrations[2];
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 3, name: 'design-billing', kind: 'ordinary', compatibleFrom: 3});
  assert.deepEqual(migrations[1].name, 'design-files');
  assert.deepEqual([...TABLES].sort(), [...DROP_ORDER].sort());
  for (const table of TABLES) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
});

test('PostgreSQL SQL032: a fresh install has the three tables; the runtime never deletes a payment or a refund', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t);
  const tables = (await f.migration.many<{table_name: string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name", [[...TABLES]])).map(r => r.table_name);
  assert.deepEqual(tables, [...TABLES].sort());
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const table of TABLES) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) assert.equal(await may(table, privilege), true, `${table} ${privilege}`);
    assert.equal(await may(table, 'DELETE'), table === 'design_subscriptions', `${table} DELETE`);
    for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await may(table, privilege), false, `${table} ${privilege}`);
  }
});

test('PostgreSQL SQL032: the checks keep every row to the catalog, one open payment per account and one live refund per payment', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime,
    user = 'sql32:checks';
  await payment(db, user, {status: 'canceled', applied: 1});
  for (const [why, fields] of [
    ['an SKU of another ledger', {sku: 'site_report'}],
    ['a period that is not its SKU\'s', {interval: 'year'}],
    ['a subscription SKU without a period', {interval: null}],
    ['an unknown period', {interval: 'week', sku: 'design_pro_month'}],
    ['a renewal paid once', {kind: 'renewal', renewal: 'manual'}],
    ['an outcome nobody writes', {outcome: 'bonus', status: 'succeeded', applied: 1, paid_at: new Date().toISOString()}],
    ['a period without its outcome', {period_start: new Date().toISOString(), period_end: new Date().toISOString()}],
    ['no seats', {seats: 0}],
  ] as const) await assert.rejects(payment(db, user, {...fields, status: 'canceled', applied: 1}), code('23514'), why);
  await payment(db, user);
  await assert.rejects(payment(db, user), code('23505'), 'one unfinished payment per account');
  const paid = randomUUID();
  await payment(db, 'sql32:other', {id: paid, status: 'succeeded', applied: 1, outcome: 'extended', paid_at: new Date().toISOString(), period_start: 'a', period_end: 'b', provider_id: 'prov_1'});
  const refund = (id: string, fields: Record<string, unknown> = {}) =>
    db.execute("INSERT INTO design_refunds(id,payment_id,amount,reason,source,effect,operator_id,request,created_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,'{}',$8,$9)",
      [id, paid, fields.amount ?? 69000, fields.reason ?? 'owner_request', fields.source ?? 'operator', fields.effect ?? 'end_access', 'operator-1', new Date().toISOString(), fields.status ?? 'creating']);
  await assert.rejects(refund(randomUUID(), {reason: 'not_applied', source: 'auto'}), code('23514'), 'an automatic refund never has an operator');
  await refund(randomUUID());
  await assert.rejects(refund(randomUUID()), code('23505'), 'one live refund per payment');
  await refund(randomUUID(), {status: 'canceled'});
  await assert.rejects(db.execute("INSERT INTO design_subscriptions(user_id,state,interval,paid_until,grace_until,anchor_day,auto_renew,source,generation,created_at,updated_at) VALUES($1,'active','month','x','y',6,1,'payment',$2,'c','c')", ['sql32:sub', randomUUID()]), code('23514'), 'auto-renewal needs a saved method and a next attempt');
});

test('PostgreSQL SQL032: 31 → 32 adds the tables once, keeps the accounts and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await db.execute("INSERT INTO users(id,email,name,password) VALUES('sql32:upgrade',$1,'Designer','')", [randomUUID() + '@example.invalid']);
  const before = await db.many('SELECT id,email,name FROM users ORDER BY id');
  await f.migration.transaction(tx => schema31(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_payments')::text AS name"))!.name, null);
  await assert.rejects(readDatabaseReadiness(f.migration), /schema version and readiness state disagree/, 'a database one migration behind is not ready');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,email,name FROM users ORDER BY id'), before, 'accounts are untouched');
  const ledger = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledger.length, 29);
  assert.deepEqual(ledger.slice(-28), [{version: 2, name: 'design-files'}, {version: 3, name: 'design-billing'}, {version: 4, name: 'design-ai'}, {version: 5, name: 'design-teams'}, {version: 6, name: 'design-comments'}, {version: 7, name: 'design-libraries'}, {version: 8, name: 'design-ai-pauses'}, {version: 9, name: 'design-file-changes'}, {version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  await payment(db, 'sql32:upgrade');
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
