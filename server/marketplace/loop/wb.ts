// Wildberries' seller API (dev.wildberries.ru): one token with the Content and Analytics categories. Products and photos are
// content-api's; the daily funnel is seller-analytics-api's, three requests a minute. What the answers mean is ./mapping.ts.
import type {LoopProduct} from '../../../shared/design/marketplace/loop';
import {
  callMarketplace,
  MarketplaceError,
  type MarketplaceAdapter,
  type MarketplaceSecret,
  type WbSecret,
} from './adapters';
import {WB_ANALYTICS_SPACING_MS} from './config';
import {wbHistoryRows, wbProducts} from './mapping';

const CONTENT = 'https://content-api.wildberries.ru';
const ANALYTICS = 'https://seller-analytics-api.wildberries.ru';
const NAME = 'Wildberries';
/** nmIDs one funnel request takes. */
const NM_PER_CALL = 20;

const tokenOf = (secret: MarketplaceSecret): string => {
  if (secret.kind !== 'wb') throw Error('Not a Wildberries key.');
  return (secret as WbSecret).token;
};
const json = (secret: MarketplaceSecret, body: unknown): RequestInit => ({
  method: 'POST',
  headers: {Authorization: tokenOf(secret), 'Content-Type': 'application/json'},
  body: JSON.stringify(body),
});
const cards = async (secret: MarketplaceSecret, search: string, limit: number): Promise<LoopProduct[]> =>
  wbProducts(
    await callMarketplace(
      NAME,
      `${CONTENT}/content/v2/get/cards/list`,
      json(secret, {settings: {cursor: {limit}, filter: {...(search ? {textSearch: search} : {}), withPhoto: -1}}}),
    ),
  );

export const wbAdapter: MarketplaceAdapter = {
  async check(secret) {
    // The content half by a one-card read; the analytics half by its ping (a 404 there only means the ping moved).
    await cards(secret, '', 1);
    try {
      await callMarketplace(NAME, `${ANALYTICS}/ping`, {headers: {Authorization: tokenOf(secret)}});
    } catch (error) {
      if (error instanceof MarketplaceError && error.kind === 'refused')
        throw new MarketplaceError(
          'refused',
          'The token has no access to analytics. Create a token with the categories "Content" and "Analytics".',
        );
      if (error instanceof MarketplaceError && error.kind === 'rate') throw error;
    }
  },
  search: (secret, query) => cards(secret, query, 20),
  async product(secret, productId) {
    return (await cards(secret, productId, 10)).find(product => product.productId === productId) ?? null;
  },
  async publish(secret, upload) {
    // content/v3/media/file: one file into the photo number given; a number already taken is replaced, the rest stay.
    const form = new FormData();
    form.append('uploadfile', new Blob([new Uint8Array(upload.bytes)], {type: upload.contentType}), upload.filename);
    await callMarketplace(NAME, `${CONTENT}/content/v3/media/file`, {
      method: 'POST',
      headers: {Authorization: tokenOf(secret), 'X-Nm-Id': upload.productId, 'X-Photo-Number': String(upload.slot)},
      body: form,
    });
    return {state: 'live', externalRef: null};
  },
  // The upload above is final; nothing to confirm.
  publication: async () => 'live',
  async numbers(secret, query) {
    const ids = [...new Set(query.products.map(product => Number(product.productId)).filter(Number.isSafeInteger))];
    const rows = [];
    for (let i = 0; i < ids.length; i += NM_PER_CALL) {
      if (i) await query.pause(WB_ANALYTICS_SPACING_MS);
      const body = await callMarketplace(
        NAME,
        `${ANALYTICS}/api/v2/nm-report/detail/history`,
        json(secret, {
          nmIDs: ids.slice(i, i + NM_PER_CALL),
          period: {begin: query.from, end: query.to},
          timezone: 'Europe/Moscow',
          aggregationLevel: 'day',
        }),
      );
      rows.push(...wbHistoryRows(body));
    }
    return rows;
  },
};
