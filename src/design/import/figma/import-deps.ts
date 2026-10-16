import type {FigmaConnectionKind} from '../../../../shared/figma/api';
import {figmaPages, pageOfNode} from '../../../../shared/design/figma-import';
import {createFigmaClient, FigmaApiError} from '../../../figma-import/figma-client';
import {downloadFigmaFile} from '../../../figma-import/asset-source-rest';
import {encodeFigmaImage} from '../../../figma-import/encode-image';
import {FigFileError, readFigFile, type FigFile} from '../../../figma-import/fig-file';
import {figRunParts, MAX_FIG_BYTES} from '../../../figma-import/fig-file/fig-client';
import type {WireError} from './import-errors';
import {readFigmaFile, type FigmaRead, type ImportStage, type RunDeps} from './run-import';

// What the import needs besides the api calls, and the messages between the page and the import's worker (import-runner.ts,
// import.worker.ts). No api and no Worker here: the worker imports this.

export type FigmaAuth = {token: string; kind: FigmaConnectionKind};
/** The api calls the page makes for the import. */
export type PageCall = 'createFile' | 'uploadImage' | 'replaceDocument' | 'patchDocument' | 'eraseFile';

/** Where the file comes from: a Figma link read with a token, or a .fig saved from Figma (no token, no network). */
export type ImportSource =
  | {kind: 'link'; fileKey: string; auth: FigmaAuth; /** A link's `node-id`: its page is chosen first. */ nodeId?: string}
  | {kind: 'fig'; fileKey: string; file: Blob; fileName: string};

/** What the dialog keeps of a read: everything but the file itself, which stays where the import runs. */
export type FigmaReadSummary = Omit<FigmaRead, 'file'> & {/** The page of the link's `node-id`, when the read shows it. */ linkedPage?: string};

/** A read kept where the import runs; a .fig's pictures with it. */
export type HeldRead = {read: FigmaRead; images: ReadonlyMap<string, Uint8Array> | null};

const shrink: RunDeps['shrink'] = (picture, ref) => encodeFigmaImage(picture, {index: 0, kind: 'fill', ref, maxSide: 4096});

/** Everything of the import but the api calls: Figma, pictures (OffscreenCanvas where there is no page). */
export function figmaDeps(auth: FigmaAuth, calls: Pick<RunDeps, PageCall>): RunDeps {
  return {client: createFigmaClient(auth), download: downloadFigmaFile, shrink, ...calls};
}

/** The same for a .fig: its pictures come out of the file. */
export function figDeps(images: ReadonlyMap<string, Uint8Array>, calls: Pick<RunDeps, PageCall>): RunDeps {
  return {...figRunParts(images), shrink, ...calls};
}

/** Reads `source` (a .fig is unpacked here: seconds for a big kit, so the worker does it). */
export async function readSource(source: ImportSource, calls: Pick<RunDeps, PageCall>, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void): Promise<HeldRead> {
  if (source.kind === 'link') return {read: await readFigmaFile(source.fileKey, figmaDeps(source.auth, calls), signal, onStage), images: null};
  onStage({stage: 'read'});
  if (source.file.size > MAX_FIG_BYTES) throw new FigFileError(`The .fig file is larger than ${Math.round(MAX_FIG_BYTES / 1024 / 1024)} MB. Save a copy in Figma with fewer pages.`);
  const data = new Uint8Array(await source.file.arrayBuffer());
  signal?.throwIfAborted();
  let fig: FigFile;
  try {
    fig = readFigFile(data, source.fileName);
  } catch (error) {
    if (error instanceof FigFileError) throw error;
    throw new FigFileError(error instanceof Error && error.name === 'KiwiError' ? error.message : 'The .fig file cannot be read.');
  }
  const pages = figmaPages(fig.file);
  if (!pages.length) throw new FigFileError('The file has no pages.');
  return {read: {fileKey: source.fileKey, name: fig.name, file: fig.file, whole: true, pages}, images: fig.images};
}

/** The dialog's part of a read. */
export function summaryOf({read}: HeldRead, source: ImportSource): FigmaReadSummary {
  const {file, ...rest} = read;
  const linkedPage = source.kind === 'link' && source.nodeId ? pageOfNode(file, source.nodeId) : null;
  return linkedPage ? {...rest, linkedPage} : rest;
}

/** What `run` uses for a held read: a .fig's own pictures, or Figma with the (maybe refreshed) token. */
export function depsFor(held: HeldRead, auth: FigmaAuth | null, calls: Pick<RunDeps, PageCall>): RunDeps {
  if (held.images) return figDeps(held.images, calls);
  if (!auth) throw new FigmaApiError({kind: 'token'});
  return figmaDeps(auth, calls);
}

// ── The worker's protocol ────────────────────────────────────────────────────────────────────────

export type ToWorker =
  // `bigFiles`: the page's switch (/api/config): the worker's own globals do not have it, and it sets the caps the file is mapped to.
  | {type: 'read'; job: number; source: ImportSource; bigFiles: boolean}
  | {type: 'run'; job: number; fileKey: string; pageIds: readonly string[]; auth: FigmaAuth | null; bigFiles: boolean}
  | {type: 'abort'; job: number}
  | {type: 'answer'; call: number; ok: true; value: unknown}
  | {type: 'answer'; call: number; ok: false; error: WireError};
export type FromWorker =
  | {type: 'stage'; job: number; stage: ImportStage}
  | {type: 'call'; job: number; call: number; method: PageCall; args: unknown[]}
  | {type: 'done'; job: number; value: unknown}
  | {type: 'failed'; job: number; error: WireError};
