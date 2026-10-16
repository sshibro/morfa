-- "Favorites", Figma's "Starred" (docs/figma-parity-shell.md; help.figma.com "Star your favorite files and folders"): the files
-- and projects an account starred, listed in its file browser's sidebar. Only that account sees them; starring changes nothing
-- for anybody else. A star goes with its file or project, and with the account (server/design/lifecycle.ts).
--
-- Older releases keep working on it (schema/rollback.json: compatible from 17): the tables are new and nothing else reads them.
CREATE TABLE public.design_favourite_files (
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,file_id)
);
-- statement-breakpoint
CREATE INDEX design_favourite_files_file ON public.design_favourite_files(file_id);
-- statement-breakpoint
CREATE TABLE public.design_favourite_projects (
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  project_id text COLLATE "C" NOT NULL REFERENCES public.design_projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,project_id)
);
-- statement-breakpoint
CREATE INDEX design_favourite_projects_project ON public.design_favourite_projects(project_id);
