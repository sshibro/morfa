import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync, rmSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {z} from 'zod/v4';

// The MCP server without a database (docs/mcp-server.md): its switches and addresses, the sign-in's pure checks, the gate in front of
// /mcp, and the endpoint itself over HTTP with probe tools (the 2025 `initialize` handshake, then tools/list and tools/call).

// The database module is loaded by the gate's module: a configuration that is never connected to is enough.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'morfa-mcp-'));
process.env.MORFA_DATABASE_URL ||= 'postgresql://morfa_runtime:unused@127.0.0.1:5999/morfa?sslmode=disable';
process.env.DATA_DIR = dataDir;
after(() => rmSync(dataDir, {recursive: true, force: true}));

const config = await import('../server/mcp/config');
const shared = await import('../server/mcp/oauth/shared');
const {createGate, resetMcpRateLimits} = await import('../server/mcp/auth');
const {createMcpRouter, callsOf} = await import('../server/mcp/router');
const {standardSchemaOf} = await import('../server/mcp/endpoint');
const {ToolError} = await import('../server/mcp/errors');
type Principal = import('../server/mcp/auth').Principal;
type ToolDefinition = import('../server/mcp/tools').ToolDefinition;
type GateInput = import('../server/mcp/auth').GateInput;

const ON = {ENABLE_DESIGN_TOOL: '1', ENABLE_MCP_SERVER: '1'};
const account = {id: 'u1', email: 'person@example.test', email_verified: 1};

test('should be on only with the design tool, and open only to the accounts MCP_ACCOUNTS names', () => {
  // The design tool's own switch is read from the process (server/design/flag.ts).
  process.env.ENABLE_DESIGN_TOOL = '1';
  assert.equal(config.mcpServerOn({ENABLE_MCP_SERVER: '1'}), false);
  assert.equal(config.mcpServerOn(ON), true);
  assert.equal(config.mcpAvailable(account, ON), false, 'unset is nobody');
  assert.equal(config.mcpAvailable(account, {...ON, MCP_ACCOUNTS: ''}), false);
  assert.equal(config.mcpAvailable(account, {...ON, MCP_ACCOUNTS: '*'}), true);
  assert.equal(config.mcpAvailable(account, {...ON, MCP_ACCOUNTS: 'someone-else'}), false);
  assert.equal(config.mcpAvailable(account, {...ON, MCP_ACCOUNTS: 'x, u1'}), true);
  assert.equal(config.mcpAvailable(null, {...ON, MCP_ACCOUNTS: '*'}), false);
  assert.equal(
    config.mcpAvailable(account, {ENABLE_MCP_SERVER: '1', MCP_ACCOUNTS: '*'}),
    false,
    'never without the design tool',
  );
});

test("should live on the app's origin, with the loopback names only outside production", () => {
  const production = {NODE_ENV: 'production', APP_ORIGIN: 'https://app.morfa.example/'};
  assert.equal(config.mcpIssuer(production), 'https://app.morfa.example');
  assert.equal(config.mcpResourceUrl(production), 'https://app.morfa.example/mcp');
  assert.deepEqual(config.mcpHosts(production), ['app.morfa.example']);
  assert.deepEqual(config.mcpOrigins(production), []);
  assert.deepEqual(config.acceptedResourceUrls(production), ['https://app.morfa.example/mcp']);
  assert.equal(
    config.protectedResourceMetadataUrl('https://app.morfa.example/mcp'),
    'https://app.morfa.example/.well-known/oauth-protected-resource/mcp',
  );
  const development = {};
  assert.equal(config.mcpResourceUrl(development), 'http://127.0.0.1:5400/mcp');
  assert.ok(config.mcpHosts(development).includes('localhost'));
  assert.ok(config.acceptedResourceUrls(development).includes('http://localhost:3400/mcp'));
  assert.equal(config.mcpDailyCalls({}), 2000);
  assert.equal(config.mcpDailyCalls({MCP_DAILY_CALLS: '50'}), 50);
  assert.equal(config.mcpDailyCalls({MCP_DAILY_CALLS: '-1'}), 2000);
});

test("should check PKCE, redirect addresses, a client's self-description and the rights asked for", () => {
  const verifier = 'v'.repeat(43);
  assert.equal(shared.verifierMatches(verifier, shared.challengeOf(verifier)), true);
  assert.equal(shared.verifierMatches('w'.repeat(43), shared.challengeOf(verifier)), false);
  assert.equal(shared.verifierMatches('short', shared.challengeOf('short')), false);

  for (const bad of [
    'myapp://callback',
    'http://example.com/cb',
    'https://user:pw@example.com/cb',
    'https://example.com/cb#x',
    'javascript:alert(1)',
  ])
    assert.equal(shared.parseRedirectUri(bad), undefined, bad);
  assert.ok(shared.parseRedirectUri('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(
    shared.redirectUriMatches(['http://127.0.0.1:1234/callback'], 'http://127.0.0.1:5678/callback'),
    'a loopback port may change',
  );
  assert.equal(shared.redirectUriMatches(['http://127.0.0.1:1234/callback'], 'http://127.0.0.1:5678/other'), false);
  assert.equal(shared.redirectUriMatches(['https://a.example/cb'], 'https://a.example/cb/'), false, 'exact text');

  const read = shared.readClientMetadata({
    client_name: 'Claude‮ evil',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  });
  assert.equal(read.clientName, 'Claude evil');
  assert.deepEqual(read.stored.grant_types, ['authorization_code']);
  // ChatGPT's own registration (developers.openai.com/apps-sdk/build/auth): its redirect address, and a signed assertion it may prefer;
  // registered as a public client, which the answer says.
  const chatgpt = shared.readClientMetadata({
    client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    token_endpoint_auth_method: 'private_key_jwt',
    grant_types: ['authorization_code', 'refresh_token'],
  });
  assert.equal(chatgpt.stored.token_endpoint_auth_method, 'none');
  assert.deepEqual(chatgpt.stored.grant_types, ['authorization_code', 'refresh_token']);
  assert.throws(
    () => shared.readClientMetadata({redirect_uris: ['https://a.example/cb'], grant_types: ['client_credentials']}),
    shared.OAuthError,
    'no machine-to-machine grant',
  );
  assert.throws(() => shared.readClientMetadata({redirect_uris: ['myapp://cb']}), shared.OAuthError);
  assert.throws(() => shared.readClientMetadata({}), shared.OAuthError);

  assert.deepEqual(shared.parseScopes(undefined), {scopes: ['read'], offlineAccess: false});
  assert.deepEqual(shared.parseScopes('read offline_access'), {scopes: ['read'], offlineAccess: true});
  assert.deepEqual(
    shared.parseScopes('read write'),
    {scopes: ['read'], offlineAccess: false},
    'while editing is off, asking to write connects for reading (docs/mcp-server.md §Editing)',
  );
  assert.equal(shared.parseScopes('read admin'), undefined, 'an unknown right is refused');
  assert.deepEqual(
    shared.parseScopes('openid email profile read offline_access'),
    {scopes: ['read'], offlineAccess: true},
    "OpenID Connect's words are passed over",
  );

  const metadata = shared.authorizationServerMetadata('https://app.morfa.example');
  assert.equal(metadata.issuer, 'https://app.morfa.example');
  assert.equal(metadata.token_endpoint, 'https://app.morfa.example/oauth/token');
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
});

const principal: Principal = {grantId: 'g1', tokenId: 't1', userId: 'u1', client: 'Claude', scopes: new Set(['read'])};
const gateInput = (calls: GateInput['calls'], extra: Partial<GateInput> = {}): GateInput => ({
  authorization: undefined,
  userAgent: 'claude-code/2.0',
  ip: '203.0.113.7',
  calls,
  ...extra,
});
const toolCall = {method: 'tools/call', id: 7, tool: true};

test('should send every request without a credential to the sign-in, and let ChatGPT shake hands first', async () => {
  resetMcpRateLimits();
  let asked = 0;
  const gate = createGate({verify: async () => (asked++, {ok: true, principal}), toolErrorClients: () => ['chatgpt']});
  // Claude's directory needs the challenge on the handshake itself.
  const hello = await gate(gateInput([{method: 'initialize', id: 1, tool: false}]));
  assert.equal(!hello.ok && hello.status, 401);
  assert.match(!hello.ok ? hello.headers['WWW-Authenticate']! : '', /resource_metadata=/);
  assert.deepEqual(
    await gate(gateInput([{method: 'initialize', id: 1, tool: false}], {userAgent: 'Mozilla/5.0 ChatGPT-User'})),
    {ok: true, principal: null},
  );
  const refused = await gate(gateInput([toolCall]));
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.status, 401);
  assert.match(
    refused.headers['WWW-Authenticate']!,
    /resource_metadata="http:\/\/127\.0\.0\.1:5400\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  // ChatGPT starts its sign-in from a tool error.
  const chatgpt = await gate(gateInput([toolCall], {userAgent: 'Mozilla/5.0 ChatGPT-User'}));
  assert.equal(!chatgpt.ok && chatgpt.status, 200);
  assert.equal(asked, 0, 'no credential, no lookup');
  assert.deepEqual(await gate(gateInput([toolCall], {authorization: 'Bearer anything'})), {ok: true, principal});
});

test('should answer every dead credential alike, look a repeated one up once, and tell only a live one its account is not open', async () => {
  resetMcpRateLimits();
  let asked = 0;
  const failure = {ok: false as const, failure: 'revoked' as const};
  const gate = createGate({verify: async () => (asked++, failure)});
  for (let i = 0; i < 3; i++) {
    const refused = await gate(gateInput([toolCall], {authorization: 'Bearer morfa_at_dead'}));
    assert.equal(!refused.ok && refused.status, 401);
    assert.match(!refused.ok ? refused.headers['WWW-Authenticate']! : '', /error="invalid_token"/);
  }
  assert.equal(asked, 1, 'a known-bad credential is not looked up again for a minute');
  const closed = createGate({verify: async () => ({ok: false, failure: 'account_not_enabled'})});
  const forbidden = await closed(gateInput([toolCall], {authorization: 'Bearer morfa_at_live'}));
  assert.equal(!forbidden.ok && forbidden.status, 403);
});

test('should hold a connection to its calls a minute', async () => {
  resetMcpRateLimits();
  const gate = createGate({verify: async () => ({ok: true, principal})});
  for (let i = 0; i < config.MCP_CALLS_PER_MINUTE.connection; i++)
    assert.equal((await gate(gateInput([toolCall], {authorization: 'Bearer x'}))).ok, true);
  const limited = await gate(gateInput([toolCall], {authorization: 'Bearer x'}));
  assert.equal(!limited.ok && limited.status, 429);
  assert.ok(!limited.ok && Number(limited.headers['Retry-After']) >= 1);
  resetMcpRateLimits();
});

test('should read what each message asks, and refuse what is not JSON-RPC', () => {
  assert.deepEqual(callsOf({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'morfa_list_files'}}), [
    {method: 'tools/call', id: 1, tool: true},
  ]);
  assert.deepEqual(callsOf([{jsonrpc: '2.0', method: 'notifications/initialized'}]), [
    {method: 'notifications/initialized', id: null, tool: false},
  ]);
  assert.equal(callsOf([]), undefined);
  assert.equal(callsOf('text'), undefined);
  assert.equal(callsOf(Array.from({length: 21}, () => ({jsonrpc: '2.0', method: 'ping', id: 1}))), undefined);
});

test("should describe a tool's input as JSON Schema, defaults optional", () => {
  const schema = standardSchemaOf(z.object({fileId: z.string(), depth: z.number().int().default(4)}).strict());
  const json = schema['~standard'].jsonSchema.input({target: 'draft-2020-12'}) as {
    properties: object;
    required?: string[];
    $schema?: string;
  };
  assert.deepEqual(Object.keys(json.properties), ['fileId', 'depth']);
  assert.deepEqual(json.required, ['fileId']);
  assert.equal(json.$schema, undefined);
});

// ── The endpoint over HTTP ──────────────────────────────────────────────────────────────────────────────────────────────────

const ran: unknown[] = [];
const probe: ToolDefinition = {
  name: 'morfa_probe',
  title: 'Probe',
  description: 'Records that it ran.',
  inputSchema: z
    .object({count: z.number().int().min(1).max(5).default(1), fail: z.enum(['tool', 'crash']).optional()})
    .strict(),
  async handler(input: {count: number; fail?: string}, who) {
    ran.push({input, userId: who.userId});
    if (input.fail === 'tool')
      throw new ToolError(
        'not_found',
        'No such file, or this account cannot open it.',
        'Take the id from morfa_list_files.',
      );
    if (input.fail === 'crash') throw new Error('database password in a message');
    return {structured: {count: input.count}, text: `Counted ${input.count}.`};
  },
};

let dailyLeft = 1000;
async function start(options: {enabled?: boolean} = {}) {
  const app = express();
  const router = createMcpRouter({
    enabled: () => options.enabled ?? true,
    hosts: () => ['127.0.0.1'],
    origins: () => ['127.0.0.1'],
    tools: [probe],
    gate: async input =>
      input.authorization === 'Bearer good'
        ? {ok: true, principal}
        : input.calls.some(call => call.tool)
          ? {
              ok: false,
              status: 401,
              headers: {'WWW-Authenticate': 'Bearer realm="morfa"'},
              body: {jsonrpc: '2.0', error: {code: -32001, message: 'Authentication required.'}, id: null},
            }
          : {ok: true, principal: null},
    run: {dailyCalls: () => 5, takeCall: async () => dailyLeft-- > 0},
  });
  app.use(router);
  app.use((_req, res) => res.status(418).json({fellThrough: true}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: async () => {
      server.closeAllConnections();
      await router.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function raw(
  base: string,
  options: {method?: string; path?: string; headers?: Record<string, string>; body?: string},
): Promise<{status: number; headers: http.IncomingHttpHeaders; body: string}> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    let answered: {status: number; headers: http.IncomingHttpHeaders; body: string} | undefined;
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: options.path ?? '/mcp',
        method: options.method ?? 'POST',
        headers: options.headers,
      },
      response => {
        answered = {status: response.statusCode ?? 0, headers: response.headers, body: ''};
        response.on('data', chunk => (answered!.body += chunk));
        response.on('end', () => resolve(answered!));
      },
    );
    // A refused body: the answer came, then the server cut what was still being sent.
    request.on('error', error => (answered ? resolve(answered) : reject(error)));
    request.end(options.body);
  });
}
const PROTOCOL = '2025-06-18';
async function rpc(base: string, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method, ...(params ? {params} : {})});
  const answer = await raw(base, {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
      'content-length': String(Buffer.byteLength(body)),
      ...headers,
    },
    body,
  });
  // The SDK answers a request as JSON or as one SSE event.
  const text = answer.headers['content-type']?.includes('text/event-stream')
    ? answer.body
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5))
        .join('')
    : answer.body;
  return {...answer, json: text ? JSON.parse(text) : undefined};
}
const call = (base: string, args: unknown, headers: Record<string, string> = {Authorization: 'Bearer good'}) =>
  rpc(base, 'tools/call', {name: 'morfa_probe', arguments: args}, headers);

test('should shake hands, list the tools as read-only, and run one for the signed-in account', async () => {
  const {base, close} = await start();
  try {
    const hello = await rpc(base, 'initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: {name: 'test', version: '0'},
    });
    assert.equal(hello.status, 200, hello.body);
    assert.equal(hello.json.result.serverInfo.name, 'morfa');
    assert.match(hello.json.result.instructions, /morfa_list_files/);
    const listed = await rpc(base, 'tools/list');
    const [tool] = listed.json.result.tools;
    assert.equal(tool.name, 'morfa_probe');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.deepEqual(tool._meta.securitySchemes, [{type: 'oauth2', scopes: ['read']}], 'ChatGPT offers its sign-in for it');
    assert.deepEqual(tool.inputSchema.properties.count, {type: 'integer', minimum: 1, maximum: 5, default: 1});

    ran.length = 0;
    const ok = await call(base, {count: 3});
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.result.structuredContent, {count: 3});
    assert.equal(ok.json.result.content[0].text, 'Counted 3.');
    assert.deepEqual(ran, [{input: {count: 3}, userId: 'u1'}]);
  } finally {
    await close();
  }
});

test("should answer bad arguments, a tool's refusal, a crash and a spent day as tool errors the model can act on", async () => {
  const {base, close} = await start();
  try {
    const invalid = await call(base, {count: 9, extra: true});
    assert.equal(invalid.json.result.isError, true);
    assert.equal(invalid.json.result.structuredContent.error.code, 'invalid_input');
    assert.match(invalid.json.result.content[0].text, /"count"/);
    const missing = await call(base, {fail: 'tool'});
    assert.equal(missing.json.result.structuredContent.error.code, 'not_found');
    const crash = await call(base, {fail: 'crash'});
    assert.equal(crash.json.result.structuredContent.error.code, 'internal');
    assert.doesNotMatch(crash.body, /password/, 'nothing of an unexpected error reaches the caller');
    dailyLeft = 0;
    const spent = await call(base, {});
    assert.equal(spent.json.result.structuredContent.error.code, 'rate_limited');
    assert.match(spent.json.result.content[0].text, /5 Morfa calls/);
    dailyLeft = 1000;
  } finally {
    await close();
  }
});

test('should refuse a tool call without a credential, a foreign host or page, and a broken or huge body', async () => {
  const {base, close} = await start();
  try {
    ran.length = 0;
    const anonymous = await call(base, {}, {});
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers['www-authenticate'], 'Bearer realm="morfa"');
    assert.equal((await call(base, {}, {Authorization: 'Bearer good', Host: 'evil.example'})).status, 403);
    assert.equal((await call(base, {}, {Authorization: 'Bearer good', Origin: 'https://evil.example'})).status, 403);
    assert.deepEqual(ran, []);
    const broken = await raw(base, {
      headers: {'content-type': 'application/json', 'content-length': '5'},
      body: '{oops',
    });
    assert.equal(broken.status, 400);
    assert.equal(JSON.parse(broken.body).error.code, -32700);
    const huge = await raw(base, {
      headers: {'content-type': 'application/json'},
      body: `[${'1,'.repeat(1024 * 1024)}1]`,
    });
    assert.equal(huge.status, 413);
    assert.equal((await raw(base, {method: 'PUT'})).status, 405);
  } finally {
    await close();
  }
});

test('should publish where the sign-in lives, and be no route at all when off', async () => {
  const on = await start();
  try {
    const document = await raw(on.base, {method: 'GET', path: '/.well-known/oauth-protected-resource/mcp'});
    assert.equal(document.status, 200);
    const body = JSON.parse(document.body);
    assert.deepEqual(body.scopes_supported, ['read']);
    assert.deepEqual(body.authorization_servers, [config.mcpIssuer()]);
    assert.equal(body.resource_name, 'Morfa');
  } finally {
    await on.close();
  }
  const off = await start({enabled: false});
  try {
    for (const [method, route] of [
      ['POST', '/mcp'],
      ['GET', '/.well-known/oauth-protected-resource'],
      ['OPTIONS', '/.well-known/oauth-protected-resource/mcp'],
    ] as const)
      assert.equal((await raw(off.base, {method, path: route})).status, 418, `${method} ${route}`);
  } finally {
    await off.close();
  }
});
