import {useSyncExternalStore} from 'react';

// One answer to "is this a phone?" for the whole tool. Width alone decides: a narrow desktop window
// gets the phone layout too. Stylesheets write the same number: `@media (max-width: 767px)`.
//
// The second answer, "is this a tablet?": a touch screen from 768 to
// 1023 px keeps the desktop layout with its side panels folded (src/design/editor/tablet/). A mouse at that width, and any
// screen above it, is a desktop. Stylesheets write `@media (min-width: 768px) and (max-width: 1023px) and (pointer: coarse)`.

export const PHONE_MAX_WIDTH = 767;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

export const TABLET_MAX_WIDTH = 1023;
export const TABLET_QUERY = `(min-width: ${PHONE_MAX_WIDTH + 1}px) and (max-width: ${TABLET_MAX_WIDTH}px) and (pointer: coarse)`;

const phoneQuery = () => (typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null);

function subscribe(listener: () => void) {
  const query = phoneQuery();
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

/** True on a phone-width screen; false wherever the browser cannot say (the server, a test without a window). */
export const isPhone = (): boolean => phoneQuery()?.matches ?? false;

const notOnServer = () => false;

/** `isPhone`, followed as the window is resized or the phone is turned. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, notOnServer);
}

const tabletQuery = () => (typeof matchMedia === 'function' ? matchMedia(TABLET_QUERY) : null);

function subscribeTablet(listener: () => void) {
  const query = tabletQuery();
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

/** True on a touch screen 768–1023 px wide; false wherever the browser cannot say. */
export const isTablet = (): boolean => tabletQuery()?.matches ?? false;

/** `isTablet`, followed as the window is resized or the tablet is turned. */
export function useTablet(): boolean {
  return useSyncExternalStore(subscribeTablet, isTablet, notOnServer);
}
