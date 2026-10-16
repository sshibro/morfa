// Ozon's Seller API (docs.ozon.ru/api/seller): Client-Id and Api-Key. Products are read by id lists (it has no text search, so a
// search reads the first thousand products and filters their names and articles here); pictures are imported by link and confirmed
// later; the analytics count by SKU and day, about one request a minute. What the answers mean is ./mapping.ts.
import {
  callMarketplace,
  MarketplaceError,
  type MarketplaceAdapter,
  type MarketplaceSecret,
  type OzonSecret,
} from './adapters';
import {
  OZON_METRICS,
  ozonAnalyticsRows,
  ozonImportState,
  ozonPictureList,
  ozonPictures,
  ozonPictureState,
  ozonProductIds,
  ozonProducts,
} from './mapping';

const API = 'https://api-seller.ozon.ru';
const NAME = 'Ozon';
const ANALYTICS_PAGE = 1000;
const ANALYTICS_PAGES = 10;
/** Ozon's analytics: about one request a minute. */
const ANALYTICS_SPACING_MS = 61_000;

const post = (secret: MarketplaceSecret, path: string, body: unknown) => {
  if (secret.kind !== 'ozon') throw Error('Not an Ozon key.');
  const {clientId, apiKey} = secret as OzonSecret;
  return callMarketplace(NAME, API + path, {
    method: 'POST',
    headers: {'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
};
const productIds = async (secret: MarketplaceSecret, limit: number) =>
  ozonProductIds(await post(secret, '/v3/product/list', {filter: {visibility: 'ALL'}, last_id: '', limit})).ids;
const info = (secret: MarketplaceSecret, filter: {product_id?: string[]; sku?: string[]; offer_id?: string[]}) =>
  post(secret, '/v3/product/info/list', {product_id: [], sku: [], offer_id: [], ...filter});

export const ozonAdapter: MarketplaceAdapter = {
  async check(secret) {
    await productIds(secret, 1);
  },
  async search(secret, query) {
    const wanted = query.trim().toLowerCase();
    if (/^\d{1,20}$/.test(wanted)) {
      const exact = await ozonAdapter.product(secret, wanted);
      if (exact) return [exact];
    }
    const ids = await productIds(secret, 1000);
    if (!ids.length) return [];
    const products = ozonProducts(await info(secret, {product_id: ids}));
    return products
      .filter(
        product =>
          !wanted || product.title.toLowerCase().includes(wanted) || product.article?.toLowerCase().includes(wanted),
      )
      .slice(0, 20);
  },
  async product(secret, productId) {
    const byId = ozonProducts(await info(secret, {product_id: [productId]}));
    if (byId.length) return byId[0]!;
    // A pasted number may be the SKU shown on the storefront.
    const bySku = ozonProducts(await info(secret, {sku: [productId]}));
    return bySku[0] ?? null;
  },
  async publish(secret, upload) {
    // pictures/import replaces the whole list: read the product's pictures, put ours into the slot, send them all in order.
    const body = (await info(secret, {product_id: [upload.productId]})) as {items?: unknown[]};
    const current = ozonPictures((body?.items ?? [])[0]);
    const images = ozonPictureList(current, upload.slot, upload.url);
    const answer = await post(secret, '/v1/product/pictures/import', {product_id: Number(upload.productId), images});
    const state = ozonImportState(answer, upload.url);
    if (typeof state === 'object') throw new MarketplaceError('failed', state.failed);
    return {state: 'sent', externalRef: upload.url.slice(0, 200)};
  },
  async publication(secret, ref) {
    return ozonPictureState(
      await post(secret, '/v2/product/pictures/info', {product_id: [ref.productId]}),
      ref.productId,
    );
  },
  async numbers(secret, query) {
    const productOfSku = new Map<string, string>();
    for (const product of query.products) if (product.sku) productOfSku.set(product.sku, product.productId);
    if (!productOfSku.size) return [];
    const rows = [];
    for (let page = 0; page < ANALYTICS_PAGES; page++) {
      if (page) await query.pause(ANALYTICS_SPACING_MS);
      const body = await post(secret, '/v1/analytics/data', {
        date_from: query.from,
        date_to: query.to,
        metrics: OZON_METRICS,
        dimension: ['sku', 'day'],
        filters: [],
        sort: [{key: 'hits_view', order: 'DESC'}],
        limit: ANALYTICS_PAGE,
        offset: page * ANALYTICS_PAGE,
      });
      rows.push(...ozonAnalyticsRows(body, productOfSku));
      const received = ((body as {result?: {data?: unknown[]}})?.result?.data ?? []).length;
      if (received < ANALYTICS_PAGE) break;
    }
    return rows;
  },
};
