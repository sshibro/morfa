import http from 'node:http';
import https from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP, type LookupFunction} from 'node:net';
import {Router, type Request, type Response} from 'express';
import {Parser} from 'htmlparser2';
import {z} from 'zod';
import {captureCustomerAuthority} from '../customer-authority';
import {asyncHandler} from '../http';
import {limitRequests} from '../rate-limit';
import {ONE_MINUTE_MS} from '../time-constants';
import type {ImageAsset, ImageRef} from '../../shared/design/types';
import {fileAccess, designRead} from './file-access';
import {isDesignFailure} from './errors';
import * as files from './files';

// Link preview cards (a pasted link as a card on a board):
//
//   GET /api/design-files/:id/link-preview?url=<http(s) URL>   an editor of the file
//   → {url, title, description, image: ImageRef | null, imageAsset: ImageAsset | null, site}
//   → 422 {code: 'link_preview_unavailable', reason}
//
// The page's picture is stored as one of the file's design pictures (files.storeDesignImage: the file's scope and storage,
// re-encoded), so the card exports and is served from Morfa, never hot-linked. That is why the route sits under a file:
// a document only takes pictures of its own scope (images.ts assertOwnedDesignImages).
//
// The server fetches a page someone else names, so every fetch goes through `fetchChecked`:
// - http/https only, ports 80/443 only, no user:password in the URL;
// - the host is resolved here (every address it has must be public: `isBlockedAddress`), and the socket connects to the address
//   that was checked (the request's `lookup` answers it: no second resolution between the check and the connect); an IP
//   literal is checked as it is (WHATWG URL parsing has already turned decimal, octal and hex IPv4 forms into dotted quads);
// - redirects are followed by hand, at most 3, each one checked again from the start (a redirect to a name that now resolves
//   to a private address is refused);
// - 5 s for the whole preview (page, redirects and picture), at most 512 KB of the page read (text/html only) and 5 MB of the
//   picture (image/* only, then decoded and re-encoded by sharp: SVG and anything not a raster are refused);
// - no cookies, no credentials, no proxy; nothing fetched is passed on but the parsed title, description, site name and the
//   re-encoded picture. Failures say only a short reason code; nothing logs a URL (the request journal keeps paths without
//   their query: admin/telemetry.ts safeRoute).
// Results are cached by URL for an hour (failures for five minutes); each account may ask 20 times a minute.

export const LINK_PREVIEW_LIMITS = {
  totalMs: 5_000,
  htmlBytes: 512 * 1024,
  imageBytes: 5 * 1024 * 1024,
  redirects: 3,
  urlChars: 2048,
  textChars: {title: 300, description: 1000, site: 100},
  cacheMs: 60 * ONE_MINUTE_MS,
  failureCacheMs: 5 * ONE_MINUTE_MS,
  cacheEntries: 500,
  perMinute: 20,
} as const;

export type LinkPreviewAnswer = {
  url: string;
  title: string | null;
  description: string | null;
  image: ImageRef | null;
  imageAsset: ImageAsset | null;
  site: string | null;
};

export type LinkPreviewReason =
  | 'invalid_url'
  | 'blocked_address'
  | 'unresolved'
  | 'timeout'
  | 'too_many_redirects'
  | 'http_status'
  | 'not_html'
  | 'fetch_failed';

export class LinkPreviewError extends Error {
  constructor(readonly reason: LinkPreviewReason) {
    super(`link preview: ${reason}`);
  }
}
const refuse = (reason: LinkPreviewReason): never => {
  throw new LinkPreviewError(reason);
};

// ── Addresses ─────────────────────────────────────────────────────────────────────────────────

/** IPv4 ranges never fetched: this network, private, CGNAT, loopback, link-local (and the cloud metadata address in it),
 *  IETF protocol assignments, documentation, 6to4 relay, benchmarking, multicast, reserved, broadcast. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const v4Number = (address: string) => address.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
const inV4 = (value: number, [base, bits]: [string, number]) =>
  bits === 0 || Math.floor(value / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits));

/** The eight 16-bit groups of an IPv6 address (with an embedded dotted quad), or null when it is not one. */
function v6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) {
    if (isIP(quad[1]) !== 4) return null;
    const n = v4Number(quad[1]);
    text = text.slice(0, -quad[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = (s: string) => (s ? s.split(':') : []);
  const head = part(halves[0]),
    tail = halves.length === 2 ? part(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every(g => !Number.isNaN(g)) ? groups : null;
}

const v4OfGroups = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/** True for every address a preview must never reach: anything not a public unicast address. Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address.replace(/%.*$/, ''));
  if (family === 4) {
    const value = v4Number(address);
    return value === 0xffffffff || BLOCKED_V4.some(range => inV4(value, range));
  }
  if (family !== 6) return true;
  const g = v6Groups(address);
  if (!g) return true;
  const zeroTo = (n: number) => g.slice(0, n).every(x => x === 0);
  // An IPv4-mapped address (::ffff:a.b.c.d, also written ::ffff:7f00:1) is judged as that IPv4 address.
  if (zeroTo(5) && g[5] === 0xffff) return isBlockedAddress(v4OfGroups(g[6], g[7]));
  // Beyond that only global unicast (2000::/3) is fetched, without the ranges that lead to other networks or none: Teredo
  // (2001::/32) and 6to4 (2002::/16) tunnel to any IPv4 address, ORCHID and documentation (2001:10::/28, 2001:20::/28,
  // 2001:db8::/32, 3fff::/20). Outside 2000::/3 and so refused too: ::, ::1, IPv4-compatible and translated forms, NAT64
  // (64:ff9b::/96, 64:ff9b:1::/48), discard (100::/64), ULA (fc00::/7), link-local (fe80::/10), site-local, multicast.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2002) return true;
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8 || (g[1] & 0xfff0) === 0x10 || (g[1] & 0xfff0) === 0x20)) return true;
  if ((g[0] & 0xfff0) === 0x3ff0) return true;
  return false;
}

// ── The checked fetch ─────────────────────────────────────────────────────────────────────────

/** What a fetch may reach; tests replace it to reach their local server (never the route: it always uses the defaults). */
export type FetchPolicy = {
  resolve: (host: string) => Promise<{address: string; family: number}[]>;
  isBlocked: (address: string) => boolean;
  ports: ReadonlySet<number>;
};
export const DEFAULT_POLICY: FetchPolicy = {
  resolve: host => dnsLookup(host, {all: true, verbatim: true}),
  isBlocked: isBlockedAddress,
  ports: new Set([80, 443]),
};

/** A URL a preview may ask for, or null: http/https, port 80/443 (or the scheme's), no credentials. */
export function checkUrl(raw: string, policy: FetchPolicy = DEFAULT_POLICY): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!policy.ports.has(port)) return null;
  if (!url.hostname) return null;
  url.hash = '';
  return url;
}

/** The one address this hop connects to: the host's every address must pass, the first is used. */
async function pinAddress(url: URL, policy: FetchPolicy): Promise<{address: string; family: number}> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(host)) {
    if (policy.isBlocked(host)) refuse('blocked_address');
    return {address: host, family: isIP(host)};
  }
  let answers: {address: string; family: number}[];
  try {
    answers = await policy.resolve(host);
  } catch {
    return refuse('unresolved');
  }
  if (!answers.length) refuse('unresolved');
  if (answers.some(answer => policy.isBlocked(answer.address))) refuse('blocked_address');
  return answers[0];
}

type Fetched = {url: URL; contentType: string; body: Buffer; truncated: boolean};

/** One GET to the pinned address; the response is read up to `maxBytes` (more is cut, `truncated`), or the redirect's target. */
function requestOnce(
  url: URL,
  pinned: {address: string; family: number},
  maxBytes: number,
  accept: string,
  signal: AbortSignal,
): Promise<{status: number; location: string | null; contentType: string; body: Buffer; truncated: boolean}> {
  const lookup: LookupFunction = (_host, options, callback) => {
    if ((options as {all?: boolean}).all) (callback as (e: null, a: {address: string; family: number}[]) => void)(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup,
        signal,
        headers: {
          accept,
          'accept-encoding': 'identity',
          'user-agent': 'MorfaLinkPreview/1.0 (+https://morfa.example)',
        },
      },
      res => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
        if (status >= 300 && status < 400) {
          res.destroy();
          resolve({status, location: res.headers.location ?? null, contentType, body: Buffer.alloc(0), truncated: false});
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const cut = () => {
          done = true;
          res.destroy();
          resolve({status, location: null, contentType, body: Buffer.concat(chunks), truncated: true});
        };
        // A picture declared past its limit is not read at all; a page is read up to its limit and parsed from that.
        if (accept.startsWith('image/') && Number(res.headers['content-length'] ?? 0) > maxBytes) return cut();
        res.on('data', (chunk: Buffer) => {
          if (done) return;
          if (size + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, maxBytes - size));
            return cut();
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => resolve({status, location: null, contentType, body: Buffer.concat(chunks), truncated: false}));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** GET with every hop checked (see the top of the file); refuses a status other than 200 and a type that does not match. */
export async function fetchChecked(
  start: URL,
  options: {maxBytes: number; accept: string; type: (contentType: string) => boolean; signal: AbortSignal; policy?: FetchPolicy},
): Promise<Fetched> {
  const policy = options.policy ?? DEFAULT_POLICY;
  let url = start;
  for (let hop = 0; ; hop++) {
    const pinned = await pinAddress(url, policy);
    let answer;
    try {
      answer = await requestOnce(url, pinned, options.maxBytes, options.accept, options.signal);
    } catch {
      return refuse(options.signal.aborted ? 'timeout' : 'fetch_failed');
    }
    if (answer.status >= 300 && answer.status < 400 && answer.status !== 304) {
      if (!answer.location) refuse('http_status');
      if (hop >= LINK_PREVIEW_LIMITS.redirects) refuse('too_many_redirects');
      let next: URL | null = null;
      try {
        next = checkUrl(new URL(answer.location!, url).href, policy);
      } catch {
        next = null;
      }
      if (!next) refuse('blocked_address');
      url = next!;
      continue;
    }
    if (answer.status !== 200) refuse('http_status');
    if (!options.type(answer.contentType.split(';')[0].trim())) refuse('not_html');
    return {url, contentType: answer.contentType, body: answer.body, truncated: answer.truncated};
  }
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────

export type PageMeta = {title: string | null; description: string | null; site: string | null; image: string | null};

const clean = (text: string | undefined, max: number) => {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, max) : null;
};

/** The page's charset: the Content-Type's, else a <meta charset> in the first 1 KB, else UTF-8 (TextDecoder's labels). */
function decodeHtml(body: Buffer, contentType: string): string {
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 1024).toString('latin1'))?.[1];
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** og:title / og:description / og:image / og:site_name, else <title> and the meta description (and twitter:image). */
export function parsePageMeta(html: string): PageMeta {
  const meta = new Map<string, string>();
  let title = '';
  let inTitle = false;
  let titleDone = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === 'title' && !titleDone) inTitle = true;
        if (name !== 'meta') return;
        const key = (attributes.property ?? attributes.name ?? '').toLowerCase().trim();
        const content = attributes.content;
        if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
      },
      ontext(text) {
        if (inTitle) title += text;
      },
      onclosetag(name) {
        if (name === 'title' && inTitle) {
          inTitle = false;
          titleDone = true;
        }
      },
    },
    {decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true},
  );
  parser.write(html);
  parser.end();
  const {textChars} = LINK_PREVIEW_LIMITS;
  return {
    title: clean(meta.get('og:title') ?? title, textChars.title),
    description: clean(meta.get('og:description') ?? meta.get('description'), textChars.description),
    site: clean(meta.get('og:site_name'), textChars.site),
    image: clean(meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image'), LINK_PREVIEW_LIMITS.urlChars),
  };
}

export type FetchedPreview = {url: string; title: string | null; description: string | null; site: string | null; image: Buffer | null};

/** The page and its picture, within one deadline. A picture that cannot be had leaves `image` null; the page must succeed. */
export async function fetchLinkPreview(raw: string, policy: FetchPolicy = DEFAULT_POLICY): Promise<FetchedPreview> {
  const start = checkUrl(raw, policy) ?? refuse('invalid_url');
  const signal = AbortSignal.timeout(LINK_PREVIEW_LIMITS.totalMs);
  const page = await fetchChecked(start, {
    maxBytes: LINK_PREVIEW_LIMITS.htmlBytes,
    accept: 'text/html',
    type: type => type === 'text/html',
    signal,
    policy,
  });
  const meta = parsePageMeta(decodeHtml(page.body, page.contentType));
  let image: Buffer | null = null;
  if (meta.image) {
    let target: URL | null = null;
    try {
      target = checkUrl(new URL(meta.image, page.url).href, policy);
    } catch {
      target = null;
    }
    if (target)
      try {
        const picture = await fetchChecked(target, {
          maxBytes: LINK_PREVIEW_LIMITS.imageBytes,
          accept: 'image/*',
          type: type => type.startsWith('image/'),
          signal,
          policy,
        });
        if (!picture.truncated) image = picture.body;
      } catch {
        image = null;
      }
  }
  return {url: page.url.href, title: meta.title, description: meta.description, site: meta.site ?? page.url.hostname, image};
}

// ── The cache ─────────────────────────────────────────────────────────────────────────────────

type Cached = {expires: number; result: FetchedPreview | LinkPreviewReason};
const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<FetchedPreview | LinkPreviewReason>>();

/** The preview of a URL, from the cache (an hour; a failure five minutes) or fetched once however many ask at the same time. */
export async function cachedLinkPreview(
  url: string,
  fetch: (url: string) => Promise<FetchedPreview> = fetchLinkPreview,
  now = Date.now(),
): Promise<FetchedPreview | LinkPreviewReason> {
  const hit = cache.get(url);
  if (hit && hit.expires > now) return hit.result;
  if (hit) cache.delete(url);
  const running = inFlight.get(url);
  if (running) return running;
  const work = fetch(url)
    .then(
      result => result as FetchedPreview | LinkPreviewReason,
      error => (error instanceof LinkPreviewError ? error.reason : ('fetch_failed' as const)),
    )
    .then(result => {
      cache.set(url, {expires: now + (typeof result === 'string' ? LINK_PREVIEW_LIMITS.failureCacheMs : LINK_PREVIEW_LIMITS.cacheMs), result});
      while (cache.size > LINK_PREVIEW_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!);
      return result;
    })
    .finally(() => inFlight.delete(url));
  inFlight.set(url, work);
  return work;
}
export const clearLinkPreviewCache = () => cache.clear();
/** Tests through the whole app (tests/postgresql-runtime-link-preview.test.ts): a result as if fetched, since the route's own
 *  fetches may reach no test server (loopback is refused). */
export const primeLinkPreviewCache = (url: string, result: FetchedPreview) =>
  void cache.set(url, {expires: Date.now() + LINK_PREVIEW_LIMITS.cacheMs, result});

// ── The route ─────────────────────────────────────────────────────────────────────────────────

const query = z.object({url: z.string().min(1).max(LINK_PREVIEW_LIMITS.urlChars)});

/** Mounted at /api/design-files/:id/link-preview, after the files router's sign-in and design-tool checks. */
export function createLinkPreviewRouter(): Router {
  const router = Router({mergeParams: true});
  const limit = limitRequests({
    windowMs: ONE_MINUTE_MS,
    limit: LINK_PREVIEW_LIMITS.perMinute,
    keyGenerator: (_req: Request, res: Response) => String(res.locals.user.id),
    message: {error: 'Too many links in a row. Wait a minute.'},
  });
  router.get(
    '/',
    limit,
    asyncHandler(async (req, res) => {
      const unavailable = (reason: LinkPreviewReason) =>
        res.status(422).json({error: 'Could not get the link preview.', code: 'link_preview_unavailable', reason});
      const parsed = query.safeParse(req.query);
      const url = parsed.success ? checkUrl(parsed.data.url) : null;
      if (!url) return void unavailable('invalid_url');
      const actor = captureCustomerAuthority(req, res);
      const fileId = String(req.params.id);
      // An editor of the file only: the picture becomes one of its pictures.
      await designRead(actor, tx => fileAccess(tx, actor.ownerId, fileId, 'edit'));
      const preview = await cachedLinkPreview(url.href);
      if (typeof preview === 'string') return void unavailable(preview);
      let image: ImageRef | null = null,
        imageAsset: ImageAsset | null = null;
      if (preview.image) {
        try {
          const stored = await files.storeDesignImage(actor, fileId, preview.image);
          image = stored.ref;
          imageAsset = stored.asset;
        } catch (error) {
          // A picture sharp refuses, or a full storage, leaves the card without one; anything else is the server's.
          if (!isDesignFailure(error) || error.status >= 500) throw error;
        }
      }
      const answer: LinkPreviewAnswer = {
        url: preview.url,
        title: preview.title,
        description: preview.description,
        image,
        imageAsset,
        site: preview.site,
      };
      res.json(answer);
    }),
  );
  return router;
}
