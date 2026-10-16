// An in-memory Wildberries and Ozon for tests and the e2e server (docs/marketplaces.md §Performance Loop): a catalogue of a few
// products, keys that work (any but those starting with "bad"), uploads it remembers, and the daily numbers a test sets. Its answers
// go through the same readers as the real ones (./mapping.ts), so the field mapping is exercised end to end. Installed with
// `useMarketplaceFake`, which only a test process honours.
import {createHash} from 'node:crypto';
import type {LoopMarketplace, LoopProduct} from '../../../shared/design/marketplace/loop';
import type {CardNumbers} from '../../../shared/design/marketplace/score';
import {
  MarketplaceError,
  type MarketplaceAdapter,
  type MarketplaceAdapters,
  type MarketplaceSecret,
  type MetricRow,
} from './adapters';
import {ozonAnalyticsRows, OZON_METRICS, wbHistoryRows} from './mapping';
import {daysFrom} from '../../../shared/design/marketplace/loop-stats';

export type FakeUpload = {
  marketplace: LoopMarketplace;
  productId: string;
  slot: number;
  bytes: number;
  sha256: string;
  url: string;
};
/** Numbers for a product's day; null: the marketplace reports nothing that day. */
export type FakeNumbers = (
  marketplace: LoopMarketplace,
  productId: string,
  day: string,
) => Promise<CardNumbers | null> | CardNumbers | null;

export type FakeMarketplaces = {
  adapters: MarketplaceAdapters;
  uploads: FakeUpload[];
  /** Every call: "wb check", "ozon numbers"… */
  calls: string[];
  /** The numbers the marketplaces report (the default reports none). */
  setNumbers(numbers: FakeNumbers): void;
  /** The next call to `marketplace` answers like this (once). */
  failNext(marketplace: LoopMarketplace, kind: 'refused' | 'rate' | 'failed'): void;
  /** Ozon confirms imported pictures (on by default); off, they stay `sent`. */
  confirmOzon(on: boolean): void;
};

/** The fake catalogues. WB: nmIDs; Ozon: product_id with the SKU its analytics count by. */
export const FAKE_PRODUCTS: Readonly<Record<LoopMarketplace, readonly LoopProduct[]>> = {
  wb: [
    {productId: '187654321', sku: null, title: 'Ceramic mug 350 ml', article: 'MUG-350', photos: 5},
    {productId: '187654322', sku: null, title: 'Steel thermos mug 450 ml', article: 'MUG-450', photos: 3},
    {productId: '187654323', sku: null, title: 'Teapot 600 ml', article: 'TEA-600', photos: 4},
  ],
  ozon: [
    {productId: '612345', sku: '1876543210', title: 'Ceramic mug 350 ml', article: 'MUG-350', photos: 4},
    {productId: '612346', sku: '1876543211', title: 'French press 800 ml', article: 'FP-800', photos: 2},
  ],
};

export function createFakeMarketplaces(): FakeMarketplaces {
  const uploads: FakeUpload[] = [];
  const calls: string[] = [];
  const failures = new Map<LoopMarketplace, 'refused' | 'rate' | 'failed'>();
  let numbers: FakeNumbers = () => null;
  let ozonConfirms = true;

  const enter = (marketplace: LoopMarketplace, secret: MarketplaceSecret, call: string) => {
    calls.push(`${marketplace} ${call}`);
    const key = secret.kind === 'wb' ? secret.token : secret.apiKey;
    const failure = failures.get(marketplace);
    failures.delete(marketplace);
    if (key.startsWith('bad') || failure === 'refused')
      throw new MarketplaceError(
        'refused',
        'The marketplace rejected the key. Check that it is valid and has the needed permissions, then reconnect.',
      );
    if (failure === 'rate')
      throw new MarketplaceError('rate', 'The marketplace asks to wait: too many requests. We will try later.');
    if (failure === 'failed') throw new MarketplaceError('failed', 'The marketplace answered with error 500.');
  };
  const find = (marketplace: LoopMarketplace, query: string) => {
    const wanted = query.trim().toLowerCase();
    return FAKE_PRODUCTS[marketplace].filter(
      product =>
        !wanted ||
        product.title.toLowerCase().includes(wanted) ||
        product.article?.toLowerCase().includes(wanted) ||
        product.productId === wanted ||
        product.sku === wanted,
    );
  };
  // The days' numbers as each marketplace's own answer, read back by the real readers.
  const daysOf = async (marketplace: LoopMarketplace, productId: string, from: string, to: string) => {
    const out: {day: string; numbers: CardNumbers}[] = [];
    for (const day of daysFrom(from, to)) {
      const value = await numbers(marketplace, productId, day);
      if (value) out.push({day, numbers: value});
    }
    return out;
  };

  const adapter = (marketplace: LoopMarketplace): MarketplaceAdapter => ({
    async check(secret) {
      enter(marketplace, secret, 'check');
    },
    async search(secret, query) {
      enter(marketplace, secret, 'search');
      return find(marketplace, query).map(product => ({...product}));
    },
    async product(secret, productId) {
      enter(marketplace, secret, 'product');
      const product = FAKE_PRODUCTS[marketplace].find(
        entry => entry.productId === productId || entry.sku === productId,
      );
      return product ? {...product} : null;
    },
    async publish(secret, upload) {
      enter(marketplace, secret, 'publish');
      if (!FAKE_PRODUCTS[marketplace].some(product => product.productId === upload.productId))
        throw new MarketplaceError('failed', 'The marketplace answered with error 404: product not found.');
      uploads.push({
        marketplace,
        productId: upload.productId,
        slot: upload.slot,
        bytes: upload.bytes.length,
        sha256: createHash('sha256').update(upload.bytes).digest('hex'),
        url: upload.url,
      });
      return marketplace === 'wb'
        ? {state: 'live', externalRef: null}
        : {state: 'sent', externalRef: upload.url.slice(0, 200)};
    },
    async publication(secret) {
      enter(marketplace, secret, 'publication');
      return marketplace === 'wb' || ozonConfirms ? 'live' : 'sent';
    },
    async numbers(secret, query): Promise<MetricRow[]> {
      enter(marketplace, secret, 'numbers');
      if (marketplace === 'wb') {
        // WB's funnel: per nmID a history of days; impressions only where the test reported them.
        const data = [];
        for (const {productId} of query.products) {
          const days = await daysOf(marketplace, productId, query.from, query.to);
          data.push({
            nmID: Number(productId),
            history: days.map(({day, numbers: n}) => ({
              dt: day,
              ...(n.views !== null ? {impressions: n.views} : {}),
              openCardCount: n.clicks ?? 0,
              addToCartCount: n.carts ?? 0,
              ordersCount: n.orders ?? 0,
            })),
          });
        }
        return wbHistoryRows({data, error: false, errorText: ''});
      }
      // Ozon's analytics: rows of [sku, day] with the metrics in OZON_METRICS' order.
      const productOfSku = new Map<string, string>();
      const data = [];
      for (const {productId, sku} of query.products) {
        if (!sku) continue;
        productOfSku.set(sku, productId);
        for (const {day, numbers: n} of await daysOf(marketplace, productId, query.from, query.to))
          data.push({
            dimensions: [
              {id: sku, name: ''},
              {id: day, name: ''},
            ],
            metrics: OZON_METRICS.map((_, i) => [n.views, n.clicks, n.carts, n.orders][i] ?? 0),
          });
      }
      return ozonAnalyticsRows({result: {data, totals: []}}, productOfSku);
    },
  });

  return {
    adapters: {wb: adapter('wb'), ozon: adapter('ozon')},
    uploads,
    calls,
    setNumbers(next) {
      numbers = next;
    },
    failNext(marketplace, kind) {
      failures.set(marketplace, kind);
    },
    confirmOzon(on) {
      ozonConfirms = on;
    },
  };
}

/** Constant numbers every day from `from` on (a test's simple case). */
export const everyDayFrom =
  (from: string, value: CardNumbers): FakeNumbers =>
  (_marketplace, _productId, day) =>
    day >= from ? value : null;
