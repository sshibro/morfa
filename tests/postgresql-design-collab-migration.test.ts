import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignCollabForTest, DESIGN_COLLAB_COLUMNS} from './helpers/postgresql-design-collab-inverse';
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
import {DESIGN_FILE_CHANGE_TABLES} from '../server/postgresql/schema/catalog';

// SQL012: the collab journal, lease and checkpoints (docs/BACKEND.md §3, §8; lane B2). design_file_changes gains the op in the
// model's codec, its sender and the lease fence; design_files the lease and the latest checkpoint; design_images the content hash.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL012 in the guarded temporary database, so the next migrate is the real upgrade to 12. */
async function before12(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeDesignCollabForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const user = async (db: Database, prefix: string) => {
  const id = prefix + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  return id;
};
const file = async (db: Database, owner: string) => {
  const id = randomUUID();
  await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, owner, 'Large mockup', '{}', 2, 0]);
  return id;
};
type Row = {patch?: string | null; op?: Buffer | null; clientId?: string | null; clientSeq?: number | null; fence?: number | null; userId?: string | null};
const change = (db: Database, fileId: string, version: number, row: Row = {patch: '{}'}) =>
  db.execute('INSERT INTO design_file_changes(file_id,version,patch,op,client_id,client_seq,fence,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
    fileId, String(version), row.patch ?? null, row.op ?? null, row.clientId ?? null, row.clientSeq ?? null, row.fence ?? null, row.userId ?? null,
  ]);

test('should register SQL012 as the ordinary collab migration after the meetings, compatible from 11', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[11]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 12, name: 'design-collab', kind: 'ordinary', compatibleFrom: 11});
  assert.equal(migrations[10]!.name, 'design-meetings');
  assert.deepEqual(migration.statements.filter(sql => /\bDROP\b/i.test(sql) && !/DROP NOT NULL/i.test(sql)), [], 'it only adds (and lets patch be NULL)');
});

test('PostgreSQL SQL012: journal rows hold exactly one body, a client counter once, and the current fence only', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const table of DESIGN_FILE_CHANGE_TABLES)
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      assert.equal(await may(table, privilege), ['SELECT', 'INSERT', 'DELETE'].includes(privilege), `${table} ${privilege}: the journal is never rewritten`);
  const owner = await user(db, 'sql12:');
  const fileId = await file(db, owner);
  // Node's rows are unchanged: JSON patch, no fence.
  await change(db, fileId, 2);
  // Collab's: the op in the codec, under the file's fence.
  await assert.rejects(change(db, fileId, 3, {op: Buffer.from('MRFA'), fence: 1}), code('MRF01'), 'fence 1 is not the file’s fence 0');
  await db.execute('UPDATE design_files SET fence=fence+1,collab_node=$2,lease_until=now()+interval \'15 seconds\' WHERE id=$1', [fileId, 'node-a']);
  await change(db, fileId, 3, {op: Buffer.from('MRFA'), fence: 1, clientId: 'tab-1', clientSeq: 1, userId: owner});
  await db.execute('UPDATE design_files SET fence=fence+1,collab_node=$2 WHERE id=$1', [fileId, 'node-b']);
  await assert.rejects(change(db, fileId, 4, {op: Buffer.from('MRFA'), fence: 1, clientId: 'tab-1', clientSeq: 2}), code('MRF01'), 'a stale owner cannot add');
  await change(db, fileId, 4, {op: Buffer.from('MRFA'), fence: 2, clientId: 'tab-1', clientSeq: 2});
  await assert.rejects(change(db, fileId, 5, {op: Buffer.from('MRFA'), fence: 2, clientId: 'tab-1', clientSeq: 2}), code('23505'), 'an op is journaled once');
  await assert.rejects(change(db, fileId, 5, {patch: '{}', op: Buffer.from('MRFA')}), code('23514'), 'not both bodies');
  await assert.rejects(change(db, fileId, 5, {}), code('23514'), 'not neither');
  await assert.rejects(change(db, fileId, 5, {patch: '{}', clientId: 'tab-1'}), code('23514'), 'a client id comes with its counter');
  await assert.rejects(change(db, fileId, 5, {op: Buffer.alloc(0)}), code('23514'), 'an op has bytes');
  await assert.rejects(change(db, fileId, 5, {patch: '{}', clientId: 'tab 1', clientSeq: 1}), code('23514'));
  await assert.rejects(db.execute('UPDATE design_file_changes SET op=$2 WHERE file_id=$1', [fileId, Buffer.from('x')]), code('42501'));
  // design_files: lease and checkpoint come whole, the checkpoint is never ahead of the file.
  await assert.rejects(db.execute('UPDATE design_files SET collab_node=NULL WHERE id=$1', [fileId]), code('23514'), 'a lease has its end');
  await assert.rejects(db.execute("UPDATE design_files SET checkpoint_key=$2 WHERE id=$1", [fileId, `ckpt/${fileId}/1.bin.zst`]), code('23514'));
  await assert.rejects(db.execute("UPDATE design_files SET checkpoint_key=$2,checkpoint_version=2,checkpoint_format='bin' WHERE id=$1", [fileId, `ckpt/${fileId}/2.bin.zst`]), code('23514'), 'the checkpoint is at most the file version');
  await assert.rejects(db.execute("UPDATE design_files SET checkpoint_key='x',checkpoint_version=1,checkpoint_format='bin' WHERE id=$1", [fileId]), code('23514'));
  await db.execute("UPDATE design_files SET checkpoint_key=$2,checkpoint_version=1,checkpoint_format='json' WHERE id=$1", [fileId, `ckpt/${fileId}/1.json.zst`]);
  // design_images: hash and key together.
  const hash = 'a'.repeat(64);
  await assert.rejects(db.execute("INSERT INTO design_images(filename,user_id,kind,bytes,width,height,content_hash) VALUES('a.png',$1,'image',1,1,1,$2)", [owner, hash]), code('23514'));
  await db.execute("INSERT INTO design_images(filename,user_id,kind,bytes,width,height,content_hash,storage_key) VALUES('a.png',$1,'image',1,1,1,$2,$3)", [owner, hash, 'img/' + hash]);
  await db.execute('DELETE FROM design_files WHERE id=$1', [fileId]);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_file_changes WHERE file_id=$1', [fileId]))!.n, 0, 'the journal goes with the file');
});

test('PostgreSQL SQL012: a lease takeover waits for the journal commit in flight, which then belongs to the old fence', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const fileId = await file(db, await user(db, 'sql12:race:'));
  await db.execute("UPDATE design_files SET fence=1,collab_node='a',lease_until=now()+interval '15 seconds' WHERE id=$1", [fileId]);
  // Two sessions of their own (the pool keeps one transaction per callback).
  const [owner, next] = [new pg.Client(f.env.MORFA_DATABASE_URL), new pg.Client(f.env.MORFA_DATABASE_URL)];
  for (const client of [owner, next]) client.on('error', () => {});
  await Promise.all([owner.connect(), next.connect()]);
  // What crates/journal does: the row lock under the fence, then the rows, in one transaction.
  await owner.query('BEGIN');
  assert.equal((await owner.query('UPDATE design_files SET version=greatest(version,2) WHERE id=$1 AND fence=1 RETURNING id', [fileId])).rowCount, 1);
  let taken = false;
  const takeover = next
    .query("UPDATE design_files SET fence=fence+1,collab_node='b',lease_until=now()+interval '15 seconds' WHERE id=$1", [fileId])
    .then(() => (taken = true));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(taken, false, 'the takeover waits for the commit');
  await owner.query('INSERT INTO design_file_changes(file_id,version,op,fence) VALUES($1,2,$2,1)', [fileId, Buffer.from('MRFA')]);
  await owner.query('COMMIT');
  await takeover;
  assert.deepEqual(await db.one('SELECT fence::int AS fence,version::int AS version FROM design_files WHERE id=$1', [fileId]), {fence: 2, version: 2});
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_file_changes WHERE file_id=$1', [fileId]))!.n, 1, 'the new owner sees the row');
  // And the other way round: once the takeover committed, the old owner's lock finds no row and its insert is refused.
  await owner.query('BEGIN');
  assert.equal((await owner.query('UPDATE design_files SET version=greatest(version,3) WHERE id=$1 AND fence=1 RETURNING id', [fileId])).rowCount, 0);
  await assert.rejects(owner.query('INSERT INTO design_file_changes(file_id,version,op,fence) VALUES($1,3,$2,1)', [fileId, Buffer.from('MRFA')]), code('MRF01'));
  await owner.query('ROLLBACK');
  await Promise.all([owner.end(), next.end()]);
});

test('PostgreSQL SQL012: the upgrade keeps files and journal rows, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const fileId = await file(db, await user(db, 'sql12:keep:'));
  await f.migration.transaction(tx => before12(tx, f.isolated.databaseName));
  for (const [table, columns] of Object.entries(DESIGN_COLLAB_COLUMNS))
    assert.equal((await f.migration.one<{n: number}>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=ANY($2)", [table, columns]))!.n, 0, table);
  // A legacy row written before the upgrade.
  await db.execute('INSERT INTO design_file_changes(file_id,version,patch) VALUES($1,2,$2)', [fileId, '{"nodes":{}}']);
  const before = await db.many('SELECT id,user_id,name,version,document FROM design_files ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name,version,document FROM design_files ORDER BY id'), before, 'files are untouched');
  assert.deepEqual(await db.many('SELECT version::int AS version,patch,op,fence FROM design_file_changes WHERE file_id=$1', [fileId]), [{version: 2, patch: '{"nodes":{}}', op: null, fence: null}]);
  assert.deepEqual(await db.one('SELECT fence::int AS fence,collab_node,checkpoint_key FROM design_files WHERE id=$1', [fileId]), {fence: 0, collab_node: null, checkpoint_key: null});
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.deepEqual(ledgerRows.slice(-18), [{version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});

test('PostgreSQL SQL012: retained collab rows forbid the test inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const fileId = await file(db, await user(db, 'sql12:retained:'));
  await change(db, fileId, 2, {op: Buffer.from('MRFA')});
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  await assert.rejects(f.migration.transaction(tx => before12(tx, f.isolated.databaseName)), /Retained collab journal rows forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
