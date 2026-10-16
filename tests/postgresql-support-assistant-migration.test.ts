import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {assertPostgresqlTestDatabaseName} from './helpers/postgresql';
import {SUPPORT_ASSISTANT_DROP_ORDER, removeSupportAssistantForTest} from './helpers/postgresql-support-assistant-inverse';
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
import {SUPPORT_AI_APPEND_TABLES, SUPPORT_AI_CONVERSATION_TABLES, SUPPORT_AI_RECORD_TABLES} from '../server/postgresql/schema/catalog';

// SQL022: the migration of the support chat's assistant tables (the assistant itself is gone from the app, the tables stay): its
// conversations, the append-only transcript, replies, requests, handoffs and the tours' events; the conversation's words go with the
// thread, the cost record stays. The chat's messages gain the author 'assistant', the guide its message offers and the handoff's note.
const SUPPORT_HANDOFF_REASONS = ['refund', 'billing', 'bug', 'account', 'legal', 'unsure', 'person_asked', 'refusal', 'limit', 'budget', 'api_error'] as const;
const SUPPORT_TOPICS = [
  'sharing', 'export', 'plans_limits', 'billing', 'ai_credits', 'components', 'auto_layout', 'prototype', 'teams', 'files_trash', 'versions', 'bug', 'account', 'other',
] as const;

const code = (value: string) => (error: unknown) => (error as {code?: string}).code === value;

/** Test-only inverse of SQL022 in the guarded temporary database, so the next migrate is the real upgrade. */
async function before22(tx: TransactionContext, databaseName: string) {
  assertPostgresqlTestDatabaseName(databaseName);
  await acquireMigrationLock(tx);
  assert.equal((await tx.one<{name: string}>('SELECT current_database() AS name'))!.name, databaseName);
  assert.equal(await removeSupportAssistantForTest(tx), true);
  await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [await databaseStructureFingerprint(tx)]);
}

async function account(db: Database) {
  const id = 'sql22:' + randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Person','')", [id, randomUUID() + '@example.invalid']);
  return id;
}
async function thread(db: Database, userId: string) {
  const id = randomUUID();
  await db.execute('INSERT INTO support_threads(id,user_id) VALUES($1,$2)', [id, userId]);
  return id;
}
async function conversation(db: Database, threadId: string, accountId: string) {
  const id = randomUUID();
  await db.execute('INSERT INTO support_ai_conversations(id,thread_id,account_id) VALUES($1,$2,$3)', [id, threadId, accountId]);
  return id;
}
const reply = (db: Database, fields: {conversationId?: string | null; threadId?: string | null; accountId?: string | null; outcome?: string; reason?: string | null; guide?: string | null}) =>
  db.execute(
    `INSERT INTO support_ai_replies(id,conversation_id,thread_id,account_id,outcome,handoff_reason,guide_tour_id,model,requests,cost_nusd,latency_ms)
     VALUES($1,$2,$3,$4,$5,$6,$7,'claude-haiku-5-5',1,1000,1200)`,
    [randomUUID(), fields.conversationId ?? null, fields.threadId ?? null, fields.accountId ?? null, fields.outcome ?? 'answered', fields.reason ?? null, fields.guide ?? null],
  );

test('should register SQL022 as the ordinary support-assistant migration after the team templates, compatible from 20', async () => {
  const migrations = await loadDatabaseMigrations();
  assert.equal(DATABASE_SCHEMA_VERSION, 29);
  const summary = migrations.slice(19).map(migration => ({version: migration.version, name: migration.name, kind: migration.kind, compatibleFrom: migration.compatibleFrom}));
  assert.deepEqual(summary, [
    {version: 20, name: 'launch-deal', kind: 'ordinary', compatibleFrom: 20},
    {version: 21, name: 'design-team-templates', kind: 'ordinary', compatibleFrom: 20},
    {version: 22, name: 'support-assistant', kind: 'ordinary', compatibleFrom: 20},
    {version: 23, name: 'admin-analyst', kind: 'ordinary', compatibleFrom: 20},
    {version: 24, name: 'design-agent-credits', kind: 'ordinary', compatibleFrom: 20},
    {version: 25, name: 'mcp-server', kind: 'ordinary', compatibleFrom: 20},
    {version: 26, name: 'mcp-edits', kind: 'ordinary', compatibleFrom: 20},
    {version: 27, name: 'marketplaces', kind: 'ordinary', compatibleFrom: 20},
    {version: 28, name: 'design-team-billing', kind: 'ordinary', compatibleFrom: 20},
    {version: 29, name: 'design-paid-guest-editing', kind: 'ordinary', compatibleFrom: 20},
  ]);
  const migration = migrations[21]!;
  // Besides its own tables it only widens the chat: the assistant's author, its two columns and the thread's "typing".
  const changes = migration.statements.map(sql => sql.replace(/^--.*$/gm, '').trim()).filter(sql => /\b(DROP|ALTER)\b/i.test(sql));
  for (const sql of changes) assert.match(sql, /^ALTER TABLE public\.support_(messages|threads) (ADD|DROP) (CONSTRAINT support_messages_(author_check|assistant_only)|COLUMN (guide|kind|assistant_typing_until))\b/, sql);
  assert.equal(changes.length, 6);
  assert.deepEqual([...SUPPORT_AI_RECORD_TABLES, ...SUPPORT_AI_APPEND_TABLES, ...SUPPORT_AI_CONVERSATION_TABLES].sort(), [...SUPPORT_ASSISTANT_DROP_ORDER].sort());
  const sql = migration.statements.join('\n');
  for (const reason of SUPPORT_HANDOFF_REASONS) assert.ok(sql.includes(`'${reason}'`), `the reason ${reason} is allowed`);
  for (const topic of SUPPORT_TOPICS) assert.ok(sql.includes(`'${topic}'`), `the topic ${topic} is allowed`);
});

test('PostgreSQL SQL022: one running conversation per thread, an append-only transcript, the words go with the thread and the cost record stays', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const privileges = [
    ...SUPPORT_AI_CONVERSATION_TABLES.map(table => [table, {SELECT: true, INSERT: true, UPDATE: true, DELETE: true}] as const),
    ...SUPPORT_AI_APPEND_TABLES.map(table => [table, {SELECT: true, INSERT: true, UPDATE: false, DELETE: true}] as const),
    ...SUPPORT_AI_RECORD_TABLES.map(table => [table, {SELECT: true, INSERT: true, UPDATE: false, DELETE: false}] as const),
  ];
  for (const [table, expected] of privileges)
    for (const [privilege, granted] of Object.entries(expected))
      assert.equal(
        (await f.migration.one<{ok: boolean}>('SELECT has_table_privilege($1,$2,$3) AS ok', [f.isolated.roles.runtime, 'public.' + table, privilege]))!.ok,
        granted,
        `${table} ${privilege}`,
      );
  const person = await account(db);
  const threadId = await thread(db, person);
  const conversationId = await conversation(db, threadId, person);
  await assert.rejects(conversation(db, threadId, person), code('23505'), 'one running conversation per thread');
  await db.execute('UPDATE support_ai_conversations SET ended_at=clock_timestamp() WHERE id=$1', [conversationId]);
  const second = await conversation(db, threadId, person);
  await assert.rejects(db.execute("UPDATE support_ai_conversations SET mode='human' WHERE id=$1", [second]), code('23514'), 'a human conversation says why');
  await db.execute("UPDATE support_ai_conversations SET mode='human',mode_reason='refund',mode_at=clock_timestamp(),topic='billing' WHERE id=$1", [second]);
  await assert.rejects(db.execute("UPDATE support_ai_conversations SET topic='weather' WHERE id=$1", [second]), code('23514'));

  // The transcript: content kept as written (json, not jsonb), append-only for the runtime.
  const content = '[{"type":"text","text":"Hello","citations":null},{"type":"thinking","thinking":"","signature":"abc"}]';
  await db.execute("INSERT INTO support_ai_transcript(conversation_id,generation,seq,role,content) VALUES($1,1,1,'assistant',$2::json)", [second, content]);
  assert.equal((await f.migration.one<{text: string}>('SELECT content::text AS text FROM support_ai_transcript WHERE conversation_id=$1', [second]))!.text, content, 'byte for byte');
  await assert.rejects(db.execute("INSERT INTO support_ai_transcript(conversation_id,generation,seq,role,content) VALUES($1,1,1,'user','\"x\"')", [second]), code('23505'));
  await assert.rejects(db.execute("INSERT INTO support_ai_transcript(conversation_id,generation,seq,role,content) VALUES($1,1,2,'tool','\"x\"')", [second]), code('23514'));
  await assert.rejects(db.execute("UPDATE support_ai_transcript SET content='\"y\"' WHERE conversation_id=$1", [second]), code('42501'), 'the runtime may not edit it');

  await db.execute("INSERT INTO support_ai_handoffs(id,conversation_id,reason,summary) VALUES($1,$2,'refund','Wants a refund.')", [randomUUID(), second]);
  await assert.rejects(db.execute("INSERT INTO support_ai_handoffs(id,conversation_id,reason,summary) VALUES($1,$2,'weather','x')", [randomUUID(), second]), code('23514'));
  await reply(db, {conversationId: second, threadId, accountId: person, outcome: 'handoff', reason: 'refund', guide: 'share-link'});
  await assert.rejects(reply(db, {conversationId: second, outcome: 'handoff'}), code('23514'), 'a handoff names its reason');
  await assert.rejects(reply(db, {conversationId: second, guide: 'Share Link'}), code('23514'));
  await db.execute(
    `INSERT INTO support_ai_requests(id,conversation_id,kind,model,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,prompt_tokens,context_tokens,cost_nusd,latency_ms)
     VALUES($1,$2,'reply','claude-haiku-5-5',100,0,0,10,100,110,15000,900)`,
    [randomUUID(), second],
  );
  await assert.rejects(db.execute("UPDATE support_ai_replies SET cost_nusd=0"), code('42501'), 'the cost record is written once');
  await db.execute("INSERT INTO support_tour_events(id,tour_id,event,step,source) VALUES($1,'share-link','abandoned',2,'assistant')", [randomUUID()]);
  await assert.rejects(db.execute("INSERT INTO support_tour_events(id,tour_id,event,step,source) VALUES($1,'share-link','abandoned',NULL,'help')", [randomUUID()]), code('23514'), 'an abandoned tour says where');
  await assert.rejects(db.execute("INSERT INTO support_tour_events(id,tour_id,event,step,source) VALUES($1,'share-link','started',1,'help')", [randomUUID()]), code('23514'));

  // Erasure takes the thread, and with it the conversations, transcripts and handoffs; the replies and requests stay, unlinked.
  const {eraseSupportOf} = await import('../server/support/store');
  await db.transaction(tx => eraseSupportOf(tx, person));
  for (const table of ['support_ai_conversations', 'support_ai_transcript', 'support_ai_handoffs'])
    assert.equal((await f.migration.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table}`))!.n, 0, `${table} goes with the thread`);
  assert.deepEqual(await f.migration.one('SELECT conversation_id,thread_id,cost_nusd FROM support_ai_replies'), {conversation_id: null, thread_id: null, cost_nusd: 1000});
  assert.deepEqual(await f.migration.one('SELECT conversation_id,cost_nusd FROM support_ai_requests'), {conversation_id: null, cost_nusd: 15000});
  assert.equal((await f.migration.one<{n: number}>('SELECT count(*)::int AS n FROM support_tour_events'))!.n, 1, 'tour events name nobody');
});

test('PostgreSQL SQL022: the upgrade from 21 keeps the support chat, and is a no-op the second time', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const person = await account(db);
  await thread(db, person);
  await f.migration.transaction(tx => before22(tx, f.isolated.databaseName));
  assert.equal((await f.migration.one<{name: string | null}>("SELECT to_regclass('public.support_ai_conversations')::text AS name"))!.name, null);
  assert.equal((await f.migration.one<{n: number}>('SELECT max(version)::int AS n FROM postgres_migrations'))!.n, 21);
  const threads = await db.many('SELECT id,user_id FROM support_threads ORDER BY id');
  const second = createDatabase(loadDatabaseConfig('migration', f.env));
  t.after(() => second.close());
  const results = await Promise.all([f.migration, second].map(database => migrateDatabase(database, {mode: 'fresh', ...f.roles})));
  assert.deepEqual(results, [{ready: true, state: 'ready', version: 29}, {ready: true, state: 'ready', version: 29}]);
  assert.deepEqual(await db.many('SELECT id,user_id FROM support_threads ORDER BY id'), threads, 'the chat is untouched');
  const ledgerRows = await f.migration.many<{version: number; name: string}>('SELECT version,name FROM postgres_migrations ORDER BY version');
  assert.deepEqual(ledgerRows.slice(-11), [{version: 19, name: 'support'}, {version: 20, name: 'launch-deal'}, {version: 21, name: 'design-team-templates'}, {version: 22, name: 'support-assistant'}, {version: 23, name: 'admin-analyst'}, {version: 24, name: 'design-agent-credits'}, {version: 25, name: 'mcp-server'}, {version: 26, name: 'mcp-edits'}, {version: 27, name: 'marketplaces'}, {version: 28, name: 'design-team-billing'}, {version: 29, name: 'design-paid-guest-editing'}]);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  assert.deepEqual(await migrateDatabase(f.migration, {mode: 'fresh', ...f.roles}), {ready: true, state: 'ready', version: 29});
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'a second run is a no-op');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});

test('PostgreSQL SQL022: a retained conversation forbids the test inverse', {timeout: 180000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t),
    db = f.runtime;
  const person = await account(db);
  await conversation(db, await thread(db, person), person);
  const structure = await f.migration.transaction(databaseStructureFingerprint);
  await assert.rejects(f.migration.transaction(tx => before22(tx, f.isolated.databaseName)), /Retained support_ai_conversations forbid the inverse/);
  assert.equal(await f.migration.transaction(databaseStructureFingerprint), structure, 'nothing went');
  assert.deepEqual(await readDatabaseReadiness(db), {ready: true, state: 'ready', version: 29});
});
