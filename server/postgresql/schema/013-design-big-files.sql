-- Big files (docs/decisions/big-files.md, lane BF). The fixed caps of a document (20 MB of JSON, 50 000 layers) leave the
-- database for the application: shared/design/big-files.ts picks the caps in force (DESIGN_DOCUMENT_CAPS, or
-- DESIGN_BIG_FILE_CAPS with DESIGN_BIG_FILES=1) and the server refuses past them as before. The database keeps only what
-- protects it: a text value it can hold (1 GiB) and a layer count within the memory budget's ceiling (2 000 000).
-- It only loosens: every older release keeps working on it (schema/rollback.json: compatible from 12), and with the switch
-- off nothing new can be stored.
ALTER TABLE public.design_files
  DROP CONSTRAINT design_files_document_check,
  DROP CONSTRAINT design_files_bytes_check,
  DROP CONSTRAINT design_files_node_count_check,
  ADD CONSTRAINT design_files_document_check CHECK(octet_length(document) BETWEEN 2 AND 1073741824),
  ADD CONSTRAINT design_files_bytes_check CHECK(bytes BETWEEN 2 AND 1073741824),
  ADD CONSTRAINT design_files_node_count_check CHECK(node_count BETWEEN 0 AND 2000000);
-- statement-breakpoint
ALTER TABLE public.design_file_versions
  DROP CONSTRAINT design_file_versions_document_check,
  DROP CONSTRAINT design_file_versions_bytes_check,
  ADD CONSTRAINT design_file_versions_document_check CHECK(octet_length(document) BETWEEN 2 AND 1073741824),
  ADD CONSTRAINT design_file_versions_bytes_check CHECK(bytes BETWEEN 2 AND 1073741824);
