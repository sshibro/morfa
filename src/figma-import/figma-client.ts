import type {FigmaConnectionKind} from '../../shared/figma/api';
import {MAX_FIGMA_RESPONSE_BYTES} from '../../shared/figma/limits';
import {figmaErrorCopy, type FigmaErrorFacts, type FigmaErrorKind, type FigmaRateType} from './figma-errors';
import {readCapped, TooLargeError} from './read-capped';

export const FIGMA_API_ORIGIN = 'https://api.figma.com';
// Error answers are small JSON; nothing bigger is worth reading.
const MAX_ERROR_BYTES = 64 * 1024;
const INVALID_TOKEN = /invalid token|token (?:has )?expired|expired token/i;
// A valid token without the right a call needs: "Invalid scope(s): … This endpoint requires the current_user:read scope".
const MISSING_SCOPE = /scope/i;

/** A failed Figma call; the message is the Russian sentence for the screen. */
export class FigmaApiError extends Error {
  readonly kind: FigmaErrorKind;
  readonly status?: number;
  readonly retryAfter?: number;
  readonly rateType?: FigmaRateType;
  readonly upgradeLink?: string;
  readonly tooLarge?: boolean;
  /** A second line for the fold under the message. */
  readonly more?: string;

  constructor(facts: FigmaErrorFacts) {
    const copy = figmaErrorCopy(facts);
    super(copy.message);
    this.name = 'FigmaApiError';
    this.kind = facts.kind;
    this.status = facts.status;
    this.retryAfter = facts.retryAfter;
    this.rateType = facts.rateType;
    this.upgradeLink = facts.upgradeLink;
    this.tooLarge = facts.tooLarge;
    this.more = copy.more;
  }
}

export type FigmaUser = {id: string; handle: string};
export type FigmaImageFormat = 'png' | 'svg';
export type FigmaClient = {
  me(signal?: AbortSignal): Promise<FigmaUser>;
  /** `depth` 0 reads the whole tree; `geometry: 'paths'` adds vector paths, sizes and transforms. */
  file(fileKey: string, depth: number, signal?: AbortSignal, geometry?: 'paths'): Promise<unknown>;
  nodes(fileKey: string, ids: string[], signal?: AbortSignal, geometry?: 'paths'): Promise<unknown>;
  images(fileKey: string, ids: string[], format: FigmaImageFormat, signal?: AbortSignal): Promise<Record<string, string | null>>;
  imageFills(fileKey: string, signal?: AbortSignal): Promise<Record<string, string>>;
};

type Options = {token: string; kind: FigmaConnectionKind; fetch?: typeof globalThis.fetch; origin?: string; maxBytes?: number};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const httpsOnly = (value: unknown): string | null => (typeof value === 'string' && /^https:\/\//i.test(value) ? value : null);

function retryAfterOf(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

function upgradeLinkOf(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const link = new URL(value);
    const host = link.hostname.toLowerCase();
    return link.protocol === 'https:' && (host === 'figma.com' || host.endsWith('.figma.com')) ? link.href : undefined;
  } catch {
    return undefined;
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = JSON.parse(await readCapped(response, MAX_ERROR_BYTES)) as unknown;
    if (!isObject(body)) return '';
    return [body.err, body.message, body.error].filter(value => typeof value === 'string').join(' ');
  } catch {
    return '';
  }
}

async function failureOf(response: Response): Promise<FigmaApiError> {
  const {status, headers} = response;
  if (status === 429) {
    const type = headers.get('X-Figma-Rate-Limit-Type')?.toLowerCase();
    return new FigmaApiError({
      kind: 'rate', status,
      retryAfter: retryAfterOf(headers.get('Retry-After')),
      rateType: type === 'low' || type === 'high' ? type : undefined,
      upgradeLink: upgradeLinkOf(headers.get('X-Figma-Upgrade-Link')),
    });
  }
  if (status === 401) return new FigmaApiError({kind: 'token', status});
  if (status === 403) {
    const text = await errorText(response);
    return new FigmaApiError({kind: INVALID_TOKEN.test(text) ? 'token' : MISSING_SCOPE.test(text) ? 'scope' : 'access', status});
  }
  if (status === 404) return new FigmaApiError({kind: 'missing', status});
  return new FigmaApiError({kind: status >= 500 ? 'server' : 'bad', status});
}

/** Figma's REST API from this browser tab, with the owner's token. Only JSON, never cookies. */
export function createFigmaClient({token, kind, fetch = globalThis.fetch, origin = FIGMA_API_ORIGIN, maxBytes = MAX_FIGMA_RESPONSE_BYTES}: Options): FigmaClient {
  const auth: Record<string, string> = kind === 'oauth' ? {Authorization: `Bearer ${token}`} : {'X-Figma-Token': token};

  async function get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(path, origin);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await fetch(url.href, {method: 'GET', headers: {Accept: 'application/json', ...auth}, credentials: 'omit', referrerPolicy: 'no-referrer', signal});
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new FigmaApiError({kind: 'network'});
    }
    if (!response.ok) throw await failureOf(response);
    const type = response.headers.get('Content-Type');
    if (type && !/json/i.test(type)) throw new FigmaApiError({kind: 'bad', status: response.status});
    try {
      return JSON.parse(await readCapped(response, maxBytes));
    } catch (cause) {
      if (cause instanceof TooLargeError) throw new FigmaApiError({kind: 'bad', status: response.status, tooLarge: true});
      if (signal?.aborted) throw signal.reason ?? cause;
      if (cause instanceof SyntaxError) throw new FigmaApiError({kind: 'bad', status: response.status});
      throw new FigmaApiError({kind: 'network'});
    }
  }

  const fileAt = (fileKey: string) => `/v1/files/${encodeURIComponent(fileKey)}`;

  return {
    async me(signal) {
      const body = await get('/v1/me', {}, signal);
      if (!isObject(body) || typeof body.handle !== 'string') throw new FigmaApiError({kind: 'bad'});
      return {id: String(body.id ?? ''), handle: body.handle.slice(0, 200)};
    },
    file: (fileKey, depth, signal, geometry) => get(fileAt(fileKey), {...(depth > 0 ? {depth: String(depth)} : {}), ...(geometry ? {geometry} : {})}, signal),
    nodes: (fileKey, ids, signal, geometry) => get(`${fileAt(fileKey)}/nodes`, {ids: ids.join(','), ...(geometry ? {geometry} : {})}, signal),
    async images(fileKey, ids, format, signal) {
      const params: Record<string, string> = format === 'png' ? {ids: ids.join(','), format, scale: '2'} : {ids: ids.join(','), format, svg_outline_text: 'true'};
      const body = await get(`/v1/images/${encodeURIComponent(fileKey)}`, params, signal);
      const images = isObject(body) && isObject(body.images) ? body.images : {};
      return Object.fromEntries(ids.map(id => [id, httpsOnly(images[id])]));
    },
    async imageFills(fileKey, signal) {
      const body = await get(`${fileAt(fileKey)}/images`, {}, signal);
      const images = isObject(body) && isObject(body.meta) && isObject(body.meta.images) ? body.meta.images : {};
      return Object.fromEntries(Object.entries(images).flatMap(([ref, url]) => (httpsOnly(url) ? [[ref, url as string]] : [])));
    },
  };
}
