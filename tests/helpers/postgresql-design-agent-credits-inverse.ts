import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeMcpServerForTest} from './postgresql-mcp-server-inverse';

/** The migration's version: "Agent" in the AI credits' ledger (024-design-agent-credits.sql). */
export const DESIGN_AGENT_CREDITS_VERSION = 24;

/**
 * Test-only inverse of SQL024 in a guarded temporary database (the caller holds the migration lock and checked the database name): the
 * design AI's requests and pauses take only 'generate', 'edit' and 'helper' again, and the ledger row goes. A database without SQL024 is
 * left alone, so every older inverse can call it first (the SQL023 one does). Refuses a retained agent request or pause: they are a
 * person's charges, not a test's to drop.
 */
export async function removeDesignAgentCreditsForTest(tx: TransactionContext): Promise<boolean> {
  // SQL025 first: newer migrations go before older ones.
  await removeMcpServerForTest(tx);
  if (!(await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.postgres_migrations WHERE version=$1', [DESIGN_AGENT_CREDITS_VERSION]))!.n) return false;
  assert.equal((await tx.one<{n: number}>("SELECT count(*)::int AS n FROM public.design_ai_requests WHERE action='agent'"))!.n, 0, "Retained agent requests forbid the inverse");
  assert.equal((await tx.one<{n: number}>("SELECT count(*)::int AS n FROM public.design_ai_pauses WHERE action='agent'"))!.n, 0, "Retained agent pauses forbid the inverse");
  await tx.execute('ALTER TABLE public.design_ai_requests DROP CONSTRAINT design_ai_requests_action_check');
  await tx.execute("ALTER TABLE public.design_ai_requests ADD CONSTRAINT design_ai_requests_action_check CHECK(action IN('generate','edit','helper'))");
  await tx.execute('ALTER TABLE public.design_ai_pauses DROP CONSTRAINT design_ai_pauses_action_check');
  await tx.execute("ALTER TABLE public.design_ai_pauses ADD CONSTRAINT design_ai_pauses_action_check CHECK(action IN('generate','edit','helper'))");
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=$1', [DESIGN_AGENT_CREDITS_VERSION]);
  return true;
}
