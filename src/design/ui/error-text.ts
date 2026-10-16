import {useEffect, useState} from 'react';

// What the shell says when an action fails. The browser's own words for a lost connection ("Failed to fetch",
// "Load failed", "NetworkError …") say nothing to a person: a request that never reached the server reads as
// "No internet connection…"; the server's answers are whole sentences and are shown as they are; any other message (an engine's
// "x is undefined", "Internal Server Error") gives way to the place's own fallback.

export const OFFLINE_TEXT = 'No internet connection. Check your network and try again.';

// A sentence for a person: starts with a capital letter and ends with a full stop (or ! ? …).
const SENTENCE = /^[A-Z][\s\S]*[.!?…]$/;

/** The text to show for `error`; `fallback` names what failed ("Could not create the file."). */
export function errorText(error: unknown, fallback = 'Could not complete the action.'): string {
  const unreached = error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
  if (unreached || (typeof navigator !== 'undefined' && navigator.onLine === false)) return OFFLINE_TEXT;
  if (error instanceof Error && SENTENCE.test(error.message.trim())) return error.message;
  return fallback;
}

/** False while the browser says it has no network; follows its "online" and "offline" events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
