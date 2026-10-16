import {depsFor, readSource, summaryOf, type FromWorker, type HeldRead, type PageCall, type ToWorker} from './import-deps';
import {runFigmaImport, type ImportStage} from './run-import';
import {fromWire, toWire} from './import-errors';
import {installBigFiles} from '../../../../shared/design/big-files';

// "Import from Figma" off the page (import-runner.ts `workerRunner`): a .fig unpacked or Figma's answers read and parsed, the file
// mapped and the save's parts written here; the page makes the api calls it is asked for and shows the stages.

type Scope = {onmessage: ((event: MessageEvent<ToWorker>) => void) | null; postMessage(message: FromWorker): void};
const scope = self as unknown as Scope;

/** The last file read: only one is kept, a big kit is hundreds of megabytes. */
let held: HeldRead | null = null;
const controllers = new Map<number, AbortController>();
const waiting = new Map<number, {resolve(value: unknown): void; reject(error: unknown): void}>();
let nextCall = 0;

/** An api call made on the page for job `job`. */
const call =
  (job: number, method: PageCall) =>
  (...args: unknown[]) =>
    new Promise<never>((resolve, reject) => {
      const id = nextCall++;
      waiting.set(id, {resolve: resolve as (value: unknown) => void, reject});
      scope.postMessage({type: 'call', job, call: id, method, args});
    });
const callsFor = (job: number) => ({
  createFile: call(job, 'createFile'),
  uploadImage: call(job, 'uploadImage'),
  replaceDocument: call(job, 'replaceDocument'),
  patchDocument: call(job, 'patchDocument'),
  eraseFile: call(job, 'eraseFile'),
});

scope.onmessage = event => {
  const message = event.data;
  if (message.type === 'answer') {
    const entry = waiting.get(message.call);
    waiting.delete(message.call);
    if (message.ok) entry?.resolve(message.value);
    else entry?.reject(fromWire(message.error));
    return;
  }
  if (message.type === 'abort') return void controllers.get(message.job)?.abort(new DOMException('Import cancelled.', 'AbortError'));
  const {job} = message;
  const controller = new AbortController();
  controllers.set(job, controller);
  const onStage = (stage: ImportStage) => scope.postMessage({type: 'stage', job, stage});
  const work = async () => {
    installBigFiles(message.bigFiles);
    if (message.type === 'read') {
      held = null;
      held = await readSource(message.source, callsFor(job), controller.signal, onStage);
      return summaryOf(held, message.source);
    }
    if (held?.read.fileKey !== message.fileKey) throw new Error('The Figma file needs to be read again.');
    return runFigmaImport(held.read, message.pageIds, depsFor(held, message.auth, callsFor(job)), controller.signal, onStage);
  };
  work().then(
    value => scope.postMessage({type: 'done', job, value}),
    error => scope.postMessage({type: 'failed', job, error: toWire(error)}),
  ).finally(() => controllers.delete(job));
};
