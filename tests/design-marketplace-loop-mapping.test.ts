import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ozonAnalyticsRows,
  ozonImportState,
  ozonPictureList,
  ozonPictures,
  ozonPictureState,
  ozonProduct,
  ozonProductIds,
  wbHistoryRows,
  wbProduct,
  wbProducts,
} from '../server/marketplace/loop/mapping';
import {count, marketplaceMessage} from '../server/marketplace/loop/adapters';
import {createFakeMarketplaces, FAKE_PRODUCTS} from '../server/marketplace/loop/fake';

// What Morfa reads out of Wildberries' and Ozon's answers (server/marketplace/loop/mapping.ts): each field mapping on the answer's
// documented shape, and what a missing or malformed field becomes (null, never a guess).

test('should read WB funnel days: card opens are clicks, carts and orders as named, no impressions unless a day has them', () => {
  const rows = wbHistoryRows({
    data: [
      {
        nmID: 187654321,
        imtName: 'Mug',
        vendorCode: 'MUG-350',
        history: [
          {dt: '2026-10-10', openCardCount: 812, addToCartCount: 95, addToCartConversion: 11, ordersCount: 31, ordersSumRub: 15500, buyoutsCount: 20},
          {dt: '2026-10-11T00:00:00', openCardCount: '700', addToCartCount: 80, ordersCount: null, impressions: 21_400},
          {dt: 'not a day', openCardCount: 5},
        ],
      },
      {history: [{dt: '2026-10-10', openCardCount: 1}]},
    ],
    error: false,
    errorText: '',
  });
  assert.deepEqual(rows, [
    {productId: '187654321', day: '2026-10-10', views: null, clicks: 812, carts: 95, orders: 31},
    {productId: '187654321', day: '2026-10-11', views: 21_400, clicks: 700, carts: 80, orders: null},
  ]);
  // WB's newer names for the same fields.
  assert.deepEqual(wbHistoryRows({data: [{nmId: 5, history: [{date: '2026-10-12', openCount: 3, cartCount: 2, orderCount: 1}]}]}), [
    {productId: '5', day: '2026-10-12', views: null, clicks: 3, carts: 2, orders: 1},
  ]);
  assert.deepEqual(wbHistoryRows(null), []);
  assert.deepEqual(wbHistoryRows({data: 'nope'}), []);
});

test('should read WB cards: the nmID, the seller article, the title and how many photos', () => {
  assert.deepEqual(
    wbProduct({nmID: 187654321, imtID: 1, vendorCode: 'MUG-350', title: 'Ceramic mug', photos: [{big: 'x'}, {big: 'y'}]}),
    {productId: '187654321', sku: null, title: 'Ceramic mug', article: 'MUG-350', photos: 2},
  );
  assert.equal(wbProduct({nmID: 'abc'}), null);
  assert.equal(wbProduct({nmID: 7, subjectName: 'Mugs'})!.title, 'Mugs');
  assert.equal(wbProduct({nmID: 7})!.title, 'WB article 7');
  assert.equal(wbProducts({cards: [{nmID: 1}, {nope: true}], cursor: {total: 2}}).length, 1);
});

test('should read Ozon products: product_id, the SKU its analytics count by, name, offer_id and pictures main first', () => {
  const item = {
    id: 612345,
    name: 'Ceramic mug 350 ml',
    offer_id: 'MUG-350',
    sources: [{source: 'sds', sku: 1876543210}],
    primary_image: ['https://cdn1.ozone.ru/main.jpg'],
    images: ['https://cdn1.ozone.ru/main.jpg', 'https://cdn1.ozone.ru/2.jpg', 'https://cdn1.ozone.ru/3.jpg'],
  };
  assert.deepEqual(ozonProduct(item), {productId: '612345', sku: '1876543210', title: 'Ceramic mug 350 ml', article: 'MUG-350', photos: 3});
  assert.deepEqual(ozonPictures(item), ['https://cdn1.ozone.ru/main.jpg', 'https://cdn1.ozone.ru/2.jpg', 'https://cdn1.ozone.ru/3.jpg']);
  assert.equal(ozonProduct({id: 1, sku: 99, fbo_sku: 5})!.sku, '99', 'a top-level SKU (older answers) is read too');
  assert.equal(ozonProduct({id: 'x'}), null);
  assert.deepEqual(ozonProductIds({result: {items: [{product_id: 1, offer_id: 'a'}, {product_id: 2}], total: 2, last_id: 'WzJd'}}), {ids: ['1', '2'], lastId: 'WzJd'});
});

test('should put the new picture into its slot and keep the others in order', () => {
  const current = ['m.jpg', '2.jpg', '3.jpg'];
  assert.deepEqual(ozonPictureList(current, 1, 'new.jpg'), ['new.jpg', '2.jpg', '3.jpg']);
  assert.deepEqual(ozonPictureList(current, 3, 'new.jpg'), ['m.jpg', '2.jpg', 'new.jpg']);
  assert.deepEqual(ozonPictureList(current, 9, 'new.jpg'), ['m.jpg', '2.jpg', '3.jpg', 'new.jpg'], 'a slot past the end is added last');
  assert.equal(ozonPictureList(Array.from({length: 30}, (_, i) => `${i}.jpg`), 31, 'new.jpg').length, 30, 'at most 30');
});

test("should read Ozon's picture states: refused at import, errors later, pictures in place", () => {
  assert.equal(ozonImportState({result: {pictures: [{url: 'u', state: 'imported', is_primary: true}]}}, 'u'), 'sent');
  assert.deepEqual(ozonImportState({result: {pictures: [{url: 'u', state: 'failed'}]}}, 'u'), {failed: 'Ozon did not accept the picture.'});
  assert.equal(ozonPictureState({items: [{product_id: 612345, primary_photo: ['a'], photo: ['b'], color_photo: [], photo_360: []}]}, '612345'), 'live');
  assert.equal(ozonPictureState({items: [{product_id: 612345, primary_photo: [], photo: []}]}, '612345'), 'sent');
  assert.deepEqual(ozonPictureState({items: [{product_id: 612345, errors: [{message: 'size is below 200 px'}]}]}, '612345'), {
    failed: 'Ozon did not accept the picture: size is below 200 px',
  });
  assert.equal(ozonPictureState({result: {pictures: [{product_id: 612345, state: 'uploaded', url: 'x'}]}}, '612345'), 'live', 'the v1 answer');
  assert.equal(ozonPictureState({}, '1'), 'sent');
});

test('should read Ozon analytics by SKU and day: impressions, card views, carts, units ordered; other SKUs left out', () => {
  const rows = ozonAnalyticsRows(
    {
      result: {
        data: [
          {dimensions: [{id: '1876543210', name: 'Mug'}, {id: '2026-10-10', name: ''}], metrics: [15_000, 420, 61, 18]},
          {dimensions: [{id: '1876543210'}, {id: '2026-10-11'}], metrics: [14_000, 390]},
          {dimensions: [{id: '999'}, {id: '2026-10-10'}], metrics: [1, 1, 1, 1]},
          {dimensions: [{id: '1876543210'}], metrics: [1, 1, 1, 1]},
        ],
        totals: [],
      },
    },
    new Map([['1876543210', '612345']]),
  );
  assert.deepEqual(rows, [
    {productId: '612345', day: '2026-10-10', views: 15_000, clicks: 420, carts: 61, orders: 18},
    {productId: '612345', day: '2026-10-11', views: 14_000, clicks: 390, carts: null, orders: null},
  ]);
});

test('should read counts and the marketplaces’ own error words leniently', () => {
  assert.deepEqual([count(5), count('12'), count(-1), count('x'), count(null), count(2.6)], [5, 12, null, null, null, 3]);
  assert.equal(marketplaceMessage({error: true, errorText: 'Invalid token'}), 'Invalid token');
  assert.equal(marketplaceMessage({code: 7, message: 'Invalid Api-Key'}), 'Invalid Api-Key');
  assert.equal(marketplaceMessage('text'), '');
});

test('should answer through the fake marketplaces with the real readers, and refuse a «bad» key', async () => {
  const fake = createFakeMarketplaces();
  const wb = {kind: 'wb' as const, token: 'e2e-token-1234567890123'};
  await fake.adapters.wb.check(wb);
  await assert.rejects(fake.adapters.wb.check({kind: 'wb', token: 'bad-token-1234567890'}), {kind: 'refused'});
  assert.deepEqual((await fake.adapters.wb.search(wb, 'mug')).map(product => product.productId), ['187654321', '187654322']);
  fake.setNumbers((_marketplace, _productId, day) => (day === '2026-10-11' ? {views: 1000, clicks: 31, carts: 4, orders: 2} : null));
  const pause = async () => {};
  assert.deepEqual(await fake.adapters.wb.numbers(wb, {products: [{productId: '187654321', sku: null}], from: '2026-10-10', to: '2026-10-12', pause}), [
    {productId: '187654321', day: '2026-10-11', views: 1000, clicks: 31, carts: 4, orders: 2},
  ]);
  const ozon = {kind: 'ozon' as const, clientId: '1234', apiKey: 'key-123456'};
  const product = FAKE_PRODUCTS.ozon[0]!;
  assert.deepEqual(await fake.adapters.ozon.numbers(ozon, {products: [{productId: product.productId, sku: product.sku}], from: '2026-10-11', to: '2026-10-11', pause}), [
    {productId: product.productId, day: '2026-10-11', views: 1000, clicks: 31, carts: 4, orders: 2},
  ]);
  fake.failNext('ozon', 'rate');
  await assert.rejects(fake.adapters.ozon.search(ozon, ''), {kind: 'rate'});
});
