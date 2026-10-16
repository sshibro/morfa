import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignFileHeadsForTest} from './postgresql-design-file-heads-inverse';

/** The tables SQL015 (sharing one file) adds, dependants first. */
export const DESIGN_FILE_SHARE_DROP_ORDER = ['design_file_invites', 'design_file_members'] as const;

/**
 * Test-only inverse of SQL015 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * empty tables and the files' link column go, and its ledger row. A database without SQL015 is left alone, so every older inverse can call
 * it first (the SQL014 inverse does). SQL016's inverse runs first. Refuses retained guests, invites or a file shared by its link.
 */
export async function removeDesignFileSharingForTest(tx: TransactionContext): Promise<boolean> {
  await removeDesignFileHeadsForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_file_members')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_FILE_SHARE_DROP_ORDER)
    assert.equal((await tx.one<{n: number}>(`SELECT count(*)::int AS n FROM public.${table}`))!.n, 0, `Retained ${table} forbid the inverse`);
  assert.equal((await tx.one<{n: number}>("SELECT count(*)::int AS n FROM public.design_files WHERE link_access<>'none'"))!.n, 0, 'Files shared by link forbid the inverse');
  for (const table of DESIGN_FILE_SHARE_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('ALTER TABLE public.design_files DROP COLUMN link_access');
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=15');
  return true;
}
