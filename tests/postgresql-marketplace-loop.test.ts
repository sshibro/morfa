import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {bootPostgresqlApp, type AppFixture} from './helpers/app-fixture';
import {createDocument, createNode} from '../shared/design/defaults';
import type {FakeMarketplaces} from '../server/marketplace/loop/fake';

// The Performance Loop through the whole application on a fresh database (docs/marketplaces.md §Performance Loop), against the fake
// Wildberries: the switch and the plan, a key checked, encrypted and never returned, a card linked to a product, publishing and the
// live picture's hours, the worker's sync (upsert, a refused key, 429), a rotation swapped at Moscow midnight and judged, a cabinet
// test's lifecycle, sweeping, and the account's erasure with its picture files.

let fixture: AppFixture;
let fake: FakeMarketplaces;
let loop: {
  advance(ms: number): void;
  now(): number;
  tick(force?: boolean): Promise<void>;
};
const KEY = randomBytes(32).toString('hex');
const SWITCHES = {ENABLE_DESIGN_TOOL: '1', ENABLE_MARKETPLACE_API: '1', HOSTING_ENCRYPTION_KEY: KEY};
const saved = Object.fromEntries(['APP_ORIGIN', 'HOSTING_KEY_VERSION', ...Object.keys(SWITCHES)].map(key => [key, process.env[key]]));
const HOUR = 3_600_000;

before(async () => {
  delete process.env.APP_ORIGIN;
  delete process.env.HOSTING_KEY_VERSION;
  fixture = await bootPostgresqlApp({env: SWITCHES});
  const [{createFakeMarketplaces}, {useMarketplaceFake}, clock, worker] = await Promise.all([
    import('../server/marketplace/loop/fake'),
    import('../server/marketplace/loop/adapters'),
    import('../server/marketplace/loop/clock'),
    import('../server/marketplace/loop/worker'),
  ]);
  fake = createFakeMarketplaces();
  useMarketplaceFake(fake.adapters);
  loop = {
    advance: clock.advanceLoopClock,
    now: clock.loopNow,
    tick: force => worker.runMarketplaceLoopTick({force}),
  };
});
after(async () => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  await fixture?.close();
});

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
type Person = {id: string; cookie: string};
async function person(label: string): Promise<Person> {
  const id = randomUUID(),
    token = randomUUID();
  await fixture.db.execute("INSERT INTO users(id,email,name,password,email_verified) VALUES($1,$2,'Seller','',1)", [
    id,
    `${label}-${id}@example.test`,
  ]);
  await fixture.db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [digest(token), id, Date.now() + 3_600_000]);
  return {id, cookie: `forma_session=${token}`};
}
async function call(who: Person, method: string, url: string, body?: unknown) {
  const response = await fetch(fixture.base + '/api' + url, {
    method,
    headers: {cookie: who.cookie, ...(body !== undefined && !(body instanceof FormData) ? {'content-type': 'application/json'} : {})},
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : null, text};
}
/** A JPEG as far as the server looks (its signature), told apart by `mark`. */
const jpeg = (mark: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF ' + mark + ' '.repeat(64))]);
const form = (fields: Record<string, string>, files: Record<string, Buffer> = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  for (const [key, bytes] of Object.entries(files)) data.append(key, new Blob([new Uint8Array(bytes)], {type: 'image/jpeg'}), key + '.jpg');
  return data;
};
const card = {'morfa.mp.card': JSON.stringify({v: 1, marketplace: 'wb', group: 'g-1'})};
async function cardFile(who: Person): Promise<string> {
  const doc = createDocument('0:1', 'Cards');
  doc.nodes['1:1'] = {...createNode('FRAME', {id: '1:1', name: 'Cover A', parentId: '0:1', x: 0, y: 0, width: 900, height: 1200}), pluginData: card};
  doc.nodes['1:2'] = {...createNode('FRAME', {id: '1:2', name: 'Cover B', parentId: '0:1', x: 1000, y: 0, width: 900, height: 1200}), pluginData: card};
  doc.nodes['0:1'] = {...doc.nodes['0:1']!, children: ['1:1', '1:2']};
  const created = await call(who, 'POST', '/design-files', {name: 'Mug', document: doc});
  assert.equal(created.status, 201, created.text);
  return created.body.file.id;
}
/** The fake WB reports `numbers[frame]` on each day that frame was the slot's live picture (as the real one would). */
async function reportByFrame(numbers: Record<string, {views: number | null; clicks: number; carts: number; orders: number}>) {
  const [{spansOf}, {frameOfDay}] = await Promise.all([import('../server/marketplace/loop/numbers'), import('../shared/design/marketplace/loop-stats')]);
  fake.setNumbers(async (_marketplace, productId, day) => {
    const rows = await fixture.db.many<{node_id: string; live_from: string | null; live_until: string | null}>(
      `SELECT p.node_id,p.live_from,p.live_until FROM marketplace_publications p JOIN marketplace_card_links l ON l.id=p.link_id
        WHERE l.product_id=$1 AND p.live_from IS NOT NULL`,
      [productId],
    );
    const frame = frameOfDay(spansOf(rows), day, loop.now());
    return frame ? (numbers[frame] ?? null) : null;
  });
}
/** Moves the loop's clock in three-hour steps (the worker's passes are every 15 minutes; a step is enough to swap and sync). */
async function live(hours: number) {
  for (let done = 0; done < hours; done += 3) {
    loop.advance(3 * HOUR);
    await loop.tick();
  }
}

test('PostgreSQL marketplace loop: off by the switch, the key checked, sealed and never returned', {timeout: 120000}, async () => {
  const seller = await person('seller');
  const other = await person('other');
  assert.deepEqual((await call(seller, 'GET', '/marketplace/loop')).body, {on: true});
  process.env.ENABLE_MARKETPLACE_API = '0';
  assert.equal((await call(seller, 'GET', '/marketplace/loop')).status, 404, 'off: not a route');
  process.env.ENABLE_MARKETPLACE_API = '1';

  delete process.env.HOSTING_ENCRYPTION_KEY;
  const unsealed = await call(seller, 'POST', '/marketplace/connections', {marketplace: 'wb', token: 'e2e-token-1234567890123456'});
  assert.equal(unsealed.status, 503);
  assert.match(unsealed.body.error, /secure storage/);
  assert.equal(fake.calls.length, 0, 'nothing is sent to the marketplace without the server key');
  process.env.HOSTING_ENCRYPTION_KEY = KEY;

  const bad = await call(seller, 'POST', '/marketplace/connections', {marketplace: 'wb', token: 'bad-token-1234567890123456'});
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'key_refused');
  assert.equal((await call(seller, 'POST', '/marketplace/connections', {marketplace: 'wb', token: 'short'})).status, 400);

  const token = 'e2e-token-secret-7f3a91c2b4';
  const made = await call(seller, 'POST', '/marketplace/connections', {marketplace: 'wb', token});
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.connection.hint, '…c2b4');
  assert.equal(made.body.connection.label, 'Wildberries …c2b4');
  assert.ok(!made.text.includes(token), 'the answer never carries the key');
  const listed = await call(seller, 'GET', '/marketplace/connections');
  assert.equal(listed.body.connections.length, 1);
  assert.ok(!listed.text.includes(token) && !listed.text.includes('secret'));
  const row = (await fixture.db.one<{secret: string}>('SELECT secret FROM marketplace_connections WHERE user_id=$1', [seller.id]))!;
  assert.ok(!row.secret.includes(token), 'stored encrypted');
  const {decrypt} = await import('../server/hosting/secrets');
  assert.deepEqual(decrypt(row.secret, `marketplace:${seller.id}`), {kind: 'wb', token});
  assert.throws(() => decrypt(row.secret, `marketplace:${other.id}`), 'bound to its account');
  assert.equal((await call(other, 'DELETE', `/marketplace/connections/${made.body.connection.id}`)).status, 404, "another account's");
});

test('PostgreSQL marketplace loop: link, publish, sync, numbers per live frame, a rotation judged, a cabinet test, erasure', {timeout: 180000}, async () => {
  const seller = await person('rotation');
  const stranger = await person('stranger');
  const connection = (await call(seller, 'POST', '/marketplace/connections', {marketplace: 'wb', token: 'e2e-token-rotation-000001'})).body.connection;
  const fileId = await cardFile(seller);
  const found = await call(seller, 'GET', `/marketplace/connections/${connection.id}/products?q=${encodeURIComponent('ceramic mu')}`);
  assert.deepEqual(found.body.products.map((product: {productId: string}) => product.productId), ['187654321']);

  // ── Link: the product as the marketplace knows it; a stranger cannot link into the file ──
  const linkInput = {fileId, nodeId: '1:1', connectionId: connection.id, productId: '187654321', slot: 1};
  assert.equal((await call(seller, 'POST', '/marketplace/links', {...linkInput, productId: '555'})).status, 404);
  const strangerConnection = (await call(stranger, 'POST', '/marketplace/connections', {marketplace: 'wb', token: 'e2e-token-stranger-000001'})).body.connection;
  assert.equal((await call(stranger, 'POST', '/marketplace/links', {...linkInput, connectionId: strangerConnection.id})).status, 404);
  const linked = await call(seller, 'POST', '/marketplace/links', linkInput);
  assert.equal(linked.status, 201, linked.text);
  const link = linked.body.link;
  assert.equal(link.title, 'Ceramic mug 350 ml');
  // A co-editor of the file cannot take the seller's frame over to their own store.
  await fixture.db.execute("INSERT INTO design_file_members(file_id,user_id,role,invited_by) VALUES($1,$2,'editor',$3)", [fileId, stranger.id, seller.id]);
  const taken = await call(stranger, 'POST', '/marketplace/links', {...linkInput, connectionId: strangerConnection.id});
  assert.equal(taken.status, 409, taken.text);
  assert.equal((await fixture.db.one<{user_id: string}>('SELECT user_id FROM marketplace_card_links WHERE id=$1', [link.id]))!.user_id, seller.id);
  await fixture.db.execute('DELETE FROM design_file_members WHERE file_id=$1 AND user_id=$2', [fileId, stranger.id]);

  // ── Publish: the picture goes to WB's slot 1 and is live; its public link serves it ──
  const first = await call(seller, 'POST', '/marketplace/publish', form({linkId: link.id}, {image: jpeg('A1')}));
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.publication.status, 'live');
  assert.deepEqual(fake.uploads.at(-1)!.slot, 1);
  const url = new URL(fake.uploads.at(-1)!.url);
  const served = await fetch(fixture.base + url.pathname);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), jpeg('A1'));
  assert.equal((await fetch(fixture.base + url.pathname.replace(/.{4}\.jpg$/, 'zzzz.jpg'))).status, 404);
  assert.equal((await call(seller, 'POST', '/marketplace/publish', form({linkId: link.id}, {image: Buffer.from('GIF89a…')}))).status, 415);
  const again = await call(seller, 'POST', '/marketplace/publish', form({linkId: link.id}, {image: jpeg('A2')}));
  const rows = await fixture.db.many<{id: string; status: string; live_from: string | null; live_until: string | null}>(
    'SELECT id,status,live_from,live_until FROM marketplace_publications WHERE link_id=$1 ORDER BY requested_at',
    [link.id],
  );
  assert.deepEqual(rows.map(row => row.status), ['replaced', 'live']);
  assert.equal(rows[0]!.live_until, rows[1]!.live_from, 'the new picture closes the old one’s hours');
  assert.equal(again.body.publication.id, rows[1]!.id);

  // ── Sync: two days later the worker reads the numbers; the frame shows its live days ──
  await reportByFrame({'1:1': {views: null, clicks: 400, carts: 40, orders: 10}});
  loop.advance(48 * HOUR);
  await loop.tick(true);
  const stored = await fixture.db.many<{day: string; clicks: number; views: number | null}>(
    'SELECT day,clicks,views FROM marketplace_metrics WHERE connection_id=$1 ORDER BY day',
    [connection.id],
  );
  assert.ok(stored.length >= 1 && stored.every(row => row.clicks === 400 && row.views === null), JSON.stringify(stored));
  await reportByFrame({'1:1': {views: 10_000, clicks: 310, carts: 40, orders: 10}});
  await loop.tick(true);
  const upserted = await fixture.db.many<{clicks: number; views: number}>('SELECT clicks,views FROM marketplace_metrics WHERE connection_id=$1', [connection.id]);
  assert.equal(upserted.length, stored.length, 'the same days, updated');
  assert.ok(upserted.every(row => row.clicks === 310 && row.views === 10_000));
  let cards = (await call(seller, 'GET', `/marketplace/files/${fileId}/cards`)).body;
  const frame = cards.frames.find((entry: {nodeId: string}) => entry.nodeId === '1:1');
  assert.ok(frame.days >= 1);
  assert.equal(frame.totals.clicks, 310 * frame.days);
  assert.equal(frame.productWide, false);
  assert.equal(cards.links.length, 1);
  assert.equal((await call(stranger, 'GET', `/marketplace/files/${fileId}/cards`)).status, 404, "not the stranger's file");

  // ── A rotation: A then B at Moscow midnight, judged six hours after its end; B's CTR is three times A's ──
  await reportByFrame({'1:1': {views: 1000, clicks: 20, carts: 2, orders: 1}, '1:2': {views: 1000, clicks: 60, carts: 6, orders: 3}});
  const uploadsBefore = fake.uploads.length;
  const started = await call(seller, 'POST', '/marketplace/tests', form({linkId: link.id, variantB: '1:2', mode: 'rotation', days: '4', swapHours: '24'}, {a: jpeg('A'), b: jpeg('B')}));
  assert.equal(started.status, 201, started.text);
  const rotation = started.body.test;
  assert.deepEqual([rotation.status, rotation.liveVariant, rotation.mode], ['running', 'a', 'rotation']);
  assert.equal(fake.uploads.length, uploadsBefore + 1, 'A goes out at once');
  const busy = await call(seller, 'POST', '/marketplace/tests', form({linkId: link.id, variantB: '1:2', mode: 'cabinet', days: '14'}));
  assert.equal(busy.status, 409, 'one test at a time per card');
  const swapAt = Date.parse(rotation.nextSwapAt);
  assert.equal(new Date(swapAt + 3 * HOUR).toISOString().slice(11, 19), '00:00:00', 'the first swap is at Moscow midnight');
  // To the minute of the swap, so the three-hour steps below land on midnights (the real worker passes every 15 minutes).
  loop.advance(swapAt - loop.now());
  await loop.tick();
  let row = (await fixture.db.one<{live_variant: string}>('SELECT live_variant FROM marketplace_tests WHERE id=$1', [rotation.id]))!;
  assert.equal(row.live_variant, 'b', 'swapped at midnight');
  assert.deepEqual(fake.uploads.at(-1)!.sha256, createHash('sha256').update(jpeg('B')).digest('hex'), 'B’s own picture');
  await live(24);
  row = (await fixture.db.one<{live_variant: string}>('SELECT live_variant FROM marketplace_tests WHERE id=$1', [rotation.id]))!;
  assert.equal(row.live_variant, 'a', 'and back at the next midnight');
  cards = (await call(seller, 'GET', `/marketplace/files/${fileId}/cards`)).body;
  const standing = cards.tests.find((entry: {id: string}) => entry.id === rotation.id);
  assert.deepEqual([standing.result.a.days, standing.result.b.days], [1, 1], 'the running test shows its standing over whole days');
  await live(4 * 24);
  const finished = (await fixture.db.one<{status: string; winner: string; live_variant: string; result: {metric: string; p: number; a: {days: number}; b: {days: number}}}>(
    'SELECT status,winner,live_variant,result FROM marketplace_tests WHERE id=$1',
    [rotation.id],
  ))!;
  assert.deepEqual([finished.status, finished.winner, finished.result.metric], ['finished', 'b', 'ctr']);
  assert.ok(finished.result.p < 0.05);
  assert.equal(finished.result.b.days, 2);
  assert.ok(finished.result.a.days >= 2);
  assert.equal(finished.live_variant, 'b', 'the winner is left live');
  const lastPublication = (await fixture.db.one<{node_id: string; status: string}>(
    "SELECT node_id,status FROM marketplace_publications WHERE link_id=$1 AND status='live'",
    [link.id],
  ))!;
  assert.equal(lastPublication.node_id, '1:2');
  cards = (await call(seller, 'GET', `/marketplace/files/${fileId}/cards`)).body;
  assert.equal(cards.tests[0].winner, 'b');

  // ── "Next round from the winner": the link follows the winner; a stopped rotation showing B puts A back ──
  const moved = await call(seller, 'POST', `/marketplace/links/${link.id}/node`, {nodeId: '1:2'});
  assert.equal(moved.body.link.nodeId, '1:2');
  await call(seller, 'POST', `/marketplace/links/${link.id}/node`, {nodeId: '1:1'});
  const second = (await call(seller, 'POST', '/marketplace/tests', form({linkId: link.id, variantB: '1:2', mode: 'rotation', days: '3', swapHours: '24'}, {a: jpeg('A'), b: jpeg('B')}))).body.test;
  await live(Math.ceil((Date.parse(second.nextSwapAt) - loop.now()) / HOUR) + 1);
  const stopped = await call(seller, 'POST', `/marketplace/tests/${second.id}/stop`);
  assert.equal(stopped.body.test.status, 'stopped');
  assert.equal(stopped.body.test.liveVariant, 'a', 'A is back');
  assert.equal(fake.uploads.at(-1)!.sha256, createHash('sha256').update(jpeg('A')).digest('hex'));

  // ── A cabinet test: planned, started on a day, finished with the winner the seller enters ──
  const cabinet = (await call(seller, 'POST', '/marketplace/tests', form({linkId: link.id, variantB: '1:2', mode: 'cabinet', days: '14'}))).body.test;
  assert.deepEqual([cabinet.status, cabinet.startedAt, cabinet.liveVariant], ['planned', null, null]);
  const day = new Date(loop.now() + 3 * HOUR).toISOString().slice(0, 10);
  const running = (await call(seller, 'POST', `/marketplace/tests/${cabinet.id}/start`, {startedOn: day})).body.test;
  assert.equal(running.status, 'running');
  assert.equal(Date.parse(running.endsAt) - Date.parse(running.startedAt), 14 * 24 * HOUR);
  assert.equal((await call(seller, 'POST', `/marketplace/tests/${cabinet.id}/start`, {startedOn: day})).status, 409);
  const won = (await call(seller, 'POST', `/marketplace/tests/${cabinet.id}/winner`, {winner: 'a'})).body.test;
  assert.deepEqual([won.status, won.winner], ['finished', 'a']);

  // ── A refused key stops the syncs until the seller enters it again; 429 backs off ──
  fake.failNext('wb', 'refused');
  await loop.tick(true);
  assert.equal((await call(seller, 'GET', '/marketplace/connections')).body.connections[0].status, 'refused');
  const calls = fake.calls.length;
  loop.advance(4 * HOUR);
  await loop.tick();
  assert.equal(fake.calls.filter(entry => entry.endsWith('numbers')).length, fake.calls.slice(0, calls).filter(entry => entry.endsWith('numbers')).length, 'no sync while refused');
  const back = await call(seller, 'POST', `/marketplace/connections/${connection.id}/key`, {token: 'e2e-token-rotation-000002'});
  assert.equal(back.body.connection.status, 'ok');
  assert.equal(back.body.connection.hint, '…0002');
  fake.failNext('wb', 'rate');
  await loop.tick();
  const rated = fake.calls.length;
  loop.advance(10 * 60_000);
  await loop.tick();
  assert.equal(fake.calls.slice(rated).filter(entry => entry === 'wb numbers').length, 0, 'backing off after 429');

  // ── Sweeping: numbers older than 400 days and expired pictures ──
  await fixture.db.execute("INSERT INTO marketplace_metrics(connection_id,product_id,day,clicks) VALUES($1,'187654321','2024-01-01',1)", [connection.id]);
  const mediaDir = path.join(fixture.dataDir, 'marketplace-media');
  fs.writeFileSync(path.join(mediaDir, 'expired.jpg'), jpeg('old'));
  await fixture.db.execute(
    "INSERT INTO marketplace_media(id,token_hash,user_id,filename,bytes,expires_at) VALUES($1,$2,$3,'expired.jpg',10,$4)",
    [randomUUID(), digest('expired'), seller.id, new Date(loop.now() - HOUR).toISOString()],
  );
  await loop.tick();
  assert.equal((await fixture.db.one<{n: number}>("SELECT count(*)::int AS n FROM marketplace_metrics WHERE day='2024-01-01'"))!.n, 0);
  assert.equal(fs.existsSync(path.join(mediaDir, 'expired.jpg')), false);

  // ── Erasure: every row of the account and its picture files ──
  await fixture.db.execute("INSERT INTO marketplace_brand_kits(id,user_id,name,kit) VALUES($1,$2,'Style','{}'::jsonb)", [randomUUID(), seller.id]);
  const files = (await fixture.db.many<{filename: string}>('SELECT filename FROM marketplace_media WHERE user_id=$1', [seller.id])).map(entry => entry.filename);
  assert.ok(files.length >= 3 && files.every(name => fs.existsSync(path.join(mediaDir, name))));
  await fixture.db.execute("UPDATE users SET deletion_requested_at='2026-10-12 10:00:00' WHERE id=$1", [seller.id]);
  const {eraseAccount} = await import('../server/launch/lifecycle');
  await eraseAccount(seller.id, new Date().toISOString());
  for (const table of ['marketplace_connections', 'marketplace_card_links', 'marketplace_media', 'marketplace_publications', 'marketplace_tests', 'marketplace_brand_kits'])
    assert.equal((await fixture.db.one<{n: number}>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [seller.id]))!.n, 0, table);
  assert.equal((await fixture.db.one<{n: number}>('SELECT count(*)::int AS n FROM marketplace_metrics WHERE connection_id=$1', [connection.id]))!.n, 0);
  assert.ok(files.every(name => !fs.existsSync(path.join(mediaDir, name))), 'the picture files go too');
  assert.equal((await fixture.db.one<{n: number}>('SELECT count(*)::int AS n FROM marketplace_connections WHERE user_id=$1', [stranger.id]))!.n, 1, 'others stay');
});
