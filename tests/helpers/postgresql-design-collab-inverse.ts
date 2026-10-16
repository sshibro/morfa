import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignBigFilesForTest} from './postgresql-design-big-files-inverse';

/** What SQL012 (the collab journal, lease and checkpoints, docs/BACKEND.md §3) adds, in the order the inverse takes it away. */
export const DESIGN_COLLAB_COLUMNS = {
  design_file_changes: ['client_id', 'client_seq', 'user_id', 'fence', 'op'],
  design_files: ['collab_node', 'lease_until', 'fence', 'checkpoint_key', 'checkpoint_version', 'checkpoint_format'],
  design_images: ['content_hash', 'storage_key'],
} as const;

/**
 * Test-only inverse of SQL012 in a guarded temporary database (the caller holds the migration lock and checked the database name):
 * its trigger, function, indexes, constraints and columns go, `patch` is required again, and its ledger row. A database without
 * SQL012 is left alone, so every older inverse can call it first (the SQL011 inverse does). Refuses what only SQL012 can hold:
 * journal rows in the binary codec or written under a lease, files with a lease or a checkpoint, content-addressed pictures.
 */
export async function removeDesignCollabForTest(tx: TransactionContext): Promise<boolean> {
  await removeDesignBigFilesForTest(tx);
  const present = await tx.one<{n: number}>(
    "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='design_file_changes' AND column_name='op'",
  );
  if (!present!.n) return false;
  const retained = async (sql: string) => (await tx.one<{n: number}>(sql))!.n;
  assert.equal(await retained('SELECT count(*)::int AS n FROM public.design_file_changes WHERE op IS NOT NULL OR fence IS NOT NULL OR client_id IS NOT NULL OR user_id IS NOT NULL'), 0, 'Retained collab journal rows forbid the inverse');
  assert.equal(await retained('SELECT count(*)::int AS n FROM public.design_files WHERE collab_node IS NOT NULL OR fence<>0 OR checkpoint_key IS NOT NULL'), 0, 'Retained leases or checkpoints forbid the inverse');
  assert.equal(await retained('SELECT count(*)::int AS n FROM public.design_images WHERE content_hash IS NOT NULL'), 0, 'Retained content-addressed pictures forbid the inverse');
  await tx.execute('DROP TRIGGER design_file_changes_fence ON public.design_file_changes');
  await tx.execute('DROP FUNCTION public.design_file_changes_fence()');
  await tx.execute('DROP INDEX public.design_file_changes_client');
  await tx.execute('DROP INDEX public.design_files_collab_node');
  await tx.execute('DROP INDEX public.design_images_content_hash');
  await tx.execute('ALTER TABLE public.design_file_changes DROP CONSTRAINT design_file_changes_one_body, DROP CONSTRAINT design_file_changes_client');
  await tx.execute('ALTER TABLE public.design_files DROP CONSTRAINT design_files_lease, DROP CONSTRAINT design_files_checkpoint, DROP CONSTRAINT design_files_checkpoint_version');
  await tx.execute('ALTER TABLE public.design_images DROP CONSTRAINT design_images_content');
  for (const [table, columns] of Object.entries(DESIGN_COLLAB_COLUMNS))
    await tx.execute(`ALTER TABLE public.${table} ${columns.map(column => `DROP COLUMN ${column}`).join(', ')}`);
  await tx.execute('ALTER TABLE public.design_file_changes ALTER COLUMN patch SET NOT NULL');
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=12');
  return true;
}
