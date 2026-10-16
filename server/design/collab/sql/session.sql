-- GET /api/design-files/:id/session in one statement (docs/BACKEND.md §2, §11; TARGETS A2). One text, two readers: api's
-- server/design/collab/session.ts (the oracle and the fallback) and the collab nodes' crates/collab/src/session.rs
-- (include_str!), which serve the same route behind Caddy (lane A7).
--   a     file-access.ts `fileAccess(…, 'view')` with designRead's session check: the caller's live session, the account not
--         closing, the file reachable by THE rule of file-access.ts `fileRoleJoins('f', 'u.id')` (a personal file of the caller:
--         'owner'; a file of a live team the caller is in: the role; a guest of the file, or anyone signed in when its link is
--         open: 'editor' or 'viewer'); the two CROSS JOIN LATERALs below are that rule's text, kept equal to it by
--         tests/postgresql-runtime-design-file-sharing.test.ts;
--         switch.ts `fileCollabMode` from the overrides passed in (the team's entry, then the holder's, then the global mode);
--   taken leases.ts `takeOrFindLease`: in rust mode an idle file's lease is taken for $8 (the fence moves up).
-- No row: 404 (a session that ended a moment ago is answered 404 rather than 401).
-- $1 file, $2 account, $3 session hash, $4 now (epoch ms), $5/$6 override ids/modes, $7 global mode, $8 node, $9 lease TTL (ms).
WITH a AS (
  SELECT f.id,f.user_id,f.team_id,f.trashed_at,fa_role.role,u.name,
         COALESCE((SELECT o.mode FROM unnest($5::text[],$6::text[]) AS o(id,mode) WHERE o.id=f.team_id),
                  (SELECT o.mode FROM unnest($5::text[],$6::text[]) AS o(id,mode) WHERE o.id=f.user_id),$7) AS mode
    FROM sessions s
    JOIN users u ON u.id=s.user_id AND u.deletion_requested_at IS NULL
    JOIN design_files f ON f.id=$1
    CROSS JOIN LATERAL (
      SELECT (SELECT m.role FROM design_teams t JOIN design_team_members m ON m.team_id=t.id AND m.user_id=u.id
                WHERE t.id=f.team_id AND t.deleted_at IS NULL) AS team_role,
             g.present AS guest_row,
             CASE WHEN f.trashed_at IS NULL AND (f.team_id IS NULL OR EXISTS(SELECT 1 FROM design_teams t WHERE t.id=f.team_id AND t.deleted_at IS NULL))
               THEN CASE WHEN g.role='editor' OR f.link_access='edit' THEN 'editor' WHEN g.role='viewer' OR f.link_access='view' THEN 'viewer' END
             END AS guest_role
        FROM (SELECT (SELECT x.role FROM design_file_members x WHERE x.file_id=f.id AND x.user_id=u.id) AS role,
                     EXISTS(SELECT 1 FROM design_file_members x WHERE x.file_id=f.id AND x.user_id=u.id) AS present) g
    ) fa_parts
    CROSS JOIN LATERAL (
      SELECT CASE WHEN f.team_id IS NULL AND f.user_id=u.id THEN 'owner'
                  WHEN fa_parts.team_role IN('owner','admin','editor') THEN fa_parts.team_role
                  WHEN fa_parts.guest_role='editor' THEN 'editor'
                  WHEN fa_parts.guest_role IS NOT NULL THEN COALESCE(fa_parts.team_role,'viewer')
                  ELSE fa_parts.team_role END AS role,
             NOT (f.team_id IS NULL AND f.user_id=u.id) AND fa_parts.team_role IS NULL AS guest
    ) fa_role
   WHERE s.token=$3 AND s.user_id=$2 AND s.expires>$4 AND fa_role.role IS NOT NULL
), taken AS (
  UPDATE design_files d SET collab_node=$8,lease_until=clock_timestamp()+$9::float8*interval '1 millisecond',fence=d.fence+1
    FROM a WHERE d.id=a.id AND a.mode='rust' AND (d.collab_node IS NULL OR d.lease_until<clock_timestamp())
  RETURNING d.collab_node,greatest(d.version,coalesce((SELECT h.version FROM design_file_heads h WHERE h.file_id=d.id),0)) AS version
)
SELECT a.id,a.user_id,a.team_id,a.trashed_at IS NOT NULL AS trashed,a.role,a.name,a.mode,
       t.collab_node AS taken_node,t.version AS taken_version,d.collab_node,greatest(d.version,coalesce((SELECT h.version FROM design_file_heads h WHERE h.file_id=d.id),0)) AS version,
       COALESCE(d.lease_until>=clock_timestamp(),false) AS live
  FROM a JOIN design_files d ON d.id=a.id LEFT JOIN taken t ON true
