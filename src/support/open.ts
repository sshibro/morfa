import type {SupportContext} from '../../shared/support';
import {designIdFromHash} from '../navigation';

// The way into the support chat from anywhere in the app: the help command (src/design/engine/commands/help.ts) when readSupportConfig
// says the chat is on, the file browser's support button. SupportHost (src/support/SupportHost.tsx, inside the design area) listens
// and opens the panel. Where the person is (the open file and its kind) is registered by the screen that knows it and attached to
// each message they send (SupportContext), so the operator sees it beside the message.

export type SupportSource = 'help' | 'button';
export type SupportRequest = {projectId?: string | null; source?: SupportSource};

export const SUPPORT_OPEN_EVENT = 'morfa:support-open';
export const SUPPORT_CLOSE_EVENT = 'morfa:support-close';

export function openSupport(request: SupportRequest = {}) {
  window.dispatchEvent(new CustomEvent<SupportRequest>(SUPPORT_OPEN_EVENT, {detail: request}));
}

export function closeSupport() {
  window.dispatchEvent(new Event(SUPPORT_CLOSE_EVENT));
}

let place: SupportContext | null = null;

/** The editor registers its file while it is open (and takes it back on leaving); the file browser needs nothing. */
export function setSupportPlace(next: SupportContext | null): () => void {
  place = next;
  return () => {
    if (place === next) place = null;
  };
}

/** Where a message is written from now: the registered file, else the file the address names (the player is "other"), else the
 *  file browser. */
export function supportPlace(hash = typeof location === 'undefined' ? '' : location.hash): SupportContext {
  if (place) return place;
  const fileId = designIdFromHash(hash);
  if (fileId) return {fileId, where: /[?&]present=/.test(hash) ? 'other' : 'editor'};
  return {where: 'files'};
}
