import type {Row} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import type {AdminPeriod, AdminUsage} from '../../../shared/admin-analytics';
import {ADOPTION_LABELS} from './labels';
import {personIdSql, personSql} from './people';
import {
  adminWindow,
  dense,
  metric,
  moscowDaySql,
  Params,
  share,
  textTimeIn,
  timeIn,
  windowDays,
} from './window';

/* GET /api/admin/usage: what people do in the product. The storage is whole; the accounts, the journal and what was made are people's
 * only (people.ts). */

const TOP_ACTIONS = 10;
const ADOPTION = Object.keys(ADOPTION_LABELS);

export async function adminUsage(sql: SqlExecutor, period: AdminPeriod, now: Date): Promise<AdminUsage> {
  const window = adminWindow(period, now),
    {from, to, previousFrom} = window,
    days = windowDays(window);
  const pk = new Params(),
    since = pk.add(previousFrom),
    start = pk.add(from),
    until = pk.add(to);
  /** The rows of `table` made in each window by a person (`maker`: the column naming the account that made it). */
  const counted = (
    table: string,
    maker: string,
  ) => `(SELECT count(*) FILTER(WHERE created_at>=${start}::timestamptz)::int AS cur,
      count(*) FILTER(WHERE created_at<${start}::timestamptz)::int AS before
    FROM ${table} WHERE created_at>=${since}::timestamptz AND created_at<${until}::timestamptz AND ${personIdSql(maker)})`;
  const product = (await sql.one<Row>(
    `SELECT f.cur AS files,f.before AS files_before,c.cur AS comments,c.before AS comments_before,t.cur AS teams,t.before AS teams_before
     FROM ${counted('design_files', 'user_id')} f,${counted('design_comments', 'author_id')} c,${counted('design_teams', 'owner_id')} t`,
    pk.values,
  ))!;
  const ps = new Params(),
    sinceDay = ps.add(from),
    untilDay = ps.add(to);
  const perDay = (table: string, maker: string, kind: string) =>
    `SELECT '${kind}' AS kind,${moscowDaySql('created_at')} AS day,count(*)::int AS value FROM ${table}
     WHERE created_at>=${sinceDay}::timestamptz AND created_at<${untilDay}::timestamptz AND ${personIdSql(maker)} GROUP BY 2`;
  const productDaily = await sql.many<{kind: string; day: string; value: number}>(
    `${perDay('design_files', 'user_id', 'files')} UNION ALL ${perDay('design_file_versions', 'user_id', 'versions')}
     UNION ALL ${perDay('design_comments', 'author_id', 'comments')}`,
    ps.values,
  );
  const series = (kind: string) =>
    dense(
      days,
      productDaily.filter(row => row.kind === kind),
    );

  // Who used each feature in the window, of the accounts with a recorded request in it.
  const a = new Params();
  const within = (expr: string) => timeIn(a, expr, from, to);
  const adoption = await sql.many<{key: string; active: number; accounts: number}>(
    `WITH active AS (SELECT a.user_id AS id FROM admin_activity a WHERE ${textTimeIn(a, 'a.created_at', from, to)} AND ${personIdSql('a.user_id')}
       GROUP BY a.user_id),
     used AS (
       SELECT 'comments' AS feature,c.author_id AS id FROM design_comments c WHERE c.author_id IS NOT NULL AND ${within('c.created_at')}
       UNION SELECT 'teams',m.user_id FROM design_team_members m JOIN design_teams t ON t.id=m.team_id AND t.deleted_at IS NULL
         WHERE m.joined_at<${a.add(to)}::timestamptz
       UNION SELECT 'sharing',m.user_id FROM design_file_members m WHERE ${within('m.created_at')}
       UNION SELECT 'sharing',m.invited_by FROM design_file_members m WHERE m.invited_by IS NOT NULL AND ${within('m.created_at')}
       UNION SELECT 'libraries',v.published_by FROM design_library_versions v WHERE v.published_by IS NOT NULL AND ${within('v.created_at')}
       UNION SELECT 'libraries',s.enabled_by FROM design_library_subscriptions s WHERE s.enabled_by IS NOT NULL AND ${within('s.enabled_at')}
       UNION SELECT 'meetings',unnest(ARRAY[m.timer_by,m.vote_by]) FROM design_meetings m WHERE ${within('m.updated_at')}
       UNION SELECT 'meetings',v.user_id FROM design_meeting_votes v JOIN design_meetings m ON m.file_id=v.file_id WHERE ${within('m.updated_at')}
       UNION SELECT 'versions',v.user_id FROM design_file_versions v WHERE v.label IS NOT NULL AND ${within('v.created_at')}
     )
     SELECT f.key,(SELECT count(*)::int FROM active) AS active,count(x.id)::int AS accounts
     FROM unnest(${a.add(ADOPTION)}::text[]) AS f(key)
       LEFT JOIN (SELECT u.feature,u.id FROM used u JOIN active ac ON ac.id=u.id) x ON x.feature=f.key
     GROUP BY f.key`,
    a.values,
  );
  const ta = new Params();
  const topActions = await sql.many<{key: string; value: number}>(
    `SELECT action AS key,count(*)::int AS value FROM admin_activity a
     WHERE a.action<>'read' AND ${textTimeIn(ta, 'a.created_at', from, to)} AND ${personIdSql('a.user_id')}
     GROUP BY action ORDER BY value DESC,action LIMIT ${TOP_ACTIONS}`,
    ta.values,
  );
  const storage = (await sql.one<Row>(
    `SELECT (SELECT count(*)::int FROM design_files) AS files,
       ((SELECT COALESCE(sum(bytes),0) FROM design_files)+(SELECT COALESCE(sum(bytes),0) FROM design_file_versions)
         +(SELECT COALESCE(sum(bytes),0) FROM design_library_versions))::bigint AS document_bytes,
       (SELECT count(*)::int FROM design_images) AS pictures,(SELECT COALESCE(sum(bytes),0)::bigint FROM design_images) AS picture_bytes,
       (SELECT count(*)::int FROM design_file_versions) AS versions`,
  ))!;

  return {
    window,
    generatedAt: now.toISOString(),
    kpis: {
      filesCreated: metric(product.files, product.files_before),
      comments: metric(product.comments, product.comments_before),
      teamsCreated: metric(product.teams, product.teams_before),
    },
    product: {
      filesCreated: series('files'),
      versions: series('versions'),
      comments: series('comments'),
      adoption: ADOPTION.map(key => {
        const row = adoption.find(x => x.key === key);
        return {
          key,
          label: ADOPTION_LABELS[key],
          accounts: row?.accounts ?? 0,
          share: share(row?.accounts ?? 0, row?.active ?? 0),
        };
      }),
      topActions: topActions.map(row => ({key: row.key, label: row.key, value: row.value})),
    },
    storage: {
      files: storage.files,
      documentBytes: Number(storage.document_bytes),
      pictures: storage.pictures,
      pictureBytes: Number(storage.picture_bytes),
      versions: storage.versions,
    },
  };
}
