// The authorization server's rows (docs/mcp-server.md §Sign-in; SQL025): registered clients, authorization requests and their codes,
// grants, and the access and refresh tokens. Every secret is stored as its sha256; a refusal at the token endpoint carries the same words
// whichever check failed.
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {digest} from '../../auth';
import {db} from '../../db';
import type {SqlExecutor, TransactionContext} from '../../postgresql/client';
import {lockResources} from '../../postgresql/locks';
import {acceptedResourceUrls, mcpAvailable} from '../config';
import {
  ACCESS_PREFIX,
  ACCESS_TOKEN_SECONDS,
  CLIENT_ID_MAX,
  CLIENT_PREFIX,
  CODE_PREFIX,
  CODE_SECONDS,
  clientHostOf,
  MAX_UNUSED_REGISTRATIONS,
  OAuthError,
  OFFLINE_ACCESS,
  readClientMetadata,
  REFRESH_PREFIX,
  REFRESH_RETRY_SECONDS,
  REFRESH_TOKEN_DAYS,
  REGISTERED_CLIENT_DAYS,
  REQUEST_ID,
  offeredScopes,
  scopesOf,
  secretPattern,
  SIGN_IN_KEEPS_CLIENT_MINUTES,
  verifierMatches,
  type Scope,
} from './shared';

export const newSecret = (prefix: string): string => prefix + randomBytes(32).toString('base64url');
const sameHash = (stored: string, presented: string): boolean => {
  const a = Buffer.from(stored, 'hex'),
    b = Buffer.from(presented, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
const account = (tx: TransactionContext, userId: string) => lockResources(tx, [{kind: 'account', id: userId}]);

// ── Clients ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OAuthClient = {id: string; clientName: string; redirectUris: string[]; grantTypes: string[]};
type ClientRecord = {id: string; client_name: string; redirect_uris: unknown; metadata: Record<string, unknown>};
const CLIENT_COLUMNS = 'id,client_name,redirect_uris,metadata';
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const clientOf = (record: ClientRecord): OAuthClient => ({
  id: record.id,
  clientName: record.client_name,
  redirectUris: strings(record.redirect_uris),
  grantTypes: strings(record.metadata?.grant_types),
});
const unknownClient = () => new OAuthError('invalid_client', 'Application not found.');

/** A registered client that has not expired; throws OAuthError('invalid_client'). */
export async function resolveClient(clientId: string): Promise<OAuthClient> {
  if (typeof clientId !== 'string' || !clientId || clientId.length > CLIENT_ID_MAX) throw unknownClient();
  const record = await db.one<ClientRecord>(
    `SELECT ${CLIENT_COLUMNS} FROM oauth_clients WHERE id=$1 AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
    [clientId],
  );
  if (!record) throw unknownClient();
  return clientOf(record);
}

/** At the cap on clients nobody has used yet, the oldest unused ones are forgotten: a flood of registrations costs the flooder its
 *  own clients and never locks everyone else out. Refused only when every client at the cap is mid sign-in. */
async function makeRoomForRegistration(): Promise<void> {
  const waiting = await db.one<{n: number}>(
    'SELECT count(*)::int AS n FROM oauth_clients WHERE expires_at IS NOT NULL AND expires_at > clock_timestamp()',
  );
  const needed = waiting!.n - MAX_UNUSED_REGISTRATIONS + 1;
  if (needed <= 0) return;
  const forgotten = await db.execute(
    `DELETE FROM oauth_clients WHERE id IN (
       SELECT c.id FROM oauth_clients c WHERE c.expires_at IS NOT NULL AND c.expires_at > clock_timestamp()
         AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id=c.id) AND NOT EXISTS (SELECT 1 FROM oauth_codes k WHERE k.client_id=c.id)
       ORDER BY c.created_at, c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED)`,
    [needed],
  );
  if (forgotten.changes < needed)
    throw new OAuthError('temporarily_unavailable', 'Registration is closed right now. Try again later.', 429);
}

/** Dynamic registration (RFC 7591). */
export async function registerClient(metadata: unknown): Promise<OAuthClient> {
  const read = readClientMetadata(metadata);
  await makeRoomForRegistration();
  const record = await db.one<ClientRecord>(
    `INSERT INTO oauth_clients(id,kind,client_name,redirect_uris,metadata,expires_at)
     VALUES($1,'dcr',$2,$3::jsonb,$4::jsonb,clock_timestamp() + ($5::int * interval '1 day')) RETURNING ${CLIENT_COLUMNS}`,
    [
      CLIENT_PREFIX + randomBytes(16).toString('base64url'),
      read.clientName,
      JSON.stringify(read.redirectUris),
      JSON.stringify(read.stored),
      REGISTERED_CLIENT_DAYS,
    ],
  );
  return clientOf(record!);
}

// ── Authorization requests ──────────────────────────────────────────────────────────────────────────────────────────────────

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  scopes: Scope[];
  state?: string;
  codeChallenge: string;
  resource: string;
  offlineAccess?: boolean;
};
export type OpenRequest = AuthorizeRequest & {id: string; clientName: string; clientHost: string};
type RequestRecord = {
  id: string;
  client_id: string;
  redirect_uri: string;
  requested_scopes: unknown;
  state: string | null;
  code_challenge: string;
  resource: string;
  binding_hash: string;
  client_name: string;
  redirect_uris: unknown;
};
const OPEN_REQUEST = `SELECT r.id,r.client_id,r.redirect_uri,r.requested_scopes,r.state,r.code_challenge,r.resource,r.binding_hash,c.client_name,c.redirect_uris
  FROM oauth_codes r JOIN oauth_clients c ON c.id=r.client_id
  WHERE r.id=$1 AND r.used_at IS NULL AND r.code_hash IS NULL AND r.expires_at > clock_timestamp()`;
const asked = (record: RequestRecord): OpenRequest => ({
  id: record.id,
  clientName: record.client_name,
  clientHost: clientHostOf(strings(record.redirect_uris)),
  clientId: record.client_id,
  redirectUri: record.redirect_uri,
  scopes: scopesOf(record.requested_scopes),
  ...(record.state === null ? {} : {state: record.state}),
  codeChallenge: record.code_challenge,
  resource: record.resource,
  offlineAccess: Array.isArray(record.requested_scopes) && record.requested_scopes.includes(OFFLINE_ACCESS),
});
export const STALE_REQUEST = 'The request has expired. Go back to the app and start connecting again.';

export async function createAuthorizeRequest(request: AuthorizeRequest, bindingHash: string): Promise<string> {
  const requestId = randomUUID();
  // A registered client nobody has signed in with yet is kept while a sign-in for it is under way.
  await db.execute(
    "UPDATE oauth_clients SET expires_at=GREATEST(expires_at, clock_timestamp() + ($2::int * interval '1 minute')) WHERE id=$1 AND expires_at IS NOT NULL",
    [request.clientId, SIGN_IN_KEEPS_CLIENT_MINUTES],
  );
  await db.execute(
    `INSERT INTO oauth_codes(id,client_id,redirect_uri,requested_scopes,state,code_challenge,resource,binding_hash) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
    [
      requestId,
      request.clientId,
      request.redirectUri,
      JSON.stringify([...request.scopes, ...(request.offlineAccess ? [OFFLINE_ACCESS] : [])]),
      request.state ?? null,
      request.codeChallenge,
      request.resource,
      bindingHash,
    ],
  );
  return requestId;
}

/** The request, for the browser it belongs to; undefined when it is unknown, expired, already decided, or another browser's. */
export async function readAuthorizeRequest(requestId: string, bindingHash: string): Promise<OpenRequest | undefined> {
  if (!REQUEST_ID.test(requestId)) return;
  const record = await db.one<RequestRecord>(OPEN_REQUEST, [requestId]);
  return record && sameHash(record.binding_hash, bindingHash) ? asked(record) : undefined;
}

/** The person said no: the request is spent. Where to send the refusal, or undefined when there was no such open request. */
export async function denyRequest(
  requestId: string,
  bindingHash: string,
): Promise<{redirectUri: string; state?: string} | undefined> {
  const request = await readAuthorizeRequest(requestId, bindingHash);
  if (!request) return;
  const spent = await db.execute(
    'UPDATE oauth_codes SET used_at=clock_timestamp() WHERE id=$1 AND used_at IS NULL AND code_hash IS NULL',
    [requestId],
  );
  return spent.changes === 1
    ? {redirectUri: request.redirectUri, ...(request.state === undefined ? {} : {state: request.state})}
    : undefined;
}

/** Deletes a request nobody can finish (the server is not open to the account that arrived). */
export const dropRequest = (requestId: string) =>
  db.execute('DELETE FROM oauth_codes WHERE id=$1 AND code_hash IS NULL', [requestId]);

/** "Allow", under the account lock: the request checked again, the grant made (or the live one renewed), the code issued. */
export async function recordConsent(
  requestId: string,
  bindingHash: string,
  userId: string,
): Promise<{code: string; redirectUri: string; state?: string}> {
  const code = newSecret(CODE_PREFIX);
  const outcome = await db.transaction(async tx => {
    await account(tx, userId);
    const user = await tx.one<{id: string; email: string; email_verified: number}>(
      'SELECT id,email,email_verified FROM users WHERE id=$1 AND deletion_requested_at IS NULL AND erasure_completed_at IS NULL',
      [userId],
    );
    if (!mcpAvailable(user))
      return {refused: new OAuthError('access_denied', 'Connections are not open to every account yet.', 403)};
    const record = await tx.one<RequestRecord>(`${OPEN_REQUEST} FOR UPDATE OF r`, [requestId]);
    if (!record || !sameHash(record.binding_hash, bindingHash))
      return {refused: new OAuthError('invalid_request', STALE_REQUEST)};
    const request = asked(record);
    const live = await tx.one<{id: string}>(
      'SELECT id FROM oauth_grants WHERE user_id=$1 AND client_id=$2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [userId, request.clientId],
    );
    const grantId = live?.id ?? randomUUID();
    // What the page showed, as the server offers it now: reading always, changing files only while editing is on. Allowing again
    // replaces what an earlier consent allowed.
    const scopes = JSON.stringify(offeredScopes().filter(scope => scope === 'read' || request.scopes.includes(scope)));
    if (live)
      await tx.execute('UPDATE oauth_grants SET client_name=$2,scopes=$3::jsonb WHERE id=$1', [
        grantId,
        record.client_name,
        scopes,
      ]);
    else
      await tx.execute(
        `INSERT INTO oauth_grants(id,user_id,client_id,scopes,client_name) VALUES($1,$2,$3,$4::jsonb,$5)`,
        [grantId, userId, request.clientId, scopes, record.client_name],
      );
    await tx.execute('UPDATE oauth_clients SET expires_at=NULL,last_used_at=clock_timestamp() WHERE id=$1', [
      request.clientId,
    ]);
    await tx.execute(
      `UPDATE oauth_codes SET user_id=$2,grant_id=$3,code_hash=$4,code_expires_at=clock_timestamp() + ($5::int * interval '1 second'),
         expires_at=GREATEST(expires_at, clock_timestamp() + ($5::int * interval '1 second')) WHERE id=$1`,
      [requestId, userId, grantId, digest(code), CODE_SECONDS],
    );
    return {done: {redirectUri: request.redirectUri, ...(request.state === undefined ? {} : {state: request.state})}};
  });
  if ('refused' in outcome) throw outcome.refused;
  return {code, ...outcome.done};
}

// ── Tokens ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A code is spent by one atomic UPDATE; presenting it again revokes what the first redemption got. A refresh token is replaced on
// every use, and presenting an old one revokes its whole family, except a retry by the same client within REFRESH_RETRY_SECONDS.

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  tokenType: 'Bearer';
};
const REFUSED = 'The code or token is not valid. Start connecting again.';
const invalidGrant = () => new OAuthError('invalid_grant', REFUSED);
export const ACCESS_PATTERN = secretPattern(ACCESS_PREFIX);
const REFRESH_PATTERN = secretPattern(REFRESH_PREFIX);

/** The audience of a token is this server's /mcp: a `resource` is accepted only when it names it (a trailing slash aside). */
export function normalizeResource(value: string): string | undefined {
  const text = value.replace(/\/+$/, '');
  return acceptedResourceUrls().includes(text) ? text : undefined;
}

type GrantState = {
  user_id: string;
  client_id: string;
  scopes: unknown;
  revoked_at: string | null;
  email: string;
  email_verified: number;
  closed: boolean;
};
const GRANT_STATE = `SELECT g.user_id,g.client_id,g.scopes,g.revoked_at,u.email,u.email_verified,
    (u.deletion_requested_at IS NOT NULL OR u.erasure_completed_at IS NOT NULL) AS closed
  FROM oauth_grants g JOIN users u ON u.id=g.user_id WHERE g.id=$1`;
const grantUsable = (grant: GrantState | undefined): grant is GrantState =>
  !!grant &&
  !grant.revoked_at &&
  !grant.closed &&
  mcpAvailable({id: grant.user_id, email: grant.email, email_verified: grant.email_verified});

async function issuePair(
  tx: TransactionContext,
  grantId: string,
  familyId: string,
  scope: string,
  resource: string,
): Promise<TokenPair> {
  const access = newSecret(ACCESS_PREFIX),
    refresh = newSecret(REFRESH_PREFIX);
  await tx.execute(
    `INSERT INTO oauth_tokens(id,grant_id,kind,token_hash,family_id,resource,expires_at) VALUES
       ($1,$3,'access',$4,$6,$9,clock_timestamp() + ($7::int * interval '1 second')),
       ($2,$3,'refresh',$5,$6,$9,clock_timestamp() + ($8::int * interval '1 day'))`,
    [
      randomUUID(),
      randomUUID(),
      grantId,
      digest(access),
      digest(refresh),
      familyId,
      ACCESS_TOKEN_SECONDS,
      REFRESH_TOKEN_DAYS,
      resource,
    ],
  );
  return {accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TOKEN_SECONDS, scope, tokenType: 'Bearer'};
}

const revokeFamily = (sql: SqlExecutor, familyId: string) =>
  sql.execute('UPDATE oauth_tokens SET revoked_at=clock_timestamp() WHERE family_id=$1 AND revoked_at IS NULL', [
    familyId,
  ]);

type CodeRecord = {
  id: string;
  client_id: string;
  redirect_uri: string;
  requested_scopes: unknown;
  code_challenge: string;
  resource: string;
  grant_id: string | null;
};

export async function exchangeCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string;
}): Promise<TokenPair> {
  void sweepOAuth();
  const hash = digest(input.code);
  const owner = await db.one<{user_id: string | null}>('SELECT user_id FROM oauth_codes WHERE code_hash=$1', [hash]);
  if (!owner?.user_id) throw invalidGrant();
  const userId = owner.user_id;
  // Claim, checks and issue are one transaction under the account lock; the refusal is thrown after the commit, so a failed
  // presentation still spends the code.
  const outcome = await db.transaction(async tx => {
    await account(tx, userId);
    const claimed = await tx.one<CodeRecord>(
      `UPDATE oauth_codes SET used_at=clock_timestamp() WHERE code_hash=$1 AND used_at IS NULL AND code_expires_at > clock_timestamp()
       RETURNING id,client_id,redirect_uri,requested_scopes,code_challenge,resource,grant_id`,
      [hash],
    );
    if (!claimed) {
      // Spent before: whatever it produced is revoked (RFC 6749 §4.1.2). The family of a code's first pair is the code row's id.
      const spent = await tx.one<{id: string}>(
        'SELECT id FROM oauth_codes WHERE code_hash=$1 AND used_at IS NOT NULL',
        [hash],
      );
      if (spent) await revokeFamily(tx, spent.id);
      return {refused: true as const};
    }
    if (
      claimed.client_id !== input.clientId ||
      claimed.redirect_uri !== input.redirectUri ||
      (input.resource !== undefined && normalizeResource(input.resource) !== claimed.resource) ||
      !verifierMatches(input.codeVerifier, claimed.code_challenge) ||
      !claimed.grant_id
    )
      return {refused: true as const};
    const grant = await tx.one<GrantState>(GRANT_STATE, [claimed.grant_id]);
    if (!grantUsable(grant)) return {refused: true as const};
    const offline = Array.isArray(claimed.requested_scopes) && claimed.requested_scopes.includes(OFFLINE_ACCESS);
    const scope = [...scopesOf(grant.scopes), ...(offline ? [OFFLINE_ACCESS] : [])].join(' ');
    return {pair: await issuePair(tx, claimed.grant_id, claimed.id, scope, claimed.resource)};
  });
  if ('refused' in outcome) throw invalidGrant();
  return outcome.pair;
}

type RefreshRecord = {
  id: string;
  grant_id: string;
  family_id: string;
  resource: string;
  used_at: string | null;
  revoked_at: string | null;
  live: boolean;
  retry: boolean;
};

export async function refreshTokens(input: {
  refreshToken: string;
  clientId: string;
  resource?: string;
}): Promise<TokenPair> {
  void sweepOAuth();
  if (!REFRESH_PATTERN.test(input.refreshToken)) throw invalidGrant();
  if (input.resource !== undefined && !normalizeResource(input.resource)) throw invalidGrant();
  const hash = digest(input.refreshToken);
  const owner = await db.one<{user_id: string}>(
    "SELECT g.user_id FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=$1 AND t.kind='refresh'",
    [hash],
  );
  if (!owner) throw invalidGrant();
  const outcome = await db.transaction(async tx => {
    await account(tx, owner.user_id);
    const token = await tx.one<RefreshRecord>(
      `SELECT t.id,t.grant_id,t.family_id,t.resource,t.used_at,t.revoked_at,(t.expires_at > clock_timestamp()) AS live,
         (t.used_at IS NOT NULL AND t.used_at > clock_timestamp() - ($2::int * interval '1 second')) AS retry
       FROM oauth_tokens t WHERE t.token_hash=$1 AND t.kind='refresh' FOR UPDATE OF t`,
      [hash, REFRESH_RETRY_SECONDS],
    );
    if (!token || token.revoked_at || !token.live) return {refused: true as const};
    // Used, and not just now: theft.
    if (token.used_at && !token.retry) {
      await revokeFamily(tx, token.family_id);
      return {refused: true as const};
    }
    const grant = await tx.one<GrantState>(GRANT_STATE, [token.grant_id]);
    if (!grantUsable(grant)) return {refused: true as const};
    // Another client's token is theft at any time.
    if (grant.client_id !== input.clientId) {
      await revokeFamily(tx, token.family_id);
      return {refused: true as const};
    }
    if (!token.used_at) await tx.execute('UPDATE oauth_tokens SET used_at=clock_timestamp() WHERE id=$1', [token.id]);
    return {
      pair: await issuePair(tx, token.grant_id, token.family_id, scopesOf(grant.scopes).join(' '), token.resource),
    };
  });
  if ('refused' in outcome) throw invalidGrant();
  return outcome.pair;
}

/** RFC 7009: a refresh token ends its chain (and the grant, when nothing else of it lives); an access token ends itself. Says
 *  nothing about whether the token was ours. */
export async function revokeToken(raw: string, clientId?: string): Promise<void> {
  const refresh = REFRESH_PATTERN.test(raw);
  if (!refresh && !ACCESS_PATTERN.test(raw)) return;
  const token = await db.one<{
    id: string;
    grant_id: string;
    family_id: string;
    kind: string;
    client_id: string;
    user_id: string;
  }>(
    'SELECT t.id,t.grant_id,t.family_id,t.kind,g.client_id,g.user_id FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=$1',
    [digest(raw)],
  );
  if (!token || (clientId !== undefined && token.client_id !== clientId)) return;
  await db.transaction(async tx => {
    await account(tx, token.user_id);
    if (token.kind === 'access') {
      await tx.execute('UPDATE oauth_tokens SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [
        token.id,
      ]);
      return;
    }
    await revokeFamily(tx, token.family_id);
    const left = await tx.one<{n: number}>(
      "SELECT count(*)::int AS n FROM oauth_tokens WHERE grant_id=$1 AND kind='refresh' AND revoked_at IS NULL AND expires_at > clock_timestamp()",
      [token.grant_id],
    );
    if (left!.n === 0)
      await tx.execute('UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [
        token.grant_id,
      ]);
  });
}

// ── Grants: what "Connections" lists, and "Disconnect" ────────────────────────────────────────────────────────────────────

export type McpConnection = {
  id: string;
  clientName: string;
  clientHost: string;
  createdAt: string;
  lastUsedAt: string | null;
};
type GrantRecord = {
  id: string;
  client_name: string;
  redirect_uris: unknown;
  created_at: string;
  last_used_at: string | null;
};
const connectionOf = (row: GrantRecord): McpConnection => ({
  id: row.id,
  clientName: row.client_name,
  clientHost: clientHostOf(strings(row.redirect_uris)),
  createdAt: String(row.created_at),
  lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
});

/** The account's live connections, newest first. Never a token or a hash. */
export async function listConnections(userId: string, sql: SqlExecutor = db): Promise<McpConnection[]> {
  const rows = await sql.many<GrantRecord>(
    `SELECT g.id,g.client_name,c.redirect_uris,g.created_at,g.last_used_at FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id
      WHERE g.user_id=$1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC,g.id`,
    [userId],
  );
  return rows.map(connectionOf);
}

/** "Disconnect": the grant stops working at once; its tokens and waiting codes are deleted. False for an unknown or another account's. */
export async function revokeConnection(userId: string, grantId: string): Promise<boolean> {
  if (!REQUEST_ID.test(grantId)) return false;
  return db.transaction(async tx => {
    await account(tx, userId);
    const revoked = await tx.execute(
      'UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND user_id=$2',
      [grantId, userId],
    );
    if (!revoked.changes) return false;
    await tx.execute('DELETE FROM oauth_tokens WHERE grant_id=$1', [grantId]);
    await tx.execute('DELETE FROM oauth_codes WHERE grant_id=$1', [grantId]);
    return true;
  });
}

/** Erasure (server/launch/lifecycle.ts): the account's grants go, and with them their requests and tokens; its daily counts too. */
export async function eraseMcpOf(tx: TransactionContext, userId: string): Promise<void> {
  await tx.execute('DELETE FROM oauth_codes WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM oauth_grants WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM mcp_daily_calls WHERE user_id=$1', [userId]);
}

// ── Housekeeping ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Started by the endpoints and run at most once a minute: requests and codes past their time, expired tokens, clients that never
// obtained a grant, daily counts older than a week. A failure is no reason to refuse a call.

const SWEEP_EVERY_MS = 60_000;
let lastSweep = 0;

export async function sweepOAuth(now: number = Date.now()): Promise<void> {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  try {
    await db.execute('DELETE FROM oauth_codes WHERE expires_at < clock_timestamp()');
    await db.execute('DELETE FROM oauth_tokens WHERE expires_at < clock_timestamp()');
    await db.execute(
      `DELETE FROM oauth_clients c WHERE c.expires_at IS NOT NULL AND c.expires_at < clock_timestamp()
         AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id=c.id)`,
    );
    await db.execute("DELETE FROM mcp_daily_calls WHERE day < (now() AT TIME ZONE 'UTC')::date - 7");
  } catch {
    lastSweep = 0;
  }
}
export const resetOAuthSweep = (): void => {
  lastSweep = 0;
};
