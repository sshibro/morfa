-- Design shared libraries (docs/design-tool.md §Teams, "Shared libraries"): a file publishes components, styles and
-- variable collections as immutable versions; other files of the same team (or the same account's personal files) enable the
-- library and use its assets through local copies. Every row is
-- held by the account that holds the publishing file (`user_id`, the team's owner for a team file), moves with the file and with
-- a team's handover, and goes with the file (ON DELETE CASCADE) or the account; files that used the library keep their copies.
CREATE TABLE public.design_libraries (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  -- One library per file.
  file_id text COLLATE "C" NOT NULL UNIQUE REFERENCES public.design_files(id) ON DELETE CASCADE,
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The newest version; versions are numbered from 1 in each library.
  version integer NOT NULL CHECK(version BETWEEN 1 AND 1000000000),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Unpublished: no file can enable it any more; files that had it keep their copies and are offered no updates.
  unpublished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX design_libraries_user ON public.design_libraries(user_id);
-- statement-breakpoint
-- One publication: the snapshot (shared/design/libraries.ts `LibrarySnapshot`, validated like a document before it is written,
-- within the same 20 MB) and its manifest (what was published, with each asset's hash and the version it last changed in), kept
-- apart so listing a library never reads a snapshot. Counted in the holder's room for documents (server/design/room.ts).
CREATE TABLE public.design_library_versions (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  library_id text COLLATE "C" NOT NULL REFERENCES public.design_libraries(id) ON DELETE CASCADE,
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK(version BETWEEN 1 AND 1000000000),
  -- The file version the snapshot was taken from.
  file_version bigint NOT NULL CHECK(file_version BETWEEN 1 AND 9007199254740991),
  description text NOT NULL DEFAULT '' CHECK(char_length(description)<=1000),
  manifest text NOT NULL CHECK(octet_length(manifest) BETWEEN 2 AND 8388608),
  snapshot text NOT NULL CHECK(octet_length(snapshot) BETWEEN 2 AND 20971520),
  -- Manifest and snapshot together.
  bytes integer NOT NULL CHECK(bytes BETWEEN 4 AND 29360128),
  -- Pictures the snapshot points at: an erased file keeps a picture a library version still shows.
  image_files text[] NOT NULL DEFAULT '{}' CHECK(cardinality(image_files)<=10000),
  published_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(library_id,version)
);
-- statement-breakpoint
CREATE INDEX design_library_versions_user ON public.design_library_versions(user_id);
-- statement-breakpoint
-- A file that enabled a library ("Libraries"), and its update state: the newest version the file has been told about
-- (taken or put off), so "Library updates available" greets each new version once.
CREATE TABLE public.design_library_subscriptions (
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  library_id text COLLATE "C" NOT NULL REFERENCES public.design_libraries(id) ON DELETE CASCADE,
  enabled_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_version integer CHECK(seen_version IS NULL OR seen_version BETWEEN 1 AND 1000000000),
  PRIMARY KEY(file_id,library_id)
);
-- statement-breakpoint
CREATE INDEX design_library_subscriptions_library ON public.design_library_subscriptions(library_id);
-- statement-breakpoint
-- A picture copied into the place of a file that uses a library from another place (a library file moved between a team and
-- personal files keeps its versions' addresses): the next use of the same picture there takes the same copy. The copy is an
-- ordinary design picture of that place (counted in its storage); this row goes with it.
CREATE TABLE public.design_library_pictures (
  filename text COLLATE "C" PRIMARY KEY REFERENCES public.design_images(filename) ON DELETE CASCADE,
  source text COLLATE "C" NOT NULL CHECK(source ~ '^[A-Za-z0-9._-]{1,200}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX design_library_pictures_source ON public.design_library_pictures(source);
