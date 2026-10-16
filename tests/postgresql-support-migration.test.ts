import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {SUPPORT_DROP_ORDER, removeSupportForTest} from './helpers/postgresql-support-inverse';
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
import {SUPPORT_MESSAGE_TABLES, SUPPORT_PRESENCE_TABLES, SUPPORT_THREAD_TABLES} from '../server/postgresql/schema/catalog';
import {SUPPORT_MESSAGE_MAX} from '../shared/support';

// SQL019: the support chat (shared/support.ts): one conversation per account and its messages, erased and exported with the account.

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL019 in the guarded temporary database, so the next migrate is the real upgrade to 19. */
async function before19(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeSupportForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function account(db: Database, closing = false) {
  const id = 'sql19:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password,deletion_requested_at) VALUES($1,$2,'Person','',$3)", [
    id,
    randomUUID() + '@example.invalid',
    closing ? '2026-10-10 10:00:00' : null,
  ]);
  return id;
}

async function thread(db: Database, userId: string) {
  const id = randomUUID();
  await db.execute('INSERT INTO support_threads(id,user_id) VALUES($1,$2)', [id, userId]);
  return id;
}

const message = (db: Database, threadId: string, fields: {author?: string; operatorId?: string | null; body?: string; clientId?: string; context?: unknown} = {}) =>
  db.execute('INSERT INTO support_messages(id,thread_id,author,operator_id,body,client_id,context) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [
    randomUUID(),
    threadId,
    fields.author ?? 'user',
    fields.operatorId ?? null,
    fields.body ?? 'Hello',
    fields.clientId ?? randomUUID(),
    fields.context === undefined ? null : JSON.stringify(fields.context),
  ]);

test('should register SQL019 as the ordinary support migration after the favourites, compatible from 17', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const migration = migrations[18]!;
  assert.deepEqual(
    {version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom},
    {version: 19, name: 'support', kind: 'ordinary', compatibleFrom: 17},
  );
  assert.equal(migrations[17]!.name, 'design-favourites');
  assert.deepEqual([...SUPPORT_MESSAGE_TABLES, ...SUPPORT_THREAD_TABLES, ...SUPPORT_PRESENCE_TABLES], [...SUPPORT_DROP_ORDER]);
  assert.deepEqual(migration.statements.filter(sql => /\b(DROP|ALTER)\b/i.test(sql)), [], 'it only adds tables');
  assert.ok(migration.statements.some(sql => sql.includes(`char_length(body) BETWEEN 1 AND ${SUPPORT_MESSAGE_MAX}`)), 'the body cap is the contract\'s');
});

test('PostgreSQL SQL019: one conversation per account, plain messages once per key, exported and erased with the account', {timeout: 180000}, async t => {
  // The server's own modules (the export, the erasure) read the runtime database.
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const privileges = [
    ...SUPPORT_THREAD_TABLES.map(table => [table, {SELECT: true, INSERT: true, UPDATE: true, DELETE: true}] as const),
    ...SUPPORT_MESSAGE_TABLES.map(table => [table, {SELECT: true, INSERT: true, UPDATE: false, DELETE: true}] as const),
    ...SUPPORT_PRESENCE_TABLES.map(table => [table, {SELECT: true, INSERT: true, UPDATE: true, DELETE: true}] as const),
  ];
  for (const [table, expected] of privileges)
    for (const [privilege, granted] of Object.entries(expected))
      assert.equal(
        (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok,
        granted,
        `${table} ${privilege}`,
      );
  const person = await account(db),
    operator = await account(db);
  const threadId = await thread(db, person);
  await assert.rejects(thread(db, person), code('23505'), 'one conversation per account');
  await assert.rejects(db.execute('INSERT INTO support_threads(id,user_id) VALUES($1,$2)', ['not-a-uuid', operator]), code('23514'));
  await assert.rejects(db.execute("UPDATE support_threads SET status='archived' WHERE id=$1", [threadId]), code('23514'));
  await message(db, threadId, {clientId: 'key-1', context: {fileId: randomUUID(), where: 'editor'}});
  await assert.rejects(message(db, threadId, {clientId: 'key-1'}), code('23505'), 'one message per key and side');
  await message(db, threadId, {author: 'operator', operatorId: operator, clientId: 'key-1'});
  await assert.rejects(message(db, threadId, {body: ''}), code('23514'), 'never empty');
  // Cyrillic on purpose: the limit counts characters, not bytes.
  await message(db, threadId, {body: 'я'.repeat(SUPPORT_MESSAGE_MAX)});
  await assert.rejects(message(db, threadId, {body: 'я'.repeat(SUPPORT_MESSAGE_MAX + 1)}), code('23514'), 'at most the contract\'s length');
  await assert.rejects(message(db, threadId, {clientId: 'not a key'}), code('23514'));
  await assert.rejects(message(db, threadId, {author: 'bot'}), code('23514'));
  await assert.rejects(message(db, threadId, {operatorId: operator}), code('23514'), 'a person\'s message names no operator');
  await assert.rejects(message(db, threadId, {author: 'operator', operatorId: operator, context: {where: 'editor'}}), code('23514'), 'context is the person\'s');
  await assert.rejects(message(db, threadId, {context: ['editor']}), code('23514'), 'context is an object');
  await assert.rejects(message(db, randomUUID()), code('23503'), 'only in a conversation');

  // The account's data export lists its conversation; its erasure takes it, messages and all.
  const {prepareExportMetadata} = await import('../server/launch/export-json');
  const {exportSupport, eraseSupportOf} = await import('../server/support/store');
  const chunks: string[] = [];
  await prepareExportMetadata({support: exportSupport(person)})(db, async text => void chunks.push(text));
  const exported = (JSON.parse('{' + chunks.join('') + '}') as {support: Array<{author: string; body: string; context?: unknown}>}).support;
  assert.deepEqual(exported.map(row => row.author), ['user', 'operator', 'user']);
  assert.equal(exported[0]!.body, 'Hello');
  assert.equal((exported[0]!.context as {where: string}).where, 'editor');
  // "Typing" names the operator and needs its end; an operator's presence is one row, of an account.
  await assert.rejects(db.execute('UPDATE support_threads SET operator_typing_by=$2 WHERE id=$1', [threadId, operator]), code('23514'));
  await db.execute("UPDATE support_threads SET operator_typing_until=clock_timestamp()+interval '6 seconds',operator_typing_by=$2 WHERE id=$1", [threadId, operator]);
  await db.execute('INSERT INTO support_operator_presence(user_id) VALUES($1)', [operator]);
  await assert.rejects(db.execute('INSERT INTO support_operator_presence(user_id) VALUES($1)', [operator]), code('23505'), 'one row per operator');
  await assert.rejects(db.execute('INSERT INTO support_operator_presence(user_id) VALUES($1)', ['nobody']), code('23503'));
  // The operator's erasure takes its presence and its "typing" state; its replies stay.
  await db.transaction(tx => eraseSupportOf(tx, operator));
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM support_operator_presence'))!.n, 0);
  assert.deepEqual(await db.one('SELECT operator_typing_until,operator_typing_by FROM support_threads WHERE id=$1', [threadId]), {operator_typing_until: null, operator_typing_by: null});
  assert.equal((await db.one<{n: number}>("SELECT count(*)::int AS n FROM support_messages WHERE thread_id=$1 AND author='operator'", [threadId]))!.n, 1);
  // The operator's own conversation is untouched by the person's erasure, and the operator's reply stays in the person's until then.
  const operatorThread = await thread(db, operator);
  await message(db, operatorThread);
  await db.transaction(tx => eraseSupportOf(tx, person));
  for (const table of [...SUPPORT_THREAD_TABLES, ...SUPPORT_MESSAGE_TABLES])
    assert.equal(
      (await db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'support_threads' ? 'id' : 'thread_id'}=$1`, [threadId]))!.n,
      0,
      `${table} goes with its account`,
    );
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM support_messages WHERE thread_id=$1', [operatorThread]))!.n, 1);
  // A conversation goes with its account's row too (a test's cleanup; the runtime anonymises accounts instead).
  await f.migration.execute('DELETE FROM users WHERE id=$1', [operator]);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM support_threads WHERE id=$1', [operatorThread]))!.n, 0);

  // The maintenance pass's erasure takes a closing account's conversation; an erased operator's replies elsewhere stay, naming the
  // anonymised row.
  const {eraseAccount} = await import('../server/launch/lifecycle');
  const leaving = await account(db, true),
    leavingOperator = await account(db, true),
    staying = await account(db);
  const leavingThread = await thread(db, leaving),
    stayingThread = await thread(db, staying);
  await message(db, leavingThread);
  await message(db, stayingThread);
  await message(db, stayingThread, {author: 'operator', operatorId: leavingOperator, body: 'Operator reply'});
  const at = new Date().toISOString();
  await eraseAccount(leaving, at);
  await eraseAccount(leavingOperator, at);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM support_threads WHERE user_id=$1', [leaving]))!.n, 0);
  assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM support_messages WHERE thread_id=$1', [leavingThread]))!.n, 0);
  const reply = await db.one<{operator_id: string; body: string}>("SELECT operator_id,body FROM support_messages WHERE thread_id=$1 AND author='operator'", [stayingThread]);
  assert.deepEqual(reply, {operator_id: leavingOperator, body: 'Operator reply'});
  assert.equal((await db.one<{name: string}>('SELECT name FROM users WHERE id=$1', [leavingOperator]))!.name, 'Deleted account');
});

test('PostgreSQL SQL019: the upgrade keeps the accounts, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await account(db);
  await f.migration.transaction(tx => before19(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.support_threads')::text AS name"))!.name, null);
  const before = await db.many('SELECT id,email,name FROM users ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,email,name FROM users ORDER BY id'), before, 'accounts are untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.equal(ledgerRows.length, 29);
  assert.deepEqual(ledgerRows.slice(-11), [{version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});

test('PostgreSQL SQL019: a retained conversation forbids the test inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  await thread(db, await account(db));
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  await assert.rejects(f.migration.transaction(tx => before19(tx, f.isolated.databaseName)), /Retained support_threads forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
