import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeLaunchDealForTest} from './postgresql-launch-deal-inverse';

/** The tables SQL019 (the support chat) adds, messages first. */
export const SUPPORT_DROP_ORDER = ['support_messages', 'support_threads', 'support_operator_presence'] as const;

/**
 * Test-only inverse of SQL019 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * tables go, and its ledger row. A database without SQL019 is left alone, so every older inverse can call it first (the SQL018 inverse
 * does); a newer migration goes first (SQL020, the launch deal). Refuses a retained conversation: people's messages are not a test's to drop.
 */
export async function removeSupportForTest(tx: TransactionContext): Promise<boolean> {
  await removeLaunchDealForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.support_threads')::text AS name"))!.name === null) return false;
  assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.support_threads'))!.n, 0, 'Retained support_threads forbid the inverse');
  for (const table of SUPPORT_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=19');
  return true;
}
