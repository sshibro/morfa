import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignAgentCreditsForTest} from './postgresql-design-agent-credits-inverse';

/** The tables SQL023 (the operator console's AI analyst) adds, in the order they can be dropped (messages before their conversations). */
export const ADMIN_ANALYST_DROP_ORDER = [
  'admin_analyst_messages',
  'admin_analyst_conversations',
  'admin_analyst_insights',
  'admin_analyst_usage',
] as const;
/** The migration's version. */
export const ADMIN_ANALYST_VERSION = 23;

/**
 * Test-only inverse of SQL023 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * tables go, and its ledger row. A database without SQL023 is left alone, so every older inverse can call it first (the SQL022 one does).
 * Nothing in these tables is a person's: the readings hold handles, the usage rows numbers, the conversations an operator's questions.
 */
export async function removeAdminAnalystForTest(tx: TransactionContext): Promise<boolean> {
  // SQL024 first: newer migrations go before older ones.
  await removeDesignAgentCreditsForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.admin_analyst_usage')::text AS name"))!.name === null) return false;
  for (const table of ADMIN_ANALYST_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=$1', [ADMIN_ANALYST_VERSION]);
  return true;
}
