import {memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties} from 'react';
import {
  durationWords,
  formatTimer,
  MEETING_EMOTES,
  MEETING_LIMITS,
  MEETING_TIMER_PRESETS_MIN,
  MEETING_TRACKS,
  timerPhase,
  timerRemaining,
  voteEnded,
  votesLeft,
  type DesignMeetingVoteRecord,
  type MeetingTrack,
} from '../../../../shared/design/meeting';
import {Button, IconButton} from '../../ui/Button';
import {TextInput} from '../../ui/TextInput';
import {deletePastVote, pastVotes} from '../history';
import {Popover} from '../../ui/Popover';
import {Select} from '../../ui/Select';
import {Slider} from '../../ui/Slider';
import {Checkbox} from '../../ui/Toggle';
import {useTooltip} from '../../ui/Tooltip';
import type {MeetingController} from '../controller';
import {IconChat, IconMinus, IconMusic, IconPause, IconPlus, IconResume, IconSmile, IconSpotlight, IconStop, IconTimer, IconVolume, IconVolumeOff, IconVote} from '../icons';

// The header cluster of "Meeting" (docs/board-meeting.md): the shared timer (an icon at rest, the "03:00" pill while it runs, FigJam's
// way) and "Reactions and meeting" (emotes, a high five, cursor chat, a vote, "Get attention"). The design editor puts it in the right
// panel's header beside the avatars; a board puts it in its top-right pill. Re-renders once a second only while the timer runs.

const useSession = (controller: MeetingController) => useSyncExternalStore(controller.session.subscribe, controller.session.state);
const useTick = (controller: MeetingController) => useSyncExternalStore(controller.tick.subscribe, controller.tick.get);

const MUSIC_OPTIONS = [{value: 'none' as const, label: 'No music'}, ...MEETING_TRACKS.map(track => ({value: track.id, label: track.label}))];
type MusicValue = MeetingTrack | 'none';

/**
 * `timer`: 'active' (the design editor, whose header is narrow) shows the timer's pill only while a timer runs, is paused or just
 * ended, and starts one from "Reactions and meeting"; 'always' (a board's top-right pill, FigJam's way) keeps the timer button there.
 */
export const MeetingHeader = memo(function MeetingHeader({controller, timer = 'active'}: {controller: MeetingController; timer?: 'always' | 'active'}) {
  return (
    <div className="dz-meet-header" role="group" aria-label="Meeting">
      <TimerButton controller={controller} always={timer === 'always'} />
      <MeetingButton controller={controller} />
    </div>
  );
});

// ── Timer ────────────────────────────────────────────────────────────────────────────────────────

function TimerButton({controller, always}: {controller: MeetingController; always: boolean}) {
  const state = useSession(controller);
  useTick(controller);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const now = controller.session.clock.now();
  const timer = state?.timer ?? null;
  const phase = timerPhase(timer, now);
  const label = phase === 'idle' ? 'Timer' : phase === 'done' ? 'Timer: time is up' : `Timer: ${formatTimer(timerRemaining(timer, now))}${phase === 'paused' ? ', paused' : ''}`;
  const tip = useTooltip(phase === 'idle' ? {label: 'Timer', placement: 'bottom'} : null);
  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => setAnchor(anchor ? null : event.currentTarget);
  if (phase === 'idle' && !always && !anchor) return null;
  return (
    <>
      {phase === 'idle' ? (
        <button type="button" className="dz-icon-btn is-24 is-panel dz-meet-timer-idle" aria-label={label} aria-haspopup="dialog" aria-expanded={!!anchor} onClick={toggle} {...tip}>
          <IconTimer />
        </button>
      ) : (
        <button type="button" className={`dz-meet-timer is-${phase}`} aria-label={label} aria-haspopup="dialog" aria-expanded={!!anchor} onClick={toggle}>
          {timer?.music ? <IconMusic size={12} /> : phase === 'paused' ? <IconPause size={12} /> : <IconTimer size={12} />}
          <span className="dz-meet-timer-digits" aria-hidden="true">{phase === 'done' ? '00:00' : formatTimer(timerRemaining(timer, now))}</span>
        </button>
      )}
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-end" aria-label="Timer" className="dz-meet-popover">
          <Accented anchor={anchor}>
            <TimerPanel controller={controller} />
          </Accented>
        </Popover>
      )}
    </>
  );
}

function TimerPanel({controller}: {controller: MeetingController}) {
  const state = useSession(controller);
  useTick(controller);
  // The time to start, in seconds: "03:00" by default, typed as minutes and seconds up to "99:59" (FigJam's).
  const [seconds, setSeconds] = useState(180);
  const minutes = Math.floor(seconds / 60);
  const now = controller.session.clock.now();
  const timer = state?.timer ?? null;
  const phase = timerPhase(timer, now);
  const canControl = !!state?.canControl;
  const [music, setMusic] = useState<MusicValue>(timer?.music ?? 'none');
  const shownMusic: MusicValue = phase === 'idle' ? music : timer?.music ?? 'none';
  const run = controller.session.timer;
  const durationMs = seconds * 1000;
  const clampSeconds = (value: number) => Math.min(TIMER_MAX_S, Math.max(TIMER_MIN_S, value));
  const step = (delta: number) => setSeconds(value => clampSeconds(value + delta * 60));
  const start = () => void run({action: 'start', durationMs, music: music === 'none' ? null : music});
  // Return in a field starts once the typed value has landed (the next render), not with the value before it.
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!starting) return;
    setStarting(false);
    start();
  });
  const startSoon = () => setStarting(true);
  return (
    <div className="dz-meet-panel">
      <div className="dz-meet-panel-title">Timer</div>
      <div className={`dz-meet-clock is-${phase}`} role="timer" aria-live="off">
        {phase === 'idle' && canControl && (
          <button type="button" className="dz-meet-step" aria-label="Minus one minute" disabled={seconds <= 60} onClick={() => step(-1)}><IconMinus /></button>
        )}
        {phase === 'idle' && canControl ? (
          <span className="dz-meet-clock-digits is-input">
            <TimeField label="Minutes" value={minutes} max={99} onChange={value => setSeconds(clampSeconds(value * 60 + (seconds % 60)))} onStep={delta => setSeconds(value => clampSeconds(value + delta * 60))} onEnter={startSoon} />
            <span aria-hidden="true">:</span>
            <TimeField label="Seconds" value={seconds % 60} max={59} onChange={value => setSeconds(clampSeconds(minutes * 60 + value))} onStep={delta => setSeconds(value => clampSeconds(value + delta))} onEnter={startSoon} />
          </span>
        ) : (
          <span className="dz-meet-clock-digits">{phase === 'idle' ? formatTimer(durationMs) : phase === 'done' ? '00:00' : formatTimer(timerRemaining(timer, now))}</span>
        )}
        {phase === 'idle' && canControl && (
          <button type="button" className="dz-meet-step" aria-label="Plus one minute" disabled={seconds >= TIMER_MAX_S} onClick={() => step(1)}><IconPlus /></button>
        )}
      </div>
      {phase === 'done' && <div className="dz-meet-note is-center" role="status">Time is up</div>}
      {phase === 'idle' && canControl && (
        <div className="dz-meet-presets" role="group" aria-label="How many minutes">
          {MEETING_TIMER_PRESETS_MIN.map(value => (
            <button key={value} type="button" className="dz-meet-chip" aria-pressed={seconds === value * 60} onClick={() => setSeconds(value * 60)}>
              {value} min
            </button>
          ))}
        </div>
      )}
      {canControl && (
        <div className="dz-meet-row">
          <span className="dz-meet-row-label">Music</span>
          <Select<MusicValue> aria-label="Music" value={shownMusic} options={MUSIC_OPTIONS} icon={<IconMusic size={14} />}
            onChange={value => (phase === 'idle' ? setMusic(value) : void run({action: 'music', music: value === 'none' ? null : value}))} />
        </div>
      )}
      {canControl ? (
        <div className="dz-meet-actions">
          {phase === 'idle' && (
            <Button variant="primary" icon={<IconResume size={12} />} className="dz-meet-grow" onClick={start}>
              Start
            </Button>
          )}
          {phase === 'running' && <Button icon={<IconPause size={12} />} className="dz-meet-grow" onClick={() => void run({action: 'pause'})}>Pause</Button>}
          {phase === 'paused' && <Button variant="primary" icon={<IconResume size={12} />} className="dz-meet-grow" onClick={() => void run({action: 'resume'})}>Resume</Button>}
          {phase !== 'idle' && <Button onClick={() => void run({action: 'add'})}>+1 min</Button>}
          {phase !== 'idle' && (
            <IconButton label={phase === 'done' ? 'Remove timer' : 'Stop'} onClick={() => void run({action: 'stop'})}><IconStop size={14} /></IconButton>
          )}
        </div>
      ) : (
        <p className="dz-meet-note">The timer is controlled by the file’s editors.</p>
      )}
      {timer?.by && phase !== 'idle' && <p className="dz-meet-note">Started by: {timer.by.name}</p>}
      <VolumeRow controller={controller} />
    </div>
  );
}

const TIMER_MIN_S = MEETING_LIMITS.timerMinMs / 1000, TIMER_MAX_S = MEETING_LIMITS.timerMaxMs / 1000;

/** Two digits of the timer to type into: ↑ / ↓ a step, ⇧ five steps, Return starts (FigJam's timer keys). */
function TimeField({label, value, max, onChange, onStep, onEnter}: {label: string; value: number; max: number; onChange(value: number): void; onStep(delta: number): void; onEnter(): void}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value).padStart(2, '0');
  const commit = () => {
    if (draft !== null && draft !== '') onChange(Math.min(max, Number(draft)));
    setDraft(null);
  };
  return (
    <input className="dz-meet-time-field" aria-label={label} inputMode="numeric" maxLength={2} value={shown}
      onFocus={event => event.currentTarget.select()}
      onChange={event => setDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 2))}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          // What was typed lands first, then the step goes from it.
          commit();
          onStep((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 5 : 1));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          onEnter();
        }
      }} />
  );
}

function VolumeRow({controller}: {controller: MeetingController}) {
  const subscribe = controller.sound.subscribe;
  const volume = useSyncExternalStore(subscribe, controller.sound.volume);
  const muted = useSyncExternalStore(subscribe, controller.sound.muted);
  return (
    <div className="dz-meet-volume">
      <IconButton label={muted ? 'Unmute' : 'Mute'} pressed={muted} onClick={() => controller.sound.setMuted(!muted)}>
        {muted || volume === 0 ? <IconVolumeOff /> : <IconVolume />}
      </IconButton>
      <Slider aria-label="Volume (only for you)" value={muted ? 0 : Math.round(volume * 100)} valueText={`${muted ? 0 : Math.round(volume * 100)}%`}
        onChange={value => controller.sound.setVolume(value / 100)} min={0} max={100} />
      <span className="dz-meet-volume-note">only for you</span>
    </div>
  );
}

// ── Reactions, chat, vote, spotlight ─────────────────────────────────────────────────────────────

function MeetingButton({controller}: {controller: MeetingController}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<'main' | 'vote' | 'timer' | 'history'>('main');
  const state = useSession(controller);
  const spotlight = useSyncExternalStore(controller.spotlight.subscribe, controller.spotlight.view);
  const tip = useTooltip(anchor ? null : {label: 'Reactions and meeting', placement: 'bottom'});
  const close = useCallback(() => {
    setAnchor(null);
    setView('main');
  }, []);
  const vote = state?.vote ?? null;
  const running = !!vote && !vote.results && !voteEnded(vote, controller.session.clock.now());
  return (
    <>
      <button type="button" className="dz-icon-btn is-24 is-panel dz-meet-more" aria-label="Reactions and meeting" aria-haspopup="dialog" aria-expanded={!!anchor}
        aria-pressed={spotlight.mine || undefined} onClick={event => (anchor ? close() : setAnchor(event.currentTarget))} {...tip}>
        {spotlight.mine ? <IconSpotlight /> : <IconSmile />}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} placement="bottom-end" aria-label={view === 'vote' ? 'Voting' : view === 'timer' ? 'Timer' : view === 'history' ? 'Past votes' : 'Reactions and meeting'} className="dz-meet-popover" layoutKey={view}>
          <Accented anchor={anchor}>
          {view === 'vote' ? (
            <VoteSetup controller={controller} onDone={close} onBack={() => setView('main')} />
          ) : view === 'timer' ? (
            <TimerPanel controller={controller} />
          ) : view === 'history' ? (
            <VoteHistory controller={controller} onBack={() => setView('main')} />
          ) : (
            <div className="dz-meet-panel">
              <div className="dz-meet-panel-title">Reactions</div>
              <div className="dz-meet-emotes" role="group" aria-label="Reactions">
                {MEETING_EMOTES.map(emote => (
                  <button key={emote.id} type="button" className="dz-meet-emote" aria-label={emote.label} title={emote.label}
                    onClick={() => {
                      controller.emote.choose(emote.id);
                      close();
                    }}>
                    <span aria-hidden="true">{emote.emoji}</span>
                  </button>
                ))}
              </div>
              <p className="dz-meet-note">Pick a reaction, then press and hold on the canvas.</p>
              <button type="button" className="dz-meet-item" onClick={() => {
                controller.emote.choose('wave');
                close();
              }}>
                <span className="dz-meet-item-emoji" aria-hidden="true">✋</span>
                <span className="dz-meet-item-text"><span>High five</span><small>Wave next to someone else’s cursor</small></span>
              </button>
              <div className="dz-meet-separator" role="separator" />
              <button type="button" className="dz-meet-item" onClick={() => setView('timer')}>
                <IconTimer />
                <span className="dz-meet-item-text"><span>Timer</span><small>Shared by everyone, with music</small></span>
              </button>
              <button type="button" className="dz-meet-item" onClick={() => {
                close();
                // After the popover gives focus back to its trigger, so the field keeps it.
                requestAnimationFrame(() => controller.chat.open());
              }}>
                <IconChat />
                <span className="dz-meet-item-text"><span>Cursor chat</span></span>
                <kbd className="dz-meet-kbd">/</kbd>
              </button>
              {running ? (
                <button type="button" className="dz-meet-item" onClick={() => {
                  controller.startVoting();
                  close();
                }}>
                  <IconVote />
                  <span className="dz-meet-item-text"><span>Vote</span><small>Votes left: {votesLeft(vote!)} of {vote!.perPerson}</small></span>
                </button>
              ) : state?.canControl ? (
                <button type="button" className="dz-meet-item" onClick={() => setView('vote')}>
                  <IconVote />
                  <span className="dz-meet-item-text"><span>Voting…</span><small>Everyone places dots on {controller.targets.noun}</small></span>
                </button>
              ) : null}
              <button type="button" className="dz-meet-item" onClick={() => setView('history')}>
                <IconVote />
                <span className="dz-meet-item-text"><span>Past votes</span><small>Results and who voted how</small></span>
              </button>
              <button type="button" className="dz-meet-item" aria-pressed={spotlight.mine} onClick={() => {
                if (spotlight.mine) controller.spotlight.stop();
                else controller.spotlight.start();
                close();
              }}>
                <IconSpotlight />
                <span className="dz-meet-item-text">
                  <span>{spotlight.mine ? 'Stop getting attention' : 'Get attention'}</span>
                  <small>{spotlight.mine ? 'Everyone is following your view' : 'Everyone will follow your view'}</small>
                </span>
              </button>
            </div>
          )}
          </Accented>
        </Popover>
      )}
    </>
  );
}

function VoteSetup({controller, onDone, onBack}: {controller: MeetingController; onDone(): void; onBack(): void}) {
  const [perPerson, setPerPerson] = useState<number>(MEETING_LIMITS.votesPerPersonDefault);
  // FigJam's vote: a prompt ("Pick your 3 favorite ideas") and the others' cursors hidden while it runs.
  const [prompt, setPrompt] = useState('');
  const [hideCursors, setHideCursors] = useState(true);
  const [timed, setTimed] = useState(true);
  const [minutes, setMinutes] = useState(3);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    const ok = await controller.session.vote({action: 'start', perPerson, durationMs: timed ? minutes * 60_000 : null, prompt: prompt.trim() || null, hideCursors});
    setBusy(false);
    if (ok) {
      controller.startVoting();
      onDone();
    }
  };
  return (
    <div className="dz-meet-panel">
      <div className="dz-meet-panel-title">Voting</div>
      <p className="dz-meet-note">Everyone places dots on {controller.targets.noun}. Nobody sees how many dots others have until voting ends.</p>
      <TextInput value={prompt} onChange={setPrompt} maxLength={MEETING_LIMITS.promptLength} placeholder="For example: pick the three best ideas" aria-label="Voting question" size={32} />
      <Stepper label="Votes per person" value={perPerson} min={MEETING_LIMITS.votesPerPersonMin} max={MEETING_LIMITS.votesPerPersonMax} onChange={setPerPerson} />
      <div className="dz-meet-row"><Checkbox checked={hideCursors} onChange={value => setHideCursors(value === true)}>Hide participants’ cursors</Checkbox></div>
      <div className="dz-meet-row">
        <Checkbox checked={timed} onChange={setTimed}>With a timer</Checkbox>
        {timed && <Stepper label="Minutes" value={minutes} min={1} max={99} onChange={setMinutes} suffix="min" inline />}
      </div>
      {timed && <p className="dz-meet-note">Voting ends in {durationWords(minutes * 60_000)}, together with the timer.</p>}
      <div className="dz-meet-actions">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" className="dz-meet-grow" busy={busy} onClick={() => void start()}>Start voting</Button>
      </div>
    </div>
  );
}

/** "Past votes": the file's ended sessions, newest first, each with its ranking and who voted how; an editor deletes one. */
function VoteHistory({controller, onBack}: {controller: MeetingController; onBack(): void}) {
  const state = useSession(controller);
  const [votes, setVotes] = useState<DesignMeetingVoteRecord[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    pastVotes(controller.fileId).then(answer => live && setVotes(answer.votes), () => live && setVotes([]));
    return () => {
      live = false;
    };
  }, [controller.fileId]);
  const doc = controller.store.getState().doc;
  const remove = async (id: string) => {
    await deletePastVote(controller.fileId, id).catch(() => undefined);
    setVotes(list => (list ?? []).filter(vote => vote.id !== id));
  };
  return (
    <div className="dz-meet-panel">
      <div className="dz-meet-panel-title">Past votes</div>
      {votes === null ? <p className="dz-meet-note">Loading…</p> : votes.length === 0 ? <p className="dz-meet-note">No votes yet.</p> : (
        <ul className="dz-meet-history">
          {votes.map(vote => (
            <li key={vote.id}>
              <button type="button" className="dz-meet-item" aria-expanded={open === vote.id} onClick={() => setOpen(current => (current === vote.id ? null : vote.id))}>
                <span className="dz-meet-item-text">
                  <span>{vote.prompt || 'Voting'}</span>
                  <small>{new Date(vote.endedAt).toLocaleString('en-US', {day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'})} · {vote.voters} voted</small>
                </span>
              </button>
              {open === vote.id && (
                <div className="dz-meet-history-body">
                  <ol className="dz-meet-ranking">
                    {vote.results.slice(0, 20).map(tally => (
                      <li key={tally.nodeId}>
                        <button type="button" className="dz-meet-rank" onClick={() => controller.reveal(tally.nodeId)}>
                          <span className="dz-meet-rank-name">{controller.targets.box(doc, tally.nodeId) ? controller.targets.label(doc, tally.nodeId) : 'Deleted object'}</span>
                          <span className="dz-meet-rank-count">{tally.count}</span>
                        </button>
                        {tally.by?.length ? <p className="dz-meet-rank-by">{tally.by.map(person => `${person.name} ${person.count}`).join(' · ')}</p> : null}
                      </li>
                    ))}
                  </ol>
                  {state?.canControl && <Button onClick={() => void remove(vote.id)}>Delete results</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="dz-meet-actions"><Button onClick={onBack}>Back</Button></div>
    </div>
  );
}

function Stepper({label, value, min, max, onChange, suffix, inline}: {label: string; value: number; min: number; max: number; onChange(value: number): void; suffix?: string; inline?: boolean}) {
  return (
    <div className={`dz-meet-row${inline ? ' is-inline' : ''}`}>
      {!inline && <span className="dz-meet-row-label">{label}</span>}
      <div className="dz-meet-stepper" role="group" aria-label={label}>
        <button type="button" className="dz-meet-step" aria-label={`${label}: less`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}><IconMinus /></button>
        <span className="dz-meet-stepper-value" aria-live="polite">{value}{suffix ? ` ${suffix}` : ''}</span>
        <button type="button" className="dz-meet-step" aria-label={`${label}: more`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}><IconPlus /></button>
      </div>
    </div>
  );
}

const ACCENT_VARS = ['--dz-meet-accent', '--dz-meet-accent-text', '--dz-meet-accent-hover'] as const;
/** A popover is drawn in the editor's layer, outside the board that holds its trigger: it takes the meeting's accent where the trigger
 *  stands (a board's purple; a design file's blue is the same everywhere). */
function Accented({anchor, children}: {anchor: HTMLElement; children: React.ReactNode}) {
  const style = useMemo(() => {
    const computed = getComputedStyle(anchor);
    return Object.fromEntries(ACCENT_VARS.map(name => [name, computed.getPropertyValue(name).trim()]).filter(([, value]) => value)) as CSSProperties;
  }, [anchor]);
  return (
    <div className="dz-meet-accented" style={style}>
      {children}
    </div>
  );
}

/** The accent of the people's colours for a style attribute. */
export const personStyle = (color: string) => ({'--dz-live-color': color}) as CSSProperties;
