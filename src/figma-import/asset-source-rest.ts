import {readCappedBytes} from './read-capped';

// One picture from Figma's storage for the design tool's Figma import (src/design/import/figma). The download
// only.

export const DOWNLOAD_TIMEOUT_MS = 45_000;
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Figma's file links only: its API and S3 hosts, over https. */
export function isFigmaFileLink(url: string): boolean {
  try {
    const link = new URL(url);
    const host = link.hostname.toLowerCase();
    return link.protocol === 'https:' && (host.endsWith('.figma.com') || host.endsWith('.amazonaws.com'));
  } catch {
    return false;
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** One file from Figma's storage: no token, no cookies, 45 s and 25 MB at most. */
export async function downloadFigmaFile(url: string, signal?: AbortSignal, fetch: typeof globalThis.fetch = globalThis.fetch): Promise<Blob> {
  if (!isFigmaFileLink(url)) throw new Error('Not a link to a Figma file.');
  const response = await fetch(url, {credentials: 'omit', referrerPolicy: 'no-referrer', signal: withTimeout(signal, DOWNLOAD_TIMEOUT_MS)});
  if (!response.ok) throw new Error(`Figma returned the file with error ${response.status}.`);
  const bytes = await readCappedBytes(response, MAX_DOWNLOAD_BYTES);
  return new Blob([bytes], {type: response.headers.get('Content-Type') ?? ''});
}
