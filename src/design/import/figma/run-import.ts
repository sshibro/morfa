import type {DesignFileCreate, DesignFileSummary, DesignImageUploaded, DesignSaved} from '../../../../shared/design/api';
import {iconTextsOf, replaceIconTexts} from './icon-texts';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {DESIGN_DOCUMENT_CAPS} from '../../../../shared/design/limits';
import {megabytes} from '../../../../shared/design/big-files';
import {
  figmaPages, importFigmaFile, missingComponents, utf8Length, withUploadedImages, FigmaImportError, type FigmaFile, type FigmaImportReport, type FigmaNode, type FigmaPageSummary, type UploadedImage,
} from '../../../../shared/design/figma-import';
import {FigmaApiError, type FigmaClient} from '../../../figma-import/figma-client';

// "Import from Figma" for "Design", without the screen: read the file with the user's token (the
// browser calls Figma; the server never does), map it, copy its pictures into a
// new design file and save the document there. Everything that talks to a network comes in `deps`,
// so the flow is tested with fakes (tests/design-figma-import-runner.test.ts).

export type ImportStage =
  | {stage: 'read'; page?: {done: number; total: number}}
  | {stage: 'wait'; seconds: number}
  | {stage: 'map'}
  | {stage: 'create'}
  | {stage: 'images'; done: number; total: number}
  /** A big file is saved in parts (`saveInParts`): `done` of `total` bytes of its layers sent. */
  | {stage: 'save'; done?: number; total?: number};

export type RunDeps = {
  client: Pick<FigmaClient, 'file' | 'nodes' | 'imageFills'> & Partial<Pick<FigmaClient, 'images'>>;
  /** downloadFigmaFile (src/figma-import/asset-source-rest.ts). */
  download: (url: string, signal?: AbortSignal) => Promise<Blob>;
  /** Re-encodes a picture over the upload limits; null when it cannot. */
  shrink: (picture: Blob, ref: string) => Promise<Blob | null>;
  createFile: (data: DesignFileCreate) => Promise<{file: DesignFileSummary}>;
  uploadImage: (fileId: string, picture: Blob, name: string) => Promise<DesignImageUploaded>;
  replaceDocument: (fileId: string, baseVersion: number, document: DesignDocument) => Promise<DesignSaved>;
  /** `PATCH /:id/document` with a body already written (`{"baseVersion":…,"patch":…}`): a big file's layers in parts. Without it
   *  every file is saved whole. */
  patchDocument?: (fileId: string, body: Blob) => Promise<DesignSaved>;
  eraseFile: (fileId: string) => Promise<unknown>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Lets the screen paint before a long synchronous step. */
  yieldToUi?: () => Promise<void>;
};

export type FigmaRead = {
  fileKey: string;
  name: string;
  file: FigmaFile;
  /** False when the file was too big to read at once: pages are read when chosen. */
  whole: boolean;
  pages: FigmaPageSummary[];
};

export type ImportOutcome = {fileId: string; name: string; report: FigmaImportReport; imagesCopied: number; imagesMissing: number};

export const IMAGE_POOL = 6;
const UPLOAD_POOL = 3;
const MAX_RATE_WAIT_S = 120;
const NODE_CHUNK = 40;
const MAX_UPLOAD_BYTES = DESIGN_DOCUMENT_CAPS.imageBytes;
const UPLOAD_RETRIES = 4;
const UPLOAD_RETRY_MS = 15_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const statusOf = (error: unknown) => (isObject(error) && typeof error.status === 'number' ? error.status : undefined);
const codeOf = (error: unknown) => (isObject(error) && isObject(error.details) && typeof error.details.code === 'string' ? error.details.code : undefined);

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', stop, {once: true});
  });
const defaultYield = () => new Promise<void>(resolve => setTimeout(resolve, 16));

/** Settles with `promise`, or rejects as soon as `signal` aborts (a call that takes no signal). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** A Figma call, waiting out Figma's rate limit (Retry-After) up to twice while it is short. */
async function figmaCall<T>(call: () => Promise<T>, deps: RunDeps, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void, resume: ImportStage): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof FigmaApiError) || error.kind !== 'rate' || attempt >= 2) throw error;
      const wait = error.retryAfter ?? 30;
      if (wait > MAX_RATE_WAIT_S) throw error;
      for (let left = Math.ceil(wait); left > 0; left--) {
        onStage({stage: 'wait', seconds: left});
        await sleep(1000, signal);
      }
      onStage(resume);
    }
  }
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    for (let index = next++; index < items.length; index = next++) await work(items[index], index);
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, lane));
}

type NodesAnswer = {nodes: Map<string, FigmaNode>; meta: Pick<FigmaFile, 'components' | 'componentSets' | 'styles'>};

/** Copies own entries of an answer's map; "__proto__" would replace the target's prototype. */
function copyEntries(target: Record<string, unknown>, source: unknown) {
  if (!isObject(source)) return;
  for (const [key, value] of Object.entries(source)) if (key !== '__proto__') target[key] = value;
}

function readNodesAnswer(answer: unknown): NodesAnswer {
  const out: NodesAnswer = {nodes: new Map(), meta: {components: {}, componentSets: {}, styles: {}}};
  const nodes = isObject(answer) && isObject(answer.nodes) ? answer.nodes : {};
  for (const [id, entry] of Object.entries(nodes)) {
    if (!isObject(entry) || !isObject(entry.document)) continue;
    out.nodes.set(id, entry.document as FigmaNode);
    for (const key of ['components', 'componentSets', 'styles'] as const) copyEntries(out.meta[key]!, entry[key]);
  }
  return out;
}

/** Adds the entries the file does not have yet, in place: a copy of the file's maps per page made a kit of 250 pages quadratic. */
function mergeMeta(file: FigmaFile, meta: NodesAnswer['meta']) {
  for (const key of ['components', 'componentSets', 'styles'] as const) {
    const target = (file[key] ??= {}) as Record<string, unknown>;
    for (const [id, value] of Object.entries(meta[key] ?? {})) if (!Object.hasOwn(target, id)) target[id] = value;
  }
}

/** Reads the whole file with its geometry, or, when Figma's answer is over the size cap, its page list. */
export async function readFigmaFile(fileKey: string, deps: RunDeps, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void): Promise<FigmaRead> {
  onStage({stage: 'read'});
  let file: FigmaFile;
  let whole = true;
  try {
    file = (await figmaCall(() => deps.client.file(fileKey, 0, signal, 'paths'), deps, signal, onStage, {stage: 'read'})) as FigmaFile;
  } catch (error) {
    if (!(error instanceof FigmaApiError) || !error.tooLarge) throw error;
    // Too big for one answer: list the pages now, read each chosen page on its own later.
    file = (await figmaCall(() => deps.client.file(fileKey, 1, signal), deps, signal, onStage, {stage: 'read'})) as FigmaFile;
    whole = false;
  }
  if (!isObject(file) || !isObject(file.document)) throw new FigmaImportError('Figma returned no file content. Try again.');
  const pages = figmaPages(file);
  if (!pages.length) throw new FigmaImportError('The file has no pages.');
  return {fileKey, name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : 'Figma import', file, whole, pages};
}

/** Nodes with their subtrees and geometry; an answer over the size cap is split until it fits. */
async function readNodes(fileKey: string, ids: string[], deps: RunDeps, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void, resume: ImportStage, tooBig: string[]): Promise<NodesAnswer> {
  const out: NodesAnswer = {nodes: new Map(), meta: {components: {}, componentSets: {}, styles: {}}};
  const queue: string[][] = [];
  for (let i = 0; i < ids.length; i += NODE_CHUNK) queue.push(ids.slice(i, i + NODE_CHUNK));
  while (queue.length) {
    const chunk = queue.shift()!;
    try {
      const answer = readNodesAnswer(await figmaCall(() => deps.client.nodes(fileKey, chunk, signal, 'paths'), deps, signal, onStage, resume));
      for (const [id, node] of answer.nodes) out.nodes.set(id, node);
      for (const key of ['components', 'componentSets', 'styles'] as const) copyEntries(out.meta[key]!, answer.meta[key]);
    } catch (error) {
      if (!(error instanceof FigmaApiError) || !error.tooLarge) throw error;
      if (chunk.length === 1) tooBig.push(chunk[0]);
      else queue.unshift(chunk.slice(0, chunk.length >> 1), chunk.slice(chunk.length >> 1));
    }
  }
  return out;
}

/** The chosen pages of a file read page by page, filled in place, and the mains they still need. */
async function readChosenPages(read: FigmaRead, pageIds: readonly string[], deps: RunDeps, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void) {
  const {file, fileKey} = read;
  const canvases = file.document!.children ?? [];
  const tooBig: string[] = [];
  let listing: FigmaFile | null = null;
  let done = 0;
  for (const pageId of pageIds) {
    const canvas = canvases.find(page => page.id === pageId);
    if (!canvas) continue;
    const stage: ImportStage = {stage: 'read', page: {done, total: pageIds.length}};
    onStage(stage);
    const answer = await readNodes(fileKey, [pageId], deps, signal, onStage, stage, tooBig);
    const page = answer.nodes.get(pageId);
    if (page) {
      copyEntries(canvas as unknown as Record<string, unknown>, page);
      mergeMeta(file, answer.meta);
    } else if (tooBig.includes(pageId)) {
      // One page over the cap: its top-level layers one by one.
      tooBig.splice(tooBig.indexOf(pageId), 1);
      listing ??= (await figmaCall(() => deps.client.file(fileKey, 2, signal), deps, signal, onStage, stage)) as FigmaFile;
      const listed = listing.document?.children?.find(entry => entry.id === pageId);
      const ids = (listed?.children ?? []).map(child => child.id).filter((id): id is string => typeof id === 'string');
      const parts = await readNodes(fileKey, ids, deps, signal, onStage, stage, tooBig);
      canvas.children = ids.flatMap(id => (parts.nodes.has(id) ? [parts.nodes.get(id)!] : []));
      mergeMeta(file, parts.meta);
    }
    done++;
  }
  // Mains on pages that were not read, fetched on their own (their own mains in turn).
  const extra: FigmaNode[] = [];
  for (let round = 0; round < 3; round++) {
    const missing = missingComponents(file, pageIds, extra).filter(id => !tooBig.includes(id));
    if (!missing.length) break;
    const answer = await readNodes(fileKey, missing, deps, signal, onStage, {stage: 'read'}, tooBig);
    if (!answer.nodes.size) break;
    extra.push(...answer.nodes.values());
    mergeMeta(file, answer.meta);
  }
  return {extra, tooBig};
}

const clientId = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'figma-' + Array.from(bytes, byte => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
};

/** Maps the chosen pages, creates the file, copies the pictures and saves the document. On a
 *  failure or a cancel after the file was created, the half-made file is erased. */
export async function runFigmaImport(read: FigmaRead, pageIds: readonly string[], deps: RunDeps, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void): Promise<ImportOutcome> {
  let extra: FigmaNode[] = [];
  let tooBig: string[] = [];
  if (!read.whole) ({extra, tooBig} = await readChosenPages(read, pageIds, deps, signal, onStage));

  onStage({stage: 'map'});
  await (deps.yieldToUi ?? defaultYield)();
  signal?.throwIfAborted();
  const mapped = importFigmaFile(read.file, {pageIds, extraNodes: extra});
  if (tooBig.length) mapped.report.items.push({key: 'read-too-big', group: 'limits', message: 'Figma does not return frames this large in one response: they were not imported', count: tooBig.length, examples: []});
  // Icon-font texts (Material Symbols…) become the vectors of Figma's SVG render of them (icon-texts.ts).
  const icons = iconTextsOf(mapped.doc);
  const images = deps.client.images;
  if (icons.length && images) {
    const resume: ImportStage = {stage: 'map'};
    const render = (ids: string[]) => figmaCall(() => images(read.fileKey, ids, 'svg', signal), deps, signal, onStage, resume);
    const {replaced} = await replaceIconTexts(mapped.doc, icons, {render, download: deps.download}, signal);
    if (replaced) mapped.report.items.push({key: 'icon-fonts', group: 'fonts', message: 'Icons from icon fonts were imported as vectors', count: replaced, examples: []});
  }

  onStage({stage: 'create'});
  signal?.throwIfAborted();
  const created: DesignFileSummary = (await deps.createFile({name: read.name.slice(0, 200), clientId: clientId()})).file;
  if (signal?.aborted) {
    await deps.eraseFile(created.id).catch(() => undefined);
    signal.throwIfAborted();
  }

  try {
    const {uploaded, missing} = await copyImages(read.fileKey, mapped.imageRefs, created.id, deps, signal, onStage);
    signal?.throwIfAborted();
    onStage({stage: 'save'});
    const {doc} = withUploadedImages(mapped.doc, uploaded);
    if (deps.patchDocument && mapped.bytes > WHOLE_SAVE_BYTES) await saveInParts(created.id, created.version, doc, mapped.bytes, deps, signal, onStage);
    else await untilAborted(deps.replaceDocument(created.id, created.version, doc), signal);
    const report = mapped.report;
    const oversized = missing.filter(entry => entry.reason === 'too-big').length;
    if (oversized)
      report.items.push({
        key: 'images-too-big', group: 'limits', count: oversized, examples: [],
        message: `Images larger than ${megabytes(MAX_UPLOAD_BYTES)} MB or ${DESIGN_DOCUMENT_CAPS.imagePixels / 1_000_000} megapixels that could not be reduced to that limit: gray fills instead`,
      });
    const other = missing.filter(entry => entry.reason !== 'too-big');
    if (other.length) {
      const storage = other.some(entry => entry.reason === 'storage');
      report.items.push({
        key: 'images-missing', group: 'images', count: other.length, examples: [],
        message: storage ? 'Not enough room for images: grey fills stand in for them. Free up space and import the file again' : 'Some images could not be copied from Figma: grey fills stand in for them',
      });
    }
    return {fileId: created.id, name: created.name, report, imagesCopied: uploaded.size, imagesMissing: missing.length};
  } catch (error) {
    // Nothing half-made stays behind.
    await deps.eraseFile(created.id).catch(() => undefined);
    throw error;
  }
}

/** A document over this is saved in parts: one PUT of 100 MB is a 100 MB string, and the server reads it whole. */
export const WHOLE_SAVE_BYTES = 8 * 1024 * 1024;
/** One part's layers: under the server's 8 MB patch body (DESIGN_PATCH_MAX_BYTES), with room for the parents sent again. */
export const SAVE_PART_BYTES = 6 * 1024 * 1024;

/**
 * A big imported file saved without one huge string — its skeleton (the pages without their layers, every
 * other table whole) with one PUT, then its layers in pre-order, parents first, in PATCHes of at most SAVE_PART_BYTES. A parent whose
 * children are not all written yet is sent with the ones that are, and again as more come: every part leaves a valid document,
 * which the server checks as it checks any save.
 */
async function saveInParts(
  fileId: string,
  baseVersion: number,
  doc: DesignDocument,
  total: number,
  deps: RunDeps,
  signal: AbortSignal | undefined,
  onStage: (stage: ImportStage) => void,
): Promise<void> {
  const nodes = doc.nodes;
  const roots = Object.keys(nodes).filter(id => nodes[id]!.parentId === null);
  const skeleton: DesignDocument = {...doc, nodes: Object.fromEntries(roots.map(id => [id, nodes[id]!.children ? {...nodes[id]!, children: []} : nodes[id]!]))};
  let version = (await untilAborted(deps.replaceDocument(fileId, baseVersion, skeleton), signal)).version;
  /** Children written so far, by parent. */
  const present = new Map<NodeId, NodeId[]>(roots.map(id => [id, []]));
  let added: NodeId[] = [],
    grown = new Set<NodeId>(),
    bytes = 0,
    sent = 0;
  const entry = (id: NodeId) => {
    const node = nodes[id]!;
    const value = node.children ? {...node, children: present.get(id) ?? []} : node;
    return JSON.stringify(id) + ':' + JSON.stringify(value);
  };
  const flush = async () => {
    if (!added.length) return;
    const fresh = new Set(added);
    const ids = [...[...grown].filter(id => !fresh.has(id)), ...added];
    const body = new Blob(['{"baseVersion":' + version + ',"patch":{"nodes":{', ids.map(entry).join(','), '}}}'], {type: 'application/json'});
    signal?.throwIfAborted();
    version = (await untilAborted(deps.patchDocument!(fileId, body), signal)).version;
    sent += bytes;
    onStage({stage: 'save', done: Math.min(sent, total), total});
    ((added = []), (grown = new Set()), (bytes = 0));
  };
  for (const root of roots) {
    // Pre-order with an explicit stack: a parent before its children, children in their order.
    const stack = [...(nodes[root]!.children ?? [])].reverse();
    while (stack.length) {
      const id = stack.pop()!;
      const node = nodes[id];
      if (!node) continue;
      const size = utf8Length(JSON.stringify(node)) + utf8Length(id) + 4;
      if (bytes && bytes + size > SAVE_PART_BYTES) await flush();
      added.push(id);
      bytes += size;
      present.get(node.parentId!)!.push(id);
      grown.add(node.parentId!);
      if (node.children) {
        present.set(id, []);
        for (let k = node.children.length - 1; k >= 0; k--) stack.push(node.children[k]!);
      }
    }
  }
  await flush();
}

type Missing = {ref: string; reason: 'link' | 'download' | 'upload' | 'storage' | 'too-big'};

async function copyImages(fileKey: string, refs: readonly string[], fileId: string, deps: RunDeps, signal: AbortSignal | undefined, onStage: (stage: ImportStage) => void) {
  const uploaded = new Map<string, UploadedImage>();
  const missing: Missing[] = [];
  if (!refs.length) return {uploaded, missing};
  const first: ImportStage = {stage: 'images', done: 0, total: refs.length};
  onStage(first);
  let links: Record<string, string> = {};
  try {
    links = await figmaCall(() => deps.client.imageFills(fileKey, signal), deps, signal, onStage, first);
  } catch (error) {
    if (signal?.aborted || (error instanceof FigmaApiError && (error.kind === 'token' || error.kind === 'scope' || error.kind === 'access' || error.kind === 'network'))) throw error;
  }
  const sleep = deps.sleep ?? defaultSleep;
  let done = 0, storageFull = false, uploading = 0;
  const waiters: (() => void)[] = [];
  const slot = async () => {
    while (uploading >= UPLOAD_POOL) await new Promise<void>(resolve => waiters.push(resolve));
    uploading++;
  };
  const release = () => {
    uploading--;
    waiters.shift()?.();
  };
  await pool(refs, IMAGE_POOL, async ref => {
    try {
      const link = links[ref];
      if (!link) return void missing.push({ref, reason: 'link'});
      if (storageFull) return void missing.push({ref, reason: 'storage'});
      let picture: Blob;
      let shrunk = false;
      try {
        picture = await deps.download(link, signal);
        if (picture.size > MAX_UPLOAD_BYTES) {
          picture = (await deps.shrink(picture, ref)) ?? picture;
          shrunk = true;
        }
      } catch {
        signal?.throwIfAborted();
        return void missing.push({ref, reason: 'download'});
      }
      // Still over the upload cap after shrinking: the server would refuse it.
      if (picture.size > MAX_UPLOAD_BYTES) return void missing.push({ref, reason: 'too-big'});
      await slot();
      try {
        for (let attempt = 0; ; attempt++) {
          signal?.throwIfAborted();
          if (storageFull) return void missing.push({ref, reason: 'storage'});
          try {
            const stored = await untilAborted(deps.uploadImage(fileId, picture, `figma-${ref.slice(0, 12)}`), signal);
            uploaded.set(ref, {ref: stored.ref, asset: stored.asset});
            return;
          } catch (error) {
            signal?.throwIfAborted();
            if (codeOf(error) === 'design_storage_limit') {
              storageFull = true;
              return void missing.push({ref, reason: 'storage'});
            }
            // The server allows 60 pictures a minute: wait and try again.
            if (statusOf(error) === 429 && attempt < UPLOAD_RETRIES) {
              await sleep(UPLOAD_RETRY_MS, signal);
              continue;
            }
            const status = statusOf(error);
            if (status === 401 || status === 403 || (status === 404 && codeOf(error) === 'design_unavailable')) throw error;
            // Refused as too big (bytes or megapixels): once more, redrawn smaller.
            if ((status === 400 || status === 413) && !shrunk) {
              shrunk = true;
              const smaller = await deps.shrink(picture, ref).catch(() => null);
              if (smaller) {
                picture = smaller;
                continue;
              }
            }
            return void missing.push({ref, reason: status === 413 ? 'too-big' : 'upload'});
          }
        }
      } finally {
        release();
      }
    } finally {
      done++;
      onStage({stage: 'images', done, total: refs.length});
    }
  });
  return {uploaded, missing};
}
