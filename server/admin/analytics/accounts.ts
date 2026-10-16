import type {SqlExecutor} from '../../postgresql/client';
import {ACCOUNT_SEGMENTS, ADMIN_ACCOUNTS_PAGE_SIZE} from '../../../shared/admin-analytics';
import type {AccountSegment, AdminAccountSort, AdminAccountsPage} from '../../../shared/admin-analytics';
import {sqlTime} from '../sql-time';
import {accountRows} from './rows';
import {accountCtes} from './segments';
import {Params} from './window';

/* GET /api/admin/accounts: the accounts tab. The search, the segment tabs' counts and the page's order are set-based statements over every
 * live account; only the page's rows are then read in full (rows.ts). */

export type AccountsQuery = {
  q: string;
  segment: AccountSegment | 'all';
  sort: AdminAccountSort;
  order: 'asc' | 'desc';
  page: number;
};

/** What each sort orders by, and the CTE it joins as `k` (the values the rows show: rows.ts reads the same CTEs). */
const SORTS: Readonly<Record<AdminAccountSort, {join: string; key: string}>> = {
  created: {join: '', key: sqlTime('u.created_at')},
  // The newest journal row as the index orders its text: one index-only probe an account. It is the newest instant for the one shape a
  // journal writes (telemetry's ISO); rows.ts shows the exact one.
  active: {
    join: 'LEFT JOIN LATERAL (SELECT max(a.created_at) AS at FROM admin_activity a WHERE a.user_id=u.id) k ON true',
    key: 'k.at',
  },
  files: {join: 'LEFT JOIN files k ON k.id=u.id', key: 'COALESCE(k.live,0)'},
  storage: {join: 'LEFT JOIN storage k ON k.id=u.id', key: 'COALESCE(k.bytes,0)'},
};

/** `q` as a bound ILIKE pattern: a substring, its own `%`, `_` and `\` taken literally. */
export const containsPattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
/** The search: the name, the e-mail or the id contains `q`, without regard to case (Cyrillic included: pg_c_utf8 folds it, "C" does not). */
function matching(p: Params, q: string): string {
  if (!q) return 'true';
  const pattern = p.add(containsPattern(q));
  return ['u.name', 'u.email', 'u.id']
    .map(column => `${column} COLLATE pg_c_utf8 ILIKE ${pattern} ESCAPE '\\'`)
    .join(' OR ');
}

export async function adminAccounts(sql: SqlExecutor, query: AccountsQuery, now: Date): Promise<AdminAccountsPage> {
  const c = new Params();
  const tallies = await sql.many<{segment: AccountSegment; n: number}>(
    `WITH ${accountCtes(c)}
     SELECT s.segment,count(*)::int AS n FROM segments s JOIN users u ON u.id=s.id WHERE ${matching(c, query.q)} GROUP BY s.segment`,
    c.values,
  );
  const counts = Object.fromEntries([...ACCOUNT_SEGMENTS, 'all'].map(key => [key, 0])) as AdminAccountsPage['counts'];
  for (const {segment, n} of tallies) {
    counts[segment] = n;
    counts.all += n;
  }
  const p = new Params(),
    sort = SORTS[query.sort],
    direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const segment = query.segment === 'all' ? '' : ` AND s.segment=${p.add(query.segment)}`;
  const ids = await sql.many<{id: string}>(
    `WITH ${accountCtes(p)}
     SELECT u.id FROM segments s JOIN users u ON u.id=s.id ${sort.join}
     WHERE (${matching(p, query.q)})${segment}
     ORDER BY ${sort.key} ${direction} NULLS LAST,u.id ${direction}
     LIMIT ${p.add(ADMIN_ACCOUNTS_PAGE_SIZE)} OFFSET ${p.add((query.page - 1) * ADMIN_ACCOUNTS_PAGE_SIZE)}`,
    p.values,
  );
  return {
    rows: await accountRows(
      sql,
      ids.map(row => row.id),
      now,
    ),
    total: counts[query.segment],
    page: query.page,
    pageSize: ADMIN_ACCOUNTS_PAGE_SIZE,
    counts,
  };
}
