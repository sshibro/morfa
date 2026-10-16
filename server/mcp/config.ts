// The MCP server's switches and addresses (docs/mcp-server.md). It reads the environment and nothing else (no database, no express),
// so the routers can be tested without either, and every function reads it when called, so a test may change it between requests.
// Read-only and on the app's own origin.
import {designToolAvailable} from '../design/flag';
import {accountList, listedAccount, type AddressOf} from '../account-list';

type Account = {id: string} & AddressOf;

/** The development app's origin (Vite on 5400), as server/app-origin.ts appOrigin() falls back to. */
const DEV_APP_ORIGIN = 'http://127.0.0.1:5400';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;
/** The path the MCP endpoint answers on; the canonical resource address ends with it. */
export const MCP_PATH = '/mcp';
/** What the server calls itself in `initialize`, the protected-resource document and the consent page. */
export const MCP_SERVER_NAME = 'morfa';

const production = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
const entriesOf = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

/** ENABLE_MCP_SERVER=1 turns the server on (with the design tool). Anything else: /mcp, /oauth/* and the well-known documents are not
 *  routes at all, and answer what any unknown path answers. */
export const mcpServerOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.ENABLE_DESIGN_TOOL === '1' && env.ENABLE_MCP_SERVER === '1';

/** ENABLE_MCP_EDITS=1 (with the server on) lets an assistant change files (docs/mcp-server.md §Editing): the `write` right is offered
 *  at sign-in and the editing tools are listed. Off, the server is read-only as before, and a `write` right granted while it was on
 *  does nothing. */
export const mcpEditsOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  mcpServerOn(env) && env.ENABLE_MCP_EDITS === '1';

/** The server is open to this account: it is on, the design tool is open to the account, and MCP_ACCOUNTS names it (ids, or the
 *  e-mails of accounts whose address is proven, comma separated; `*` is every account). Fails closed: unset or empty is nobody. Read
 *  at every sign-in, token and call, so taking an account out of the list stops its assistant at its next call. */
export function mcpAvailable(account: Account | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!account || !mcpServerOn(env) || !designToolAvailable(account)) return false;
  const accounts = accountList(env.MCP_ACCOUNTS);
  if (!accounts) return false;
  return accounts.has('*') || listedAccount(accounts, account);
}

/** The app's origin, which is also the authorization server's issuer: the session cookie lives there. */
export const mcpIssuer = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.APP_ORIGIN || DEV_APP_ORIGIN).replace(/\/+$/, '');

/** The canonical address of the endpoint, what a person types into an assistant: the app's origin + /mcp
 *  (https://app.morfa.example/mcp in production). Token audiences and the protected-resource document use it. */
export const mcpResourceUrl = (env: NodeJS.ProcessEnv = process.env): string => mcpIssuer(env) + MCP_PATH;

/** A host name of an address or host entry (no port; IPv6 in brackets), lower case; undefined when it is none. */
function hostnameOf(entry: string): string | undefined {
  try {
    return new URL(entry.includes('://') ? entry : `http://${entry}`).hostname.toLowerCase() || undefined;
  } catch {
    return;
  }
}

/** Host names the endpoint and the sign-in answer for (the DNS-rebinding guard): the app's own host and, outside production, the
 *  loopback names (the API listens on 3400 in development, the app on 5400). */
export function mcpHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = hostnameOf(mcpIssuer(env));
  return unique([...(own ? [own] : []), ...(production(env) ? [] : LOOPBACK_HOSTS)]);
}

/** Browser origins (host names, as the SDK's validateOriginHeader reads them) allowed to call /mcp: none in production (assistants
 *  call it from their servers or the person's machine, never from a page), the development hosts elsewhere. A request without an
 *  Origin header always passes: only browsers send one. */
export const mcpOrigins = (env: NodeJS.ProcessEnv = process.env): string[] => (production(env) ? [] : mcpHosts(env));

/** Every address a token's audience or an authorization request's `resource` may name: the canonical one and, outside production
 *  only, the same path on the development hosts and ports (an inspector may type localhost:3400 while the app says 127.0.0.1:5400). */
export function acceptedResourceUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const canonical = mcpResourceUrl(env);
  if (production(env)) return [canonical];
  const url = new URL(canonical);
  const ports = unique([url.port, env.PORT || '3400', '3400', '5400'].filter(Boolean));
  const alternates = mcpHosts(env).flatMap(host => ports.map(port => `${url.protocol}//${host}:${port}${MCP_PATH}`));
  return unique([canonical, ...alternates]);
}

/** The address of the protected-resource document that goes into every 401 challenge (RFC 9728, path-suffixed form). */
export const protectedResourceMetadataUrl = (resource: string = mcpResourceUrl()): string =>
  `${new URL(resource).origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** Calls a minute: a connection's own budget, and a caller without one by address. The limiter is server/mcp/auth.ts. */
export const MCP_CALLS_PER_MINUTE = {connection: 120, anonymous: 60} as const;

/** Tool calls one account may make in a UTC day, all its connections together (MCP_DAILY_CALLS, default 2000). Counted in
 *  PostgreSQL, so every api process shares it. */
export function mcpDailyCalls(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MCP_DAILY_CALLS);
  return env.MCP_DAILY_CALLS && Number.isInteger(value) && value > 0 ? value : 2000;
}

/** User-Agent fragments of clients that start sign-in from a tool error rather than from a 401 (ChatGPT). A heuristic. */
export const toolErrorSignInClients = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env.MCP_TOOL_ERROR_AUTH_CLIENTS?.trim() ? entriesOf(env.MCP_TOOL_ERROR_AUTH_CLIENTS) : ['ChatGPT', 'OpenAI']).map(
    entry => entry.toLowerCase(),
  );
