// Morfa's accounts and sessions. A session is a random token in an httpOnly cookie; the database keeps only its SHA-256. Every
// request that acts for an account reads the account through its live session (currentUser), and a browser that names a
// different account than the cookie's (the X-Forma-Account header of src/api.ts, "the account generation check") is refused with
// 409, so a tab never acts for an account another tab switched to. People sign in by typing a name (server/accounts.ts,
// docs/authentication.md).
import {randomBytes, createHash} from 'node:crypto';
import type {Request, Response} from 'express';
import {recordActivity} from './admin/telemetry';
import {db, inTransaction} from './db';
import {prepared, type SqlExecutor} from './postgresql/client';
import {lockResources} from './postgresql/locks';
import {asyncHandler} from './http';
import {ONE_DAY_MS} from './time-constants';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password: string;
  created_at: string;
  deletion_requested_at: string | null;
  erasure_completed_at: string | null;
  email_verified: number;
}
/** What the client is told about the signed-in account (GET /api/auth/me). */
export type UserInfo = {id: string; email: string; name: string};

export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const SESSION_MAX_AGE_MS = 7 * ONE_DAY_MS;
/** The header a tab sends with the account it acts for. */
export const ACCOUNT_HEADER = 'x-forma-account';
export const ACCOUNT_CHANGED = 'The account was changed in another tab. Refresh the page.';
export const SIGN_IN_REQUIRED = 'Sign in to continue.';

// __Host- prevents a sibling host from planting a parent-domain login cookie.
// Production intentionally never accepts the unprefixed cookie.
export const authCookieName = (name: string) =>
  `${process.env.NODE_ENV === 'production' ? '__Host-' : ''}forma_${name}`;
export const authCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
});

export function sessionToken(req: Request): string | undefined {
  const token = req.cookies?.[authCookieName('session')];
  return typeof token === 'string' ? token : undefined;
}

/** The account named by the browser's header differs from the session's: a tab acts for an account it no longer has. */
export const accountChanged = (req: Request, accountId: string) => {
  const named = req.get(ACCOUNT_HEADER);
  return !!named && named !== accountId;
};

export async function revokeSession(req: Request, executor: SqlExecutor = db) {
  const token = sessionToken(req);
  if (token) await executor.execute('DELETE FROM sessions WHERE token=$1', [digest(token)]);
}

export function clearSession(res: Response) {
  res.clearCookie(authCookieName('session'), authCookieOptions());
}

/** Signs the account in on this response. Call after the caller's transaction commits; never set a cookie inside one. */
export async function setSession(res: Response, id: string, options: {previousToken?: string} = {}) {
  const token = randomBytes(32).toString('hex'),
    now = Date.now();
  // Cleanup holds no account lock and cannot invert another account's locks.
  await db.execute('DELETE FROM sessions WHERE expires<=$1', [now]);
  await inTransaction(async tx => {
    await lockResources(tx, [{kind: 'account', id}]);
    const user = await tx.one<Pick<UserRow, 'deletion_requested_at'>>(
      'SELECT deletion_requested_at FROM users WHERE id=$1 FOR UPDATE',
      [id],
    );
    if (!user || user.deletion_requested_at)
      throw Object.assign(Error('The session has ended. Sign in again.'), {status: 401, code: 'session_changed'});
    if (options.previousToken) await tx.execute('DELETE FROM sessions WHERE token=$1', [digest(options.previousToken)]);
    await tx.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [
      digest(token),
      id,
      now + SESSION_MAX_AGE_MS,
    ]);
  });
  res.cookie(authCookieName('session'), token, {...authCookieOptions(), maxAge: SESSION_MAX_AGE_MS});
  try {
    await recordActivity(id, 'auth.login');
  } catch {
    /* A committed login cannot depend on optional telemetry. */
  }
}

export const userInfo = (u: Pick<UserRow, 'id' | 'email' | 'name'>): UserInfo => ({id: u.id, email: u.email, name: u.name});

/** The account of the request's live session, or undefined: no cookie, an expired or revoked session, or a closing account. */
export async function currentUser(req: Request, executor: SqlExecutor = db): Promise<UserRow | undefined> {
  const token = sessionToken(req);
  if (!token) return;
  return executor.one<UserRow>(CURRENT_USER, [digest(token), Date.now()]);
}
// Every request with a cookie reads it (server/app.ts), so it is prepared; the columns are UserRow's, named (a `users.*` would fail
// the cached plan when a migration adds a column to users while this process runs).
const CURRENT_USER = prepared(
  `SELECT u.id,u.email,u.name,u.password,u.created_at,u.deletion_requested_at,u.erasure_completed_at,u.email_verified
     FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=$1 AND s.expires>$2 AND u.deletion_requested_at IS NULL`,
);

/** The request's account: the one server/app.ts read at the start of the request (null: no live session), else read now (lane A7:
 *  /api/config, /api/auth/me and every picture or thumbnail read it a second time). */
export async function requestUser(req: Request, res: Response): Promise<UserRow | undefined> {
  const known = res.locals.sessionUser as UserRow | null | undefined;
  return known !== undefined ? (known ?? undefined) : currentUser(req);
}

/** Express guard: 401 without a live session, 409 when the tab names another account; else res.locals.user is the account. */
export const requireAuth = asyncHandler(async (req, res, next) => {
  const u = await requestUser(req, res);
  if (!u) {
    res.status(401).json({error: SIGN_IN_REQUIRED, code: 'unauthorized'});
    return;
  }
  if (accountChanged(req, u.id)) {
    res.status(409).json({error: ACCOUNT_CHANGED, code: 'account_changed'});
    return;
  }
  res.locals.user = u;
  next();
});
