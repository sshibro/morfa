import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignMeetingsForTest} from './postgresql-design-meetings-inverse';

/**
 * Test-only inverse of SQL039 ("Board": the kind of a design file) in a guarded temporary database (the caller holds the migration lock
 * and checked the database name): design_files loses its kind column and the ledger row goes (SQL040, the meetings, first when it is
 * there). A database without SQL039 is left alone, so every older inverse can call it first (the SQL038 inverse does). Refuses retained
 * boards, like the other inverses refuse retained data.
 */
export async function removeDesignBoardsForTest(tx: TransactionContext): Promise<boolean> {
  await removeDesignMeetingsForTest(tx);
  const column = await tx.one("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='design_files' AND column_name='kind'");
  if (!column) return false;
  assert.equal(await tx.one("SELECT 1 FROM public.design_files WHERE kind<>'design' LIMIT 1"), undefined, 'Retained boards forbid the inverse');
  await tx.execute('ALTER TABLE public.design_files DROP COLUMN kind');
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=10');
  return true;
}
