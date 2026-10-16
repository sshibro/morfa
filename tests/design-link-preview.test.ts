import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import express from 'express';
import sharp from 'sharp';
import type {FetchPolicy} from '../server/design/link-preview';

// The route module reaches the database pool (files.ts), which is lazy: the URL only has to be set, nothing connects (the
// route answers these tests before any database read).
process.env.MORFA_DATABASE_URL ||= 'postgresql://morfa_runtime:unused@127.0.0.1:5999/morfa?sslmode=disable';
const {
  LINK_PREVIEW_LIMITS,
  LinkPreviewError,
  cachedLinkPreview,
  checkUrl,
  clearLinkPreviewCache,
  createLinkPreviewRouter,
  fetchLinkPreview,
  isBlockedAddress,
  parsePageMeta,
} = await import('../server/design/link-preview');

// Lane D step 2: the link preview's SSRF guard (server/design/link-preview.ts). Everything runs against a server on this
// machine's loopback, reached through a test policy that maps names to it; nothing outside the container is contacted (the
// refused addresses are refused before any connection).

const reasonOf = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof LinkPreviewError) return error.reason;
    throw error;
  }
  return 'ok';
};

test('address filter: every private, loopback, link-local, CGNAT, multicast, metadata and reserved address is refused', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.1.2.3',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'ff05::2',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:c0a8:101',
    '::127.0.0.1', '::ffff:0:127.0.0.1', '64:ff9b::a00:1', '64:ff9b::8.8.8.8', '64:ff9b:1::1', '100::1', '2002:a00:1::1',
    '2002:808:808::1', '2001::1', '2001:db8::1', '2001:10::1', '2001:20::1', '3fff::1', 'fec0::1',
    'not-an-ip', '', '1.2.3', '256.1.1.1', '::ffff:999.1.1.1', '1:2:3:4:5:6:7:8:9',
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '11.0.0.1', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1',
    '169.253.255.255', '169.255.0.1', '172.15.255.255', '172.32.0.1', '192.167.255.255', '192.169.0.1', '198.17.255.255',
    '198.20.0.1', '223.255.255.255', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4010:c05::64', '2001:4860:4860::8888',
  ];
  assert.deepEqual(blocked.filter(address => !isBlockedAddress(address)), [], 'let through');
  assert.deepEqual(allowed.filter(isBlockedAddress), [], 'refused');
});

test('urls: http/https on 80/443 only, no credentials; decimal, octal, hex and IPv6 forms of a private address are refused', async () => {
  for (const raw of ['ftp://example.invalid/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://example.invalid:8080/',
    'https://example.invalid:22/', 'http://user:pass@example.invalid/', 'http:///', 'not a url'])
    assert.equal(checkUrl(raw), null, raw);
  assert.equal(checkUrl('https://example.invalid/a?b=c#frag')?.href, 'https://example.invalid/a?b=c');
  assert.equal(checkUrl('http://example.invalid:443/')?.port, '443');
  // WHATWG URL parsing turns these into dotted quads; each is refused before any connection is made.
  for (const raw of [
    'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://0x7f000001/', 'http://127.1/', 'http://017700000001/',
    'http://169.254.169.254/latest/meta-data/', 'http://0xa9fea9fe/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://10.1.2.3/', 'http://localhost/',
  ])
    assert.equal(await reasonOf(fetchLinkPreview(raw)), 'blocked_address', raw);
});

// ── A local server reached through a test policy ──────────────────────────────────────────────

type Route = (req: IncomingMessage, res: ServerResponse) => void;
const listen = (routes: Record<string, Route>) =>
  new Promise<{server: Server; port: number}>(resolve => {
    const server = createServer((req, res) => {
      const route = routes[req.url ?? ''];
      if (route) return route(req, res);
      res.writeHead(404).end('nope');
    });
    server.listen(0, '127.0.0.1', () => resolve({server, port: (server.address() as AddressInfo).port}));
  });
const close = (server: Server) => new Promise<void>(resolve => {
  server.closeAllConnections();
  server.close(() => resolve());
});

/** Names that resolve to the test server (127.0.0.1, allowed here only), and a few that resolve to private addresses. */
const policyFor = (port: number, names: Record<string, string[] | (() => string[])> = {}, resolutions: string[] = []): FetchPolicy => ({
  resolve: async host => {
    resolutions.push(host);
    const answer = names[host] ?? (host.endsWith('.test') ? ['127.0.0.1'] : null);
    if (!answer) throw Error('ENOTFOUND');
    return (typeof answer === 'function' ? answer() : answer).map(address => ({address, family: address.includes(':') ? 6 : 4}));
  },
  isBlocked: address => (address === '127.0.0.1' ? false : isBlockedAddress(address)),
  ports: new Set([port]),
});

const html = (body: string, type = 'text/html; charset=utf-8'): Route => (_req, res) => res.writeHead(200, {'content-type': type}).end(body);
const redirect = (to: string, status = 302): Route => (_req, res) => res.writeHead(status, {location: to}).end();

test('preview: og tags, a relative og:image fetched and kept; <title> and the meta description when there are no og tags', async () => {
  const png = await sharp({create: {width: 8, height: 6, channels: 3, background: '#3366ff'}}).png().toBuffer();
  const {server, port} = await listen({
    '/og': html(`<!doctype html><html><head><title>Ignored</title>
      <meta property="og:title" content="Board &amp; cards"><meta property="og:description" content="  All   together  ">
      <meta property="og:site_name" content="Morfa"><meta property="og:image" content="/pic.png"></head><body></body></html>`),
    '/plain': html('<html><head><title> Plain page </title><meta name="description" content="Description"></head></html>'),
    '/pic.png': (_req, res) => res.writeHead(200, {'content-type': 'image/png'}).end(png),
    // The bytes below are "Привет" in Windows-1251: Cyrillic is kept on purpose, this route tests charset decoding.
    '/cp1251': (_req, res) =>
      res.writeHead(200, {'content-type': 'text/html; charset=windows-1251'}).end(Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e])),
  });
  try {
    const policy = policyFor(port);
    const og = await fetchLinkPreview(`http://page.test:${port}/og`, policy);
    assert.equal(og.title, 'Board & cards');
    assert.equal(og.description, 'All together');
    assert.equal(og.site, 'Morfa');
    assert.ok(og.image?.equals(png), 'the picture as served (the route re-encodes it when it stores it)');
    const plain = await fetchLinkPreview(`http://page.test:${port}/plain`, policy);
    assert.deepEqual({...plain, image: null}, {url: `http://page.test:${port}/plain`, title: 'Plain page', description: 'Description', site: 'page.test', image: null});
    assert.equal((await fetchLinkPreview(`http://page.test:${port}/cp1251`, policy)).title, 'Привет');
  } finally {
    await close(server);
  }
});

test('preview: every redirect is checked again — a private target, a name that rebinds, IPv6 loopback; at most 3 hops', async () => {
  let rebound = 0;
  const {server, port} = await listen({});
  const at = (path: string, host = 'page.test') => `http://${host}:${port}${path}`;
  const routes: Record<string, Route> = {
    '/page': html('<title>Here</title>'),
    '/one': redirect('/page'),
    '/three': redirect('/two'),
    '/two': redirect(at('/one', 'other.test'), 301),
    '/four': redirect('/three'),
    '/to-private': redirect(at('/page', 'private.test')),
    '/to-loopback6': redirect(`http://[::1]:${port}/page`),
    '/to-metadata': redirect('http://169.254.169.254/latest/meta-data/'),
    '/to-port': redirect('http://page.test:8080/page'),
    '/to-file': redirect('file:///etc/passwd'),
    '/rebind': redirect(at('/page', 'rebind.test')),
  };
  server.removeAllListeners('request');
  server.on('request', (req, res) => (routes[req.url ?? ''] ?? ((_q, r) => r.writeHead(404).end()))(req, res));
  try {
    const resolutions: string[] = [];
    const policy = policyFor(
      port,
      {'private.test': ['10.0.0.7'], 'rebind.test': () => (rebound++ === 0 ? ['127.0.0.1'] : ['192.168.0.10']), 'mixed.test': ['127.0.0.1', '10.0.0.1']},
      resolutions,
    );
    const three = await fetchLinkPreview(at('/three'), policy);
    assert.equal(three.title, 'Here');
    assert.equal(three.url, at('/page', 'other.test'));
    assert.deepEqual(resolutions, ['page.test', 'page.test', 'other.test', 'other.test'], 'one resolution per hop, then the connect');
    assert.equal(await reasonOf(fetchLinkPreview(at('/four'), policy)), 'too_many_redirects');
    for (const path of ['/to-private', '/to-loopback6', '/to-metadata', '/to-port', '/to-file'])
      assert.equal(await reasonOf(fetchLinkPreview(at(path), policy)), 'blocked_address', path);
    // rebind.test answers the loopback (allowed here) for the first hop, then a private address for the redirect's hop.
    assert.equal(await reasonOf(fetchLinkPreview(at('/rebind', 'rebind.test'), policy)), 'blocked_address');
    assert.equal(rebound, 2);
    // A name with one private address among its answers is refused, whichever address would be picked.
    assert.equal(await reasonOf(fetchLinkPreview(at('/page', 'mixed.test'), policy)), 'blocked_address');
    assert.equal(await reasonOf(fetchLinkPreview(at('/page', 'missing.invalid'), policy)), 'unresolved');
  } finally {
    await close(server);
  }
});

test('preview: text/html only, 200 only; 512 KB of the page read; a picture over 5 MB or not an image is dropped', async () => {
  const pad = 'x'.repeat(LINK_PREVIEW_LIMITS.htmlBytes);
  let bigImageSent = 0;
  const {server, port} = await listen({
    '/json': html('{"title": "no"}', 'application/json'),
    '/svg': html('<svg/>', 'image/svg+xml'),
    '/gone': (_req, res) => res.writeHead(404, {'content-type': 'text/html'}).end('<title>Not found</title>'),
    '/error': (_req, res) => res.writeHead(500, {'content-type': 'text/html'}).end('<title>secret stack trace</title>'),
    '/head-then-pad': html(`<title>Early</title><!-- ${pad}${pad} -->`),
    '/pad-then-head': html(`<!-- ${pad} --><title>Late</title>`),
    '/big-picture': html('<title>Big</title><meta property="og:image" content="/big.png">'),
    '/big.png': (_req, res) => {
      res.writeHead(200, {'content-type': 'image/png'});
      const chunk = Buffer.alloc(256 * 1024);
      const send = () => {
        while (bigImageSent < LINK_PREVIEW_LIMITS.imageBytes * 2) {
          bigImageSent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', send);
        }
        res.end();
      };
      send();
    },
    '/declared-big': html('<title>Declared</title><meta property="og:image" content="/declared.png">'),
    '/declared.png': (_req, res) => res.writeHead(200, {'content-type': 'image/png', 'content-length': String(LINK_PREVIEW_LIMITS.imageBytes + 1)}).end(),
    '/text-picture': html('<title>Text</title><meta property="og:image" content="/text.png">'),
    '/text.png': html('not a picture', 'text/plain'),
    '/private-picture': html('<title>Private</title><meta property="og:image" content="http://10.0.0.1/pic.png">'),
  });
  try {
    const policy = policyFor(port);
    const at = (path: string) => `http://page.test:${port}${path}`;
    assert.equal(await reasonOf(fetchLinkPreview(at('/json'), policy)), 'not_html');
    assert.equal(await reasonOf(fetchLinkPreview(at('/svg'), policy)), 'not_html');
    assert.equal(await reasonOf(fetchLinkPreview(at('/gone'), policy)), 'http_status');
    const error = await reasonOf(fetchLinkPreview(at('/error'), policy));
    assert.equal(error, 'http_status', 'the reason only: nothing of the body');
    assert.equal((await fetchLinkPreview(at('/head-then-pad'), policy)).title, 'Early');
    assert.equal((await fetchLinkPreview(at('/pad-then-head'), policy)).title, null, 'past 512 KB nothing is read');
    const big = await fetchLinkPreview(at('/big-picture'), policy);
    assert.equal(big.title, 'Big');
    assert.equal(big.image, null);
    assert.ok(bigImageSent < LINK_PREVIEW_LIMITS.imageBytes * 2, 'the read stopped at the limit');
    assert.equal((await fetchLinkPreview(at('/declared-big'), policy)).image, null);
    assert.equal((await fetchLinkPreview(at('/text-picture'), policy)).image, null);
    assert.equal((await fetchLinkPreview(at('/private-picture'), policy)).image, null);
  } finally {
    await close(server);
  }
});

test('preview: 5 s for everything — a page that never answers, and one that trickles', {timeout: 20_000}, async () => {
  const {server, port} = await listen({
    '/silent': () => {},
    '/trickle': (_req, res) => {
      res.writeHead(200, {'content-type': 'text/html'});
      const timer = setInterval(() => res.write(' '), 200);
      res.on('close', () => clearInterval(timer));
    },
  });
  try {
    const policy = policyFor(port);
    for (const path of ['/silent', '/trickle']) {
      const started = Date.now();
      assert.equal(await reasonOf(fetchLinkPreview(`http://page.test:${port}${path}`, policy)), 'timeout', path);
      const took = Date.now() - started;
      assert.ok(took >= LINK_PREVIEW_LIMITS.totalMs - 100 && took < LINK_PREVIEW_LIMITS.totalMs + 1500, `${path}: ${took} ms`);
    }
  } finally {
    await close(server);
  }
});

test('cache: one fetch per URL for an hour (failures five minutes), one fetch for callers at the same time', async () => {
  clearLinkPreviewCache();
  let calls = 0;
  const fetch = async (url: string) => {
    calls++;
    if (url.includes('fail')) throw new LinkPreviewError('timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
    return {url, title: 't', description: null, site: null, image: null};
  };
  const now = 1_000_000;
  const [a, b] = await Promise.all([cachedLinkPreview('https://a.test/', fetch, now), cachedLinkPreview('https://a.test/', fetch, now)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  await cachedLinkPreview('https://a.test/', fetch, now + LINK_PREVIEW_LIMITS.cacheMs - 1);
  assert.equal(calls, 1);
  await cachedLinkPreview('https://a.test/', fetch, now + LINK_PREVIEW_LIMITS.cacheMs + 1);
  assert.equal(calls, 2);
  assert.equal(await cachedLinkPreview('https://fail.test/', fetch, now), 'timeout');
  assert.equal(await cachedLinkPreview('https://fail.test/', fetch, now + LINK_PREVIEW_LIMITS.failureCacheMs - 1), 'timeout');
  assert.equal(calls, 3);
  await cachedLinkPreview('https://fail.test/', fetch, now + LINK_PREVIEW_LIMITS.failureCacheMs + 1);
  assert.equal(calls, 4);
  clearLinkPreviewCache();
});

test('page meta: og first, then <title>, the meta description and twitter:image; text trimmed and capped', () => {
  assert.deepEqual(parsePageMeta('<title>T</title><meta name="description" content="D"><meta name="twitter:image" content="/t.png">'), {
    title: 'T',
    description: 'D',
    site: null,
    image: '/t.png',
  });
  const long = parsePageMeta(`<meta property="og:title" content="${'x'.repeat(1000)}">`);
  assert.equal(long.title?.length, LINK_PREVIEW_LIMITS.textChars.title);
  assert.equal(parsePageMeta('<p>nothing</p>').title, null);
});

test('route: 422 link_preview_unavailable for a URL it may not fetch (before any database read), 429 past 20 a minute', async () => {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.user = {id: 'account-1'};
    next();
  });
  app.use('/api/design-files/:id/link-preview', createLinkPreviewRouter());
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/design-files/f/link-preview`;
  try {
    for (const query of ['', '?url=', '?url=ftp%3A%2F%2Fx.invalid%2F', `?url=${encodeURIComponent('http://x.invalid:8080/')}`, `?url=${'a'.repeat(3000)}`]) {
      const answer = await fetch(base + query);
      assert.equal(answer.status, 422, query);
      assert.deepEqual(await answer.json(), {error: 'Could not get the link preview.', code: 'link_preview_unavailable', reason: 'invalid_url'});
    }
    // Five asked above; the rest of the minute's twenty, then the limit.
    for (let i = 5; i < LINK_PREVIEW_LIMITS.perMinute; i++) assert.equal((await fetch(base)).status, 422);
    const limited = await fetch(base);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'rate_limited');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
