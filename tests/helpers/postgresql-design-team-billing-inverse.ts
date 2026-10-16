import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removePaidGuestEditingForTest} from './postgresql-paid-guest-editing-inverse';

/**
 * Test-only inverse of SQL028 in a guarded temporary database (the caller holds the migration lock and checked the database name):
 * SQL029 goes first; then design_payments gets SQL020's catalogue, SQL004's outcomes and SQL003's period back without the seats' check,
 * the AI requests lose their `wallet`, and the ledger row goes. A database without SQL028 is left alone, so every older inverse can call
 * it first (the SQL027 one does). Refuses a payment of added seats: the old catalogue could not come back.
 */
export async function removeDesignTeamBillingForTest(tx: TransactionContext): Promise<boolean> {
  // SQL029 first: newer migrations go before older ones.
  await removePaidGuestEditingForTest(tx);
  const column = await tx.one<{present: boolean}>(
    `SELECT EXISTS(SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='design_ai_requests' AND column_name='wallet') AS present`,
  );
  if (!column!.present) return false;
  assert.equal(
    (await tx.one<{n: number}>("SELECT count(*)::int AS n FROM public.design_payments WHERE sku LIKE 'design_team_seats_%'"))!.n,
    0,
    'A payment of added seats forbids the inverse',
  );
  await tx.execute('ALTER TABLE public.design_ai_requests DROP COLUMN wallet');
  await tx.execute('ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_seats');
  await tx.execute('ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_period');
  await tx.execute(`ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_period CHECK(period_start IS NULL
  OR (outcome IS NOT DISTINCT FROM 'extended' AND interval IS NOT NULL))`);
  await tx.execute('ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_outcome');
  await tx.execute("ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_outcome CHECK(outcome IS NULL OR outcome IN('extended','refused','granted'))");
  await tx.execute('ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_catalog');
  await tx.execute(`ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_catalog CHECK(CASE WHEN interval IS NULL
  THEN sku IN('design_ai_credits_200','design_ai_credits_600','design_ai_credits_2000')
  ELSE (interval='month' AND sku='design_pro_month') OR (interval='year' AND sku IN('design_pro_year','design_pro_year_launch')) END)`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=28');
  return true;
}
