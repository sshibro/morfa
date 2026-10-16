import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignTeamBillingForTest} from './helpers/postgresql-design-team-billing-inverse';
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

// SQL028: team billing: seats added to a team's
// running period are their own SKUs and outcome in the design ledger, and an AI request names the team whose shared credits it held.
// The selling and the spending are tested through the app in tests/postgresql-design-team-seats.test.ts.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL028 (and of every newer one) in the guarded temporary database, so the next migrate is the real upgrade. */
async function before28(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignTeamBillingForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function account(db: Database) {
  const id = 'sql28:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  return id;
}
/** A payment row as the seats' checkout writes it (a team's, open); `fields` changes any column. */
function payment(db: Database, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: randomUUID(), user_id: 'design-team:' + randomUUID(), seats: 1, kind: 'checkout', interval: 'month', sku: 'design_team_seats_month', amount: 51_100,
    renewal: 'manual', terms_version: 'design-team-v5', price_version: '2026-10-07-design-v2', generation: randomUUID(), intent: 'seats:' + randomUUID(),
    request: '{}', created_at: new Date().toISOString(), ...fields,
  };
  const keys = Object.keys(row);
  return db.execute(`INSERT INTO design_payments(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`, keys.map(key => row[key]));
}
const paid = (outcome: string) => ({status: 'succeeded', applied: 1, outcome, paid_at: new Date().toISOString(), period_start: 'a', period_end: 'b'});
const settled = {status: 'canceled', applied: 1};
async function request(db: Database, userId: string, wallet: string | null) {
  await db.execute(
    `INSERT INTO design_ai_requests(id,user_id,file_id,action,tier,status,reserved,price_version,created_at,wallet)
     VALUES($1,$2,NULL,'helper','small','reserved',4,'v',$3,$4)`,
    [randomUUID(), userId, new Date().toISOString(), wallet],
  );
}

test('should register SQL028 as the ordinary design-team-billing migration after the marketplaces, compatible from 20', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[27]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 28, name: 'design-team-billing', kind: 'ordinary', compatibleFrom: 20},
  );
  assert.equal(migrations[26]!.name, 'marketplaces');
  // It changes design_payments' checks and adds one nullable column; no row is written or removed.
  const statements = migration.statements.map(sql => sql.replace(/^--.*$/gm, '').trim());
  for (const sql of statements.filter(statement => /\bALTER\b/i.test(statement)))
    assert.match(sql, /^ALTER TABLE public\.(design_payments (DROP|ADD) CONSTRAINT design_payments_(catalog|outcome|period|seats)\b|design_ai_requests ADD COLUMN wallet\b)/, sql);
  assert.deepEqual(statements.filter(sql => /^(UPDATE|DELETE FROM)\b|\bDROP (TABLE|COLUMN)\b/im.test(sql)), []);
});

test('PostgreSQL SQL028: added seats are a team\'s one-off checkout that never extends; a request\'s wallet is a team key', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const user = await account(db);
  for (const [why, fields] of [
    ['an account\'s own key', {user_id: user}],
    ['a renewal', {kind: 'renewal'}],
    ['an automatic renewal', {renewal: 'auto'}],
    ['a month\'s seats on a year', {interval: 'year'}],
    ['seats without a period', {interval: null}],
    ['a period without its outcome', {period_start: new Date().toISOString(), period_end: new Date().toISOString()}],
  ] as const) await assert.rejects(payment(db, {...fields, ...settled}), code('23514'), why);
  await assert.rejects(payment(db, paid('extended')), code('23514'), 'added seats never extend a period');
  await assert.rejects(payment(db, {user_id: user, sku: 'design_pro_month', amount: 99_000, intent: 'checkout:' + randomUUID(), ...paid('seats')}), code('23514'), 'only added seats say seats');
  await payment(db, paid('seats'));
  await payment(db, {interval: 'year', sku: 'design_team_seats_year', ...paid('refused'), period_start: null, period_end: null});
  await payment(db, {user_id: user, sku: 'design_pro_month', amount: 99_000, intent: 'checkout:' + randomUUID(), ...paid('extended')});

  await request(db, user, null);
  await request(db, user, 'design-team:' + randomUUID());
  await assert.rejects(request(db, user, user), code('23514'), 'a wallet is a team\'s ledger key');
});

test('PostgreSQL SQL028: the upgrade keeps the payments and the requests, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const user = await account(db);
  await payment(db, {user_id: user, sku: 'design_pro_month', amount: 99_000, intent: 'checkout:' + randomUUID(), ...paid('extended')});
  await request(db, user, null);
  await f.migration.transaction(tx => before28(tx, f.isolated.databaseName));
  await assert.rejects(payment(db, settled), code('23514'), 'before 28 the catalogue has no seats');
  const before = await db.many('SELECT id,sku,amount,status,outcome FROM design_payments ORDER BY id');
  const requests = await db.many('SELECT id,user_id,status,reserved FROM design_ai_requests ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,sku,amount,status,outcome FROM design_payments ORDER BY id'), before, 'payments are untouched');
  assert.deepEqual(await db.many('SELECT id,user_id,status,reserved FROM design_ai_requests ORDER BY id'), requests, 'requests are untouched');
  assert.deepEqual(await db.many('SELECT wallet FROM design_ai_requests'), [{wallet: null}], 'an older request held only its own credits');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.at(-2), {version: 28, name: 'design-team-billing'});
  await payment(db, settled);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
