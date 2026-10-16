-- The design tool (docs/design-tool.md §Performance, "Saving large files"): the changes a large file's saves made after the
-- version its stored text holds. A save of a large document (up to 20 MB of JSON) writes its change here and the file's version, size
-- and pictures in design_files, instead of rewriting the whole text each time; the text catches up now and then (written at the
-- file's version, these rows deleted in the same transaction). The document at design_files.version is the stored text with these
-- rows applied in version order: they are always the versions right after the text's, up to the file's. The rows go with their
-- file. Ships with 002–008 (the design tool's first release), so no release that reads
-- design_files.document without them ever runs on it.
CREATE TABLE public.design_file_changes (
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  -- The file version this change made.
  version bigint NOT NULL CHECK(version BETWEEN 2 AND 9007199254740991),
  -- The change as the server applied it (shared/design/patch.ts DocumentPatch, JSON).
  patch text NOT NULL CHECK(octet_length(patch) BETWEEN 2 AND 20971520),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(file_id,version)
);
