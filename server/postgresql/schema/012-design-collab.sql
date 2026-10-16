-- The Rust co-editing backend (docs/BACKEND.md §2, §3, §8; lane B2). Three things change, all by adding:
--
-- 1. design_file_changes becomes the collab journal. Collab writes the op in the model's binary codec (`op`) and leaves `patch`
--    NULL; Node keeps writing `patch` (JSON) as before while DESIGN_COLLAB is legacy|shadow. Exactly one of the two is set. A row
--    carries who sent it (`client_id`, `client_seq`: an op re-sent after a reconnect is re-acked, never applied twice), the account
--    and the lease `fence` it was written under. The document at design_files.version is still the stored text (or the checkpoint)
--    with these rows applied in version order.
-- 2. design_files holds the lease (`collab_node`, `lease_until`, `fence`) and the latest checkpoint in object storage
--    (`checkpoint_key`, `checkpoint_version`, `checkpoint_format`). The fence grows by one on every new owner; a journal row
--    written under an older fence is refused (the trigger below), so a stale owner that still runs cannot add to the document.
-- 3. design_images learns its content hash and object-storage key (`img/<sha256>`): pictures become content-addressed.
--
-- Older releases keep working on it (schema/rollback.json: compatible from 11): every new column is nullable or has a default,
-- and a row without a fence (what Node writes) passes the trigger.
ALTER TABLE public.design_file_changes
  ALTER COLUMN patch DROP NOT NULL,
  -- The tab's id and its op counter (crates/protocol `hello {clientId}`, `op {seq}`); both or neither.
  ADD COLUMN client_id text COLLATE "C" CHECK(client_id IS NULL OR client_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD COLUMN client_seq bigint CHECK(client_seq IS NULL OR client_seq BETWEEN 0 AND 9007199254740991),
  -- The account whose op it was (no reference: the journal is written on the hot path, accounts are never deleted).
  ADD COLUMN user_id text COLLATE "C" CHECK(user_id IS NULL OR char_length(user_id) BETWEEN 1 AND 200),
  -- The lease fence the writer held (NULL: written by Node outside a lease).
  ADD COLUMN fence bigint CHECK(fence IS NULL OR fence BETWEEN 1 AND 9007199254740991),
  -- The op in the model's binary codec (crates/model codec), or the JSON patch bytes when the codec decision says JSON.
  ADD COLUMN op bytea CHECK(op IS NULL OR octet_length(op) BETWEEN 1 AND 20971520),
  ADD CONSTRAINT design_file_changes_one_body CHECK((patch IS NULL) <> (op IS NULL)),
  ADD CONSTRAINT design_file_changes_client CHECK((client_id IS NULL) = (client_seq IS NULL));
-- statement-breakpoint
-- A re-sent op is found by its sender's id and counter (and journaled at most once while its row is kept).
CREATE UNIQUE INDEX design_file_changes_client ON public.design_file_changes(file_id,client_id,client_seq) WHERE client_id IS NOT NULL;
-- statement-breakpoint
ALTER TABLE public.design_files
  -- The collab node that owns the document, and until when (15 s, renewed every 5 s); both or neither.
  ADD COLUMN collab_node text COLLATE "C" CHECK(collab_node IS NULL OR collab_node ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  ADD COLUMN lease_until timestamptz,
  -- Grows by one with every new owner; journal rows carry the fence they were written under.
  ADD COLUMN fence bigint NOT NULL DEFAULT 0 CHECK(fence BETWEEN 0 AND 9007199254740991),
  -- The latest checkpoint: `ckpt/<file>/<version>.<format>.zst` in object storage, the version it holds and its format.
  ADD COLUMN checkpoint_key text COLLATE "C" CHECK(checkpoint_key IS NULL OR checkpoint_key ~ '^ckpt/[0-9a-f-]{36}/[0-9]{1,16}\.(bin|json)\.zst$'),
  ADD COLUMN checkpoint_version bigint CHECK(checkpoint_version IS NULL OR checkpoint_version BETWEEN 1 AND 9007199254740991),
  ADD COLUMN checkpoint_format text COLLATE "C" CHECK(checkpoint_format IS NULL OR checkpoint_format IN('bin','json')),
  ADD CONSTRAINT design_files_lease CHECK((collab_node IS NULL) = (lease_until IS NULL)),
  ADD CONSTRAINT design_files_checkpoint CHECK((checkpoint_key IS NULL) = (checkpoint_version IS NULL) AND (checkpoint_key IS NULL) = (checkpoint_format IS NULL)),
  ADD CONSTRAINT design_files_checkpoint_version CHECK(checkpoint_version IS NULL OR checkpoint_version <= version);
-- statement-breakpoint
-- A node's documents (its leases are expired at once when its health check fails).
CREATE INDEX design_files_collab_node ON public.design_files(collab_node) WHERE collab_node IS NOT NULL;
-- statement-breakpoint
ALTER TABLE public.design_images
  -- sha256 of the stored bytes, and where they are (`img/<sha256>`, `thumb/<sha256>.webp`); both or neither (older rows: neither).
  ADD COLUMN content_hash text COLLATE "C" CHECK(content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN storage_key text COLLATE "C" CHECK(storage_key IS NULL OR storage_key ~ '^(img/[0-9a-f]{64}|thumb/[0-9a-f]{64}\.webp)$'),
  ADD CONSTRAINT design_images_content CHECK((content_hash IS NULL) = (storage_key IS NULL));
-- statement-breakpoint
-- Dedup: an upload whose bytes are already stored reuses the object.
CREATE INDEX design_images_content_hash ON public.design_images(content_hash) WHERE content_hash IS NOT NULL;
-- statement-breakpoint
-- The fence check (docs/BACKEND.md §8, split brain): a journal row written under a lease must carry the file's current fence.
-- The collab journal also takes the file's row lock in the same statement (crates/journal), so a new owner's lease waits for
-- the commit in flight and then sees its rows; this trigger is the database's own guarantee for any other writer.
CREATE FUNCTION public.design_file_changes_fence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  current_fence bigint;
BEGIN
  IF NEW.fence IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT f.fence INTO current_fence FROM public.design_files f WHERE f.id = NEW.file_id;
  IF current_fence IS DISTINCT FROM NEW.fence THEN
    RAISE EXCEPTION 'design file % is held under fence %, not %', NEW.file_id, current_fence, NEW.fence
      USING ERRCODE = 'MRF01';
  END IF;
  RETURN NEW;
END
$$;
-- statement-breakpoint
CREATE TRIGGER design_file_changes_fence BEFORE INSERT ON public.design_file_changes
  FOR EACH ROW WHEN (NEW.fence IS NOT NULL) EXECUTE FUNCTION public.design_file_changes_fence();
