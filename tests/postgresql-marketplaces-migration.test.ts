import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {MARKETPLACES_DROP_ORDER, removeMarketplacesForTest} from './helpers/postgresql-marketplaces-inverse';
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
import {MARKETPLACE_TABLES} from '../server/postgresql/schema/catalog';

// SQL027: marketplace cards (docs/marketplaces.md): brand kits, seller connections, card links, published pictures, publications, A/B
// tests and the daily numbers; a card follows its file and its connection, and the rest follows the account.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL027 in the guarded temporary database, so the next migrate is the real upgrade to 27. */
async function before27(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeMarketplacesForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [
    await databaseStructureFingerprint(tx),
  ]);
}

async function account(db: Database) {
  const id = 'sql27:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Seller','')", [
    id,
    randomUUID() + '@example.invalid',
  ]);
  return id;
}

async function file(db: Database, owner: string) {
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [
    id,
    owner,
    'Card',
    '{}',
    2,
    0,
  ]);
  return id;
}

async function connection(db: Database, owner: string, marketplace = 'wb') {
  const id = randomUUID();
  await db.execute('INSERT INTO marketplace_connections(id,user_id,marketplace,label,secret,hint) VALUES($1,$2,$3,$4,$5,$6)', [
    id,
    owner,
    marketplace,
    'Store',
    'envelope',
    '…1a2b',
  ]);
  return id;
}

async function brandKit(db: Database, owner: string, kit = '{"colours":["#1a1a2e"]}') {
  const id = randomUUID();
  await db.execute('INSERT INTO marketplace_brand_kits(id,user_id,name,kit) VALUES($1,$2,$3,$4::jsonb)', [
    id,
    owner,
    'Brand style',
    kit,
  ]);
  return id;
}

async function picture(db: Database, owner: string) {
  const id = randomUUID();
  await db.execute(
    'INSERT INTO marketplace_media(id,token_hash,user_id,filename,bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [
      id,
      createHash('sha256').update(randomUUID()).digest('hex'),
      owner,
      'card-1.jpg',
      2048,
      new Date(Date.now() + 86_400_000).toISOString(),
    ],
  );
  return id;
}

/** A card frame of `fileId` standing for the photo slot `nodeId` of a product on the connection. */
async function link(db: Database, owner: string, fileId: string, connectionId: string, nodeId: string) {
  const id = randomUUID();
  await db.execute(
    'INSERT INTO marketplace_card_links(id,user_id,file_id,node_id,connection_id,product_id,sku,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, owner, fileId, nodeId, connectionId, '12345', 'SKU-1', 'Mug'],
  );
  return id;
}

async function abTest(
  db: Database,
  owner: string,
  fileId: string,
  linkId: string,
  mode: 'cabinet' | 'rotation',
  swapHours: number | null = null,
) {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO marketplace_tests(id,user_id,link_id,file_id,variant_a,variant_b,mode,days,swap_hours) VALUES($1,$2,$3,$4,'Photo 1','Photo 2',$5,14,$6)`,
    [id, owner, linkId, fileId, mode, swapHours],
  );
  return id;
}

async function publication(db: Database, owner: string, linkId: string, testId: string | null = null) {
  const id = randomUUID();
  await db.execute('INSERT INTO marketplace_publications(id,user_id,link_id,node_id,test_id) VALUES($1,$2,$3,$4,$5)', [
    id,
    owner,
    linkId,
    '1:2',
    testId,
  ]);
  return id;
}

const dailyNumbers = (db: Database, connectionId: string) =>
  db.execute(
    "INSERT INTO marketplace_metrics(connection_id,product_id,day,views,clicks,carts,orders) VALUES($1,'12345','2026-10-10',120,9,2,NULL)",
    [connectionId],
  );

const count = async (db: Database, table: string) => (await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table}`))!.n;

test('should register SQL027 as the ordinary marketplaces migration after the MCP edits, compatible from 20', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[26]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 27, name: 'marketplaces', kind: 'ordinary', compatibleFrom: 20},
  );
  assert.equal(migrations[25]!.name, 'mcp-edits');
  assert.deepEqual([...MARKETPLACE_TABLES].sort(), [...MARKETPLACES_DROP_ORDER].sort());
  assert.deepEqual(
    migration.statements.map(sql => sql.replace(/^--.*$/gm, '').trim()).filter(sql => /\b(ALTER|UPDATE|DELETE FROM|DROP)\b/i.test(sql)),
    [],
    'it only adds tables and indexes',
  );
});

test(
  'PostgreSQL SQL027: the runtime role reads and writes the marketplace tables; a card is linked once, a rotation names its hours, and the cards go with their file, connection and account',
  {timeout: 180000},
  async t => {
    const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
      db = f.runtime;
    for (const table of MARKETPLACE_TABLES)
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
    await assert.rejects(connection(db, owner, 'ym'), code('23514'), 'a connection is to Wildberries or Ozon');
    await assert.rejects(brandKit(db, owner, '[]'), code('23514'), 'a brand kit is an object');
    const seller = await connection(db, owner, 'wb'),
      ozon = await connection(db, owner, 'ozon');
    await brandKit(db, owner);
    await picture(db, owner);
    await assert.rejects(
      db.execute("INSERT INTO marketplace_metrics(connection_id,product_id,day,views,orders) VALUES($1,'12345','2026-10-10',5,-1)", [seller]),
      code('23514'),
      'a count is not negative',
    );

    const kept = await file(db, owner),
      gone = await file(db, owner);
    const keptLink = await link(db, owner, kept, seller, '1:2');
    await link(db, owner, kept, seller, '3:4');
    await assert.rejects(link(db, owner, kept, seller, '1:2'), code('23505'), 'a slot of a file is linked once');
    await assert.rejects(abTest(db, owner, kept, keptLink, 'rotation'), code('23514'), 'a rotation names its hours');
    const rotation = await abTest(db, owner, kept, keptLink, 'rotation', 24);
    await publication(db, owner, keptLink, rotation);

    // The file deleted for good takes its card links, tests and publications; the other frame stays.
    const goneLink = await link(db, owner, gone, seller, '1:2');
    const goneTest = await abTest(db, owner, gone, goneLink, 'cabinet');
    await publication(db, owner, goneLink, goneTest);
    await db.execute('DELETE FROM design_files WHERE id=$1', [gone]);
    assert.equal(await count(db, 'marketplace_card_links'), 2);
    assert.equal(await count(db, 'marketplace_tests'), 1, 'the test of the deleted file goes');
    assert.equal(await count(db, 'marketplace_publications'), 1, 'and its publication');

    // The connection taken away takes its card links, tests, publications and numbers; the other connection keeps its numbers.
    await dailyNumbers(db, seller);
    await dailyNumbers(db, ozon);
    assert.equal(await count(db, 'marketplace_metrics'), 2);
    await db.execute('DELETE FROM marketplace_connections WHERE id=$1', [seller]);
    assert.equal(await count(db, 'marketplace_metrics'), 1, 'the numbers of the connection go');
    assert.equal(await count(db, 'marketplace_card_links'), 0);
    assert.equal(await count(db, 'marketplace_tests'), 0);
    assert.equal(await count(db, 'marketplace_publications'), 0);

    // The account takes the rest with it.
    await f.migration.execute('DELETE FROM users WHERE id=$1', [owner]);
    for (const table of MARKETPLACE_TABLES) assert.equal(await count(db, table), 0, `${table} goes with the account`);
  },
);

test(
  'PostgreSQL SQL027: the upgrade from 26 keeps the accounts and files, and is a no-op the second time',
  {timeout: 180000},
  async t => {
    const f = await createPostgresqlRuntimeFixture(t),
      db = f.runtime;
    const owner = await account(db);
    const kept = await file(db, owner);
    const before = await db.many('SELECT id,email FROM users ORDER BY id');
    await f.migration.transaction(tx => before27(tx, f.isolated.databaseName));
    for (const table of MARKETPLACE_TABLES)
      assert.equal(
        (await f.migration.one<{name: string | null}>(`SELECT to_regclass('public.${table}')::text AS name`))!.name,
        null,
        table,
      );
    assert.equal(
      (await f.migration.one<{name: string | null}>("SELECT to_regclass('public.mcp_edits')::text AS name"))!.name,
      'mcp_edits',
      'SQL026 stays',
    );
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
    assert.deepEqual(await db.many('SELECT id FROM design_files ORDER BY id'), [{id: kept}], 'files are untouched');
    const ledgerRows = await f.migration.many<{version: number; name: string}>(
      'SELECT version,name FROM postgres_migrations ORDER BY version',
    );
    assert.equal(ledgerRows.length, 29);
    assert.deepEqual(ledgerRows.at(-3), {version: 27, name: 'marketplaces'});
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
