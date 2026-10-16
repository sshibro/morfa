import {randomUUID} from 'node:crypto';
import type {SqlExecutor, TransactionContext} from '../../postgresql/client';
import type {CustomerAuthority} from '../../customer-authority';
import {canEditTeamFiles} from '../../../shared/design/teams';
import {
  applyBallot,
  clampTimer,
  cleanPrompt,
  MEETING_LIMITS,
  voteEnded,
  type DesignMeetingState,
  type DesignMeetingVoteRecord,
  type DesignMeetingVotes,
  type MeetingBallot,
  type MeetingPerson,
  type MeetingTally,
  type MeetingTimer,
  type MeetingTimerAction,
  type MeetingTrack,
  type MeetingVote,
  type MeetingVoteAction,
} from '../../../shared/design/meeting';
import {designFail, notFound} from '../errors';
import {designRead, designWrite, fileAccess, type DesignNeed} from '../file-access';
import {recordMeeting} from '../live/hub';

// "Meeting" on the server (docs/board-meeting.md; wire types and rules in shared/design/meeting.ts): a file's shared timer and its
// voting session, in design_meetings (one row per file) and design_meeting_votes (the ballots). Every request reaches its file through
// `fileAccess`: anyone who may open the file reads the meeting and votes; editors (owner, admins, editors) run the timer and votes. A file
// in the trash is read but never written. Writes of one file are ordered by its meeting row (FOR UPDATE; ballots FOR SHARE, so people
// vote in parallel while a start or an end waits for them), and the row's `revision` grows with each change. Once committed, the file's
// open editors hear `meeting {revision}` on their streams and read the state again (a ballot tells only its voter's own tabs: counts
// stay hidden until the end). Times are this process's clock, in ms; every answer carries `now` so the editors count down by it.

type Row = {
  revision: number;
  timer_state: 'running' | 'paused' | null;
  timer_duration_ms: number | null;
  timer_ends_at: string | null;
  timer_remaining_ms: number | null;
  timer_music: MeetingTrack | null;
  timer_by: string | null;
  timer_by_name: string | null;
  vote_id: string | null;
  vote_by: string | null;
  vote_by_name: string | null;
  vote_per_person: number | null;
  vote_with_timer: boolean | null;
  vote_started_at: string | null;
  vote_ends_at: string | null;
  vote_ended_at: string | null;
  vote_prompt: string | null;
  vote_hide_cursors: boolean;
};
/** What a write may change: the row's own columns, never its file or revision. */
type Fields = Partial<Omit<Row, 'revision' | 'timer_by_name' | 'vote_by_name'>>;
const WRITABLE: readonly (keyof Fields)[] = [
  'timer_state',
  'timer_duration_ms',
  'timer_ends_at',
  'timer_remaining_ms',
  'timer_music',
  'timer_by',
  'vote_id',
  'vote_by',
  'vote_per_person',
  'vote_with_timer',
  'vote_started_at',
  'vote_ends_at',
  'vote_ended_at',
  'vote_prompt',
  'vote_hide_cursors',
];

const COLUMNS = `m.revision,m.timer_state,m.timer_duration_ms,m.timer_ends_at,m.timer_remaining_ms,m.timer_music,m.timer_by,tb.name AS timer_by_name,
  m.vote_id,m.vote_by,vb.name AS vote_by_name,m.vote_per_person,m.vote_with_timer,m.vote_started_at,m.vote_ends_at,m.vote_ended_at,
  m.vote_prompt,m.vote_hide_cursors`;
const FROM = 'design_meetings m LEFT JOIN users tb ON tb.id=m.timer_by LEFT JOIN users vb ON vb.id=m.vote_by';

const ms = (value: string | null) => (value === null ? null : Date.parse(value));
const iso = (value: number) => new Date(value).toISOString();
const person = (id: string | null, name: string | null): MeetingPerson | null => (id === null ? null : {id, name: (name ?? '').trim() || 'Member'});
const conflict = (message: string): never => designFail(409, 'design_meeting_conflict', message);
const NO_TIMER: Fields = {timer_state: null, timer_duration_ms: null, timer_ends_at: null, timer_remaining_ms: null, timer_music: null, timer_by: null};
const NO_VOTE: Fields = {
  vote_id: null,
  vote_by: null,
  vote_per_person: null,
  vote_with_timer: null,
  vote_started_at: null,
  vote_ends_at: null,
  vote_ended_at: null,
  vote_prompt: null,
  vote_hide_cursors: false,
};

async function readRow(tx: SqlExecutor, fileId: string, lock: '' | 'FOR UPDATE OF m' | 'FOR SHARE OF m' = ''): Promise<Row | null> {
  return (await tx.one<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE m.file_id=$1 ${lock}`, [fileId])) ?? null;
}

function timerOf(row: Row | null): MeetingTimer | null {
  if (!row?.timer_state) return null;
  return {
    state: row.timer_state,
    durationMs: Number(row.timer_duration_ms),
    endsAt: ms(row.timer_ends_at),
    remainingMs: row.timer_remaining_ms === null ? null : Number(row.timer_remaining_ms),
    music: row.timer_music,
    by: person(row.timer_by, row.timer_by_name),
  };
}

/** One person's votes in a session (`mine`). */
async function talliesOf(tx: SqlExecutor, fileId: string, voteId: string, userId: string): Promise<MeetingTally[]> {
  const rows = await tx.many<{node_id: string; count: number}>(
    'SELECT node_id,count FROM design_meeting_votes WHERE file_id=$1 AND vote_id=$2 AND user_id=$3 ORDER BY node_id',
    [fileId, voteId, userId],
  );
  return rows.map(row => ({nodeId: row.node_id, count: Number(row.count)}));
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** A session's results once it ended: every voted object the most votes first (at most MEETING_LIMITS.results), each with how many
 *  votes each person gave it (`by`), and how many people voted. */
async function resultsOf(tx: SqlExecutor, fileId: string, voteId: string): Promise<{results: MeetingTally[]; voters: number}> {
  const rows = await tx.many<{node_id: string; user_id: string; count: number; name: string | null}>(
    'SELECT v.node_id,v.user_id,v.count,u.name FROM design_meeting_votes v LEFT JOIN users u ON u.id=v.user_id WHERE v.file_id=$1 AND v.vote_id=$2',
    [fileId, voteId],
  );
  const nodes = new Map<string, {count: number; by: {name: string; count: number}[]}>();
  for (const row of rows) {
    const entry = nodes.get(row.node_id) ?? {count: 0, by: []};
    entry.count += Number(row.count);
    entry.by.push({name: (row.name ?? '').trim() || 'Member', count: Number(row.count)});
    nodes.set(row.node_id, entry);
  }
  const results = [...nodes]
    .map(([nodeId, entry]) => ({nodeId, count: entry.count, by: entry.by.sort((a, b) => b.count - a.count || byName(a.name, b.name))}))
    .sort((a, b) => b.count - a.count || byName(a.nodeId, b.nodeId))
    .slice(0, MEETING_LIMITS.results);
  return {results, voters: new Set(rows.map(row => row.user_id)).size};
}

/** When the row's vote ended (or ends on its own timer, once that passed), else null: it still runs at `now`. */
function endedAtOf(row: Row, now: number): number | null {
  const endsAt = ms(row.vote_ends_at);
  return ms(row.vote_ended_at) ?? (endsAt !== null && now >= endsAt ? endsAt : null);
}

async function voteOf(tx: SqlExecutor, fileId: string, row: Row | null, userId: string, now: number): Promise<MeetingVote | null> {
  if (!row?.vote_id) return null;
  const endsAt = ms(row.vote_ends_at);
  // A vote whose timer ran out has ended, written or not (the next write writes it): ballots after `endsAt` are refused.
  const endedAt = endedAtOf(row, now);
  const ended = endedAt !== null ? await resultsOf(tx, fileId, row.vote_id) : null;
  return {
    id: row.vote_id,
    by: person(row.vote_by, row.vote_by_name),
    perPerson: Number(row.vote_per_person),
    withTimer: !!row.vote_with_timer,
    startedAt: ms(row.vote_started_at)!,
    endsAt,
    endedAt,
    mine: await talliesOf(tx, fileId, row.vote_id, userId),
    results: ended?.results ?? null,
    voters: ended?.voters ?? null,
    prompt: row.vote_prompt,
    hideCursors: !!row.vote_hide_cursors,
  };
}

/**
 * The row's vote kept as a past session (design_meeting_sessions; its ballots stay under its id): ended when it did, or now when it
 * still ran (a start or a clear took it off). Only the newest MEETING_LIMITS.history are kept; older ones go with their ballots, and
 * so do ballots of no session (an older release's).
 */
async function archiveVote(tx: SqlExecutor, fileId: string, row: Row, now: number): Promise<void> {
  if (!row.vote_id) return;
  await tx.execute(
    `INSERT INTO design_meeting_sessions(file_id,vote_id,prompt,per_person,started_by,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(file_id,vote_id) DO NOTHING`,
    [fileId, row.vote_id, row.vote_prompt, row.vote_per_person, row.vote_by, row.vote_started_at, iso(endedAtOf(row, now) ?? now)],
  );
  await tx.execute(
    `WITH old AS (DELETE FROM design_meeting_sessions WHERE file_id=$1 AND vote_id NOT IN
       (SELECT vote_id FROM design_meeting_sessions WHERE file_id=$1 ORDER BY ended_at DESC,vote_id DESC LIMIT ${MEETING_LIMITS.history}) RETURNING vote_id)
     SELECT count(*) FROM old`,
    [fileId],
  );
  await tx.execute('DELETE FROM design_meeting_votes WHERE file_id=$1 AND vote_id NOT IN (SELECT vote_id FROM design_meeting_sessions WHERE file_id=$1)', [fileId]);
}

async function stateOf(tx: SqlExecutor, fileId: string, row: Row | null, userId: string, canControl: boolean, now: number): Promise<DesignMeetingState> {
  return {revision: Number(row?.revision ?? 0), now, timer: timerOf(row), vote: await voteOf(tx, fileId, row, userId, now), canControl};
}

/** `GET /:id/meeting`: the file's timer and vote as the caller sees them (their own votes; everyone's once the vote ended). */
export async function readDesignMeeting(actor: CustomerAuthority, fileId: string): Promise<DesignMeetingState> {
  return designRead(actor, async tx => {
    const file = await fileAccess(tx, actor.ownerId, fileId, 'view');
    const row = await readRow(tx, file.id);
    return stateOf(tx, file.id, row, actor.ownerId, canEditTeamFiles(file.role) && file.trashed_at === null, Date.now());
  });
}

type WriteContext = {tx: TransactionContext; fileId: string; userId: string; row: Row; now: number};

/**
 * One change of a file's meeting: its access (`need`; a file in the trash refuses), its row locked (created on first use), then `work`,
 * whose fields are written with the next revision (none: nothing changed). Afterwards the open editors hear of it: everyone's, or
 * only the caller's own tabs when just their ballots changed (`private`).
 */
async function meetingWrite(
  actor: CustomerAuthority,
  fileId: string,
  need: DesignNeed,
  work: (context: WriteContext) => Promise<Fields | null> | Fields | null,
  options: {share?: boolean; private?: boolean; by?: string | null} = {},
): Promise<DesignMeetingState> {
  let signal: {fileId: string; revision: number; user?: string} | null = null;
  const answer = await designWrite(actor, async tx => {
    const file = await fileAccess(tx, actor.ownerId, fileId, need);
    if (file.trashed_at !== null) notFound();
    await tx.execute('INSERT INTO design_meetings(file_id,revision) VALUES($1,1) ON CONFLICT(file_id) DO NOTHING', [file.id]);
    let row = (await readRow(tx, file.id, options.share ? 'FOR SHARE OF m' : 'FOR UPDATE OF m'))!;
    const now = Date.now();
    const fields = await work({tx, fileId: file.id, userId: actor.ownerId, row, now});
    if (fields && Object.keys(fields).length) {
      const keys = WRITABLE.filter(key => Object.hasOwn(fields, key));
      await tx.execute(
        `UPDATE design_meetings SET ${keys.map((key, index) => `${key}=$${index + 2}`).join(',')},revision=revision+1,updated_at=clock_timestamp() WHERE file_id=$1`,
        [file.id, ...keys.map(key => fields[key] ?? null)],
      );
      row = (await readRow(tx, file.id))!;
      signal = {fileId: file.id, revision: Number(row.revision)};
    } else if (options.private) signal = {fileId: file.id, revision: Number(row.revision), user: actor.ownerId};
    return stateOf(tx, file.id, row, actor.ownerId, canEditTeamFiles(file.role), now);
  });
  const done = signal as {fileId: string; revision: number; user?: string} | null;
  if (done) recordMeeting(done.fileId, {revision: done.revision, ...(done.user ? {user: done.user} : {}), by: options.by ?? null});
  return answer;
}

/** The timer columns of a running timer that ends at `endsAt`. */
const running = (endsAt: number, durationMs: number, music: MeetingTrack | null, by: string | null): Fields => ({
  timer_state: 'running',
  timer_duration_ms: durationMs,
  timer_ends_at: iso(endsAt),
  timer_remaining_ms: null,
  timer_music: music,
  timer_by: by,
});

/** A running vote tied to the timer follows it: it ends when the timer ends (`endsAt`), or waits while it is paused (null). */
function linkedVote(row: Row, now: number, endsAt: number | null): Fields {
  if (!row.vote_id || !row.vote_with_timer || voteEnded({endedAt: ms(row.vote_ended_at), endsAt: ms(row.vote_ends_at)}, now)) return {};
  return {vote_ends_at: endsAt === null ? null : iso(endsAt)};
}

/** A vote whose timer ran out is written as ended when it was (so the next timer cannot bring it back). */
function settleExpiredVote(row: Row, now: number): Fields {
  const endsAt = ms(row.vote_ends_at);
  return row.vote_id && row.vote_ended_at === null && endsAt !== null && now >= endsAt ? {vote_ended_at: iso(endsAt)} : {};
}

/** `POST /:id/meeting/timer`: start, pause, resume, "+1 min", stop, or the music of the file's timer (editors). */
export async function changeDesignMeetingTimer(actor: CustomerAuthority, fileId: string, action: MeetingTimerAction, by: string | null = null): Promise<DesignMeetingState> {
  return meetingWrite(actor, fileId, 'edit', ({row, now, userId}) => {
    const settled = settleExpiredVote(row, now);
    const view: Row = {...row, ...(settled as Partial<Row>)};
    const endsAt = ms(row.timer_ends_at);
    const live = row.timer_state === 'running' && endsAt !== null && now < endsAt;
    switch (action.action) {
      case 'start': {
        const duration = clampTimer(action.durationMs);
        return {...settled, ...running(now + duration, duration, action.music ?? null, userId), ...linkedVote(view, now, now + duration)};
      }
      case 'pause':
        if (!live) return null;
        return {...settled, timer_state: 'paused', timer_ends_at: null, timer_remaining_ms: endsAt! - now, ...linkedVote(view, now, null)};
      case 'resume': {
        if (row.timer_state !== 'paused') return null;
        const next = now + Number(row.timer_remaining_ms);
        return {...settled, ...running(next, Number(row.timer_duration_ms), row.timer_music, row.timer_by), ...linkedVote(view, now, next)};
      }
      case 'add': {
        if (row.timer_state === 'paused') {
          const remaining = Math.min(MEETING_LIMITS.timerMaxMs, Number(row.timer_remaining_ms) + MEETING_LIMITS.addMs);
          return {...settled, timer_remaining_ms: remaining, timer_duration_ms: Math.min(MEETING_LIMITS.timerMaxMs, Number(row.timer_duration_ms) + MEETING_LIMITS.addMs)};
        }
        if (live) {
          const next = Math.min(now + MEETING_LIMITS.timerMaxMs, endsAt! + MEETING_LIMITS.addMs);
          return {
            ...settled,
            timer_ends_at: iso(next),
            timer_duration_ms: Math.min(MEETING_LIMITS.timerMaxMs, Number(row.timer_duration_ms) + (next - endsAt!)),
            ...linkedVote(view, now, next),
          };
        }
        // Time is up (or there was no timer): one more minute from now, as FigJam's "+1 min" does.
        return {...settled, ...running(now + MEETING_LIMITS.addMs, MEETING_LIMITS.addMs, row.timer_music, userId)};
      }
      case 'stop':
        if (!row.timer_state) return Object.keys(settled).length ? settled : null;
        // A running vote that followed the timer goes on until an editor ends it.
        return {...settled, ...NO_TIMER, ...(view.vote_id && view.vote_ended_at === null && view.vote_with_timer ? {vote_with_timer: false, vote_ends_at: null} : {})};
      case 'music':
        if (!row.timer_state || row.timer_music === action.music) return null;
        return {...settled, timer_music: action.music};
    }
  }, {by});
}

/** `POST /:id/meeting/vote`: start a voting session (with or without the timer), end it for everyone, or clear its results (editors). */
export async function changeDesignMeetingVote(actor: CustomerAuthority, fileId: string, action: MeetingVoteAction, by: string | null = null): Promise<DesignMeetingState> {
  return meetingWrite(actor, fileId, 'edit', async ({tx, fileId: id, row, now, userId}) => {
    switch (action.action) {
      case 'start': {
        // The previous session gives way: kept with its ballots among the past ones (ended now if it still ran).
        await archiveVote(tx, id, row, now);
        const vote: Fields = {
          vote_id: randomUUID(),
          vote_by: userId,
          vote_per_person: action.perPerson,
          vote_with_timer: action.durationMs !== null,
          vote_started_at: iso(now),
          vote_ends_at: null,
          vote_ended_at: null,
          vote_prompt: cleanPrompt(action.prompt),
          vote_hide_cursors: !!action.hideCursors,
        };
        if (action.durationMs === null) return vote;
        const duration = clampTimer(action.durationMs);
        return {...vote, vote_ends_at: iso(now + duration), ...running(now + duration, duration, action.music ?? null, userId)};
      }
      case 'end': {
        if (!row.vote_id) return conflict('Voting has already ended.');
        const settled = settleExpiredVote(row, now);
        if (row.vote_ended_at !== null || Object.keys(settled).length) return Object.keys(settled).length ? settled : null;
        // Ended early: the timer that was counting its time stops with it.
        return {vote_ended_at: iso(now), ...(row.vote_with_timer ? NO_TIMER : {})};
      }
      case 'cursors':
        // Only while it runs: an ended vote shows everyone's cursors again anyway.
        if (!row.vote_id || endedAtOf(row, now) !== null || !!row.vote_hide_cursors === action.hide) return null;
        return {vote_hide_cursors: action.hide};
      case 'clear':
        // Off the meeting; the session stays among the past ones ("Results").
        if (!row.vote_id) return null;
        await archiveVote(tx, id, row, now);
        return NO_VOTE;
    }
  }, {by});
}

/** `POST /:id/meeting/vote/ballot`: one vote more or less for an object, while the session runs (anyone who may open the file). */
export async function castDesignMeetingBallot(actor: CustomerAuthority, fileId: string, ballot: MeetingBallot, by: string | null = null): Promise<DesignMeetingState> {
  return meetingWrite(
    actor,
    fileId,
    'view',
    async ({tx, fileId: id, row, now, userId}) => {
      if (!row.vote_id || row.vote_id !== ballot.voteId || voteEnded({endedAt: ms(row.vote_ended_at), endsAt: ms(row.vote_ends_at)}, now))
        conflict('Voting has already ended.');
      const mine = await talliesOf(tx, id, ballot.voteId, userId);
      const next = applyBallot(mine, Number(row.vote_per_person), ballot.nodeId, ballot.delta);
      if (next === 'no-votes-left') conflict('No votes left: remove one to vote for something else.');
      if (next === 'no-vote-here') conflict('You have no vote here.');
      const count = (next as MeetingTally[]).find(tally => tally.nodeId === ballot.nodeId)?.count ?? 0;
      if (count)
        await tx.execute(
          `INSERT INTO design_meeting_votes(file_id,vote_id,user_id,node_id,count) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(file_id,vote_id,user_id,node_id) DO UPDATE SET count=EXCLUDED.count`,
          [id, ballot.voteId, userId, ballot.nodeId, count],
        );
      else await tx.execute('DELETE FROM design_meeting_votes WHERE file_id=$1 AND vote_id=$2 AND user_id=$3 AND node_id=$4', [id, ballot.voteId, userId, ballot.nodeId]);
      return null;
    },
    {share: true, private: true, by},
  );
}

// ── Past sessions ────────────────────────────────────────────────────────────────────────────────

/** `GET /:id/meeting/votes`: the file's ended sessions, newest first (the last MEETING_LIMITS.history), with who voted for what; the
 *  meeting's own vote among them once it ended. Anyone who may open the file. */
export async function listDesignMeetingVotes(actor: CustomerAuthority, fileId: string): Promise<DesignMeetingVotes> {
  return designRead(actor, async tx => {
    const file = await fileAccess(tx, actor.ownerId, fileId, 'view');
    const now = Date.now();
    const sessions = await tx.many<{vote_id: string; prompt: string | null; started_at: string; ended_at: string}>(
      `SELECT vote_id,prompt,started_at,ended_at FROM design_meeting_sessions WHERE file_id=$1 ORDER BY ended_at DESC,vote_id DESC LIMIT ${MEETING_LIMITS.history}`,
      [file.id],
    );
    const listed = sessions.map(session => ({id: session.vote_id, prompt: session.prompt, startedAt: ms(session.started_at)!, endedAt: ms(session.ended_at)!}));
    const row = await readRow(tx, file.id);
    const endedAt = row?.vote_id ? endedAtOf(row, now) : null;
    if (row?.vote_id && endedAt !== null && !listed.some(session => session.id === row.vote_id))
      listed.push({id: row.vote_id, prompt: row.vote_prompt, startedAt: ms(row.vote_started_at)!, endedAt});
    listed.sort((a, b) => b.endedAt - a.endedAt || byName(b.id, a.id));
    const votes: DesignMeetingVoteRecord[] = [];
    for (const session of listed.slice(0, MEETING_LIMITS.history)) votes.push({...session, ...(await resultsOf(tx, file.id, session.id))});
    return {votes};
  });
}

/** `DELETE /:id/meeting/votes/:voteId`: a past session goes with its ballots (editors); the meeting's own vote is cleared with it. */
export async function deleteDesignMeetingVote(actor: CustomerAuthority, fileId: string, voteId: string, by: string | null = null): Promise<void> {
  let found = false;
  await meetingWrite(
    actor,
    fileId,
    'edit',
    async ({tx, fileId: id, row}) => {
      const removed = await tx.execute('DELETE FROM design_meeting_sessions WHERE file_id=$1 AND vote_id=$2', [id, voteId]);
      const current = row.vote_id === voteId;
      found = removed.changes > 0 || current;
      if (!found) return null;
      await tx.execute('DELETE FROM design_meeting_votes WHERE file_id=$1 AND vote_id=$2', [id, voteId]);
      return current ? NO_VOTE : null;
    },
    {by},
  );
  if (!found) designFail(404, 'not_found', 'Voting not found.');
}

// ── Account life ─────────────────────────────────────────────────────────────────────────────────

/** Account erasure, inside its transaction (its files' meetings went with them): its ballots elsewhere go, and the timers and votes it
 *  started name nobody. Takes no lock. */
export async function eraseDesignMeetingsOf(tx: TransactionContext, userId: string): Promise<void> {
  await tx.execute('DELETE FROM design_meeting_votes WHERE user_id=$1', [userId]);
  await tx.execute('UPDATE design_meetings SET timer_by=NULL WHERE timer_by=$1', [userId]);
  await tx.execute('UPDATE design_meetings SET vote_by=NULL WHERE vote_by=$1', [userId]);
  await tx.execute('UPDATE design_meeting_sessions SET started_by=NULL WHERE started_by=$1', [userId]);
}
