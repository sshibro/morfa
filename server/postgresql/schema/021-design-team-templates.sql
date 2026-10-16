-- Custom team templates and the voting sessions' history (help.figma.com "Create custom templates in FigJam"
-- and "Run voting sessions in FigJam").
--
-- A team's board published as a template: the template row (its name, description, scope and newest version) and its versions,
-- each a snapshot of the board's first page's top-level objects built by the server from the stored document
-- (server/design/templates.ts). Both belong to the board: erasing it (and so its team or the account that holds it) takes them.
-- Who published a version is forgotten with their account.
--
-- A meeting's vote gains a prompt and the "hide cursors" flag, and an ended session is kept in design_meeting_sessions with its
-- ballots (design_meeting_votes, keyed by vote) until an editor deletes it or 20 newer ones push it out
-- (server/design/meeting/service.ts). Erasing an account deletes its ballots there too, as before.
--
-- Older releases keep working on it (schema/rollback.json): the tables are new, the columns have defaults, and an older release
-- that starts a vote deletes the file's ballots as it always did (the history then shows those sessions without votes).
CREATE TABLE public.design_templates (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  file_id text COLLATE "C" NOT NULL UNIQUE REFERENCES public.design_files(id) ON DELETE CASCADE,
  -- The team it was published in: listed there (and, with scope 'organization', in the other teams of the same owner) while the
  -- board is in that team and outside the trash.
  team_id text COLLATE "C" NOT NULL REFERENCES public.design_teams(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK(char_length(description) <= 300),
  scope text COLLATE "C" NOT NULL CHECK(scope IN('team','organization')),
  version integer NOT NULL CHECK(version > 0),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL
);
-- statement-breakpoint
CREATE INDEX design_templates_team ON public.design_templates(team_id);
-- statement-breakpoint
CREATE INDEX design_templates_published_by ON public.design_templates(published_by) WHERE published_by IS NOT NULL;
-- statement-breakpoint
CREATE TABLE public.design_template_versions (
  template_id text COLLATE "C" NOT NULL REFERENCES public.design_templates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK(version > 0),
  -- The board's version it was built from.
  file_version bigint NOT NULL CHECK(file_version > 0),
  -- {nodes, roots, images}: the first page's top-level objects with everything under them, and the picture table entries they use.
  snapshot text NOT NULL,
  bytes integer NOT NULL CHECK(bytes BETWEEN 0 AND 5242880),
  -- The pictures it points at (without `/uploads/`): kept while a version uses them (server/design/files.ts eraseFileWithin).
  image_files text[] NOT NULL DEFAULT '{}' CHECK(cardinality(image_files)<=10000),
  published_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(template_id,version)
);
-- statement-breakpoint
CREATE INDEX design_template_versions_published_by ON public.design_template_versions(published_by) WHERE published_by IS NOT NULL;
-- statement-breakpoint
ALTER TABLE public.design_meetings
  ADD COLUMN vote_prompt text CHECK(char_length(vote_prompt) <= 120),
  ADD COLUMN vote_hide_cursors boolean NOT NULL DEFAULT false;
-- statement-breakpoint
-- An ended voting session of a file's meeting; its ballots stay in design_meeting_votes under its vote id.
CREATE TABLE public.design_meeting_sessions (
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_meetings(file_id) ON DELETE CASCADE,
  vote_id text COLLATE "C" NOT NULL CHECK(vote_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  prompt text CHECK(char_length(prompt) <= 120),
  per_person smallint NOT NULL CHECK(per_person BETWEEN 1 AND 20),
  started_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  PRIMARY KEY(file_id,vote_id)
);
-- statement-breakpoint
CREATE INDEX design_meeting_sessions_recent ON public.design_meeting_sessions(file_id,ended_at DESC);
-- statement-breakpoint
CREATE INDEX design_meeting_sessions_started_by ON public.design_meeting_sessions(started_by) WHERE started_by IS NOT NULL;
