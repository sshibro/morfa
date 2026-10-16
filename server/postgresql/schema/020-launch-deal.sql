-- The launch deal (owner, 2026-10-10; docs/design-tool.md §Billing "Launch deal, 2026-10-10"): the first year of the Professional plan
-- at half the yearly price, once per account, until DESIGN_LAUNCH_DEAL_UNTIL. It is its own SKU of the design ledger,
-- `design_pro_year_launch` (shared/design/billing.ts DESIGN_CATALOG): a year like `design_pro_year`, at the deal's amount, so every
-- rule that reads the payment's SKU and amount (the provider's answer checked against the row, the lawful refund of the paid days,
-- the AI allowance of a paid period) works on what was actually paid. The renewal a year later is the regular `design_pro_year`.
--
-- Numbered 020: 019 is the support chat's (another lane), merged before this one.
-- Older releases do not run on it (schema/rollback.json: compatible from 20): an older billing summary cannot read a payment of an
-- SKU it does not know, so an account that bought the deal would lose its plan card there.
ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_catalog;
-- statement-breakpoint
ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_catalog CHECK(CASE WHEN interval IS NULL
  THEN sku IN('design_ai_credits_200','design_ai_credits_600','design_ai_credits_2000')
  ELSE (interval='month' AND sku='design_pro_month') OR (interval='year' AND sku IN('design_pro_year','design_pro_year_launch')) END);
-- statement-breakpoint
-- The deal is an account's own first year: bought on the payment page (never charged by itself: a renewal is the regular year), one
-- seat, never a team's ledger key.
ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_launch CHECK(sku<>'design_pro_year_launch'
  OR (kind='checkout' AND seats=1 AND user_id NOT LIKE 'design-team:%'));
-- statement-breakpoint
-- Once per account: at most one deal payment that is paid or still open. A page that expired or was declined (status `canceled`)
-- frees the account to try again; a paid one never does, a refunded one included.
CREATE UNIQUE INDEX design_payments_launch_once ON public.design_payments(user_id)
  WHERE sku='design_pro_year_launch' AND (status='succeeded' OR applied=0);
-- statement-breakpoint
-- The offers an account was introduced to (the deal's one-time card, shared/design/launch-deal.ts LAUNCH_DEAL_OFFER): shown once per
-- account on any device, never again. A convenience of the account: in its data export, gone with it on erasure
-- (server/design-billing/erasure.ts).
CREATE TABLE public.design_offer_intros (
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  offer text COLLATE "C" NOT NULL CHECK(offer ~ '^[a-z0-9-]{1,40}$'),
  shown_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,offer)
);
