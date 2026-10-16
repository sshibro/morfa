import {db} from '../db';
import {mailEnabled} from '../mail';
import {isNameAddress} from '../../shared/sign-in';
import type {SqlExecutor} from '../postgresql/client';
import type {UserRow} from '../auth';
import {
  SUPPORT_ONLINE_WINDOW_MS,
  SUPPORT_REPLY_STATS_DAYS,
  SUPPORT_REPLY_STATS_MIN,
  SUPPORT_TEAM_NAME,
  type SupportTeam,
} from '../../shared/support';
import {isOperator, operatorEntries} from '../admin/operators';

// Who answers the support chat, told truthfully (shared/support.ts SupportTeam): Morfa's team, while MORFA_OPERATORS names an
// operator (never an operator's name: the person reads "Morfa team"); whether one of them used the console's support routes
// within SUPPORT_ONLINE_WINDOW_MS (support_operator_presence, so every API process agrees);
// and how long an answer usually takes, measured: the median wait from a person's first unanswered message to the operator's next
// answer over the last SUPPORT_REPLY_STATS_DAYS days, only from SUPPORT_REPLY_STATS_MIN answers on (null below: nothing is promised).

/** An operator's presence is written at most this often (the console polls every few seconds). */
const PRESENCE_EVERY_MS = 30_000;
/** The median is read again after this long (every open chat asks for the team every few seconds). */
const STATS_FOR_MS = 5 * 60_000;

type OperatorRow = Pick<
  UserRow,
  'id' | 'name' | 'email' | 'email_verified' | 'deletion_requested_at' | 'erasure_completed_at'
> & {
  seen_at: string | null;
  online: boolean;
};

/** The operators' accounts, in MORFA_OPERATORS's order, each with whether it was seen within the window. */
export async function supportOperators(sql: SqlExecutor, env: NodeJS.ProcessEnv = process.env) {
  const entries = operatorEntries(env);
  if (!entries.length) return [];
  const rows = await sql.many<OperatorRow>(
    `SELECT u.id,u.name,u.email,u.email_verified,u.deletion_requested_at,u.erasure_completed_at,p.seen_at,
       COALESCE(p.seen_at>clock_timestamp()-make_interval(secs=>$2::int/1000.0),false) AS online
     FROM users u LEFT JOIN support_operator_presence p ON p.user_id=u.id
     WHERE u.id=ANY($1::text[]) OR u.email=ANY($1::text[])`,
    [entries, SUPPORT_ONLINE_WINDOW_MS],
  );
  const rank = (row: OperatorRow) => {
    const byId = entries.indexOf(row.id);
    return byId >= 0 ? byId : entries.indexOf(row.email.trim().toLowerCase());
  };
  return rows
    .filter(row => isOperator(row, env))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .map(row => ({id: row.id, name: row.name.trim(), online: row.online}));
}

/**
 * The median minutes from a person's first message after the previous answer (or the conversation's start) to the operator's next
 * answer, over the answers of the last SUPPORT_REPLY_STATS_DAYS days; null with fewer than SUPPORT_REPLY_STATS_MIN of them. An answer
 * that follows another answer (nobody was waiting) is not a sample.
 */
export async function measureTypicalReply(sql: SqlExecutor): Promise<number | null> {
  const row = await sql.one<{samples: number; median: number | null}>(
    `SELECT count(*)::int AS samples,percentile_cont(0.5) WITHIN GROUP (ORDER BY waited) AS median FROM (
       SELECT extract(epoch FROM o.created_at-asked.at)/60 AS waited
       FROM support_messages o
       CROSS JOIN LATERAL (
         SELECT max(p.created_at) AS at FROM support_messages p
         WHERE p.thread_id=o.thread_id AND p.created_at<o.created_at
           AND p.author='operator'
       ) answered
       CROSS JOIN LATERAL (
         SELECT min(u.created_at) AS at FROM support_messages u WHERE u.thread_id=o.thread_id AND u.author='user'
           AND u.created_at<o.created_at AND u.created_at>COALESCE(answered.at,'-infinity')
       ) asked
       WHERE o.author='operator' AND o.created_at>clock_timestamp()-make_interval(days=>$1::int) AND asked.at IS NOT NULL
     ) waits`,
    [SUPPORT_REPLY_STATS_DAYS],
  );
  if (!row || row.samples < SUPPORT_REPLY_STATS_MIN || row.median === null) return null;
  return Math.max(1, Math.round(Number(row.median)));
}

let stats: {at: number; minutes: Promise<number | null>} | null = null;
/** measureTypicalReply, read again every few minutes. */
export function typicalReplyMinutes(sql: SqlExecutor = db, now = Date.now()): Promise<number | null> {
  if (!stats || now - stats.at > STATS_FOR_MS) {
    const minutes = measureTypicalReply(sql).catch(() => null);
    stats = {at: now, minutes};
  }
  return stats.minutes;
}
/** Tests measure again at once. */
export const resetSupportStats = () => void (stats = null);

type Person = Pick<UserRow, 'email' | 'email_verified'>;
/** Letters reach the person's address: a real-looking one, proven. A name account's address (shared/sign-in.ts) is no mailbox. */
export function supportMailReaches(person: Person, env: NodeJS.ProcessEnv = process.env): boolean {
  const email = person.email.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.endsWith('@invalid.local') || isNameAddress(email)) return false;
  return !!person.email_verified || env.NODE_ENV !== 'production';
}

/** The team the person sees (GET /api/support). */
export async function supportTeam(
  sql: SqlExecutor,
  person: Person,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SupportTeam> {
  const [operators, minutes] = await Promise.all([supportOperators(sql, env), typicalReplyMinutes()]);
  return {
    operators: operators.length ? [{name: SUPPORT_TEAM_NAME}] : [],
    online: operators.some(operator => operator.online),
    typicalReplyMinutes: minutes,
    emailFollowUp: mailEnabled(env) && supportMailReaches(person, env),
  };
}

const presence = new Map<string, number>();
/** The operator used the console's support routes now (written at most every PRESENCE_EVERY_MS per process and in the table). */
export async function recordOperatorPresence(operatorId: string, now = Date.now()): Promise<void> {
  const last = presence.get(operatorId);
  if (last !== undefined && now - last < PRESENCE_EVERY_MS) return;
  presence.set(operatorId, now);
  await db.execute(
    `INSERT INTO support_operator_presence(user_id) VALUES($1)
     ON CONFLICT(user_id) DO UPDATE SET seen_at=clock_timestamp()
     WHERE support_operator_presence.seen_at<clock_timestamp()-make_interval(secs=>$2::int/1000.0)`,
    [operatorId, PRESENCE_EVERY_MS],
  );
}
/** Tests write presence again at once. */
export const resetPresenceThrottle = () => presence.clear();
