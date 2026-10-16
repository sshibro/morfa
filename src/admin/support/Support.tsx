import './support.css';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {ArrowLeft, ArrowUp, Check, CheckCheck, ChevronRight, CircleAlert, Lock, MessageCircle, RotateCcw, Search} from 'lucide-react';
import {ADMIN_API, type AdminAccountDetail} from '../../../shared/admin-analytics';
import {
  SUPPORT_API,
  SUPPORT_INBOX_FILTERS,
  SUPPORT_MESSAGE_MAX,
  SUPPORT_POLL_OPEN_MS,
  type SupportContext,
  type SupportConversation,
  type SupportInbox,
  type SupportInboxFilter,
  type SupportInboxRow,
  type SupportReplyInput,
  type SupportStatusInput,
} from '../../../shared/support';
import {BrandSymbol} from '../../brand/marks';
import {Sparkline} from '../charts/Sparkline';
import {adminWrite, useAdmin, useAdminQuery, useVisible, failureOf} from '../data';
import {ago, dateLabel, dayLabel, num, plural, timeLabel, NBSP} from '../format';
import {accountHash, goAdmin, supportHash, type SupportView} from '../route';
import {Avatar, Failure, PageHead, SearchBox, SegmentPill} from '../ui';

// The support inbox (#admin/support[/<threadId>]): who waits for an answer, the conversation, and the person's account at a glance.
// Two panes on a desktop (a third with the account on wide screens), a list then the conversation on a phone. Both panes poll every
// SUPPORT_POLL_OPEN_MS while the tab is in front; an answer is shown at once and sent with its own clientId, so a retry never doubles it.
const FILTER_LABEL: Record<SupportInboxFilter, string> = {waiting: 'Waiting', open: 'Open', closed: 'Closed', all: 'All'};
const WHERE_LABEL: Record<NonNullable<SupportContext['where']>, string> = {editor: 'from the editor', board: 'from a board', files: 'from the file list', other: 'from the app'};

const HOUR = 3_600_000;
/** The person sees "typing…" while these keep coming: at most one every 3 s while the operator types. */
const TYPING_EVERY_MS = 3_000;

/** How long someone waits: "12 min", "3 hr", "2 d"; the tone turns at 1 and 4 hours. */
function waitOf(since: string, now: number): {text: string; tone: 'neutral' | 'warn' | 'danger'} {
  const ms = Math.max(0, now - new Date(since).getTime());
  const minutes = Math.floor(ms / 60_000);
  const text = minutes < 60 ? `${Math.max(1, minutes)}${NBSP}min` : ms < 24 * HOUR ? `${Math.floor(ms / HOUR)}${NBSP}hr` : `${Math.floor(ms / (24 * HOUR))}${NBSP}d`;
  return {text, tone: ms < HOUR ? 'neutral' : ms < 4 * HOUR ? 'warn' : 'danger'};
}

/** A message's time in a list: today's clock, "yesterday", or the date. */
function shortWhen(iso: string, now: number): string {
  const date = new Date(iso);
  const day = (value: Date) => value.toLocaleDateString('en-CA', {timeZone: 'Europe/Moscow'});
  if (day(date) === day(new Date(now))) return timeLabel(iso);
  if (day(date) === day(new Date(now - 24 * HOUR))) return 'yesterday';
  return dateLabel(iso, now);
}

const moscowDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', {timeZone: 'Europe/Moscow'});

function daySeparator(iso: string, now: number): string {
  const day = moscowDay(iso);
  if (day === moscowDay(new Date(now).toISOString())) return 'Today';
  if (day === moscowDay(new Date(now - 24 * HOUR).toISOString())) return 'Yesterday';
  return dayLabel(day);
}

const newClientId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** A minute-by-minute clock, so waits and "5 min ago" stay true while the screen is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/* ── The list ─────────────────────────────────────────────────────────────── */

function ThreadRow({row, view, active, now}: {row: SupportInboxRow; view: SupportView; active: boolean; now: number}) {
  const wait = row.waitingSince && row.status === 'open' ? waitOf(row.waitingSince, now) : null;
  const unread = row.unread > 0;
  return (
    <li>
      <a
        href={supportHash({...view, thread: row.id})}
        className={`mfa-thread${unread ? ' is-unread' : ''}${active ? ' is-active' : ''}${row.status === 'closed' ? ' is-closed' : ''}`}
        aria-current={active ? 'true' : undefined}
      >
        <Avatar id={row.account.id} name={row.account.name} email={row.account.email} />
        <span className="mfa-thread-main">
          <span className="mfa-thread-top">
            <b>{row.account.name || row.account.email}</b>
            {wait ? (
              <span className={`mfa-wait is-${wait.tone}`} title="waiting for a reply">{wait.text}</span>
            ) : (
              <span className="mfa-thread-when">
                {row.status === 'closed' && <Lock size={11} strokeWidth={2.2} aria-label="closed" />}
                {shortWhen(row.last.createdAt, now)}
              </span>
            )}
          </span>
          <span className="mfa-thread-preview">
            {row.last.author === 'operator' && <span className="mfa-thread-you">You: </span>}
            {row.last.body}
          </span>
        </span>
        {unread && <i className="mfa-thread-dot" aria-label={`${row.unread} unread`} />}
      </a>
    </li>
  );
}

function AllAnswered() {
  return (
    <div className="mfa-answered">
      <span className="mfa-answered-art" aria-hidden="true">
        <BrandSymbol className="mfa-answered-symbol" />
        <span className="mfa-answered-check"><CheckCheck size={22} strokeWidth={2.4} /></span>
      </span>
      <b>All replies sent</b>
      <span>New requests will appear here</span>
    </div>
  );
}

/* ── The conversation ─────────────────────────────────────────────────────── */

type Pending = {clientId: string; body: string; state: 'sending' | 'failed'; at: string};

function contextText(context: SupportContext | undefined): string | null {
  if (!context || (!context.where && !context.fileId)) return null;
  const where = context.where ? WHERE_LABEL[context.where] : 'from the app';
  return context.fileId ? `${where} · file` : where;
}

function Composer({onSend, onTyping, disabled}: {onSend: (body: string) => void; onTyping?: () => void; disabled?: boolean}) {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const change = (value: string) => {
    setText(value);
    // Only while there is something being written; an emptied field or a sent answer stops it.
    if (!value.trim() || !onTyping) return;
    const now = Date.now();
    if (now - lastTyping.current >= TYPING_EVERY_MS) {
      lastTyping.current = now;
      onTyping();
    }
  };
  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [text]);
  const body = text.trim();
  const tooLong = body.length > SUPPORT_MESSAGE_MAX;
  const send = () => {
    if (!body || tooLong || disabled) return;
    onSend(body);
    setText('');
    lastTyping.current = 0;
    area.current?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  return (
    <form className="mfa-composer" onSubmit={event => {
      event.preventDefault();
      send();
    }}>
      <textarea
        ref={area}
        value={text}
        rows={1}
        onChange={event => change(event.target.value)}
        onKeyDown={onKey}
        placeholder="Reply…"
        title="Enter to send, Shift+Enter for a new line"
        aria-label="Reply (Enter to send, Shift+Enter for a new line)"
      />
      {body.length > SUPPORT_MESSAGE_MAX - 300 && <span className={`mfa-composer-count${tooLong ? ' is-over' : ''}`}>{num(body.length)} / {num(SUPPORT_MESSAGE_MAX)}</span>}
      <button type="submit" className="mfa-send" disabled={!body || tooLong || disabled} aria-label="Send">
        <ArrowUp size={18} strokeWidth={2.4} aria-hidden="true" />
      </button>
    </form>
  );
}

function AccountCard({accountId}: {accountId: string}) {
  const query = useAdminQuery<AdminAccountDetail>(ADMIN_API.account(accountId), {});
  const data = query.data;
  if (!data) {
    return (
      <aside className="mfa-acard" aria-label="Account">
        {query.error ? <p className="mfa-none">{failureOf(query.error).message}</p> : <div className="mfa-skel" style={{height: 220}} />}
      </aside>
    );
  }
  const {account} = data;
  return (
    <aside className="mfa-acard" aria-label="Account">
      <div className="mfa-acard-head">
        <Avatar id={account.id} name={account.name} email={account.email} size="md" />
        <span className="mfa-who-text">
          <b>{account.name || account.email}</b>
          <small>since {dateLabel(account.createdAt)}</small>
        </span>
      </div>
      <div className="mfa-acard-pills">
        <SegmentPill segment={account.segment} />
      </div>
      <dl className="mfa-acard-facts">
        <div><dt>Seen</dt><dd>{ago(account.lastActiveAt)}</dd></div>
        <div><dt>Files</dt><dd>{num(account.files)}</dd></div>
      </dl>
      <div className="mfa-acard-spark">
        <span>Activity, 30 days</span>
        <Sparkline values={account.activity30d} height={36} area dot />
        <small>{account.activeDays30d} {plural(account.activeDays30d, 'active day', 'active days')}</small>
      </div>
      <a className="mfa-acard-link" href={accountHash(account.id)}>
        Full profile
        <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
      </a>
    </aside>
  );
}

function Conversation({id, row, view, onChanged}: {id: string; row: SupportInboxRow | null; view: SupportView; onChanged: () => void}) {
  const query = useAdminQuery<SupportConversation>(SUPPORT_API.conversation(id), {}, {pollMs: SUPPORT_POLL_OPEN_MS});
  const [pending, setPending] = useState<Pending[]>([]);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const visible = useVisible();
  const now = useNow();
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const readUpTo = useRef<string | null>(null);
  const data = query.data;
  const replace = query.replace;
  const messages = data?.messages ?? [];
  const lastId = messages[messages.length - 1]?.id ?? null;
  const lastUser = [...messages].reverse().find(message => message.author === 'user') ?? null;

  // Read: once it is open and the tab is in front, up to the person's newest message.
  useEffect(() => {
    if (!data || !visible || !lastUser || readUpTo.current === lastUser.id) return;
    readUpTo.current = lastUser.id;
    adminWrite(SUPPORT_API.operatorRead(id), {}).then(onChanged, () => {
      readUpTo.current = null;
    });
  }, [data, visible, lastUser, id, onChanged]);

  // Stay at the newest message when it was in view (and always after the operator's own answer).
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && nearBottom.current) node.scrollTop = node.scrollHeight;
  }, [lastId, pending.length, data !== null]);

  const deliver = useCallback(async (item: Pending) => {
    setPending(list => list.map(entry => (entry.clientId === item.clientId ? {...entry, state: 'sending'} : entry)));
    try {
      const answer = await adminWrite<SupportConversation>(SUPPORT_API.reply(id), {body: item.body, clientId: item.clientId} satisfies SupportReplyInput);
      if (answer) replace(answer);
      setPending(list => list.filter(entry => entry.clientId !== item.clientId));
      onChanged();
    } catch {
      setPending(list => list.map(entry => (entry.clientId === item.clientId ? {...entry, state: 'failed'} : entry)));
    }
  }, [id, replace, onChanged]);

  // The operator is typing: the person's panel shows it. A lost ping is harmless, so failures are ignored.
  const typing = useCallback(() => {
    adminWrite(SUPPORT_API.typing(id), {}).catch(() => undefined);
  }, [id]);

  const send = (body: string) => {
    const item: Pending = {clientId: newClientId(), body, state: 'sending', at: new Date().toISOString()};
    nearBottom.current = true;
    setPending(list => [...list, item]);
    void deliver(item);
  };

  const setStatus = async (status: 'open' | 'closed') => {
    setStatusBusy(true);
    setStatusError(null);
    try {
      const answer = await adminWrite<SupportConversation>(SUPPORT_API.status(id), {status} satisfies SupportStatusInput);
      if (answer) replace(answer);
      onChanged();
    } catch (error) {
      setStatusError(error instanceof Error ? failureOf(error).message : 'That did not work');
    } finally {
      setStatusBusy(false);
    }
  };

  const person = data?.account ?? row?.account ?? null;
  const lastOperator = [...messages].reverse().find(message => message.author === 'operator') ?? null;
  const seen = !!(data?.userReadAt && lastOperator && data.userReadAt >= lastOperator.createdAt);

  return (
    <div className="mfa-convo-layout">
      <section className="mfa-convo" aria-label="Conversation">
        <header className="mfa-convo-head">
          <a className="mfa-convo-back" href={supportHash({...view, thread: null})} aria-label="All requests">
            <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
          </a>
          {person ? (
            <>
              <a className="mfa-who mfa-convo-who" href={accountHash(person.id)} title="Profile">
                <Avatar id={person.id} name={person.name} email={person.email} />
                <span className="mfa-who-text">
                  <b>{person.name || person.email}</b>
                  <small>{person.email}</small>
                </span>
              </a>
              <a className="mfa-convo-profile" href={accountHash(person.id)}>
                Profile <ChevronRight size={14} strokeWidth={2.2} aria-hidden="true" />
              </a>
            </>
          ) : (
            <span className="mfa-skel" style={{width: 200, height: 16}} />
          )}
          {data && (
            <button type="button" className={`mfa-btn${data.status === 'open' ? '' : ' is-ink'}`} disabled={statusBusy} onClick={() => void setStatus(data.status === 'open' ? 'closed' : 'open')}>
              {data.status === 'open' ? <Check size={15} strokeWidth={2.4} aria-hidden="true" /> : <RotateCcw size={15} strokeWidth={2.2} aria-hidden="true" />}
              {data.status === 'open' ? 'Close' : 'Reopen'}
            </button>
          )}
        </header>
        {statusError && <p className="mfa-convo-error" role="alert"><CircleAlert size={14} strokeWidth={2.2} aria-hidden="true" />{statusError}</p>}

        <div
          className="mfa-convo-scroll"
          ref={scroller}
          onScroll={event => {
            const node = event.currentTarget;
            nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          }}
        >
          {!data && query.error ? (
            <Failure error={query.error} onRetry={query.retry} />
          ) : !data ? (
            <div className="mfa-convo-loading" aria-busy="true">
              <span className="mfa-skel" style={{width: '52%', height: 54, borderRadius: 18}} />
              <span className="mfa-skel" style={{width: '38%', height: 40, borderRadius: 18, alignSelf: 'flex-end'}} />
              <span className="mfa-skel" style={{width: '60%', height: 72, borderRadius: 18}} />
            </div>
          ) : (
            <ol className="mfa-messages" aria-live="polite">
              {messages.map((message, index) => {
                const previous = messages[index - 1];
                const next = messages[index + 1];
                const newDay = !previous || moscowDay(previous.createdAt) !== moscowDay(message.createdAt);
                const grouped = previous && !newDay && previous.author === message.author && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;
                const lastOfGroup = !next || next.author !== message.author || moscowDay(next.createdAt) !== moscowDay(message.createdAt) || new Date(next.createdAt).getTime() - new Date(message.createdAt).getTime() >= 5 * 60_000;
                const context = message.author === 'user' ? contextText(message.context) : null;
                return (
                  <li key={message.id} className="mfa-message-item">
                    {newDay && <div className="mfa-day"><span>{daySeparator(message.createdAt, now)}</span></div>}
                    <div className={`mfa-message is-${message.author}${grouped ? ' is-grouped' : ''}`}>
                      <div className="mfa-bubble">{message.body}</div>
                      {(lastOfGroup || context) && (
                        <div className="mfa-message-meta">
                          {context && <span className="mfa-context">{context}</span>}
                          {lastOfGroup && <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>}
                          {message === lastOperator && seen && (
                            <span className="mfa-seen"><CheckCheck size={14} strokeWidth={2.2} aria-hidden="true" />Read</span>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {pending.map(item => (
                <li key={item.clientId} className="mfa-message-item">
                  <div className={`mfa-message is-operator is-pending${item.state === 'failed' ? ' is-failed' : ''}`}>
                    <div className="mfa-bubble">{item.body}</div>
                    <div className="mfa-message-meta">
                      {item.state === 'sending' ? (
                        <span>Sending…</span>
                      ) : (
                        <>
                          <span className="mfa-failed-text"><CircleAlert size={13} strokeWidth={2.2} aria-hidden="true" />Not sent</span>
                          <button type="button" className="mfa-retry" onClick={() => void deliver(item)}>Retry</button>
                          <button type="button" className="mfa-retry" onClick={() => setPending(list => list.filter(entry => entry.clientId !== item.clientId))}>Remove</button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        {data?.status === 'closed' && <p className="mfa-convo-note"><Lock size={13} strokeWidth={2.2} aria-hidden="true" />The conversation is closed; a reply will reopen it</p>}
        <Composer onSend={send} onTyping={typing} disabled={!data} />
      </section>
      {person && <AccountCard accountId={person.id} />}
    </div>
  );
}

/* ── The screen ───────────────────────────────────────────────────────────── */

export function Support({view}: {view: SupportView}) {
  const {recount} = useAdmin();
  const inbox = useAdminQuery<SupportInbox>(SUPPORT_API.inbox, {filter: view.filter, q: view.q || undefined}, {pollMs: SUPPORT_POLL_OPEN_MS, report: true});
  const now = useNow();
  const data = inbox.data;
  const rows = data?.rows ?? [];
  const row = view.thread ? rows.find(entry => entry.id === view.thread) ?? null : null;
  const waitingRows = rows.filter(entry => entry.waitingSince && entry.status === 'open');
  const longest = waitingRows.reduce<string | null>((oldest, entry) => (!oldest || entry.waitingSince! < oldest ? entry.waitingSince : oldest), null);

  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  });
  const onSearch = useCallback((q: string) => goAdmin(supportHash({...latest.current, q}), {replace: true}), []);
  const pokeInbox = inbox.poke;
  const onChanged = useCallback(() => {
    pokeInbox();
    recount();
  }, [pokeInbox, recount]);

  const counts = data?.counts;
  const listBody = useMemo(() => {
    if (!data && inbox.error) return <Failure error={inbox.error} onRetry={inbox.retry} compact />;
    if (!data) {
      return (
        <ul className="mfa-threads" aria-busy="true">
          {Array.from({length: 6}, (_, index) => (
            <li key={index} className="mfa-thread is-skeleton">
              <span className="mfa-skel" style={{width: 36, height: 36, borderRadius: 18}} />
              <span className="mfa-thread-main">
                <span className="mfa-skel" style={{width: '50%', height: 12}} />
                <span className="mfa-skel" style={{width: '85%', height: 10, marginTop: 8}} />
              </span>
            </li>
          ))}
        </ul>
      );
    }
    if (rows.length === 0) {
      if (view.q) {
        return (
          <div className="mfa-answered is-search">
            <span className="mfa-empty-mark" aria-hidden="true"><Search size={20} strokeWidth={1.9} /></span>
            <b>Nobody found</b>
            <span>for "{view.q}" in "{FILTER_LABEL[view.filter]}"</span>
          </div>
        );
      }
      if (view.filter === 'waiting') return <AllAnswered />;
      return (
        <div className="mfa-answered is-search">
          <span className="mfa-empty-mark" aria-hidden="true"><MessageCircle size={20} strokeWidth={1.9} /></span>
          <b>Nothing here</b>
        </div>
      );
    }
    return (
      <ul className="mfa-threads">
        {rows.map(entry => <ThreadRow key={entry.id} row={entry} view={view} active={entry.id === view.thread} now={now} />)}
      </ul>
    );
  }, [data, inbox.error, inbox.retry, rows, view, now]);

  return (
    <div className={`mfa-support${view.thread ? ' has-thread' : ''}`}>
      <PageHead
        title="Support"
        fact={
          counts ? (
            counts.waiting > 0 ? (
              <>
                <span><b>{num(counts.waiting)}</b> waiting for a reply</span>
                {longest && view.filter === 'waiting' && (
                  <>
                    <i className="mfa-dot-sep" aria-hidden="true" />
                    <span>longest wait: <b>{waitOf(longest, now).text}</b></span>
                  </>
                )}
              </>
            ) : (
              <span>All replies sent</span>
            )
          ) : undefined
        }
      />
      <div className="mfa-panes">
        <aside className="mfa-inbox" aria-label="Requests">
          <div className="mfa-inbox-tools">
            <div className="mfa-filters is-tight" role="group" aria-label="Show">
              {SUPPORT_INBOX_FILTERS.map(filter => (
                <button key={filter} type="button" aria-pressed={view.filter === filter} className={`mfa-filter${view.filter === filter ? ' is-on' : ''}`} onClick={() => goAdmin(supportHash({...view, filter, thread: view.thread}))}>
                  {FILTER_LABEL[filter]}
                  <span className={`mfa-filter-count${filter === 'waiting' && counts && counts.waiting > 0 ? ' is-hot' : ''}`}>{counts ? num(counts[filter]) : '·'}</span>
                </button>
              ))}
            </div>
            <SearchBox value={view.q} onChange={onSearch} placeholder="Name or e-mail" label="Search requests" full />
          </div>
          <div className={`mfa-inbox-list${inbox.stale ? ' mfa-stale' : ''}`}>{listBody}</div>
        </aside>
        {view.thread ? (
          <Conversation key={view.thread} id={view.thread} row={row} view={view} onChanged={onChanged} />
        ) : (
          <div className="mfa-convo-empty">
            <span className="mfa-empty-mark" aria-hidden="true"><MessageCircle size={22} strokeWidth={1.9} /></span>
            <b>Choose a conversation</b>
            <span>{counts && counts.waiting > 0 ? `${num(counts.waiting)} ${plural(counts.waiting, 'person is', 'people are')} waiting for a reply` : 'All requests are on the left'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
