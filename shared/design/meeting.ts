// "Meeting": what people do together in an open file, design file or board (docs/board-meeting.md). The wire types of
// `/api/design-files/:id/meeting`, the limits both sides check, and the pure rules the editor and the server share: the timer's
// phases on the server's clock, a vote's tally, cursor chat text, the high five. No zod and no server imports.
//
// Two kinds of state, never mixed:
// - durable (PostgreSQL, design_meetings and design_meeting_votes; it survives reloads, reconnects and deploys): the shared timer
//   and a voting session with its ballots. The server orders every change (`revision`); the stream says only that something
//   changed (`event: meeting {revision, user?}`) and each editor reads `GET …/meeting`, which also carries the server's clock;
// - ephemeral (a field of each connection's presence, kept in the stream's memory only, never stored): cursor chat, emote
//   bursts, a wave for a high five and "Spotlight".
//
// Routes (signed in; `fileAccess`: 'view' reads and votes, 'edit' runs the timer and the vote; writes refuse a file in the trash):
//   GET  /api/design-files/:id/meeting                                    → DesignMeetingState
//   POST /api/design-files/:id/meeting/timer        MeetingTimerAction    → DesignMeetingState   (edit)
//   POST /api/design-files/:id/meeting/vote         MeetingVoteAction     → DesignMeetingState   (edit)
//   POST /api/design-files/:id/meeting/vote/ballot  MeetingBallot         → DesignMeetingState   (view, while the vote runs)
//   GET  /api/design-files/:id/meeting/votes                              → DesignMeetingVotes   (the last ended sessions)
//   DELETE /api/design-files/:id/meeting/votes/:voteId                    → {ok: true}           (edit)
import {pointInRect, worldBox} from './geometry';
import type {DesignDocument, NodeId, SceneNode, Vec} from './types';

export const MEETING_LIMITS = {
  /** The shortest and longest timer: "00:05" to "99:59", the pill's two digits each. */
  timerMinMs: 5_000,
  timerMaxMs: 5_999_000,
  /** "+1 min". */
  addMs: 60_000,
  /** A timer that reached zero shows "Time is up" this long, then the pill rests. */
  doneShownMs: 10_000,
  /** Votes each person places in one session. */
  votesPerPersonMin: 1,
  votesPerPersonMax: 20,
  votesPerPersonDefault: 3,
  /** Objects a results list names (the rest still count in their badges up to this many). */
  results: 100,
  /** Characters of one cursor chat message (code points). */
  chatLength: 100,
  /** A layer or page id (schema.ts). */
  idLength: 512,
  /** Characters of a vote's prompt (code points). */
  promptLength: 120,
  /** Ended sessions a file keeps ("Results"): the newest ones. */
  history: 20,
} as const;

/** Presets of the timer's popover, in minutes (FigJam's "1 · 3 · 5 · 10"; ± sets any other). */
export const MEETING_TIMER_PRESETS_MIN = [1, 3, 5, 10] as const;

/** Background music while the timer runs: played by each editor from a generator in the browser (src/design/meeting/music.ts),
 *  composed for Morfa; no recording, nothing fetched from anyone. */
export const MEETING_TRACKS = [
  {id: 'lofi', label: 'Lo-fi'},
  {id: 'ambient', label: 'Ambient'},
  {id: 'rain', label: 'Rain'},
] as const;
export type MeetingTrack = (typeof MEETING_TRACKS)[number]['id'];
export const isMeetingTrack = (value: unknown): value is MeetingTrack => MEETING_TRACKS.some(track => track.id === value);

/** Emote bursts at one's cursor (FigJam's emotes), drawn with the system's emoji. */
export const MEETING_EMOTES = [
  {id: 'heart', emoji: '❤️', label: 'Heart'},
  {id: 'like', emoji: '👍', label: 'Like'},
  {id: 'dislike', emoji: '👎', label: 'Dislike'},
  {id: 'fire', emoji: '🔥', label: 'Fire'},
  {id: 'laugh', emoji: '😂', label: 'Funny'},
  {id: 'wow', emoji: '😮', label: 'Wow'},
  {id: 'party', emoji: '🎉', label: 'Hooray'},
] as const;
export type MeetingEmote = (typeof MEETING_EMOTES)[number]['id'];
export const isMeetingEmote = (value: unknown): value is MeetingEmote => MEETING_EMOTES.some(emote => emote.id === value);
export const emoteEmoji = (id: MeetingEmote) => MEETING_EMOTES.find(emote => emote.id === id)?.emoji ?? '❤️';
/** The hand a wave shows, and what two waves that meet become. */
export const WAVE_EMOJI = '✋';
export const HIGH_FIVE_EMOJI = '🙌';

// ── Durable state ────────────────────────────────────────────────────────────────────────────────

export type MeetingPerson = {id: string | null; name: string};

/** The shared timer. `running`: it reaches zero at `endsAt` (the server's clock, ms since 1970); `paused`: `remainingMs` are left.
 *  A running timer whose `endsAt` passed has ended (`timerPhase`). Stopped, there is none. */
export type MeetingTimer = {
  state: 'running' | 'paused';
  /** What it was set to, "+1 min" included (the pill's ring). */
  durationMs: number;
  endsAt: number | null;
  remainingMs: number | null;
  music: MeetingTrack | null;
  by: MeetingPerson | null;
};

/** In a vote's `results` after its end, `by`: how many votes each person gave the object, the most first (then by name). */
export type MeetingTally = {nodeId: NodeId; count: number; by?: {name: string; count: number}[]};

/** A voting session. Counts are hidden while it runs: each person sees only `mine`; once it ends everyone gets `results`. */
export type MeetingVote = {
  id: string;
  by: MeetingPerson | null;
  perPerson: number;
  /** It ends when the timer reaches zero (and pauses with it). */
  withTimer: boolean;
  startedAt: number;
  /** When it ends by itself (the timer's end), or null: when an editor ends it. */
  endsAt: number | null;
  endedAt: number | null;
  /** The caller's own votes. */
  mine: MeetingTally[];
  /** After the end: every voted object, the most votes first (at most MEETING_LIMITS.results). */
  results: MeetingTally[] | null;
  /** After the end: how many people voted. */
  voters: number | null;
  /** What the vote asks ("Which idea?"), shown in the vote bar and the results; null without one. */
  prompt: string | null;
  /** While it runs, everyone's editor hides the others' cursors (the presence layer reads it; nothing else changes). */
  hideCursors: boolean;
};

/** An ended session as "Results" lists it: its results with who voted for what. */
export type DesignMeetingVoteRecord = {id: string; prompt: string | null; startedAt: number; endedAt: number; voters: number; results: MeetingTally[]};
export type DesignMeetingVotes = {votes: DesignMeetingVoteRecord[]};

export type DesignMeetingState = {
  /** Grows with every change of the file's meeting; an older answer never replaces a newer one. */
  revision: number;
  /** The server's clock when it answered (the editors count down by it, not by their own). */
  now: number;
  timer: MeetingTimer | null;
  vote: MeetingVote | null;
  /** The caller may run the timer and votes (edit access). */
  canControl: boolean;
};

export type MeetingTimerAction =
  | {action: 'start'; durationMs: number; music?: MeetingTrack | null}
  | {action: 'pause'}
  | {action: 'resume'}
  | {action: 'add'}
  | {action: 'stop'}
  | {action: 'music'; music: MeetingTrack | null};
export type MeetingVoteAction =
  | {action: 'start'; perPerson: number; durationMs: number | null; music?: MeetingTrack | null; prompt?: string | null; hideCursors?: boolean}
  /** Hide (or show again) the others' cursors while the vote runs. */
  | {action: 'cursors'; hide: boolean}
  | {action: 'end'}
  | {action: 'clear'};
export type MeetingBallot = {voteId: string; nodeId: NodeId; delta: 1 | -1};

/** The stream's `meeting` event: the file's meeting changed (`user`: only that person's votes did, sent to their tabs only). */
export type DesignMeetingSignal = {revision: number; user?: string};

// ── The timer ────────────────────────────────────────────────────────────────────────────────────

export type TimerPhase = 'idle' | 'running' | 'paused' | 'done';

/** What the timer shows at `now` (the server's clock). */
export function timerPhase(timer: MeetingTimer | null, now: number): TimerPhase {
  if (!timer) return 'idle';
  if (timer.state === 'paused') return 'paused';
  const endsAt = timer.endsAt ?? 0;
  if (now < endsAt) return 'running';
  return now - endsAt < MEETING_LIMITS.doneShownMs ? 'done' : 'idle';
}

/** Milliseconds left at `now`: none once it ended. */
export function timerRemaining(timer: MeetingTimer | null, now: number): number {
  if (!timer) return 0;
  if (timer.state === 'paused') return Math.max(0, timer.remainingMs ?? 0);
  return Math.max(0, (timer.endsAt ?? 0) - now);
}

/** "03:00": minutes and seconds, the seconds rounded up (a countdown shows 03:00 for its first second, 00:01 for its last). */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000 - 1e-9));
  const minutes = Math.min(99, Math.floor(total / 60)),
    seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** "3 minutes", "1 minute", "30 seconds" — a duration in words for labels. */
export function durationWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 !== 0 || seconds < 60) return `${seconds} ${plural(seconds, 'second', 'seconds')}`;
  const minutes = seconds / 60;
  return `${minutes} ${plural(minutes, 'minute', 'minutes')}`;
}

export const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

export const clampTimer = (ms: number) => Math.min(MEETING_LIMITS.timerMaxMs, Math.max(MEETING_LIMITS.timerMinMs, Math.round(ms / 1000) * 1000));

// ── Votes ────────────────────────────────────────────────────────────────────────────────────────

/** The vote no longer takes ballots at `now`: an editor ended it, or its timer reached zero. */
export const voteEnded = (vote: Pick<MeetingVote, 'endedAt' | 'endsAt'>, now: number) => vote.endedAt !== null || (vote.endsAt !== null && now >= vote.endsAt);
export const votesUsed = (mine: readonly MeetingTally[]) => mine.reduce((sum, tally) => sum + tally.count, 0);
export const votesLeft = (vote: Pick<MeetingVote, 'perPerson' | 'mine'>) => Math.max(0, vote.perPerson - votesUsed(vote.mine));
export const countOf = (tallies: readonly MeetingTally[] | null | undefined, nodeId: NodeId) => tallies?.find(tally => tally.nodeId === nodeId)?.count ?? 0;

/** A ballot applied to one person's votes: their list after it, or why it is refused. */
export function applyBallot(mine: readonly MeetingTally[], perPerson: number, nodeId: NodeId, delta: 1 | -1): MeetingTally[] | 'no-votes-left' | 'no-vote-here' {
  const current = countOf(mine, nodeId);
  if (delta > 0 && votesUsed(mine) >= perPerson) return 'no-votes-left';
  if (delta < 0 && current === 0) return 'no-vote-here';
  const next = current + delta;
  const others = mine.filter(tally => tally.nodeId !== nodeId);
  return next > 0 ? [...others, {nodeId, count: next}].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)) : others;
}

export type RankedTally = MeetingTally & {rank: number};
/** The results the most votes first; equal counts share a place ("1, 1, 3"), ties in id order so every editor lists them alike. */
export function rankTallies(tallies: readonly MeetingTally[]): RankedTally[] {
  const sorted = [...tallies].filter(tally => tally.count > 0).sort((a, b) => b.count - a.count || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  let rank = 0,
    previous = Number.NaN;
  return sorted.map((tally, index) => {
    if (tally.count !== previous) {
      rank = index + 1;
      previous = tally.count;
    }
    return {...tally, rank};
  });
}

// ── Ephemeral: presence ──────────────────────────────────────────────────────────────────────────

/** What a connection shows the others besides its cursor (DesignPresence.meeting): never stored. */
export type MeetingPresence = {
  /** Cursor chat: the text being typed or just sent ('' while open and empty), null when closed. */
  chat: string | null;
  /** The last emote burst: `n` grows with each burst, so the others play every one (and none they find already there). */
  emote: {id: MeetingEmote; n: number} | null;
  /** Waving for a high five: a number for this wave while the button is held, else null. */
  wave: number | null;
  /** "Spotlight": a number for this spotlight while it lasts, else null. */
  spotlight: number | null;
};
export const EMPTY_MEETING_PRESENCE: MeetingPresence = {chat: null, emote: null, wave: null, spotlight: null};

export const sameMeetingPresence = (a: MeetingPresence | null | undefined, b: MeetingPresence | null | undefined) =>
  (a ?? null) === (b ?? null) ||
  (!!a && !!b && a.chat === b.chat && a.wave === b.wave && a.spotlight === b.spotlight && (a.emote === b.emote || (!!a.emote && !!b.emote && a.emote.id === b.emote.id && a.emote.n === b.emote.n)));

// Control characters (C0, DEL, C1), bidirectional overrides and isolates, and line or paragraph separators never reach a bubble.
// eslint-disable-next-line no-control-regex
const CHAT_REFUSED = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/** Cursor chat text as everyone shows it: one line, no control or direction characters, at most MEETING_LIMITS.chatLength code points. */
export function cleanChat(text: string): string {
  return [...text.replace(CHAT_REFUSED, ' ')].slice(0, MEETING_LIMITS.chatLength).join('');
}
/** The server's check: text the editor would have sent as it is. */
export const isCleanChat = (text: string) => cleanChat(text) === text;

/** A vote's prompt as everyone shows it: one line, as cursor chat cleans it, trimmed, at most MEETING_LIMITS.promptLength code points;
 *  null when nothing is left. */
export function cleanPrompt(text: string | null | undefined): string | null {
  const line = [...(text ?? '').replace(CHAT_REFUSED, ' ').replace(/\s+/g, ' ').trim()].slice(0, MEETING_LIMITS.promptLength).join('').trim();
  return line || null;
}

/** Two cursors close enough to high-five: their distance on screen, at the larger zoom of the two, is at most this. */
export const HIGH_FIVE_PX = 72;

export type Waver = {connection: string; wave: number; page: NodeId | null; cursor: Vec | null; zoom: number};
/** Pairs of people waving at each other on one page (each pair once, in connection order), the meeting point between them. */
export function highFives(wavers: readonly Waver[]): {a: string; b: string; key: string; at: Vec}[] {
  const out: {a: string; b: string; key: string; at: Vec}[] = [];
  const sorted = [...wavers].filter(w => w.cursor && w.page).sort((x, y) => (x.connection < y.connection ? -1 : 1));
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i],
        b = sorted[j];
      if (a.page !== b.page) continue;
      const zoom = Math.max(a.zoom || 1, b.zoom || 1);
      const dx = a.cursor!.x - b.cursor!.x,
        dy = a.cursor!.y - b.cursor!.y;
      if (Math.hypot(dx, dy) * zoom > HIGH_FIVE_PX) continue;
      out.push({a: a.connection, b: b.connection, key: `${a.connection}:${a.wave}|${b.connection}:${b.wave}`, at: {x: (a.cursor!.x + b.cursor!.x) / 2, y: (a.cursor!.y + b.cursor!.y) / 2}});
    }
  return out;
}

// ── What a vote counts in a design file ──────────────────────────────────────────────────────────

const VOTABLE: ReadonlySet<SceneNode['type']> = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP']);

/**
 * In a design file people vote for frames: the top-level frame (or component, set, instance, group) under `point` on the page, the
 * frontmost first; frames inside a section count as top-level, the section itself does not. Hidden ones are skipped. A board passes
 * its own rule (stickies, shapes) through the editor's `MeetingTargets`.
 */
export function frameTargetAt(doc: DesignDocument, pageId: NodeId, point: Vec): NodeId | null {
  const page = doc.nodes[pageId];
  if (!page || page.type !== 'PAGE') return null;
  const walk = (children: readonly NodeId[]): NodeId | null => {
    for (let index = children.length - 1; index >= 0; index--) {
      const node = doc.nodes[children[index]];
      if (!node || node.visible === false) continue;
      // The box on the page (a rotated frame by its bounds, as a hover outline takes it).
      if (!pointInRect(point, worldBox(doc, node.id))) continue;
      if (node.type === 'SECTION') {
        const found = walk(node.children ?? []);
        if (found) return found;
        continue;
      }
      if (VOTABLE.has(node.type)) return node.id;
    }
    return null;
  };
  return walk(page.children ?? []);
}

/** A results row's name: a frame's name, a text's own words. */
export function targetLabel(doc: DesignDocument, id: NodeId): string {
  const node = doc.nodes[id];
  if (!node) return 'Deleted object';
  const text = node.type === 'TEXT' ? node.text?.characters : undefined;
  const label = (text ?? node.name ?? '').replace(/\s+/g, ' ').trim();
  return label.length > 60 ? label.slice(0, 59) + '…' : label || 'Untitled';
}
