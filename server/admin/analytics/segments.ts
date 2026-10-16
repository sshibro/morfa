import {sqlTime} from '../sql-time';
import {personSql} from './people';
import type {Params} from './window';

/* What an account is (shared/admin-analytics.ts AccountSegment) and the per-account numbers every list shows, as CTEs one statement
 * reads beside its own: set-based, never a query per account. */

/** The account's last recorded request (`id` a trusted SQL expression): the max of its newest written date's rows only, which the journal's
 *  index (user_id, created_at) finds without reading the rest. */
export function lastActiveSql(id: string): string {
  return `(SELECT max(${sqlTime('a.created_at')}) FROM admin_activity a WHERE a.user_id=${id}
    AND a.created_at>=(SELECT left(max(b.created_at),10) FROM admin_activity b WHERE b.user_id=${id}))`;
}

/**
 * The per-account CTEs, over every live (not erased) account that is a person (people.ts) or only `ids`:
 *  accounts   (id, deletion_requested_at)
 *  segments   (id, segment): closing (deletion requested) or active
 *  files      (id, live, trashed): files the account holds (its own and its teams')
 *  storage    (id, bytes): the documents' JSON (files, saved versions, library versions; server/design/room.ts) and the pictures
 *  teams      (id, n): memberships of live teams
 * Unreferenced CTEs are never run, so a statement pays only for what it reads.
 */
export function accountCtes(p: Params, ids?: readonly string[]): string {
  const only = ids ? p.add(ids) : null;
  const scope = (column: string) => (only ? ` AND ${column}=ANY(${only}::text[])` : '');
  return `accounts AS (SELECT u.id,u.deletion_requested_at FROM users u WHERE u.erasure_completed_at IS NULL AND ${personSql('u')}${scope('u.id')}),
  segments AS (SELECT a.id,CASE WHEN a.deletion_requested_at IS NOT NULL THEN 'closing' ELSE 'active' END AS segment FROM accounts a),
  files AS (
    SELECT f.user_id AS id,count(*) FILTER(WHERE f.trashed_at IS NULL)::int AS live,count(*) FILTER(WHERE f.trashed_at IS NOT NULL)::int AS trashed
    FROM design_files f JOIN accounts a ON a.id=f.user_id WHERE true${scope('f.user_id')} GROUP BY f.user_id
  ),
  storage AS (
    SELECT x.user_id AS id,sum(x.bytes)::bigint AS bytes FROM (
      SELECT user_id,bytes FROM design_files WHERE true${scope('user_id')}
      UNION ALL SELECT user_id,bytes FROM design_file_versions WHERE true${scope('user_id')}
      UNION ALL SELECT user_id,bytes FROM design_library_versions WHERE true${scope('user_id')}
      UNION ALL SELECT user_id,bytes FROM design_images WHERE true${scope('user_id')}
    ) x JOIN accounts a ON a.id=x.user_id GROUP BY x.user_id
  ),
  teams AS (
    SELECT m.user_id AS id,count(*)::int AS n FROM design_team_members m JOIN design_teams t ON t.id=m.team_id AND t.deleted_at IS NULL
    JOIN accounts a ON a.id=m.user_id WHERE true${scope('m.user_id')} GROUP BY m.user_id
  )`;
}
