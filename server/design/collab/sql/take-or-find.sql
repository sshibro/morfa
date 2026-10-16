-- The live holder of file $1, or its lease taken for node $2 when the file is idle (TTL $3 ms): leases.ts `takeOrFindLease`
-- and crates/collab/src/session.rs (include_str!). Not taken and no live holder in the snapshot: another statement took or
-- released it meanwhile, the caller reads again. The version is the file's: design_files.version or its collab head (SQL016,
-- file-access.ts `versionOf`).
WITH taken AS (
  UPDATE design_files SET collab_node=$2,lease_until=clock_timestamp()+$3::float8*interval '1 millisecond',fence=fence+1
   WHERE id=$1 AND (collab_node IS NULL OR lease_until<clock_timestamp())
   RETURNING collab_node,fence,greatest(design_files.version,coalesce((SELECT h.version FROM design_file_heads h WHERE h.file_id=design_files.id),0)) AS version)
SELECT collab_node,fence,version,true AS taken,true AS live FROM taken
UNION ALL
SELECT collab_node,fence,greatest(design_files.version,coalesce((SELECT h.version FROM design_file_heads h WHERE h.file_id=design_files.id),0)),false,coalesce(lease_until>=clock_timestamp(),false) FROM design_files
 WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM taken)
