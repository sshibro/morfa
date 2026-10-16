import {createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {api, ApiError} from '../api';
import {readApi} from '../api-read';

// The console's one way to read: GET /api/admin/* through readApi (bounded retries for reads), aborted when the address changes or the
// screen goes. While a new answer is on its way the previous one for the same path stays on screen (`stale`), so a period switch keeps
// the frame instead of flashing skeletons. The top bar's refresh reads every query on the screen again. A query may also poll (the
// support inbox): a poll is silent, it never dims what is on screen, and it waits while the tab is hidden.

export type AdminStatus = {loading: boolean; at: number | null};

export type AdminContextValue = {
  /** Bumped by the top bar's refresh. */
  refreshToken: number;
  refresh: () => void;
  /** The screen's main query tells the top bar when its data was read and whether a read is running. */
  report: (status: AdminStatus) => void;
  /** Support conversations waiting for an answer (the rail's badge), null until read. */
  waiting: number | null;
  /** Read the waiting count again now (after an answer, a read, a close). */
  recount: () => void;
};

export const AdminContext = createContext<AdminContextValue>({refreshToken: 0, refresh: () => undefined, report: () => undefined, waiting: null, recount: () => undefined});
export const useAdmin = () => useContext(AdminContext);

export type QueryParams = Record<string, string | number | null | undefined>;

export type AdminQuery<T> = {
  data: T | null;
  error: Error | null;
  /** A read is running (the first, or one that will replace `data`); polls do not count. */
  loading: boolean;
  /** `data` answers other parameters than the current ones (a new period is loading). */
  stale: boolean;
  /** When `data` arrived. */
  at: number | null;
  retry: () => void;
  /** Read again quietly, as a poll does (after a write that changed it). */
  poke: () => void;
  /** Put an answer in place (a write that answers the whole object). */
  replace: (data: T) => void;
};

type Held<T> = {path: string; key: string; data: T | null; error: Error | null; loading: boolean; at: number | null};

export function queryString(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(name, String(value));
  }
  const text = search.toString();
  return text ? '?' + text : '';
}

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
/** The tab is in front. */
export const useVisible = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible', () => true);

/** A tick every `ms` while the tab is visible (null: never); coming back to the tab ticks at once. */
export function usePoll(ms: number | null): number {
  const visible = useVisible();
  const [tick, setTick] = useState(0);
  const [wasHidden, setWasHidden] = useState(false);
  useEffect(() => {
    if (!ms) return;
    if (!visible) {
      setWasHidden(true);
      return;
    }
    if (wasHidden) {
      setWasHidden(false);
      setTick(count => count + 1);
    }
    const timer = setInterval(() => setTick(count => count + 1), ms);
    return () => clearInterval(timer);
  }, [ms, visible, wasHidden]);
  return tick;
}

type QueryOptions = {report?: boolean; pollMs?: number | null; enabled?: boolean};

export function useAdminQuery<T>(path: string, params: QueryParams = {}, {report = false, pollMs = null, enabled = true}: QueryOptions = {}): AdminQuery<T> {
  const {refreshToken, report: reportStatus} = useAdmin();
  const [attempt, setAttempt] = useState(0);
  const [poked, setPoked] = useState(0);
  const key = path + queryString(params);
  const [held, setHeld] = useState<Held<T>>({path, key, data: null, error: null, loading: enabled, at: null});
  const tick = usePoll(enabled ? pollMs : null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setHeld(previous => ({
      path,
      key,
      // Another path (another account) never shows the last one's numbers.
      data: previous.path === path ? previous.data : null,
      error: null,
      loading: true,
      at: previous.path === path ? previous.at : null,
    }));
    readApi<T>(key, {signal: controller.signal, timeoutMs: 20_000}).then(
      data => {
        if (!controller.signal.aborted) setHeld({path, key, data, error: null, loading: false, at: Date.now()});
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setHeld(previous => ({...previous, error: error instanceof Error ? error : new Error(String(error)), loading: false}));
      },
    );
    return () => controller.abort();
  }, [path, key, refreshToken, attempt, enabled]);

  // A poll: the same read, quietly; a failed poll keeps what is on screen.
  useEffect(() => {
    if (!enabled || (tick === 0 && poked === 0)) return;
    const controller = new AbortController();
    readApi<T>(key, {signal: controller.signal, timeoutMs: 20_000, retryDelays: []}).then(
      data => {
        if (!controller.signal.aborted) setHeld(previous => (previous.key === key && !previous.loading ? {...previous, data, error: null, at: Date.now()} : previous));
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [tick, poked, key, enabled]);

  useEffect(() => {
    if (report) reportStatus({loading: held.loading, at: held.at});
  }, [report, reportStatus, held.loading, held.at]);

  const retry = useCallback(() => setAttempt(count => count + 1), []);
  const poke = useCallback(() => setPoked(count => count + 1), []);
  const replace = useCallback((data: T) => setHeld(previous => ({...previous, data, error: null, loading: false, at: Date.now()})), []);
  return useMemo(() => ({
    data: held.data,
    error: held.error,
    loading: held.loading,
    stale: held.data !== null && (held.loading || held.key !== key),
    at: held.at,
    retry,
    poke,
    replace,
  }), [held, key, retry, poke, replace]);
}

/** A write to /api/admin/*: JSON in, JSON (or nothing: 204) out. Never retried automatically; the caller offers the retry. */
export function adminWrite<T>(path: string, body: unknown): Promise<T | null> {
  return api<T | null>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    readJson: async response => (response.status === 204 ? null : response.text().then(text => (text ? JSON.parse(text) : null))),
  });
}

/** What a failure says, and the ids that let the server's log find it. */
export function failureOf(error: Error): {message: string; status: number | null; requestId: string | null} {
  if (error instanceof ApiError) {
    const requestId = typeof error.details?.requestId === 'string' ? error.details.requestId : null;
    return {message: error.message, status: error.status, requestId};
  }
  return {message: error.message || 'Could not load the data.', status: null, requestId: null};
}
