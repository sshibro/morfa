import type {Request, Response} from 'express';
import {digest, sessionToken} from './auth';
import {lockCurrentSession} from './session-authority';
import type {TransactionContext} from './postgresql/client';
import {fail} from './hosting/errors';
import {lockMcpWriter} from './mcp/authority';

/** `mcpToken`: an assistant's MCP connection acting for the account (its access token's row), which has no session; its checks are
 *  server/mcp/authority.ts. */
export type CustomerAuthority = Readonly<{ownerId: string; sessionHash: string; mcpToken?: string}>;
/** Capture at the HTTP boundary. Background work retains its separate committed
 * operation claim; it never borrows a later request's cookie or user object. */
export function captureCustomerAuthority(req: Request, res: Response): CustomerAuthority {
  const token = sessionToken(req);
  return Object.freeze({ownerId: String(res.locals.user.id), sessionHash: token ? digest(token) : ''});
}
/** The domain owner acquires its complete business locks before this check. */
export async function assertCustomerAuthority(
  tx: TransactionContext,
  owner: string,
  authority: CustomerAuthority,
): Promise<void> {
  const live =
    authority.mcpToken !== undefined
      ? await lockMcpWriter(tx, owner, authority.mcpToken)
      : await lockCurrentSession(tx, owner, authority.sessionHash);
  if (authority.ownerId !== owner || !live) fail(401, 'unauthorized', 'Sign in to continue.');
}
