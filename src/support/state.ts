import {useSyncExternalStore} from 'react';
import {api} from '../api';
import {readApi} from '../api-read';
import {SUPPORT_API, type SupportContext, type SupportThreadView, type SupportUnread} from '../../shared/support';

// The support chat's state the whole design area shares: whether the panel is open (the support button's pressed state) and how
// many of the operator's messages the person has not seen (the badges on the file browser's button and the editor's help menu).
// SupportHost keeps the count fresh while the panel is closed; the panel sets it from each answer it gets. The API's calls live
// here too, so the badge and the panel speak to /api/support the same way.

export type SupportState = {open: boolean; unread: number};

let state: SupportState = {open: false, unread: 0};
const listeners = new Set<() => void>();

export const supportState = (): SupportState => state;

export function setSupportState(patch: Partial<SupportState>) {
  const next = {...state, ...patch};
  if (next.open === state.open && next.unread === state.unread) return;
  state = next;
  listeners.forEach(listener => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useSupportState = (): SupportState => useSyncExternalStore(subscribe, supportState, supportState);

/** Tests start from a clean state. */
export const resetSupportState = () => setSupportState({open: false, unread: 0});

/* ── /api/support ─────────────────────────────────────────────────────────────────────────────────── */

// Every request has a deadline: a dead connection never leaves a message "Sending…" or the panel's polling waiting on it. A
// send that timed out reads as failed and may go again (its key makes the server keep one copy).
const SEND_DEADLINE_MS = 30_000;
export const readSupportThread = (signal?: AbortSignal) => readApi<SupportThreadView>(SUPPORT_API.thread, {signal, retryDelays: []});
export const readSupportUnread = (signal?: AbortSignal) => api<SupportUnread>(SUPPORT_API.unread, {signal});
export const sendSupportMessage = (body: string, clientId: string, context: SupportContext) =>
  api<SupportThreadView>(SUPPORT_API.messages, {method: 'POST', body: JSON.stringify({body, clientId, context}), signal: AbortSignal.timeout(SEND_DEADLINE_MS)});
export const markSupportRead = () => api<unknown>(SUPPORT_API.read, {method: 'POST', body: '{}', readJson: () => Promise.resolve(null)});
/** A key for one message: the same key again is the same message on the server, so a retry never sends it twice. */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // An insecure context (a LAN address in development) has no randomUUID; the same 122 bits from getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
