-- Team billing (owner, 2026-10-13; docs/design-tool.md §Teams "Billing, 2026-10-13"): a team that pays can add editor seats in the middle
-- of its period, paid for the rest of it, and every paid seat brings the team AI credits that its editors share.
--
-- Seats added to a running period are their own SKUs of the design ledger, `design_team_seats_month` and `design_team_seats_year`
-- (shared/design/billing.ts DESIGN_CATALOG): a checkout of a team's ledger key, never renewed by itself (the next renewal charges the
-- period's own SKU for every seat). Applied, such a payment says `seats`: it raised the seats of the period that runs, from the moment
-- it was paid (`period_start`) to that period's end (`period_end`), which is what its lawful refund reads. It never extended anything,
-- so every reader of `extended` (the paid period, the allowance, the launch deal) leaves it out.
--
-- A request of the design AI in a team's file may spend the team's credits: `wallet` names the team's ledger key it held from, null when
-- it held only the person's own (every request before this one).
--
-- Older releases keep working on it (schema/rollback.json): the new SKUs and outcome can only be written once team sales open
-- (DESIGN_TEAM_TERMS_APPROVED=design-team-v5, a consent no older release offers), and an older release leaves `wallet` empty.
ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_catalog;
-- statement-breakpoint
ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_catalog CHECK(CASE WHEN interval IS NULL
  THEN sku IN('design_ai_credits_200','design_ai_credits_600','design_ai_credits_2000')
  ELSE (interval='month' AND sku IN('design_pro_month','design_team_seats_month'))
    OR (interval='year' AND sku IN('design_pro_year','design_pro_year_launch','design_team_seats_year')) END);
-- statement-breakpoint
ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_outcome;
-- statement-breakpoint
ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_outcome CHECK(outcome IS NULL OR outcome IN('extended','refused','granted','seats'));
-- statement-breakpoint
ALTER TABLE public.design_payments DROP CONSTRAINT design_payments_period;
-- statement-breakpoint
ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_period CHECK(period_start IS NULL
  OR ((outcome IS NOT DISTINCT FROM 'extended' OR outcome IS NOT DISTINCT FROM 'seats') AND interval IS NOT NULL));
-- statement-breakpoint
-- Added seats are a team's, bought once on the payment page; only they say `seats`, and they never say `extended`.
ALTER TABLE public.design_payments ADD CONSTRAINT design_payments_seats CHECK(CASE WHEN sku LIKE 'design_team_seats_%'
  THEN kind='checkout' AND renewal='manual' AND user_id LIKE 'design-team:%' AND outcome IS DISTINCT FROM 'extended'
  ELSE outcome IS DISTINCT FROM 'seats' END);
-- statement-breakpoint
ALTER TABLE public.design_ai_requests ADD COLUMN wallet text COLLATE "C" CHECK(wallet IS NULL OR wallet ~ '^design-team:[0-9a-f-]{36}$');
