import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {bootPostgresqlApp, type AppFixture} from './helpers/app-fixture';
import {buttonFile} from './design-codegen-fixture';

// The MCP server through the whole application on a fresh database (docs/mcp-server.md): an assistant registers, its person signs in
// and allows it, it trades the code for tokens and reads that person's files (and only theirs) with the five tools; "Disconnect", the
// account list, the day's budget and the account's erasure each stop it.

let fixture: AppFixture;
const SWITCHES = {ENABLE_DESIGN_TOOL: '1', ENABLE_MCP_SERVER: '1', MCP_ACCOUNTS: '*'};
const saved = Object.fromEntries(
  ['APP_ORIGIN', 'DESIGN_TOOL_ACCOUNTS', 'MCP_DAILY_CALLS', ...Object.keys(SWITCHES)].map(key => [
    key,
    process.env[key],
  ]),
);
before(async () => {
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  fixture = await bootPostgresqlApp({env: SWITCHES});
});
after(async () => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  await fixture?.close();
});

/** The session's stored form (server/auth.ts `digest`), here so no server module loads before the fixture names its database. */
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
type Person = {id: string; email: string; cookie: string};
/** An account as the MCP server needs it. */
async function person(label: string): Promise<Person> {
  const id = `mcp:${label}:${randomUUID()}`,
    token = randomUUID(),
    email = `${label}-${randomUUID()}@example.test`;
  await fixture.db.execute("INSERT INTO users(id,email,name,password,email_verified) VALUES($1,$2,'Designer','',1)", [
    id,
    email,
  ]);
  await fixture.db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [
    digest(token),
    id,
    Date.now() + 3_600_000,
  ]);
  return {id, email, cookie: `forma_session=${token}`};
}
async function createFile(who: Person, name: string, document: unknown): Promise<string> {
  const response = await fetch(fixture.base + '/api/design-files', {
    method: 'POST',
    headers: {cookie: who.cookie, 'content-type': 'application/json'},
    body: JSON.stringify({name, document}),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.file.id;
}

/** The cookies a browser keeps from the answers (name=value only; every one here is the app's own). */
const jar = (initial: string) => {
  const cookies = new Map(initial.split('; ').map(pair => pair.split('=') as [string, string]));
  return {
    take(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(line)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    get header() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    has: (name: string) => cookies.has(name),
  };
};

const REDIRECT = 'http://127.0.0.1:43123/callback';
type Tokens = {access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string};

/** The whole connection as an assistant and its person's browser make it: registration, authorize, consent, the token exchange. */
async function connect(
  who: Person,
  clientName = 'Claude Code',
): Promise<{clientId: string; tokens: Tokens; replay: () => Promise<Response>}> {
  const registered = await fetch(fixture.base + '/oauth/register', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registered.status, 201);
  const clientId = (await registered.json()).client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const browser = jar(who.cookie);
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'st-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'read offline_access',
  });
  const authorize = await fetch(`${fixture.base}/oauth/authorize?${query}`, {
    headers: {cookie: browser.header},
    redirect: 'manual',
  });
  assert.equal(authorize.status, 302);
  browser.take(authorize);
  const consentPath = authorize.headers.get('location')!;
  assert.match(consentPath, /^\/oauth\/consent\?req=[0-9a-f-]{36}$/);
  const page = await fetch(fixture.base + consentPath, {headers: {cookie: browser.header}});
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(clientName));
  assert.match(html, /You are signed in as <b>Designer<\/b>/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf, 'the form carries its CSRF token');
  const allowed = await fetch(fixture.base + '/oauth/consent', {
    method: 'POST',
    headers: {
      cookie: browser.header,
      'content-type': 'application/x-www-form-urlencoded',
      origin: fixture.base,
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({req: consentPath.split('=')[1]!, csrf, decision: 'allow'}),
    redirect: 'manual',
  });
  assert.equal(allowed.status, 302, await allowed.clone().text());
  const back = new URL(allowed.headers.get('location')!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st-1');
  assert.equal(back.searchParams.get('iss'), 'http://127.0.0.1:5400');
  const code = back.searchParams.get('code')!;
  const exchanged = await fetch(fixture.base + '/oauth/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  const tokens = (await exchanged.json()) as Tokens;
  assert.equal(exchanged.status, 200, JSON.stringify(tokens));
  assert.match(tokens.access_token, /^morfa_at_/);
  assert.match(tokens.refresh_token, /^morfa_rt_/);
  const replay = async () =>
    fetch(fixture.base + '/oauth/token', {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    });
  return {clientId, tokens, replay};
}

const CHATGPT_AGENT = {'user-agent': 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)'};
let id = 0;
async function mcp(token: string | undefined, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(fixture.base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(token ? {authorization: `Bearer ${token}`} : {}),
      ...headers,
    },
    body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, ...(params ? {params} : {})}),
  });
  const text = await response.text();
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(
        text
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5))
          .join(''),
      )
    : text
      ? JSON.parse(text)
      : undefined;
  return {status: response.status, headers: response.headers, json};
}
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const answer = await mcp(token, 'tools/call', {name, arguments: args});
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json.result as {isError?: boolean; content: {text: string}[]; structuredContent: any};
};

test('should publish its sign-in, and send an assistant without a credential there', async () => {
  const resource = await fetch(fixture.base + '/.well-known/oauth-protected-resource/mcp');
  assert.equal(resource.status, 200);
  assert.deepEqual(await resource.json(), {
    resource: 'http://127.0.0.1:5400/mcp',
    authorization_servers: ['http://127.0.0.1:5400'],
    scopes_supported: ['read'],
    bearer_methods_supported: ['header'],
    resource_name: 'Morfa',
  });
  const server = await (await fetch(fixture.base + '/.well-known/oauth-authorization-server')).json();
  assert.equal(server.registration_endpoint, 'http://127.0.0.1:5400/oauth/register');
  const params = {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '0'}};
  // The handshake itself asks for the sign-in (Claude's directory requires it)…
  const challenged = await mcp(undefined, 'initialize', params);
  assert.equal(challenged.status, 401);
  assert.match(challenged.headers.get('www-authenticate')!, /resource_metadata="http:\/\/127\.0\.0\.1:5400\/\.well-known\/oauth-protected-resource\/mcp"/);
  // …except for ChatGPT, which starts its sign-in from a tool's answer.
  const hello = await mcp(undefined, 'initialize', params, CHATGPT_AGENT);
  assert.equal(hello.status, 200);
  assert.equal(hello.json.result.serverInfo.name, 'morfa');
  const listed = await mcp(undefined, 'tools/list', undefined, CHATGPT_AGENT);
  assert.deepEqual(
    listed.json.result.tools.map((entry: {name: string}) => entry.name),
    ['morfa_list_files', 'morfa_get_file', 'morfa_get_layers', 'morfa_get_code', 'morfa_get_variables', 'morfa_show_file'],
  );
  const refused = await mcp(undefined, 'tools/call', {name: 'morfa_list_files', arguments: {}});
  assert.equal(refused.status, 401);
  assert.match(
    refused.headers.get('www-authenticate')!,
    /resource_metadata="http:\/\/127\.0\.0\.1:5400\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  const forged = await mcp('morfa_at_' + 'x'.repeat(43), 'tools/call', {name: 'morfa_list_files', arguments: {}});
  assert.equal(forged.status, 401);
});

test("should read the signed-in person's files with every tool, and nobody else's", async () => {
  const owner = await person('owner'),
    stranger = await person('stranger');
  const {doc} = buttonFile();
  const mine = await createFile(owner, 'Buttons', doc);
  const theirs = await createFile(stranger, 'Foreign file', doc);
  const {tokens} = await connect(owner);

  const files = await tool(tokens.access_token, 'morfa_list_files');
  assert.equal(files.isError, undefined);
  assert.deepEqual(
    files.structuredContent.files.map((file: {id: string; name: string; role: string}) => [
      file.id,
      file.name,
      file.role,
    ]),
    [[mine, 'Buttons', 'owner']],
  );
  assert.equal(files.structuredContent.files[0].link, `http://127.0.0.1:5400/#design/${mine}`);
  assert.equal((await tool(tokens.access_token, 'morfa_list_files', {query: 'no such file'})).structuredContent.total, 0);

  const outline = await tool(tokens.access_token, 'morfa_get_file', {fileId: mine});
  assert.equal(outline.structuredContent.file.name, 'Buttons');
  assert.ok(outline.structuredContent.pages[0].layers.some((layer: {id: string}) => layer.id === 'home'));

  const layers = await tool(tokens.access_token, 'morfa_get_layers', {
    link: `http://127.0.0.1:5400/#design/${mine}?node=home`,
    depth: 1,
  });
  assert.equal(layers.structuredContent.layer.name, doc.nodes['home']!.name);
  assert.ok(layers.structuredContent.layer.children.some((layer: {text?: string}) => layer.text === doc.nodes['title']!.text!.characters));
  assert.match(layers.structuredContent.layer.css, /flex-direction: column/);

  const code = await tool(tokens.access_token, 'morfa_get_code', {
    fileId: mine,
    nodeId: 'home',
    format: 'react-tailwind',
  });
  assert.equal(code.isError, undefined, code.content[0]!.text);
  assert.match(code.content[0]!.text, /export (default )?function/);
  const tokensCode = await tool(tokens.access_token, 'morfa_get_code', {fileId: mine, format: 'tokens'});
  assert.equal(tokensCode.isError, undefined);
  const variables = await tool(tokens.access_token, 'morfa_get_variables', {fileId: mine});
  assert.deepEqual(variables.structuredContent.collections, []);

  // Another person's file is as missing as one that does not exist.
  for (const fileId of [theirs, randomUUID()]) {
    const refused = await tool(tokens.access_token, 'morfa_get_file', {fileId});
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.error.code, 'not_found');
  }
  const badArgs = await tool(tokens.access_token, 'morfa_get_layers', {fileId: mine});
  assert.equal(badArgs.structuredContent.error.code, 'invalid_input');
  // A file in the trash is not offered.
  assert.equal(
    (await fetch(`${fixture.base}/api/design-files/${mine}`, {method: 'DELETE', headers: {cookie: owner.cookie}}))
      .status,
    200,
  );
  assert.equal(
    (await tool(tokens.access_token, 'morfa_get_file', {fileId: mine})).structuredContent.error.code,
    'not_found',
  );
  assert.equal((await tool(tokens.access_token, 'morfa_list_files')).structuredContent.total, 0);
});

test('should take a code once, and revoke what it gave when it is presented again', async () => {
  const owner = await person('replay');
  const {tokens, replay} = await connect(owner);
  assert.equal((await tool(tokens.access_token, 'morfa_list_files')).isError, undefined);
  const again = await replay();
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, 'invalid_grant');
  assert.equal((await mcp(tokens.access_token, 'tools/call', {name: 'morfa_list_files', arguments: {}})).status, 401);
});

test('should list the connection, refresh it, and stop it at "Disconnect"', async () => {
  const owner = await person('connections');
  const config = await (await fetch(fixture.base + '/api/config', {headers: {cookie: owner.cookie}})).json();
  assert.equal(config.mcpServer, 'http://127.0.0.1:5400/mcp');
  const {clientId, tokens} = await connect(owner, 'Cursor');
  const listed = await (await fetch(fixture.base + '/api/mcp/connections', {headers: {cookie: owner.cookie}})).json();
  assert.equal(listed.url, 'http://127.0.0.1:5400/mcp');
  assert.deepEqual(
    listed.connections.map((connection: {clientName: string; clientHost: string}) => [
      connection.clientName,
      connection.clientHost,
    ]),
    [['Cursor', '127.0.0.1:43123']],
  );
  assert.equal(JSON.stringify(listed).includes(tokens.access_token), false);

  const refreshed = await fetch(fixture.base + '/oauth/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token}),
  });
  assert.equal(refreshed.status, 200);
  const next = (await refreshed.json()) as Tokens;
  assert.notEqual(next.access_token, tokens.access_token);
  assert.equal((await tool(next.access_token, 'morfa_list_files')).isError, undefined);

  // Someone else cannot end it.
  const other = await person('other');
  const foreign = await fetch(`${fixture.base}/api/mcp/connections/${listed.connections[0].id}`, {
    method: 'DELETE',
    headers: {cookie: other.cookie},
  });
  assert.equal(foreign.status, 404);
  const ended = await fetch(`${fixture.base}/api/mcp/connections/${listed.connections[0].id}`, {
    method: 'DELETE',
    headers: {cookie: owner.cookie},
  });
  assert.equal(ended.status, 200);
  const after = await mcp(next.access_token, 'tools/call', {name: 'morfa_list_files', arguments: {}});
  assert.equal(after.status, 401);
  assert.deepEqual(
    (await (await fetch(fixture.base + '/api/mcp/connections', {headers: {cookie: owner.cookie}})).json()).connections,
    [],
  );
});

test('should stop an assistant when its account leaves the list or spends its day', async () => {
  const owner = await person('limits');
  const {tokens} = await connect(owner);
  process.env.MCP_DAILY_CALLS = '2';
  try {
    assert.equal((await tool(tokens.access_token, 'morfa_list_files')).isError, undefined);
    assert.equal((await tool(tokens.access_token, 'morfa_list_files')).isError, undefined);
    const spent = await tool(tokens.access_token, 'morfa_list_files');
    assert.equal(spent.structuredContent.error.code, 'rate_limited');
  } finally {
    delete process.env.MCP_DAILY_CALLS;
  }
  process.env.MCP_ACCOUNTS = 'someone-else';
  try {
    const closed = await mcp(tokens.access_token, 'tools/call', {name: 'morfa_list_files', arguments: {}});
    assert.equal(closed.status, 403);
    const config = await (await fetch(fixture.base + '/api/config', {headers: {cookie: owner.cookie}})).json();
    assert.equal(config.mcpServer, undefined);
    assert.equal((await fetch(fixture.base + '/api/mcp/connections', {headers: {cookie: owner.cookie}})).status, 404);
  } finally {
    process.env.MCP_ACCOUNTS = '*';
  }
});

test('should offer a person who is not signed in the name form, and the consent after it', async () => {
  const registered = await (
    await fetch(fixture.base + '/oauth/register', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({client_name: 'Claude', redirect_uris: [REDIRECT]}),
    })
  ).json();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: registered.client_id,
    redirect_uri: REDIRECT,
    code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256',
  });
  const browser = jar('');
  const page = await fetch(`${fixture.base}/oauth/authorize?${query}`, {redirect: 'manual'});
  assert.equal(page.status, 200);
  browser.take(page);
  assert.ok(browser.has('forma_mcp_oauth_req'));
  const html = await page.text();
  assert.match(html, /id="name-form"/);
  assert.match(html, /\/api\/auth\/name/);
  // Signed in meanwhile (in this browser): the consent page now asks.
  const owner = await person('later');
  const requestId = /consent\?req=([0-9a-f-]{36})/.exec(html)![1];
  const consent = await fetch(`${fixture.base}/oauth/consent?req=${requestId}`, {
    headers: {cookie: `${browser.header}; ${owner.cookie}`},
  });
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /name="decision" value="allow"/);
  // Without the browser's binding the request is not this browser's.
  const elsewhere = await fetch(`${fixture.base}/oauth/consent?req=${requestId}`, {headers: {cookie: owner.cookie}});
  assert.equal(elsewhere.status, 400);
});

test("should end an account's connections when it closes, and forget them at its erasure", async () => {
  const owner = await person('erased');
  const {tokens} = await connect(owner);
  await fixture.db.execute("UPDATE users SET deletion_requested_at='2026-10-11 10:00:00' WHERE id=$1", [owner.id]);
  assert.equal((await mcp(tokens.access_token, 'tools/call', {name: 'morfa_list_files', arguments: {}})).status, 401);
  const {eraseAccount} = await import('../server/launch/lifecycle');
  await eraseAccount(owner.id, new Date().toISOString());
  const left = await fixture.db.one<{grants: number; codes: number; days: number}>(
    `SELECT (SELECT count(*)::int FROM oauth_grants WHERE user_id=$1) AS grants,(SELECT count(*)::int FROM oauth_codes WHERE user_id=$1) AS codes,
            (SELECT count(*)::int FROM mcp_daily_calls WHERE user_id=$1) AS days`,
    [owner.id],
  );
  assert.deepEqual(left, {grants: 0, codes: 0, days: 0});
});
