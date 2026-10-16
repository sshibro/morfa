import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignBoardsForTest} from './postgresql-design-boards-inverse';

/** The table SQL038 ("Morfa Design": the saved changes of large files) adds. */
export const DESIGN_FILE_CHANGE_DROP_ORDER = ['design_file_changes'] as const;

/**
 * Test-only inverse of SQL038 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * empty table goes, and its ledger row (SQL039 and SQL040 first, newest first, when they are there). A database without SQL038 is left
 * alone, so every older inverse can call it first (the SQL037 inverse does). Refuses retained changes, like the other inverses.
 */
export async function removeDesignFileChangesForTest(tx: TransactionContext): Promise<boolean> {
  await removeDesignBoardsForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_file_changes')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_FILE_CHANGE_DROP_ORDER)
    assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.' + table))!.n, 0, 'Retained saved changes forbid the inverse: ' + table);
  for (const table of DESIGN_FILE_CHANGE_DROP_ORDER) await tx.execute('DROP TABLE public.' + table);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=9');
  return true;
}
