import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {removeDesignCommentsForTest, DESIGN_COMMENT_DROP_ORDER} from './helpers/postgresql-design-comments-inverse';
import {removeDesignLibrariesForTest} from './helpers/postgresql-design-libraries-inverse';
import {removeDesignAiPausesForTest} from './helpers/postgresql-design-ai-pauses-inverse';
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
import {APPLICATION_TABLES, DESIGN_COMMENT_TABLES} from '../server/postgresql/schema/catalog';

// SQL035: "Morfa Design" comments (docs/design-tool.md §Teams "Comments"): threads pinned to a file's page, their comments, mentions and
// each account's read state. Derived tables, outside the SQLite import inventory; they go with their file.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL040–SQL035 in the guarded temporary database, so the next migrate is the real 34 → 35 upgrade (and 36–40 after it). */
async function schema34(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  await removeDesignAiPausesForTest(tx);
  await removeDesignLibrariesForTest(tx);
  assert.equal(await removeDesignCommentsForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

const row = {
  user: (db: Database, id: string) => db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']),
  file: async (db: Database, user: string) => {
    const id = randomUUID();
    await db.execute('INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,$3,$4,$5,$6)', [id, user, 'Mockup', '{}', 2, 0]);
    return id;
  },
  thread: async (db: Database, file: string, author: string | null, fields: Record<string, unknown> = {}) => {
    const id = (fields.id as string) ?? randomUUID();
    await db.execute(
      `INSERT INTO design_comment_threads(id,file_id,page_id,x,y,node_id,offset_x,offset_y,author_id,seq,resolved_at,resolved_by,deleted_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, file, fields.page_id ?? '0:1', fields.x ?? 10, fields.y ?? 20, fields.node_id ?? null, fields.offset_x ?? null, fields.offset_y ?? null, author,
        fields.seq ?? 1, fields.resolved_at ?? null, fields.resolved_by ?? null, fields.deleted_at ?? null],
    );
    return id;
  },
  comment: async (db: Database, thread: string, author: string | null, fields: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.execute('INSERT INTO design_comments(id,thread_id,author_id,body,seq) VALUES($1,$2,$3,$4,$5)', [id, thread, author, fields.body ?? 'Check the spacing', fields.seq ?? 1]);
    return id;
  },
};

test('should register SQL035 as the ordinary design-comments migration after the teams, declared compatible from 24, outside the import inventory', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[5]!;
  assert.deepEqual({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}, {version: 6, name: 'design-comments', kind: 'ordinary', compatibleFrom: 6});
  assert.equal(migrations[4]!.name, 'design-teams');
  assert.deepEqual([...DESIGN_COMMENT_TABLES].sort(), [...DESIGN_COMMENT_DROP_ORDER].sort());
  for (const table of DESIGN_COMMENT_TABLES) assert.equal((APPLICATION_TABLES as readonly string[]).includes(table), false, table + ' is derived, not imported');
  assert.ok(!migration.statements.some(sql => /\bDROP\b/i.test(sql)), 'nothing is dropped');
  assert.ok(!migration.statements.some(sql => /ALTER TABLE/i.test(sql)), 'no existing table changes');
});

test('PostgreSQL SQL035: the runtime keeps comments, the checks hold anchors, text and mentions, and the rows go with their file', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const may = async (table: string, privilege: string) => (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok;
  for (const table of DESIGN_COMMENT_TABLES)
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      assert.equal(await may(table, privilege), ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), `${table} ${privilege}`);

  const owner = 'sql35:owner:' + randomUUID(),
    member = 'sql35:member:' + randomUUID();
  await row.user(db, owner);
  await row.user(db, member);
  const file = await row.file(db, owner),
    other = await row.file(db, owner);

  // Anchors: on the canvas (no layer), or on a layer with its offset; finite, bounded, ids of the document's shape.
  const canvas = await row.thread(db, file, owner);
  const layer = await row.thread(db, file, member, {node_id: '12:34', offset_x: 5, offset_y: -3.5, seq: 2});
  for (const [why, fields] of [
    ['a layer without its offset', {node_id: '1:2'}],
    ['an offset without a layer', {offset_x: 1, offset_y: 1}],
    ['half an offset', {node_id: '1:2', offset_x: 1}],
    ['an infinite point', {x: 'Infinity'}],
    ['not a number', {y: 'NaN'}],
    ['too far', {x: 2e9}],
    ['a page id with markup', {page_id: '<b>'}],
    ['a counter of zero', {seq: 0}],
    ['resolved by someone without a time', {resolved_by: owner}],
    ['a tombstone with an author', {deleted_at: '2026-10-07T00:00:00Z'}],
  ] as const) await assert.rejects(row.thread(db, file, owner, fields), code('23514'), why);
  await assert.rejects(row.thread(db, file, owner, {id: 'not-a-uuid'}), code('23514'), 'a UUID');
  await assert.rejects(row.thread(db, randomUUID(), owner), code('23503'), 'of a file that exists');
  await row.thread(db, file, null, {deleted_at: '2026-10-07T00:00:00Z', seq: 3});

  // Comments: plain text of 1–4000 characters; mentions inside the text, of real accounts, one per position.
  const first = await row.comment(db, canvas, owner);
  await assert.rejects(row.comment(db, canvas, owner, {body: ''}), code('23514'), 'not empty');
  await assert.rejects(row.comment(db, canvas, owner, {body: 'x'.repeat(4001)}), code('23514'), 'at most 4000');
  await row.comment(db, canvas, owner, {body: 'x'.repeat(4000), seq: 4});
  const mention = (at: number, length: number, user = member) =>
    db.execute('INSERT INTO design_comment_mentions(comment_id,user_id,at,length) VALUES($1,$2,$3,$4)', [first, user, at, length]);
  await mention(0, 6);
  await assert.rejects(mention(0, 6, owner), code('23505'), 'one mention per position');
  await assert.rejects(mention(7, 1), code('23514'), 'at least "@" and a letter');
  await assert.rejects(mention(7, 102), code('23514'), 'at most 101');
  await assert.rejects(mention(7, 5, 'sql35:nobody'), code('23503'), 'of an account');
  await db.execute('INSERT INTO design_comment_reads(thread_id,user_id,read_seq) VALUES($1,$2,4)', [canvas, member]);
  await assert.rejects(db.execute('INSERT INTO design_comment_reads(thread_id,user_id,read_seq) VALUES($1,$2,-1)', [layer, member]), code('23514'), 'a counter');
  await row.thread(db, other, owner);

  // Erasing a file takes its threads, comments, mentions and read state; another file keeps its own.
  await db.execute('DELETE FROM design_files WHERE id=$1', [file]);
  for (const table of DESIGN_COMMENT_TABLES)
    assert.equal((await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table}`))!.n, table === 'design_comment_threads' ? 1 : 0, table);
});

test('PostgreSQL SQL035: 34 → 35 adds the tables once, keeps the design files and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const owner = 'sql35:keep:' + randomUUID();
  await row.user(db, owner);
  await row.file(db, owner);
  const before = await db.many('SELECT id,user_id,name,version FROM design_files ORDER BY id');
  await f.migration.transaction(tx => schema34(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.design_comment_threads')::text AS name"))!.name, null);
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id,name,version FROM design_files ORDER BY id'), before, 'files are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-25), [{version: 5, name: 'design-teams'}, {version: 6, name: 'design-comments'}, {version: 7, name: 'design-libraries'}, {version: 8, name: 'design-ai-pauses'}, {version: 9, name: 'design-file-changes'}, {version: 10, name: 'design-boards'}, {version: 11, name: 'design-meetings'}, {version: 12, name: 'design-collab'}, {version: 13, name: 'design-big-files'}, {version: 14, name: 'design-team-email-invites'}, {version: 15, name: 'design-file-sharing'}, {version: 16, name: 'design-file-heads'}, {version: 17, name: 'proven-addresses'}, {version: 18, name: 'design-favourites'}, {version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
