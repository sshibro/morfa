-- Design comments, Teams step 2 (docs/design-tool.md §Teams "Comments"): threads pinned to a file's page, on a layer (with
-- the point inside it, so the pin follows the layer) or on the canvas; their comments, mentions of the team's members, and each account's
-- read state. The rows belong to the file: erasing a file (and so a team or
-- the account that holds it) takes them with it (ON DELETE CASCADE). An erased account's comments in files other accounts hold stay as
-- part of that file's discussion, detached from the account (author NULL, "Deleted account"); its mentions and read state go.
-- Who may do what is decided by server/design/comments.ts through server/design/file-access.ts.
CREATE TABLE public.design_comment_threads (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  page_id text COLLATE "C" NOT NULL CHECK(page_id ~ '^[A-Za-z0-9_:;.,-]+$' AND char_length(page_id)<=512),
  -- The pin's point on the page: where it stood when it was last written (the fallback once its layer is gone).
  x double precision NOT NULL CHECK(x BETWEEN -1e9 AND 1e9),
  y double precision NOT NULL CHECK(y BETWEEN -1e9 AND 1e9),
  -- The layer it follows and the point in the layer's own space; all three NULL for a pin on the canvas.
  node_id text COLLATE "C" CHECK(node_id ~ '^[A-Za-z0-9_:;.,-]+$' AND char_length(node_id)<=512),
  offset_x double precision CHECK(offset_x BETWEEN -1e9 AND 1e9),
  offset_y double precision CHECK(offset_y BETWEEN -1e9 AND 1e9),
  author_id text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  -- A deleted thread stays as a tombstone (no comments, no author, no layer) so an open editor learns about it from its cursor.
  deleted_at timestamptz,
  -- The file's change counter at the thread's last change; per file it only grows (writes of one file are serialized).
  seq bigint NOT NULL CHECK(seq > 0),
  CHECK((node_id IS NULL) = (offset_x IS NULL) AND (node_id IS NULL) = (offset_y IS NULL)),
  CHECK(resolved_by IS NULL OR resolved_at IS NOT NULL),
  CHECK(deleted_at IS NULL OR (author_id IS NULL AND node_id IS NULL AND resolved_at IS NULL))
);
-- statement-breakpoint
-- A file's changes after a cursor, and its counter.
CREATE INDEX design_comment_threads_file ON public.design_comment_threads(file_id,seq);
-- statement-breakpoint
CREATE INDEX design_comment_threads_author ON public.design_comment_threads(author_id) WHERE author_id IS NOT NULL;
-- statement-breakpoint
CREATE INDEX design_comment_threads_resolver ON public.design_comment_threads(resolved_by) WHERE resolved_by IS NOT NULL;
-- statement-breakpoint
-- The comments of a thread, the first one included. Plain text only.
CREATE TABLE public.design_comments (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  thread_id text COLLATE "C" NOT NULL REFERENCES public.design_comment_threads(id) ON DELETE CASCADE,
  author_id text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  edited_at timestamptz,
  seq bigint NOT NULL CHECK(seq > 0)
);
-- statement-breakpoint
CREATE INDEX design_comments_thread ON public.design_comments(thread_id,seq);
-- statement-breakpoint
CREATE INDEX design_comments_author ON public.design_comments(author_id) WHERE author_id IS NOT NULL;
-- statement-breakpoint
-- "@Name" in a comment: the member it names and where it stands in the text (UTF-16 units, the "@" included).
CREATE TABLE public.design_comment_mentions (
  comment_id text COLLATE "C" NOT NULL REFERENCES public.design_comments(id) ON DELETE CASCADE,
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  at integer NOT NULL CHECK(at BETWEEN 0 AND 3999),
  length integer NOT NULL CHECK(length BETWEEN 2 AND 101),
  PRIMARY KEY(comment_id,at)
);
-- statement-breakpoint
CREATE INDEX design_comment_mentions_user ON public.design_comment_mentions(user_id);
-- statement-breakpoint
-- How far each account has read each thread (the file's counter): what is newer and someone else's is unread.
CREATE TABLE public.design_comment_reads (
  thread_id text COLLATE "C" NOT NULL REFERENCES public.design_comment_threads(id) ON DELETE CASCADE,
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  read_seq bigint NOT NULL CHECK(read_seq >= 0),
  PRIMARY KEY(thread_id,user_id)
);
-- statement-breakpoint
CREATE INDEX design_comment_reads_user ON public.design_comment_reads(user_id);
