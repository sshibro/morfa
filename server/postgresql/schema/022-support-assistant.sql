-- The support chat's AI assistant (server/support/assistant, shared/support-assistant.ts): Claude answers a person's support
-- conversation in plain Russian, offers guided tours of the app (shared/support-tours.ts) and hands the conversation to the
-- operator when it needs one. Its rows: the AI's conversations (one runs per support thread at a time; the operator's close ends it),
-- the API transcript of each (append-only: content blocks as the API returned them, compaction and thinking blocks included), every
-- reply and every request with its tokens and cost (the operator console's AI support analytics), every handoff with its reason and
-- the operator's summary, and the guided tours' events. A conversation, its transcript and its handoffs are personal data and go
-- with the support thread (and so with the account on erasure); replies, requests and tour events hold no words of anyone and stay
-- as the cost record, their thread and conversation set to NULL. Tour events name no account at all.
--
-- Older releases keep working on it (schema/rollback.json: compatible from 20): the tables are new, and the support chat's new
-- columns have defaults its older code never reads; it shows an assistant's message as an answer from support.
CREATE TABLE public.support_ai_conversations (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  thread_id text COLLATE "C" NOT NULL REFERENCES public.support_threads(id) ON DELETE CASCADE,
  account_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- ai: the assistant answers; human: it handed off (or the operator wrote) and stays quiet until the conversation ends.
  mode text COLLATE "C" NOT NULL DEFAULT 'ai' CHECK(mode IN ('ai','human')),
  -- Why it is human: a handoff reason (shared/support-assistant.ts SUPPORT_HANDOFF_REASONS) or 'operator' (the operator wrote).
  mode_reason text COLLATE "C" CHECK(mode_reason IN ('refund','billing','bug','account','legal','unsure','person_asked','refusal','limit','budget','api_error','operator')),
  mode_at timestamptz,
  -- What it was about (shared/support-assistant.ts SUPPORT_TOPICS), classified once after its first AI exchange.
  topic text COLLATE "C" CHECK(topic IN ('sharing','export','plans_limits','billing','ai_credits','components','auto_layout','prototype','teams','files_trash','versions','bug','account','other')),
  -- The transcript's generation: a forced compaction (the token guard) starts a fresh one seeded with a summary of the last.
  generation integer NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 1000),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The last reply the assistant gave in it (the console's "AI-resolved": no person's message 24 hours after it).
  last_reply_at timestamptz,
  -- The operator closed the thread: the person's next message starts a new conversation.
  ended_at timestamptz,
  CHECK((mode = 'human') = (mode_reason IS NOT NULL AND mode_at IS NOT NULL)),
  CHECK(ended_at IS NULL OR ended_at >= started_at)
);
-- statement-breakpoint
-- One running conversation per thread; the console's windows by start.
CREATE UNIQUE INDEX support_ai_conversations_running ON public.support_ai_conversations(thread_id) WHERE ended_at IS NULL;
-- statement-breakpoint
CREATE INDEX support_ai_conversations_started ON public.support_ai_conversations(started_at);
-- statement-breakpoint
CREATE INDEX support_ai_conversations_account ON public.support_ai_conversations(account_id);
-- statement-breakpoint
-- The API transcript, append-only (the runtime may not UPDATE it): each message as it was sent or received, `content` byte for byte
-- as the API returned it (json, not jsonb: key order and text kept). `seq` counts from 1 within a generation.
CREATE TABLE public.support_ai_transcript (
  conversation_id text COLLATE "C" NOT NULL REFERENCES public.support_ai_conversations(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK(generation BETWEEN 1 AND 1000),
  seq integer NOT NULL CHECK(seq BETWEEN 1 AND 100000),
  role text COLLATE "C" NOT NULL CHECK(role IN ('user','assistant','system')),
  content json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(conversation_id, generation, seq)
);
-- statement-breakpoint
-- Every reply the assistant made (or tried to): the operator console's AI support analytics. Its tokens are the sums of its requests;
-- `max_prompt_tokens` the largest prompt one of them carried (the 100K guard's evidence); `cost_nusd` billionths of a dollar.
CREATE TABLE public.support_ai_replies (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  conversation_id text COLLATE "C" REFERENCES public.support_ai_conversations(id) ON DELETE SET NULL,
  thread_id text COLLATE "C" REFERENCES public.support_threads(id) ON DELETE SET NULL,
  account_id text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  -- answered: the assistant wrote to the person; handoff: the conversation went to the operator (with or without words of its own).
  outcome text COLLATE "C" NOT NULL CHECK(outcome IN ('answered','handoff')),
  handoff_reason text COLLATE "C" CHECK(handoff_reason IN ('refund','billing','bug','account','legal','unsure','person_asked','refusal','limit','budget','api_error')),
  -- The tour the reply offered with its "Show me where to click" button (shared/support-tours.ts).
  guide_tour_id text COLLATE "C" CHECK(guide_tour_id ~ '^[a-z0-9-]{1,40}$'),
  model text COLLATE "C" CHECK(char_length(model) BETWEEN 1 AND 100),
  requests integer NOT NULL DEFAULT 0 CHECK(requests >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK(cache_read_tokens >= 0),
  cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK(cache_write_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  max_prompt_tokens integer NOT NULL DEFAULT 0 CHECK(max_prompt_tokens >= 0),
  cost_nusd bigint NOT NULL DEFAULT 0 CHECK(cost_nusd >= 0),
  stop_reason text COLLATE "C" CHECK(char_length(stop_reason) BETWEEN 1 AND 40),
  compacted boolean NOT NULL DEFAULT false,
  latency_ms integer NOT NULL CHECK(latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((outcome = 'handoff') = (handoff_reason IS NOT NULL))
);
-- statement-breakpoint
CREATE INDEX support_ai_replies_created ON public.support_ai_replies(created_at);
-- statement-breakpoint
-- The account's replies in the last 24 hours (its daily limit).
CREATE INDEX support_ai_replies_account ON public.support_ai_replies(account_id, created_at) WHERE account_id IS NOT NULL;
-- statement-breakpoint
CREATE INDEX support_ai_replies_conversation ON public.support_ai_replies(conversation_id) WHERE conversation_id IS NOT NULL;
-- statement-breakpoint
-- Every request to the model: a reply's turns (`reply`), the topic's classification (`topic`), a summary for a fresh transcript or
-- for the operator (`summary`). The month's cost (SUPPORT_AI_MONTHLY_BUDGET_USD) is their sum. `prompt_tokens` is the largest prompt
-- one of its iterations read (compaction's included).
CREATE TABLE public.support_ai_requests (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  reply_id text COLLATE "C" REFERENCES public.support_ai_replies(id) ON DELETE SET NULL,
  conversation_id text COLLATE "C" REFERENCES public.support_ai_conversations(id) ON DELETE SET NULL,
  kind text COLLATE "C" NOT NULL CHECK(kind IN ('reply','topic','summary')),
  model text COLLATE "C" NOT NULL CHECK(char_length(model) BETWEEN 1 AND 100),
  input_tokens integer NOT NULL CHECK(input_tokens >= 0),
  cache_read_tokens integer NOT NULL CHECK(cache_read_tokens >= 0),
  cache_write_tokens integer NOT NULL CHECK(cache_write_tokens >= 0),
  output_tokens integer NOT NULL CHECK(output_tokens >= 0),
  prompt_tokens integer NOT NULL CHECK(prompt_tokens >= 0),
  -- What the conversation holds after this request (its last pass's prompt and output): the next request starts from at least this.
  context_tokens integer NOT NULL CHECK(context_tokens >= 0),
  compacted boolean NOT NULL DEFAULT false,
  cost_nusd bigint NOT NULL CHECK(cost_nusd >= 0),
  stop_reason text COLLATE "C" CHECK(char_length(stop_reason) BETWEEN 1 AND 40),
  latency_ms integer NOT NULL CHECK(latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX support_ai_requests_created ON public.support_ai_requests(created_at);
-- statement-breakpoint
CREATE INDEX support_ai_requests_reply ON public.support_ai_requests(reply_id) WHERE reply_id IS NOT NULL;
-- statement-breakpoint
-- Every handoff to the operator: its reason and the 2–4 lines the operator reads first.
CREATE TABLE public.support_ai_handoffs (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  conversation_id text COLLATE "C" NOT NULL REFERENCES public.support_ai_conversations(id) ON DELETE CASCADE,
  reason text COLLATE "C" NOT NULL CHECK(reason IN ('refund','billing','bug','account','legal','unsure','person_asked','refusal','limit','budget','api_error')),
  summary text NOT NULL CHECK(char_length(summary) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX support_ai_handoffs_conversation ON public.support_ai_handoffs(conversation_id);
-- statement-breakpoint
CREATE INDEX support_ai_handoffs_created ON public.support_ai_handoffs(created_at);
-- statement-breakpoint
-- What the guided tours did in the app (POST /api/support/tour-events), whoever started them: no account, only the tour, the event,
-- the step and who started it.
CREATE TABLE public.support_tour_events (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  tour_id text COLLATE "C" NOT NULL CHECK(tour_id ~ '^[a-z0-9-]{1,40}$'),
  event text COLLATE "C" NOT NULL CHECK(event IN ('started','completed','abandoned','target_missing')),
  step integer CHECK(step BETWEEN 1 AND 50),
  source text COLLATE "C" NOT NULL CHECK(source IN ('assistant','help','other')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((event IN ('abandoned','target_missing')) = (step IS NOT NULL))
);
-- statement-breakpoint
CREATE INDEX support_tour_events_created ON public.support_tour_events(created_at);
-- statement-breakpoint
-- The assistant writes in the chat itself: its messages are support messages of the author 'assistant' (no operator, no context).
-- `guide` is the guided tour its message offers ({tourId, label}: shared/support-tours.ts), `kind` 'handoff' marks the note that the
-- conversation went to the operator ("Passed your question to an operator…"); both only on the assistant's messages.
ALTER TABLE public.support_messages DROP CONSTRAINT support_messages_author_check;
-- statement-breakpoint
ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_author_check CHECK(author IN ('user','operator','assistant'));
-- statement-breakpoint
ALTER TABLE public.support_messages ADD COLUMN guide jsonb CHECK(guide IS NULL OR (jsonb_typeof(guide)='object' AND octet_length(guide::text) <= 256));
-- statement-breakpoint
ALTER TABLE public.support_messages ADD COLUMN kind text COLLATE "C" NOT NULL DEFAULT 'message' CHECK(kind IN ('message','handoff'));
-- statement-breakpoint
ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_assistant_only CHECK(author='assistant' OR (guide IS NULL AND kind='message'));
-- statement-breakpoint
-- The assistant is writing an answer until then (the person's panel says "Assistant is typing…"); its answer or handoff clears it, and
-- a reply that never came (a process gone) is handed to the operator by the worker once it passes.
ALTER TABLE public.support_threads ADD COLUMN assistant_typing_until timestamptz;
