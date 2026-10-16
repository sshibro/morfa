// The app's JSON client for /api: same-origin cookies, the account the tab acts for (X-Forma-Account), and the
// account-generation check every caller relies on: an answer that arrives after the tab switched accounts is
// dropped, never shown or saved.
import {RATE_LIMITED_MESSAGE} from '../shared/rate-limit';

/** The header the server compares with the session's account (server/design/router.ts). */
export const ACCOUNT_HEADER = 'X-Forma-Account';
/** Fired when the server says the session ended or now belongs to another account; App re-reads the session. */
export const SESSION_CHANGED_EVENT = 'forma-session-changed';

let account: string | null = null;
let generation = 0;

/** Switching accounts (or signing out) makes every request still in flight stale. */
export function setApiAccount(id: string | null) {
  account = id;
  generation++;
}
/** Account the client currently acts for; long downloads compare it before saving data. */
export const apiAccount = () => account;
/** Changes even when an account signs out and back in with the same id. */
export const apiGeneration = () => generation;

/** A proxy's own page (HTML, not our JSON) still proves the connection works; say what it means. */
const PROXY_TIMED_OUT = 'The server took too long to respond. Try again or shorten the request.';
const PROXY_UNAVAILABLE = 'The server is temporarily unavailable. Try again in a minute.';
const NO_ANSWER = 'The server did not respond. Check your connection.';
const ACCOUNT_CHANGED = 'The account was changed. Repeat the action.';
const unreadableAnswer = (status: number) => (status === 504 ? PROXY_TIMED_OUT : status === 502 || status === 503 ? PROXY_UNAVAILABLE : NO_ANSWER);

export type ApiErrorDetails = {code?: string; retryable?: boolean; fieldErrors?: Record<string, string[]>; requestId?: string; [key: string]: unknown};

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: ApiErrorDetails) {
    super(message);
  }
}

const accountHeaders = (): Record<string, string> => (account ? {[ACCOUNT_HEADER]: account} : {});

const sessionEnded = (status: number, body: {code?: unknown; error?: unknown} | null) =>
  status === 401 || (status === 409 && (body?.code === 'account_changed' || String(body?.error).startsWith('The account was changed')));

export type ApiOptions = RequestInit & {
  /** Reads the answer's JSON in place of `response.json()` (api-read.ts: whole documents, with progress and a stall
   *  deadline). Rejects as `response.json()` does: TypeError when the body stops arriving, SyntaxError when unreadable. */
  readJson?: (response: Response) => Promise<unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(url: string, {readJson, ...options}: ApiOptions = {}): Promise<T> {
  const version = generation;
  const check = () => {
    options.signal?.throwIfAborted();
    if (version !== generation) throw new ApiError(ACCOUNT_CHANGED, 409);
  };
  check();
  const isForm = options.body instanceof FormData;
  const response = await fetch('/api' + url, {
    credentials: 'same-origin',
    ...options,
    headers: {...accountHeaders(), ...(!isForm && options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers},
  }).catch(error => {
    check();
    throw error;
  });
  check();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = await (readJson ? readJson(response) : response.json());
  } catch (error) {
    // A body that stops arriving (the connection dropped after the headers) rejects with a TypeError, like a
    // failed fetch: it stays a network failure, which reads and startup retry. Unreadable JSON is a SyntaxError.
    check();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof TypeError) throw error;
    if (response.status === 429) throw new ApiError(RATE_LIMITED_MESSAGE, 429, {code: 'rate_limited'});
    throw new ApiError(unreadableAnswer(response.status), response.status);
  }
  check();
  if (account && sessionEnded(response.status, data)) window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
  if (!response.ok) throw new ApiError(data?.error || 'Could not complete the action.', response.status, data);
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const post = <T = any>(url: string, data: unknown = {}) => api<T>(url, {method: 'POST', body: JSON.stringify(data)});

/** A private upload (`/uploads/…`, owner's cookie) as a data URL, for places that cannot send the cookie themselves. */
export async function privateImageData(url: string, signal: AbortSignal): Promise<string> {
  const version = generation;
  const response = await fetch(url, {credentials: 'same-origin', headers: accountHeaders(), signal, cache: 'no-store'});
  if (!response.ok || version !== generation) throw new ApiError('The image is not available.', response.status);
  const blob = await response.blob();
  if (version !== generation) throw new ApiError('The account was changed.', 409);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (version === generation ? resolve(String(reader.result)) : reject(new Error('The account was changed.')));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
