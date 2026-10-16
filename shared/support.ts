/* Support chat: one conversation per account with the operator. The person writes from the app ("Help ▸ Contact
 * support", the file browser's help button); the operator answers from the console (#admin/support). Server:
 * server/support/*; the person's side GET/POST /api/support/*, the operator's /api/admin/support/* (operators only, the
 * console's plain 404 for anyone else). Messages are plain text (no HTML, no markdown), personal data: they go with the
 * account when it is erased. Instants are UTC ISO strings. Both sides poll; nothing streams. */

import {PRODUCT_NAME} from './design/product';

/** The longest message, in characters (after trimming). */
export const SUPPORT_MESSAGE_MAX = 4000;
/** Messages a thread answer carries: the newest ones, oldest first. */
export const SUPPORT_MESSAGES_PAGE = 200;
/** How often an open chat asks for news (the person's panel and the operator's conversation), and how often a closed one checks its
 *  unread count. */
export const SUPPORT_POLL_OPEN_MS = 5_000;
export const SUPPORT_POLL_IDLE_MS = 60_000;
/** An operator is "Online" while they used the console's support routes this recently (stored, so every API process agrees). */
export const SUPPORT_ONLINE_WINDOW_MS = 3 * 60_000;
/** The operator's composer says "typing" at most this often while they type (POST SUPPORT_API.typing); the person's panel shows
 *  "typing…" until this long after the last call, unless an answer comes first. */
export const SUPPORT_TYPING_PING_MS = 3_000;
export const SUPPORT_TYPING_MS = 6_000;
/** "We usually reply within …": the median wait for an answer over this many days, shown only from this many answers on. */
export const SUPPORT_REPLY_STATS_DAYS = 30;
export const SUPPORT_REPLY_STATS_MIN = 5;
/** An answer the person has not seen this long after it came is e-mailed to them, at most one letter per conversation per
 *  SUPPORT_FOLLOW_UP_EVERY_MS (and only for answers newer than the last letter). */
export const SUPPORT_FOLLOW_UP_AFTER_MS = 10 * 60_000;
export const SUPPORT_FOLLOW_UP_EVERY_MS = 60 * 60_000;

export type SupportAuthor = 'user' | 'operator';
/** `authorName`: on an operator's message in the console, the name of the operator who wrote it (their account's name), absent when
 *  unknown; never on the person's side, which reads the team's answers (SupportTeam). */
export type SupportMessage = {
  id: string;
  author: SupportAuthor;
  body: string;
  createdAt: string;
  authorName?: string;
};
/** open: a conversation that runs; closed: the operator closed it (the person's next message opens it again). */
export type SupportThreadStatus = 'open' | 'closed';

/** Where the person wrote from, attached to their message so the operator sees it: the file open at the time, the screen. */
export type SupportContext = {fileId?: string; where?: 'editor' | 'board' | 'files' | 'other'};

/* ── The person's side ─────────────────────────────────────────────────────────────────────────────── */

/** Who answers, as the person sees it: the operators, never one of them by name. */
export const SUPPORT_TEAM_NAME = `${PRODUCT_NAME} team`;

/** Who answers, as the person sees them: Morfa's team (SUPPORT_TEAM_NAME), real people, never one of them by name (owner's call,
 *  2026-10-12). `operators`: one entry, the team, while MORFA_OPERATORS names an operator,
 *  none otherwise (a list with a name, so a tab still open from an earlier release reads it). `online`: an operator used the
 *  console within SUPPORT_ONLINE_WINDOW_MS.
 *  `typicalReplyMinutes`: the median wait for an answer (SUPPORT_REPLY_STATS_*), null without enough answers: never a promise made
 *  up. `emailFollowUp`: an unseen answer will be e-mailed to this person (mail is configured and their address can receive it). */
export type SupportTeam = {
  operators: Array<{name: string}>;
  online: boolean;
  typicalReplyMinutes: number | null;
  emailFollowUp: boolean;
};

/** GET /api/support — the account's conversation, null before its first message. */
export type SupportThreadView = {
  enabled: boolean;
  team: SupportTeam;
  /** An operator is typing an answer to this conversation now (SUPPORT_TYPING_MS). */
  operatorTyping: boolean;
  thread: {
    id: string;
    status: SupportThreadStatus;
    messages: SupportMessage[];
    /** Operator messages the person has not seen. */
    unread: number;
    /** When the operator last read the conversation (the "read" mark under the person's messages), null when never. */
    operatorReadAt: string | null;
  } | null;
};
/** GET /api/support/unread — the help button's badge. */
export type SupportUnread = {unread: number};
/** POST /api/support/messages — `clientId` makes a retry safe (one message per account and key). Answers the whole view. */
export type SupportSendInput = {body: string; clientId: string; context?: SupportContext};
/** POST /api/support/read — the person has seen everything up to now. 204. */

/* ── The operator's side ───────────────────────────────────────────────────────────────────────────── */

export const SUPPORT_INBOX_FILTERS = ['waiting', 'open', 'closed', 'all'] as const;
/** waiting: open, and the person waits for an answer; open: every open one; closed; all. */
export type SupportInboxFilter = (typeof SUPPORT_INBOX_FILTERS)[number];

export type SupportInboxRow = {
  id: string;
  account: {id: string; name: string; email: string};
  status: SupportThreadStatus;
  last: {author: SupportAuthor; body: string; createdAt: string};
  /** The person's messages the operator has not read. */
  unread: number;
  /** The first of the person's messages after the operator's last answer, while the conversation is open: how long they wait. */
  waitingSince: string | null;
  updatedAt: string;
};
/** GET /api/admin/support/threads?filter=&q= (filter 'waiting' by default; q matches the name or e-mail). Rows: waiting longest
 *  first for 'waiting', newest first otherwise; at most 100. */
export type SupportInbox = {rows: SupportInboxRow[]; counts: Record<SupportInboxFilter, number>};

/** GET /api/admin/support/threads/:id — one conversation; 404 for an unknown one. */
export type SupportConversation = {
  id: string;
  status: SupportThreadStatus;
  account: {id: string; name: string; email: string};
  messages: Array<SupportMessage & {context?: SupportContext}>;
  /** When the person last read it, null when never: the "read" mark under the operator's messages. */
  userReadAt: string | null;
};
/** POST /api/admin/support/threads/:id/messages {body, clientId} — answers the conversation. Writing to a closed one opens it. */
export type SupportReplyInput = {body: string; clientId: string};
/** POST /api/admin/support/threads/:id/status {status} — answers the conversation. */
export type SupportStatusInput = {status: SupportThreadStatus};
/** POST /api/admin/support/threads/:id/read — the operator has seen it. 204. */
/** POST /api/admin/support/threads/:id/typing — the operator is typing an answer (at most every SUPPORT_TYPING_PING_MS while they
 *  type; the person sees "typing…" for SUPPORT_TYPING_MS after the last call). 204; 404 for an unknown conversation. */
/** GET /api/admin/support/unread — the console rail's badge: conversations waiting for an answer. */
export type SupportWaiting = {waiting: number};

export const SUPPORT_API = {
  thread: '/support',
  unread: '/support/unread',
  messages: '/support/messages',
  read: '/support/read',
  inbox: '/admin/support/threads',
  conversation: (id: string) => `/admin/support/threads/${encodeURIComponent(id)}`,
  reply: (id: string) => `/admin/support/threads/${encodeURIComponent(id)}/messages`,
  status: (id: string) => `/admin/support/threads/${encodeURIComponent(id)}/status`,
  operatorRead: (id: string) => `/admin/support/threads/${encodeURIComponent(id)}/read`,
  typing: (id: string) => `/admin/support/threads/${encodeURIComponent(id)}/typing`,
  waiting: '/admin/support/unread',
} as const;
