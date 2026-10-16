import type {TransactionContext} from '../../server/postgresql/client';
import {removeMarketplacesForTest} from './postgresql-marketplaces-inverse';

/** The tables SQL026 (the MCP server's edits) adds. */
export const MCP_EDITS_DROP_ORDER = ['mcp_uploads', 'mcp_edits'] as const;

/**
 * Test-only inverse of SQL026 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * table goes, the grants that allow changing files with it, the grants' check is SQL025's again, and its ledger row goes. SQL027 goes
 * first. A database without SQL026 is left alone, so every older inverse can call it first (the SQL025 inverse does).
 */
export async function removeMcpEditsForTest(tx: TransactionContext): Promise<boolean> {
  await removeMarketplacesForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.mcp_edits')::text AS name"))!.name === null) return false;
  for (const table of MCP_EDITS_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute(`DELETE FROM public.oauth_grants WHERE scopes <> '["read"]'::jsonb`);
  await tx.execute('ALTER TABLE public.oauth_grants DROP CONSTRAINT oauth_grants_scopes_check');
  await tx.execute(
    `ALTER TABLE public.oauth_grants ADD CONSTRAINT oauth_grants_scopes_check
       CHECK(jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes) BETWEEN 1 AND 1 AND scopes <@ '["read"]'::jsonb)`,
  );
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=26');
  return true;
}
