import type {Row} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import type {AccountSegment, AdminAccountRow} from '../../../shared/admin-analytics';
import {sqlTime} from '../sql-time';
import {accountCtes, lastActiveSql} from './segments';
import {daysStart, lastDays, moscowDaySql, Params, rowsIn} from './window';

/* An account as every list of the console shows it (AdminAccountRow), for a page of ids at once: two statements whatever the page's
 * size, each reading through the accounts' own indexes. */

/** The rows of `ids` that are live accounts, in the order of `ids`. "The last 30 days" are the 30 Moscow dates ending today. */
export async function accountRows(sql: SqlExecutor, ids: readonly string[], now: Date): Promise<AdminAccountRow[]> {
  if (!ids.length) return [];
  const p = new Params();
  const rows = await sql.many<Row>(
    `WITH ${accountCtes(p, ids)}
     SELECT u.id,u.name,u.email,u.email_verified=1 AS email_verified,${sqlTime('u.created_at')} AS created_at,u.created_at AS created_text,
       ${lastActiveSql('u.id')} AS last_active,s.segment,
       COALESCE(f.live,0) AS files,COALESCE(st.bytes,0) AS storage,COALESCE(tm.n,0) AS teams
     FROM segments s JOIN users u ON u.id=s.id LEFT JOIN files f ON f.id=u.id LEFT JOIN storage st ON st.id=u.id LEFT JOIN teams tm ON tm.id=u.id`,
    p.values,
  );
  const days = lastDays(now, 30),
    a = new Params();
  const activity = await sql.many<{id: string; day: string; n: number}>(
    `SELECT x.user_id AS id,${moscowDaySql('x.at')} AS day,count(*)::int AS n
     FROM ${rowsIn(a, 'admin_activity a', 'a.user_id', 'a.created_at', daysStart(days), now.toISOString(), ` AND a.user_id=ANY(${a.add(ids)}::text[])`)} x
     GROUP BY 1,2`,
    a.values,
  );
  const perDay = new Map(activity.map(r => [`${r.id} ${r.day}`, r.n]));
  const byId = new Map(
    rows.map(r => {
      const activity30d = days.map(day => perDay.get(`${r.id} ${day}`) ?? 0);
      const row: AdminAccountRow = {
        id: r.id,
        name: r.name,
        email: r.email,
        emailVerified: r.email_verified,
        createdAt: r.created_at ?? r.created_text,
        lastActiveAt: r.last_active ?? null,
        segment: r.segment as AccountSegment,
        activeDays30d: activity30d.filter(n => n > 0).length,
        activity30d,
        files: Number(r.files),
        storageBytes: Number(r.storage),
        teams: Number(r.teams),
      };
      return [r.id as string, row];
    }),
  );
  return ids.flatMap(id => byId.get(id) ?? []);
}
