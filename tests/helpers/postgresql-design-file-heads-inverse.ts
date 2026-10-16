import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeProvenAddressesForTest} from './postgresql-proven-addresses-inverse';

/** The tables SQL016 (the collab journal's version counter beside the file) adds. */
export const DESIGN_FILE_HEAD_DROP_ORDER = ['design_file_heads'] as const;

/**
 * Test-only inverse of SQL016 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * empty table goes, and its ledger row (SQL017's inverse first). A database without SQL016 is left alone, so every older inverse can call it first (the SQL015
 * inverse does). Refuses a retained head: its file's version would fall back to design_files.version.
 */
export async function removeDesignFileHeadsForTest(tx: TransactionContext): Promise<boolean> {
  // A newer migration goes first.
  await removeProvenAddressesForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_file_heads')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_FILE_HEAD_DROP_ORDER)
    assert.equal((await tx.one<{n: number}>(`SELECT count(*)::int AS n FROM public.${table}`))!.n, 0, `Retained ${table} forbid the inverse`);
  for (const table of DESIGN_FILE_HEAD_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=16');
  return true;
}
