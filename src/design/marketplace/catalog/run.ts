// Catalog run (docs/marketplaces.md §Catalog run): the rows of a table become cards on a new page "Catalog — <date>", in batches of up
// to 50 rows, each batch one undo step. Before a batch its photos arrive: the addresses in the table through the server
// (POST /api/marketplace/catalog/fetch-images), the files the seller dropped through the file's own upload; each picture's record is
// written in the same step as the cards that use it. Plain async code over the store, so the dialog only shows its progress.

import {ApiError} from '../../../api';
import {textBoxSize} from '../../../../shared/design/text-layout';
import {createNode, newId} from '../../../../shared/design/defaults';
import type {DesignImageUploaded} from '../../../../shared/design/api';
import {CATALOG_FETCH_LIMITS} from '../../../../shared/design/marketplace/catalog-api';
import {
  catalogBatchRows,
  catalogGrid,
  catalogPageName,
  insertCard,
  matchPhotoFiles,
  photoUrlOf,
  planCard,
  rowSku,
  templateNodes,
  utf8Length,
  type CatalogBinding,
  type CatalogMapping,
  type CatalogTable,
} from '../../../../shared/design/marketplace/catalog';
import type {ImageAsset, ImageRef, NodeId, SceneNode} from '../../../../shared/design/types';
import {uploadDesignImage} from '../../api';
import type {DesignStore, RefusalReason} from '../../engine/store';
import {fetchCatalogImages} from './api';

export type CatalogProgress = {phase: 'photos' | 'cards'; done: number; total: number};

export type CatalogOutcome = {
  pageId: NodeId | null;
  pageName: string;
  /** Card frames made, in row order. */
  cardIds: NodeId[];
  /** Rows asked for. */
  asked: number;
  /** Rows whose card kept the template's photo placeholder, with why (no address, a download that failed, no file). */
  withoutPhoto: {sku: string; reason: string}[];
  /** Stopped with "Stop". */
  stopped: boolean;
  /** Why the run ended early, for the user; null when it did not. */
  failure: string | null;
  /** Grid columns (to reveal the first rows). */
  columns: number;
};

export type CatalogRunInput = {
  store: DesignStore;
  fileId: string;
  frameId: NodeId;
  table: CatalogTable;
  mapping: CatalogMapping;
  /** Table rows to make, in order (rows with a SKU, cut to what the file holds). */
  rows: readonly number[];
  /** Photos the seller dropped, matched to rows by SKU in the file name. */
  files: readonly File[];
  signal: AbortSignal;
  onProgress: (progress: CatalogProgress) => void;
  /** Tests: the server's photo download and the file's upload. */
  fetchImages?: typeof fetchCatalogImages;
  uploadImage?: (fileId: string, image: Blob, name: string) => Promise<DesignImageUploaded>;
  now?: () => Date;
};

type Photo = {ref: ImageRef; asset: ImageAsset} | {error: string};

const REFUSED: Record<RefusalReason, string> = {
  readOnly: 'The file is open for viewing only: no cards were created.',
  devMode: 'In Code mode the file is not changed: switch to Design.',
  memory: 'The browser is out of memory for new layers. Close other tabs or create the catalog in parts.',
};
const RETRIES = 6;
const RETRY_MS = 15_000;

const aborted = (signal: AbortSignal) => new DOMException(signal.reason instanceof Error ? signal.reason.message : 'Stopped', 'AbortError');
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(aborted(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(aborted(signal));
    };
    signal.addEventListener('abort', stop, {once: true});
  });

/** A call the server limits per minute: on 429 it waits and tries again, a few times. */
async function patiently<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 429) || attempt >= RETRIES || signal.aborted) throw error;
      await wait(RETRY_MS, signal);
    }
  }
}

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** Runs the catalog. Resolves with what was made, also when stopped or refused part way. */
export async function runCatalog(input: CatalogRunInput): Promise<CatalogOutcome> {
  const {store, table, mapping, frameId, signal} = input;
  const fetchImages = input.fetchImages ?? fetchCatalogImages;
  const upload = input.uploadImage ?? uploadDesignImage;
  const start = store.getState().doc;
  const template = start.nodes[frameId];
  const pageName = catalogPageName((input.now ?? (() => new Date()))(), start.pages.map(id => start.nodes[id]?.name ?? ''));
  const grid = catalogGrid(input.rows.length, {width: template?.width ?? 1, height: template?.height ?? 1});
  const outcome: CatalogOutcome = {pageId: null, pageName, cardIds: [], asked: input.rows.length, withoutPhoto: [], stopped: false, failure: null, columns: grid.columns};
  if (!template) return {...outcome, failure: 'The template was deleted: choose a card and open the catalog again.'};

  const nodes = templateNodes(start, frameId);
  const batch = catalogBatchRows({nodes: nodes.length, bytes: utf8Length(JSON.stringify(nodes))});
  const imageBindings = Object.entries(mapping.bindings).filter((entry): entry is [NodeId, CatalogBinding] => {
    const binding = entry[1];
    return (binding.kind === 'column' || binding.kind === 'files') && start.nodes[entry[0]]?.type !== 'TEXT';
  });
  const fileFor = matchPhotoFiles(input.rows.map(row => rowSku(table, mapping, row)), input.files.map(file => file.name));
  const urlPhotos = new Map<string, Photo>();
  const filePhotos = new Map<number, Photo>();
  const measure = (node: SceneNode) => textBoxSize({...node, text: {...node.text!, textAutoResize: 'WIDTH_AND_HEIGHT'}}, store.measurer).width;
  const pageId = newId();
  let refusal: RefusalReason | null = null;
  const stopListening = store.onRefused((_label, reason) => {
    refusal = reason;
  });

  /** The photo a row puts into a picture layer bound to `binding`, or why there is none. */
  const photoOf = (index: number, binding: CatalogBinding): Photo | null => {
    const row = input.rows[index];
    if (binding.kind === 'column') {
      const url = photoUrlOf(table.rows[row]?.[binding.column] ?? '');
      return url ? (urlPhotos.get(url) ?? null) : {error: 'no photo link'};
    }
    if (binding.kind === 'files') return fileFor[index] < 0 ? {error: 'no file with the article number in its name'} : (filePhotos.get(fileFor[index]) ?? null);
    return null;
  };

  /** Fetches and uploads the photos of rows [from, to) the run does not have yet. */
  const loadPhotos = async (from: number, to: number) => {
    const urls = new Set<string>(), files = new Set<number>();
    for (let index = from; index < to; index++) {
      for (const [, binding] of imageBindings) {
        if (binding.kind === 'column') {
          const url = photoUrlOf(table.rows[input.rows[index]]?.[binding.column] ?? '');
          if (url && !urlPhotos.has(url)) urls.add(url);
        } else if (binding.kind === 'files' && fileFor[index] >= 0 && !filePhotos.has(fileFor[index])) files.add(fileFor[index]);
      }
    }
    const total = urls.size + files.size;
    if (!total) return;
    let done = 0;
    input.onProgress({phase: 'photos', done, total});
    const list = [...urls];
    for (let at = 0; at < list.length; at += CATALOG_FETCH_LIMITS.urls) {
      const chunk = list.slice(at, at + CATALOG_FETCH_LIMITS.urls);
      try {
        const {results} = await patiently(() => fetchImages(input.fileId, chunk, signal), signal);
        for (const result of results) urlPhotos.set(result.url, 'ref' in result ? {ref: result.ref, asset: result.asset} : {error: result.error});
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw error;
        for (const url of chunk) urlPhotos.set(url, {error: messageOf(error, 'could not download')});
      }
      done += chunk.length;
      input.onProgress({phase: 'photos', done, total});
    }
    // Three uploads at a time, as the file's own upload allows.
    const queue = [...files];
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (signal.aborted) return;
        const file = input.files[next];
        try {
          const stored = await patiently(() => upload(input.fileId, file, file.name), signal);
          filePhotos.set(next, {ref: stored.ref, asset: stored.asset});
        } catch (error) {
          if (isAbort(error) || signal.aborted) return;
          filePhotos.set(next, {error: messageOf(error, 'could not upload')});
        }
        done++;
        input.onProgress({phase: 'photos', done, total});
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (signal.aborted) throw aborted(signal);
  };

  try {
    for (let from = 0; from < input.rows.length; from += batch) {
      if (signal.aborted) throw aborted(signal);
      const to = Math.min(input.rows.length, from + batch);
      if (imageBindings.length) await loadPhotos(from, to);
      input.onProgress({phase: 'cards', done: from, total: input.rows.length});
      const doc = store.getState().doc;
      if (!doc.nodes[frameId]) throw new Error('The template was deleted while the catalog was being created.');
      const made: NodeId[] = [];
      const missing: {sku: string; reason: string}[] = [];
      refusal = null;
      const result = store.transact('Catalog from a table', tx => {
        if (from === 0) tx.addPage(createNode('PAGE', {id: pageId, name: pageName}));
        for (let index = from; index < to; index++) {
          const reasons: string[] = [];
          const plan = planCard({
            doc,
            frameId,
            table,
            mapping,
            row: input.rows[index],
            position: grid.position(index),
            measure,
            photoFor: (_slot, binding) => {
              const photo = photoOf(index, binding);
              if (!photo || 'error' in photo) {
                reasons.push(photo ? photo.error : 'photo not uploaded');
                return null;
              }
              if (!tx.doc.images[photo.ref]) tx.setImage(photo.ref, photo.asset);
              return photo.ref;
            },
          });
          insertCard(tx, plan, pageId, doc.variableModes);
          made.push(plan.rootId);
          if (plan.missingPhoto) missing.push({sku: plan.sku, reason: reasons[0] ?? 'photo not uploaded'});
        }
      });
      if (!result.doc.nodes[pageId] || made.some(id => !result.doc.nodes[id])) {
        outcome.failure = REFUSED[refusal ?? 'memory'];
        break;
      }
      outcome.pageId = pageId;
      outcome.cardIds.push(...made);
      outcome.withoutPhoto.push(...missing);
      input.onProgress({phase: 'cards', done: to, total: input.rows.length});
      // Let the dialog paint between batches.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch (error) {
    if (isAbort(error) || signal.aborted) outcome.stopped = true;
    else outcome.failure = messageOf(error, 'Could not create the catalog.');
  } finally {
    stopListening();
  }
  return outcome;
}
