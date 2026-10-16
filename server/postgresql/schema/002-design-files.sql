-- The design tool (docs/design-tool.md §Server API): the files of the vector design tool, their saved versions and
-- the pictures placed in them. A file belongs to one
-- account; every read and write filters by user_id. Pictures and thumbnails are files in DATA_DIR/uploads, served by
-- GET /uploads/:filename to their owner only; they are counted against the design plan's storage.
-- The rows go with the account (ON DELETE CASCADE), so an
-- older release keeps working on these tables; the erasure of an account deletes them explicitly with their files.
CREATE TABLE public.design_files (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Reserved for team accounts (a later wave): the team that owns the file, NULL for a personal file. No reference
  -- until the teams table exists; nothing reads it yet.
  team_id text COLLATE "C" CHECK(team_id IS NULL OR char_length(team_id) BETWEEN 1 AND 200),
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200),
  -- The document as JSON (shared/design/types.ts), validated by shared/design/schema.ts before every write.
  document text NOT NULL CHECK(octet_length(document) BETWEEN 2 AND 20971520),
  version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
  bytes integer NOT NULL CHECK(bytes BETWEEN 2 AND 20971520),
  node_count integer NOT NULL CHECK(node_count BETWEEN 0 AND 50000),
  -- Filenames of the pictures the document points at: an erased file takes the pictures no other file or version uses.
  image_files text[] NOT NULL DEFAULT '{}' CHECK(cardinality(image_files)<=10000),
  thumbnail_filename text COLLATE "C" CHECK(thumbnail_filename IS NULL OR thumbnail_filename ~ '^[A-Za-z0-9_-]{1,120}\.webp$'),
  -- The browser's key for a create that may be retried: one file per account and key.
  client_id text COLLATE "C" CHECK(client_id IS NULL OR client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  -- When the last automatic version was taken (at most one per 10 minutes of editing).
  auto_version_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  trashed_at timestamptz,
  UNIQUE(user_id,client_id)
);
-- statement-breakpoint
-- The file browser: an account's files, newest first.
CREATE INDEX design_files_user ON public.design_files(user_id,updated_at DESC);
-- statement-breakpoint
-- The trash sweep.
CREATE INDEX design_files_trashed ON public.design_files(trashed_at) WHERE trashed_at IS NOT NULL;
-- statement-breakpoint
-- Saved copies of a file's document: automatic ones (label NULL) and the ones the owner named. Pruned by the plan's
-- history days when a new one is taken.
CREATE TABLE public.design_file_versions (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The file version this copy captured.
  version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  label text CHECK(label IS NULL OR char_length(label) BETWEEN 1 AND 120),
  document text NOT NULL CHECK(octet_length(document) BETWEEN 2 AND 20971520),
  bytes integer NOT NULL CHECK(bytes BETWEEN 2 AND 20971520),
  image_files text[] NOT NULL DEFAULT '{}' CHECK(cardinality(image_files)<=10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX design_file_versions_file ON public.design_file_versions(file_id,created_at DESC);
-- statement-breakpoint
CREATE INDEX design_file_versions_user ON public.design_file_versions(user_id);
-- statement-breakpoint
-- Pictures placed in design files and the files' thumbnails: DATA_DIR/uploads/<filename>, re-encoded by the server.
-- file_id is the file a picture was uploaded into; a picture may be used by other files of the same account.
CREATE TABLE public.design_images (
  filename text COLLATE "C" PRIMARY KEY CHECK(filename ~ '^[A-Za-z0-9_-]{1,120}\.(webp|png)$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  file_id text COLLATE "C" REFERENCES public.design_files(id) ON DELETE SET NULL,
  kind text COLLATE "C" NOT NULL CHECK(kind IN('image','thumbnail')),
  bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 20971520),
  width integer NOT NULL CHECK(width BETWEEN 1 AND 16384),
  height integer NOT NULL CHECK(height BETWEEN 1 AND 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX design_images_user ON public.design_images(user_id,kind);
-- statement-breakpoint
CREATE INDEX design_images_file ON public.design_images(file_id) WHERE file_id IS NOT NULL;
