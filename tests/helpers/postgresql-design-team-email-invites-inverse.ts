import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignFileSharingForTest} from './postgresql-design-file-sharing-inverse';

/**
 * Test-only inverse of SQL014 (invites by e-mail, docs/design-tool.md §Teams) in a guarded temporary database (the caller holds the
 * migration lock and checked the database name): its index, constraint and column go, and its ledger row (SQL015's first, when it is
 * there). A database without SQL014 is left alone, so every older inverse can call it first (the SQL013 inverse does). Refuses invites
 * that name an address.
 */
export async function removeDesignTeamEmailInvitesForTest(tx: TransactionContext): Promise<boolean> {
  await removeDesignFileSharingForTest(tx);
  const present = await tx.one<{n: number}>(
    "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='design_team_invites' AND column_name='email'",
  );
  if (!present!.n) return false;
  const retained = (await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.design_team_invites WHERE email IS NOT NULL'))!.n;
  assert.equal(retained, 0, 'Retained e-mail invites forbid the inverse');
  await tx.execute('DROP INDEX public.design_team_invites_email');
  await tx.execute('ALTER TABLE public.design_team_invites DROP CONSTRAINT design_team_invites_email_once, DROP COLUMN email');
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=14');
  return true;
}
