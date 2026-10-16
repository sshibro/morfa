-- The MCP server's editing (docs/mcp-server.md §Editing): a person may allow their assistant to change files too (the `write`
-- right, offered while ENABLE_MCP_EDITS=1), and every change an assistant made is kept with its way back, so the assistant can undo
-- its own edits: the editor's ⌘Z holds only the person's own steps, as it does for a teammate's.
--
-- Older releases keep working on it (schema/rollback.json): the grants' check only widens (a release that knows only `read` ignores
-- the other word), and nothing older reads the new table.

-- A grant allows reading, or reading and changing files.
ALTER TABLE public.oauth_grants DROP CONSTRAINT oauth_grants_scopes_check;
-- statement-breakpoint
ALTER TABLE public.oauth_grants ADD CONSTRAINT oauth_grants_scopes_check
  CHECK(jsonb_typeof(scopes)='array' AND scopes IN('["read"]'::jsonb, '["read","write"]'::jsonb));
-- statement-breakpoint

-- One change an assistant stored in a file (one tool call): what it changed (`patch`, the entries as stored) and what they were
-- before (`inverse`), the version it made, and when the assistant took it back. The newest 50 of a connection in a file are kept,
-- none older than 30 days (server/mcp/edits.ts). Gone with the connection (and so with the account) and with the file.
CREATE TABLE public.mcp_edits (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  grant_id text COLLATE "C" NOT NULL REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
  version integer NOT NULL CHECK(version > 0),
  patch jsonb NOT NULL CHECK(jsonb_typeof(patch)='object'),
  inverse jsonb NOT NULL CHECK(jsonb_typeof(inverse)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  undone_at timestamptz
);
-- statement-breakpoint
CREATE INDEX mcp_edits_grant_file ON public.mcp_edits(grant_id, file_id, created_at DESC);
-- statement-breakpoint
CREATE INDEX mcp_edits_file ON public.mcp_edits(file_id);
-- statement-breakpoint
CREATE INDEX mcp_edits_created ON public.mcp_edits(created_at);
-- statement-breakpoint

-- A picture an assistant sends from the person's computer (server/mcp/uploads.ts): `morfa_upload_image` makes a slot for one file
-- and returns an address holding a secret (stored only as sha256); the picture sent there is stored as the file's design picture,
-- and `morfa_place_image` puts it on the canvas. A slot takes one picture within ten minutes. Gone with the connection and the file.
CREATE TABLE public.mcp_uploads (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  secret_hash text COLLATE "C" NOT NULL UNIQUE CHECK(secret_hash ~ '^[0-9a-f]{64}$'),
  grant_id text COLLATE "C" NOT NULL REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  picture jsonb CHECK(picture IS NULL OR jsonb_typeof(picture)='object'),
  received_at timestamptz,
  CHECK((picture IS NULL) = (received_at IS NULL))
);
-- statement-breakpoint
CREATE INDEX mcp_uploads_grant ON public.mcp_uploads(grant_id);
-- statement-breakpoint
CREATE INDEX mcp_uploads_file ON public.mcp_uploads(file_id);
-- statement-breakpoint
CREATE INDEX mcp_uploads_expires ON public.mcp_uploads(expires_at);
