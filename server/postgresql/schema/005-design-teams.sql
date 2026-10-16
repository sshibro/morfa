-- Design teams, step 1 (docs/design-tool.md §Teams): team workspaces, their members and roles, invite links and projects
-- (folders of files). A team file is a design_files row with team_id set;
-- its user_id is the team's owner (the account that holds the team's files, pictures and versions), moved with ownership. Who may do
-- what is decided in one place, server/design/file-access.ts. The rows go with the owner account (ON DELETE CASCADE), so an older release
-- keeps working on these tables; the erasure of an account deletes the teams it owns and its memberships explicitly, files first.
CREATE TABLE public.design_teams (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
  -- The one owner (also a design_team_members row with role 'owner'): pays for the team and holds its files.
  owner_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A deleted team is invisible to everyone; its files sit in the trash until the sweep erases them, then the row goes.
  deleted_at timestamptz
);
-- statement-breakpoint
CREATE INDEX design_teams_owner ON public.design_teams(owner_id) WHERE deleted_at IS NULL;
-- statement-breakpoint
CREATE INDEX design_teams_deleted ON public.design_teams(deleted_at) WHERE deleted_at IS NOT NULL;
-- statement-breakpoint
-- Owner, Admin, Editor, Developer, Viewer. Editor seats (owner, admin, editor) are paid; developer and viewer are free.
CREATE TABLE public.design_team_members (
  team_id text COLLATE "C" NOT NULL REFERENCES public.design_teams(id) ON DELETE CASCADE,
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role text COLLATE "C" NOT NULL CHECK(role IN('owner','admin','editor','developer','viewer')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  invited_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  PRIMARY KEY(team_id,user_id)
);
-- statement-breakpoint
-- One owner per team.
CREATE UNIQUE INDEX design_team_members_owner ON public.design_team_members(team_id) WHERE role='owner';
-- statement-breakpoint
CREATE INDEX design_team_members_user ON public.design_team_members(user_id);
-- statement-breakpoint
-- Invite links (SMTP is not configured): only the SHA-256 of the token is kept; the link is shown once to whoever made it.
CREATE TABLE public.design_team_invites (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  team_id text COLLATE "C" NOT NULL REFERENCES public.design_teams(id) ON DELETE CASCADE,
  token text COLLATE "C" NOT NULL UNIQUE CHECK(token ~ '^[0-9a-f]{64}$'),
  -- Never 'owner': ownership is only handed over by the owner.
  role text COLLATE "C" NOT NULL CHECK(role IN('admin','editor','developer','viewer')),
  created_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL DEFAULT 1 CHECK(max_uses BETWEEN 1 AND 100),
  uses integer NOT NULL DEFAULT 0 CHECK(uses>=0 AND uses<=max_uses),
  revoked_at timestamptz,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
-- statement-breakpoint
CREATE INDEX design_team_invites_team ON public.design_team_invites(team_id,created_at DESC);
-- statement-breakpoint
-- Projects: folders of a team's files.
CREATE TABLE public.design_projects (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  team_id text COLLATE "C" NOT NULL REFERENCES public.design_teams(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  -- A file's project is one of its own team's (design_files_project).
  UNIQUE(id,team_id)
);
-- statement-breakpoint
CREATE INDEX design_projects_team ON public.design_projects(team_id) WHERE deleted_at IS NULL;
-- statement-breakpoint
-- The reservation 002 left: a team file names its team. A file in a project is a team file of that project's team.
ALTER TABLE public.design_files ADD CONSTRAINT design_files_team FOREIGN KEY(team_id) REFERENCES public.design_teams(id) ON DELETE CASCADE;
-- statement-breakpoint
ALTER TABLE public.design_files ADD COLUMN project_id text COLLATE "C";
-- statement-breakpoint
ALTER TABLE public.design_files ADD CONSTRAINT design_files_project FOREIGN KEY(project_id,team_id) REFERENCES public.design_projects(id,team_id) ON DELETE SET NULL (project_id);
-- statement-breakpoint
ALTER TABLE public.design_files ADD CONSTRAINT design_files_project_team CHECK(project_id IS NULL OR team_id IS NOT NULL);
-- statement-breakpoint
-- A team's files, newest first (the file browser's team view).
CREATE INDEX design_files_team_files ON public.design_files(team_id,updated_at DESC) WHERE team_id IS NOT NULL;
-- statement-breakpoint
-- A picture uploaded into a team file is the team's: counted against the team's storage and served to its members. NULL: the account's own.
ALTER TABLE public.design_images ADD COLUMN team_id text COLLATE "C" REFERENCES public.design_teams(id) ON DELETE CASCADE;
-- statement-breakpoint
CREATE INDEX design_images_team ON public.design_images(team_id,kind) WHERE team_id IS NOT NULL;
