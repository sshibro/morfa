-- "Agent" in AI credits: each leg of an agent turn is a request of the
-- design AI's ledger like a picture or a helper call: action 'agent', tier 'leg', its hold and real charge in design_ai_ledger. A leg
-- whose usage is still under a whole credit is recorded 'released' (nothing charged; the turn charges it later), with its cost.
--
-- Older releases keep working on it (schema/rollback.json: compatible from 20): they never write 'agent', and read such rows only
-- in sums (daily caps, the month's spend) and the admin's lists.
ALTER TABLE public.design_ai_requests DROP CONSTRAINT design_ai_requests_action_check;
-- statement-breakpoint
ALTER TABLE public.design_ai_requests ADD CONSTRAINT design_ai_requests_action_check CHECK(action IN('generate','edit','helper','agent'));
-- statement-breakpoint
ALTER TABLE public.design_ai_pauses DROP CONSTRAINT design_ai_pauses_action_check;
-- statement-breakpoint
ALTER TABLE public.design_ai_pauses ADD CONSTRAINT design_ai_pauses_action_check CHECK(action IN('generate','edit','helper','agent'));
