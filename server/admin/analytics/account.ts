import type {Row} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import type {AdminAccountDetail} from '../../../shared/admin-analytics';
import {sqlTime} from '../sql-time';
import {personIdSql} from './people';
import {accountRows} from './rows';
import {daysStart, dense, lastDays, moscowDaySql, Params, rowsIn} from './window';

/* GET /api/admin/accounts/:id: one account in full. Every statement reads one account through its own indexes. */

/** The journal's daily series goes back this many Moscow days (today's included). */
const DETAIL_DAYS = 90;
const RECENT_FILES = 8;
const RECENT_ACTIVITY = 40;
const TOP_ACTIONS = 8;

/** The account, or null for an unknown or erased one, or one that is not a person (people.ts). */
export async function adminAccount(sql: SqlExecutor, id: string, now: Date): Promise<AdminAccountDetail | null> {
  const [row] = await accountRows(sql, [id], now);
  if (!row) return null;
  const at = now.toISOString(),
    days = lastDays(now, DETAIL_DAYS),
    since = daysStart(days);
  const person = (await sql.one<Row>(
    `SELECT ${sqlTime('u.deletion_requested_at')} AS deletion_requested_at,
       (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.expires>$2) AS sessions,
       (SELECT max(${sqlTime('s.created_at')}) FROM sessions s WHERE s.user_id=u.id) AS last_sign_in
     FROM users u WHERE u.id=$1`,
    [id, now.getTime()],
  ))!;
  const files = (await sql.one<Row>(
    `SELECT count(*) FILTER(WHERE f.trashed_at IS NOT NULL)::int AS trashed,
       (SELECT count(*)::int FROM design_file_versions v WHERE v.user_id=$1) AS versions
     FROM design_files f WHERE f.user_id=$1`,
    [id],
  ))!;
  const recentFiles = await sql.many<Row>(
    `SELECT id,name,updated_at,bytes,node_count,team_id IS NOT NULL AS team FROM design_files
     WHERE user_id=$1 AND trashed_at IS NULL ORDER BY updated_at DESC,id LIMIT ${RECENT_FILES}`,
    [id],
  );
  const teams = await sql.many<Row>(
    `SELECT t.id,t.name,m.role,(SELECT count(*)::int FROM design_team_members x WHERE x.team_id=t.id AND ${personIdSql('x.user_id')}) AS members
     FROM design_team_members m JOIN design_teams t ON t.id=m.team_id AND t.deleted_at IS NULL WHERE m.user_id=$1 ORDER BY t.created_at,t.id`,
    [id],
  );
  const j = new Params();
  const journal = await sql.many<{day: string | null; key: string | null; value: number}>(
    `SELECT CASE WHEN GROUPING(x.day)=0 THEN x.day END AS day,CASE WHEN GROUPING(x.action)=0 THEN x.action END AS key,count(*)::int AS value
     FROM (SELECT ${moscowDaySql('y.at')} AS day,y.action FROM ${rowsIn(j, 'admin_activity a', 'a.action', 'a.created_at', since, at, ` AND a.user_id=${j.add(id)}`)} y) x
     GROUP BY GROUPING SETS ((x.day),(x.action))`,
    j.values,
  );
  const recentActivity = await sql.many<{at: string; action: string}>(
    `SELECT ${sqlTime('created_at')} AS at,action FROM admin_activity WHERE user_id=$1
     ORDER BY ${sqlTime('created_at')} DESC NULLS LAST,id DESC LIMIT ${RECENT_ACTIVITY}`,
    [id],
  );
  const collaboration = (await sql.one<Row>(
    `SELECT (SELECT count(*)::int FROM design_comments c WHERE c.author_id=$1) AS comments,
       (SELECT count(*)::int FROM design_files f WHERE f.user_id=$1 AND f.trashed_at IS NULL
          AND (f.link_access<>'none' OR EXISTS(SELECT 1 FROM design_file_members m WHERE m.file_id=f.id))) AS shared_files,
       (SELECT count(*)::int FROM design_meetings mt JOIN design_files f ON f.id=mt.file_id WHERE f.user_id=$1) AS meetings`,
    [id],
  ))!;

  const topActions = journal
    .filter(r => r.key !== null && r.key !== 'read')
    .sort((a, b) => b.value - a.value || (a.key! < b.key! ? -1 : 1))
    .slice(0, TOP_ACTIONS)
    .map(r => ({key: r.key!, label: r.key!, value: r.value}));
  return {
    account: {
      ...row,
      deletionRequestedAt: person.deletion_requested_at ?? null,
      sessions: {active: person.sessions, lastSignInAt: person.last_sign_in ?? null},
    },
    files: {
      count: row.files,
      trashed: files.trashed,
      storageBytes: row.storageBytes,
      versions: files.versions,
      recent: recentFiles.map(f => ({
        id: f.id,
        name: f.name,
        updatedAt: f.updated_at,
        bytes: f.bytes,
        nodeCount: f.node_count,
        team: f.team,
      })),
    },
    teams: teams.map(t => ({id: t.id, name: t.name, role: t.role, members: t.members})),
    activity: {
      daily: dense(
        days,
        journal.filter(r => r.day !== null).map(r => ({day: r.day!, value: r.value})),
      ),
      recent: recentActivity.map(r => ({at: r.at, action: r.action})),
      topActions,
    },
    collaboration: {
      comments: collaboration.comments,
      sharedFiles: collaboration.shared_files,
      meetings: collaboration.meetings,
    },
  };
}
