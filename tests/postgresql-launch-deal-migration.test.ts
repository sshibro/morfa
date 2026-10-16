import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {LAUNCH_DEAL_DROP_ORDER, removeLaunchDealForTest} from './helpers/postgresql-launch-deal-inverse';
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
import {DESIGN_OFFER_INTRO_TABLES} from '../server/postgresql/schema/catalog';

// SQL020: the launch deal (docs/design-tool.md §Billing "Launch deal, 2026-10-10"): its SKU in the design ledger's catalogue, once per
// account, only an account's own checkout; and the offers an account was introduced to. 019 is the support chat's (another lane).

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL020 in the guarded temporary database, so the next migrate is the real upgrade to 20. */
async function before20(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeLaunchDealForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function account(db: Database) {
  const id = 'sql20:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  return id;
}
/** A payment row as checkout writes it (the deal's by default, open); `fields` changes any column. */
function payment(db: Database, user: string, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: randomUUID(), user_id: user, kind: 'checkout', interval: 'year', sku: 'design_pro_year_launch', amount: 474_000, renewal: 'auto',
    terms_version: 'design-launch-v1', price_version: '2026-10-07-design-v2', generation: randomUUID(), intent: 'checkout:' + randomUUID(),
    request: '{}', created_at: new Date().toISOString(), ...fields,
  };
  const keys = Object.keys(row);
  return db.execute(`INSERT INTO design_payments(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`, keys.map(key => row[key]));
}
const settled = {status: 'canceled', applied: 1};
const paid = () => ({status: 'succeeded', applied: 1, outcome: 'extended', paid_at: new Date().toISOString(), period_start: 'a', period_end: 'b'});

test('should register SQL020 as the ordinary launch-deal migration after the support chat\'s, compatible from 20', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[19]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 20, name: 'launch-deal', kind: 'ordinary', compatibleFrom: 20},
  );
  assert.equal(migrations[18]!.version, 19, 'the support chat (019) comes first');
  assert.deepEqual([...DESIGN_OFFER_INTRO_TABLES], [...LAUNCH_DEAL_DROP_ORDER]);
  // It changes design_payments' checks only; no column, no row.
  const statements = migration.statements.map(sql => sql.replace(/^--.*$/gm, '').trim());
  for (const sql of statements.filter(statement => /\bALTER\b/i.test(statement)))
    assert.match(sql, /^ALTER TABLE public\.design_payments (DROP|ADD) CONSTRAINT design_payments_(catalog|launch)\b/, sql);
  assert.deepEqual(statements.filter(sql => /^(UPDATE|DELETE FROM)\b|\bDROP (TABLE|COLUMN)\b/im.test(sql)), []);
});

test('PostgreSQL SQL020: the deal is an account\'s own first year, bought once; its introduction is recorded once', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  for (const table of DESIGN_OFFER_INTRO_TABLES)
    for (const [privilege, granted] of [['SELECT', true], ['INSERT', true], ['DELETE', true], ['UPDATE', false], ['TRUNCATE', false]] as const)
      assert.equal(
        (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok,
        granted,
        `${table} ${privilege}`,
      );
  const user = await account(db);
  for (const [why, fields] of [
    ['a month at the deal', {interval: 'month'}],
    ['the deal without a period', {interval: null}],
    ['a renewal at the deal\'s price', {kind: 'renewal'}],
    ['a team\'s seats', {seats: 3}],
    ['a team\'s ledger key', {user_id: 'design-team:' + randomUUID(), seats: 1}],
  ] as const) await assert.rejects(payment(db, user, {...fields, ...settled}), code('23514'), why);
  // A page that expired frees the account to try again; an open one or a paid one does not.
  await payment(db, user, settled);
  await payment(db, user);
  await assert.rejects(payment(db, user, paid()), code('23505'), 'once per account: an open page stands in the way');
  await db.execute("UPDATE design_payments SET status='canceled',applied=1 WHERE user_id=$1 AND applied=0", [user]);
  await payment(db, user, paid());
  await assert.rejects(payment(db, user, {...paid(), intent: 'checkout:' + randomUUID()}), code('23505'), 'once per account: paid once');
  await payment(db, user, {sku: 'design_pro_year', amount: 948_000, ...settled});
  await payment(db, user, {kind: 'renewal', sku: 'design_pro_year', amount: 948_000, terms_version: 'design-launch-v1', ...paid()});
  // Another account takes it on its own.
  await payment(db, await account(db), paid());

  await db.execute("INSERT INTO design_offer_intros(user_id,offer) VALUES($1,'launch')", [user]);
  await assert.rejects(db.execute("INSERT INTO design_offer_intros(user_id,offer) VALUES($1,'launch')", [user]), code('23505'), 'once per account');
  await assert.rejects(db.execute("INSERT INTO design_offer_intros(user_id,offer) VALUES($1,'Launch Deal')", [user]), code('23514'), 'an id, not a sentence');
  await assert.rejects(db.execute("INSERT INTO design_offer_intros(user_id,offer) VALUES('sql20:nobody','launch')"), code('23503'), 'an account\'s');
  assert.equal((await db.one<{n: number}>("SELECT count(*)::int AS n FROM design_payments WHERE user_id=$1 AND sku='design_pro_year_launch'", [user]))!.n, 3, 'payments stay');
});

test('PostgreSQL SQL020: the upgrade keeps the payments, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const user = await account(db);
  await payment(db, user, {sku: 'design_pro_year', amount: 948_000, terms_version: 'design-professional-v2', ...paid()});
  await f.migration.transaction(tx => before20(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_offer_intros')::text AS name"))!.name, null);
  await assert.rejects(payment(db, user, settled), code('23514'), 'before 20 the catalogue has no deal');
  const before = await db.many('SELECT id,sku,amount,status FROM design_payments ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,sku,amount,status FROM design_payments ORDER BY id'), before, 'payments are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.at(-10), {version: 20, name: 'launch-deal'});
  await payment(db, user, settled);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
