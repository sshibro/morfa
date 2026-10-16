// Morfa's telemetry, cut to what the server needs today: the request context, the
// activity journal (admin_activity) the operator's console reads (server/admin/analytics), the operator's cost settings the design AI
// reads, and error and issue reports. Every write here is best effort, made after the business transaction committed, and never fails
// the request it describes. Errors and operator alerts go to the process log as one sanitized JSON line each.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {db, type Row} from '../db';
import type {SqlExecutor, TransactionContext} from '../postgresql/client';
import {lockResources} from '../postgresql/locks';
import {ONE_DAY_MS, ONE_MINUTE_MS} from '../time-constants';
import {maskDesignInvite, sanitize} from './sanitize';
export {sanitize};

/** What the current request is: set by requestTelemetry (server/app.ts) for everything a request does. */
export const context = new AsyncLocalStorage<{accountId?: string; requestId: string; operation: string}>();
export const now = () => new Date().toISOString();

/** The journal keeps this many days (the console's year, and the cohorts before it): the maintenance pass deletes what is older. */
export const ACTIVITY_RETENTION_DAYS = 400;
/** A safety net, never the journal's limit (retention is): past this many rows new ones are dropped, and counted in the log. */
const ACTIVITY_CAP = 20_000_000;
/** How often a process reads the journal's size: the planner's estimate (pg_class.reltuples, kept by autovacuum), never a count. */
const SIZE_EVERY_MS = 5 * ONE_MINUTE_MS;
/** The retention pass deletes this many rows a statement. */
const PRUNE_BATCH = 50_000;
const ACTION_CHARS = 200;
/** UUID-shaped ids in a route: replaced, so the journal records the kind of request, not which file. */
const ROUTE_ID = /[a-f\d]{8}-[a-f\d-]{27,}/gi;

const pending = new Set<Promise<unknown>>();
let dropped = 0;
let activityCap = ACTIVITY_CAP;
let size = {rows: 0, readAt: -Infinity};

/** A request's route as the journal and the log keep it: query dropped, bearer tokens and ids masked, scrubbed. */
export function safeRoute(value: string): string {
  const route = maskDesignInvite(value.split(/[?#]/)[0]).replace(ROUTE_ID, ':id');
  return sanitize(route, 500).replace(ROUTE_ID, ':id');
}

/** Awaitable best-effort work in its own transaction, never retried; drainTelemetry waits for all of it. */
export function safely<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T | undefined> {
  const work = db.transaction(run).catch(() => {
    dropped++;
    return undefined;
  });
  pending.add(work);
  void work.finally(() => pending.delete(work));
  return work;
}

export async function drainTelemetry(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** When this process last saw each account's action in the journal (a row it wrote, or one it found): the same action within a minute
 *  of it is skipped before any database work. Every request of a signed-in account comes here (lane B6 measured the journal's lock as
 *  the file list's queue, TARGETS A1), and an editor's autosave PUTs come every few seconds. */
const recent = new Map<string, number>();
const RECENT_KEPT = 10_000;
function remember(key: string, at: number) {
  recent.delete(key);
  recent.set(key, at);
  if (recent.size > RECENT_KEPT)
    for (const old of recent.keys()) {
      recent.delete(old);
      if (recent.size <= RECENT_KEPT / 2) break;
    }
}
/** Test seam: forget what this process knows of the journal (its recent actions, its size), and set the safety cap. */
export function resetActivityJournal(cap: number = ACTIVITY_CAP) {
  recent.clear();
  size = {rows: 0, readAt: -Infinity};
  activityCap = cap;
}

/** Whether the journal is past its safety cap, by its size estimate, read at most every SIZE_EVERY_MS. */
async function journalFull(tx: SqlExecutor): Promise<boolean> {
  const at = Date.parse(now());
  if (at - size.readAt >= SIZE_EVERY_MS) {
    const row = await tx.one<{rows: number}>(
      "SELECT reltuples::float8 AS rows FROM pg_class WHERE oid='public.admin_activity'::regclass",
    );
    // -1: never analyzed yet, so small.
    size = {rows: Math.max(0, Number(row?.rows ?? 0)), readAt: at};
  }
  return size.rows >= activityCap;
}

/**
 * One row in the activity journal for a live account: `action` is 'read' for any GET, else the request's masked route. Each action is
 * recorded at most once a minute per account: an editor's autosave is a row a minute, not one every few seconds. Only the account's lock
 * is taken: it orders the row after the account's closure and before its erasure, and makes the minute's check and the write one step.
 */
export function recordActivity(accountId: string, action: string): Promise<void | undefined> {
  const name = sanitize(action, ACTION_CHARS).slice(0, ACTION_CHARS),
    key = accountId + ' ' + name;
  const seen = recent.get(key);
  if (seen !== undefined && Date.parse(now()) - seen < ONE_MINUTE_MS) return Promise.resolve(undefined);
  let written: number | null = null;
  const work = safely(async tx => {
    await lockResources(tx, [{kind: 'account', id: accountId}]);
    if (!(await tx.one('SELECT 1 FROM users WHERE id=$1 AND deletion_requested_at IS NULL', [accountId]))) return;
    const at = now();
    // The account's rows of the last minute only, through the journal's index (user_id, created_at); the journal writes ISO text.
    const last = await tx.one<{created_at: string | null}>(
      'SELECT max(created_at) AS created_at FROM admin_activity WHERE user_id=$1 AND created_at>=$2 AND action=$3',
      [accountId, new Date(Date.parse(at) - ONE_MINUTE_MS).toISOString(), name],
    );
    if (last?.created_at) {
      remember(key, Date.parse(last.created_at));
      return;
    }
    if (await journalFull(tx)) {
      dropped++;
      return;
    }
    await tx.execute('INSERT INTO admin_activity(id,user_id,action,created_at) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      accountId,
      name,
      at,
    ]);
    written = Date.parse(at);
  });
  // Remembered once the row is committed (a rolled-back write leaves nothing to dedupe against).
  return work.then(() => {
    if (written !== null) remember(key, written);
  });
}

/**
 * The journal's retention, run by the maintenance pass (server/launch/lifecycle.ts): the rows written before the date
 * ACTIVITY_RETENTION_DAYS ago go, a batch a statement, so none runs long on a journal of millions of rows. Returns how many went.
 */
export async function pruneActivity(at: Date = new Date()): Promise<number> {
  // A date alone sorts before every timestamp of that day in either text shape: the cutoff's own day stays whole.
  const before = new Date(at.getTime() - ACTIVITY_RETENTION_DAYS * ONE_DAY_MS).toISOString().slice(0, 10);
  let total = 0;
  for (;;) {
    const {changes} = await db.execute(
      'DELETE FROM admin_activity WHERE id IN (SELECT id FROM admin_activity WHERE created_at<$1 LIMIT $2)',
      [before, PRUNE_BATCH],
    );
    total += changes;
    if (changes < PRUNE_BATCH) return total;
  }
}

export type IssueSource = 'backend' | 'worker' | 'browser';
export type IssueSeverity = 'error' | 'warning' | 'info';
export type DiagnosticEvent = {
  eventId: string;
  timestamp: string;
  buildId: string;
  name: string;
  message: string;
  route?: string;
  kind?: string;
  stack?: string;
};
export type IssueOwner = {source: IssueSource; trusted: boolean; severity: IssueSeverity; accountId?: string};

/** Repeats of one event id within this process are logged once. */
const seenEvents = new Set<string>();
const SEEN_EVENTS_CAP = 10_000;

function writeLog(record: Record<string, unknown>): void {
  console.error(JSON.stringify({at: now(), ...record}));
}

/** An operator alert or a diagnosed failure, as one log line. Never throws. */
export async function recordIssue(event: DiagnosticEvent, owner: IssueOwner): Promise<void> {
  try {
    if (seenEvents.has(event.eventId)) return;
    if (seenEvents.size >= SEEN_EVENTS_CAP) seenEvents.clear();
    seenEvents.add(event.eventId);
    writeLog({
      issue: sanitize(event.name, 120),
      message: sanitize(event.message, 1000),
      route: event.route ? safeRoute(event.route) : undefined,
      kind: event.kind,
      source: owner.source,
      severity: owner.severity,
      build: sanitize(event.buildId, 80),
    });
  } catch {
    /* Telemetry never fails its caller. */
  }
}

/** A server error, logged with the request it happened in (route and request id, never the body or the account's data). */
export async function captureError(
  error: unknown,
  source: IssueSource = 'backend',
  details: {fatal?: boolean} = {},
): Promise<void> {
  try {
    const failure = error instanceof Error ? error : Error(String(error));
    const request = context.getStore();
    writeLog({
      error: sanitize(failure.name, 120),
      message: sanitize(failure.message, 1000),
      stack: sanitize(failure.stack?.split('\n').slice(1, 8).join('\n') ?? '', 2000),
      route: request ? safeRoute(request.operation) : undefined,
      requestId: request?.requestId,
      source,
      fatal: details.fatal || undefined,
      dropped: dropped || undefined,
    });
  } catch {
    /* Telemetry never fails its caller. */
  }
}
