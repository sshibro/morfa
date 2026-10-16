-- Which e-mail addresses are proven (docs/authentication.md "Addresses"; owner, 2026-10-10). An address is proven when the
-- provider that signed the person in hosts it (Yandex's own mailbox of the account's login), or when its owner entered the code
-- Morfa sent to it; users.email_verified is then 1. Before this, users.email was unique for every account, so the first person
-- to sign in with an address a provider did not prove owned it in Morfa and locked out its real owner. Now an address is unique
-- among proven ones only: an unproven one is the account's contact address and blocks nobody, and a proven claim of it wins.
--
-- Older releases do not run on it (schema/rollback.json: compatible from 17): their first sign-in names ON CONFLICT(email),
-- which needs the unique constraint dropped here. Accounts made earlier keep working in them, a new account cannot be made.
ALTER TABLE public.users DROP CONSTRAINT users_email_key;
-- statement-breakpoint
CREATE UNIQUE INDEX users_email_proven ON public.users(email) WHERE email_verified=1;
-- statement-breakpoint
-- The lookups by address (an invite's address, an account's) the dropped constraint's index served.
CREATE INDEX users_email ON public.users(email);
-- statement-breakpoint
-- "Verify e-mail": the code sent to the account's address, one at a time per account. Only the SHA-256 of the code is kept;
-- `email` is the address it was sent to (a code proves that one, not an address changed since). Times are epoch milliseconds.
-- `sends` counts the letters since `sends_since` (the hourly budget); `attempts` the wrong codes entered for this one. The row
-- goes when the code is used, and with the account on erasure.
CREATE TABLE public.account_email_codes (
  user_id text COLLATE "C" PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  email text COLLATE "C" NOT NULL CHECK(char_length(email) BETWEEN 3 AND 320),
  code_hash text COLLATE "C" NOT NULL CHECK(code_hash ~ '^[0-9a-f]{64}$'),
  expires bigint NOT NULL CHECK(expires BETWEEN 1 AND 9007199254740991),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  sends integer NOT NULL CHECK(sends >= 1),
  sends_since bigint NOT NULL CHECK(sends_since BETWEEN 1 AND 9007199254740991),
  last_sent bigint NOT NULL CHECK(last_sent BETWEEN 1 AND 9007199254740991)
);
-- statement-breakpoint
-- The sign-in routes' one budget per client address (server/sign-in/budget.ts), shared by every api process: steps counted since
-- the window began, and when it ends (epoch milliseconds). A row whose window ended is reused or deleted.
CREATE TABLE public.sign_in_budget (
  key text COLLATE "C" PRIMARY KEY CHECK(char_length(key) BETWEEN 1 AND 200),
  hits integer NOT NULL CHECK(hits >= 0),
  reset_at bigint NOT NULL CHECK(reset_at BETWEEN 1 AND 9007199254740991)
);
-- statement-breakpoint
CREATE INDEX sign_in_budget_reset ON public.sign_in_budget(reset_at);
