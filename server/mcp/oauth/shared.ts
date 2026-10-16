// What the authorization server's parts share (docs/mcp-server.md §Sign-in): its numbers, its error, the HTTP helpers, PKCE, redirect
// addresses, the consent form's CSRF token and the reader of what a client says about itself. Reduced to
// what a server on the app's origin needs: two rights (`read`, and `write` while
// editing is on), registered clients only (no Client ID Metadata Documents), no per-file choice on the consent page.
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import type {Request, Response} from 'express';
import {authCookieName, authCookieOptions, digest, sessionToken} from '../../auth';
import {mcpEditsOn} from '../config';

// ── Numbers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The rights a person grants: reading their files, and changing them (only while editing is on: `mcpEditsOn`). `offline_access` is
 *  remembered (the token answer echoes it) but is no right. */
export const SCOPES = ['read', 'write'] as const;
export type Scope = (typeof SCOPES)[number];
export const OFFLINE_ACCESS = 'offline_access';
export const KNOWN_SCOPES: readonly string[] = [...SCOPES, OFFLINE_ACCESS];
/** The rights offered now: `write` only while editing is on. */
export const offeredScopes = (): Scope[] => (mcpEditsOn() ? ['read', 'write'] : ['read']);

export const ACCESS_TOKEN_SECONDS = 3600 as const;
export const REFRESH_TOKEN_DAYS = 30;
/** A refresh token shown again this soon after its first use is a client retrying (two refreshes raced), not a thief. */
export const REFRESH_RETRY_SECONDS = 30;
/** From "Allow" to the code exchange. */
export const CODE_SECONDS = 300;
/** From /oauth/authorize to the decision (a sign-in may happen in between). */
export const REQUEST_MINUTES = 10;
/** A registered client that never obtained a grant is forgotten after this long; MAX_UNUSED_REGISTRATIONS bounds a flood. */
export const REGISTERED_CLIENT_DAYS = 30;
/** While a person is signing in for a registered client, it is kept at least this long. */
export const SIGN_IN_KEEPS_CLIENT_MINUTES = 60;
export const MAX_UNUSED_REGISTRATIONS = 5000;

export const MAX_REDIRECT_URIS = 20;
export const REDIRECT_URI_MAX = 2048;
export const CLIENT_NAME_MAX = 80;
export const CLIENT_ID_MAX = 512;
export const STATE_MAX = 1024;
export const BODY_LIMIT = '16kb';
export const BODY_LIMIT_BYTES = 16 * 1024;
export const FORM_PARAMETER_LIMIT = 50;

/** Per address and 15 minutes. Hosted assistants share a few egress addresses, so the token endpoint and registration have room. */
export const LIMIT_WINDOW_MS = 15 * 60_000;
export const PAGE_LIMIT = 100;
export const TOKEN_LIMIT = 300;
export const REGISTRATION_LIMIT = 60;

export const BINDING_COOKIE = 'mcp_oauth_req';
export const BINDING_COOKIE_MS = REQUEST_MINUTES * 60_000;

/** Every secret is a prefix + base64url(32 random bytes) (43 characters), stored as its sha256 (hex). */
export const ACCESS_PREFIX = 'morfa_at_';
export const REFRESH_PREFIX = 'morfa_rt_';
export const CODE_PREFIX = 'morfa_ac_';
export const CLIENT_PREFIX = 'morfa_c_';
export const secretPattern = (prefix: string): RegExp => new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The rights of a stored JSON column, only known ones, in canonical order. */
export const scopesOf = (value: unknown): Scope[] =>
  SCOPES.filter(scope => Array.isArray(value) && value.includes(scope));

// ── The error ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'server_error'
  | 'invalid_client_metadata'
  | 'invalid_redirect_uri'
  | 'unsupported_response_type'
  | 'temporarily_unavailable';

export class OAuthError extends Error {
  constructor(
    readonly error: OAuthErrorCode,
    description: string,
    readonly status: 400 | 401 | 403 | 429 | 500 | 503 = 400,
  ) {
    super(description);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const noStore = (res: Response): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
};

/** The token and revocation endpoints and the metadata take no cookie: any origin may call them. Registration has no CORS answer. */
export const openCors = (res: Response): void => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
};

/** RFC 6749 §5.2: {error, error_description}, never more. */
export function sendOAuthError(
  res: Response,
  error: OAuthError | {error: string; description: string; status: number},
): void {
  const answer =
    error instanceof OAuthError ? {error: error.error, description: error.message, status: error.status} : error;
  if ((answer.status === 429 || answer.status === 503) && !res.getHeader('Retry-After'))
    res.setHeader('Retry-After', '60');
  res.status(answer.status).json({error: answer.error, error_description: answer.description});
}

const BINDING_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const bindingName = () => authCookieName(BINDING_COOKIE);

/** The browser-binding secret of the cookie, when it is one. */
export function bindingOf(req: Request): string | undefined {
  const value = req.cookies?.[bindingName()];
  return typeof value === 'string' && BINDING_SHAPE.test(value) ? value : undefined;
}
export const bindingHash = (binding: string): string => digest(binding);
export const setBinding = (res: Response, binding: string): void =>
  void res.cookie(bindingName(), binding, {...authCookieOptions(), maxAge: BINDING_COOKIE_MS});
export const clearBinding = (res: Response): void => void res.clearCookie(bindingName(), authCookieOptions());

/** The stored form of the session token (what the CSRF token is bound to), or undefined without a session cookie. */
export const sessionDigestOf = (req: Request): string | undefined => {
  const token = sessionToken(req);
  return token ? digest(token) : undefined;
};

/** The consent POST comes from the page we served: the browser says so in Sec-Fetch-Site and Origin, which another site cannot set.
 *  The routes sit outside /api, so the app's own origin guard does not cover them. */
export function isSameOriginPost(req: Request, issuer: string): boolean {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = req.get('origin');
  if (!origin) return !!site;
  const own = new URL(issuer).origin;
  if (process.env.NODE_ENV === 'production') return origin === own;
  return origin === own || origin === `${req.protocol}://${req.get('host')}`;
}

/** A query or form value that is one plain string (a repeated or nested one is none). */
export const oneString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length <= max ? value : undefined;

// ── PKCE (RFC 7636), S256 only ──────────────────────────────────────────────────────────────────────────────────────────────

export const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** True when `verifier` hashes to `challenge`, compared in constant time. A verifier or challenge of the wrong shape is a plain no. */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier) || !CHALLENGE_PATTERN.test(challenge)) return false;
  const expected = Buffer.from(challenge),
    actual = Buffer.from(challengeOf(verifier));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── Redirect addresses (RFC 6749 §3.1.2, RFC 8252 §7.3) ─────────────────────────────────────────────────────────────────────
// https, or loopback http whose port the client picks each time. No custom scheme, no login, no fragment. Matched by exact text,
// except that a loopback address may differ in its port.

const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const PLAIN_ADDRESS = /^[\x21-\x7e]+$/;
const isLoopback = (url: URL): boolean => url.protocol === 'http:' && LOOPBACK.has(url.hostname);

export function parseRedirectUri(raw: unknown): URL | undefined {
  if (
    typeof raw !== 'string' ||
    raw.length < 8 ||
    raw.length > REDIRECT_URI_MAX ||
    !PLAIN_ADDRESS.test(raw) ||
    raw.includes('#')
  )
    return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.username || url.password || !url.hostname) return;
  return url.protocol === 'https:' || isLoopback(url) ? url : undefined;
}

export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  const asked = parseRedirectUri(requested);
  if (!asked) return false;
  return registered.some(candidate => {
    if (candidate === requested) return true;
    const known = parseRedirectUri(candidate);
    return (
      !!known &&
      isLoopback(known) &&
      isLoopback(asked) &&
      known.hostname === asked.hostname &&
      known.pathname === asked.pathname &&
      known.search === asked.search
    );
  });
}

/** `redirectUri` with the parameters that are set appended. */
export function responseUrl(redirectUri: string, parameters: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) if (value !== undefined) url.searchParams.append(name, value);
  return url.href;
}

export const redirectOrigin = (redirectUri: string): string | undefined => parseRedirectUri(redirectUri)?.origin;

/** The host names a registered client can be checked by: those of its redirect addresses. Shown next to its self-chosen name. */
export function clientHostOf(redirectUris: readonly string[]): string {
  const hosts = [...new Set(redirectUris.flatMap(uri => parseRedirectUri(uri)?.host ?? []))];
  return hosts.length > 3 ? `${hosts.slice(0, 3).join(', ')} and ${hosts.length - 3} more` : hosts.join(', ');
}

// ── The consent form's CSRF token ───────────────────────────────────────────────────────────────────────────────────────────
// An HMAC keyed by the browser-binding cookie over the request and the session: another site cannot read the cookie, a token made
// for one request or session fails on another, and nothing is stored.

const CSRF_LABEL = 'morfa mcp oauth csrf v1';
export const csrfToken = (binding: string, requestId: string, sessionDigest: string): string =>
  createHmac('sha256', binding)
    .update(JSON.stringify([CSRF_LABEL, requestId, sessionDigest]))
    .digest('base64url');
export function csrfValid(presented: unknown, binding: string, requestId: string, sessionDigest: string): boolean {
  if (typeof presented !== 'string') return false;
  const expected = Buffer.from(csrfToken(binding, requestId, sessionDigest)),
    given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ── What a client says about itself (RFC 7591) ──────────────────────────────────────────────────────────────────────────────
// Written by a stranger: only the fields the server uses are kept, and a name is only a label, never a reason to allow anything.

export type ClientMetadata = {clientName: string; redirectUris: string[]; stored: Record<string, unknown>};

const MAX_LIST_ENTRIES = 20;
const MAX_ENTRY_CHARS = 100;
const NO_NAME = 'Unnamed application';

/** A name for a label: no control or invisible formatting characters (bidi overrides included), single spaces, at most 80 characters. */
export function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, CLIENT_NAME_MAX).join('').trim();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) &&
  value.length <= MAX_LIST_ENTRIES &&
  value.every(item => typeof item === 'string' && item.length <= MAX_ENTRY_CHARS)
    ? (value as string[])
    : undefined;

/** Reads a registration body. Throws OAuthError `invalid_client_metadata` or `invalid_redirect_uri` (RFC 7591). */
export function readClientMetadata(input: unknown): ClientMetadata {
  const refuse = (error: 'invalid_client_metadata' | 'invalid_redirect_uri', description: string): never => {
    throw new OAuthError(error, description);
  };
  if (!isRecord(input)) return refuse('invalid_client_metadata', 'The application description must be a JSON object.');
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS)
    return refuse('invalid_redirect_uri', 'redirect_uris must be a list of 1–20 addresses.');
  const redirectUris = [
    ...new Set(
      uris.map(uri =>
        parseRedirectUri(uri)
          ? (uri as string)
          : refuse(
              'invalid_redirect_uri',
              'The redirect address must be https or loopback http, without credentials or a fragment.',
            ),
      ),
    ),
  ];
  // Every client is public (PKCE): a client asking to authenticate otherwise (ChatGPT may prefer `private_key_jwt`) is registered with
  // `none`, which the answer says (RFC 7591 §3.2.1 lets the server replace a value); nothing it presents at the token endpoint is read.
  const grants = input.grant_types === undefined ? undefined : stringList(input.grant_types);
  if (input.grant_types !== undefined && (!grants || !grants.includes('authorization_code')))
    return refuse('invalid_client_metadata', 'grant_types must include authorization_code.');
  const responses = input.response_types === undefined ? undefined : stringList(input.response_types);
  if (input.response_types !== undefined && (!responses || !responses.includes('code')))
    return refuse('invalid_client_metadata', 'response_types must include code.');
  const clientName = cleanName(input.client_name) || NO_NAME;
  return {
    clientName,
    redirectUris,
    stored: {
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: (grants ?? ['authorization_code']).filter(
        grant => grant === 'authorization_code' || grant === 'refresh_token',
      ),
      response_types: ['code'],
    },
  };
}

/** OpenID Connect's words some assistants add to every request (openid, profile, email): no right here, so passed over. */
const OIDC_SCOPES: ReadonlySet<string> = new Set(['openid', 'profile', 'email']);

/** The rights asked for: only known words, OpenID Connect's passed over. Reading always; changing files when it is asked for, or when no right is named (the
 *  assistants connect with what the server offers), and only while editing is on. */
export function parseScopes(raw: string | undefined): {scopes: Scope[]; offlineAccess: boolean} | undefined {
  const words = (raw ?? '').split(' ').filter(word => word && !OIDC_SCOPES.has(word));
  if (words.some(word => !KNOWN_SCOPES.includes(word))) return;
  const named = words.some(word => word !== OFFLINE_ACCESS);
  const write = mcpEditsOn() && (!named || words.includes('write'));
  return {scopes: write ? ['read', 'write'] : ['read'], offlineAccess: words.includes(OFFLINE_ACCESS)};
}

/** The RFC 8414 document: every address built on the issuer. Client ID Metadata Documents are not offered (the hosted
 *  assistants' hosts were found to refuse the server's fetch; they register at `registration_endpoint` instead). */
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...offeredScopes(), OFFLINE_ACCESS],
    authorization_response_iss_parameter_supported: true,
    ui_locales_supported: ['en'],
  };
}

/** An unexpected failure of an endpoint, for the operator's error list: the error, never the request. */
export async function captureOAuthError(error: unknown): Promise<void> {
  try {
    const {captureError} = await import('../../admin/telemetry');
    await captureError(error);
  } catch {
    /* Reporting must not turn a refused request into a second failure. */
  }
}
