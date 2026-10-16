-- The Professional plan (docs/design-tool.md §Billing): the per-account subscription to the design tool, its payments and its refunds.
-- A ledger of its own. Payments and refunds are financial evidence and stay when the account
-- is erased (no foreign key to users); the subscription row goes with the account. The request sent to the provider (it holds the receipt's
-- e-mail) and a saved payment method are stored encrypted. Seats are one today; team plans priced per seat come later.
CREATE TABLE public.design_subscriptions (
  user_id text COLLATE "C" PRIMARY KEY CHECK(char_length(user_id) BETWEEN 1 AND 200),
  seats integer NOT NULL DEFAULT 1 CHECK(seats BETWEEN 1 AND 1000),
  state text COLLATE "C" NOT NULL CHECK(state IN('active','past_due','suspended','cancelled')),
  interval text COLLATE "C" NOT NULL CHECK(interval IN('month','year')),
  paid_until text COLLATE "C" NOT NULL,
  -- Pro still holds until here when the next period is not paid (paid_until + 7 days).
  grace_until text COLLATE "C" NOT NULL,
  -- The Moscow day of the month the paid chain began on: a month bought on the 31st ends on the last day of a shorter month and comes back to the 31st.
  anchor_day integer NOT NULL CHECK(anchor_day BETWEEN 1 AND 31),
  auto_renew integer NOT NULL DEFAULT 0 CHECK(auto_renew IN(0,1)),
  -- Kept after auto-renewal is switched off until the paid period ends, so it can be switched on again; never charged while auto_renew=0.
  encrypted_method text COLLATE "C",
  next_attempt text COLLATE "C",
  renewal_attempt integer NOT NULL DEFAULT 0 CHECK(renewal_attempt BETWEEN 0 AND 10),
  -- The terms and the price the owner accepted at the last checkout: an automatic charge needs both to be the current ones. Null for a gift.
  consent_version text COLLATE "C" CHECK(consent_version IS NULL OR char_length(consent_version) BETWEEN 1 AND 60),
  price_version text COLLATE "C" CHECK(price_version IS NULL OR char_length(price_version) BETWEEN 1 AND 60),
  -- What funded the period that runs: a payment, or an operator's gift.
  source text COLLATE "C" NOT NULL CHECK(source IN('payment','gift')),
  -- Changes with every new agreement (a checkout, auto-renewal switched off or on): a charge made under an older one never renews this one.
  generation text COLLATE "C" NOT NULL CHECK(generation ~ '^[0-9a-f-]{36}$'),
  created_at text COLLATE "C" NOT NULL,
  updated_at text COLLATE "C" NOT NULL,
  CHECK(auto_renew=0 OR (encrypted_method IS NOT NULL AND next_attempt IS NOT NULL)),
  CHECK(auto_renew=0 OR state IN('active','past_due'))
);
-- statement-breakpoint
-- What the minute pass looks for: periods that end, and charges that are due.
CREATE INDEX design_subscriptions_work ON public.design_subscriptions(paid_until) WHERE state IN('active','past_due');
-- statement-breakpoint
CREATE TABLE public.design_payments (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  user_id text COLLATE "C" NOT NULL CHECK(char_length(user_id) BETWEEN 1 AND 200),
  seats integer NOT NULL DEFAULT 1 CHECK(seats BETWEEN 1 AND 1000),
  -- `checkout`: the owner on the payment page; `renewal`: an automatic charge of the saved method.
  kind text COLLATE "C" NOT NULL CHECK(kind IN('checkout','renewal')),
  -- What was sold: a key of DESIGN_CATALOG (shared/design/billing.ts), the one list of what this ledger sells. Which SKUs exist and how each
  -- pairs with a period is design_payments_catalog below, named so a later kind of SKU (a one-off pack) replaces it without a new table.
  sku text COLLATE "C" NOT NULL CHECK(sku ~ '^design_[a-z0-9_]{1,60}$'),
  -- The period a subscription SKU pays for; null for an SKU that is not a subscription.
  interval text COLLATE "C" CHECK(interval IS NULL OR interval IN('month','year')),
  amount bigint NOT NULL CHECK(amount BETWEEN 100 AND 100000000),
  -- How it was sold: `auto` asked the provider to save the method for renewals, `manual` was paid once.
  renewal text COLLATE "C" NOT NULL CHECK(renewal IN('auto','manual')),
  terms_version text COLLATE "C" NOT NULL CHECK(char_length(terms_version) BETWEEN 1 AND 60),
  price_version text COLLATE "C" NOT NULL CHECK(char_length(price_version) BETWEEN 1 AND 60),
  generation text COLLATE "C" NOT NULL CHECK(generation ~ '^[0-9a-f-]{36}$'),
  -- checkout:<the client's idempotency key> or renewal:<paid_until>:<attempt>; a repeated request finds this row.
  intent text COLLATE "C" NOT NULL CHECK(char_length(intent) BETWEEN 1 AND 200),
  provider_id text COLLATE "C" UNIQUE CHECK(provider_id IS NULL OR provider_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  status text COLLATE "C" NOT NULL DEFAULT 'creating' CHECK(status IN('creating','needs_attention','pending','waiting_for_capture','succeeded','canceled')),
  -- 1 once the provider's answer was applied (money settled one way or the other). A succeeded row with applied=0 waits to be applied.
  applied integer NOT NULL DEFAULT 0 CHECK(applied IN(0,1)),
  -- What a succeeded payment did: extended the subscription, or could not be applied (its money goes back by itself). Checked by design_payments_outcome.
  outcome text COLLATE "C",
  period_start text COLLATE "C",
  period_end text COLLATE "C",
  confirmation_url text COLLATE "C" CHECK(confirmation_url IS NULL OR char_length(confirmation_url)<=4096),
  receipt_status text COLLATE "C" CHECK(receipt_status IS NULL OR receipt_status IN('pending','succeeded','canceled')),
  cancellation_reason text COLLATE "C" CHECK(cancellation_reason IS NULL OR cancellation_reason ~ '^[a-z0-9_]{1,64}$'),
  request text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" NOT NULL,
  paid_at text COLLATE "C",
  refunded_at text COLLATE "C",
  UNIQUE(user_id,intent),
  CONSTRAINT design_payments_catalog CHECK(interval IS NOT NULL AND ((interval='month' AND sku='design_pro_month') OR (interval='year' AND sku='design_pro_year'))),
  -- Only a subscription renews by itself.
  CONSTRAINT design_payments_renewal CHECK(kind='checkout' OR (renewal='auto' AND interval IS NOT NULL)),
  CONSTRAINT design_payments_outcome CHECK(outcome IS NULL OR outcome IN('extended','refused')),
  CHECK(outcome IS NULL OR (status='succeeded' AND applied=1)),
  CHECK(status<>'succeeded' OR paid_at IS NOT NULL),
  CHECK(refunded_at IS NULL OR status='succeeded'),
  CHECK((period_start IS NULL)=(period_end IS NULL)),
  CONSTRAINT design_payments_period CHECK(period_start IS NULL OR (outcome IS NOT DISTINCT FROM 'extended' AND interval IS NOT NULL))
);
-- statement-breakpoint
-- One unfinished payment per account: two checkouts at once make one payment, and a renewal never runs beside a checkout.
CREATE UNIQUE INDEX design_payments_open ON public.design_payments(user_id) WHERE applied=0;
-- statement-breakpoint
CREATE INDEX design_payments_user ON public.design_payments(user_id,created_at DESC);
-- statement-breakpoint
-- What the minute pass looks for: payments still to be sent or applied, and receipts still to be registered.
CREATE INDEX design_payments_work ON public.design_payments(created_at) WHERE applied=0 OR (status='succeeded' AND (receipt_status IS NULL OR receipt_status='pending'));
-- statement-breakpoint
-- Full refunds only. The id is the provider's idempotency key.
CREATE TABLE public.design_refunds (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  payment_id text COLLATE "C" NOT NULL REFERENCES public.design_payments(id),
  provider_id text COLLATE "C" UNIQUE CHECK(provider_id IS NULL OR provider_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  amount bigint NOT NULL CHECK(amount BETWEEN 100 AND 100000000),
  -- `not_applied`: the money arrived when it could not buy anything (queued by the server); `owner_request`: the operator's refund after a request in "Help"; `other`: anything else, a cabinet refund included.
  reason text COLLATE "C" NOT NULL CHECK(reason IN('not_applied','owner_request','other')),
  -- `auto`: queued by the server; `operator`: the admin's refund action; `cabinet`: made in the shop's cabinet and bound here.
  source text COLLATE "C" NOT NULL CHECK(source IN('auto','operator','cabinet')),
  -- What the refund does to the paid period once the money is back: `preserve` keeps it, `end_access` ends Pro at that moment.
  effect text COLLATE "C" NOT NULL CHECK(effect IN('preserve','end_access')),
  operator_id text COLLATE "C" CHECK(operator_id IS NULL OR char_length(operator_id) BETWEEN 1 AND 180),
  status text COLLATE "C" NOT NULL DEFAULT 'creating' CHECK(status IN('creating','needs_attention','pending','succeeded','canceled')),
  applied integer NOT NULL DEFAULT 0 CHECK(applied IN(0,1)),
  receipt_status text COLLATE "C" CHECK(receipt_status IS NULL OR receipt_status IN('pending','succeeded','canceled')),
  request text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" NOT NULL,
  CHECK((source='auto')=(reason='not_applied')),
  CHECK(source<>'auto' OR (operator_id IS NULL AND effect='preserve')),
  CHECK(source<>'operator' OR operator_id IS NOT NULL)
);
-- statement-breakpoint
-- At most one live refund per payment.
CREATE UNIQUE INDEX design_refunds_live ON public.design_refunds(payment_id) WHERE status<>'canceled';
-- statement-breakpoint
CREATE INDEX design_refunds_work ON public.design_refunds(created_at) WHERE applied=0 OR (status='succeeded' AND (receipt_status IS NULL OR receipt_status='pending'));
