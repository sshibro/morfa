import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {MCP_EDITS_DROP_ORDER, removeMcpEditsForTest} from './helpers/postgresql-mcp-edits-inverse';
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
import {MCP_EDIT_TABLES} from '../server/postgresql/schema/catalog';

// SQL026: the MCP server's editing: a grant may allow changing files, and the changes an assistant made are kept to undo them
// (docs/mcp-server.md §Editing).

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL026 in the guarded temporary database, so the next migrate is the real upgrade to 26. */
async function before26(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeMcpEditsForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [
    await databaseStructureFingerprint(tx),
  ]);
}

async function account(db: Database) {
  const id = 'sql26:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [
    id,
    randomUUID() + '@example.invalid',
  ]);
  return id;
}

async function connection(db: Database, owner: string, scopes: string) {
  const clientId = 'morfa_c_' + randomUUID();
  await db.execute(
    `INSERT INTO oauth_clients(id,kind,client_name,redirect_uris,metadata) VALUES($1,'dcr','Claude','["https://claude.ai/api/mcp/auth_callback"]','{}')`,
    [clientId],
  );
  const id = randomUUID();
  await db.execute('INSERT INTO oauth_grants(id,user_id,client_id,client_name,scopes) VALUES($1,$2,$3,$4,$5::jsonb)', [
    id,
    owner,
    clientId,
    'Claude',
    scopes,
  ]);
  return {id, clientId};
}

async function file(db: Database, owner: string) {
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [
    id,
    owner,
    'Mockup',
    '{}',
    2,
    0,
  ]);
  return id;
}

const edit = (db: Database, grantId: string, fileId: string, label = 'Added layers') =>
  db.execute(
    `INSERT INTO mcp_edits(id,grant_id,file_id,label,version,patch,inverse) VALUES($1,$2,$3,$4,2,'{"nodes":{}}','{"nodes":{}}')`,
    [randomUUID(), grantId, fileId, label],
  );

const count = async (db: Database, table: string) => (await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table}`))!.n;

test('should register SQL026 as the ordinary MCP edits migration after the MCP server, compatible from 20', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[25]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 26, name: 'mcp-edits', kind: 'ordinary', compatibleFrom: 20},
  );
  assert.equal(migrations[24]!.name, 'mcp-server');
  assert.deepEqual([...MCP_EDIT_TABLES].sort(), [...MCP_EDITS_DROP_ORDER].sort());
  assert.deepEqual(
    migration.statements.map(sql => sql.trim().split('\n').at(-1)!).filter(sql => /\bDROP\b/i.test(sql)),
    ['ALTER TABLE public.oauth_grants DROP CONSTRAINT oauth_grants_scopes_check;'],
    'it only widens the grants check and adds a table',
  );
});

test(
  'PostgreSQL SQL026: a grant reads or reads and writes; kept edits go with the connection, the file and the account',
  {timeout: 180000},
  async t => {
    const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
      db = f.runtime;
    for (const table of MCP_EDIT_TABLES)
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
    await connection(db, owner, '["read"]');
    const writer = await connection(db, owner, '["read","write"]');
    for (const scopes of ['["write"]', '["write","read"]', '["read","read"]', '["read","write","write"]', '[]', '"read"'])
      await assert.rejects(connection(db, owner, scopes), code('23514'), scopes);

    const kept = await file(db, owner),
      gone = await file(db, owner);
    await edit(db, writer.id, kept);
    await edit(db, writer.id, gone);
    await assert.rejects(edit(db, writer.id, kept, ''), code('23514'), 'a change is named');
    await assert.rejects(edit(db, writer.id, randomUUID()), code('23503'), 'only in a file that exists');
    await assert.rejects(
      db.execute(
        `INSERT INTO mcp_edits(id,grant_id,file_id,label,version,patch,inverse) VALUES($1,$2,$3,'x',1,'[]','{}')`,
        [randomUUID(), writer.id, kept],
      ),
      code('23514'),
      'a patch is an object',
    );
    // The file deleted for good takes its kept changes; the connection revoked (its row deleted) takes the rest.
    await db.execute('DELETE FROM design_files WHERE id=$1', [gone]);
    assert.equal(await count(db, 'mcp_edits'), 1);
    await db.execute('DELETE FROM oauth_grants WHERE id=$1', [writer.id]);
    assert.equal(await count(db, 'mcp_edits'), 0);

    const again = await connection(db, owner, '["read","write"]');
    await edit(db, again.id, kept);
    await f.migration.execute('DELETE FROM users WHERE id=$1', [owner]);
    for (const table of ['oauth_grants', 'mcp_edits']) assert.equal(await count(db, table), 0, `${table} goes with the account`);
  },
);

test(
  'PostgreSQL SQL026: the upgrade keeps reading grants, and is a no-op the second time',
  {timeout: 180000},
  async t => {
    const f = await createPostgresqlRuntimeFixture(t),
      db = f.runtime;
    const owner = await account(db);
    await f.migration.transaction(tx => before26(tx, f.isolated.databaseName));
    assert.equal(
      (await f.migration.one<{name: string | null}>("SELECT to_regclass('public.mcp_edits')::text AS name"))!.name,
      null,
    );
    const reading = await connection(db, owner, '["read"]');
    await assert.rejects(connection(db, owner, '["read","write"]'), code('23514'), 'SQL025 knows only reading');
    const second = createDatabase(loadDatabaseConfig('migration', f.env));
    t.after(() => second.close());
    const results = await Promise.all(
      [f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})),
    );
    assert.deepEqual(results, [
      {ready: true, state: 'ready', version: 29},
      {ready: true, state: 'ready', version: 29},
    ]);
    assert.deepEqual(
      await db.many('SELECT id,scopes FROM oauth_grants ORDER BY id'),
      [{id: reading.id, scopes: ['read']}],
      'reading grants are untouched',
    );
    await connection(db, owner, '["read","write"]');
    const ledgerRows = await f.migration.many<{version: number; name: string}>(
      'SELECT version,name FROM postgres_migrations ORDER BY version',
    );
    assert.equal(ledgerRows.length, 29);
    assert.deepEqual(ledgerRows.at(-4), {version: 26, name: 'mcp-edits'});
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
