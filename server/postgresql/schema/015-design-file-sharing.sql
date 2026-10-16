-- Sharing one file, Figma's way (docs/design-tool.md §Teams, "File access"): people outside the file's place (the owner's personal
-- files, or a team) get it to view or to edit, by an invite to their address or by the file's link. Who may do what is still decided in
-- one place, server/design/file-access.ts.
--
-- Older releases keep working on it (schema/rollback.json: compatible from 14): the column has a default and the tables are new; a
-- release that does not know them simply gives a file's guests no access.

-- The file's link: 'none' (only the people it was shared with), or anyone signed in who has the link may view or edit it.
ALTER TABLE public.design_files ADD COLUMN link_access text COLLATE "C" NOT NULL DEFAULT 'none' CHECK(link_access IN('none','view','edit'));
-- statement-breakpoint
-- A file's guests. `role` is what an invite gave; NULL for someone who opened the file by its link (their access follows link_access,
-- and the row only keeps the file in their "Shared with me"; turning the link off removes those rows).
CREATE TABLE public.design_file_members (
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role text COLLATE "C" CHECK(role IS NULL OR role IN('editor','viewer')),
  invited_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(file_id,user_id)
);
-- statement-breakpoint
CREATE INDEX design_file_members_user ON public.design_file_members(user_id);
-- statement-breakpoint
-- An invite to a file waiting for its address: the person of that address gets the file once signed in with it (the address proven),
-- when they open the file or answer the invitation. One per file and address; a second invite renews it.
CREATE TABLE public.design_file_invites (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  email text COLLATE "C" NOT NULL CHECK(char_length(email) BETWEEN 3 AND 320 AND email=lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'),
  role text COLLATE "C" NOT NULL CHECK(role IN('editor','viewer')),
  created_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days'),
  UNIQUE(file_id,email)
);
-- statement-breakpoint
CREATE INDEX design_file_invites_email ON public.design_file_invites(email);
