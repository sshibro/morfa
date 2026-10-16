import {randomUUID} from 'node:crypto';
import {db} from '../db';
import {prepared, type SqlExecutor, type TransactionContext} from '../postgresql/client';
import {exportRows} from '../launch/export-json';
import {
  SUPPORT_MESSAGES_PAGE,
  SUPPORT_TYPING_MS,
  type SupportAuthor,
  type SupportContext,
  type SupportConversation,
  type SupportInbox,
  type SupportInboxFilter,
  type SupportInboxRow,
  type SupportMessage,
  type SupportThreadStatus,
  type SupportThreadView,
} from '../../shared/support';
import type {MessageInput} from './input';

// The support chat's rows (SQL019): one conversation per account, its messages, and what each side has read. Every write of a
// conversation holds its row's lock (FOR UPDATE, or the UPDATE itself), so messages, reads and status changes of one conversation
// are serialized and each message's clock_timestamp() follows the one before it. A send names its key (`client_id`): the same key
// again is the same message, answered without a second row. Instants leave as UTC ISO strings with milliseconds. An operator's
// message carries the name of the operator who wrote it, so the person sees who answered.

const ISO = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** The inbox lists at most this many conversations. */
export const SUPPORT_INBOX_ROWS = 100;
/** Closing accounts are not in the inbox: they cannot read an answer, and the next maintenance pass erases them. */
const LIVE_ACCOUNT = 'u.deletion_requested_at IS NULL AND u.erasure_completed_at IS NULL';

export type SupportAccount = {id: string; name: string; email: string};
type ThreadRow = {
  id: string;
  status: SupportThreadStatus;
  operatorReadAt: string | null;
  unread: number;
  typing: boolean;
};

/** The newest SUPPORT_MESSAGES_PAGE messages of a conversation, oldest first, each operator's with the operator's name. */
const MESSAGES = `SELECT m.id,m.author,m.body,m.context,${ISO('m.created_at')} AS "createdAt",o.name AS "authorName" FROM (
    SELECT id,author,body,context,created_at,operator_id FROM support_messages WHERE thread_id=$1
    ORDER BY created_at DESC,id DESC LIMIT ${SUPPORT_MESSAGES_PAGE}
  ) m LEFT JOIN users o ON o.id=m.operator_id ORDER BY m.created_at,m.id`;

const contextOf = (value: unknown): SupportContext | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>,
    context: SupportContext = {};
  if (typeof source.fileId === 'string') context.fileId = source.fileId;
  if (typeof source.where === 'string') context.where = source.where as SupportContext['where'];
  return Object.keys(context).length ? context : undefined;
};

type MessageRow = Omit<SupportMessage, 'authorName'> & {
  context: unknown;
  authorName: string | null;
};
const messagesOf = (sql: SqlExecutor, threadId: string) => sql.many<MessageRow>(MESSAGES, [threadId]);
/** A message as both sides read it: an operator's names its author when the account has a name (the console's only: the person
 *  reads the team's answers, shared/support.ts SupportTeam). */
function messageOf({id, author, body, createdAt, authorName}: MessageRow): SupportMessage {
  if (author === 'operator' && authorName?.trim()) return {id, author, body, createdAt, authorName: authorName.trim()};
  return {id, author, body, createdAt};
}

/* ── The person's side ─────────────────────────────────────────────────────────────────────────── */

// Polled every few seconds by an open chat and every minute by the help button's badge: prepared.
const PERSON_THREAD = prepared(
  `SELECT t.id,t.status,${ISO('t.operator_read_at')} AS "operatorReadAt",
     (SELECT count(*)::int FROM support_messages m WHERE m.thread_id=t.id AND m.author='operator'
        AND (t.user_read_at IS NULL OR m.created_at>t.user_read_at)) AS unread,
     COALESCE(t.operator_typing_until>clock_timestamp(),false) AS typing
   FROM support_threads t WHERE t.user_id=$1`,
);
const PERSON_UNREAD = prepared(
  `SELECT count(*)::int AS n FROM support_threads t JOIN support_messages m ON m.thread_id=t.id AND m.author='operator'
     AND (t.user_read_at IS NULL OR m.created_at>t.user_read_at)
   WHERE t.user_id=$1`,
);

/** The person's conversation (null before its first message) and whether an operator is typing in it now. */
export type PersonConversation = Pick<SupportThreadView, 'thread' | 'operatorTyping'>;

/** GET /api/support: the account's conversation, null before its first message. */
export async function personConversation(sql: SqlExecutor, userId: string): Promise<PersonConversation> {
  const row = await sql.one<ThreadRow>(PERSON_THREAD, [userId]);
  if (!row) return {thread: null, operatorTyping: false};
  const {typing, ...thread} = row;
  const messages = (await messagesOf(sql, thread.id)).map(message => messageOf({...message, authorName: null}));
  return {thread: {...thread, messages}, operatorTyping: typing};
}

/** GET /api/support/unread: the operator's messages the person has not seen. */
export async function personUnread(sql: SqlExecutor, userId: string): Promise<number> {
  return (await sql.one<{n: number}>(PERSON_UNREAD, [userId]))?.n ?? 0;
}

/** What a send did: the conversation's view after it, and whether this request wrote the message (a retry of a key already sent did
 *  not). */
export type PersonSent = {threadId: string; created: boolean; conversation: PersonConversation};

/**
 * POST /api/support/messages. The first message makes the conversation; a message to a closed one opens it again. The person's
 * message starts the wait for an answer unless one is already running, and the person has read everything the answer shows.
 */
export async function sendPersonMessage(userId: string, input: MessageInput): Promise<PersonSent> {
  return db.transaction(async tx => {
    await tx.execute('INSERT INTO support_threads(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING', [
      randomUUID(),
      userId,
    ]);
    const thread = (await tx.one<{id: string}>('SELECT id FROM support_threads WHERE user_id=$1 FOR UPDATE', [
      userId,
    ]))!;
    const created = !(await sentBefore(tx, thread.id, 'user', input.clientId));
    if (created)
      await tx.execute(
        `WITH m AS (
           INSERT INTO support_messages(id,thread_id,author,body,client_id,context) VALUES($1,$2,'user',$3,$4,$5::jsonb) RETURNING created_at
         )
         UPDATE support_threads t SET status='open',updated_at=m.created_at,waiting_since=COALESCE(t.waiting_since,m.created_at),
           user_read_at=m.created_at
         FROM m WHERE t.id=$2`,
        [randomUUID(), thread.id, input.body, input.clientId, input.context ? JSON.stringify(input.context) : null],
      );
    return {threadId: thread.id, created, conversation: await personConversation(tx, userId)};
  });
}

/** POST /api/support/read: the person has seen everything up to now. False before the first message. */
export async function markPersonRead(userId: string): Promise<boolean> {
  return (
    (await db.execute('UPDATE support_threads SET user_read_at=clock_timestamp() WHERE user_id=$1', [userId])).changes >
    0
  );
}

const sentBefore = async (tx: TransactionContext, threadId: string, author: SupportAuthor, clientId: string) =>
  !!(await tx.one('SELECT 1 FROM support_messages WHERE thread_id=$1 AND author=$2 AND client_id=$3', [
    threadId,
    author,
    clientId,
  ]));

/* ── The operator's side ───────────────────────────────────────────────────────────────────────── */

/** Each filter's condition on `t` (shared/support.ts SupportInboxFilter) and its order. */
const FILTERS: Record<SupportInboxFilter, {where: string; order: string}> = {
  waiting: {
    where: "t.status='open' AND t.waiting_since IS NOT NULL",
    order: 't.waiting_since,t.id',
  },
  open: {where: "t.status='open'", order: 't.updated_at DESC,t.id'},
  closed: {where: "t.status='closed'", order: 't.updated_at DESC,t.id'},
  all: {where: 'TRUE', order: 't.updated_at DESC,t.id'},
};

/** `q` as an ILIKE pattern that matches the text anywhere: its own %, _ and \ escaped. */
export const containsPattern = (q: string) => '%' + q.replace(/[\\%_]/g, char => '\\' + char) + '%';
// users.name and users.email are COLLATE "C", whose case folding stops at ASCII: compared under the builtin UTF-8 collation
// (PostgreSQL 17+) so "anna" finds "Anna".
const MATCHES = `($1::text IS NULL OR u.name COLLATE pg_c_utf8 ILIKE $1 ESCAPE '\\' OR u.email COLLATE pg_c_utf8 ILIKE $1 ESCAPE '\\')`;

type InboxRow = Omit<SupportInboxRow, 'account' | 'last'> & {
  accountId: string;
  name: string;
  email: string;
  lastAuthor: SupportAuthor;
  lastBody: string;
  lastAt: string;
};

/** GET /api/admin/support/threads: the conversations of one filter, matching `q` (the name or the e-mail), and how many each filter
 *  holds for the same search. */
export async function supportInbox(filter: SupportInboxFilter, q: string | null): Promise<SupportInbox> {
  const pattern = q ? containsPattern(q) : null,
    {where, order} = FILTERS[filter];
  const rows = await db.many<InboxRow>(
    `SELECT t.id,t.status,u.id AS "accountId",u.name,u.email,
       lm.author AS "lastAuthor",lm.body AS "lastBody",${ISO('lm.created_at')} AS "lastAt",
       (SELECT count(*)::int FROM support_messages m WHERE m.thread_id=t.id AND m.author='user'
          AND (t.operator_read_at IS NULL OR m.created_at>t.operator_read_at)) AS unread,
       CASE WHEN t.status='open' THEN ${ISO('t.waiting_since')} END AS "waitingSince",
       ${ISO('t.updated_at')} AS "updatedAt"
     FROM support_threads t JOIN users u ON u.id=t.user_id
     CROSS JOIN LATERAL (SELECT author,body,created_at FROM support_messages WHERE thread_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) lm
     WHERE ${LIVE_ACCOUNT} AND ${MATCHES} AND ${where}
     ORDER BY ${order} LIMIT ${SUPPORT_INBOX_ROWS}`,
    [pattern],
  );
  const counts = (await db.one<SupportInbox['counts']>(
    `SELECT count(*) FILTER (WHERE ${FILTERS.waiting.where})::int AS waiting,
       count(*) FILTER (WHERE ${FILTERS.open.where})::int AS open,
       count(*) FILTER (WHERE ${FILTERS.closed.where})::int AS closed,
       count(*)::int AS "all"
     FROM support_threads t JOIN users u ON u.id=t.user_id WHERE ${LIVE_ACCOUNT} AND ${MATCHES}`,
    [pattern],
  ))!;
  return {
    rows: rows.map(row => ({
      id: row.id,
      account: {id: row.accountId, name: row.name, email: row.email},
      status: row.status,
      last: {author: row.lastAuthor, body: row.lastBody, createdAt: row.lastAt},
      unread: row.unread,
      waitingSince: row.waitingSince,
      updatedAt: row.updatedAt,
    })),
    counts,
  };
}

/** GET /api/admin/support/unread: conversations waiting for a person's answer (the console rail's badge). */
const WAITING = prepared(
  `SELECT count(*)::int AS n FROM support_threads t JOIN users u ON u.id=t.user_id
   WHERE t.status='open' AND t.waiting_since IS NOT NULL AND u.deletion_requested_at IS NULL AND u.erasure_completed_at IS NULL`,
);
export async function supportWaiting(): Promise<number> {
  return (await db.one<{n: number}>(WAITING))?.n ?? 0;
}

/** One conversation for the console, undefined for an unknown one (or a closing account's). */
export async function supportConversation(sql: SqlExecutor, id: string): Promise<SupportConversation | undefined> {
  const thread = await sql.one<{
    id: string;
    status: SupportThreadStatus;
    userReadAt: string | null;
    accountId: string;
    name: string;
    email: string;
  }>(
    `SELECT t.id,t.status,${ISO('t.user_read_at')} AS "userReadAt",u.id AS "accountId",u.name,u.email
     FROM support_threads t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND ${LIVE_ACCOUNT}`,
    [id],
  );
  if (!thread) return undefined;
  const messages = (await messagesOf(sql, id)).map(row => {
    const message = messageOf(row),
      where = contextOf(row.context);
    return where ? {...message, context: where} : message;
  });
  return {
    id: thread.id,
    status: thread.status,
    account: {id: thread.accountId, name: thread.name, email: thread.email},
    messages,
    userReadAt: thread.userReadAt,
  };
}

/** Locks a live account's conversation for a write; false for an unknown one. */
const lockConversation = async (tx: TransactionContext, id: string) =>
  !!(await tx.one(
    `SELECT t.id FROM support_threads t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND ${LIVE_ACCOUNT} FOR UPDATE OF t`,
    [id],
  ));

/**
 * POST /api/admin/support/threads/:id/messages: the operator's answer, naming the operator's account. It ends the wait and the
 * "typing", opens a closed conversation again, and the operator has read everything the answer shows. Undefined for an unknown conversation.
 */
export async function replyAsOperator(
  id: string,
  operatorId: string,
  input: MessageInput,
): Promise<SupportConversation | undefined> {
  return db.transaction(async tx => {
    if (!(await lockConversation(tx, id))) return undefined;
    if (!(await sentBefore(tx, id, 'operator', input.clientId)))
      await tx.execute(
        `WITH m AS (
           INSERT INTO support_messages(id,thread_id,author,operator_id,body,client_id) VALUES($1,$2,'operator',$3,$4,$5) RETURNING created_at
         )
         UPDATE support_threads t SET status='open',updated_at=m.created_at,waiting_since=NULL,operator_read_at=m.created_at,
           operator_typing_until=NULL,operator_typing_by=NULL
         FROM m WHERE t.id=$2`,
        [randomUUID(), id, operatorId, input.body, input.clientId],
      );
    return supportConversation(tx, id);
  });
}

/** POST /api/admin/support/threads/:id/status: open or close; the same status again changes nothing. */
export async function setSupportStatus(
  id: string,
  status: SupportThreadStatus,
): Promise<SupportConversation | undefined> {
  return db.transaction(async tx => {
    if (!(await lockConversation(tx, id))) return undefined;
    await tx.execute(
      'UPDATE support_threads SET status=$2,updated_at=greatest(updated_at,clock_timestamp()) WHERE id=$1 AND status<>$2',
      [id, status],
    );
    return supportConversation(tx, id);
  });
}

/** POST /api/admin/support/threads/:id/read: the operator has seen it. False for an unknown conversation. */
export async function markOperatorRead(id: string): Promise<boolean> {
  return (
    (
      await db.execute(
        `UPDATE support_threads t SET operator_read_at=clock_timestamp() FROM users u
         WHERE t.id=$1 AND u.id=t.user_id AND ${LIVE_ACCOUNT}`,
        [id],
      )
    ).changes > 0
  );
}

/** POST /api/admin/support/threads/:id/typing: the operator is typing an answer; the person sees it for SUPPORT_TYPING_MS. False
 *  for an unknown conversation. */
export async function markOperatorTyping(id: string, operatorId: string): Promise<boolean> {
  return (
    (
      await db.execute(
        `UPDATE support_threads t SET operator_typing_until=clock_timestamp()+make_interval(secs=>$3::int/1000.0),operator_typing_by=$2
         FROM users u WHERE t.id=$1 AND u.id=t.user_id AND ${LIVE_ACCOUNT}`,
        [id, operatorId, SUPPORT_TYPING_MS],
      )
    ).changes > 0
  );
}

/* ── The account's life ────────────────────────────────────────────────────────────────────────── */

/** The account's name and address, for the operators' letter (server/support/notify.ts). */
export const supportAccount = (userId: string) =>
  db.one<SupportAccount>('SELECT id,name,email FROM users WHERE id=$1', [userId]);

/** Account erasure (server/launch/lifecycle.ts), inside its transaction: the conversation and its messages are personal data. Replies
 *  the account wrote as an operator stay in the conversations they answer, naming an account that no longer says who it was; its
 *  presence and any "typing" go. */
export async function eraseSupportOf(tx: TransactionContext, userId: string): Promise<void> {
  await tx.execute('DELETE FROM support_threads WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM support_operator_presence WHERE user_id=$1', [userId]);
  await tx.execute(
    'UPDATE support_threads SET operator_typing_until=NULL,operator_typing_by=NULL WHERE operator_typing_by=$1',
    [userId],
  );
}

/** The account's data export (server/launch/account-export.ts, 152-FZ): its conversation with support, oldest first, read in keyset
 *  pages. */
const EXPORT_PAGE = 500;
export const exportSupport = (ownerId: string) =>
  exportRows(async function* (sql) {
    const thread = await sql.one<{id: string}>('SELECT id FROM support_threads WHERE user_id=$1', [ownerId]);
    if (!thread) return;
    type Row = {id: string; author: SupportAuthor; body: string; context: unknown; createdAt: string; at: string};
    let after: Row | undefined;
    for (;;) {
      const rows: Row[] = await sql.many<Row>(
        `SELECT id,author,body,context,${ISO('created_at')} AS "createdAt",created_at::text AS at FROM support_messages
         WHERE thread_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::text))
         ORDER BY created_at,id LIMIT ${EXPORT_PAGE}`,
        [thread.id, after?.at ?? null, after?.id ?? null],
      );
      for (const row of rows) {
        const context = contextOf(row.context);
        yield {author: row.author, body: row.body, createdAt: row.createdAt, ...(context ? {context} : {})};
      }
      if (rows.length < EXPORT_PAGE) return;
      after = rows.at(-1);
    }
  });
