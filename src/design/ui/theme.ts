import {useSyncExternalStore} from 'react';

// The tool follows the system's light or dark appearance unless the designer picks one
// ("View → Theme"). The choice is a per-browser convenience, so it lives in localStorage and the
// page works the same when storage is blocked.

export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'morfa-design-theme';
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

let preference: ThemePreference | null = null;
const currentPreference = () => (preference ??= readPreference());

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked: the choice holds for this visit.
  }
  listeners.forEach(listener => listener());
}

const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);

function subscribe(listener: () => void) {
  listeners.add(listener);
  const query = darkQuery();
  query?.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    query?.removeEventListener('change', listener);
  };
}

const resolve = (): Theme => {
  const chosen = currentPreference();
  if (chosen !== 'system') return chosen;
  return darkQuery()?.matches ? 'dark' : 'light';
};

export const useThemePreference = () => useSyncExternalStore(subscribe, currentPreference, () => 'system' as ThemePreference);
export const useResolvedTheme = () => useSyncExternalStore(subscribe, resolve, () => 'light' as Theme);

export const THEME_LABELS: Record<ThemePreference, string> = {system: 'System', light: 'Light', dark: 'Dark'};
