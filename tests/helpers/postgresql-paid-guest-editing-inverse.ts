import type {TransactionContext} from '../../server/postgresql/client';

/**
 * Test-only inverse of SQL029 in a guarded temporary database (the caller holds the migration lock and checked the database name): the
 * guests' free days go with their column, and its ledger row goes. A database without SQL029 is left alone, so every older inverse can
 * call it first (the SQL028 one does).
 */
export async function removePaidGuestEditingForTest(tx: TransactionContext): Promise<boolean> {
  const column = await tx.one<{present: boolean}>(
    `SELECT EXISTS(SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='design_file_members' AND column_name='free_edit_until') AS present`,
  );
  if (!column!.present) return false;
  await tx.execute('ALTER TABLE public.design_file_members DROP COLUMN free_edit_until');
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=29');
  return true;
}
