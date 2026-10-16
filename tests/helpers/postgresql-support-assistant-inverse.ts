import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeAdminAnalystForTest} from './postgresql-admin-analyst-inverse';

/** The tables SQL022 (the support chat's AI assistant) adds, dependants first. */
export const SUPPORT_ASSISTANT_DROP_ORDER = [
  'support_ai_requests',
  'support_ai_replies',
  'support_ai_handoffs',
  'support_ai_transcript',
  'support_ai_conversations',
  'support_tour_events',
] as const;

/**
 * Test-only inverse of SQL022 in a guarded temporary database (the caller holds the migration lock and checked the database name): the
 * tables go, the support chat's messages and threads lose the assistant's columns and author, and the ledger row goes. A database
 * without SQL022 is left alone, so every older inverse can call it first (the SQL021 inverse does). Refuses a retained conversation or
 * an assistant's message: people's conversations are not a test's to drop.
 */
export async function removeSupportAssistantForTest(tx: TransactionContext): Promise<boolean> {
  // SQL023 first: newer migrations go before older ones.
  await removeAdminAnalystForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.support_ai_conversations')::text AS name"))!.name === null) return false;
  assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.support_ai_conversations'))!.n, 0, 'Retained support_ai_conversations forbid the inverse');
  assert.equal((await tx.one<{n: number}>("SELECT count(*)::int AS n FROM public.support_messages WHERE author='assistant'"))!.n, 0, "Retained assistant's messages forbid the inverse");
  for (const table of SUPPORT_ASSISTANT_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('ALTER TABLE public.support_threads DROP COLUMN assistant_typing_until');
  await tx.execute('ALTER TABLE public.support_messages DROP CONSTRAINT support_messages_assistant_only');
  await tx.execute('ALTER TABLE public.support_messages DROP COLUMN kind');
  await tx.execute('ALTER TABLE public.support_messages DROP COLUMN guide');
  await tx.execute('ALTER TABLE public.support_messages DROP CONSTRAINT support_messages_author_check');
  await tx.execute("ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_author_check CHECK(author IN ('user','operator'))");
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=22');
  return true;
}
