import {db} from '../db';
import {ONE_SECOND_MS} from '../time-constants';
import type {AdminOverview, AdminPeriod, AdminUsage} from '../../shared/admin-analytics';
import type {TransactionContext} from '../postgresql/client';
import {adminOverview} from './analytics/overview';
import {adminUsage} from './analytics/usage';

/* How the console reads its reports (server/admin/router.ts): one read-only snapshot per report, the period reports remembered
 * for a few seconds per period, so a console left open, or several of them, read the database once. */

/** Overview and usage are remembered this long per period. */
const MEMO_MS = 15 * ONE_SECOND_MS;
/** One operator at a time reads (the reports are remembered), so its own read-only transaction may sort in more memory than a request's. */
const REPORT_WORK_MEM = '64MB';

/** Every report reads one snapshot, so its numbers agree with each other, with room to group and sort in memory (the journal runs to
 *  millions of rows, which the default 4 MB would spill to disk). */
export const snapshot = <T>(work: (tx: TransactionContext) => Promise<T>) =>
  db.transaction(
    async tx => {
      await tx.execute(`SET LOCAL work_mem='${REPORT_WORK_MEM}'`);
      return work(tx);
    },
    {isolation: 'repeatable read', readOnly: true},
  );

const memos = new Map<string, {until: number; value: Promise<unknown>}>();
export function remembered<T>(key: string, read: () => Promise<T>): Promise<T> {
  const at = Date.now(),
    hit = memos.get(key);
  if (hit && hit.until > at) return hit.value as Promise<T>;
  const value = read();
  memos.set(key, {until: at + MEMO_MS, value});
  // A failed read is not remembered.
  value.catch(() => {
    if (memos.get(key)?.value === value) memos.delete(key);
  });
  return value;
}
/** Test seam: forget what was remembered. */
export const forgetAdminReports = () => memos.clear();

export type PeriodReports = {overview: AdminOverview; usage: AdminUsage};
export type PeriodReportName = keyof PeriodReports;
export const PERIOD_REPORTS: {
  readonly [K in PeriodReportName]: (
    tx: TransactionContext,
    period: AdminPeriod,
    now: Date,
  ) => Promise<PeriodReports[K]>;
} = {
  overview: adminOverview,
  usage: adminUsage,
};

/** A period report as GET /api/admin/<name>?period= answers it (remembered per period). */
export const periodReport = <K extends PeriodReportName>(name: K, period: AdminPeriod): Promise<PeriodReports[K]> =>
  remembered(`${name}:${period}`, () => snapshot(tx => PERIOD_REPORTS[name](tx, period, new Date())));
