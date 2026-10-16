import {ACCOUNT_HEADER, api, apiAccount, ApiError, apiGeneration} from './api';

/** How much of a long answer has arrived: `loaded` bytes as they came off the wire (decoded), `total` when the server said
 *  how long the answer is and sent it uncompressed (a compressed answer's Content-Length counts other bytes), else null. */
export type ReadProgress = {loaded: number; total: number | null};

type ReadOptions = {
  signal?: AbortSignal;
  /** Until the answer's headers arrive; without `stallMs`, until the whole answer is read. */
  timeoutMs?: number;
  retryDelays?: readonly number[];
  /** Whole documents (tens of MB over a slow link): once the headers are in, no fixed deadline while bytes keep arriving;
   *  the read gives up only when nothing arrived for this long. */
  stallMs?: number;
  onProgress?: (progress: ReadProgress) => void;
};
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);
const TIMED_OUT = 'The server is taking too long to respond. Try again.';
const STALLED = 'The file stopped loading: the connection was interrupted. Check your connection and try again.';

function pause(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, {once: true});
  });
}

/** The answer's JSON read chunk by chunk: `alive` after every chunk (the stall deadline moves), progress as it goes. The text
 *  is decoded as it arrives, so only the parse waits for the last byte (the browser's JSON.parse is not incremental). */
async function readJsonWithProgress(response: Response, signal: AbortSignal, alive: () => void, onProgress?: (progress: ReadProgress) => void): Promise<unknown> {
  if (!response.body) return response.json();
  const length = Number(response.headers.get('content-length'));
  const total = response.headers.get('content-encoding') || !Number.isFinite(length) || length <= 0 ? null : length;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let loaded = 0;
  // An abort (the stall deadline, the caller) ends a read that waits on the network: the body does not always end with it.
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener('abort', cancel, {once: true});
  alive();
  for (;;) {
    const {done, value} = await reader.read().finally(() => signal.throwIfAborted());
    if (done) break;
    alive();
    loaded += value.byteLength;
    parts.push(decoder.decode(value, {stream: true}));
    onProgress?.({loaded, total});
  }
  signal.removeEventListener('abort', cancel);
  parts.push(decoder.decode());
  return JSON.parse(parts.join(''));
}

/** Bounded recovery for reads only. Writes must never be replayed automatically. */
export async function readApi<T>(url: string, {signal, timeoutMs = 10_000, retryDelays = [300, 900], stallMs, onProgress}: ReadOptions = {}): Promise<T> {
  const version = apiGeneration();
  const check = () => {
    signal?.throwIfAborted();
    if (version !== apiGeneration()) throw new ApiError('The account was changed. Repeat the action.', 409);
  };
  for (let attempt = 0; ; attempt++) {
    check();
    const controller = new AbortController();
    const abort = () => controller.abort(signal!.reason);
    signal?.addEventListener('abort', abort, {once: true});
    const expire = (message: string) => () => controller.abort(new DOMException(message, 'TimeoutError'));
    let timer = setTimeout(expire(TIMED_OUT), timeoutMs);
    // Each chunk of the body pushes the deadline `stallMs` further: a slow link that keeps delivering is never cut off.
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(expire(STALLED), stallMs);
    };
    try {
      const result = await api<T>(url, {signal: controller.signal, ...(stallMs ? {readJson: (response: Response) => readJsonWithProgress(response, controller.signal, alive, onProgress)} : {})});
      check();
      return result;
    } catch (error) {
      check();
      const reason = controller.signal.aborted ? controller.signal.reason : null;
      const timeout = reason instanceof DOMException && reason.name === 'TimeoutError';
      const retryable = timeout || error instanceof TypeError || error instanceof ApiError && TRANSIENT_STATUSES.has(error.status);
      if (!retryable || attempt >= retryDelays.length) {
        if (timeout) throw new ApiError(reason.message, 408);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    await pause(retryDelays[attempt], signal);
  }
}

/** A binary answer read whole, with `readApi`'s rules: the account
 *  generation check, a deadline for the headers, then a stall deadline while bytes arrive, progress, bounded retries of transient
 *  failures. The browser undoes the answer's Content-Encoding itself. An error answer's JSON becomes an ApiError with its details
 *  (`code`, …), so the caller can fall back. */
export async function readApiBytes(
  url: string,
  {signal, timeoutMs = 30_000, stallMs = 15_000, retryDelays = [300, 900], onProgress}: Omit<ReadOptions, 'stallMs'> & {stallMs?: number} = {},
): Promise<{bytes: Uint8Array<ArrayBuffer>; headers: Headers}> {
  const version = apiGeneration();
  const check = () => {
    signal?.throwIfAborted();
    if (version !== apiGeneration()) throw new ApiError('The account was changed. Repeat the action.', 409);
  };
  for (let attempt = 0; ; attempt++) {
    check();
    const controller = new AbortController();
    const abort = () => controller.abort(signal!.reason);
    signal?.addEventListener('abort', abort, {once: true});
    const expire = (message: string) => () => controller.abort(new DOMException(message, 'TimeoutError'));
    let timer = setTimeout(expire(TIMED_OUT), timeoutMs);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(expire(STALLED), stallMs);
    };
    try {
      const account = apiAccount();
      const response = await fetch('/api' + url, {credentials: 'same-origin', signal: controller.signal, headers: account ? {[ACCOUNT_HEADER]: account} : {}});
      check();
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {error?: string; code?: string} | null;
        check();
        throw new ApiError(data?.error || 'Could not complete the action.', response.status, data ?? undefined);
      }
      const bytes = await readBytes(response, controller.signal, alive, onProgress);
      check();
      return {bytes, headers: response.headers};
    } catch (error) {
      check();
      const reason = controller.signal.aborted ? controller.signal.reason : null;
      const timeout = reason instanceof DOMException && reason.name === 'TimeoutError';
      const retryable = timeout || error instanceof TypeError || error instanceof ApiError && TRANSIENT_STATUSES.has(error.status);
      if (!retryable || attempt >= retryDelays.length) {
        if (timeout) throw new ApiError(reason.message, 408);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    await pause(retryDelays[attempt], signal);
  }
}

/** The body's bytes, chunk by chunk (the stall deadline moves with each), into one buffer: grown by doubling when the length is
 *  not known (a compressed answer). */
async function readBytes(response: Response, signal: AbortSignal, alive: () => void, onProgress?: (progress: ReadProgress) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const length = Number(response.headers.get('content-length'));
  const total = response.headers.get('content-encoding') || !Number.isFinite(length) || length <= 0 ? null : length;
  let buffer = new Uint8Array(total ?? 1 << 20);
  let loaded = 0;
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener('abort', cancel, {once: true});
  alive();
  try {
    for (;;) {
      const {done, value} = await reader.read().finally(() => signal.throwIfAborted());
      if (done) break;
      alive();
      if (loaded + value.byteLength > buffer.byteLength) {
        const grown = new Uint8Array(Math.max(buffer.byteLength * 2, loaded + value.byteLength));
        grown.set(buffer.subarray(0, loaded));
        buffer = grown;
      }
      buffer.set(value, loaded);
      loaded += value.byteLength;
      onProgress?.({loaded, total});
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return loaded === buffer.byteLength ? buffer : buffer.slice(0, loaded);
}
