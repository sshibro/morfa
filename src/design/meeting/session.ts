import {api, ApiError} from '../../api';
import {
  applyBallot,
  voteEnded,
  type DesignMeetingSignal,
  type DesignMeetingState,
  type MeetingBallot,
  type MeetingTimerAction,
  type MeetingVoteAction,
} from '../../../shared/design/meeting';
import type {NodeId} from '../../../shared/design/types';
import {createServerClock, type ServerClock} from './clock';

// The durable half of "Meeting" in one open file (docs/board-meeting.md): the shared timer and the voting session as the server last
// said, with the server's clock. The stream only says that something changed (`meeting {revision}`); this reads the state again,
// once at a time, a little spread out so fifty people do not ask in the same millisecond. Its own actions get the new state in
// their answers. An answer older than what is shown (a lower revision) never replaces it. Ballots show at once and are corrected by
// the server's answer when no other ballot is on its way.

export type MeetingTransport = {
  read(fileId: string): Promise<DesignMeetingState>;
  timer(fileId: string, action: MeetingTimerAction & {client?: string | null}): Promise<DesignMeetingState>;
  vote(fileId: string, action: MeetingVoteAction & {client?: string | null}): Promise<DesignMeetingState>;
  ballot(fileId: string, ballot: MeetingBallot & {client?: string | null}): Promise<DesignMeetingState>;
};

const base = (fileId: string) => `/design-files/${encodeURIComponent(fileId)}/meeting`;
const send = <T>(url: string, data: unknown) => api<T>(url, {method: 'POST', body: JSON.stringify(data)});
/** Two answers of the same revision that differ only in the server's clock (`now`). */
const sameButClock = (a: DesignMeetingState, b: DesignMeetingState) => JSON.stringify({...a, now: 0}) === JSON.stringify({...b, now: 0});
export const browserMeetingTransport: MeetingTransport = {
  read: fileId => api<DesignMeetingState>(base(fileId), {cache: 'no-store'}),
  timer: (fileId, action) => send(base(fileId) + '/timer', action),
  vote: (fileId, action) => send(base(fileId) + '/vote', action),
  ballot: (fileId, ballot) => send(base(fileId) + '/vote/ballot', ballot),
};

export type MeetingSession = {
  readonly clock: ServerClock;
  state(): DesignMeetingState | null;
  subscribe(listener: () => void): () => void;
  /** The stream said the meeting changed. */
  signal(signal: DesignMeetingSignal): void;
  /** Reads the state again (the stream (re)connected). */
  refresh(): void;
  timer(action: MeetingTimerAction): Promise<boolean>;
  vote(action: MeetingVoteAction): Promise<boolean>;
  /** One vote more (1) or less (−1) for `nodeId` in the running session; false when refused. */
  ballot(nodeId: NodeId, delta: 1 | -1): Promise<boolean>;
  dispose(): void;
};

type Timers = {setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number; random(): number};
const realTimers: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  random: () => Math.random(),
};

export function createMeetingSession(options: {
  fileId: string;
  /** This editor's stream connection (sent with its actions so its own stream is not told about them). */
  client: () => string | null;
  /** The user this editor acts for: a `meeting {user}` signal for them means their votes changed in another tab. */
  user: () => string | null;
  onError?(message: string): void;
  transport?: MeetingTransport;
  timers?: Timers;
  clock?: ServerClock;
}): MeetingSession {
  const {fileId} = options;
  const transport = options.transport ?? browserMeetingTransport;
  const timers = options.timers ?? realTimers;
  const clock = options.clock ?? createServerClock(timers.now);
  const listeners = new Set<() => void>();
  let state: DesignMeetingState | null = null;
  let disposed = false;
  let reading = false;
  let readAgain = false;
  let pendingRead: unknown = null;
  let endWatch: unknown = null;
  let ballots = 0;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  /** Takes `next` unless an answer already shown is newer. A re-read that brings nothing new (the same revision and
   *  the same state but the server's clock) keeps the shown state and wakes no one: every meeting control re-rendered
   *  on each poll and stream notice before. */
  function adopt(next: DesignMeetingState, sentAt: number, receivedAt: number) {
    clock.sample(next.now, sentAt, receivedAt);
    if (state && next.revision < state.revision) return;
    if (state && next.revision === state.revision && sameButClock(state, next)) return;
    state = next;
    watchVoteEnd();
    notify();
  }
  /** A running vote that ends by its timer: read the results once it has (each editor a moment apart). */
  function watchVoteEnd() {
    if (endWatch !== null) timers.clearTimeout(endWatch);
    endWatch = null;
    const vote = state?.vote;
    if (!vote || vote.endsAt === null || vote.endedAt !== null) return;
    const wait = Math.max(0, vote.endsAt - clock.now()) + 150 + timers.random() * 900;
    endWatch = timers.setTimeout(() => {
      endWatch = null;
      read();
    }, wait);
  }

  async function read() {
    if (disposed) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    const sentAt = timers.now();
    try {
      const next = await transport.read(fileId);
      if (!disposed) adopt(next, sentAt, timers.now());
    } catch {
      // The next signal or reconnect reads again.
    } finally {
      reading = false;
      if (readAgain && !disposed) {
        readAgain = false;
        void read();
      }
    }
  }
  /** Soon, spread out: everyone in the file hears the same signal at once. */
  function readSoon(spreadMs = 250) {
    if (pendingRead !== null || disposed) return;
    pendingRead = timers.setTimeout(() => {
      pendingRead = null;
      void read();
    }, timers.random() * spreadMs);
  }

  async function act(run: () => Promise<DesignMeetingState>): Promise<boolean> {
    const sentAt = timers.now();
    try {
      const next = await run();
      if (!disposed) adopt(next, sentAt, timers.now());
      return true;
    } catch (error) {
      if (!disposed) {
        options.onError?.(error instanceof ApiError ? error.message : 'Could not reach the server. Check your connection.');
        void read();
      }
      return false;
    }
  }

  return {
    clock,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signal(signal) {
      if (signal.user !== undefined) {
        // Only this person's votes changed (another tab of theirs voted).
        if (signal.user === options.user()) readSoon(50);
        return;
      }
      if (!state || signal.revision > state.revision) readSoon();
    },
    refresh: () => void read(),
    timer: action => act(() => transport.timer(fileId, {...action, client: options.client()})),
    vote: action => act(() => transport.vote(fileId, {...action, client: options.client()})),
    async ballot(nodeId, delta) {
      const vote = state?.vote;
      if (!state || !vote || voteEnded(vote, clock.now())) return false;
      const mine = applyBallot(vote.mine, vote.perPerson, nodeId, delta);
      if (typeof mine === 'string') return false;
      // Shown at once; the answer corrects it when no later ballot is on its way.
      state = {...state, vote: {...vote, mine}};
      notify();
      ballots++;
      const sentAt = timers.now();
      try {
        const next = await transport.ballot(fileId, {voteId: vote.id, nodeId, delta, client: options.client()});
        ballots--;
        if (!disposed && ballots === 0) adopt(next, sentAt, timers.now());
        return true;
      } catch (error) {
        ballots--;
        if (!disposed) {
          options.onError?.(error instanceof ApiError ? error.message : 'The vote was not saved. Check your connection.');
          void read();
        }
        return false;
      }
    },
    dispose() {
      disposed = true;
      if (pendingRead !== null) timers.clearTimeout(pendingRead);
      if (endWatch !== null) timers.clearTimeout(endWatch);
      listeners.clear();
    },
  };
}
