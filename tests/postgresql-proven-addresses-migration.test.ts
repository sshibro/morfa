import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {PROVEN_ADDRESS_DROP_ORDER, removeProvenAddressesForTest} from './helpers/postgresql-proven-addresses-inverse';
import {createDatabase, type TransactionContext} from '../server/postgresql/client';
import {loadDatabaseConfig} from '../server/postgresql/config';
import {
  DATABASE_SCHEMA_VERSION,
  acquireMigrationLock,
  databaseStructureFingerprint,
  loadDatabaseMigrations,
  migrateDatabase,
  readDatabaseReadiness,
} from '../server/postgresql/migrations';
import {EMAIL_CODE_TABLES, SIGN_IN_BUDGET_TABLES} from '../server/postgresql/schema/catalog';

// SQL017: proven addresses (docs/authentication.md "Addresses"): users.email unique among proven addresses only, the confirmation
// codes and the sign-in routes' shared budget.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL017 in the guarded temporary database, so the next migrate is the real upgrade to 17. */
async function before17(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeProvenAddressesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

test('should register SQL017 as the ordinary proven-address migration after the file heads, with no older release on it', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[16]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 17, name: 'proven-addresses', kind: 'ordinary', compatibleFrom: 17},
  );
  assert.equal(migrations[15]!.name, 'design-file-heads');
  assert.deepEqual([...EMAIL_CODE_TABLES, ...SIGN_IN_BUDGET_TABLES], [...PROVEN_ADDRESS_DROP_ORDER]);
});

test('PostgreSQL SQL017: an address is unique among proven ones only; codes and budget rows are checked and written by the runtime', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  for (const table of ['account_email_codes', 'sign_in_budget'])
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      assert.equal(
        (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok,
        true,
        table + ' ' + privilege,
      );
  const email = randomUUID() + '@example.test';
  const user = (verified: number) => db.execute("INSERT INTO users(id,email,name,password,email_verified) VALUES($1,$2,'Person','',$3)", [randomUUID(), email, verified]);
  await user(0);
  await user(0);
  await user(1);
  await assert.rejects(user(1), code('23505'), 'one proven holder of an address');
  const id = (await db.one<{id: string}>('SELECT id FROM users WHERE email=$1 AND email_verified=0 LIMIT 1', [email]))!.id;
  await assert.rejects(db.execute("UPDATE users SET email_verified=1 WHERE id=$1", [id]), code('23505'), 'an unproven holder cannot become a second');
  const now = Date.now();
  await assert.rejects(
    db.execute("INSERT INTO account_email_codes(user_id,email,code_hash,expires,sends,sends_since,last_sent) VALUES($1,$2,'123456',$3,1,$3,$3)", [id, email, now]),
    code('23514'),
    'a hash, never the code',
  );
  await db.execute("INSERT INTO account_email_codes(user_id,email,code_hash,expires,sends,sends_since,last_sent) VALUES($1,$2,repeat('a',64),$3,1,$3,$3)", [id, email, now]);
  await assert.rejects(db.execute("INSERT INTO account_email_codes(user_id,email,code_hash,expires,sends,sends_since,last_sent) VALUES($1,$2,repeat('b',64),$3,1,$3,$3)", [id, email, now]), code('23505'), 'one per account');
  await db.execute("INSERT INTO sign_in_budget(key,hits,reset_at) VALUES('sign-in:127.0.0.1',1,$1)", [now]);
  await assert.rejects(db.execute("INSERT INTO sign_in_budget(key,hits,reset_at) VALUES('sign-in:x',-1,$1)", [now]), code('23514'));
});

test('PostgreSQL SQL017: the upgrade keeps the accounts, and is a no-op the second time; a retained code forbids the inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await db.execute("INSERT INTO users(id,email,name,password,email_verified) VALUES($1,$2,'Designer','',1)", ['sql17:' + randomUUID(), randomUUID() + '@example.test']);
  await f.migration.transaction(tx => before17(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.account_email_codes')::text AS name"))!.name, null);
  const before = await db.many('SELECT id,email,name,email_verified FROM users ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,email,name,email_verified FROM users ORDER BY id'), before, 'accounts are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-13), [{version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
  const id = (before[0] as {id: string}).id;
  await db.execute("INSERT INTO account_email_codes(user_id,email,code_hash,expires,sends,sends_since,last_sent) VALUES($1,'a@example.test',repeat('a',64),1,1,1,1)", [id]);
  await assert.rejects(f.migration.transaction(tx => before17(tx, f.isolated.databaseName)), /Retained account_email_codes forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
});
