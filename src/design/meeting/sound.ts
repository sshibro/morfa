import type {MeetingTrack} from '../../../shared/design/meeting';

// The timer's sounds in this browser (docs/board-meeting.md "Timer"): a bell when time is up and, while it runs, the music the
// host chose. Each person sets their own volume or mutes it; that stays in this browser only. Everything is synthesised with
// Web Audio here: no recording is shipped or fetched (the music's generator loads with the first track, music.ts).
// Sound only after a gesture: no audio context exists until the person has pressed a key or the pointer in this page (the browser's
// user activation, or a press seen here). A timer that runs with music when the file opens stays silent until then and starts its
// music on that press; a bell that rang before it is skipped.

const VOLUME_KEY = 'morfa:meeting:volume';
const MUTED_KEY = 'morfa:meeting:muted';
/** Module-level, as every lazy import of the design tool (tests/design-lazy-imports.test.ts): the bundler's preload keeps
 *  the function that first asked for a chunk, with what it closes over. */
const loadMusic = () => import('./music');

export type MeetingSound = {
  volume(): number;
  muted(): boolean;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  subscribe(listener: () => void): () => void;
  /** The bell at the end of the timer. */
  chime(): void;
  /** Plays `track` (the same one keeps playing), or fades the music out (null). Muted, nothing plays until unmuted. */
  music(track: MeetingTrack | null): void;
  dispose(): void;
};

type Player = {stop(fadeMs: number): void};

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A private window: the choice lasts until the tab closes.
  }
}

/** What the sounds need from the browser (a test passes its own). */
export type SoundEnvironment = {
  AudioContext?: new () => AudioContext;
  /** The page has had a user gesture (navigator.userActivation). */
  activated(): boolean;
  /** Press listeners (pointer and keys) on the window, capture phase. */
  onGesture(listener: () => void): () => void;
  load(key: string): string | null;
  save(key: string, value: string): void;
};

function browserEnvironment(): SoundEnvironment {
  return {
    AudioContext: typeof window === 'undefined' ? undefined : window.AudioContext,
    activated: () => (typeof navigator !== 'undefined' && (navigator as Navigator & {userActivation?: {hasBeenActive: boolean}}).userActivation?.hasBeenActive) === true,
    onGesture(listener) {
      if (typeof window === 'undefined') return () => undefined;
      window.addEventListener('pointerdown', listener, true);
      window.addEventListener('keydown', listener, true);
      return () => {
        window.removeEventListener('pointerdown', listener, true);
        window.removeEventListener('keydown', listener, true);
      };
    },
    load: stored,
    save: store,
  };
}

export function createMeetingSound(environment: SoundEnvironment = browserEnvironment()): MeetingSound {
  const listeners = new Set<() => void>();
  const read = Number(environment.load(VOLUME_KEY));
  let volume = environment.load(VOLUME_KEY) !== null && Number.isFinite(read) ? Math.min(1, Math.max(0, read)) : 0.6;
  let muted = environment.load(MUTED_KEY) === '1';
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let playing: {track: MeetingTrack; player: Player | null} | null = null;
  /** What should play now: kept while the page waits for a gesture. */
  let wanted: MeetingTrack | null = null;
  let touched = false;
  let disposed = false;

  const level = () => (muted ? 0 : volume * volume);
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const allowed = () => touched || environment.activated();
  const offGesture = environment.onGesture(() => {
    touched = true;
    if (context?.state === 'suspended') void context.resume().catch(() => undefined);
    if (!playing) sync();
  });

  function audio(): {context: AudioContext; master: GainNode} | null {
    if (disposed || !allowed()) return null;
    if (!context) {
      const Context = environment.AudioContext;
      if (!Context) return null;
      try {
        context = new Context();
      } catch {
        return null;
      }
      master = context.createGain();
      master.gain.value = level();
      master.connect(context.destination);
    }
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    return {context, master: master!};
  }
  function applyLevel() {
    if (!context || !master) return;
    master.gain.setTargetAtTime(level(), context.currentTime, 0.05);
  }
  /** Plays what is wanted unless muted (the generator does not run silent), fading out what played before. */
  function sync(fadeMs = 400) {
    const next = muted || volume === 0 ? null : wanted;
    if (playing?.track === next) return;
    playing?.player?.stop(next ? fadeMs : 1200);
    playing = null;
    if (next) start(next);
  }
  function start(track: MeetingTrack) {
    const sound = audio();
    if (!sound) return;
    const entry: {track: MeetingTrack; player: Player | null} = {track, player: null};
    playing = entry;
    void loadMusic().then(
      module => {
        if (playing !== entry || disposed) return;
        entry.player = module.playTrack(sound.context, sound.master, track);
      },
      () => undefined,
    );
  }

  return {
    volume: () => volume,
    muted: () => muted,
    setVolume(next) {
      volume = Math.min(1, Math.max(0, next));
      if (volume > 0 && muted) muted = false;
      environment.save(VOLUME_KEY, String(Math.round(volume * 100) / 100));
      environment.save(MUTED_KEY, muted ? '1' : '0');
      applyLevel();
      sync();
      notify();
    },
    setMuted(next) {
      muted = next;
      environment.save(MUTED_KEY, muted ? '1' : '0');
      applyLevel();
      sync();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    chime() {
      if (muted || volume === 0) return;
      const sound = audio();
      if (!sound) return;
      bell(sound.context, sound.master);
    },
    music(track) {
      wanted = track;
      sync();
    },
    dispose() {
      disposed = true;
      wanted = null;
      offGesture();
      playing?.player?.stop(200);
      playing = null;
      const closing = context;
      context = null;
      if (closing) setTimeout(() => void closing.close().catch(() => undefined), 300);
      listeners.clear();
    },
  };
}

/** Three soft bell notes going up (E5, G♯5, B5), a sine with two quiet partials each, ringing out over about two seconds. */
function bell(context: AudioContext, destination: AudioNode) {
  const start = context.currentTime + 0.02;
  const out = context.createGain();
  out.gain.value = 0.32;
  out.connect(destination);
  [659.25, 830.61, 987.77].forEach((frequency, index) => {
    const at = start + index * 0.16;
    for (const [ratio, gain] of [[1, 1], [2.76, 0.22], [5.4, 0.06]] as const) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency * ratio;
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(gain, at + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, at + (ratio === 1 ? 2.2 : 0.9));
      osc.connect(env).connect(out);
      osc.start(at);
      osc.stop(at + 2.3);
    }
  });
  setTimeout(() => out.disconnect(), 3200);
}
