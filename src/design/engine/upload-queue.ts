// Pictures go to the server a few at a time (docs/design-tool.md §Server API: three picture uploads per account at once,
// 60 a minute). Dropping or placing six pictures together sent six requests and the server refused the ones past its
// three places with 429, so those pictures vanished from the canvas. The editor's uploads queue here instead: at most
// `limit` in flight, and an upload the server answers "busy" (429, retryable) waits and goes again.

export type UploadQueueOptions = {
  /** Uploads in flight at once: below the server's per-account places, so another tab's paste still gets one. */
  limit?: number;
  /** Waits before each retry of a "busy" answer; the last one repeats until `retries` run out. */
  delays?: readonly number[];
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
};

const status = (error: unknown) => (typeof error === 'object' && error !== null && typeof (error as {status?: unknown}).status === 'number' ? (error as {status: number}).status : undefined);

/** A refusal that clears up by itself: the account's places are taken, or the minute's uploads are used up. */
export const isBusy = (error: unknown) => status(error) === 429;

export type UploadQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createUploadQueue(options: UploadQueueOptions = {}): UploadQueue {
  const limit = Math.max(1, options.limit ?? 2);
  const delays = options.delays?.length ? options.delays : [600, 1_200, 2_500, 5_000, 10_000];
  const retries = options.retries ?? 8;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let running = 0;
  const waiting: (() => void)[] = [];
  const take = async () => {
    while (running >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };
  return async task => {
    await take();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await task();
        } catch (error) {
          if (!isBusy(error) || attempt >= retries) throw error;
          await sleep(delays[Math.min(attempt, delays.length - 1)]);
        }
      }
    } finally {
      release();
    }
  };
}
