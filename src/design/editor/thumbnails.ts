import type {DesignDocument} from '../../../shared/design/types';

// The file card's picture (PUT /api/design-files/:id/thumbnail) follows the work: after an edit,
// once the designer has paused for a few seconds and at most once a minute, the first page is
// painted small and uploaded. Leaving the editor sends a last one when edits are still unpictured.
// Painting and uploading are injected, so node tests drive it with a fake clock.

export type ThumbnailTimers = {setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void};

export type ThumbnailSchedulerOptions = {
  /** The document to picture (read when the picture is taken, not when the edit happened). */
  getDoc: () => DesignDocument;
  render: (doc: DesignDocument) => Promise<Blob>;
  upload: (image: Blob) => Promise<unknown>;
  /** Quiet time after the last edit. Default 3 s. */
  idleMs?: number;
  /** Least time between two uploads. Default 60 s. */
  minIntervalMs?: number;
  timers?: ThumbnailTimers;
  now?: () => number;
};

export type ThumbnailScheduler = {
  /** The document changed. */
  noteEdit(): void;
  /** Pictures the file now if it changed since the last picture (leaving the editor). Never rejects. */
  flush(): Promise<void>;
  /** Edits since the last picture. */
  readonly dirty: boolean;
  dispose(): void;
};

export function createThumbnailScheduler(options: ThumbnailSchedulerOptions): ThumbnailScheduler {
  const idleMs = options.idleMs ?? 3_000,
    minIntervalMs = options.minIntervalMs ?? 60_000,
    timers: ThumbnailTimers = options.timers ?? {setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: handle => globalThis.clearTimeout(handle as number)},
    now = options.now ?? Date.now;
  let dirty = false,
    timer: unknown = null,
    lastUpload = -Infinity,
    running: Promise<void> | null = null,
    disposed = false;

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  /** Waits for the quiet time, then for the minute since the last upload to pass. */
  function schedule() {
    clear();
    if (disposed || !dirty) return;
    timer = timers.setTimeout(() => {
      timer = null;
      const wait = lastUpload + minIntervalMs - now();
      if (wait > 0) {
        timer = timers.setTimeout(() => {
          timer = null;
          void take();
        }, wait);
        return;
      }
      void take();
    }, idleMs);
  }

  function take(): Promise<void> {
    if (running) return running;
    if (disposed || !dirty) return Promise.resolve();
    dirty = false;
    lastUpload = now();
    running = (async () => {
      try {
        // A picture started before `dispose` (the last one, on leaving) still goes up.
        await options.upload(await options.render(options.getDoc()));
      } catch {
        // A card picture is a nicety: a failed one waits for the next edit.
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    noteEdit() {
      if (disposed) return;
      dirty = true;
      // A picture being taken now may miss this edit: the next quiet time takes another.
      schedule();
    },
    async flush() {
      clear();
      if (running) await running;
      if (dirty) await take();
    },
    get dirty() {
      return dirty;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
