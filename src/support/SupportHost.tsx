import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {SUPPORT_POLL_IDLE_MS} from '../../shared/support';
import {SUPPORT_CLOSE_EVENT, SUPPORT_OPEN_EVENT} from './open';
import {readSupportUnread, setSupportState} from './state';
import {supportChatOn} from './support-config';

// The support chat's host in the design area (src/design/DesignRoot.tsx renders it once, so the panel stays open from the file
// browser to a file and back). While the chat is on (/api/config `supportChat`) it listens for openSupport() and closeSupport()
// (src/support/open.ts) and keeps the unread badge fresh while the panel is closed: every SUPPORT_POLL_IDLE_MS while the tab is
// visible, and at once when it becomes visible again. The panel itself (SupportChat.tsx) is its own chunk, fetched when the browser
// is idle after the start or with the first opening; it never enters the app's first load. Closing gives the focus back to what
// opened the panel. An address with `?support=1` (the letter about an unseen answer) opens it at once.

const loadChat = () => import('./SupportChat');
/** `?support=1` in the address opens the panel (the letter's link). */
export const SUPPORT_LINK_PARAM = 'support';
const SupportChat = lazy(loadChat);
/** The panel's chunk is fetched this long after the start, so the first opening does not wait for it. */
const PRELOAD_AFTER_MS = 4000;
/** The first badge check waits for the area's own first requests. */
const FIRST_CHECK_MS = 1500;

export function SupportHost() {
  const on = supportChatOn();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setSupportState({open: false});
    const back = trigger.current;
    trigger.current = null;
    // The element that opened the panel, if it is still on the page (a menu item is not: then the page itself).
    if (back?.isConnected) back.focus({preventScroll: true});
  }, []);

  // The area closes with its account (sign-out, another account): its count goes with it.
  useEffect(() => () => setSupportState({open: false, unread: 0}), []);

  useEffect(() => {
    if (!on) return;
    const opened = () => {
      const active = document.activeElement;
      // The panel's own controls never become the trigger (a second openSupport while it is open only keeps it open).
      if (active instanceof HTMLElement && !active.closest('.mf-sc')) trigger.current = active;
      setOpen(true);
      setSupportState({open: true});
    };
    window.addEventListener(SUPPORT_OPEN_EVENT, opened);
    window.addEventListener(SUPPORT_CLOSE_EVENT, close);
    // The link of the letter about an unseen answer (server/support/follow-up.ts, `?support=1`) opens the conversation once.
    const query = new URLSearchParams(location.search);
    if (query.get(SUPPORT_LINK_PARAM) === '1') {
      query.delete(SUPPORT_LINK_PARAM);
      const search = query.toString();
      history.replaceState(history.state, '', location.pathname + (search ? '?' + search : '') + location.hash);
      opened();
    }
    const preload = window.setTimeout(() => void loadChat().catch(() => undefined), PRELOAD_AFTER_MS);
    return () => {
      window.removeEventListener(SUPPORT_OPEN_EVENT, opened);
      window.removeEventListener(SUPPORT_CLOSE_EVENT, close);
      window.clearTimeout(preload);
    };
  }, [on, close]);

  // The badge while the panel is closed (the open panel reads the whole conversation itself).
  useEffect(() => {
    if (!on || open) return;
    let controller: AbortController | null = null;
    let stopped = false;
    const check = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      controller?.abort();
      controller = new AbortController();
      readSupportUnread(controller.signal).then(
        answer => !stopped && setSupportState({unread: answer.unread}),
        () => undefined,
      );
    };
    const first = window.setTimeout(check, FIRST_CHECK_MS);
    const timer = window.setInterval(check, SUPPORT_POLL_IDLE_MS);
    const visible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [on, open]);

  if (!on || !open) return null;
  return (
    <Suspense fallback={null}>
      <SupportChat onClose={close} />
    </Suspense>
  );
}
