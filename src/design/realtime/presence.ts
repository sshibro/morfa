import type {NodeId, Vec} from '../../../shared/design/types';
import {DESIGN_LIVE, EMPTY_PRESENCE, type DesignPeer, type DesignPresence, type DesignPresencePost, type DesignViewportPresence} from '../../../shared/design/live';
import {sameMeetingPresence} from '../../../shared/design/meeting';

// Who else is in the file and where (docs/design-tool.md "Co-editing"): the peers the stream reports, kept
// outside the design store so a cursor moving many times a second never wakes a panel. Two subscriptions: the roster
// (people, their colours and pages: the avatars) changes only when someone comes, goes or changes page; motion (cursors,
// selections, viewports) is read by the canvas overlay once per animation frame.

/** An avatar's letters: the first of the first two words ("Anna Smith" → "AS"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map(word => [...word][0] ?? '');
  return (letters.join('') || '?').toLocaleUpperCase('en');
}

/** One person in the file (their tabs together), as the avatars show them. */
export type RosterEntry = {
  user: string;
  name: string;
  color: number;
  /** Their connections, the most recently active first. */
  connections: readonly string[];
  page: NodeId | null;
  /** This account in another tab. */
  self: boolean;
  /** Someone with view rights only (Viewer, Developer). */
  viewer: boolean;
};

export interface PeerStore {
  /** Every other connection, by connection id. */
  peers(): ReadonlyMap<string, DesignPeer>;
  roster(): readonly RosterEntry[];
  subscribeRoster(listener: () => void): () => void;
  subscribeMotion(listener: () => void): () => void;
  /** The connection being followed ("follow"), or null. */
  following(): string | null;
  follow(connection: string | null): void;
  subscribeFollowing(listener: () => void): () => void;
  /** Stream events. */
  reset(peers: readonly DesignPeer[], self: {connection: string; user: string}): void;
  update(peers: readonly DesignPeer[]): void;
  leave(connection: string): void;
  /** This editor's stream dropped: everyone stays shown a moment (they most likely still are), until the next hello says. */
  stale(): void;
  clear(): void;
}

/**
 * How long someone stays shown after their stream (or this editor's) went: a reconnect, which takes about half a second (a
 * restarting server, a network change, a laptop waking), never makes their avatar, cursor and selection vanish and come back.
 */
export const PRESENCE_LINGER_MS = 3_000;

type Timers = {now(): number; setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void};
const realTimers: Timers = {now: () => performance.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)};

const sameRoster = (a: readonly RosterEntry[], b: readonly RosterEntry[]) =>
  a.length === b.length &&
  a.every((entry, i) => {
    const other = b[i];
    return entry.user === other.user && entry.name === other.name && entry.color === other.color && entry.page === other.page && entry.self === other.self && entry.viewer === other.viewer && entry.connections.length === other.connections.length && entry.connections.every((id, j) => id === other.connections[j]);
  });

export function createPeerStore(options: {lingerMs?: number; timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>} = {}): PeerStore {
  const lingerMs = options.lingerMs ?? PRESENCE_LINGER_MS;
  const timers = options.timers ?? realTimers;
  const peers = new Map<string, DesignPeer>();
  /** Connections that went and are still shown, with the timer that removes them. */
  const lingering = new Map<string, unknown>();
  /** When each connection last changed: the avatars list the people who moved last first among equals. */
  const activeAt = new Map<string, number>();
  let me: {connection: string; user: string} | null = null;
  let roster: readonly RosterEntry[] = [];
  let following: string | null = null;
  const rosterListeners = new Set<() => void>(), motionListeners = new Set<() => void>(), followListeners = new Set<() => void>();
  const notify = (set: Set<() => void>) => {
    for (const listener of [...set]) listener();
  };
  // Join order decides the avatars' order; it never reshuffles while people work.
  const joined = new Map<string, number>();
  let order = 0;

  function rebuild() {
    const byUser = new Map<string, RosterEntry & {connections: string[]}>();
    for (const peer of peers.values()) {
      let entry = byUser.get(peer.user);
      if (!entry) {
        entry = {user: peer.user, name: peer.name, color: peer.color, connections: [], page: peer.page, self: peer.user === me?.user, viewer: peer.role === 'viewer' || peer.role === 'developer'};
        byUser.set(peer.user, entry);
      }
      entry.connections.push(peer.connection);
    }
    for (const entry of byUser.values()) {
      entry.connections.sort((a, b) => (activeAt.get(b) ?? 0) - (activeAt.get(a) ?? 0) || a.localeCompare(b));
      entry.page = peers.get(entry.connections[0])?.page ?? null;
    }
    const next = [...byUser.values()].sort((a, b) => Number(a.self) - Number(b.self) || (joined.get(a.user) ?? 0) - (joined.get(b.user) ?? 0) || a.user.localeCompare(b.user));
    if (sameRoster(next, roster)) return;
    roster = next;
    notify(rosterListeners);
  }
  function put(peer: DesignPeer) {
    if (peer.connection === me?.connection) return;
    unlinger(peer.connection);
    // Back on a new connection: the one that went gives way, and following moves over.
    for (const old of [...lingering.keys()])
      if (peers.get(old)?.user === peer.user) {
        unlinger(old);
        peers.delete(old);
        activeAt.delete(old);
        if (following === old) {
          following = peer.connection;
          notify(followListeners);
        }
      }
    const previous = peers.get(peer.connection);
    peers.set(peer.connection, peer);
    if (!joined.has(peer.user)) joined.set(peer.user, order++);
    if (!previous || previous.cursor?.x !== peer.cursor?.x || previous.cursor?.y !== peer.cursor?.y || previous.page !== peer.page || previous.selectionCount !== peer.selectionCount) activeAt.set(peer.connection, Date.now());
  }
  function unlinger(connection: string) {
    if (!lingering.has(connection)) return;
    timers.clearTimeout(lingering.get(connection));
    lingering.delete(connection);
  }
  function linger(connection: string) {
    if (lingering.has(connection) || !peers.has(connection)) return;
    lingering.set(
      connection,
      timers.setTimeout(() => {
        lingering.delete(connection);
        drop(connection);
      }, lingerMs),
    );
  }
  function drop(connection: string) {
    if (!peers.delete(connection)) return;
    activeAt.delete(connection);
    dropFollowing();
    rebuild();
    notify(motionListeners);
  }
  function dropFollowing() {
    if (following && !peers.has(following)) {
      following = null;
      notify(followListeners);
    }
  }

  return {
    peers: () => peers,
    roster: () => roster,
    subscribeRoster(listener) {
      rosterListeners.add(listener);
      return () => void rosterListeners.delete(listener);
    },
    subscribeMotion(listener) {
      motionListeners.add(listener);
      return () => void motionListeners.delete(listener);
    },
    following: () => following,
    follow(connection) {
      const next = connection && peers.has(connection) ? connection : null;
      if (next === following) return;
      following = next;
      notify(followListeners);
    },
    subscribeFollowing(listener) {
      followListeners.add(listener);
      return () => void followListeners.delete(listener);
    },
    reset(list, self) {
      me = self;
      // Someone shown and missing from the hello may be in the file through another server that has not said so yet: they
      // stay a moment, as after a leave.
      const listed = new Set(list.map(peer => peer.connection));
      for (const connection of [...peers.keys()]) if (!listed.has(connection)) linger(connection);
      for (const peer of list) put(peer);
      dropFollowing();
      rebuild();
      notify(motionListeners);
    },
    update(list) {
      for (const peer of list) put(peer);
      rebuild();
      notify(motionListeners);
    },
    leave(connection) {
      const peer = peers.get(connection);
      if (!peer) return;
      // Their other tab is still here: this one goes at once. Their last one stays a moment, in case they are only reconnecting.
      if ([...peers.values()].some(other => other.user === peer.user && other.connection !== connection && !lingering.has(other.connection))) {
        unlinger(connection);
        drop(connection);
      } else linger(connection);
    },
    stale() {
      for (const connection of peers.keys()) linger(connection);
    },
    clear() {
      for (const handle of lingering.values()) timers.clearTimeout(handle);
      lingering.clear();
      if (!peers.size) return;
      peers.clear();
      dropFollowing();
      rebuild();
      notify(motionListeners);
    },
  };
}

// ── What this editor shows the others ────────────────────────────────────────────────────────────

export type LocalPresence = {
  /** Merges fields into this editor's presence; sent at most every DESIGN_LIVE.presenceMs (the last state always goes). */
  set(partial: Partial<DesignPresence>): void;
  /** A new stream: everything is sent again with its token. */
  connected(token: string): void;
  disconnected(): void;
  dispose(): void;
};


const sameVec = (a: Vec | null | undefined, b: Vec | null | undefined) => (a ?? null) === (b ?? null) || (!!a && !!b && a.x === b.x && a.y === b.y);
const sameViewport = (a: DesignViewportPresence | null, b: DesignViewportPresence | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.zoom === b.zoom && a.width === b.width && a.height === b.height);
const sameIds = (a: readonly string[], b: readonly string[]) => a === b || (a.length === b.length && a.every((id, i) => id === b[i]));

/**
 * Coalesces this editor's presence and sends only what changed, at most once per `intervalMs` (a cursor crossing the
 * canvas makes ~16 posts a second on the SSE path, ~30 frames on the socket, not one per pointer event). `send` resolves false when the stream is gone.
 */
export function createLocalPresence(send: (post: DesignPresencePost) => Promise<boolean>, options: {intervalMs?: number | (() => number); timers?: Timers; onGone?: () => void} = {}): LocalPresence {
  // Config-driven: the transport decides (60 ms on the SSE path, 33 ms = 30 Hz on the socket, crates/protocol limits).
  const intervalOf = typeof options.intervalMs === 'function' ? options.intervalMs : () => (options.intervalMs as number | undefined) ?? DESIGN_LIVE.presenceMs;
  const timers = options.timers ?? realTimers;
  let current: DesignPresence = {...EMPTY_PRESENCE};
  let sent: DesignPresence | null = null;
  let token: string | null = null;
  let lastAt = -Infinity;
  let timer: unknown = null;
  let inflight = false;
  let disposed = false;

  function diff(): Partial<DesignPresence> | null {
    const out: Partial<DesignPresence> = {};
    if (!sent || !sameVec(sent.cursor, current.cursor)) out.cursor = current.cursor;
    if (!sent || sent.page !== current.page) out.page = current.page;
    if (!sent || !sameIds(sent.selection, current.selection) || sent.selectionCount !== current.selectionCount) {
      out.selection = current.selection;
      out.selectionCount = current.selectionCount;
    }
    if (!sent || !sameViewport(sent.viewport, current.viewport)) out.viewport = current.viewport;
    if (!sent || sent.editing !== current.editing) out.editing = current.editing;
    // "Meeting" (cursor chat, emotes, a wave, spotlight): only once the meeting module set it, so an older server never sees the field.
    if (current.meeting !== undefined && (!sent || !sameMeetingPresence(sent.meeting, current.meeting))) out.meeting = current.meeting;
    return Object.keys(out).length ? out : null;
  }
  function flush() {
    timer = null;
    if (disposed || !token || inflight) return;
    const changes = diff();
    if (!changes) return;
    const wait = lastAt + intervalOf() - timers.now();
    if (wait > 0) {
      timer = timers.setTimeout(flush, wait);
      return;
    }
    lastAt = timers.now();
    const snapshot = current, to = token;
    inflight = true;
    void send({token, ...changes}).then(
      ok => {
        inflight = false;
        // The stream it was for went meanwhile: its answer says nothing about the new one, which gets everything.
        if (token !== to) return void schedule();
        if (!ok) {
          options.onGone?.();
          return;
        }
        sent = snapshot;
        if (diff()) schedule();
      },
      () => {
        inflight = false;
        // Lost on the way: the next change resends everything that differs.
        schedule();
      },
    );
  }
  function schedule() {
    if (timer !== null || disposed) return;
    timer = timers.setTimeout(flush, Math.max(0, lastAt + intervalOf() - timers.now()));
  }
  return {
    set(partial) {
      current = {...current, ...partial};
      schedule();
    },
    connected(next) {
      token = next;
      sent = null;
      schedule();
    },
    disconnected() {
      token = null;
      sent = null;
    },
    dispose() {
      disposed = true;
      if (timer !== null) timers.clearTimeout(timer);
    },
  };
}
