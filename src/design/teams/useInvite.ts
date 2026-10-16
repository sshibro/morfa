import {useState} from 'react';
import {takeDesignInvite} from './model';

/** The invite of this page load (`?designInvite=` or the one kept over the sign-in), read and removed from the address once: StrictMode
 * renders twice and a second file browser must not ask again. */
let taken: string | null | undefined;
function takeOnce(): string | null {
  if (taken === undefined) {
    let storage: Storage | null = null;
    try {
      storage = typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
      storage = null;
    }
    const found = typeof location === 'undefined' ? {token: null, search: null} : takeDesignInvite(location.search, storage);
    if (found.search !== null) history.replaceState(history.state, '', location.pathname + found.search + location.hash);
    taken = found.token;
  }
  return taken;
}

/** The invite to show over the file browser, and the way to dismiss it: dismissed or joined, it stays gone when the browser mounts again
 *  (back from a file) in the same page load. */
export function useInviteToken() {
  const [token, setToken] = useState<string | null>(takeOnce);
  return {
    token,
    clear: () => {
      taken = null;
      setToken(null);
    },
  };
}
