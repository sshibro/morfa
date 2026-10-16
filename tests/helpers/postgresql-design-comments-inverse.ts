import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';

/** The tables SQL035 ("Morfa Design" comments) adds, in drop order (referencing tables first). */
export const DESIGN_COMMENT_DROP_ORDER = ['design_comment_reads', 'design_comment_mentions', 'design_comments', 'design_comment_threads'] as const;

/**
 * Test-only inverse of SQL035 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * empty tables go. A database without SQL035 is left alone, so every older inverse can call it first (the SQL034 inverse does). Refuses
 * retained comments, like the other inverses.
 */
export async function removeDesignCommentsForTest(tx: TransactionContext): Promise<boolean> {
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_comment_threads')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_COMMENT_DROP_ORDER)
    assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.' + table))!.n, 0, 'Retained comments forbid the inverse: ' + table);
  for (const table of DESIGN_COMMENT_DROP_ORDER) await tx.execute('DROP TABLE public.' + table);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=6');
  return true;
}
