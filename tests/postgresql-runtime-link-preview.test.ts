import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import sharp from 'sharp';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createNode} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';

// Lane D step 2: GET /api/design-files/:id/link-preview through the whole app against the real schema: who may ask, that the
// route's own fetches refuse loopback (the test server is never reached), and that a page's picture becomes one of the file's
// pictures, served from /uploads and accepted in the file's document (so the card exports).

type Account = {id: string; token: string};

test('link preview: editors only, loopback refused end to end, the picture stored as the file\'s', {timeout: 120000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const saved = {ENABLE_DESIGN_TOOL: process.env.ENABLE_DESIGN_TOOL, DESIGN_TOOL_ACCOUNTS: process.env.DESIGN_TOOL_ACCOUNTS, APP_ORIGIN: process.env.APP_ORIGIN};
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  process.env.ENABLE_DESIGN_TOOL = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const {primeLinkPreviewCache, clearLinkPreviewCache} = await import('../server/design/link-preview');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  let reached = 0;
  const target = createServer((_req, res) => {
    reached++;
    res.writeHead(200, {'content-type': 'text/html'}).end('<title>never</title>');
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    clearLinkPreviewCache();
    for (const s of [server, target]) {
      s.closeAllConnections();
      await new Promise<void>(resolve => s.close(() => resolve()));
    }
    await drainAppTasks().catch(() => undefined);
  });

  async function account(label: string): Promise<Account> {
    const id = `design:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token};
  }
  const call = async (who: Account | null, url: string, init: RequestInit & {json?: unknown} = {}) => {
    const {json, ...rest} = init;
    const headers: Record<string, string> = {
      ...(who ? {cookie: auth.authCookieName('session') + '=' + who.token} : {}),
      ...(json !== undefined ? {'content-type': 'application/json'} : {}),
    };
    const response = await fetch(base + url, {...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const type = response.headers.get('content-type') ?? '';
    const raw = Buffer.from(await response.arrayBuffer());
    return {status: response.status, data: type.includes('json') ? JSON.parse(raw.toString('utf8')) : raw, type};
  };
  const preview = (who: Account | null, id: string, url: string) =>
    call(who, `/api/design-files/${id}/link-preview?url=${encodeURIComponent(url)}`);

  const owner = await account('link-owner');
  const stranger = await account('link-stranger');
  const created = await call(owner, '/api/design-files', {method: 'POST', json: {}});
  assert.ok(created.status === 201 || created.status === 200, JSON.stringify(created.data));
  const id = created.data.file.id as string;

  // Signed out, someone else's file, a file that does not exist: refused before anything is fetched.
  const local = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
  assert.equal((await preview(null, id, 'https://example.invalid/')).status, 401);
  assert.equal((await preview(stranger, id, 'https://example.invalid/')).status, 404);
  assert.equal((await preview(owner, randomUUID(), 'https://example.invalid/')).status, 404);
  // Loopback, by any spelling, through the real route: 422 with the reason, the test server never reached.
  for (const url of [local, 'http://localhost/', 'http://2130706433/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/']) {
    const answer = await preview(owner, id, url);
    assert.equal(answer.status, 422, url);
    assert.equal(answer.data.code, 'link_preview_unavailable');
    assert.ok(['blocked_address', 'invalid_url'].includes(answer.data.reason), `${url}: ${answer.data.reason}`);
  }
  assert.equal(reached, 0);

  // A page as if fetched (the cache): its picture is stored as the file's, re-encoded, served from /uploads.
  const picture = await sharp({create: {width: 40, height: 20, channels: 3, background: '#ff8800'}}).jpeg().toBuffer();
  const page = 'https://example.invalid/article';
  primeLinkPreviewCache(page, {url: page, title: 'Article', description: 'About boards', site: 'Example', image: picture});
  const answer = await preview(owner, id, page);
  assert.equal(answer.status, 200, JSON.stringify(answer.data));
  assert.equal(answer.data.title, 'Article');
  assert.equal(answer.data.description, 'About boards');
  assert.equal(answer.data.site, 'Example');
  assert.match(answer.data.image, /^dz-[0-9a-f-]+$/);
  assert.deepEqual({width: answer.data.imageAsset.width, height: answer.data.imageAsset.height}, {width: 40, height: 20});
  assert.match(answer.data.imageAsset.url, /^\/uploads\/dz-[0-9a-f-]+\.webp$/);
  const served = await call(owner, answer.data.imageAsset.url);
  assert.equal(served.status, 200);
  assert.equal(served.type, 'image/webp');
  const row = await db.one<{file_id: string; kind: string}>('SELECT file_id,kind FROM design_images WHERE filename=$1', [
    answer.data.imageAsset.url.slice('/uploads/'.length),
  ]);
  assert.deepEqual(row, {file_id: id, kind: 'image'});

  // The file's document takes the picture (a card that exports): a rectangle filled with it saves.
  const opened = await call(owner, `/api/design-files/${id}`);
  assert.equal(opened.status, 200);
  const doc = opened.data.document as DesignDocument;
  const pageId = doc.pages[0];
  const rect = createNode('RECTANGLE', {id: 'card-1', parentId: pageId, x: 0, y: 0, width: 200, height: 100});
  rect.fills = [{type: 'IMAGE', imageRef: answer.data.image, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}];
  const saved1 = await call(owner, `/api/design-files/${id}/document`, {
    method: 'PATCH',
    json: {
      baseVersion: opened.data.file.version,
      patch: {nodes: {'card-1': rect, [pageId]: {...doc.nodes[pageId], children: [...doc.nodes[pageId].children!, 'card-1']}}, images: {[answer.data.image]: answer.data.imageAsset}},
    },
  });
  assert.equal(saved1.status, 200, JSON.stringify(saved1.data));

  // A page without a picture: no image, nothing stored.
  primeLinkPreviewCache('https://example.invalid/plain', {url: 'https://example.invalid/plain', title: 'T', description: null, site: 'example.invalid', image: null});
  const plain = await preview(owner, id, 'https://example.invalid/plain');
  assert.equal(plain.status, 200);
  assert.equal(plain.data.image, null);
  assert.equal(plain.data.imageAsset, null);
});
