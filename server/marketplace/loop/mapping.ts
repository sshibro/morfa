// What Morfa reads out of the marketplaces' answers (docs/marketplaces.md §Performance Loop): one small function per answer, each
// tested on its own (tests/design-marketplace-loop-mapping.test.ts), so a field the marketplace renames is fixed in one place. Every
// reader is lenient: a missing or malformed field becomes null (a number the marketplace did not report), never a guess.
//
// Checked against the sellers' documentation as known on 2026-10-12 (dev.wildberries.ru, docs.ozon.ru/api/seller); the newer names WB
// gave its funnel's fields are read too.
import type {LoopProduct} from '../../../shared/design/marketplace/loop';
import {count, type MetricRow, type PublicationState} from './adapters';

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : null;
/** The first of the fields that is present (WB renamed some), as a count. */
const firstCount = (row: Json, ...keys: string[]): number | null => {
  for (const key of keys) if (key in row) return count(row[key]);
  return null;
};
const dayOf = (value: unknown): string | null => {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
};

// ── Wildberries ─────────────────────────────────────────────────────────────────────────────────────

/** A card of POST content/v2/get/cards/list: the nmID, the seller's article (vendorCode), its title and photos. */
export function wbProduct(card: unknown): LoopProduct | null {
  const value = object(card);
  const productId = text(value.nmID);
  if (!productId || !/^\d{1,20}$/.test(productId)) return null;
  const article = text(value.vendorCode);
  return {
    productId,
    sku: null,
    title: (text(value.title) ?? text(value.subjectName) ?? `WB article ${productId}`).slice(0, 300),
    article: article?.slice(0, 64) ?? null,
    photos: list(value.photos).length,
  };
}
export const wbProducts = (body: unknown): LoopProduct[] =>
  list(object(body).cards)
    .map(wbProduct)
    .filter((product): product is LoopProduct => product !== null);

/**
 * The sales funnel by day (POST seller-analytics-api …/nm-report/detail/history): per nmID a `history` of days. Card opens
 * (openCardCount) are the clicks, addToCartCount the carts, ordersCount the orders. The funnel has no impressions, so views stay null
 * unless a day carries them (`impressions`, as WB's newer reports do).
 */
export function wbHistoryRows(body: unknown): MetricRow[] {
  const out: MetricRow[] = [];
  for (const product of list(object(body).data)) {
    const value = object(product);
    const productId = text(value.nmID ?? value.nmId);
    if (!productId) continue;
    for (const entry of list(value.history)) {
      const row = object(entry);
      const day = dayOf(row.dt ?? row.date);
      if (!day) continue;
      out.push({
        productId,
        day,
        views: firstCount(row, 'impressions', 'impressionsCount'),
        clicks: firstCount(row, 'openCardCount', 'openCount'),
        carts: firstCount(row, 'addToCartCount', 'cartCount'),
        orders: firstCount(row, 'ordersCount', 'orderCount'),
      });
    }
  }
  return out;
}

// ── Ozon ────────────────────────────────────────────────────────────────────────────────────────────

/** The pictures of an item of POST /v3/product/info/list, main first, without repeats. */
export function ozonPictures(item: unknown): string[] {
  const value = object(item);
  const urls = [
    ...list(value.primary_image),
    ...(typeof value.primary_image === 'string' ? [value.primary_image] : []),
    ...list(value.images),
  ]
    .map(url => (typeof url === 'string' ? url : text(object(url).file_name ?? object(url).url)))
    .filter((url): url is string => !!url);
  return [...new Set(urls)];
}

/** An item of POST /v3/product/info/list: its product_id, the SKU its analytics count by, name, offer_id and pictures. */
export function ozonProduct(item: unknown): LoopProduct | null {
  const value = object(item);
  const productId = text(value.id ?? value.product_id);
  if (!productId || !/^\d{1,20}$/.test(productId)) return null;
  const source = list(value.sources)
    .map(object)
    .find(entry => text(entry.sku));
  const sku = text(value.sku) ?? text(source?.sku) ?? text(value.fbo_sku) ?? text(value.fbs_sku);
  const article = text(value.offer_id);
  return {
    productId,
    sku: sku && /^\d{1,20}$/.test(sku) ? sku : null,
    title: (text(value.name) ?? `Ozon product ${productId}`).slice(0, 300),
    article: article?.slice(0, 64) ?? null,
    photos: ozonPictures(value).length,
  };
}
export const ozonProducts = (body: unknown): LoopProduct[] =>
  list(object(body).items ?? object(object(body).result).items)
    .map(ozonProduct)
    .filter((product): product is LoopProduct => product !== null);

/** The product ids of POST /v3/product/list and the cursor to the next page. */
export function ozonProductIds(body: unknown): {ids: string[]; lastId: string | null} {
  const result = object(object(body).result);
  const ids = list(result.items)
    .map(item => text(object(item).product_id))
    .filter((id): id is string => !!id);
  return {ids, lastId: text(result.last_id)};
}

/** The pictures to import so that `url` takes slot `slot` (1 = main) and the others keep their order; at most 30. */
export function ozonPictureList(current: readonly string[], slot: number, url: string): string[] {
  const next = [...current];
  if (slot - 1 < next.length) next[slot - 1] = url;
  else next.push(url);
  return next.slice(0, 30);
}

/** POST /v1/product/pictures/import's answer: a picture refused at once fails; else Ozon processes it. */
export function ozonImportState(body: unknown, url: string): PublicationState {
  const pictures = list(object(object(body).result).pictures).map(object);
  const ours = pictures.find(picture => picture.url === url);
  const state = text(ours?.state)?.toLowerCase();
  if (state && /fail|error|reject/.test(state)) return {failed: 'Ozon did not accept the picture.'};
  return 'sent';
}

/**
 * POST /v2/product/pictures/info for one product: errors refuse it; pictures in place mean Ozon took it. Read both the v2 answer
 * (`items` with photo lists and `errors`) and the v1 one (`result.pictures` with a `state` each).
 */
export function ozonPictureState(body: unknown, productId: string): PublicationState {
  const value = object(body);
  const items = list(value.items ?? object(value.result).items).map(object);
  const item = items.find(entry => text(entry.product_id) === productId) ?? (items.length === 1 ? items[0] : undefined);
  const errors = [
    ...list(item?.errors),
    ...list(value.errors).filter(
      error => !text(object(error).product_id) || text(object(error).product_id) === productId,
    ),
  ];
  if (errors.length) {
    const first = object(errors[0]);
    return {
      failed:
        `Ozon did not accept the picture${text(first.message ?? first.error) ? `: ${text(first.message ?? first.error)}` : '.'}`.slice(
          0,
          480,
        ),
    };
  }
  if (item && [item.primary_photo, item.photo, item.photos].some(photos => list(photos).length > 0)) return 'live';
  const pictures = list(object(value.result).pictures).map(object);
  if (pictures.length) {
    const states = pictures.map(picture => text(picture.state)?.toLowerCase() ?? '');
    if (states.some(state => /fail|error|reject/.test(state))) return {failed: 'Ozon did not accept the picture.'};
    if (states.every(state => state === 'uploaded' || state === 'imported' || state === 'ok')) return 'live';
  }
  return 'sent';
}

/** The metrics Morfa asks Ozon's analytics for, in this order: impressions, card views, carts and units ordered. */
export const OZON_METRICS = ['hits_view', 'hits_view_pdp', 'hits_tocart', 'ordered_units'] as const;

/**
 * POST /v1/analytics/data by SKU and day: each row's `dimensions` are [sku, day] and its `metrics` follow OZON_METRICS. hits_view are
 * the impressions (views), hits_view_pdp the card views (clicks), hits_tocart the carts, ordered_units the orders. Rows of SKUs not
 * linked are left out.
 */
export function ozonAnalyticsRows(body: unknown, productOfSku: ReadonlyMap<string, string>): MetricRow[] {
  const out: MetricRow[] = [];
  for (const entry of list(object(object(body).result).data)) {
    const row = object(entry);
    const dimensions = list(row.dimensions).map(object);
    const sku = text(dimensions[0]?.id);
    const day = dayOf(dimensions[1]?.id);
    const productId = sku ? productOfSku.get(sku) : undefined;
    if (!productId || !day) continue;
    const metrics = list(row.metrics);
    out.push({
      productId,
      day,
      views: count(metrics[0]),
      clicks: count(metrics[1]),
      carts: count(metrics[2]),
      orders: count(metrics[3]),
    });
  }
  return out;
}
