import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {MCP_SERVER_DROP_ORDER, removeMcpServerForTest} from './helpers/postgresql-mcp-server-inverse';
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
import {MCP_CLIENT_TABLES, MCP_GRANT_TABLES, MCP_USAGE_TABLES} from '../server/postgresql/schema/catalog';

// SQL025: the MCP server's sign-in (clients, consents, codes, tokens) and its daily call counts (docs/mcp-server.md).

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;
const TABLES = [...MCP_CLIENT_TABLES, ...MCP_GRANT_TABLES, ...MCP_USAGE_TABLES];
const HASH = 'a'.repeat(64);

/** Test-only inverse of SQL025 in the guarded temporary database, so the next migrate is the real upgrade to 25. */
async function before25(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeMcpServerForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [
    await databaseStructureFingerprint(tx),
  ]);
}

async function account(db: Database) {
  const id = 'sql22:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [
    id,
    randomUUID() + '@example.invalid',
  ]);
  return id;
}

test('should register SQL025 as the ordinary MCP server migration after the agent credits, compatible from 20', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[24]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 25, name: 'mcp-server', kind: 'ordinary', compatibleFrom: 20},
  );
  assert.equal(migrations[23]!.name, 'design-agent-credits');
  assert.deepEqual([...TABLES].sort(), [...MCP_SERVER_DROP_ORDER].sort());
  assert.deepEqual(
    migration.statements.filter(sql => /\b(DROP|ALTER)\b/i.test(sql)),
    [],
    'it only adds tables',
  );
});

test(
  'PostgreSQL SQL025: the runtime may use the tables; a grant reads only, and goes with its account',
  {timeout: 180000},
  async t => {
    const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
      db = f.runtime;
    for (const table of TABLES)
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        assert.equal(
          (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [
            f.isolated.roles.runtime,
            'public.' + table,
            privilege,
          ]))!.ok,
          true,
          `${table} ${privilege}`,
        );
    const owner = await account(db);
    const clientId = 'morfa_c_' + randomUUID();
    await db.execute(
      `INSERT INTO oauth_clients(id,kind,client_name,redirect_uris,metadata) VALUES($1,'dcr','Claude','["https://claude.ai/api/mcp/auth_callback"]','{}')`,
      [clientId],
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO oauth_clients(id,kind,client_name,redirect_uris,metadata) VALUES($1,'cimd','x','["https://a.example/cb"]','{}')`,
        ['morfa_c_x' + randomUUID()],
      ),
      code('23514'),
      'registered clients only',
    );
    const grant = (scopes: string) =>
      db.execute('INSERT INTO oauth_grants(id,user_id,client_id,client_name,scopes) VALUES($1,$2,$3,$4,$5::jsonb)', [
        randomUUID(),
        owner,
        clientId,
        'Claude',
        scopes,
      ]);
    await assert.rejects(grant('["write"]'), code('23514'), 'there is no writing');
    await assert.rejects(grant('["read","read"]'), code('23514'));
    await assert.rejects(grant('[]'), code('23514'));
    const grantId = randomUUID();
    await db.execute(
      `INSERT INTO oauth_grants(id,user_id,client_id,client_name,scopes) VALUES($1,$2,$3,'Claude','["read"]')`,
      [grantId, owner, clientId],
    );
    const family = randomUUID();
    await db.execute(
      "INSERT INTO oauth_tokens(id,grant_id,kind,token_hash,family_id,resource,expires_at) VALUES($1,$2,'access',$3,$4,'https://app.morfa.example/mcp',clock_timestamp()+interval '1 hour')",
      [randomUUID(), grantId, HASH, family],
    );
    await assert.rejects(
      db.execute(
        "INSERT INTO oauth_tokens(id,grant_id,kind,token_hash,family_id,resource,expires_at) VALUES($1,$2,'access',$3,$4,'https://app.morfa.example/mcp',clock_timestamp())",
        [randomUUID(), grantId, HASH, family],
      ),
      code('23505'),
      'a token hash is unique',
    );
    await assert.rejects(
      db.execute(
        "INSERT INTO oauth_tokens(id,grant_id,kind,token_hash,family_id,resource,expires_at) VALUES($1,$2,'access','morfa_at_plain',$3,'x',clock_timestamp())",
        [randomUUID(), grantId, family],
      ),
      code('23514'),
      'only a hash is stored',
    );
    await db.execute("INSERT INTO mcp_daily_calls(user_id,day,calls) VALUES($1,'2026-10-11',3)", [owner]);
    // The account's row gone (the migration role deletes it here; the app erases its rows itself) takes its grants, tokens and counts.
    await f.migration.execute('DELETE FROM users WHERE id=$1', [owner]);
    for (const table of ['oauth_grants', 'oauth_tokens', 'mcp_daily_calls'])
      assert.equal(
        (await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table}`))!.n,
        0,
        `${table} goes with the account`,
      );
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM oauth_clients'))!.n, 1, 'the client stays');
  },
);

test(
  'PostgreSQL SQL025: the upgrade keeps the accounts, and is a no-op the second time',
  {timeout: 180000},
  async t => {
    const f = await createPostgresqlRuntimeFixture(t),
      db = f.runtime;
    await account(db);
    await f.migration.transaction(tx => before25(tx, f.isolated.databaseName));
    assert.equal(
      (await f.migration.one<{name: string | null}>("SELECT to_regclass('public.oauth_clients')::text AS name"))!.name,
      null,
    );
    const before = await db.many('SELECT id,email FROM users ORDER BY id');
    const second = createDatabase(loadDatabaseConfig('migration', f.env));
    t.after(() => second.close());
    const results = await Promise.all(
      [f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})),
    );
    assert.deepEqual(results, [
      {ready: true, state: 'ready', version: 29},
      {ready: true, state: 'ready', version: 29},
    ]);
    assert.deepEqual(await db.many('SELECT id,email FROM users ORDER BY id'), before, 'accounts are untouched');
    const ledgerRows = await f.migration.many<{version: number; name: string}>(
      'SELECT version,name FROM postgres_migrations ORDER BY version',
    );
    assert.equal(ledgerRows.length, 29);
    assert.deepEqual(ledgerRows.at(-5), {version: 25, name: 'mcp-server'});
    const structure = await f.migration.transaction(databaseStructureFingerprint);
    assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {
      ready: true,
      state: 'ready',
      version: 29,
    });
    assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
    assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
  },
);
