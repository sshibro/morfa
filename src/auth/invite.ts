import {DESIGN_INVITE_PARAM, DESIGN_INVITE_STORAGE_KEY, DESIGN_INVITE_TOKEN} from '../../shared/design/teams';

const addressQuery = () => (typeof location === 'undefined' ? '' : location.search);

/** This tab's own storage, or null where the browser refuses it (private modes, a blocked site). */
export function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** An invite link opened signed out: the address keeps the token, and the design area takes it after the sign-in. The tab keeps it
 *  too, in case the address is rewritten before then (src/design/teams/model.ts takeDesignInvite reads both). Says whether this
 *  visit carries an invite. */
export function rememberInvite(search: string = addressQuery(), storage: Storage | null = tabStorage()): boolean {
  const token = new URLSearchParams(search).get(DESIGN_INVITE_PARAM);
  if (!token || !DESIGN_INVITE_TOKEN.test(token)) return false;
  try {
    storage?.setItem(DESIGN_INVITE_STORAGE_KEY, token);
  } catch {
    // A full or refused storage: the address alone carries it.
  }
  return true;
}
