import {
  cleanChat,
  emoteEmoji,
  HIGH_FIVE_EMOJI,
  WAVE_EMOJI,
  MEETING_LIMITS,
  timerPhase,
  timerRemaining,
  votesLeft,
  voteEnded,
  type DesignMeetingSignal,
  type DesignMeetingState,
  type MeetingEmote,
  type TimerPhase,
} from '../../../shared/design/meeting';
import type {DesignLiveHello} from '../../../shared/design/live';
import type {NodeId, Vec} from '../../../shared/design/types';
import {currentViewport, type DesignStore} from '../engine/store';
import {registerCommand} from '../engine/commands/registry';
import type {CanvasController} from '../editor/CanvasView';
import type {LiveSession} from '../realtime/live-session';
import {createLocalMeeting, createSpotlight, watchPeers, type LocalMeeting, type Spotlight} from './ephemeral';
import {colorOf, MeetingOverlay, type Badge} from './overlay';
import {createMeetingSession, type MeetingSession, type MeetingTransport} from './session';
import {createMeetingSound, type MeetingSound} from './sound';
import {designSurface, type MeetingMode, type SurfaceFactory} from './surface';
import {DESIGN_TARGETS, type MeetingTargets} from './targets';
import {emoteCursor} from './tools';

// One open file's "Meeting" (docs/board-meeting.md): the durable session (timer, vote), the ephemeral presence (chat, emotes, waves,
// spotlight), the sounds, and what ties them to this editor — its surface (a design file's canvas tools or a board's clicks and badges,
// surface.ts), the overlay, the commands, a one-second tick for the timer while it runs. React components read it through the small
// stores below; nothing here renders.

export type MeetingIdentity = {connection: string; user: string; name: string; color: number; canEdit: boolean};
export type ChatState = {open: boolean; text: string; sent: boolean};
export type EmoteChoice = MeetingEmote | 'wave';
export type PointerState = {screen: Vec; page: Vec; inside: boolean};

type Store<T> = {get(): T; subscribe(listener: () => void): () => void};
function valueStore<T>(initial: T): Store<T> & {set(next: T): void} {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The chat bubble stays this long after Enter, and closes by itself after this long without typing. */
const SENT_MS = 4_000;
const IDLE_MS = 15_000;
/** A wave lasts this long after the press ends, so the other person can wave back. */
const WAVE_GRACE_MS = 1_500;
/** Emote bursts while the press is held. */
const REPEAT_MS = 160;

export type MeetingController = ReturnType<typeof createMeetingController>;

export function createMeetingController(options: {
  fileId: string;
  live: LiveSession;
  store: DesignStore;
  host: () => HTMLElement | null;
  canvas: () => CanvasController | null;
  toast: (message: string, kind?: 'error') => void;
  reveal?: (ids: NodeId[]) => void;
  targets?: MeetingTargets;
  /** Where the voting and reactions modes live: a design file's canvas tools when absent (a board passes its own). */
  surface?: SurfaceFactory;
  /** How the timer and votes reach the server (tests pass their own). */
  transport?: MeetingTransport;
}) {
  const {live, store} = options;
  const targets = options.targets ?? DESIGN_TARGETS;
  const offs: (() => void)[] = [];
  const identity = valueStore<MeetingIdentity | null>(null);
  const readHello = (hello: DesignLiveHello | null) => {
    if (hello) identity.set({connection: hello.connection, user: hello.user, name: hello.name, color: hello.color, canEdit: hello.canEdit});
  };
  readHello(live.hello());

  const session: MeetingSession = createMeetingSession({
    fileId: options.fileId,
    client: () => live.connection(),
    user: () => identity.get()?.user ?? null,
    onError: message => options.toast(message, 'error'),
    transport: options.transport,
  });
  const sound: MeetingSound = createMeetingSound();
  const local: LocalMeeting = createLocalMeeting(live.presence);
  const spotlight: Spotlight = createSpotlight({
    peers: live.peers,
    local,
    self: () => live.connection(),
    onYield: name => options.toast(`${name} now has everyone's attention.`),
  });

  offs.push(
    live.listen((name, data) => {
      if (name === 'meeting') session.signal(data as DesignMeetingSignal);
      else if (name === 'hello') {
        readHello(data as DesignLiveHello);
        session.refresh();
      } else if (name === 'access') {
        const current = identity.get();
        if (current) identity.set({...current, canEdit: (data as {canEdit: boolean}).canEdit});
      }
    }),
  );
  session.refresh();
  // Without the stream (switched off, or reconnecting), the meeting is read now and then instead.
  const poll = setInterval(() => {
    if (live.status() !== 'live' && document.visibilityState === 'visible') session.refresh();
  }, 15_000);
  offs.push(() => clearInterval(poll));

  // ── The pointer over the canvas (cursor chat stands at it; a wave meets others there) ──
  const pointer = valueStore<PointerState | null>(null);
  let element: HTMLElement | null = null;
  const move = (event: PointerEvent) => {
    const view = options.canvas()?.view;
    if (!view || !element) return;
    const rect = element.getBoundingClientRect();
    const screen = {x: event.clientX - rect.left, y: event.clientY - rect.top};
    const page = view.screenToPage(screen);
    pointer.set({screen, page, inside: true});
    // A held emote follows the pointer (a board's surface has no tool to say so).
    if (held) held = page;
  };
  const leave = () => {
    const last = pointer.get();
    if (last) pointer.set({...last, inside: false});
  };
  const attach = () => {
    const next = options.host();
    if (next === element) return;
    element?.removeEventListener('pointermove', move);
    element?.removeEventListener('pointerleave', leave);
    element = next;
    element?.addEventListener('pointermove', move, {passive: true});
    element?.addEventListener('pointerleave', leave, {passive: true});
  };
  attach();
  const retry = setInterval(() => {
    attach();
    if (element) clearInterval(retry);
  }, 250);
  offs.push(() => {
    clearInterval(retry);
    element?.removeEventListener('pointermove', move);
    element?.removeEventListener('pointerleave', leave);
  });
  /** Where a bubble or a burst of this editor goes: the pointer, or the middle of the view when it is elsewhere. */
  function anchor(): {screen: Vec; page: Vec} {
    const at = pointer.get();
    if (at?.inside) return at;
    const view = options.canvas()?.view;
    const size = view?.size() ?? {width: 800, height: 600};
    const screen = {x: size.width / 2, y: size.height / 2};
    return {screen, page: view ? view.screenToPage(screen) : {x: 0, y: 0}};
  }

  // ── Overlay ──
  let overlay: MeetingOverlay | null = null;
  const watcher = watchPeers(
    live.peers,
    {
      burst(peer, id) {
        if (peer.cursor && peer.page) overlay?.burst(peer.cursor, peer.page, emoteEmoji(id));
      },
      chat: (peer, text) => overlay?.chat(peer.connection, peer.name, text),
      wave: (peer, waving) => overlay?.wave(peer.connection, peer.name, waving),
      highFive: (_a, _b, at, page) => overlay?.burst(at, page, HIGH_FIVE_EMOJI, 'high-five'),
      gone: connection => overlay?.gone(connection),
    },
    () => {
      const wave = local.current().wave;
      const at = pointer.get();
      const me = live.connection();
      if (wave === null || !at || !me) return null;
      return {connection: me, wave, page: store.getState().pageId, cursor: at.page, zoom: currentViewport(store.getState()).zoom};
    },
  );
  offs.push(() => watcher.dispose());
  offs.push(local.subscribe(() => watcher.check()));
  offs.push(live.peers.subscribeMotion(() => overlay?.retry()));

  function badges(): Badge[] {
    const state = session.state(),
      vote = state?.vote;
    const doc = store.getState().doc;
    if (!vote) return [];
    if (vote.results) {
      const top = vote.results[0]?.count ?? 0;
      return vote.results.map(tally => ({nodeId: tally.nodeId, kind: 'result' as const, count: tally.count, top: tally.count === top, label: targets.label(doc, tally.nodeId)}));
    }
    const color = colorOf(identity.get()?.color ?? 0);
    return vote.mine.map(tally => ({nodeId: tally.nodeId, kind: 'mine' as const, count: tally.count, color, label: targets.label(doc, tally.nodeId)}));
  }
  const showResults = valueStore(true);
  function syncBadges() {
    const list = session.state()?.vote?.results && !showResults.get() ? [] : badges();
    if (surface.badges) surface.badges(list);
    else overlay?.setBadges(list);
  }

  // ── Votes ──
  let seenVote: {id: string; ended: boolean} | null = null;
  function onState() {
    const state = session.state();
    const vote = state?.vote ?? null;
    const now = session.clock.now();
    const ended = vote ? vote.results !== null || voteEnded(vote, now) : false;
    if (vote && seenVote?.id !== vote.id && !ended && seenVote !== null) {
      // A vote started while this editor was open: into voting mode, unless busy with another tool.
      if (surface.idle()) surface.setMode('vote');
      const by = vote.by?.id === identity.get()?.user ? null : vote.by?.name;
      if (by) options.toast(`${by} started a vote: you have ${vote.perPerson} ${vote.perPerson === 1 ? 'vote' : 'votes'}.`);
    }
    if (vote && ended && seenVote?.id === vote.id && !seenVote.ended) {
      if (surface.mode() === 'vote') surface.setMode(null);
      showResults.set(true);
    }
    if (!vote && surface.mode() === 'vote') surface.setMode(null);
    if (vote?.results && seenVote?.id !== vote.id) showResults.set(true);
    seenVote = vote ? {id: vote.id, ended} : state ? {id: '', ended: true} : null;
    // The others' cursors stay out of sight while a vote that hides them runs (help.figma.com "Run voting sessions in FigJam":
    // "multiplayer cursors in the file are hidden so votes aren't revealed"): a mark on the editor's root, live.css's cursors
    // hidden under it (meeting.css). Nothing changes in the co-editing layer.
    const root = options.host()?.closest<HTMLElement>('.dz');
    if (root) {
      const hide = !!vote?.hideCursors && !ended;
      if (hide !== (root.dataset.meetHideCursors === 'true')) {
        if (hide) root.dataset.meetHideCursors = 'true';
        else delete root.dataset.meetHideCursors;
      }
    }
    syncBadges();
    scheduleTick();
  }
  offs.push(session.subscribe(onState));
  offs.push(() => {
    const root = options.host()?.closest<HTMLElement>('.dz');
    if (root) delete root.dataset.meetHideCursors;
  });
  offs.push(showResults.subscribe(syncBadges));
  offs.push(store.subscribe(() => syncBadges(), {slice: 'doc'}));

  // ── The second's tick: the pill's digits, the bell, the music ──
  const tick = valueStore(0);
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPhase: TimerPhase = 'idle';
  let lastEndsAt: number | null = null;
  function scheduleTick() {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;
    const state = session.state();
    const now = session.clock.now();
    const timer = state?.timer ?? null;
    const phase = timerPhase(timer, now);
    // Time is up while this editor watched it run (not a timer that ended before it opened the file).
    if (phase === 'done' && lastPhase === 'running' && timer?.endsAt === lastEndsAt) sound.chime();
    lastPhase = phase;
    lastEndsAt = timer?.endsAt ?? null;
    sound.music(phase === 'running' && timer?.music ? timer.music : null);
    tick.set(now);
    const vote = state?.vote;
    let next: number | null = null;
    if (phase === 'running') next = (timerRemaining(timer, now) % 1000) + 5;
    else if (phase === 'done') next = Math.max(50, (timer!.endsAt ?? now) + MEETING_LIMITS.doneShownMs - now);
    if (vote && vote.endsAt !== null && vote.endedAt === null && vote.results === null) next = Math.min(next ?? 1000, 1000);
    if (next !== null) tickTimer = setTimeout(scheduleTick, Math.max(16, next));
  }
  offs.push(() => tickTimer && clearTimeout(tickTimer));

  // ── Cursor chat ──
  const chat = valueStore<ChatState>({open: false, text: '', sent: false});
  let chatTimer: ReturnType<typeof setTimeout> | null = null;
  const clearChatTimer = () => {
    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = null;
  };
  const closeChat = () => {
    clearChatTimer();
    chat.set({open: false, text: '', sent: false});
    local.chat(null);
  };
  const chatApi = {
    state: chat.get,
    subscribe: chat.subscribe,
    open() {
      clearChatTimer();
      // Someone outside the canvas still shows the others where they speak: the middle of their view.
      const at = anchor();
      if (!pointer.get()?.inside) {
        pointer.set({screen: at.screen, page: at.page, inside: false});
        live.presence.set({cursor: {x: Math.round(at.page.x * 100) / 100, y: Math.round(at.page.y * 100) / 100}});
      }
      chat.set({open: true, text: '', sent: false});
      local.chat('');
      chatTimer = setTimeout(closeChat, IDLE_MS);
    },
    type(text: string) {
      const clean = cleanChat(text);
      clearChatTimer();
      chat.set({open: true, text: clean, sent: false});
      local.chat(clean);
      chatTimer = setTimeout(closeChat, IDLE_MS);
    },
    /** Enter: the words stay a moment for everyone, then fade. */
    send() {
      const text = chat.get().text.trim();
      if (!text) return closeChat();
      clearChatTimer();
      chat.set({open: false, text, sent: true});
      local.chat(text);
      chatTimer = setTimeout(closeChat, SENT_MS);
    },
    close: closeChat,
  };
  offs.push(clearChatTimer);

  // ── Emotes and waves ──
  const emote = valueStore<EmoteChoice>('heart');
  let repeat: ReturnType<typeof setInterval> | null = null;
  let held: Vec | null = null;
  let waveOff: ReturnType<typeof setTimeout> | null = null;
  const fire = (page: Vec) => {
    const choice = emote.get();
    if (choice === 'wave') return;
    local.emote(choice);
    overlay?.burst(page, store.getState().pageId, emoteEmoji(choice));
  };
  const releaseWave = () => {
    if (waveOff) clearTimeout(waveOff);
    waveOff = setTimeout(() => {
      waveOff = null;
      local.wave(false);
    }, WAVE_GRACE_MS);
  };
  offs.push(() => {
    if (repeat) clearInterval(repeat);
    if (waveOff) clearTimeout(waveOff);
  });

  // ── The surface: voting and reactions as canvas tools (a design file) or through the board's clicks and badges ──
  const surface = (options.surface ?? designSurface(store))({
    targetAt: page => {
      const state = store.getState();
      return targets.at(state.doc, state.pageId, page);
    },
    box: id => targets.box(store.getState().doc, id),
    vote(id) {
      const vote = session.state()?.vote;
      if (!vote || vote.results || voteEnded(vote, session.clock.now())) return;
      if (!votesLeft(vote)) {
        options.toast(`You are out of votes: ${surface.takeBack}.`);
        return;
      }
      void session.ballot(id, 1);
    },
    unvote(id) {
      const vote = session.state()?.vote;
      if (!vote || vote.results || voteEnded(vote, session.clock.now()) || !vote.mine.some(tally => tally.nodeId === id)) return;
      void session.ballot(id, -1);
    },
    cursor: () => emoteCursor(emote.get() === 'wave' ? WAVE_EMOJI : emoteEmoji(emote.get() as MeetingEmote)),
    accent: () => {
      const host = options.host();
      return (host && getComputedStyle(host).getPropertyValue('--dz-meet-accent').trim()) || '#0d99ff';
    },
    press(page) {
      held = page;
      if (emote.get() === 'wave') {
        if (waveOff) clearTimeout(waveOff);
        waveOff = null;
        local.wave(true);
        return;
      }
      fire(page);
      if (repeat) clearInterval(repeat);
      repeat = setInterval(() => held && fire(held), REPEAT_MS);
    },
    move(page) {
      if (held) held = page;
    },
    release() {
      held = null;
      if (repeat) clearInterval(repeat);
      repeat = null;
      if (emote.get() === 'wave') releaseWave();
    },
  });
  offs.push(() => surface.dispose());
  const emoteApi = {
    choice: emote.get,
    subscribe: emote.subscribe,
    /** Picks an emote and turns the mode on (the canvas cursor becomes it). */
    choose(choice: EmoteChoice) {
      emote.set(choice);
      surface.setMode('emote');
    },
    stop() {
      if (surface.mode() === 'emote') surface.setMode(null);
    },
    /** One burst of `choice` at a page point, sent to everyone here (a board's ⇧-click with the stamp tool). */
    burst(page: Vec, choice: MeetingEmote) {
      local.emote(choice);
      overlay?.burst(page, store.getState().pageId, emoteEmoji(choice));
    },
  };
  /** The meeting's mode in this editor, for the bars. */
  const mode = {get: (): MeetingMode | null => surface.mode(), subscribe: (listener: () => void) => surface.subscribe(listener)};

  // ── Commands (quick actions ⌘/, and "/" for cursor chat as in Figma and FigJam) ──
  offs.push(
    registerCommand({id: 'meeting.chat', label: 'Cursor chat', group: 'meeting', shortcut: {code: 'Slash'}, run: () => chatApi.open()}),
    registerCommand({id: 'meeting.react', label: 'Reactions', group: 'meeting', run: () => emoteApi.choose(emote.get())}),
    registerCommand({
      id: 'meeting.spotlight',
      label: 'Get attention',
      group: 'meeting',
      checked: () => spotlight.view().mine,
      run: () => (spotlight.view().mine ? spotlight.stop() : spotlight.start()),
    }),
  );

  return {
    fileId: options.fileId,
    store,
    live,
    targets,
    session,
    sound,
    local,
    spotlight,
    identity,
    pointer,
    tick,
    chat: chatApi,
    emote: emoteApi,
    showResults,
    mode,
    /** How this editor takes a vote back ("click your dot…"). */
    takeBack: surface.takeBack,
    /** Where votes go: a design file's frames or a board's objects (a board takes one back with ⌥-click, or "Remove vote" by touch). */
    surfaceKind: surface.kind,
    canControl: () => !!session.state()?.canControl,
    startVoting: () => surface.setMode('vote'),
    stopVoting: () => {
      if (surface.mode() === 'vote') surface.setMode(null);
    },
    removeVote: (id: NodeId) => void session.ballot(id, -1),
    reveal: (id: NodeId) => options.reveal?.([id]),
    toast: options.toast,
    /** The canvas layer mounts the overlay's root here (null when it unmounts). */
    attach(root: HTMLElement | null) {
      overlay?.dispose();
      overlay = root ? new MeetingOverlay(root, store, options.host, targets, id => void session.ballot(id, -1)) : null;
      if (overlay) {
        // What is already there: open chats and waves of people in the file, this person's votes or the results.
        for (const peer of live.peers.peers().values()) {
          if (peer.meeting?.chat != null) overlay.chat(peer.connection, peer.name, peer.meeting.chat);
          if (peer.meeting?.wave != null) overlay.wave(peer.connection, peer.name, true);
        }
        syncBadges();
      }
    },
    dispose() {
      // Out of the meeting's mode while the surface still answers, then everything it connected.
      if (surface.mode()) surface.setMode(null);
      for (const off of offs.splice(0)) off();
      overlay?.dispose();
      overlay = null;
      if (chat.get().open || chat.get().sent) local.chat(null);
      if (local.current().spotlight !== null) local.spotlight(false);
      if (local.current().wave !== null) local.wave(false);
      spotlight.dispose();
      session.dispose();
      sound.dispose();
    },
  };
}
