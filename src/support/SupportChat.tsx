import './support-chat.css';
import {Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent} from 'react';
import {ApiError, apiAccount} from '../api';
import {errorText} from '../design/ui/error-text';
import {BrandMorph} from '../brand/BrandMorph';
import {BrandSymbol} from '../brand/marks';
import {PRODUCT_NAME} from '../../shared/design/product';
import {SUPPORT_MESSAGE_MAX, SUPPORT_POLL_OPEN_MS, SUPPORT_TEAM_NAME, type SupportMessage, type SupportTeam, type SupportThreadView} from '../../shared/support';
import {
  chatDays, counterText, emptyText, newOperatorMessages, presenceText, QUICK_STARTS, readMessageId, receivedNote, receivedNoteRun, TEAM_TYPING, teamHeadline,
  timeLabel, typicalReplyText, unconfirmed, type ChatBubble, type ChatRun, type PendingMessage,
} from './chat-model';
import {supportPlace} from './open';
import {markSupportRead, newClientId, readSupportThread, sendSupportMessage, setSupportState} from './state';

// The person's support chat (shared/support.ts): a panel anchored to the bottom right (a full-screen sheet on a phone) with the
// conversation and a composer. It reads the conversation every SUPPORT_POLL_OPEN_MS while the tab is visible and marks it read
// while it is shown; a message appears at once (pending), is confirmed by the server's answer, and on failure says so with
// "Retry", which sends the same key again (the server keeps one message per key). Each message carries where it was written
// (src/support/open.ts supportPlace). Plain text only: React escapes every message, nothing is rendered as markup. A dialog: the
// focus stays inside while it is open, Esc closes it, and SupportHost gives the focus back to what opened it. Its own chunk.
//
// The person is told the truth about who answers (shared/support.ts SupportTeam): Morfa's team, by its mark and "Morfa team",
// never one person's name or face; "Online" only while an operator has the console open, "typing…" only while one types, the usual
// reply time only when it was measured, a note after their first message that a person will read it (and the letter only when one
// will go). Nothing here is staged.


type View = SupportThreadView;
type Load = {status: 'loading'} | {status: 'error'; message: string} | {status: 'ready'; view: View};

// What the person typed and what failed to send stay for the tab's life when the panel is closed and opened again, for the
// account that wrote them only (another account signed in in this tab starts empty).
let kept: {account: string | null; draft: string; pending: PendingMessage[]} = {account: null, draft: '', pending: []};
const keptNow = () => (kept.account === apiAccount() ? kept : (kept = {account: apiAccount(), draft: '', pending: []}));

const NEAR_BOTTOM_PX = 48;
const COMPOSER_MAX_PX = 148;
const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const PHONE_QUERY = '(max-width: 767px)';

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
const visibleNow = () => document.visibilityState === 'visible';
const subscribePhone = (listener: () => void) => {
  const query = matchMedia(PHONE_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};
const phoneNow = () => matchMedia(PHONE_QUERY).matches;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function SupportChat({onClose}: {onClose: () => void}) {
  const [load, setLoad] = useState<Load>({status: 'loading'});
  // A failed send whose request was lost with the closed panel can be sent again: it reads as failed when the panel comes back.
  const [pending, setPending] = useState<PendingMessage[]>(() => keptNow().pending.map(item => ({...item, status: 'failed' as const})));
  const [draft, setDraft] = useState(() => keptNow().draft);
  const [fresh, setFresh] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const visible = useSyncExternalStore(subscribeVisibility, visibleNow, visibleNow);
  const phone = useSyncExternalStore(subscribePhone, phoneNow, phoneNow);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // Answers apply in the order their requests left: a poll that left before a send never overwrites the send's answer.
  const issued = useRef(0);
  const applied = useRef(0);
  const sending = useRef(0);
  const marking = useRef(false);
  const known = useRef<Set<string> | null>(null);
  const shown = useRef<readonly SupportMessage[]>([]);
  const firstKeys = useRef<Set<string> | null>(null);
  const stick = useRef(true);
  const scrollNext = useRef<'instant' | 'smooth' | null>('instant');
  const shownCount = useRef(0);

  useEffect(() => {
    keptNow().draft = draft;
  }, [draft]);
  useEffect(() => {
    keptNow().pending = pending;
  }, [pending]);

  const apply = useCallback((ticket: number, view: View) => {
    if (ticket < applied.current) return;
    applied.current = ticket;
    setLoad({status: 'ready', view});
    setSupportState({unread: view.thread?.unread ?? 0});
    // The operator's new messages are read out once (never what was there when the panel opened).
    const messages = view.thread?.messages ?? [];
    if (known.current) {
      const arrived = newOperatorMessages(messages, known.current);
      const last = arrived.at(-1);
      if (last)
        setAnnouncement(`${SUPPORT_TEAM_NAME}: ${arrived.map(message => message.body).join(' · ')}`.slice(0, 400));
    }
    known.current = new Set(messages.map(message => message.id));
    shown.current = messages;
  }, []);

  const refresh = useCallback(async () => {
    if (sending.current) return;
    const ticket = ++issued.current;
    try {
      apply(ticket, await readSupportThread());
    } catch (error) {
      // A failed poll keeps what is shown; only the first read has nothing to show instead.
      setLoad(current => (current.status === 'ready' ? current : {status: 'error', message: errorText(error, 'Could not load the conversation.')}));
    }
  }, [apply]);

  // The conversation while the panel is open and the tab visible; at once when it becomes visible again.
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), SUPPORT_POLL_OPEN_MS);
    return () => window.clearInterval(timer);
  }, [visible, refresh]);

  // Shown and visible: the operator's messages are read.
  const unread = load.status === 'ready' ? (load.view.thread?.unread ?? 0) : 0;
  useEffect(() => {
    if (!visible || !unread || marking.current) return;
    marking.current = true;
    markSupportRead().then(
      () => {
        setLoad(current =>
          current.status === 'ready' && current.view.thread ? {...current, view: {...current.view, thread: {...current.view.thread, unread: 0}}} : current,
        );
        setSupportState({unread: 0});
      },
      () => undefined,
    ).finally(() => {
      marking.current = false;
    });
  }, [visible, unread]);

  const send = useCallback((text: string, clientId = newClientId(), createdAt = new Date().toISOString()) => {
    const body = text.trim();
    if (!body || body.length > SUPPORT_MESSAGE_MAX) return;
    // The same words sent before ("Thanks" again) are not this message's copy; a retry keeps what its first send saw.
    const seen = shown.current.filter(message => message.author === 'user' && message.body === body).map(message => message.id);
    setPending(list => [
      ...list.filter(item => item.clientId !== clientId),
      {clientId, body, createdAt, status: 'sending', seen: list.find(item => item.clientId === clientId)?.seen ?? seen},
    ]);
    scrollNext.current = 'smooth';
    sending.current++;
    const ticket = ++issued.current;
    sendSupportMessage(body, clientId, supportPlace()).then(
      view => {
        apply(ticket, view);
        setPending(list => list.filter(item => item.clientId !== clientId));
      },
      error => {
        const shown = error instanceof ApiError && (error.status === 429 || error.status === 422) ? error.message : undefined;
        setPending(list => list.map(item => (item.clientId === clientId ? {...item, status: 'failed', error: shown} : item)));
      },
    ).finally(() => {
      sending.current--;
    });
  }, [apply]);

  const submit = () => {
    const counter = counterText(draft);
    if (!draft.trim() || counter?.over) return;
    send(draft);
    setDraft('');
    composer.current?.focus();
  };

  // The composer grows with its text up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, COMPOSER_MAX_PX) + 'px';
  }, [draft]);

  useEffect(() => {
    composer.current?.focus({preventScroll: true});
  }, []);

  const view = load.status === 'ready' ? load.view : null;
  const thread = view?.thread ?? null;
  const team = view?.team ?? null;
  const typing = !!view?.operatorTyping;
  const messages = useMemo(() => thread?.messages ?? [], [thread]);
  const days = useMemo(() => chatDays(messages, pending), [messages, pending]);
  const waitingOnes = useMemo(() => unconfirmed(messages, pending), [messages, pending]);
  // Pending messages the server already holds (their answer was lost) are confirmed by a poll: forget them.
  useEffect(() => {
    const confirmed = pending.filter(item => !waitingOnes.includes(item));
    if (confirmed.length) setPending(list => list.filter(item => !confirmed.includes(item)));
  }, [waitingOnes, pending]);
  const readId = waitingOnes.length ? null : readMessageId(messages, thread?.operatorReadAt ?? null);
  const count = messages.length + waitingOnes.length;
  const noteRun = receivedNoteRun(days);
  if (load.status === 'ready' && !firstKeys.current) firstKeys.current = new Set(messages.map(message => message.id));

  // New messages: the list follows them while it is at its end, and otherwise offers "New messages".
  useLayoutEffect(() => {
    const element = list.current;
    // The first answer lands at the end at once; nothing to place before it.
    if (!element || load.status !== 'ready') return;
    const grew = count > shownCount.current;
    shownCount.current = count;
    const how = scrollNext.current;
    scrollNext.current = null;
    if (how || (grew && stick.current)) {
      stick.current = true;
      setFresh(false);
      element.scrollTo({top: element.scrollHeight, behavior: how === 'instant' || reducedMotion() ? 'auto' : 'smooth'});
    } else if (grew) setFresh(true);
  }, [count, load.status]);

  // "typing…" appears at the end: in view if the list is at its end.
  useLayoutEffect(() => {
    const element = list.current;
    if (typing && element && stick.current) element.scrollTo({top: element.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth'});
  }, [typing]);

  // The list keeps its end in view while the composer grows or the panel resizes.
  useEffect(() => {
    const element = list.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [load.status]);

  const scrolled = () => {
    const element = list.current;
    if (!element) return;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (stick.current) setFresh(false);
  };
  const toEnd = () => {
    const element = list.current;
    if (!element) return;
    stick.current = true;
    setFresh(false);
    element.scrollTo({top: element.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth'});
  };

  // A dialog: Tab stays inside, Esc closes; no key reaches the editor behind it.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.offsetParent !== null || element === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0]!,
      last = focusable.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const composerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const prefill = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const field = composer.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(text.length, text.length);
    });
  };

  const counter = counterText(draft);
  const canSend = !!draft.trim() && !counter?.over;
  const empty = load.status === 'ready' && !messages.length && !waitingOnes.length;

  return (
    <div ref={panel} className="mf-sc" role="dialog" aria-modal={phone} aria-label={`${PRODUCT_NAME} support`} aria-describedby="mf-sc-subtitle" onKeyDown={onKeyDown}>
      <Header team={team} onClose={onClose} />

      <div className="mf-sc-body">
        <div ref={list} className="mf-sc-list" onScroll={scrolled} tabIndex={-1} aria-label="Support conversation" role="log" aria-live="off">
          {load.status === 'loading' && <Skeleton />}
          {load.status === 'error' && (
            <div className="mf-sc-state" role="alert">
              <p className="mf-sc-state-title">Could not load the conversation</p>
              <p className="mf-sc-state-text">{load.message}</p>
              <button type="button" className="mf-sc-chip is-solid" onClick={() => {setLoad({status: 'loading'}); void refresh();}}>Retry</button>
            </div>
          )}
          {empty && (
            <div className="mf-sc-empty">
              {team?.operators.length ? <TeamFace size="lg" online={team.online} /> : <span className="mf-sc-empty-mark" aria-hidden="true"><BrandMorph motion="once" className="mf-sc-empty-morph" /></span>}
              <p className="mf-sc-empty-title">Hello! How can we help?</p>
              <p className="mf-sc-empty-text">{team ? emptyText(team) : 'Tell us what happened or what you want to know. The reply will appear here.'}</p>
              <div className="mf-sc-chips" role="group" aria-label="Quick start">
                {QUICK_STARTS.map(start => (
                  <button key={start.label} type="button" className="mf-sc-chip" onClick={() => prefill(start.text)}>{start.label}</button>
                ))}
              </div>
            </div>
          )}
          {days.map(day => (
            <section key={day.key} className="mf-sc-day" aria-label={day.label}>
              <p className="mf-sc-day-label"><span>{day.label}</span></p>
              {day.runs.map(run => (
                <Fragment key={run.key}>
                  <Run run={run} readId={readId} fresh={firstKeys.current} onRetry={item => send(item.body, item.clientId, item.createdAt)} />
                  {run.key === noteRun && team && <p className="mf-sc-note" role="note">{receivedNote(team)}</p>}
                </Fragment>
              ))}
            </section>
          ))}
          {typing && team && <Typing />}
        </div>
        {fresh && (
          <button type="button" className="mf-sc-fresh" onClick={toEnd}>
            New messages
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M8 3v9.75M4.25 9 8 12.75 11.75 9" /></svg>
          </button>
        )}
      </div>

      <form className="mf-sc-composer" onSubmit={event => {event.preventDefault(); submit();}}>
        <div className={`mf-sc-field${counter?.over ? ' is-over' : ''}`}>
          <textarea ref={composer} className="mf-sc-input" rows={1} value={draft} placeholder="Write a message…" aria-label="Message to support"
            aria-describedby="mf-sc-hint" maxLength={SUPPORT_MESSAGE_MAX + 2000} onChange={event => setDraft(event.target.value)} onKeyDown={composerKeyDown} />
          <button type="submit" className="mf-sc-send" disabled={!canSend} aria-label="Send">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M8 13V3.25M4.25 7 8 3.25 11.75 7" /></svg>
          </button>
        </div>
        <div className="mf-sc-composer-foot">
          <span id="mf-sc-hint" className="mf-sc-hint">Enter to send, Shift + Enter for a new line</span>
          {counter && <span className={`mf-sc-counter${counter.over ? ' is-over' : ''}`} aria-live="polite">{counter.text}</span>}
        </div>
      </form>
      <div className="mf-visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</div>
    </div>
  );
}

/** The panel's head: who answers (the team, by its face and name), that people answer, whether they are here now, how long answers
 *  usually take. Until the first answer comes, the product's mark. */
function Header({team, onClose}: {team: SupportTeam | null; onClose: () => void}) {
  const headline = team ? teamHeadline(team) : null;
  const reply = team ? typicalReplyText(team) : null;
  return (
    <header className="mf-sc-head">
      <div className="mf-sc-head-main">
        {team && headline ? <TeamFace size="md" online={team.online} /> : <span className="mf-sc-head-mark" aria-hidden="true"><BrandMorph motion="once" className="mf-sc-head-morph" /></span>}
        <div className="mf-sc-head-text">
          <h2 className="mf-sc-title">{headline ? headline.title : `${PRODUCT_NAME} support`}</h2>
          <p className="mf-sc-subtitle" id="mf-sc-subtitle">{headline?.subtitle ?? 'The reply will appear here'}</p>
        </div>
        <button type="button" className="mf-sc-close" aria-label="Close chat" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      {team && headline && (
        <p className={`mf-sc-status${team.online ? ' is-online' : ''}`}>
          <span className="mf-sc-status-dot" aria-hidden="true" />
          <span>
            {presenceText(team)}
            {reply && (team.online ? <span className="mf-sc-status-reply"> · {reply}</span> : <span className="mf-sc-status-reply is-line">{reply}</span>)}
          </span>
        </p>
      )}
    </header>
  );
}

/** The team's face: Morfa's mark, round as people's faces are; the green dot while someone is here. */
function TeamFace({size, online = false}: {size: 'sm' | 'md' | 'lg'; online?: boolean}) {
  return (
    <span className={`mf-sc-face is-${size}`} aria-hidden="true">
      <BrandSymbol palette="onBrand" className="mf-sc-face-mark" />
      {online && <span className="mf-sc-face-online" />}
    </span>
  );
}

/** "Morfa team is typing…": three dots in the team's bubble while an operator types (never shown otherwise). */
function Typing() {
  return (
    <div className="mf-sc-run is-theirs is-typing">
      <TeamFace size="sm" />
      <div className="mf-sc-run-body">
        <p className="mf-sc-bubble is-single mf-sc-typing" aria-hidden="true"><i /><i /><i /></p>
        <p className="mf-sc-meta">{TEAM_TYPING}</p>
      </div>
    </div>
  );
}

function Run({run, readId, fresh, onRetry}: {run: ChatRun; readId: string | null; fresh: Set<string> | null; onRetry: (item: PendingMessage) => void}) {
  const mine = run.author === 'user';
  const operator = run.author === 'operator';
  const last = run.bubbles.at(-1)!;
  return (
    <div className={`mf-sc-run ${mine ? 'is-mine' : 'is-theirs'}`}>
      {operator && <TeamFace size="sm" />}
      <div className="mf-sc-run-body">
        {operator && <p className="mf-sc-author">{SUPPORT_TEAM_NAME}</p>}
        {run.bubbles.map((bubble, index) => (
          <Bubble key={bubble.key} bubble={bubble} position={run.bubbles.length === 1 ? 'single' : index === 0 ? 'first' : index === run.bubbles.length - 1 ? 'last' : 'middle'}
            arrived={!!fresh && !mine && !fresh.has(bubble.key)} />
        ))}
        <Meta bubble={last} read={last.key === readId} onRetry={onRetry} />
      </div>
    </div>
  );
}

function Bubble({bubble, position, arrived}: {bubble: ChatBubble; position: 'single' | 'first' | 'middle' | 'last'; arrived: boolean}) {
  const state = bubble.pending ? ` is-${bubble.pending.status}` : '';
  return (
    <p className={`mf-sc-bubble is-${position}${state}${arrived || bubble.pending ? ' is-new' : ''}`}>
      {bubble.body}
    </p>
  );
}

function Meta({bubble, read, onRetry}: {bubble: ChatBubble; read: boolean; onRetry: (item: PendingMessage) => void}) {
  const pending = bubble.pending;
  if (pending?.status === 'failed')
    return (
      <div className="mf-sc-meta is-failed" role="status">
        <svg className="mf-sc-failed-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 4.75v3.75" />
          <circle cx="8" cy="11" r="0.6" />
        </svg>
        <span>Not sent</span>
        <span aria-hidden="true">·</span>
        <button type="button" className="mf-sc-retry" onClick={() => onRetry(pending)}>Retry</button>
        {pending.error && <span className="mf-sc-meta-error">{pending.error}</span>}
      </div>
    );
  if (pending) return <p className="mf-sc-meta">Sending…</p>;
  return (
    <p className="mf-sc-meta">
      <time dateTime={bubble.createdAt}>{timeLabel(bubble.createdAt)}</time>
      {read && (
        <span className="mf-sc-read">
          <svg viewBox="0 0 18 12" width="16" height="11" aria-hidden="true" focusable="false"><path d="m1.5 6.5 3 3 6-7M7.75 8.25l1.25 1.25 6-7" /></svg>
          Read
        </span>
      )}
    </p>
  );
}

function Skeleton() {
  return (
    <div className="mf-sc-skeleton" aria-busy="true" aria-label="Loading the conversation">
      <span className="is-theirs" style={{width: '62%'}} />
      <span className="is-mine" style={{width: '48%'}} />
      <span className="is-theirs" style={{width: '70%'}} />
      <span className="is-mine" style={{width: '36%'}} />
    </div>
  );
}
