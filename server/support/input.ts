import {
  SUPPORT_INBOX_FILTERS,
  SUPPORT_MESSAGE_MAX,
  type SupportContext,
  type SupportInboxFilter,
  type SupportThreadStatus,
} from '../../shared/support';

// What the support routes accept (shared/support.ts), read by hand so each refusal says what to fix: a message is plain text, trimmed
// and stored as written (never HTML: nothing renders it as markup); an empty one or one past SUPPORT_MESSAGE_MAX is 422 in Russian,
// a malformed request 400.

export class SupportInputError extends Error {
  constructor(
    public status: 400 | 422,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (): never => {
  throw new SupportInputError(400, 'invalid_request', 'Check the request data.');
};

const CLIENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PLACES = new Set<NonNullable<SupportContext['where']>>(['editor', 'board', 'files', 'other']);
/** The longest search the inbox takes. */
export const SUPPORT_SEARCH_MAX = 100;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : invalid();

/** The message's text: NUL characters (which PostgreSQL text cannot hold) dropped, then trimmed; counted in UTF-16 units, as the
 *  composer counts them, which is never fewer than the characters the database's CHECK counts. */
export function messageBody(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  const body = value.replaceAll('\u0000', '').trim();
  if (!body) throw new SupportInputError(422, 'empty_message', 'Write a message.');
  if (body.length > SUPPORT_MESSAGE_MAX)
    throw new SupportInputError(
      422,
      'message_too_long',
      `The message is longer than ${SUPPORT_MESSAGE_MAX.toLocaleString('en-US')} characters. Shorten it or split it into several.`,
    );
  return body;
}

/** Where the person wrote from; anything unknown is dropped rather than refused (an older or newer app may send more). */
export function messageContext(value: unknown): SupportContext | null {
  if (value === undefined || value === null) return null;
  const source = record(value);
  const context: SupportContext = {};
  if (typeof source.fileId === 'string' && FILE_ID.test(source.fileId)) context.fileId = source.fileId;
  if (typeof source.where === 'string' && PLACES.has(source.where as NonNullable<SupportContext['where']>))
    context.where = source.where as SupportContext['where'];
  return Object.keys(context).length ? context : null;
}

export type MessageInput = {body: string; clientId: string; context: SupportContext | null};

/** POST /api/support/messages and the operator's reply: the body, the sender's key for the message, and (the person's only) where. */
export function messageInput(value: unknown, {withContext}: {withContext: boolean}): MessageInput {
  const source = record(value);
  const clientId = typeof source.clientId === 'string' && CLIENT_ID.test(source.clientId) ? source.clientId : invalid();
  return {body: messageBody(source.body), clientId, context: withContext ? messageContext(source.context) : null};
}

export function threadStatus(value: unknown): SupportThreadStatus {
  const status = record(value).status;
  return status === 'open' || status === 'closed' ? status : invalid();
}

/** A conversation's id from the address; null for anything that cannot be one (the route answers 404). */
export const threadId = (value: unknown): string | null =>
  typeof value === 'string' && THREAD_ID.test(value) ? value : null;

/** ?filter= ('waiting' when absent) and ?q= (trimmed; empty means no search). */
export function inboxQuery(query: Record<string, unknown>): {filter: SupportInboxFilter; q: string | null} {
  const rawFilter = query.filter ?? 'waiting';
  const filter = (SUPPORT_INBOX_FILTERS as readonly unknown[]).includes(rawFilter)
    ? (rawFilter as SupportInboxFilter)
    : invalid();
  if (query.q !== undefined && typeof query.q !== 'string') return invalid();
  const q = (query.q ?? '').replaceAll('\u0000', '').trim().slice(0, SUPPORT_SEARCH_MAX);
  return {filter, q: q || null};
}
