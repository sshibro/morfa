import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignFavouritesForTest} from './postgresql-design-favourites-inverse';

/** The tables SQL017 (proven addresses) adds. */
export const PROVEN_ADDRESS_DROP_ORDER = ['account_email_codes', 'sign_in_budget'] as const;

/**
 * Test-only inverse of SQL017 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * tables go, users.email is unique again, and its ledger row goes. A database without SQL017 is left alone, so every older inverse can
 * call it first (the SQL016 inverse does). Refuses a retained confirmation code, and two accounts with one address (the unique
 * constraint could not come back).
 */
export async function removeProvenAddressesForTest(tx: TransactionContext): Promise<boolean> {
  // A newer migration goes first.
  await removeDesignFavouritesForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.account_email_codes')::text AS name"))!.name === null) return false;
  assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.account_email_codes'))!.n, 0, 'Retained account_email_codes forbid the inverse');
  assert.equal(
    (await tx.one<{n: number}>('SELECT count(*)::int AS n FROM (SELECT email FROM public.users GROUP BY email HAVING count(*)>1) shared'))!.n,
    0,
    'Shared addresses forbid the inverse',
  );
  for (const table of PROVEN_ADDRESS_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DROP INDEX public.users_email_proven');
  await tx.execute('DROP INDEX public.users_email');
  await tx.execute('ALTER TABLE public.users ADD CONSTRAINT users_email_key UNIQUE(email)');
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=17');
  return true;
}
