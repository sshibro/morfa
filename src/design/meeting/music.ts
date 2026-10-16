import type {MeetingTrack} from '../../../shared/design/meeting';

// Background music of the shared timer (docs/board-meeting.md "Timer"), composed for Morfa as code: Web Audio oscillators, filtered
// noise and envelopes, scheduled a fraction of a second ahead. No recording is shipped or fetched, so there is no licence to
// track and nothing to hotlink. Loaded with the first track a person hears (sound.ts imports it lazily).
//   "Lo-fi"  — a slow ii–V–I–vi in C on a warm electric-piano tone, upright bass, a dusty boom-bap kit with swung hats.
//   "Ambient" — long detuned pads drifting through four chords, with a few bell notes in a large room.
//   "Rain"   — rain on a window (filtered noise and drops) over a very quiet pad.

export type TrackPlayer = {stop(fadeMs: number): void};

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const LOOKAHEAD = 0.4;
const TICK_MS = 100;

function noiseBuffer(context: AudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** A room: decaying stereo noise as the impulse response. */
function room(context: AudioContext, seconds: number, decay: number): ConvolverNode {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
  }
  const convolver = context.createConvolver();
  convolver.buffer = buffer;
  return convolver;
}

type Kit = {context: AudioContext; out: AudioNode; wet: AudioNode; noise: AudioBuffer};

/** One note: oscillators summed, an attack and an exponential fall, optionally into the room. */
function tone(kit: Kit, at: number, midi: number, options: {length: number; gain: number; attack?: number; type?: OscillatorType; partial?: number; wet?: number; cutoff?: number}) {
  const {context} = kit;
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(options.gain, at + (options.attack ?? 0.01));
  env.gain.exponentialRampToValueAtTime(0.0001, at + options.length);
  let input: AudioNode = env;
  if (options.cutoff) {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = options.cutoff;
    filter.connect(env);
    input = filter;
  }
  const oscillators: OscillatorNode[] = [];
  const main = context.createOscillator();
  main.type = options.type ?? 'sine';
  main.frequency.value = hz(midi);
  main.connect(input);
  oscillators.push(main);
  if (options.partial) {
    const overtone = context.createOscillator();
    overtone.type = 'triangle';
    overtone.frequency.value = hz(midi + 12);
    const level = context.createGain();
    level.gain.value = options.partial;
    overtone.connect(level).connect(input);
    oscillators.push(overtone);
  }
  env.connect(kit.out);
  if (options.wet) {
    const send = context.createGain();
    send.gain.value = options.wet;
    env.connect(send).connect(kit.wet);
  }
  for (const osc of oscillators) {
    osc.start(at);
    osc.stop(at + options.length + 0.05);
  }
}

/** A noise hit through one filter (snare, hat, a raindrop, vinyl dust). */
function hit(kit: Kit, at: number, options: {type: BiquadFilterType; frequency: number; q?: number; gain: number; length: number; wet?: number}) {
  const {context} = kit;
  const source = context.createBufferSource();
  source.buffer = kit.noise;
  const filter = context.createBiquadFilter();
  filter.type = options.type;
  filter.frequency.value = options.frequency;
  filter.Q.value = options.q ?? 0.7;
  const env = context.createGain();
  env.gain.setValueAtTime(options.gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + options.length);
  source.connect(filter).connect(env).connect(kit.out);
  if (options.wet) {
    const send = context.createGain();
    send.gain.value = options.wet;
    env.connect(send).connect(kit.wet);
  }
  source.start(at, Math.random() * 1.5);
  source.stop(at + options.length + 0.02);
}

function kick(kit: Kit, at: number) {
  const {context} = kit;
  const osc = context.createOscillator();
  osc.frequency.setValueAtTime(115, at);
  osc.frequency.exponentialRampToValueAtTime(42, at + 0.11);
  const env = context.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(0.75, at + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
  osc.connect(env).connect(kit.out);
  osc.start(at);
  osc.stop(at + 0.34);
}

// ── "Lo-fi" ────────────────────────────────────────────────────────────────────────────────────

const LOFI_BPM = 72;
const LOFI_CHORDS: {bass: number; notes: number[]}[] = [
  {bass: 38, notes: [53, 57, 60, 64]}, // Dm9
  {bass: 43, notes: [53, 59, 64, 69]}, // G13
  {bass: 48, notes: [52, 55, 59, 62]}, // Cmaj9
  {bass: 45, notes: [55, 59, 60, 64]}, // Am9
];

function lofi(kit: Kit): (from: number, to: number) => void {
  const beat = 60 / LOFI_BPM;
  const start = kit.context.currentTime + 0.1;
  let step = 0; // eighth notes since the start
  return (_from, to) => {
    for (;;) {
      const eighth = step % 8,
        bar = Math.floor(step / 8);
      // Swung eighths: the off-beat comes late, a third of the way into the next half.
      const at = start + Math.floor(step / 2) * beat + (step % 2 ? beat * 0.62 : 0);
      if (at > to) return;
      const chord = LOFI_CHORDS[bar % LOFI_CHORDS.length];
      if (eighth === 0 || eighth === 3)
        chord.notes.forEach((note, i) =>
          tone(kit, at + i * 0.012, note, {length: eighth === 0 ? beat * 2.6 : beat * 1.4, gain: eighth === 0 ? 0.075 : 0.05, partial: 0.18, cutoff: 1900, wet: 0.25}),
        );
      if (eighth === 6 && bar % 2 === 1) tone(kit, at, chord.notes[3] + 12, {length: beat * 1.2, gain: 0.035, partial: 0.1, cutoff: 2400, wet: 0.4});
      if (eighth === 0) tone(kit, at, chord.bass, {length: beat * 1.8, gain: 0.32, cutoff: 320});
      if (eighth === 4) tone(kit, at, chord.bass + 7, {length: beat * 1.1, gain: 0.24, cutoff: 320});
      if (eighth === 0 || eighth === 5) kick(kit, at);
      if (eighth === 2 || eighth === 6) {
        hit(kit, at, {type: 'bandpass', frequency: 1700, q: 0.9, gain: 0.22, length: 0.2, wet: 0.2});
        tone(kit, at, 54, {length: 0.12, gain: 0.08});
      }
      hit(kit, at, {type: 'highpass', frequency: 7500, gain: step % 2 ? 0.045 : 0.07, length: 0.045});
      // Dust on the record.
      if (Math.random() < 0.35) hit(kit, at + Math.random() * beat * 0.5, {type: 'bandpass', frequency: 2500 + Math.random() * 3000, q: 3, gain: 0.02 + Math.random() * 0.03, length: 0.012});
      step++;
    }
  };
}

// ── "Ambient" ────────────────────────────────────────────────────────────────────────────────────

const AMBIENT_CHORDS = [
  [48, 55, 59, 64], // Cmaj7
  [45, 52, 55, 59, 62], // Am9
  [41, 53, 57, 60, 64], // Fmaj7
  [43, 50, 57, 59, 64], // G6/9
];
const PENTATONIC = [72, 74, 76, 79, 81, 84, 86, 88];

function pad(kit: Kit, at: number, midi: number, length: number, gain: number) {
  const {context} = kit;
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 650;
  filter.Q.value = 0.4;
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + 2.6);
  env.gain.setValueAtTime(gain, at + length - 2.8);
  env.gain.linearRampToValueAtTime(0, at + length);
  filter.connect(env).connect(kit.out);
  const send = context.createGain();
  send.gain.value = 0.6;
  env.connect(send).connect(kit.wet);
  for (const cents of [-7, 7]) {
    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = hz(midi);
    osc.detune.value = cents;
    osc.connect(filter);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }
}

function ambient(kit: Kit): (from: number, to: number) => void {
  const chordLength = 7;
  const start = kit.context.currentTime + 0.1;
  let chord = 0,
    nextBell = start + 1.5;
  return (_from, to) => {
    for (;;) {
      const at = start + chord * chordLength;
      if (at > to) break;
      for (const note of AMBIENT_CHORDS[chord % AMBIENT_CHORDS.length]) pad(kit, at, note, chordLength + 2.4, 0.045);
      chord++;
    }
    while (nextBell <= to) {
      tone(kit, nextBell, PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)], {length: 3.5, gain: 0.05, attack: 0.004, partial: 0.05, wet: 0.9});
      nextBell += 1.8 + Math.random() * 3.2;
    }
  };
}

// ── "Rain" ──────────────────────────────────────────────────────────────────────────────────────

function rain(kit: Kit): {schedule: (from: number, to: number) => void; stop: () => void} {
  const {context} = kit;
  const source = context.createBufferSource();
  source.buffer = kit.noise;
  source.loop = true;
  const high = context.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 380;
  const low = context.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 2400;
  const level = context.createGain();
  level.gain.value = 0.2;
  // The shower thickens and thins slowly.
  const lfo = context.createOscillator();
  lfo.frequency.value = 0.07;
  const depth = context.createGain();
  depth.gain.value = 600;
  lfo.connect(depth).connect(low.frequency);
  source.connect(high).connect(low).connect(level).connect(kit.out);
  source.start();
  lfo.start();
  const start = context.currentTime + 0.1;
  let nextDrop = start,
    chord = 0;
  const chords = [[53, 57, 60, 64], [52, 55, 59, 62]];
  return {
    schedule(_from, to) {
      while (nextDrop <= to) {
        hit(kit, nextDrop, {type: 'bandpass', frequency: 1800 + Math.random() * 4200, q: 5, gain: 0.03 + Math.random() * 0.07, length: 0.02 + Math.random() * 0.03, wet: 0.3});
        nextDrop += 0.03 + Math.random() * 0.14;
      }
      for (;;) {
        const at = start + chord * 10;
        if (at > to) break;
        for (const note of chords[chord % chords.length]) pad(kit, at, note, 12, 0.018);
        chord++;
      }
    },
    stop() {
      source.stop();
      lfo.stop();
    },
  };
}

// ── Playing ──────────────────────────────────────────────────────────────────────────────────────

const LEVEL: Record<MeetingTrack, number> = {lofi: 0.55, ambient: 0.5, rain: 0.7};

export function playTrack(context: AudioContext, destination: AudioNode, track: MeetingTrack): TrackPlayer {
  const out = context.createGain();
  out.gain.setValueAtTime(0, context.currentTime);
  out.gain.linearRampToValueAtTime(LEVEL[track], context.currentTime + 1.5);
  // A gentle top cut keeps it behind the conversation.
  const tone = context.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = track === 'lofi' ? 4200 : 6000;
  tone.connect(out).connect(destination);
  const reverb = room(context, track === 'ambient' ? 4 : 2.4, track === 'ambient' ? 2.2 : 3);
  const wetLevel = context.createGain();
  wetLevel.gain.value = track === 'ambient' ? 0.5 : 0.3;
  reverb.connect(wetLevel).connect(tone);
  const kit: Kit = {context, out: tone, wet: reverb, noise: noiseBuffer(context, 2)};
  let schedule: (from: number, to: number) => void;
  let stopSources = () => {};
  if (track === 'rain') {
    const shower = rain(kit);
    schedule = shower.schedule;
    stopSources = shower.stop;
  } else schedule = track === 'lofi' ? lofi(kit) : ambient(kit);
  let until = context.currentTime;
  const tick = () => {
    const to = context.currentTime + LOOKAHEAD;
    if (to <= until) return;
    schedule(until, to);
    until = to;
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  let stopped = false;
  return {
    stop(fadeMs) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const now = context.currentTime;
      out.gain.cancelScheduledValues(now);
      out.gain.setValueAtTime(out.gain.value, now);
      out.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
      setTimeout(() => {
        try {
          stopSources();
        } catch {
          // Already stopped.
        }
        out.disconnect();
      }, fadeMs + 100);
    },
  };
}
