// Catalog run (docs/marketplaces.md §Catalog run): one photo a seller's table links to, fetched from the open internet the way
// server/hosting/https-request.ts `safeHTTPS` reaches a public host. https only, no credentials or odd ports; the host name is resolved
// first and every address it has must be public, then the connection is pinned to that address (no second lookup a DNS rebinding could
// answer differently); each redirect is checked again from the start. At most 20 MB and 30 seconds, redirects included.
import https from 'node:https';
import type {LookupAddress} from 'node:dns';
import {publicAddress} from '../../hosting/https-request';
import {CATALOG_FETCH_LIMITS} from '../../../shared/design/marketplace/catalog-api';

/** Why a photo could not be fetched, said for the seller (`code` for the client and the logs). */
export class PhotoFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PhotoFetchError';
  }
}

export type FetchedPhoto = {data: Buffer; name: string};
/** How the route downloads a photo; tests pass a fake. */
export type PhotoFetcher = (url: string, signal: AbortSignal) => Promise<FetchedPhoto>;

const USER_AGENT = 'Mozilla/5.0 (compatible; MorfaBot/1.0; +https://morfa.example)';
const timedOut = () => new PhotoFetchError('The site with the photo did not respond in time.', 'timeout');
const tooBig = () => new PhotoFetchError(`The photo is larger than ${CATALOG_FETCH_LIMITS.bytes / 1024 / 1024} MB.`, 'too_large');

export function photoUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PhotoFetchError('This is not a link.', 'invalid_url');
  }
  if (url.protocol !== 'https:') throw new PhotoFetchError('A link that starts with https:// is needed.', 'not_https');
  if (url.username || url.password || (url.port && url.port !== '443'))
    throw new PhotoFetchError('A link with a login or a non-standard port is not accepted.', 'unsafe_url');
  return url;
}

/** The file name a link suggests (its last path segment), for the picture's name in the file. */
export function photoName(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // A malformed escape: keep it as written.
  }
  return name.slice(0, 200) || url.hostname;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timedOut());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(timedOut());
    signal.addEventListener('abort', abort, {once: true});
    work.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function resolvePublic(host: string, signal: AbortSignal): Promise<LookupAddress> {
  try {
    return await untilAborted(publicAddress(host), signal);
  } catch (error) {
    if (error instanceof PhotoFetchError) throw error;
    if ((error as {code?: unknown}).code === 'unsafe_destination')
      throw new PhotoFetchError('The link does not lead to a public site.', 'unsafe_destination');
    throw new PhotoFetchError('The site behind the link was not found.', 'not_found');
  }
}

type Hop = {redirect: string} | {data: Buffer};

/** One GET to `url` over a connection pinned to `address`: the body (200), a redirect's target, or a refusal. */
function getPinned(url: URL, address: LookupAddress, signal: AbortSignal): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      run();
    };
    const fail = (error: unknown) =>
      settle(() =>
        reject(
          error instanceof PhotoFetchError
            ? error
            : signal.aborted
              ? timedOut()
              : new PhotoFetchError('Could not download the photo.', 'network'),
        ),
      );
    const request = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
        },
        timeout: 15_000,
        signal,
        lookup: ((_host: string, options: {all?: boolean}, callback: (...args: unknown[]) => void) =>
          options.all ? callback(null, [address]) : callback(null, address.address, address.family)) as never,
      },
      response => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          settle(() => resolve({redirect: location}));
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(new PhotoFetchError(`The site with the photo answered with error ${status}.`, 'http_error'));
          return;
        }
        if (Number(response.headers['content-length']) > CATALOG_FETCH_LIMITS.bytes) {
          response.destroy();
          fail(tooBig());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > CATALOG_FETCH_LIMITS.bytes) {
            response.destroy();
            fail(tooBig());
          } else chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => settle(() => resolve({data: Buffer.concat(chunks)})));
        response.on('close', () => fail(new PhotoFetchError('The site with the photo cut the download short.', 'network')));
      },
    );
    request.on('timeout', () => request.destroy(timedOut()));
    request.on('error', fail);
    request.end();
  });
}

/** Downloads a photo from a public https address (redirects followed and checked), or throws `PhotoFetchError`. */
export async function fetchPublicPhoto(raw: string, signal?: AbortSignal): Promise<FetchedPhoto> {
  const deadline = AbortSignal.timeout(CATALOG_FETCH_LIMITS.timeoutMs);
  const all = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = photoUrl(raw);
  for (let hop = 0; ; hop++) {
    const address = await resolvePublic(url.hostname, all);
    const answer = await getPinned(url, address, all);
    if ('data' in answer) {
      if (!answer.data.length) throw new PhotoFetchError('The link leads to an empty file.', 'empty');
      return {data: answer.data, name: photoName(url)};
    }
    if (hop >= CATALOG_FETCH_LIMITS.redirects) throw new PhotoFetchError('Too many redirects.', 'redirects');
    let next: string;
    try {
      next = new URL(answer.redirect, url).href;
    } catch {
      throw new PhotoFetchError('The site with the photo redirected to an invalid link.', 'invalid_url');
    }
    url = photoUrl(next);
  }
}
