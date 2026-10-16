import type {TransactionContext} from '../../server/postgresql/client';
import {removeMcpEditsForTest} from './postgresql-mcp-edits-inverse';

/** The tables SQL025 (the MCP server's sign-in and daily counts) adds, children first. */
export const MCP_SERVER_DROP_ORDER = ['oauth_tokens', 'oauth_codes', 'oauth_grants', 'oauth_clients', 'mcp_daily_calls'] as const;

/**
 * Test-only inverse of SQL025 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * tables go, the clients, consents, codes and tokens with them, and its ledger row. SQL026 goes first. A database without SQL025 is left alone, so every
 * older inverse can call it first (the SQL024 one does).
 */
export async function removeMcpServerForTest(tx: TransactionContext): Promise<boolean> {
  await removeMcpEditsForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.oauth_clients')::text AS name"))!.name === null) return false;
  for (const table of MCP_SERVER_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=25');
  return true;
}
