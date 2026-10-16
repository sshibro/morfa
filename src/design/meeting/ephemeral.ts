import {EMPTY_MEETING_PRESENCE, highFives, type MeetingEmote, type MeetingPresence, type Waver} from '../../../shared/design/meeting';
import type {DesignPeer} from '../../../shared/design/live';
import type {Vec} from '../../../shared/design/types';
import type {LocalPresence, PeerStore} from '../realtime/presence';

// The ephemeral half of "Meeting" (docs/board-meeting.md): what this editor shows the others besides its cursor — cursor chat, the
// last emote burst, a wave, "Get attention" — as the `meeting` field of its presence (sent with the cursor's own coalesced posts,
// held in the stream's memory, never stored), and what it hears of the others': a new burst, a changed chat, a wave that meets
// another, someone asking for attention. Nothing here touches React or the DOM; the canvas layer draws what it is told.

export type LocalMeeting = {
  current(): MeetingPresence;
  /** Opens (''), types into or closes (null) cursor chat. */
  chat(text: string | null): void;
  /** One burst of `id` at this editor's cursor. */
  emote(id: MeetingEmote): void;
  wave(on: boolean): void;
  spotlight(on: boolean): void;
  subscribe(listener: () => void): () => void;
};

export function createLocalMeeting(presence: LocalPresence, random: () => number = Math.random): LocalMeeting {
  let current: MeetingPresence = {...EMPTY_MEETING_PRESENCE};
  let bursts = 0;
  const listeners = new Set<() => void>();
  const set = (partial: Partial<MeetingPresence>) => {
    const next = {...current, ...partial};
    if (next.chat === current.chat && next.emote === current.emote && next.wave === current.wave && next.spotlight === current.spotlight) return;
    current = next;
    presence.set({meeting: current});
    for (const listener of [...listeners]) listener();
  };
  const token = () => 1 + Math.floor(random() * 2 ** 30);
  return {
    current: () => current,
    chat: text => set({chat: text}),
    emote: id => set({emote: {id, n: ++bursts}}),
    wave: on => set({wave: on ? (current.wave ?? token()) : null}),
    spotlight: on => set({spotlight: on ? (current.spotlight ?? token()) : null}),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** What the others did since the last look, for the canvas layer. */
export type PeerEvents = {
  /** A new emote burst of `peer` (never one that was already there when this editor first saw them). */
  burst(peer: DesignPeer, id: MeetingEmote): void;
  /** Their cursor chat changed (null: closed). */
  chat(peer: DesignPeer, text: string | null): void;
  /** They started or stopped waving. */
  wave(peer: DesignPeer, waving: boolean): void;
  /** Two people's waves met: `at` is the point between their cursors (page space), on `page`. */
  highFive(a: string, b: string, at: Vec, page: string): void;
  /** They left: their bubble and hand go with their cursor. */
  gone(connection: string): void;
};

/** Watches the peers' `meeting` fields and reports what changed. `self` is this editor as a waver (its pointer and zoom). */
export function watchPeers(peers: PeerStore, events: PeerEvents, self: () => Waver | null): {check(): void; dispose(): void} {
  const seen = new Map<string, MeetingPresence | null>();
  const celebrated = new Set<string>();
  const check = () => {
    const all = peers.peers();
    for (const id of [...seen.keys()])
      if (!all.has(id)) {
        seen.delete(id);
        events.gone(id);
      }
    const wavers: Waver[] = [];
    for (const peer of all.values()) {
      const meeting = peer.meeting ?? null;
      const first = !seen.has(peer.connection);
      const before = seen.get(peer.connection) ?? null;
      if (!first && before !== meeting) {
        if (meeting?.emote && (meeting.emote.id !== before?.emote?.id || meeting.emote.n !== before?.emote?.n)) events.burst(peer, meeting.emote.id);
        if ((meeting?.chat ?? null) !== (before?.chat ?? null)) events.chat(peer, meeting?.chat ?? null);
        if ((meeting?.wave ?? null) !== (before?.wave ?? null)) events.wave(peer, meeting?.wave != null);
      } else if (first) {
        // Someone already chatting or waving when this editor arrived: show it, but replay no burst.
        if (meeting?.chat != null) events.chat(peer, meeting.chat);
        if (meeting?.wave != null) events.wave(peer, true);
      }
      seen.set(peer.connection, meeting);
      if (meeting?.wave != null) wavers.push({connection: peer.connection, wave: meeting.wave, page: peer.page, cursor: peer.cursor, zoom: peer.viewport?.zoom ?? 1});
    }
    const me = self();
    if (me) wavers.push(me);
    if (wavers.length < 2) return;
    const pageOf = new Map(wavers.map(waver => [waver.connection, waver.page]));
    for (const pair of highFives(wavers)) {
      if (celebrated.has(pair.key)) continue;
      celebrated.add(pair.key);
      if (celebrated.size > 200) celebrated.delete(celebrated.values().next().value!);
      events.highFive(pair.a, pair.b, pair.at, pageOf.get(pair.a)!);
    }
  };
  const off = peers.subscribeMotion(check);
  check();
  return {
    check,
    dispose() {
      off();
      seen.clear();
    },
  };
}

// ── "Get attention" ──────────────────────────────────────────────────────────────────────────

export type SpotlightView = {
  /** Who asks for everyone's attention now (the latest to start), or null. */
  presenter: {connection: string; name: string; color: number} | null;
  /** This editor is the one asking. */
  mine: boolean;
  /** This editor follows the presenter (false: it stepped away; "Follow" brings it back). */
  following: boolean;
};

/**
 * Figma's Spotlight: while someone asks for attention, every other editor follows them (their page and view) until it pans, zooms,
 * switches page or presses Escape — then a pill offers to follow again. The latest to start wins: someone already presenting stops
 * when another starts. It ends when they stop, close the file or lose the stream.
 */
export function createSpotlight(options: {peers: PeerStore; local: LocalMeeting; self: () => string | null; onYield?(name: string): void}) {
  const {peers, local} = options;
  const listeners = new Set<() => void>();
  /** When each spotlight was first seen here: the latest started wins. */
  const since = new Map<string, number>();
  const declined = new Set<string>();
  let order = 0;
  let mineSince = 0;
  let view: SpotlightView = {presenter: null, mine: false, following: false};
  let autoFollowed: string | null = null;

  const keyOf = (peer: DesignPeer) => `${peer.connection}:${peer.meeting?.spotlight}`;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  let updating = false,
    again = false;
  /** Following changes from inside (peers.follow notifies at once): one pass at a time, then once more if asked meanwhile. */
  function update() {
    if (updating) {
      again = true;
      return;
    }
    updating = true;
    try {
      do {
        again = false;
        pass();
      } while (again);
    } finally {
      updating = false;
    }
  }
  function pass() {
    let best: DesignPeer | null = null,
      bestAt = -1;
    for (const peer of peers.peers().values()) {
      if (peer.meeting?.spotlight == null) continue;
      const key = keyOf(peer);
      if (!since.has(key)) since.set(key, ++order);
      const at = since.get(key)!;
      if (at > bestAt) {
        best = peer;
        bestAt = at;
      }
    }
    for (const key of [...since.keys()]) if (![...peers.peers().values()].some(peer => peer.meeting?.spotlight != null && keyOf(peer) === key)) since.delete(key);
    const mine = local.current().spotlight != null;
    // Someone started after this editor did: it gives way.
    if (mine && best && bestAt > mineSince) {
      local.spotlight(false);
      options.onYield?.(best.name);
    }
    const stillMine = local.current().spotlight != null;
    const presenter = stillMine ? null : best;
    // Follow the presenter unless this editor stepped away from this spotlight.
    if (presenter && !declined.has(keyOf(presenter)) && peers.following() !== presenter.connection) {
      autoFollowed = presenter.connection;
      peers.follow(presenter.connection);
    }
    if (!presenter && autoFollowed && peers.following() === autoFollowed) peers.follow(null);
    if (!presenter) autoFollowed = null;
    const next: SpotlightView = {
      presenter: presenter ? {connection: presenter.connection, name: presenter.name, color: presenter.color} : null,
      mine: stillMine,
      following: !!presenter && peers.following() === presenter.connection,
    };
    if (next.mine !== view.mine || next.following !== view.following || next.presenter?.connection !== view.presenter?.connection || next.presenter?.name !== view.presenter?.name) {
      view = next;
      notify();
    }
  }
  const offMotion = peers.subscribeMotion(update);
  // Stepping away (Escape, a pan, "Stop following") declines this spotlight; following again accepts it.
  const offFollow = peers.subscribeFollowing(() => {
    const presenter = view.presenter;
    if (presenter) {
      const peer = peers.peers().get(presenter.connection);
      if (peer) {
        if (peers.following() === presenter.connection) declined.delete(keyOf(peer));
        else declined.add(keyOf(peer));
      }
    }
    update();
  });
  const offLocal = local.subscribe(update);
  update();
  return {
    view: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      mineSince = ++order;
      if (peers.following()) peers.follow(null);
      local.spotlight(true);
    },
    stop() {
      local.spotlight(false);
    },
    /** "Follow": back to the presenter after stepping away. */
    rejoin() {
      const presenter = view.presenter;
      if (!presenter) return;
      const peer = peers.peers().get(presenter.connection);
      if (peer) declined.delete(keyOf(peer));
      peers.follow(presenter.connection);
    },
    dispose() {
      offMotion();
      offFollow();
      offLocal();
      listeners.clear();
    },
  };
}
export type Spotlight = ReturnType<typeof createSpotlight>;
