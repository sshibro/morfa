import {memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties} from 'react';
import {emoteEmoji, formatTimer, MEETING_EMOTES, MEETING_LIMITS, rankTallies, voteEnded, votesLeft, votesUsed} from '../../../../shared/design/meeting';
import {markReady} from '../../editor/readiness';
import {useDesignStore} from '../../engine/useDesignStore';
import {Button, IconButton} from '../../ui/Button';
import type {MeetingController} from '../controller';
import {setVoteTakesBack} from '../touch-take-back';
import {colorOf, votesWord} from '../overlay';
import {IconClose, IconSpotlight, IconVote} from '../icons';

// Over the canvas (docs/board-meeting.md): the overlay's root (bursts, the others' chat and hands, vote badges — drawn without React,
// overlay.ts), this person's own cursor chat field, the voting bar, the results, "Get attention" and the emote bar. The bars that
// replace the toolbar swap in at once (a mode entered from the keyboard as often as the pointer; emil-design-eng: no motion there).

const useSession = (controller: MeetingController) => useSyncExternalStore(controller.session.subscribe, controller.session.state);

/** The meeting is on screen with its state (both editors mount this layer): the file's readiness waits for it (editor/readiness.ts). */
function MarkReady({controller}: {controller: MeetingController}) {
  const read = useSession(controller) !== null;
  useEffect(() => (read ? markReady(controller.fileId, 'meeting') : undefined), [controller, read]);
  return null;
}

export const MeetingCanvasLayer = memo(function MeetingCanvasLayer({controller}: {controller: MeetingController}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    controller.attach(root.current);
    return () => controller.attach(null);
  }, [controller]);
  const me = useSyncExternalStore(controller.identity.subscribe, controller.identity.get);
  const style = {'--dz-meet-self': colorOf(me?.color ?? 0)} as CSSProperties;
  return (
    <div className="dz-meet-layer" style={style}>
      <div className="dz-meet-overlay" ref={root} />
      <MarkReady controller={controller} />
      <ChatField controller={controller} />
      <VoteBar controller={controller} />
      <Results controller={controller} />
      <SpotlightPill controller={controller} />
      <EmoteBar controller={controller} />
    </div>
  );
});

// ── Cursor chat ──────────────────────────────────────────────────────────────────────────────────

/** "/": a bubble at this person's pointer, in their colour, with the field already focused. Appears at once (a key opens it). */
function ChatField({controller}: {controller: MeetingController}) {
  const chat = useSyncExternalStore(controller.chat.subscribe, controller.chat.state);
  const me = useSyncExternalStore(controller.identity.subscribe, controller.identity.get);
  const bubble = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = chat.open || chat.sent;
  // Follows the pointer without a render: the transform is written straight into the element.
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const at = controller.pointer.get();
      if (at && bubble.current) bubble.current.style.transform = `translate3d(${at.screen.x.toFixed(1)}px, ${at.screen.y.toFixed(1)}px, 0)`;
    };
    place();
    return controller.pointer.subscribe(place);
  }, [controller, shown]);
  useEffect(() => {
    if (chat.open) input.current?.focus({preventScroll: true});
  }, [chat.open]);
  if (!shown) return null;
  return (
    <div className={`dz-meet-chat-self${chat.sent ? ' is-sent' : ''}`} ref={bubble} style={{'--dz-live-color': colorOf(me?.color ?? 0)} as CSSProperties}>
      {chat.open ? (
        <input ref={input} className="dz-meet-chat-input" aria-label="Cursor chat: everyone in the file sees the message" placeholder="Say something"
          value={chat.text} maxLength={MEETING_LIMITS.chatLength * 2} autoComplete="off" spellCheck={false}
          onChange={event => controller.chat.type(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              controller.chat.send();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              controller.chat.close();
            }
          }}
          onBlur={() => (controller.chat.state().text.trim() ? controller.chat.send() : controller.chat.close())}
          size={Math.max(12, Math.min(40, chat.text.length + 2))} />
      ) : (
        <span className="dz-meet-chat-sent">{chat.text}</span>
      )}
    </div>
  );
}

// ── Voting ───────────────────────────────────────────────────────────────────────────────────────

function VoteBar({controller}: {controller: MeetingController}) {
  const state = useSession(controller);
  const mode = useSyncExternalStore(controller.mode.subscribe, controller.mode.get);
  useSyncExternalStore(controller.tick.subscribe, controller.tick.get);
  const vote = state?.vote ?? null;
  const now = controller.session.clock.now();
  // A finger has no ⌥: on a touch screen the board's bar offers "Remove vote" for the next taps (touch-take-back.ts).
  const [takingBack, setTakingBack] = useState(false);
  const touchBoard = controller.surfaceKind === 'board' && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  useEffect(() => {
    setVoteTakesBack(controller.store, takingBack && mode === 'vote');
  }, [controller.store, takingBack, mode]);
  // Nothing left to take back: the switch goes off by itself.
  const used = vote ? votesUsed(vote.mine) : 0;
  useEffect(() => {
    if (!used) setTakingBack(false);
  }, [used]);
  if (!vote || vote.results || voteEnded(vote, now)) return null;
  const voting = mode === 'vote';
  const left = votesLeft(vote);
  return (
    <div className={`dz-meet-votebar${voting ? ' is-voting' : ''}`} role="region" aria-label="Voting">
      <IconVote />
      {vote.prompt && <span className="dz-meet-votebar-prompt">{vote.prompt}</span>}
      <span className="dz-meet-votebar-text" role="status">
        {voting ? (takingBack ? `Click ${controller.targets.noun} to remove your votes` : left ? `Keep clicking ${controller.targets.noun}: ${left} of ${vote.perPerson} left` : `You are out of votes: ${touchBoard ? 'turn on “Remove vote” and click an object' : controller.takeBack}`) : `Voting in progress · ${left} of ${vote.perPerson} left`}
      </span>
      {vote.endsAt !== null && <span className="dz-meet-votebar-time">{formatTimer(vote.endsAt - now)}</span>}
      {voting && touchBoard && used > 0 && (
        <Button variant="ghost" aria-pressed={takingBack} className={takingBack ? 'is-pressed' : undefined} onClick={() => setTakingBack(on => !on)}>Remove vote</Button>
      )}
      {voting ? (
        <Button variant="ghost" onClick={controller.stopVoting}>Done</Button>
      ) : (
        <Button variant="primary" onClick={controller.startVoting}>Vote</Button>
      )}
      {state?.canControl && (
        <IconButton label={vote.hideCursors ? 'Show participants’ cursors' : 'Hide participants’ cursors'} onClick={() => void controller.session.vote({action: 'cursors', hide: !vote.hideCursors})}>
          {vote.hideCursors ? <IconCursorOff /> : <IconCursor />}
        </IconButton>
      )}
      {state?.canControl && <EndForEveryone onEnd={() => void controller.session.vote({action: 'end'})} />}
    </div>
  );
}

/** FigJam's "End for everyone", confirmed: the first press asks, the second ends; anything else puts the question away. */
function EndForEveryone({onEnd}: {onEnd(): void}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button onClick={() => setAsking(true)}>End</Button>;
  return (
    <span className="dz-meet-confirm" role="group" aria-label="End voting for everyone?">
      <Button variant="primary" onClick={() => { setAsking(false); onEnd(); }}>End for everyone</Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
    </span>
  );
}

const IconCursor = ({size = 14}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" aria-hidden="true"><path d="M3.5 2.5l9 4.2-3.9 1.2-1.4 4.1z" /></svg>
);
const IconCursorOff = ({size = 14}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M3.5 2.5l9 4.2-3.9 1.2-1.4 4.1z" /><path d="M2 14L14 2" /></svg>
);

function Results({controller}: {controller: MeetingController}) {
  const state = useSession(controller);
  const shown = useSyncExternalStore(controller.showResults.subscribe, controller.showResults.get);
  const vote = state?.vote ?? null;
  const visible = !!vote?.results && shown;
  // The document only while the results show (they name and find the voted layers): without them every frame of a drag
  // re-rendered this empty component.
  const doc = useDesignStore(next => (visible ? next.doc : null), Object.is, {store: controller.store, slice: 'doc'});
  if (!vote?.results || !shown || !doc) return null;
  const ranked = rankTallies(vote.results).filter(tally => controller.targets.box(doc, tally.nodeId));
  const total = vote.results.reduce((sum, tally) => sum + tally.count, 0);
  const mine = votesUsed(vote.mine);
  return (
    <section className="dz-meet-results" aria-label="Voting results">
      <header className="dz-meet-results-head">
        <IconVote />
        <h2>Voting results</h2>
        <button type="button" className="dz-meet-icon" aria-label="Hide results" onClick={() => controller.showResults.set(false)}><IconClose /></button>
      </header>
      {vote.prompt && <p className="dz-meet-results-prompt">{vote.prompt}</p>}
      <p className="dz-meet-note">
        {vote.voters ? `${vote.voters} voted · ${total} ${votesWord(total)}` : 'Nobody has voted'}
        {mine ? ` · yours ${mine}` : ''}
      </p>
      {ranked.length > 0 && (
        <ol className="dz-meet-ranking">
          {ranked.slice(0, 20).map(tally => (
            <li key={tally.nodeId}>
              <button type="button" className="dz-meet-rank" onClick={() => controller.reveal(tally.nodeId)}>
                <span className={`dz-meet-rank-place${tally.rank === 1 ? ' is-top' : ''}`}>{tally.rank}</span>
                <span className="dz-meet-rank-name">{controller.targets.label(doc, tally.nodeId)}</span>
                <span className="dz-meet-rank-count">{tally.count}</span>
                <span className="dz-meet-rank-bar" style={{'--dz-meet-share': `${(tally.count / ranked[0].count) * 100}%`} as CSSProperties} aria-hidden="true" />
              </button>
              {/* Who gave this object their votes (lane S's `by`, after the end). */}
              {tally.by?.length ? <p className="dz-meet-rank-by">{tally.by.map(person => `${person.name} ${person.count}`).join(' · ')}</p> : null}
            </li>
          ))}
        </ol>
      )}
      {state?.canControl && (
        <div className="dz-meet-actions">
          <Button className="dz-meet-grow" onClick={() => void controller.session.vote({action: 'clear'})}>Clear results for everyone</Button>
        </div>
      )}
    </section>
  );
}

// ── "Get attention" ──────────────────────────────────────────────────────────────────────────

/** The presenter's own pill, or — for someone who stepped away from them — a way back. Following itself shows the follow pill. */
function SpotlightPill({controller}: {controller: MeetingController}) {
  const view = useSyncExternalStore(controller.spotlight.subscribe, controller.spotlight.view);
  if (view.mine)
    return (
      <div className="dz-meet-spotlight is-mine" role="status">
        <IconSpotlight size={14} />
        <span>Everyone is following your view</span>
        <button type="button" className="dz-meet-spotlight-action" onClick={() => controller.spotlight.stop()}>Stop</button>
      </div>
    );
  if (view.presenter && !view.following)
    return (
      <div className="dz-meet-spotlight" role="status" style={{'--dz-live-color': colorOf(view.presenter.color)} as CSSProperties}>
        <IconSpotlight size={14} />
        <span>{view.presenter.name} is getting attention</span>
        <button type="button" className="dz-meet-spotlight-action" onClick={() => controller.spotlight.rejoin()}>Follow</button>
      </div>
    );
  return null;
}

// ── Emotes ───────────────────────────────────────────────────────────────────────────────────────

function EmoteBar({controller}: {controller: MeetingController}) {
  const mode = useSyncExternalStore(controller.mode.subscribe, controller.mode.get);
  const choice = useSyncExternalStore(controller.emote.subscribe, controller.emote.choice);
  if (mode !== 'emote') return null;
  return (
    <div className="dz-meet-emotebar" role="toolbar" aria-label="Reactions">
      {MEETING_EMOTES.map(emote => (
        <button key={emote.id} type="button" className="dz-meet-emote" aria-label={emote.label} aria-pressed={choice === emote.id} title={emote.label}
          onClick={() => controller.emote.choose(emote.id)}>
          <span aria-hidden="true">{emoteEmoji(emote.id)}</span>
        </button>
      ))}
      <button type="button" className="dz-meet-emote" aria-label="High five" aria-pressed={choice === 'wave'} title="High five: wave next to someone else’s cursor" onClick={() => controller.emote.choose('wave')}>
        <span aria-hidden="true">✋</span>
      </button>
      <span className="dz-meet-emotebar-hint">{choice === 'wave' ? 'Hold next to someone else’s cursor' : 'Press and hold on the canvas'}</span>
      <button type="button" className="dz-meet-icon" aria-label="Close reactions (Esc)" onClick={controller.emote.stop}><IconClose /></button>
    </div>
  );
}
