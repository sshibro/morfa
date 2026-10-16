import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignTeamBillingForTest} from './postgresql-design-team-billing-inverse';

/** The tables SQL027 (the marketplace cards) adds, children first. */
export const MARKETPLACES_DROP_ORDER = [
  'marketplace_publications',
  'marketplace_tests',
  'marketplace_media',
  'marketplace_metrics',
  'marketplace_card_links',
  'marketplace_connections',
  'marketplace_brand_kits',
] as const;

/**
 * Test-only inverse of SQL027 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * tables go, with the links, tests, pictures, publications and numbers they hold, and its ledger row goes. SQL028 (and with it 029) goes
 * first. A database without SQL027 is left alone, so every older inverse can call it first (the SQL026 one does).
 */
export async function removeMarketplacesForTest(tx: TransactionContext): Promise<boolean> {
  await removeDesignTeamBillingForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.marketplace_connections')::text AS name"))!.name === null) return false;
  for (const table of MARKETPLACES_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=27');
  return true;
}
