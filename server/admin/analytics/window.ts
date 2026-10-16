import {ADMIN_PERIOD_DAYS} from '../../../shared/admin-analytics';
import type {AdminDayPoint, AdminMetric, AdminPeriod, AdminSlice, AdminWindow} from '../../../shared/admin-analytics';
import {MOSCOW_OFFSET_MS} from '../../../shared/moscow-calendar';
import {ONE_DAY_MS} from '../../time-constants';
import {sqlTime} from '../sql-time';

/* What every report of the operator's console (shared/admin-analytics.ts) is measured in: the window and its Moscow days, the bound
 * parameters of a statement, and the SQL that reads the journal's text timestamps by day. Pure; the clock is always the caller's. */

/** The report's window: [now - days, now), and the same length right before it. */
export function adminWindow(period: AdminPeriod, now: Date): AdminWindow {
  const days = ADMIN_PERIOD_DAYS[period],
    to = now.getTime(),
    from = to - days * ONE_DAY_MS;
  return {period, from: iso(from), to: iso(to), previousFrom: iso(from - days * ONE_DAY_MS), days};
}
export const iso = (ms: number) => new Date(ms).toISOString();
/** The Moscow calendar date of an instant: "2026-10-09". */
export const moscowDate = (instant: string): string => new Date(Date.parse(instant) + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
/** The instant a Moscow calendar date ("2026-10-09") begins. */
export const moscowDateStart = (date: string): string => new Date(Date.parse(date + 'T00:00:00.000Z') - MOSCOW_OFFSET_MS).toISOString();
/** The Moscow date `days` days after `day` (before it when negative). */
export const addDays = (day: string, days: number) =>
  new Date(Date.parse(day + 'T00:00:00.000Z') + days * ONE_DAY_MS).toISOString().slice(0, 10);
/** Every Moscow date from `first` to `last`, both included, oldest first. */
export function daysFrom(first: string, last: string): string[] {
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}
/** The Moscow dates a window touches: the day of `from` to the day of its last instant (a dense series has a point for each). */
export const windowDays = (window: {from: string; to: string}) =>
  daysFrom(moscowDate(window.from), moscowDate(iso(Date.parse(window.to) - 1)));
/** "The last `count` days" of an account: the `count` Moscow dates that end with today's (the day of `now`). */
export const lastDays = (now: Date, count: number) => {
  const today = moscowDate(now.toISOString());
  return daysFrom(addDays(today, 1 - count), today);
};
/** The instant the first of `days` begins: the start of "the last N days". */
export const daysStart = (days: readonly string[]) => moscowDateStart(days[0]);
/** The Monday that begins the Moscow week of `day`. */
export function weekOf(day: string): string {
  const weekday = (new Date(day + 'T00:00:00.000Z').getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

/** Sparse rows of (day, value) as one point per day of `days`, zeros included. */
export function dense(days: readonly string[], rows: ReadonlyArray<{day: string; value: unknown}>): AdminDayPoint[] {
  const values = new Map(rows.map(row => [row.day, Number(row.value)]));
  return days.map(day => ({day, value: values.get(day) ?? 0}));
}
export const metric = (value: unknown, previous: unknown): AdminMetric => ({
  value: Number(value ?? 0),
  previous: previous === null ? null : Number(previous ?? 0),
});
/** A share 0..1 to four places; 0 of nothing. */
export const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 10000 : 0);

/** Slices of `rows` (key, value): every key of `fixed` first, in that order and zeros included, then any other key that has a value,
 *  largest first. Labels from `labels`, the key itself for one it does not know. */
export function slices(
  rows: ReadonlyArray<{key: string | null; value: unknown}>,
  labels: Readonly<Record<string, string>>,
  fixed: readonly string[] = [],
): AdminSlice[] {
  const values = new Map<string, number>();
  for (const row of rows) values.set(row.key ?? '', (values.get(row.key ?? '') ?? 0) + Number(row.value ?? 0));
  const rest = [...values.keys()]
    .filter(key => !fixed.includes(key) && values.get(key)! !== 0)
    .sort((a, b) => values.get(b)! - values.get(a)! || (a < b ? -1 : 1));
  return [...fixed, ...rest].map(key => ({key, label: labels[key] ?? key, value: values.get(key) ?? 0}));
}

/** The bound parameters of one statement: `add` takes a value and returns its placeholder. Nothing a request sends reaches SQL any other
 *  way. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** The Moscow wall clock of a timestamptz expression (Moscow keeps UTC+3 all year, shared/moscow-calendar.ts). */
export const moscowWall = (expr: string) => `((${expr}) AT TIME ZONE 'UTC'+interval '3 hours')`;
/** The Moscow date of a timestamptz expression, as 'YYYY-MM-DD' text. */
export const moscowDaySql = (expr: string) => `to_char(${moscowWall(expr)},'YYYY-MM-DD')`;
const utcDate = (ms: number) => iso(ms).slice(0, 10);
/** Both shapes a text timestamp takes, 'YYYY-MM-DD HH24:MI:SS' and ISO, begin with the date: a range of whole days a day wider on each
 *  side (an offset moves the written date by at most one) holds every instant of [from, to), and the column's index (admin_activity_user, …) serves it. */
const textDays = (p: Params, column: string, from: string, to: string) =>
  `${column}>=${p.add(utcDate(Date.parse(from) - ONE_DAY_MS))} AND ${column}<${p.add(utcDate(Date.parse(to) + 2 * ONE_DAY_MS))}`;
/** A text timestamp `column` (trusted) in [from, to): its days first; a row written on a date two days inside either end is in the window
 *  whatever its shape, and only the rest are read as instants (once). */
export function textTimeIn(p: Params, column: string, from: string, to: string): string {
  const inside = `${column}>=${p.add(utcDate(Date.parse(from) + 2 * ONE_DAY_MS))} AND ${column}<${p.add(utcDate(Date.parse(to) - 2 * ONE_DAY_MS))}`;
  return `${textDays(p, column, from, to)}
    AND CASE WHEN ${inside} THEN true ELSE tstzrange(${p.add(from)}::timestamptz,${p.add(to)}::timestamptz)@>${sqlTime(column)} END`;
}
/**
 * The rows of `source` (a trusted table and its alias) whose text timestamp `column` is in [from, to): the `columns` asked for and that
 * instant as `at`, read once per row (`OFFSET 0` keeps the planner from copying the conversion into every place `at` is used). Only the
 * columns asked for are read, so an index that holds them all (admin_activity_user: user_id, created_at) can serve them alone. `where`
 * adds conditions on the source's own columns (` AND a.user_id=…`). Name the result: `FROM ${rowsIn(…)} x`.
 */
export function rowsIn(
  p: Params,
  source: string,
  columns: string,
  column: string,
  from: string,
  to: string,
  where = '',
): string {
  return `(SELECT * FROM (SELECT ${columns},${sqlTime(column)} AS at FROM ${source} WHERE ${textDays(p, column, from, to)}${where} OFFSET 0) t
    WHERE t.at>=${p.add(from)}::timestamptz AND t.at<${p.add(to)}::timestamptz)`;
}
/** A timestamptz expression in [from, to). */
export const timeIn = (p: Params, expr: string, from: string, to: string) =>
  `${expr}>=${p.add(from)}::timestamptz AND ${expr}<${p.add(to)}::timestamptz`;
