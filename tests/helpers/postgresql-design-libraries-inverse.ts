import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';

/** The tables SQL036 ("Morfa Design" shared libraries) adds, in drop order (referencing tables first). */
export const DESIGN_LIBRARY_DROP_ORDER = ['design_library_pictures', 'design_library_subscriptions', 'design_library_versions', 'design_libraries'] as const;

/**
 * Test-only inverse of SQL036 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * empty tables go and its ledger row with them. A database without SQL036 is left alone, so every older inverse can call it first.
 * Refuses retained library data, like the other inverses.
 */
export async function removeDesignLibrariesForTest(tx: TransactionContext): Promise<boolean> {
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_libraries')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_LIBRARY_DROP_ORDER)
    assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.' + table))!.n, 0, 'Retained library data forbids the inverse: ' + table);
  for (const table of DESIGN_LIBRARY_DROP_ORDER) await tx.execute('DROP TABLE public.' + table);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=7');
  return true;
}
