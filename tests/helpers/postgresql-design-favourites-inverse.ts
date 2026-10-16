import type {TransactionContext} from '../../server/postgresql/client';
import {removeSupportForTest} from './postgresql-support-inverse';

/** The tables SQL018 ("Favorites") adds. */
export const DESIGN_FAVOURITE_DROP_ORDER = ['design_favourite_files', 'design_favourite_projects'] as const;

/**
 * Test-only inverse of SQL018 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * tables go, stars and all (an account's stars are a convenience, not its work), and its ledger row. A database without SQL018 is
 * left alone, so every older inverse can call it first (the SQL017 inverse does).
 */
export async function removeDesignFavouritesForTest(tx: TransactionContext): Promise<boolean> {
  // A newer migration goes first.
  await removeSupportForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_favourite_files')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_FAVOURITE_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=18');
  return true;
}
