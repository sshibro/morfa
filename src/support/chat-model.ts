import {SUPPORT_MESSAGE_MAX, SUPPORT_TEAM_NAME, type SupportAuthor, type SupportMessage, type SupportTeam} from '../../shared/support';

// What the support panel (SupportChat.tsx) draws, as pure functions the node tests cover: the conversation split into days
// ("Today", "Yesterday", "October 8") and runs of one side's messages, the messages still on their way merged in after the server's,
// the "Read" mark, and the composer's counter. Days and times are the person's own (the browser's time zone). And the words
// that say who answers, all from what the server measured (shared/support.ts SupportTeam): Morfa's team, never one person's name,
// presence only when it is true, a reply time only when there is one, a letter only when one will go.

/** A message written here that the server has not confirmed yet: being sent, or failed (the person may send it again). `seen`: the
 *  person's messages with the same text the panel already showed when it was written ("Thanks" twice): never this one's copy. */
export type PendingMessage = {clientId: string; body: string; createdAt: string; status: 'sending' | 'failed'; error?: string; seen?: readonly string[]};

/** One bubble: a confirmed message or a pending one. */
export type ChatBubble = {
  key: string;
  author: SupportAuthor;
  body: string;
  createdAt: string;
  pending?: PendingMessage;
};
/** Consecutive bubbles of one writer close in time: the time is printed under the last one, the avatar beside it. */
export type ChatRun = {key: string; author: SupportAuthor; bubbles: ChatBubble[]};
export type ChatDay = {key: string; label: string; runs: ChatRun[]};

/** Two messages of one side further apart than this start a new run. */
export const RUN_GAP_MS = 5 * 60_000;
/** The composer shows its counter from this length on. */
export const COUNTER_FROM = SUPPORT_MESSAGE_MAX - 500;
/** A pending message is matched to a server message with its text written at most this long before it was sent here (a send whose
 *  answer was lost arrives with the next poll). */
const MATCH_WINDOW_MS = 10 * 60_000;

const time = (iso: string) => Date.parse(iso);
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

/** "Today", "Yesterday", "October 8", and the year when it is not this one: "October 8, 2025". */
export function dayLabel(at: Date, now = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'long', ...(at.getFullYear() === now.getFullYear() ? {} : {year: 'numeric'})})
    .format(at);
}

/** "2:05 PM". */
export const timeLabel = (iso: string) => new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit'}).format(new Date(iso));

/** The pending messages the server's list does not hold yet, in the order they were written. A pending one is held when the
 *  server has the person's message with the same text, written no earlier than shortly before it, not shown before it was written
 *  and not already taken by another. */
export function unconfirmed(messages: readonly SupportMessage[], pending: readonly PendingMessage[]): PendingMessage[] {
  const taken = new Set<string>();
  return pending.filter(item => {
    const match = messages.find(
      message =>
        message.author === 'user' &&
        !taken.has(message.id) &&
        !item.seen?.includes(message.id) &&
        message.body === item.body.trim() &&
        time(message.createdAt) >= time(item.createdAt) - MATCH_WINDOW_MS,
    );
    if (!match) return true;
    taken.add(match.id);
    return false;
  });
}

/** The conversation as days of runs: the server's messages, then the pending ones (always the newest: they are written now). */
export function chatDays(messages: readonly SupportMessage[], pending: readonly PendingMessage[] = [], now = new Date()): ChatDay[] {
  const bubbles: ChatBubble[] = [
    ...messages.map(message => ({
      key: message.id,
      author: message.author,
      body: message.body,
      createdAt: message.createdAt,
    })),
    ...unconfirmed(messages, pending).map(item => ({key: 'pending:' + item.clientId, author: 'user' as const, body: item.body, createdAt: item.createdAt, pending: item})),
  ];
  const days: ChatDay[] = [];
  for (const bubble of bubbles) {
    const at = new Date(bubble.createdAt),
      key = dayKey(at);
    let day = days.at(-1);
    if (!day || day.key !== key) days.push((day = {key, label: dayLabel(at, now), runs: []}));
    const run = day.runs.at(-1),
      previous = run?.bubbles.at(-1);
    const same = run && previous && run.author === bubble.author;
    if (same && time(bubble.createdAt) - time(previous.createdAt) <= RUN_GAP_MS) run.bubbles.push(bubble);
    else day.runs.push({key: bubble.key, author: bubble.author, bubbles: [bubble]});
  }
  return days;
}

/** The person's last message carries "Read" when it is the conversation's last and the operator read past it. */
export function readMessageId(messages: readonly SupportMessage[], operatorReadAt: string | null): string | null {
  const last = messages.at(-1);
  if (!last || last.author !== 'user' || !operatorReadAt) return null;
  return time(operatorReadAt) >= time(last.createdAt) ? last.id : null;
}

/** The composer's counter near the limit ("3,812 / 4,000"), null below it. Counted as the server counts: the trimmed text. */
export function counterText(draft: string): {text: string; over: boolean} | null {
  const length = draft.trim().length;
  if (length < COUNTER_FROM) return null;
  const format = (value: number) => value.toLocaleString('en-US');
  return {text: `${format(length)} / ${format(SUPPORT_MESSAGE_MAX)}`, over: length > SUPPORT_MESSAGE_MAX};
}

/** The operator's answers that arrived since `known` (ids already shown): what the live region reads out. */
export function newOperatorMessages(messages: readonly SupportMessage[], known: ReadonlySet<string>): SupportMessage[] {
  return messages.filter(message => message.author !== 'user' && !known.has(message.id));
}

/** The quick starts of an empty conversation: what each chip puts in the composer. */
export const QUICK_STARTS = [
  {label: 'Found a bug', text: 'Hello! I think I found a bug. What happened: '},
  {label: 'Need help with a file', text: 'Hello! I need help with a file: '},
] as const;

/* ── Who answers ────────────────────────────────────────────────────────────────────────────────── */

/** A dash never starts a line (a no-break space before it), "not a bot" never splits. */
const typeset = (text: string) => text.replace(/ — /g, '\u00a0— ').replace(/ not a bot/g, ' not\u00a0a\u00a0bot');

/** Someone answers: the server has an operator (it has one whenever the chat is on). */
const staffed = (team: SupportTeam | null) => !!team?.operators.length;

/** The header: "Morfa team" and the promise that people answer. Null without an operator. */
export function teamHeadline(team: SupportTeam): {title: string; subtitle: string} | null {
  if (!staffed(team)) return null;
  return {title: SUPPORT_TEAM_NAME, subtitle: typeset('Our team will answer you — real people, not a bot')};
}

/** "Online" only while an operator has the console open; otherwise when they will answer. */
export const presenceText = (team: SupportTeam) => (team.online ? 'Online' : typeset('We are offline right now — we will reply here as soon as we are back'));

/** "~40 min", "~3 h", "~2 d" of a measured median; null without one (nothing is promised then). */
export function replyTimeText(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 10) return `~${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 55) return `~${Math.round(minutes / 5) * 5} min`;
  if (minutes < 36 * 60) return `~${Math.max(1, Math.round(minutes / 60))} h`;
  return `~${Math.round(minutes / (24 * 60))} d`;
}

/** "We usually reply within ~40 min", or null. */
export const typicalReplyText = (team: SupportTeam) => {
  const text = replyTimeText(team.typicalReplyMinutes);
  return text ? `We usually reply within ${text}` : null;
};

/** The note after the person's first message: who reads it, where the answer comes, and the letter only when one will go. */
export function receivedNote(team: SupportTeam): string {
  const answer = team.emailFollowUp ? 'The reply will appear here; if you leave, we will email you.' : 'The reply will appear here.';
  return typeset(`Message received. A person from our team will read it. ${answer}`);
}

/** "Morfa team is typing…". */
export const TEAM_TYPING = `${SUPPORT_TEAM_NAME} is typing…`;

/** The run the note follows: the first of the person's runs with a message the server holds, while no operator has answered. */
export function receivedNoteRun(days: readonly ChatDay[]): string | null {
  const runs = days.flatMap(day => day.runs);
  if (runs.some(run => run.author === 'operator')) return null;
  return runs.find(run => run.author === 'user' && run.bubbles.some(bubble => !bubble.pending))?.key ?? null;
}

/** The empty conversation's line: who will read the first message. */
export function emptyText(team: SupportTeam): string {
  if (!staffed(team)) return 'Tell us what happened or what you want to know. The reply will appear here.';
  return typeset('Describe your question in your own words — our team will read it. The reply will appear here, and the support button will show a badge.');
}
