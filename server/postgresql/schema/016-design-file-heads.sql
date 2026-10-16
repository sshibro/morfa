-- The collab journal's version counter beside the file (docs/BACKEND.md §3). Every journal statement moved
-- design_files.version to its newest row, an UPDATE of the file's wide row: PostgreSQL re-reads and evaluates the 22 CHECK
-- constraints of design_files and writes a new version of the row on every commit, ~14 % of its CPU per op at 2 000 editors. A
-- collab node started with MORFA_JOURNAL_VERSION_HEADS=1 keeps the counter here instead: the statement takes the file's row lock
-- under the fence (FOR SHARE: a new owner's lease still waits for the commit in flight) and moves this narrow row.
--
-- The file's version is then greatest(design_files.version, design_file_heads.version); a checkpoint folds the head back into
-- design_files.version (crates/checkpoint RECORD). The readers that still read design_files.version alone (api's saves, exports,
-- sessions) must read that expression before a node runs with the switch on. Without the switch
-- nothing writes here and nothing changes.
--
-- Older releases keep working on it (schema/rollback.json: compatible from 15): the table is new and empty until the switch is on.
CREATE TABLE public.design_file_heads (
  file_id text COLLATE "C" PRIMARY KEY REFERENCES public.design_files(id) ON DELETE CASCADE,
  -- The version of the file's newest journal row written under the switch.
  version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991)
);
