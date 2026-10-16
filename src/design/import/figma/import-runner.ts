import {createDesignFile, eraseDesignFile, patchDesignDocumentBody, replaceDesignDocument, uploadDesignImage} from '../../api';
import {bigFilesEnabled} from '../../../../shared/design/big-files';
import {fromWire, toWire} from './import-errors';
import {depsFor, readSource, summaryOf, type FigmaAuth, type FigmaReadSummary, type FromWorker, type HeldRead, type ImportSource, type PageCall, type ToWorker} from './import-deps';
import {runFigmaImport, type ImportOutcome, type ImportStage, type RunDeps} from './run-import';

// Where "Import from Figma" runs: in a worker when the browser has one — unpacking a .fig or reading
// Figma's answers, mapping 200 000 layers and writing the save's parts never hold the page — or on the page (no Worker: tests, old
// browsers). The worker keeps the file it read; the page gets its summary. The api calls (create, pictures, the save's PUT and
// PATCHes, erase) stay on the page, which holds the session: the worker asks for them by message.

export type {FigmaAuth, FigmaReadSummary, ImportSource};

export interface ImportRunner {
  read(source: ImportSource, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void): Promise<FigmaReadSummary>;
  /** `auth`: the token for a link's file (null for a .fig). */
  run(read: FigmaReadSummary, pageIds: readonly string[], auth: FigmaAuth | null, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void): Promise<ImportOutcome>;
  /** Lets go of the file read (the dialog closed). */
  dispose(): void;
}

/** The api calls the import makes, on the page. */
export const pageCalls = {
  createFile: createDesignFile,
  uploadImage: uploadDesignImage,
  replaceDocument: replaceDesignDocument,
  patchDocument: patchDesignDocumentBody,
  eraseFile: eraseDesignFile,
};

const REREAD = 'The Figma file needs to be read again.';

/** On the page: the read kept here. Only the last read is kept: a big kit is hundreds of megabytes. */
export function pageRunner(calls: Pick<RunDeps, PageCall> = pageCalls): ImportRunner {
  let held: HeldRead | null = null;
  return {
    async read(source, signal, onStage) {
      held = null;
      held = await readSource(source, calls, signal, onStage);
      return summaryOf(held, source);
    },
    async run(read, pageIds, auth, signal, onStage) {
      if (held?.read.fileKey !== read.fileKey) throw new Error(REREAD);
      return runFigmaImport(held.read, pageIds, depsFor(held, auth, calls), signal, onStage);
    },
    dispose() {
      held = null;
    },
  };
}

/** In a worker; null when the browser has none (the dialog then runs the import on the page). */
export function workerRunner(calls: Pick<RunDeps, PageCall> = pageCalls): ImportRunner | null {
  if (typeof Worker === 'undefined') return null;
  let worker: Worker | null = null;
  let nextJob = 0;
  let disposed = false;
  const jobs = new Map<number, {resolve(value: unknown): void; reject(error: unknown): void; onStage(stage: ImportStage): void}>();
  const stop = (error: unknown) => {
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
    worker?.terminate();
    worker = null;
  };
  const start = () => {
    worker = new Worker(new URL('./import.worker.ts', import.meta.url), {type: 'module'});
    worker.onmessage = async (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      const job = jobs.get(message.job);
      if (message.type === 'stage') return job?.onStage(message.stage);
      if (message.type === 'call') {
        try {
          const method = calls[message.method] as (...args: unknown[]) => Promise<unknown>;
          const value = await method(...message.args);
          worker?.postMessage({type: 'answer', call: message.call, ok: true, value} satisfies ToWorker);
        } catch (error) {
          worker?.postMessage({type: 'answer', call: message.call, ok: false, error: toWire(error)} satisfies ToWorker);
        }
        return;
      }
      jobs.delete(message.job);
      if (message.type === 'done') job?.resolve(message.value);
      else job?.reject(fromWire(message.error));
      if (disposed && !jobs.size) stop(new Error(REREAD));
    };
    worker.onerror = event => {
      event.preventDefault();
      stop(new Error('The import stopped: it could not be started in the background. Reload the page and try again.'));
    };
    return worker;
  };
  /** `halt`: a cancel stops the worker at once (unpacking a .fig is one long step that never looks at the signal; nothing is on
   *  the server yet). Otherwise the worker winds the job down itself and erases a half-made file. */
  const send = <T>(message: (job: number) => ToWorker, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void, halt = false) =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const job = nextJob++;
      const abort = () => {
        if (halt) stop(signal!.reason);
        else (worker ?? start()).postMessage({type: 'abort', job} satisfies ToWorker);
      };
      signal?.addEventListener('abort', abort, {once: true});
      jobs.set(job, {
        resolve: value => (signal?.removeEventListener('abort', abort), resolve(value as T)),
        reject: error => (signal?.removeEventListener('abort', abort), reject(error)),
        onStage,
      });
      (worker ?? start()).postMessage(message(job));
    });
  return {
    read: (source, signal, onStage) => send<FigmaReadSummary>(job => ({type: 'read', job, source, bigFiles: bigFilesEnabled()}), signal, onStage, source.kind === 'fig'),
    run: (read, pageIds, auth, signal, onStage) =>
      send<ImportOutcome>(job => ({type: 'run', job, fileKey: read.fileKey, pageIds, auth, bigFiles: bigFilesEnabled()}), signal, onStage),
    dispose() {
      // A job still running (an import past its cancel, erasing what it made) finishes first; the worker goes after it.
      disposed = true;
      if (!jobs.size) stop(new Error(REREAD));
    },
  };
}

/** The runner the dialog uses: a worker when there is one, else the page. */
export const figmaImportRunner = (): ImportRunner => workerRunner() ?? pageRunner();
