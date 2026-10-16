-- The operator console's AI analyst (shared/admin-analyst.ts, server/admin/analyst): its readings of a period, the operators'
-- conversations with it, and what every request to the model cost. Nothing here is anyone's personal data but the operator's own
-- questions: the model is given aggregates and opaque handles only, and a handle's account is kept beside the reading that named it
-- (an account id, never a name or an address), so the console can show who it is.
--
-- 023: after main's 021 (team templates) and 022 (the support assistant).
-- Older releases keep working on it (schema/rollback.json: compatible from 20): the tables are new and nothing else reads them.
--
-- A reading of a period (POST /api/admin/insights): answered again for six hours, then made anew; kept a month.
CREATE TABLE public.admin_analyst_insights (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  period text COLLATE "C" NOT NULL CHECK(period IN ('7d','30d','90d','365d')),
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  model text COLLATE "C" NOT NULL CHECK(model ~ '^[a-z0-9][a-z0-9.-]{0,79}$'),
  -- The insights as the model wrote them (handles, never names), and which account each handle is ({"acct_1a2b3c4d": "<account id>"}).
  insights jsonb NOT NULL CHECK(jsonb_typeof(insights)='array'),
  handles jsonb NOT NULL CHECK(jsonb_typeof(handles)='object'),
  cost_nano_usd bigint NOT NULL CHECK(cost_nano_usd>=0),
  operator_id text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL
);
-- statement-breakpoint
CREATE INDEX admin_analyst_insights_period ON public.admin_analyst_insights(period,generated_at DESC);
-- statement-breakpoint
-- An operator's conversation (POST /api/admin/ask). Append-only: its messages are written once, in order, exactly as the model was
-- sent them and answered (thinking blocks included), and never changed; a conversation whose next request would pass the size cap
-- goes on in a new one that starts from a short summary (`continues`).
CREATE TABLE public.admin_analyst_conversations (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operator_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  model text COLLATE "C" NOT NULL CHECK(model ~ '^[a-z0-9][a-z0-9.-]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Questions answered, and the tokens the last request sent the model (the cap reads it).
  turns integer NOT NULL DEFAULT 0 CHECK(turns>=0),
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK(prompt_tokens>=0),
  -- Which account each handle the conversation has seen is.
  handles jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(handles)='object'),
  continues text COLLATE "C" REFERENCES public.admin_analyst_conversations(id) ON DELETE SET NULL,
  CHECK(updated_at >= created_at)
);
-- statement-breakpoint
CREATE INDEX admin_analyst_conversations_operator ON public.admin_analyst_conversations(operator_id,updated_at DESC);
-- statement-breakpoint
CREATE INDEX admin_analyst_conversations_continues ON public.admin_analyst_conversations(continues) WHERE continues IS NOT NULL;
-- statement-breakpoint
-- `content`: the message's content blocks as the API takes them. `turn`: the question it belongs to (1, 2, …).
CREATE TABLE public.admin_analyst_messages (
  conversation_id text COLLATE "C" NOT NULL REFERENCES public.admin_analyst_conversations(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK(seq>=0),
  turn integer NOT NULL CHECK(turn>=1),
  role text COLLATE "C" NOT NULL CHECK(role IN ('user','assistant')),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(conversation_id,seq)
);
-- statement-breakpoint
-- Every request to the model and what it cost (nano-dollars: 10⁻⁹ USD), whatever came of it: the month's spend against
-- ADMIN_AI_MONTHLY_BUDGET_USD is read from here, so the budget holds across processes. Evidence: added, never changed.
CREATE TABLE public.admin_analyst_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  operator_id text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  kind text COLLATE "C" NOT NULL CHECK(kind IN ('insights','ask')),
  model text COLLATE "C" NOT NULL CHECK(model ~ '^[a-z0-9][a-z0-9.-]{0,79}$'),
  outcome text COLLATE "C" NOT NULL CHECK(outcome IN ('ok','error','refused','truncated')),
  input_tokens integer NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  cache_read_tokens integer NOT NULL DEFAULT 0 CHECK(cache_read_tokens>=0),
  cache_write_tokens integer NOT NULL DEFAULT 0 CHECK(cache_write_tokens>=0),
  cost_nano_usd bigint NOT NULL CHECK(cost_nano_usd>=0),
  -- The conversation a question's request belonged to; no reference, so the cost stays when the conversation goes.
  conversation_id text COLLATE "C"
);
-- statement-breakpoint
CREATE INDEX admin_analyst_usage_at ON public.admin_analyst_usage(at);
