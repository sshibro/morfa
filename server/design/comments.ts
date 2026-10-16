import {randomUUID} from 'node:crypto';
import {prepared, type SqlExecutor, type TransactionContext} from '../postgresql/client';
import {lockResources} from '../postgresql/locks';
import type {CustomerAuthority} from '../customer-authority';
import {
  anchorIssue,
  commentTextIssue,
  DESIGN_COMMENT_ID,
  DESIGN_COMMENT_LIMITS,
  mentionsIssue,
  type DesignComment,
  type DesignCommentAnchor,
  type DesignCommentChange,
  type DesignCommentDraft,
  type DesignCommentList,
  type DesignCommentMention,
  type DesignCommentPerson,
  type DesignCommentRights,
  type DesignCommentThread,
  type DesignThreadCreate,
} from '../../shared/design/comments';
import {canEditTeamFiles, canManageTeam, type DesignTeamRole} from '../../shared/design/teams';
import {designFail, notFound} from './errors';
import {designRead, designReadRows, designWrite, fileAccess, fileAccessSql, forbidden, SESSION_EXPIRY_SQL, type DesignFileAccessRow} from './file-access';
import {recordComments} from './live/hub';

// Morfa comments (docs/design-tool.md §Teams "Comments"; wire types and rules in shared/design/comments.ts). Every request
// reaches its file through `fileAccess(…, 'view')`: whoever may look at a file may comment on it (Figma lets viewers comment), a personal
// file only its owner. Beyond their own comments, an editor resolves any thread and the team's owner and admins delete any comment.
//
// The rows belong to the file (ON DELETE CASCADE from design_files), whoever wrote them. Writes of one file are serialized by its comment
// lock (project rank, after the caller's account lock), so the file's change counter (`seq`) only grows in commit order and a reader that
// saw counter N has seen every change up to N: `GET ?since=N` never misses one.

type ThreadRow = {
  id: string;
  page_id: string;
  x: number;
  y: number;
  node_id: string | null;
  offset_x: number | null;
  offset_y: number | null;
  author_id: string | null;
  author_name: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolver_name: string | null;
  deleted_at: string | null;
  seq: number;
  read_seq: number;
};
type CommentRow = {
  id: string;
  thread_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  seq: number;
};
type MentionRow = {comment_id: string; user_id: string; at: number; length: number};

const ERASED = 'Deleted account';
const threadNotFound = (): never => designFail(404, 'not_found', 'Comment not found: it may have been deleted.');
const invalid = (message: string): never => designFail(400, 'invalid_request', message);
const limit = (message: string, value: number): never => designFail(409, 'design_comment_limit', message, {limit: value});
const iso = (value: string | Date) => new Date(value).toISOString();

/** The lock under which a file's comments change (after the caller's account lock). */
const commentLock = (fileId: string) => ({kind: 'project' as const, id: 'design-comments:' + fileId});

const person = (id: string | null, name: string | null): DesignCommentPerson =>
  id === null ? {id: null, name: ERASED} : {id, name: (name ?? '').trim() || 'Member'};

/** A guest of the file (file-access.ts) mentions nobody: the mentions are of the team's members, whom a guest does not see. */
function rightsOf(row: Pick<DesignFileAccessRow, 'role' | 'team_id' | 'guest'>): DesignCommentRights {
  return {resolveAny: canEditTeamFiles(row.role), deleteAny: canManageTeam(row.role), mention: row.team_id !== null && !row.guest};
}

/** When the caller joined the file's team: comments written before it count as read (a new member does not inherit a backlog). */
async function joinedAt(tx: SqlExecutor, row: DesignFileAccessRow, userId: string): Promise<number> {
  if (!row.team_id) return 0;
  const member = await tx.one<{joined_at: string}>('SELECT joined_at FROM design_team_members WHERE team_id=$1 AND user_id=$2', [row.team_id, userId]);
  return member ? new Date(member.joined_at).getTime() : 0;
}

/** Threads of a file as the caller sees them: changed after `since` (tombstones too), or every live one. */
async function loadThreads(
  tx: SqlExecutor,
  fileId: string,
  userId: string,
  joined: number,
  filter: {since: number} | {ids: readonly string[]},
): Promise<DesignCommentChange[]> {
  const byIds = 'ids' in filter;
  const rows = await tx.many<ThreadRow>(
    `${threadsSql('$1', '$2', byIds ? 't.id=ANY($3::text[])' : 't.seq>$3 AND ($3>0 OR t.deleted_at IS NULL)')} ORDER BY t.seq,t.id`,
    [fileId, userId, byIds ? filter.ids : filter.since],
  );
  const live = rows.filter(row => row.deleted_at === null).map(row => row.id);
  const comments = live.length ? await tx.many<CommentRow>(`${commentsSql('c.thread_id=ANY($1::text[])')} ORDER BY ${COMMENT_ORDER}`, [live]) : [];
  const mentions = comments.length
    ? await tx.many<MentionRow>(`${mentionsSql('m.comment_id=ANY($1::text[])')} ORDER BY ${MENTION_ORDER}`, [comments.map(comment => comment.id)])
    : [];
  return assembleThreads(rows, comments, mentions, userId, joined);
}

/** The threads' query of a file (`file`, SQL) as `user` sees them, those `where` picks (the caller orders them by seq, id). */
const threadsSql = (file: string, user: string, where: string) =>
  `SELECT t.id,t.page_id,t.x,t.y,t.node_id,t.offset_x,t.offset_y,t.author_id,ua.name AS author_name,t.created_at,t.resolved_at,t.resolved_by,
       ur.name AS resolver_name,t.deleted_at,t.seq,COALESCE(r.read_seq,0) AS read_seq
     FROM design_comment_threads t
     LEFT JOIN users ua ON ua.id=t.author_id
     LEFT JOIN users ur ON ur.id=t.resolved_by
     LEFT JOIN design_comment_reads r ON r.thread_id=t.id AND r.user_id=${user}
     WHERE t.file_id=${file} AND ${where}`;
const commentsSql = (where: string) =>
  `SELECT c.id,c.thread_id,c.author_id,u.name AS author_name,c.body,c.created_at,c.edited_at,c.seq
         FROM design_comments c LEFT JOIN users u ON u.id=c.author_id WHERE ${where}`;
const COMMENT_ORDER = 'c.thread_id,c.seq,c.created_at,c.id';
const mentionsSql = (where: string) => `SELECT m.comment_id,m.user_id,m.at,m.length FROM design_comment_mentions m WHERE ${where}`;
const MENTION_ORDER = 'm.comment_id,m.at';

/** The answer's threads from their rows, their live comments and those comments' mentions (each in its query's order). */
function assembleThreads(rows: ThreadRow[], comments: CommentRow[], mentions: MentionRow[], userId: string, joined: number): DesignCommentChange[] {
  const mentionsOf = new Map<string, DesignCommentMention[]>();
  for (const mention of mentions) {
    const list = mentionsOf.get(mention.comment_id) ?? [];
    list.push({userId: mention.user_id, at: mention.at, length: mention.length});
    mentionsOf.set(mention.comment_id, list);
  }
  const commentsOf = new Map<string, CommentRow[]>();
  for (const comment of comments) {
    const list = commentsOf.get(comment.thread_id) ?? [];
    list.push(comment);
    commentsOf.set(comment.thread_id, list);
  }
  return rows.map((row): DesignCommentChange => {
    if (row.deleted_at !== null) return {id: row.id, deleted: true, seq: Number(row.seq)};
    const readSeq = Number(row.read_seq);
    const list = (commentsOf.get(row.id) ?? []).map(
      (comment): DesignComment => ({
        id: comment.id,
        author: person(comment.author_id, comment.author_name),
        text: comment.body,
        mentions: mentionsOf.get(comment.id) ?? [],
        createdAt: iso(comment.created_at),
        editedAt: comment.edited_at ? iso(comment.edited_at) : null,
        seq: Number(comment.seq),
      }),
    );
    const unread = (commentsOf.get(row.id) ?? []).filter(
      comment => comment.author_id !== userId && Number(comment.seq) > readSeq && new Date(comment.created_at).getTime() > joined,
    ).length;
    const anchor: DesignCommentAnchor = {
      pageId: row.page_id,
      x: Number(row.x),
      y: Number(row.y),
      nodeId: row.node_id,
      offset: row.node_id !== null ? {x: Number(row.offset_x), y: Number(row.offset_y)} : null,
    };
    return {
      id: row.id,
      seq: Number(row.seq),
      anchor,
      author: person(row.author_id, row.author_name),
      createdAt: iso(row.created_at),
      resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
      resolvedBy: row.resolved_at ? person(row.resolved_by, row.resolver_name) : null,
      comments: list,
      readSeq,
      unread,
    } satisfies DesignCommentThread;
  });
}

/** `GET /:id/comments?since=`: the file's threads (all live ones, or what changed after the cursor) and the counter to ask from next. */
export async function listDesignComments(actor: CustomerAuthority, fileId: string, since: number): Promise<DesignCommentList> {
  // One statement (designReadRows; lane A7, TARGETS A5: a poll of every open editor) reads what `designRead` + `fileAccess(…, 'view')`
  // + the counter, `joinedAt`, `loadThreads` and `you` read, in one snapshot; the rows come as JSON arrays (`iso` and Number() read
  // them as they read the columns).
  const [row] = await designReadRows<{
    file: string | null;
    role: DesignTeamRole;
    guest: boolean;
    team_id: string | null;
    n: number;
    joined_at: string | null;
    name: string | null;
    threads: ThreadRow[] | null;
    comments: CommentRow[] | null;
    mentions: MentionRow[] | null;
  }>(actor, COMMENTS_LIST, [fileId, since]);
  if (!row.file) return notFound();
  const cursor = Number(row.n);
  const joined = row.team_id && row.joined_at ? new Date(row.joined_at).getTime() : 0;
  const threads = assembleThreads(row.threads ?? [], row.comments ?? [], row.mentions ?? [], actor.ownerId, joined);
  return {threads, cursor, you: {id: actor.ownerId, name: person(actor.ownerId, row.name).name}, rights: rightsOf(row)};
}
// $3 the file, $4 `since`: a cursor from the future (another file, a restored database) starts over.
const COMMENTS_LIST = prepared(`WITH a AS (SELECT (${SESSION_EXPIRY_SQL}) AS expires),
  x AS (${fileAccessSql('$3', '$1')} AND EXISTS(SELECT 1 FROM a WHERE a.expires IS NOT NULL)),
  h AS (SELECT x.id,CASE WHEN $4::bigint>n.n THEN 0 ELSE $4::bigint END AS since,n.n
          FROM x,LATERAL (SELECT COALESCE(max(seq),0) AS n FROM design_comment_threads WHERE file_id=x.id) n),
  t AS (${threadsSql('(SELECT id FROM h)', '$1', 't.seq>(SELECT since FROM h) AND ((SELECT since FROM h)>0 OR t.deleted_at IS NULL)')}),
  c AS (${commentsSql('c.thread_id IN (SELECT id FROM t WHERE deleted_at IS NULL)')}),
  m AS (${mentionsSql('m.comment_id IN (SELECT id FROM c)')})
  SELECT a.expires,x.id AS file,x.role,x.guest,x.team_id,h.n,
         (SELECT joined_at FROM design_team_members WHERE team_id=x.team_id AND user_id=$1) AS joined_at,
         (SELECT name FROM users WHERE id=$1) AS name,
         (SELECT json_agg(t ORDER BY t.seq,t.id) FROM t) AS threads,
         (SELECT json_agg(c ORDER BY ${COMMENT_ORDER}) FROM c) AS comments,
         (SELECT json_agg(m ORDER BY ${MENTION_ORDER}) FROM m) AS mentions
    FROM a LEFT JOIN x ON true LEFT JOIN h ON true`);

type WriteContext = {tx: TransactionContext; row: DesignFileAccessRow; seq: number; userId: string};

/** A comment write: the caller's account lock (designWrite), the file through `fileAccess` (not in the trash), the file's comment lock,
 *  then the next value of the file's counter. Answers the threads the work names, as the caller now sees them. */
async function commentWrite(
  actor: CustomerAuthority,
  fileId: string,
  work: (context: WriteContext) => Promise<string>,
): Promise<DesignCommentChange> {
  const changed: {fileId: string | null} = {fileId: null};
  const answer = await designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, fileId, 'view');
    if (row.trashed_at !== null) notFound();
    changed.fileId = row.id;
    await lockResources(tx, [commentLock(row.id)]);
    const seq =
      Number((await tx.one<{n: number}>('SELECT COALESCE(max(seq),0) AS n FROM design_comment_threads WHERE file_id=$1', [row.id]))!.n) + 1;
    const threadId = await work({tx, row, seq, userId: actor.ownerId});
    const [thread] = await loadThreads(tx, row.id, actor.ownerId, await joinedAt(tx, row, actor.ownerId), {ids: [threadId]});
    return thread ?? threadNotFound();
  });
  // Committed: the file's open editors hear of it at once (the poll stays their fallback).
  if (changed.fileId) recordComments(changed.fileId);
  return answer;
}

/** The draft's text and mentions, checked: plain text within the limits, mentions inside it, of members of the file's team. */
async function checkedDraft(tx: SqlExecutor, row: DesignFileAccessRow, draft: DesignCommentDraft): Promise<DesignCommentDraft> {
  const textIssue = commentTextIssue(draft.text);
  if (textIssue) invalid(textIssue);
  const mentionIssue = mentionsIssue(draft.text, draft.mentions);
  if (mentionIssue) invalid(mentionIssue);
  if (draft.mentions.length) {
    if (!row.team_id) invalid('There is no one to mention in a personal file.');
    if (row.guest) invalid('Only team members can mention team members.');
    const ids = [...new Set(draft.mentions.map(mention => mention.userId))];
    const members = await tx.many<{user_id: string}>('SELECT user_id FROM design_team_members WHERE team_id=$1 AND user_id=ANY($2::text[])', [
      row.team_id,
      ids,
    ]);
    if (members.length !== ids.length) invalid('You can only mention team members.');
  }
  return draft;
}

async function insertComment(context: WriteContext, threadId: string, draft: DesignCommentDraft): Promise<string> {
  const id = randomUUID();
  await context.tx.execute('INSERT INTO design_comments(id,thread_id,author_id,body,seq) VALUES($1,$2,$3,$4,$5)', [
    id,
    threadId,
    context.userId,
    draft.text,
    context.seq,
  ]);
  for (const mention of draft.mentions)
    await context.tx.execute('INSERT INTO design_comment_mentions(comment_id,user_id,at,length) VALUES($1,$2,$3,$4)', [
      id,
      mention.userId,
      mention.at,
      mention.length,
    ]);
  return id;
}

/** What the writer has seen of a thread it just wrote to: its own comment is not unread to it. */
async function markReadUpTo(tx: SqlExecutor, threadId: string, userId: string, seq: number) {
  await tx.execute(
    `INSERT INTO design_comment_reads(thread_id,user_id,read_seq) VALUES($1,$2,$3)
     ON CONFLICT(thread_id,user_id) DO UPDATE SET read_seq=GREATEST(design_comment_reads.read_seq,EXCLUDED.read_seq)`,
    [threadId, userId, seq],
  );
}

async function fileCounts(tx: SqlExecutor, fileId: string) {
  return (await tx.one<{threads: number; comments: number}>(
    `SELECT (SELECT count(*)::int FROM design_comment_threads WHERE file_id=$1 AND deleted_at IS NULL) AS threads,
       (SELECT count(*)::int FROM design_comments c JOIN design_comment_threads t ON t.id=c.thread_id WHERE t.file_id=$1) AS comments`,
    [fileId],
  ))!;
}

/** `POST /:id/comments`: a new thread with its first comment, pinned where the anchor says. */
export async function createDesignCommentThread(actor: CustomerAuthority, fileId: string, input: DesignThreadCreate): Promise<DesignCommentThread> {
  const anchorProblem = anchorIssue(input.anchor);
  if (anchorProblem) invalid(anchorProblem);
  const result = await commentWrite(actor, fileId, async context => {
    const {tx, row, seq, userId} = context;
    const draft = await checkedDraft(tx, row, input);
    const counts = await fileCounts(tx, row.id);
    if (counts.threads >= DESIGN_COMMENT_LIMITS.threadsPerFile)
      limit(`A file can have up to ${DESIGN_COMMENT_LIMITS.threadsPerFile} threads. Delete resolved ones.`, DESIGN_COMMENT_LIMITS.threadsPerFile);
    if (counts.comments >= DESIGN_COMMENT_LIMITS.commentsPerFile)
      limit(`A file can have up to ${DESIGN_COMMENT_LIMITS.commentsPerFile} comments. Delete resolved threads.`, DESIGN_COMMENT_LIMITS.commentsPerFile);
    const id = randomUUID(),
      anchor = input.anchor;
    await tx.execute(
      `INSERT INTO design_comment_threads(id,file_id,page_id,x,y,node_id,offset_x,offset_y,author_id,seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, row.id, anchor.pageId, anchor.x, anchor.y, anchor.nodeId ?? null, anchor.offset?.x ?? null, anchor.offset?.y ?? null, userId, seq],
    );
    await insertComment(context, id, draft);
    await markReadUpTo(tx, id, userId, seq);
    return id;
  });
  return result as DesignCommentThread;
}

/** The live thread of this file, locked for the change. */
async function liveThread(tx: SqlExecutor, fileId: string, threadId: string) {
  if (typeof threadId !== 'string' || !DESIGN_COMMENT_ID.test(threadId)) return threadNotFound();
  return (
    (await tx.one<{id: string; author_id: string | null; resolved_at: string | null}>(
      'SELECT id,author_id,resolved_at FROM design_comment_threads WHERE id=$1 AND file_id=$2 AND deleted_at IS NULL FOR UPDATE',
      [threadId, fileId],
    )) ?? threadNotFound()
  );
}

/** `POST /:id/comments/:threadId/replies`. A reply to a resolved thread leaves it resolved, as in Figma. */
export async function replyToDesignComment(
  actor: CustomerAuthority,
  fileId: string,
  threadId: string,
  input: DesignCommentDraft,
): Promise<DesignCommentThread> {
  return (await commentWrite(actor, fileId, async context => {
    const {tx, row, seq, userId} = context;
    const thread = await liveThread(tx, row.id, threadId);
    const draft = await checkedDraft(tx, row, input);
    const counts = await fileCounts(tx, row.id);
    if (counts.comments >= DESIGN_COMMENT_LIMITS.commentsPerFile)
      limit(`A file can have up to ${DESIGN_COMMENT_LIMITS.commentsPerFile} comments. Delete resolved threads.`, DESIGN_COMMENT_LIMITS.commentsPerFile);
    const inThread = (await tx.one<{n: number}>('SELECT count(*)::int AS n FROM design_comments WHERE thread_id=$1', [thread.id]))!.n;
    if (inThread >= DESIGN_COMMENT_LIMITS.commentsPerThread)
      limit(`A thread can have up to ${DESIGN_COMMENT_LIMITS.commentsPerThread} comments. Start a new one.`, DESIGN_COMMENT_LIMITS.commentsPerThread);
    await insertComment(context, thread.id, draft);
    await tx.execute('UPDATE design_comment_threads SET seq=$2 WHERE id=$1', [thread.id, seq]);
    await markReadUpTo(tx, thread.id, userId, seq);
    return thread.id;
  })) as DesignCommentThread;
}

/** `PATCH /:id/comments/:threadId/messages/:commentId`: the author's own words only. */
export async function editDesignComment(
  actor: CustomerAuthority,
  fileId: string,
  threadId: string,
  commentId: string,
  input: DesignCommentDraft,
): Promise<DesignCommentThread> {
  return (await commentWrite(actor, fileId, async context => {
    const {tx, row, seq, userId} = context;
    const thread = await liveThread(tx, row.id, threadId);
    const comment = await commentOf(tx, thread.id, commentId);
    if (comment.author_id !== userId) forbidden('You can only edit your own comments.');
    const draft = await checkedDraft(tx, row, input);
    await tx.execute('UPDATE design_comments SET body=$2,edited_at=clock_timestamp() WHERE id=$1', [comment.id, draft.text]);
    await tx.execute('DELETE FROM design_comment_mentions WHERE comment_id=$1', [comment.id]);
    for (const mention of draft.mentions)
      await tx.execute('INSERT INTO design_comment_mentions(comment_id,user_id,at,length) VALUES($1,$2,$3,$4)', [
        comment.id,
        mention.userId,
        mention.at,
        mention.length,
      ]);
    await tx.execute('UPDATE design_comment_threads SET seq=$2 WHERE id=$1', [thread.id, seq]);
    return thread.id;
  })) as DesignCommentThread;
}

async function commentOf(tx: SqlExecutor, threadId: string, commentId: string) {
  if (typeof commentId !== 'string' || !DESIGN_COMMENT_ID.test(commentId)) return threadNotFound();
  return (
    (await tx.one<{id: string; author_id: string | null; first: boolean}>(
      `SELECT c.id,c.author_id,c.id=(SELECT f.id FROM design_comments f WHERE f.thread_id=$1 ORDER BY f.seq,f.created_at,f.id LIMIT 1) AS first
       FROM design_comments c WHERE c.id=$2 AND c.thread_id=$1`,
      [threadId, commentId],
    )) ?? threadNotFound()
  );
}

/** Turns a thread into a tombstone: its comments, mentions and read state go, the row keeps only its id and counter. */
async function tombstone(tx: SqlExecutor, threadId: string, seq: number) {
  await tx.execute('DELETE FROM design_comments WHERE thread_id=$1', [threadId]);
  await tx.execute('DELETE FROM design_comment_reads WHERE thread_id=$1', [threadId]);
  await tx.execute(
    `UPDATE design_comment_threads SET deleted_at=clock_timestamp(),author_id=NULL,node_id=NULL,offset_x=NULL,offset_y=NULL,
       resolved_at=NULL,resolved_by=NULL,x=0,y=0,seq=$2 WHERE id=$1`,
    [threadId, seq],
  );
}

/** `DELETE /:id/comments/:threadId/messages/:commentId`: the author's own, or any for the team's owner and admins. The first comment
 *  takes the whole thread with it (it is what the thread is about). */
export async function deleteDesignComment(actor: CustomerAuthority, fileId: string, threadId: string, commentId: string): Promise<DesignCommentChange> {
  return commentWrite(actor, fileId, async ({tx, row, seq, userId}) => {
    const thread = await liveThread(tx, row.id, threadId);
    const comment = await commentOf(tx, thread.id, commentId);
    if (comment.author_id !== userId && !rightsOf(row).deleteAny) forbidden('You can only delete your own comments.');
    if (comment.first) {
      if (thread.author_id !== userId && !rightsOf(row).deleteAny) forbidden('You can only delete your own comments.');
      await tombstone(tx, thread.id, seq);
    } else {
      await tx.execute('DELETE FROM design_comments WHERE id=$1', [comment.id]);
      await tx.execute('UPDATE design_comment_threads SET seq=$2 WHERE id=$1', [thread.id, seq]);
    }
    return thread.id;
  });
}

/** `DELETE /:id/comments/:threadId`: the thread's author, or the team's owner and admins. */
export async function deleteDesignCommentThread(actor: CustomerAuthority, fileId: string, threadId: string): Promise<DesignCommentChange> {
  return commentWrite(actor, fileId, async ({tx, row, seq, userId}) => {
    const thread = await liveThread(tx, row.id, threadId);
    if (thread.author_id !== userId && !rightsOf(row).deleteAny) forbidden('Only the thread\'s author or a team admin can delete it.');
    await tombstone(tx, thread.id, seq);
    return thread.id;
  });
}

/** `PATCH /:id/comments/:threadId {resolved}`: the thread's author, or an editor (as in Figma: viewers resolve their own). */
export async function resolveDesignCommentThread(
  actor: CustomerAuthority,
  fileId: string,
  threadId: string,
  resolved: boolean,
): Promise<DesignCommentThread> {
  return (await commentWrite(actor, fileId, async ({tx, row, seq, userId}) => {
    const thread = await liveThread(tx, row.id, threadId);
    if (thread.author_id !== userId && !rightsOf(row).resolveAny)
      forbidden('Only the thread\'s author or a file editor can resolve it.');
    if (resolved === (thread.resolved_at !== null)) return thread.id;
    if (resolved) await tx.execute('UPDATE design_comment_threads SET resolved_at=clock_timestamp(),resolved_by=$2,seq=$3 WHERE id=$1', [thread.id, userId, seq]);
    else await tx.execute('UPDATE design_comment_threads SET resolved_at=NULL,resolved_by=NULL,seq=$2 WHERE id=$1', [thread.id, seq]);
    return thread.id;
  })) as DesignCommentThread;
}

/** `POST /:id/comments/read {threads}`: the caller has read these threads up to now. No lock: only the caller's own rows change. */
export async function markDesignCommentsRead(actor: CustomerAuthority, fileId: string, threadIds: readonly string[]): Promise<{ok: true}> {
  if (threadIds.length > DESIGN_COMMENT_LIMITS.readBatch || threadIds.some(id => typeof id !== 'string' || !DESIGN_COMMENT_ID.test(id)))
    invalid('Check the request data.');
  await designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, fileId, 'view');
    if (!threadIds.length) return;
    await tx.execute(
      `INSERT INTO design_comment_reads(thread_id,user_id,read_seq)
       SELECT t.id,$3,t.seq FROM design_comment_threads t WHERE t.file_id=$1 AND t.id=ANY($2::text[]) AND t.deleted_at IS NULL
       ON CONFLICT(thread_id,user_id) DO UPDATE SET read_seq=GREATEST(design_comment_reads.read_seq,EXCLUDED.read_seq)`,
      [row.id, [...new Set(threadIds)], actor.ownerId],
    );
  });
  return {ok: true};
}

/**
 * Unread comments per file for the caller, for the file browser's badge: comments of others in open threads newer than what the caller
 * read (and than when it joined the team, `joinedAt`). One query for a page of files.
 */
export async function unreadDesignComments(tx: SqlExecutor, userId: string, fileIds: readonly string[], joinedAt: string | null): Promise<Map<string, number>> {
  if (!fileIds.length) return new Map();
  const rows = await tx.many<{file_id: string; n: number}>(unreadCommentsSql('t.file_id=ANY($1::text[])', '$2', '$3::timestamptz'), [fileIds, userId, joinedAt]);
  return new Map(rows.map(row => [row.file_id, row.n]));
}
/** The query of `unreadDesignComments` as SQL (`file_id`, `n` per file with any) for the threads `files` picks, the reader `user` and
 *  when it joined `joined` (SQL expressions; NULL: no bound), for a statement that reads it beside other things (the file list). */
export const unreadCommentsSql = (files: string, user: string, joined: string) =>
  `SELECT t.file_id,count(*)::int AS n FROM design_comment_threads t
     JOIN design_comments c ON c.thread_id=t.id
     LEFT JOIN design_comment_reads r ON r.thread_id=t.id AND r.user_id=${user}
     WHERE ${files} AND t.deleted_at IS NULL AND t.resolved_at IS NULL AND c.author_id IS DISTINCT FROM ${user}
       AND c.seq>COALESCE(r.read_seq,0) AND (${joined} IS NULL OR c.created_at>${joined})
     GROUP BY t.file_id`;

// ── Account life (docs/design-tool.md §Teams "Comments") ───────────────────────────────────────

/**
 * Account erasure, inside its transaction, after the account's own files went (their threads with them, ON DELETE CASCADE). What the
 * account wrote in files other accounts hold stays part of that file's discussion, detached from it: no author (shown as "Deleted
 * account"), as an erased operator's replies in support threads; the mentions of it and its read state go. Takes no lock.
 */
export async function eraseDesignCommentsOf(tx: TransactionContext, userId: string): Promise<void> {
  await tx.execute('UPDATE design_comments SET author_id=NULL WHERE author_id=$1', [userId]);
  await tx.execute('UPDATE design_comment_threads SET author_id=NULL WHERE author_id=$1', [userId]);
  await tx.execute('UPDATE design_comment_threads SET resolved_by=NULL WHERE resolved_by=$1', [userId]);
  await tx.execute('DELETE FROM design_comment_mentions WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM design_comment_reads WHERE user_id=$1', [userId]);
}
