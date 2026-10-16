-- The MCP server (docs/mcp-server.md): a person's own AI assistant (Claude, ChatGPT, Cursor) reads their design files through /mcp
-- after they allow it on the sign-in page. The OAuth 2.1 authorization server's rows,
-- read-only (one right, `read`), and the calls each account made in a day.
-- Secrets are never stored: every *_hash column holds the sha256 (hex) of the value (server/auth.ts digest), as sessions do.
-- Erasing an account deletes its grants (and with them their codes and tokens) and its counts (server/launch/lifecycle.ts).
--
-- Older releases keep working on it (schema/rollback.json): the tables are new and nothing older reads them.

-- A client: one that registered itself (RFC 7591; id `morfa_c_…`). Every client is public (PKCE, no secret). One that never obtained
-- a grant is forgotten after 30 days; one with a grant is kept.
CREATE TABLE public.oauth_clients (
  id text COLLATE "C" PRIMARY KEY CHECK(char_length(id) BETWEEN 8 AND 512),
  kind text COLLATE "C" NOT NULL CHECK(kind IN('dcr')),
  client_name text NOT NULL CHECK(char_length(client_name) BETWEEN 1 AND 80),
  -- JSON array of exact redirect addresses (loopback http ones are compared without the port).
  redirect_uris jsonb NOT NULL CHECK(jsonb_typeof(redirect_uris)='array' AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 20),
  -- What the client registered, only the fields the server uses (server/mcp/oauth/shared.ts readClientMetadata).
  metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  expires_at timestamptz
);
-- statement-breakpoint
CREATE INDEX oauth_clients_expires ON public.oauth_clients(expires_at) WHERE expires_at IS NOT NULL;
-- statement-breakpoint

-- One consent: a person allowed a client to read their files. "Disconnect" sets revoked_at and deletes its tokens.
CREATE TABLE public.oauth_grants (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id text COLLATE "C" NOT NULL REFERENCES public.oauth_clients(id) ON DELETE CASCADE,
  -- Copied at consent: the list stays readable whatever the client says about itself later.
  client_name text NOT NULL CHECK(char_length(client_name) BETWEEN 1 AND 80),
  scopes jsonb NOT NULL CHECK(jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes) BETWEEN 1 AND 1 AND scopes <@ '["read"]'::jsonb),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
-- statement-breakpoint
CREATE INDEX oauth_grants_user ON public.oauth_grants(user_id, created_at DESC);
-- statement-breakpoint
CREATE INDEX oauth_grants_client ON public.oauth_grants(client_id);
-- statement-breakpoint

-- One authorization request, from /oauth/authorize to the code exchange: created when the request is checked, bound to the browser
-- by a cookie (binding_hash), filled in at consent (user, grant, code), spent once at /oauth/token.
CREATE TABLE public.oauth_codes (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  client_id text COLLATE "C" NOT NULL REFERENCES public.oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text COLLATE "C" NOT NULL CHECK(char_length(redirect_uri) BETWEEN 8 AND 2048),
  -- What the client asked for ('read', 'offline_access'); the grant holds what the person allowed.
  requested_scopes jsonb NOT NULL CHECK(jsonb_typeof(requested_scopes)='array'),
  state text COLLATE "C" CHECK(state IS NULL OR char_length(state)<=1024),
  code_challenge text COLLATE "C" NOT NULL CHECK(code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource text COLLATE "C" NOT NULL CHECK(char_length(resource) BETWEEN 1 AND 512),
  binding_hash text COLLATE "C" NOT NULL CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
  user_id text COLLATE "C" REFERENCES public.users(id) ON DELETE CASCADE,
  grant_id text COLLATE "C" REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  code_hash text COLLATE "C" UNIQUE CHECK(code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  used_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX oauth_codes_client ON public.oauth_codes(client_id);
-- statement-breakpoint
CREATE INDEX oauth_codes_grant ON public.oauth_codes(grant_id) WHERE grant_id IS NOT NULL;
-- statement-breakpoint
CREATE INDEX oauth_codes_expires ON public.oauth_codes(expires_at);
-- statement-breakpoint

-- Opaque access (1 hour) and refresh (30 days, replaced on every use) tokens of a grant. A family is one chain of refreshes:
-- presenting an old refresh token again revokes the whole family.
CREATE TABLE public.oauth_tokens (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  grant_id text COLLATE "C" NOT NULL REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  kind text COLLATE "C" NOT NULL CHECK(kind IN('access','refresh')),
  token_hash text COLLATE "C" NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  family_id text COLLATE "C" NOT NULL CHECK(family_id ~ '^[0-9a-f-]{36}$'),
  -- The audience (RFC 8707): the /mcp address the token was issued for.
  resource text COLLATE "C" NOT NULL CHECK(char_length(resource) BETWEEN 1 AND 512),
  expires_at timestamptz NOT NULL,
  -- A refresh token: when it was exchanged for the next pair. An access token: NULL.
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX oauth_tokens_grant ON public.oauth_tokens(grant_id);
-- statement-breakpoint
CREATE INDEX oauth_tokens_family ON public.oauth_tokens(family_id);
-- statement-breakpoint
CREATE INDEX oauth_tokens_expires ON public.oauth_tokens(expires_at);
-- statement-breakpoint

-- Tool calls an account made in one UTC day, all its connections together (MCP_DAILY_CALLS). Rows older than a week are pruned.
CREATE TABLE public.mcp_daily_calls (
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  day date NOT NULL,
  calls integer NOT NULL CHECK(calls >= 0),
  PRIMARY KEY(user_id, day)
);
