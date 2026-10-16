-- The design tool: never spend more on a person than they paid (docs/design-tool.md §AI "Rails", §Billing "Refunds").
--
-- 1. design_ai_pauses: an action whose reported usage cost more than its price table's ceiling (a sign the table no longer covers the
--    model) is paused for everyone until the operator re-prices (a new price version) or clears the pause. The owner was charged no more
--    than the table. Rows are evidence: the runtime adds and clears them, never deletes.
-- 2. design_refunds: the operator's full refund of our own error (`our_error`, with the operator's short note) beside the refund of a
--    person's withdrawal (`owner_request`), which the server caps at the unused days less the AI already spent.
CREATE TABLE public.design_ai_pauses (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  action text COLLATE "C" NOT NULL CHECK(action IN('generate','edit','helper')),
  -- The priced variant, as design_ai_requests records it: low.square, high.portrait, large, ...
  tier text COLLATE "C" NOT NULL CHECK(tier ~ '^[a-z]{1,10}(\.[a-z]{1,10})?$'),
  -- The price table it was paused under: a new version (the operator re-priced) lifts it.
  price_version text COLLATE "C" NOT NULL CHECK(char_length(price_version) BETWEEN 1 AND 60),
  -- The request that showed it, its reported usage and the table's ceiling, in dollars of the provider's list price.
  request_id text COLLATE "C" NOT NULL CHECK(request_id ~ '^[0-9a-f-]{36}$'),
  usage_usd double precision NOT NULL CHECK(usage_usd>=0),
  ceiling_usd double precision NOT NULL CHECK(ceiling_usd>0),
  created_at text COLLATE "C" NOT NULL,
  -- The operator's clearing, when and who; both null while the pause holds.
  cleared_at text COLLATE "C",
  cleared_by text COLLATE "C" CHECK(cleared_by IS NULL OR char_length(cleared_by) BETWEEN 1 AND 180),
  CHECK(usage_usd>ceiling_usd),
  CHECK((cleared_at IS NULL)=(cleared_by IS NULL))
);
-- statement-breakpoint
-- One pause holds per action and price version.
CREATE UNIQUE INDEX design_ai_pauses_open ON public.design_ai_pauses(action,tier,price_version) WHERE cleared_at IS NULL;
-- statement-breakpoint
ALTER TABLE public.design_refunds DROP CONSTRAINT design_refunds_reason_check;
-- statement-breakpoint
-- `our_error`: the operator's refund of our own mistake (a duplicate charge, a plan or credits that could not be used), the whole payment allowed.
ALTER TABLE public.design_refunds ADD CONSTRAINT design_refunds_reason CHECK(reason IN('not_applied','owner_request','our_error','other'));
-- statement-breakpoint
-- What the operator wrote about our error: required for `our_error`.
ALTER TABLE public.design_refunds ADD COLUMN note text COLLATE "C" CHECK(note IS NULL OR char_length(note) BETWEEN 5 AND 300);
-- statement-breakpoint
ALTER TABLE public.design_refunds ADD CONSTRAINT design_refunds_our_error CHECK(reason<>'our_error' OR (source='operator' AND note IS NOT NULL));
