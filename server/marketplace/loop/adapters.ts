// The marketplaces' seller APIs behind one interface (docs/marketplaces.md §Performance Loop): checking a key, finding products,
// uploading a picture into a photo slot, confirming it, and reading the daily numbers. ./wb.ts and ./ozon.ts talk to the real
// APIs; tests and the e2e server put an in-memory fake (./fake.ts) in their place, which only a test process honours.
import type {LoopMarketplace, LoopProduct} from '../../../shared/design/marketplace/loop';
import {MARKETPLACE_TIMEOUT_MS} from './config';

export type WbSecret = {kind: 'wb'; token: string};
export type OzonSecret = {kind: 'ozon'; clientId: string; apiKey: string};
/** What is encrypted into marketplace_connections.secret. */
export type MarketplaceSecret = WbSecret | OzonSecret;

/** `refused`: the key is not valid or lacks a right (401/403); `rate`: the marketplace asked to slow down (429); `failed`: anything
 *  else (it did not answer, or answered an error). The message is the seller's, in Russian. */
export type MarketplaceErrorKind = 'refused' | 'rate' | 'failed';
export class MarketplaceError extends Error {
  constructor(
    readonly kind: MarketplaceErrorKind,
    message: string,
  ) {
    super(message);
  }
}
export const isMarketplaceError = (error: unknown): error is MarketplaceError => error instanceof MarketplaceError;

/** A picture for one photo slot: its bytes (WB takes the file) and its public link (Ozon downloads it). */
export type PictureUpload = {
  productId: string;
  slot: number;
  bytes: Buffer;
  contentType: string;
  filename: string;
  url: string;
};
/** `live`: the marketplace took it; `sent`: it is processing it (confirmed later with `publication`). */
export type PublishAnswer = {state: 'live' | 'sent'; externalRef: string | null};
export type PublicationState = 'sent' | 'live' | {failed: string};
/** One product's numbers for one Moscow day; null where the marketplace does not report the number. */
export type MetricRow = {
  productId: string;
  day: string;
  views: number | null;
  clicks: number | null;
  carts: number | null;
  orders: number | null;
};
export type NumbersQuery = {
  products: readonly {productId: string; sku: string | null}[];
  /** Moscow days, both included. */
  from: string;
  to: string;
  /** Waits between two calls to respect the marketplace's rate limit (instant in tests). */
  pause(ms: number): Promise<void>;
};

export interface MarketplaceAdapter {
  /** A cheap read with the key: resolves when it works, throws MarketplaceError('refused') when the marketplace refuses it. */
  check(secret: MarketplaceSecret): Promise<void>;
  /** Products of the seller whose name or article contains `query` (the first page). */
  search(secret: MarketplaceSecret, query: string): Promise<LoopProduct[]>;
  /** One product by its id (WB nmID, Ozon product_id), or null. */
  product(secret: MarketplaceSecret, productId: string): Promise<LoopProduct | null>;
  /** Puts the picture into the slot, replacing the one there; the product's other pictures stay in order. */
  publish(secret: MarketplaceSecret, upload: PictureUpload): Promise<PublishAnswer>;
  /** Whether a `sent` picture is live now. */
  publication(
    secret: MarketplaceSecret,
    ref: {productId: string; externalRef: string | null},
  ): Promise<PublicationState>;
  /** The daily numbers of the products. */
  numbers(secret: MarketplaceSecret, query: NumbersQuery): Promise<MetricRow[]>;
}
export type MarketplaceAdapters = Readonly<Record<LoopMarketplace, MarketplaceAdapter>>;

let real: MarketplaceAdapters | null = null;
let fake: MarketplaceAdapters | null = null;

/** The adapters in use: the real ones, or a test's fake while it is set in a test process. */
export async function marketplaceAdapters(): Promise<MarketplaceAdapters> {
  if (fake && process.env.NODE_ENV === 'test') return fake;
  if (!real) {
    const [{wbAdapter}, {ozonAdapter}] = await Promise.all([import('./wb'), import('./ozon')]);
    real = {wb: wbAdapter, ozon: ozonAdapter};
  }
  return real;
}

/** Tests and the e2e server (NODE_ENV=test) answer for the marketplaces; anywhere else this throws. Null puts the real ones back. */
export function useMarketplaceFake(adapters: MarketplaceAdapters | null): void {
  if (process.env.NODE_ENV !== 'test') throw Error('A marketplace fake is for tests only.');
  fake = adapters;
}

const REFUSED =
  'The marketplace rejected the key. Check that it is valid and has the needed permissions, then reconnect.';
const RATE = 'The marketplace asks to wait: too many requests. We will try later.';

/**
 * One call to a marketplace: JSON (or multipart) in, JSON out, within MARKETPLACE_TIMEOUT_MS. 401/403 is `refused`, 429 `rate`, any
 * other failure `failed` with the marketplace's own words where it gave some. Never retried here: the worker's next pass does.
 */
export async function callMarketplace(name: string, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {...init, redirect: 'error', signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS)});
  } catch {
    throw new MarketplaceError('failed', `${name} did not respond. Try again in a few minutes.`);
  }
  if (response.status === 401 || response.status === 403) throw new MarketplaceError('refused', REFUSED);
  if (response.status === 429) throw new MarketplaceError('rate', RATE);
  const text = await response.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const said = marketplaceMessage(body);
    throw new MarketplaceError(
      'failed',
      `${name} answered with error ${response.status}${said ? `: ${said}` : '.'}`.slice(0, 480),
    );
  }
  return body;
}

/** The error text a marketplace put in its answer (WB: errorText / title / detail; Ozon: message). */
export function marketplaceMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const value = body as Record<string, unknown>;
  for (const key of ['errorText', 'message', 'detail', 'title', 'error'])
    if (typeof value[key] === 'string' && value[key]) return String(value[key]).slice(0, 300);
  return '';
}

/** A count from a marketplace's answer: a non-negative integer, or null when it is absent or not a number. */
export function count(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}
