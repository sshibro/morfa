import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignTeamTemplatesForTest} from './postgresql-design-team-templates-inverse';

/** The tables SQL020 (the launch deal) adds. */
export const LAUNCH_DEAL_DROP_ORDER = ['design_offer_intros'] as const;

/**
 * Test-only inverse of SQL020 in a guarded temporary database (the caller holds the migration lock and checked the database name): the
 * offers' table goes, design_payments gets SQL004's catalogue back without the deal's checks and index, and the ledger row goes. A
 * database without SQL020 is left alone, so every older inverse can call it first (the SQL019 inverse does once the support chat is
 * merged; until then the SQL018 one). Refuses a payment of the deal's SKU: the old catalogue could not come back.
 */
export async function removeLaunchDealForTest(tx: TransactionContext): Promise<boolean> {
  // SQL021 first: newer migrations go before older ones.
  await removeDesignTeamTemplatesForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_offer_intros')::text AS name"))!.name === null) return false;
  assert.equal(
    (await tx.one<{n: number}>("SELECT count(*)::int AS n FROM public.design_payments WHERE sku='design_pro_year_launch'"))!.n,
    0,
    'A payment of the launch deal forbids the inverse',
  );
  for (const table of LAUNCH_DEAL_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DROP INDEX public.design_payments_launch_once');
  await tx.execute('ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_launch');
  await tx.execute('ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_catalog');
  await tx.execute(`ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_catalog CHECK(CASE WHEN interval IS NULL
  THEN sku IN('design_ai_credits_200','design_ai_credits_600','design_ai_credits_2000')
  ELSE (interval='month' AND sku='design_pro_month') OR (interval='year' AND sku='design_pro_year') END)`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=20');
  return true;
}
