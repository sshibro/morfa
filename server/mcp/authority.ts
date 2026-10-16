// An assistant acting for an account (docs/mcp-server.md §Editing): the files API's own reads and writes take a CustomerAuthority, which
// a browser proves with its session. An MCP connection proves itself with its access token instead, so its authority names that token
// (`mcpToken`) and has no session; server/customer-authority.ts and server/design/file-access.ts check it here in place of the session:
//   a read   — the connection works (the token is live, its grant not revoked, the account open and in MCP_ACCOUNTS);
//   a write  — the same, with the token and its grant row-locked until the commit (a revocation waits for the write, or the write
//              sees it), and the grant allows changing files while editing is on.
// Every other check of an authority (a session's own) finds no session for it and refuses: nothing else is opened to an assistant.
import type {CustomerAuthority} from '../customer-authority';
import type {SqlExecutor} from '../postgresql/client';
import {credentialState, CREDENTIAL_SQL, type CredentialRow, type Principal} from './auth';
import {mcpEditsOn} from './config';
import {scopesOf} from './oauth/shared';


const CONNECTION_SQL = CREDENTIAL_SQL.replace('k.token_hash=$1', 'k.id=$1');
const LOCKED_CONNECTION_SQL = `${CONNECTION_SQL} FOR SHARE OF k,g`;

/** The authority of a connection's call: its account, no session, its access token. */
export const mcpAuthority = (principal: Principal): CustomerAuthority =>
  Object.freeze({ownerId: principal.userId, sessionHash: '', mcpToken: principal.tokenId});

/** Whether the connection may read for `owner` now. */
export async function mcpConnectionReads(sql: SqlExecutor, owner: string, tokenId: string): Promise<boolean> {
  const row = await sql.one<CredentialRow>(CONNECTION_SQL, [tokenId]);
  return !!row && row.user_id === owner && credentialState(row) === undefined;
}

/** Whether the connection may change files for `owner` now; its token and grant stay locked until the transaction ends. */
export async function lockMcpWriter(sql: SqlExecutor, owner: string, tokenId: string): Promise<boolean> {
  if (!mcpEditsOn()) return false;
  const row = await sql.one<CredentialRow>(LOCKED_CONNECTION_SQL, [tokenId]);
  return !!row && row.user_id === owner && credentialState(row) === undefined && scopesOf(row.scopes).includes('write');
}
