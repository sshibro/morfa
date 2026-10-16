-- The support chat (shared/support.ts, server/support): one conversation per account with Morfa's operators. The person writes
-- from the app, an operator answers from the console; both sides poll. Messages are plain text and personal data: the thread and
-- its messages go with the account on erasure (server/launch/lifecycle.ts) and are in its data export. An operator's reply names
-- the operator's account (operator_id), whose name the person sees; an erased operator's row is anonymised, never deleted, so the
-- reply keeps it. The person is told the truth about who answers: when an operator last used the console (presence), whether one is
-- typing, and how long answers usually take (computed from the messages, never configured).
--
-- Older releases keep working on it (schema/rollback.json: compatible from 17): the tables are new and nothing else reads them.
CREATE TABLE public.support_threads (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  user_id text COLLATE "C" NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  -- open: the conversation runs; closed: an operator closed it, and the person's next message opens it again.
  status text COLLATE "C" NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The last message or change of status: the inbox's "newest first".
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- When each side last read the conversation (NULL: never): the other side's messages after it are its unread ones, and the
  -- "read" mark under one's own.
  user_read_at timestamptz,
  operator_read_at timestamptz,
  -- The person's first message after the operator's last answer (NULL once an operator answers): the inbox's "awaiting reply" and
  -- how long. Kept through a close; the inbox reads it only while the conversation is open.
  waiting_since timestamptz,
  -- The last letter that told the operators about this conversation (SUPPORT_NOTIFY_EMAIL): at most one per quarter of an hour.
  notified_at timestamptz,
  -- An operator is typing an answer until then (the console says so every few seconds while they type), and who; an answer clears it.
  operator_typing_until timestamptz,
  operator_typing_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  -- The last letter that told the person about an answer they had not seen: at most one an hour, and only for newer answers.
  user_notified_at timestamptz,
  CHECK(updated_at >= created_at),
  CHECK(operator_typing_by IS NULL OR operator_typing_until IS NOT NULL)
);
-- statement-breakpoint
-- The inbox: the conversations waiting for an answer, longest first; the open or closed ones and all of them, newest first.
CREATE INDEX support_threads_waiting ON public.support_threads(waiting_since) WHERE status='open' AND waiting_since IS NOT NULL;
-- statement-breakpoint
CREATE INDEX support_threads_status ON public.support_threads(status,updated_at DESC);
-- statement-breakpoint
CREATE INDEX support_threads_updated ON public.support_threads(updated_at DESC);
-- statement-breakpoint
CREATE INDEX support_threads_typing_by ON public.support_threads(operator_typing_by) WHERE operator_typing_by IS NOT NULL;
-- statement-breakpoint
-- The messages, either side's. `client_id` is the sender's key for one message (a retry of the same send is the same message);
-- `context` is where the person wrote from ({fileId, where}), never on an operator's message. Plain text, trimmed, never HTML.
CREATE TABLE public.support_messages (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  thread_id text COLLATE "C" NOT NULL REFERENCES public.support_threads(id) ON DELETE CASCADE,
  author text COLLATE "C" NOT NULL CHECK(author IN ('user','operator')),
  operator_id text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  -- shared/support.ts SUPPORT_MESSAGE_MAX.
  body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 4000),
  client_id text COLLATE "C" NOT NULL CHECK(client_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  context jsonb CHECK(context IS NULL OR (jsonb_typeof(context)='object' AND octet_length(context::text) <= 512)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(thread_id,author,client_id),
  CHECK(author='operator' OR operator_id IS NULL),
  CHECK(author='user' OR context IS NULL)
);
-- statement-breakpoint
-- A conversation in order, its last message, and each side's unread ones.
CREATE INDEX support_messages_thread ON public.support_messages(thread_id,created_at);
-- statement-breakpoint
CREATE INDEX support_messages_operator ON public.support_messages(operator_id) WHERE operator_id IS NOT NULL;
-- statement-breakpoint
-- When each operator last used the console's support routes (written at most every half minute): "Online" for the person while it
-- is recent. One row per operator, gone with the account.
CREATE TABLE public.support_operator_presence (
  user_id text COLLATE "C" PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
