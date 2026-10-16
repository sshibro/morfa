-- Morfa's own accounts (server/auth.ts): the account rows, their sessions and the external sign-ins, plus the few account-wide
-- tables the design tool's server code reads and writes beside them. The design tables (002–011) reference users(id).
-- Timestamps in this file are text 'YYYY-MM-DD HH24:MI:SS' UTC, the shape the design code reads; sessions keep epoch milliseconds.
--
-- An account. Sign-in providers are an open owner decision: until one is chosen the only way in is the local development sign-in
-- (MORFA_DEV_LOGIN=1, refused in production). `password` holds a scrypt hash once password sign-in is chosen, '' for none.
-- Erasure anonymises the row (name, e-mail, password) and stamps erasure_completed_at; the row itself stays, so evidence rows
-- that name the account id keep pointing at something.
CREATE TABLE public.users (
  id text COLLATE "C" PRIMARY KEY CHECK(char_length(id) BETWEEN 1 AND 200),
  email text COLLATE "C" NOT NULL UNIQUE CHECK(char_length(email) BETWEEN 3 AND 320),
  name text COLLATE "C" NOT NULL CHECK(char_length(name) <= 200),
  password text COLLATE "C" NOT NULL DEFAULT '',
  -- 1 once the address was proven to belong to the person (a provider that verified it, or a confirmation link).
  email_verified bigint NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
  created_at text COLLATE "C" NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- The person asked to close the account: every session is refused from then on, and the next maintenance pass erases it.
  deletion_requested_at text COLLATE "C",
  erasure_completed_at text COLLATE "C",
  CHECK(erasure_completed_at IS NULL OR deletion_requested_at IS NOT NULL)
);
-- statement-breakpoint
CREATE INDEX users_closing ON public.users(id) WHERE deletion_requested_at IS NOT NULL AND erasure_completed_at IS NULL;
-- statement-breakpoint
-- A signed-in browser. Only the SHA-256 of the cookie's token is stored; `expires` is epoch milliseconds.
CREATE TABLE public.sessions (
  token text COLLATE "C" PRIMARY KEY CHECK(token ~ '^[0-9a-f]{64}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires bigint NOT NULL CHECK(expires BETWEEN 0 AND 9007199254740991),
  created_at text COLLATE "C" NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
-- statement-breakpoint
CREATE INDEX sessions_user ON public.sessions(user_id);
-- statement-breakpoint
CREATE INDEX sessions_expires ON public.sessions(expires);
-- statement-breakpoint
-- An external sign-in bound to an account (provider + the provider's subject id). No provider is chosen yet; the design code reads
-- this table for 'google', 'yandex' and 'vk' (a provider-verified person: the AI trial and the payer check).
CREATE TABLE public.identities (
  provider text COLLATE "C" NOT NULL CHECK(provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  subject text COLLATE "C" NOT NULL CHECK(char_length(subject) BETWEEN 1 AND 255),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at text COLLATE "C" NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  PRIMARY KEY(provider,subject)
);
-- statement-breakpoint
CREATE INDEX identities_user ON public.identities(user_id);
-- statement-breakpoint
-- An account's own uploaded pictures outside design files (DATA_DIR/uploads/<filename>, served to the owner only). The design
-- code accepts such a picture in a document when its row is the account's and ready=1. Nothing in Morfa writes these rows yet;
-- the table keeps those reads valid and goes with the account.
CREATE TABLE public.uploads (
  filename text COLLATE "C" PRIMARY KEY CHECK(filename ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  ready bigint NOT NULL DEFAULT 1 CHECK(ready IN (0,1)),
  bytes bigint CHECK(bytes IS NULL OR bytes BETWEEN 0 AND 9007199254740991),
  created_at text COLLATE "C" NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
-- statement-breakpoint
CREATE INDEX uploads_user ON public.uploads(user_id);
-- statement-breakpoint
-- The operations audit the billing writes (design-billing/audit.ts): what was done for which account and how it ended. Evidence:
-- the runtime adds rows and never changes them; no foreign key, so a row outlives the erasure of its account.
CREATE TABLE public.launch_audit (
  id text COLLATE "C" PRIMARY KEY,
  user_id text COLLATE "C",
  project_id text COLLATE "C",
  action text COLLATE "C" NOT NULL,
  result text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
-- statement-breakpoint
CREATE INDEX launch_audit_action ON public.launch_audit(action,created_at);
-- statement-breakpoint
-- Erased accounts, by id, so a restore from an older backup can erase them again before it serves anyone.
CREATE TABLE public.erasure_ledger (
  id text COLLATE "C" PRIMARY KEY,
  kind text COLLATE "C" NOT NULL CHECK(kind IN ('account')),
  erased_at text COLLATE "C" NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
-- statement-breakpoint
-- The activity journal (server/admin/telemetry.ts): one row per recorded request of a signed-in account, its route with ids and
-- bearer tokens masked. Capped; goes with the account.
CREATE TABLE public.admin_activity (
  id text COLLATE "C" PRIMARY KEY,
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  action text COLLATE "C" NOT NULL CHECK(char_length(action) <= 200),
  created_at text COLLATE "C" NOT NULL
);
-- statement-breakpoint
CREATE INDEX admin_activity_user ON public.admin_activity(user_id,created_at);
-- statement-breakpoint
-- The operator's cost settings (the design AI reads `usdRub`, the dollar rate; with no row the AI prices at its worst-case rate).
-- Set by the operator with the migration role until Morfa has an admin; the runtime only reads it.
CREATE TABLE public.admin_cost_settings (
  version bigint PRIMARY KEY CHECK(version BETWEEN 1 AND 9007199254740991),
  effective_at text COLLATE "C" NOT NULL,
  settings text COLLATE "C" NOT NULL
);
