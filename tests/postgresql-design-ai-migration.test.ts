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
import {APPLICATION_TABLES, DESIGN_AI_BALANCE_TABLES, DESIGN_AI_EVIDENCE_TABLES, DESIGN_AI_LEDGER_TABLES} from '../server/postgresql/schema/catalog';

// SQL033: "Morfa Design" AI credits (docs/design-tool.md §AI): credit lots, the append-only ledger, the requests, and credit packs in the
// design ledger's catalogue. Derived tables, outside the SQLite import inventory.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;
const DROP_ORDER = ['design_ai_ledger', 'design_ai_requests', 'design_ai_balances'] as const;
const TABLES = [...DESIGN_AI_LEDGER_TABLES, ...DESIGN_AI_EVIDENCE_TABLES, ...DESIGN_AI_BALANCE_TABLES];

/** Test-only inverse of SQL033 in the guarded temporary database: the empty tables go, design_payments gets SQL032's checks back and the
 *  ledger row goes, so the next migrate is the real 32 → 33 upgrade. */
async function schema32(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  // SQL034 (teams) first: it added columns to the design tables, which stay.
  await removeDesignTeamsForTest(tx);
  for (const table of DROP_ORDER) {
    assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.' + table))!.n, 0);
    await tx.execute('DROP TABLE public.' + table);
  }
  await tx.execute('ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_catalog');
  await tx.execute("ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_catalog CHECK(interval IS NOT NULL AND ((interval='month' AND sku='design_pro_month') OR (interval='year' AND sku='design_pro_year')))");
  await tx.execute('ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_outcome');
  await tx.execute("ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_outcome CHECK(outcome IS NULL OR outcome IN('extended','refused'))");
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=4');
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

function payment(db: Database, user: string, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: randomUUID(), user_id: user, kind: 'checkout', interval: null, sku: 'design_ai_credits_200', amount: 29000, renewal: 'manual', terms_version: 'design-ai-v1',
    price_version: 'p1', generation: randomUUID(), intent: 'pack:' + randomUUID(), request: '{}', created_at: new Date().toISOString(), status: 'canceled', applied: 1, ...fields,
  };
  const keys = Object.keys(row);
  return db.execute(`INSERT INTO design_payments(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`, keys.map(key => row[key]));
}
function ledger(db: Database, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {user_id: 'sql33:user', lot_id: randomUUID(), kind: 'grant', bucket: 'trial', credits: 30, price_version: 'v', created_at: new Date().toISOString(), ...fields};
  const keys = Object.keys(row);
  return db.execute(`INSERT INTO design_ai_ledger(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`, keys.map(key => row[key]));
}

test('should register SQL033 as the ordinary design-ai migration after the Pro ledger, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[3]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 4, name: 'design-ai', kind: 'ordinary', compatibleFrom: 4});
  assert.equal(migrations[2]!.name, 'design-billing');
  assert.deepEqual([...TABLES].sort(), [...DROP_ORDER].sort());
  for (const table of TABLES) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
});

test('PostgreSQL SQL033: the ledger is append-only for the runtime, requests are never deleted, lots go with the account', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t);
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  const expected: Record<string, string[]> = {design_ai_ledger: ['SELECT', 'INSERT'], design_ai_requests: ['SELECT', 'INSERT', 'UPDATE'], design_ai_balances: ['SELECT', 'INSERT', 'UPDATE', 'DELETE']};
  for (const table of TABLES)
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal(await may(table, privilege), expected[table]!.includes(privilege), `${table} ${privilege}`);
  await ledger(f.runtime);
  await assert.rejects(f.runtime.execute('UPDATE design_ai_ledger SET credits=31'), code('42501'), 'no update');
  await assert.rejects(f.runtime.execute('DELETE FROM design_ai_ledger'), code('42501'), 'no delete');
});

test('PostgreSQL SQL033: the checks keep the ledger\'s signs, one grant per lot, the lots in bounds and packs in the catalogue', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const lot = randomUUID();
  await ledger(db, {lot_id: lot});
  await assert.rejects(ledger(db, {lot_id: lot}), code('23505'), 'one grant per lot');
  for (const [why, fields] of [
    ['a grant that takes', {credits: -1}],
    ['a reserve that gives', {kind: 'reserve', credits: 5, request_id: randomUUID()}],
    ['a release that takes', {kind: 'release', credits: -5, request_id: randomUUID()}],
    ['a reserve without its request', {kind: 'reserve', credits: -5}],
    ['a purchase that is not paid', {kind: 'purchase', bucket: 'trial', payment_id: randomUUID()}],
    ['a refund of a free lot', {kind: 'refund', bucket: 'trial', credits: -5, refund_id: randomUUID()}],
    ['nothing moved', {kind: 'expire', credits: 0}],
    ['an unknown kind', {kind: 'bonus'}],
  ] as const) await assert.rejects(ledger(db, fields), code('23514'), why);
  const balance = (fields: Record<string, unknown>) =>
    db.execute(
      'INSERT INTO design_ai_balances(id,user_id,bucket,source,granted,remaining,expires_at,payment_id,paid_kopecks,price_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [randomUUID(), 'sql33:user', fields.bucket ?? 'trial', fields.source ?? 'trial', fields.granted ?? 30, fields.remaining ?? 30, 'x', fields.payment_id ?? null, fields.paid_kopecks ?? null, 'v', 'c'],
    );
  await balance({});
  await assert.rejects(balance({}), code('23505'), 'one trial per account');
  await assert.rejects(balance({source: 'allowance:a', bucket: 'allowance', remaining: 31}), code('23514'), 'never more than granted');
  await assert.rejects(balance({source: 'payment:x', bucket: 'paid'}), code('23514'), 'a paid lot names its payment');
  await assert.rejects(balance({source: 'allowance:b', bucket: 'allowance', payment_id: randomUUID(), paid_kopecks: 100}), code('23514'), 'a free lot has none');
  // Packs are one-off: no period, and `granted`.
  await payment(db, 'sql33:pack', {status: 'succeeded', applied: 1, outcome: 'granted', paid_at: new Date().toISOString()});
  await payment(db, 'sql33:pack', {sku: 'design_ai_credits_2000', amount: 200000});
  for (const [why, fields] of [
    ['a pack with a period', {interval: 'month'}],
    ['a subscription without one', {sku: 'design_pro_year'}],
    ['an unknown pack', {sku: 'design_ai_credits_1'}],
    ['a pack that extends a period', {status: 'succeeded', applied: 1, outcome: 'extended', paid_at: 'x', period_start: 'a', period_end: 'b'}],
  ] as const) await assert.rejects(payment(db, 'sql33:pack', fields), code('23514'), why);
  const request = (fields: Record<string, unknown>) =>
    db.execute(
      'INSERT INTO design_ai_requests(id,user_id,action,tier,status,reserved,settled,price_version,created_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [randomUUID(), 'sql33:user', fields.action ?? 'generate', fields.tier ?? 'low.square', fields.status ?? 'reserved', fields.reserved ?? 5, fields.settled ?? null, 'v', 'c', fields.finished_at ?? null],
    );
  await request({});
  await assert.rejects(request({status: 'settled', finished_at: 'f'}), code('23514'), 'a settled request says what it was charged');
  await assert.rejects(request({status: 'settled', settled: 6, finished_at: 'f'}), code('23514'), 'never more than it held');
  await assert.rejects(request({status: 'released'}), code('23514'), 'a finished request has its time');
  await assert.rejects(request({tier: 'low square; DROP'}), code('23514'));
});

test('PostgreSQL SQL033: 32 → 33 adds the tables once, keeps the design payments and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await db.execute(
    "INSERT INTO design_payments(id,user_id,kind,interval,sku,amount,renewal,terms_version,price_version,generation,intent,request,created_at,status,applied) VALUES($1,'sql33:pro','checkout','month','design_pro_month',69000,'manual','design-pro-v1','p',$2,$3,'{}','c','canceled',1)",
    [randomUUID(), randomUUID(), 'checkout:' + randomUUID()],
  );
  const before = await db.many('SELECT id,sku,amount FROM design_payments ORDER BY id');
  await f.migration.transaction(tx => schema32(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_ai_ledger')::text AS name"))!.name, null);
  await assert.rejects(payment(db, 'sql33:old'), code('23514'), 'SQL032 knows no pack');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,sku,amount FROM design_payments ORDER BY id'), before, 'payments are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-27), [{version: 3, name: 'design-billing'}, {version: 4, name: 'design-ai'}, {version: 5, name: 'design-teams'}, {version: 6, name: 'design-comments'}, {version: 7, name: 'design-libraries'}, {version: 8, name: 'design-ai-pauses'}, {version: 9, name: 'design-file-changes'}, {version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  await payment(db, 'sql33:new');
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
