import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignFileChangesForTest} from './postgresql-design-file-changes-inverse';

/** The table SQL037 ("Morfa Design" AI pauses and the refund of our error) adds. */
export const DESIGN_AI_PAUSE_DROP_ORDER = ['design_ai_pauses'] as const;

/**
 * Test-only inverse of SQL037 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * empty pause table goes, design_refunds loses the note and gets SQL032's reason check back, and its ledger row goes (SQL038–040 first,
 * newest first, when they are there). A database without SQL037 is left alone, so every older inverse can call it first. Refuses retained
 * pauses or refunds of our error, like the other inverses.
 */
export async function removeDesignAiPausesForTest(tx: TransactionContext): Promise<boolean> {
  // The newer migrations on the design tables go first: SQL040 (meetings), SQL039 (the kind of a file), SQL038 (saved changes).
  await removeDesignFileChangesForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_ai_pauses')::text AS name"))!.name === null) return false;
  assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.design_ai_pauses'))!.n, 0, 'Retained pauses forbid the inverse');
  assert.equal(
    await tx.one("SELECT 1 FROM public.design_refunds WHERE reason='our_error' OR note IS NOT NULL LIMIT 1"),
    undefined,
    'Retained refunds of our error forbid the inverse',
  );
  await tx.execute('DROP TABLE public.design_ai_pauses');
  await tx.execute('ALTER TABLE public.design_refunds DROP CONSTRAINT design_refunds_our_error');
  await tx.execute('ALTER TABLE public.design_refunds DROP COLUMN note');
  await tx.execute('ALTER TABLE public.design_refunds DROP CONSTRAINT design_refunds_reason');
  await tx.execute("ALTER TABLE public.design_refunds ADD CONSTRAINT design_refunds_reason_check CHECK(reason IN('not_applied','owner_request','other'))");
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=8');
  return true;
}
