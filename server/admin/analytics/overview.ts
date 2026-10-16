import type {Row} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import type {AdminAlert, AdminCohort, AdminOverview, AdminPeriod} from '../../../shared/admin-analytics';
import {ONE_DAY_MS} from '../../time-constants';
import {sqlTime} from '../sql-time';
import {FUNNEL_LABELS} from './labels';
import {personIdSql, personSql} from './people';
import {accountCtes} from './segments';
import {
  addDays,
  adminWindow,
  dense,
  iso,
  metric,
  moscowDate,
  moscowDateStart,
  moscowDaySql,
  moscowWall,
  Params,
  rowsIn,
  share,
  timeIn,
  weekOf,
  windowDays,
} from './window';

/* GET /api/admin/overview: the console's home screen. One statement per block, each a set-based read of its tables. Accounts, activity
 * and the funnel are people's only (people.ts). */

const WEEK_MS = 7 * ONE_DAY_MS;
const COHORT_WEEKS = 8;
const TONES = ['danger', 'warn', 'info'] as const;

export async function adminOverview(
  sql: SqlExecutor,
  period: AdminPeriod,
  now: Date,
): Promise<AdminOverview> {
  const window = adminWindow(period, now),
    {from, to, previousFrom} = window,
    days = windowDays(window);

  const u = new Params();
  const accounts = await sql.many<Row>(
    `SELECT GROUPING(x.day)=1 AS total,x.day,count(*) FILTER(WHERE x.live)::int AS live,
       count(*) FILTER(WHERE x.c<${u.add(from)}::timestamptz AND (x.e IS NULL OR x.e>=$1::timestamptz))::int AS live_then,
       count(*) FILTER(WHERE ${timeIn(u, 'x.c', from, to)})::int AS signups,
       count(*) FILTER(WHERE ${timeIn(u, 'x.c', previousFrom, from)})::int AS signups_before
     FROM (SELECT y.*,${moscowDaySql('y.c')} AS day FROM (SELECT u.erasure_completed_at IS NULL AS live,${sqlTime('u.created_at')} AS c,
             ${sqlTime('u.erasure_completed_at')} AS e FROM users u WHERE ${personSql('u')} OFFSET 0) y) x
     GROUP BY GROUPING SETS ((),(x.day))`,
    u.values,
  );
  const people = accounts.find(row => row.total)!;

  // The journal, read once (each row's instant converted once, then grouped three ways): who was active in the window and before it, and
  // in the last 1, 7 and 30 days (each account once: grouped, never a count(DISTINCT), which sorts every row); per day; by weekday and
  // hour.
  const toMs = Date.parse(to);
  const j = new Params(),
    start = j.add(from);
  const journal = (await sql.one<{active: Row; daily: Array<[string, number]>; hours: Array<[number, number, number]>}>(
    `WITH j AS MATERIALIZED (
       SELECT y.user_id,y.at,${moscowWall('y.at')} AS wall
       FROM ${rowsIn(j, 'admin_activity a', 'a.user_id', 'a.created_at', iso(Math.min(Date.parse(previousFrom), toMs - 30 * ONE_DAY_MS)), to)} y
       WHERE ${personIdSql('y.user_id')})
     SELECT (SELECT row_to_json(x) FROM (
               SELECT count(*) FILTER(WHERE u.cur) AS active,count(*) FILTER(WHERE u.before) AS active_before,
                 count(*) FILTER(WHERE u.last>=${j.add(iso(toMs - ONE_DAY_MS))}::timestamptz) AS dau,
                 count(*) FILTER(WHERE u.last>=${j.add(iso(toMs - 7 * ONE_DAY_MS))}::timestamptz) AS wau,
                 count(*) FILTER(WHERE u.last>=${j.add(iso(toMs - 30 * ONE_DAY_MS))}::timestamptz) AS mau
               FROM (SELECT bool_or(at>=${start}::timestamptz) AS cur,max(at) AS last,
                       bool_or(at>=${j.add(previousFrom)}::timestamptz AND at<${start}::timestamptz) AS before
                     FROM j GROUP BY user_id) u) x) AS active,
       (SELECT COALESCE(json_agg(json_build_array(d.day,d.n)),'[]') FROM (
          SELECT day,count(*) AS n FROM (SELECT wall::date AS day FROM j WHERE at>=${start}::timestamptz GROUP BY 1,user_id) e
          GROUP BY day) d) AS daily,
       (SELECT COALESCE(json_agg(json_build_array(h.weekday,h.hour,h.n)),'[]') FROM (
          SELECT extract(isodow FROM wall)::int-1 AS weekday,extract(hour FROM wall)::int AS hour,count(*) AS n
          FROM j WHERE at>=${start}::timestamptz GROUP BY 1,2) h) AS hours`,
    j.values,
  ))!;
  const active = journal.active;
  const daily = journal.daily.map(([day, value]) => ({day, value}));
  const heatmap = Array.from({length: 7}, () => Array<number>(24).fill(0));
  for (const [weekday, hour, n] of journal.hours) heatmap[weekday][hour] = n;

  return {
    window,
    generatedAt: now.toISOString(),
    kpis: {
      accounts: metric(people.live, people.live_then),
      newAccounts: metric(people.signups, people.signups_before),
      activeAccounts: metric(active.active, active.active_before),
    },
    series: {
      signups: dense(
        days,
        accounts.filter(row => !row.total).map(row => ({day: row.day, value: row.signups})),
      ),
      active: dense(days, daily),
    },
    funnel: await funnel(sql, from, to),
    stickiness: {dau: active.dau, wau: active.wau, mau: active.mau},
    cohorts: await cohorts(sql, now),
    heatmap,
    alerts: await alerts(sql),
  };
}

/**
 * The accounts that signed up in [from, to), step by step; each step counts those that also took every step before it: made a file (one
 * it holds), came back (a recorded request on a Moscow day after the day of its signup).
 */
async function funnel(sql: SqlExecutor, from: string, to: string) {
  const p = new Params();
  const steps = (await sql.one<Row>(
    `WITH signed AS (SELECT u.id,u.at FROM ${rowsIn(p, 'users u', 'u.id', 'u.created_at', from, to, ` AND ${personSql('u')}`)} u),
     steps AS (
       SELECT EXISTS(SELECT 1 FROM design_files f WHERE f.user_id=s.id) AS file,
         EXISTS(SELECT 1 FROM admin_activity a WHERE a.user_id=s.id AND a.created_at>=to_char(n.next-interval '1 day','YYYY-MM-DD')
                AND ${sqlTime('a.created_at')}>=n.next) AS back
       FROM signed s CROSS JOIN LATERAL (SELECT (date_trunc('day',${moscowWall('s.at')})+interval '1 day'-interval '3 hours') AT TIME ZONE 'UTC' AS next) n
     )
     SELECT count(*)::int AS signed_up,count(*) FILTER(WHERE file)::int AS made_file,count(*) FILTER(WHERE file AND back)::int AS came_back
     FROM steps`,
    p.values,
  ))!;
  return Object.keys(FUNNEL_LABELS).map(key => ({key, label: FUNNEL_LABELS[key], value: Number(steps[key])}));
}

/** The weekly cohorts of the last COHORT_WEEKS whole Moscow weeks (the current week has not ended): the leading weeks nobody signed up
 *  in are left out. */
async function cohorts(sql: SqlExecutor, now: Date): Promise<AdminCohort[]> {
  const current = weekOf(moscowDate(now.toISOString())),
    first = addDays(current, -7 * COHORT_WEEKS);
  const start = moscowDateStart(first),
    end = moscowDateStart(current);
  const p = new Params(),
    origin = p.add(start);
  const week = (at: string) => `floor(extract(epoch FROM ${at}-${origin}::timestamptz)/${WEEK_MS / 1000})::int`;
  const rows = await sql.many<{w: number; k: number | null; n: number}>(
    `WITH cohort AS (SELECT u.id,${week('u.at')} AS w FROM ${rowsIn(p, 'users u', 'u.id', 'u.created_at', start, end, ` AND ${personSql('u')}`)} u),
     seen AS (SELECT DISTINCT c.id,c.w,${week('a.at')} AS k FROM cohort c
              CROSS JOIN LATERAL ${rowsIn(p, 'admin_activity a', 'a.user_id', 'a.created_at', start, end, ' AND a.user_id=c.id')} a)
     SELECT w,NULL::int AS k,count(*)::int AS n FROM cohort GROUP BY w
     UNION ALL SELECT w,k-w,count(*)::int FROM seen GROUP BY w,k`,
    p.values,
  );
  const size = (w: number) => rows.find(row => row.w === w && row.k === null)?.n ?? 0;
  const seen = (w: number, k: number) => rows.find(row => row.w === w && row.k === k)?.n ?? 0;
  const list: AdminCohort[] = [];
  for (let w = 0; w < COHORT_WEEKS; w++) {
    const n = size(w);
    if (!n && !list.length) continue;
    list.push({
      week: addDays(first, 7 * w),
      size: n,
      active: Array.from({length: COHORT_WEEKS - w}, (_, k) => share(seen(w, k), n)),
    });
  }
  return list;
}

/** What needs the operator now, the most urgent first; only kinds with something to show. */
async function alerts(sql: SqlExecutor): Promise<AdminAlert[]> {
  const p = new Params();
  const row = (await sql.one<Row>(
    `WITH ${accountCtes(p)} SELECT (SELECT count(*)::int FROM accounts WHERE deletion_requested_at IS NOT NULL) AS closing`,
    p.values,
  ))!;
  const list: AdminAlert[] = [{kind: 'closing', tone: 'info', count: row.closing}];
  return list.filter(alert => alert.count > 0).sort((x, y) => TONES.indexOf(x.tone) - TONES.indexOf(y.tone));
}
