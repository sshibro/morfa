// Catalog run (docs/marketplaces.md §Catalog run): its one server call. POST /api/marketplace/catalog/fetch-images fetches the photos a
// table links to (public https addresses only) and stores each as a picture of the file, as an upload would; the editor then puts the
// refs into the cards. Plain types and numbers, importable by the editor and the server alike.

import type {ImageAsset, ImageRef} from '../types';

export const CATALOG_FETCH_LIMITS = {
  /** Addresses one request takes. */
  urls: 50,
  /** One address, characters. */
  url: 2_048,
  /** One picture as downloaded (DESIGN_DOCUMENT_CAPS.imageBytes). */
  bytes: 20 * 1024 * 1024,
  /** One download, start to end, redirects included. */
  timeoutMs: 30_000,
  redirects: 3,
  /** Downloads one request runs at once. */
  parallel: 4,
  /** Requests per account per ten minutes (each up to 50 addresses). */
  requestsPer10Minutes: 40,
} as const;

export type CatalogFetchRequest = {fileId: string; urls: string[]};

/** One address's outcome, in the order asked: the stored picture, or why there is none (for the user). */
export type CatalogFetched = {url: string; ref: ImageRef; asset: ImageAsset} | {url: string; error: string; code?: string};

export type CatalogFetchAnswer = {results: CatalogFetched[]};
