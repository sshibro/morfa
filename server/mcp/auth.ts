// Who is calling /mcp, and whether they may (docs/mcp-server.md §Calls). Read-only:
// one right, one budget per connection.
//   no credential, or one that does not resolve   → 401 with the sign-in challenge (or a tool-error result for the clients that start
//                                                    sign-in from one: ChatGPT)
//   a valid credential of an account not open      → 403 account_not_enabled
//   too many calls, or too many dead credentials   → 429 with Retry-After
// An unknown, expired, revoked, malformed or closed-account credential gets the identical 401: nothing tells them apart.
import {createHash, timingSafeEqual} from 'node:crypto';
import {isIPv6} from 'node:net';
import {digest} from '../auth';
import {db} from '../db';
import {ONE_MINUTE_MS} from '../time-constants';
import {
  acceptedResourceUrls,
  MCP_CALLS_PER_MINUTE,
  mcpAvailable,
  protectedResourceMetadataUrl,
  toolErrorSignInClients,
} from './config';
import {ACCESS_PREFIX, offeredScopes, scopesOf, secretPattern, type Scope} from './oauth/shared';

/** The caller of a request: one grant (one assistant a person allowed), through one of its access tokens. */
export type Principal = Readonly<{
  /** oauth_grants.id: what "Connections" lists and revokes, and the rate-limit key. */
  grantId: string;
  /** The access token's row. */
  tokenId: string;
  userId: string;
  /** The assistant's own name for itself, at most 80 characters. */
  client: string;
  scopes: ReadonlySet<Scope>;
}>;

export type CredentialFailure =
  'missing' | 'malformed' | 'unknown' | 'expired' | 'revoked' | 'account_closed' | 'account_not_enabled';
export type VerifyResult = {ok: true; principal: Principal} | {ok: false; failure: CredentialFailure};

const BEARER = /^bearer +(\S+)$/i;
const ACCESS_TOKEN_PATTERN = secretPattern(ACCESS_PREFIX);

/** The credential of an Authorization header, or why there is none. Never throws. */
export function bearerCredential(
  authorization: string | undefined,
): {ok: true; secret: string} | {ok: false; reason: 'missing' | 'malformed'} {
  const header = authorization?.trim();
  if (!header) return {ok: false, reason: 'missing'};
  const secret = BEARER.exec(header)?.[1];
  if (!secret || !ACCESS_TOKEN_PATTERN.test(secret)) return {ok: false, reason: 'malformed'};
  return {ok: true, secret};
}

export type CredentialRow = {
  token_id: string;
  grant_id: string;
  user_id: string;
  client: string;
  scopes: unknown;
  token_hash: string;
  live: boolean;
  revoked: boolean;
  resource: string;
  email: string;
  email_verified: number;
  closed: boolean;
};
export const CREDENTIAL_SQL = `SELECT k.id AS token_id,g.id AS grant_id,g.user_id,g.client_name AS client,g.scopes,k.token_hash,k.resource,
    (k.expires_at > clock_timestamp()) AS live,(k.revoked_at IS NOT NULL OR g.revoked_at IS NOT NULL) AS revoked,
    u.email,u.email_verified,(u.deletion_requested_at IS NOT NULL OR u.erasure_completed_at IS NOT NULL) AS closed
  FROM oauth_tokens k JOIN oauth_grants g ON g.id=k.grant_id JOIN users u ON u.id=g.user_id WHERE k.token_hash=$1 AND k.kind='access'`;

/** Whether a stored credential row may act now; the reason when it may not. In this order, so that an expired or revoked credential
 *  never learns anything about the account behind it. */
export function credentialState(row: CredentialRow | undefined): CredentialFailure | undefined {
  if (!row) return 'unknown';
  // An access token is good only for the address it was issued for (RFC 8707).
  if (!acceptedResourceUrls().includes(row.resource)) return 'unknown';
  if (!row.live) return 'expired';
  if (row.revoked) return 'revoked';
  if (row.closed) return 'account_closed';
  if (!mcpAvailable({id: row.user_id, email: row.email, email_verified: row.email_verified}))
    return 'account_not_enabled';
}

const sameHash = (stored: string, presented: string): boolean => {
  const a = Buffer.from(stored, 'hex'),
    b = Buffer.from(presented, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Resolves the header to a principal. Never throws for a bad credential. */
export async function verifyCredential(authorization: string | undefined): Promise<VerifyResult> {
  const presented = bearerCredential(authorization);
  if (!presented.ok) return {ok: false, failure: presented.reason};
  const hash = digest(presented.secret);
  const row = await db.one<CredentialRow>(CREDENTIAL_SQL, [hash]);
  const failure = row && !sameHash(row.token_hash, hash) ? 'unknown' : credentialState(row);
  if (failure) return {ok: false, failure};
  const principal: Principal = {
    grantId: row!.grant_id,
    tokenId: row!.token_id,
    userId: row!.user_id,
    client: row!.client.slice(0, 80),
    scopes: new Set(scopesOf(row!.scopes)),
  };
  stampLastUsed(principal.grantId);
  return {ok: true, principal};
}

/* last_used_at, for "Connections": stamped at most once a minute per grant (the process remembers, bounded, and the statement repeats
 * the check for the other processes). Fire and forget: a failed stamp is no reason to refuse a call. */
const MAX_STAMPED = 10_000;
const stampedAt = new Map<string, number>();
function stampLastUsed(grantId: string, now: number = Date.now()): void {
  const last = stampedAt.get(grantId);
  if (last !== undefined && now - last < ONE_MINUTE_MS) return;
  stampedAt.delete(grantId);
  stampedAt.set(grantId, now);
  while (stampedAt.size > MAX_STAMPED) stampedAt.delete(stampedAt.keys().next().value as string);
  void db
    .execute(
      "UPDATE oauth_grants SET last_used_at=clock_timestamp() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < clock_timestamp() - interval '1 minute')",
      [grantId],
    )
    .catch(() => undefined);
}

// ── Rate limits ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fixed one-minute windows in process memory (each api process has its own: with two, a connection may make twice the calls).
// Bounded stores: a flood of addresses or tokens never grows them past their cap.

export type RateDecision = {ok: true} | {ok: false; retryAfterSeconds: number};
type Entry = Readonly<{windowStart: number; count: number}>;

export function createRateLimiter(maxKeys: number) {
  const entries = new Map<string, Entry>();
  const retry = (entry: Entry, now: number) =>
    Math.min(60, Math.max(1, Math.ceil((entry.windowStart + ONE_MINUTE_MS - now) / 1000)));
  return {
    take(key: string, perMinute: number, now: number = Date.now()): RateDecision {
      const held = entries.get(key);
      const live = held && now - held.windowStart < ONE_MINUTE_MS ? held : undefined;
      if (!live) {
        entries.delete(key);
        // Expired windows are at the front (a key that starts a new window is inserted again): sweep them, then drop the oldest.
        for (const [old, entry] of entries) {
          if (entries.size < maxKeys || now - entry.windowStart < ONE_MINUTE_MS) break;
          entries.delete(old);
        }
        while (entries.size >= maxKeys) entries.delete(entries.keys().next().value as string);
      }
      const entry: Entry = live ?? {windowStart: now, count: 0};
      if (entry.count >= perMinute) return {ok: false, retryAfterSeconds: retry(entry, now)};
      entries.set(key, {windowStart: entry.windowStart, count: entry.count + 1});
      return {ok: true};
    },
    peek(key: string, perMinute: number, now: number = Date.now()): RateDecision {
      const held = entries.get(key);
      if (!held || now - held.windowStart >= ONE_MINUTE_MS || held.count < perMinute) return {ok: true};
      return {ok: false, retryAfterSeconds: retry(held, now)};
    },
    clear: () => entries.clear(),
  };
}

const connections = createRateLimiter(10_000);
const anonymous = createRateLimiter(50_000);
const failed = createRateLimiter(50_000);
/** Credentials just seen to fail, by fingerprint, for a minute: one dead token sent in a loop (a client retrying after "Disconnect")
 *  costs one query and one unit of its address's budget, not one per request, so it never locks out others behind that address. */
const knownBad = new Map<string, number>();

export function resetMcpRateLimits(): void {
  connections.clear();
  anonymous.clear();
  failed.clear();
  knownBad.clear();
}

/** The address a caller is counted by: an IPv4-mapped address as its IPv4, an IPv6 address as its /64. */
export function anonymousKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const address = ip.split('%')[0]!;
  if (!isIPv6(address)) return ip;
  const [head, tail] = address.split('::');
  const first = head ? head.split(':') : [];
  const last = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
  return (
    groups
      .slice(0, 4)
      .map(group => group.toLowerCase().padStart(4, '0'))
      .join(':') + '::/64'
  );
}

// ── The gate ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One JSON-RPC message of a request: its method, its id (null for a notification), and whether it calls a tool. */
export type GateCall = {method: string; id: string | number | null; tool: boolean};
export type GateInput = {authorization: string | undefined; userAgent: string; ip: string; calls: readonly GateCall[]};
/** 200 is the tool-error answer for the clients that start sign-in from a tool result. */
export type GateRefusal = {ok: false; status: 200 | 401 | 403 | 429; headers: Record<string, string>; body: unknown};
export type GateResult = {ok: true; principal: Principal | null} | GateRefusal;

/** The rights a challenge asks for: every one on offer, since hosts ask for the challenge's scope before the metadata's. */
const challengeScope = (): string => offeredScopes().join(' ');

/** The WWW-Authenticate value that sends a client to the sign-in (RFC 9728 `resource_metadata`). */
export function bearerChallenge(error?: 'invalid_token'): string {
  return `Bearer realm="morfa"${error ? `, error="${error}"` : ''}, scope="${challengeScope()}", resource_metadata="${protectedResourceMetadataUrl()}"`;
}

const UNAUTHORIZED_CODE = -32001;
const FORBIDDEN_CODE = -32002;
const RATE_LIMITED_CODE = -32003;

export const unauthorizedRefusal = (id: string | number | null = null, error?: 'invalid_token'): GateRefusal => ({
  ok: false,
  status: 401,
  headers: {'WWW-Authenticate': bearerChallenge(error)},
  body: {jsonrpc: '2.0', error: {code: UNAUTHORIZED_CODE, message: 'Authentication required.'}, id},
});

/** The challenge inside a tool result, where ChatGPT looks for one (`_meta["mcp/www_authenticate"]`, developers.openai.com/apps-sdk). */
const toolErrorRefusal = (id: string | number, presented: boolean): GateRefusal => ({
  ok: false,
  status: 200,
  headers: {},
  body: {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      isError: true,
      content: [{type: 'text', text: 'Sign in to Morfa to continue.'}],
      _meta: {
        'mcp/www_authenticate': [
          `Bearer resource_metadata="${protectedResourceMetadataUrl()}", error="${presented ? 'invalid_token' : 'insufficient_scope'}", error_description="${presented ? 'This Morfa connection no longer works. Sign in again' : 'Sign in to Morfa to continue'}", scope="${challengeScope()}"`,
        ],
      },
    },
  },
});

const rateLimitedRefusal = (id: string | number | null, retryAfterSeconds: number): GateRefusal => ({
  ok: false,
  status: 429,
  headers: {'Retry-After': String(retryAfterSeconds)},
  body: {
    jsonrpc: '2.0',
    error: {
      code: RATE_LIMITED_CODE,
      message: `Too many requests. Retry in ${retryAfterSeconds} s.`,
      data: {code: 'rate_limited', retryAfterSeconds},
    },
    id,
  },
});

export type GateDependencies = {
  verify: (authorization: string | undefined) => Promise<VerifyResult>;
  toolErrorClients?: () => string[];
};

const firstId = (calls: readonly GateCall[]): string | number | null =>
  calls.find(call => call.id !== null)?.id ?? null;

export function createGate({verify, toolErrorClients = toolErrorSignInClients}: GateDependencies) {
  const startsFromToolError = (input: GateInput) => {
    const agent = input.userAgent.toLowerCase();
    return toolErrorClients().some(fragment => agent.includes(fragment));
  };
  function signIn(input: GateInput, toolCall: GateCall | undefined, presented: boolean): GateRefusal {
    if (startsFromToolError(input) && toolCall?.id != null && input.calls.length === 1)
      return toolErrorRefusal(toolCall.id, presented);
    return unauthorizedRefusal(toolCall?.id ?? firstId(input.calls), presented ? 'invalid_token' : undefined);
  }
  /** One unit per message (a request with none, a GET, counts once). */
  function spend(input: GateInput, take: () => RateDecision): GateRefusal | undefined {
    for (const call of input.calls.length ? input.calls : [undefined]) {
      const taken = take();
      if (!taken.ok) return rateLimitedRefusal(call?.id ?? firstId(input.calls), taken.retryAfterSeconds);
    }
  }

  return async function gate(input: GateInput): Promise<GateResult> {
    const toolCall = input.calls.find(call => call.tool);
    const address = anonymousKey(input.ip);
    if (!input.authorization?.trim()) {
      const refused = spend(input, () => anonymous.take(address, MCP_CALLS_PER_MINUTE.anonymous));
      if (refused) return refused;
      // Every request asks for the sign-in at once (a 401 with the challenge), which is how Claude and the other hosts know to start it;
      // Claude's directory requires it. ChatGPT starts sign-in from a tool's answer instead, so its handshake and tool list go on.
      if (toolCall || !startsFromToolError(input)) return signIn(input, toolCall, false);
      return {ok: true, principal: null};
    }
    const fingerprint = createHash('sha256').update(input.authorization.trim()).digest('hex');
    const until = knownBad.get(fingerprint);
    if (until !== undefined && until > Date.now()) return signIn(input, toolCall, true);
    // An address that spent its failed credentials is turned away before the database is asked: made-up tokens cost a query each.
    const spent = failed.peek(address, MCP_CALLS_PER_MINUTE.anonymous);
    if (!spent.ok) return rateLimitedRefusal(firstId(input.calls), spent.retryAfterSeconds);
    const verdict = await verify(input.authorization);
    if (!verdict.ok) {
      // The account's own state is told only to the holder of a valid credential.
      if (verdict.failure === 'account_not_enabled')
        return {
          ok: false,
          status: 403,
          headers: {},
          body: {
            jsonrpc: '2.0',
            error: {
              code: FORBIDDEN_CODE,
              message: 'The Morfa MCP server is not open to this account yet.',
              data: {code: 'account_not_enabled'},
            },
            id: firstId(input.calls),
          },
        };
      knownBad.delete(fingerprint);
      knownBad.set(fingerprint, Date.now() + ONE_MINUTE_MS);
      while (knownBad.size > 10_000) knownBad.delete(knownBad.keys().next().value as string);
      const recorded = failed.take(address, MCP_CALLS_PER_MINUTE.anonymous);
      return recorded.ok
        ? signIn(input, toolCall, true)
        : rateLimitedRefusal(firstId(input.calls), recorded.retryAfterSeconds);
    }
    const refused = spend(input, () => connections.take(verdict.principal.grantId, MCP_CALLS_PER_MINUTE.connection));
    return refused ?? {ok: true, principal: verdict.principal};
  };
}

/** The gate of /mcp: the credential store, loaded on the first credential shown. */
export const gateMcpRequest = createGate({verify: verifyCredential});

// ── The day's calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Counts one tool call against the account's UTC day, all its connections together; false when the day's calls are spent (the
 *  call is then not counted). One statement, so every api process shares the count. */
export async function takeDailyCall(userId: string, limit: number): Promise<boolean> {
  const row = await db.one<{calls: number}>(
    `INSERT INTO mcp_daily_calls(user_id,day,calls) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1)
     ON CONFLICT (user_id,day) DO UPDATE SET calls=mcp_daily_calls.calls+1 WHERE mcp_daily_calls.calls < $2
     RETURNING calls`,
    [userId, limit],
  );
  return !!row;
}
