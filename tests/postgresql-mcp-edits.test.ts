import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {bootPostgresqlApp, type AppFixture} from './helpers/app-fixture';

// Editing through the MCP server on a fresh database, through the whole application (docs/mcp-server.md §Editing): a person allows their
// assistant to change files, and it creates a file, a page and layers, changes, copies and deletes them, saves colours, and undoes its
// own changes; each change reaches an editor that has the file open, as a teammate's would. A connection allowed only to read, a file the
// account may only view, someone else's file, a change made since by the person, a revoked connection and editing switched off each stop
// it, and nothing is charged for any of it.

let fixture: AppFixture;
const SWITCHES = {ENABLE_DESIGN_TOOL: '1', ENABLE_MCP_SERVER: '1', ENABLE_MCP_EDITS: '1', MCP_ACCOUNTS: '*'};
const saved = Object.fromEntries(
  ['APP_ORIGIN', 'DESIGN_TOOL_ACCOUNTS', 'MCP_DAILY_CALLS', ...Object.keys(SWITCHES)].map(key => [key, process.env[key]]),
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

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
type Person = {id: string; email: string; cookie: string};
/** An account with the Professional plan, as the MCP server needs. */
async function person(label: string): Promise<Person> {
  const id = `mcp-edit:${label}:${randomUUID()}`,
    token = randomUUID(),
    email = `${label}-${randomUUID()}@example.test`;
  await fixture.db.execute("INSERT INTO users(id,email,name,password,email_verified) VALUES($1,$2,'Designer','',1)", [id, email]);
  await fixture.db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [digest(token), id, Date.now() + 3_600_000]);
  return {id, email, cookie: `forma_session=${token}`};
}
async function api(who: Person, method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.base + path, {
    method,
    headers: {cookie: who.cookie, ...(body === undefined ? {} : {'content-type': 'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const text = await response.text();
  return {status: response.status, json: text ? JSON.parse(text) : undefined};
}
const documentOf = async (who: Person, fileId: string) => {
  const read = await api(who, 'GET', `/api/design-files/${fileId}`);
  assert.equal(read.status, 200, JSON.stringify(read.json));
  return read.json as {file: {version: number}; document: {pages: string[]; nodes: Record<string, any>; styles: Record<string, any>}};
};

const cookieJar = (initial: string) => {
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
  };
};

const REDIRECT = 'http://127.0.0.1:43123/callback';
/** The whole connection, as the assistant and the person's browser make it, asking for `scope` (none: what the server offers). */
/** How ChatGPT's connectors sign in (developers.openai.com/apps-sdk/build/auth): their redirect address, a signed assertion they may
 *  prefer, refresh, and RFC 8707's `resource` on both requests. */
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

async function connect(
  who: Person,
  scope?: string,
  as: 'claude' | 'chatgpt' = 'claude',
): Promise<{token: string; scope: string; consent: string; iss: string | null}> {
  const chatgpt = as === 'chatgpt';
  const redirect = chatgpt ? CHATGPT_REDIRECT : REDIRECT;
  // The address ChatGPT is given is the published one (RFC 9728 `resource`).
  const resource: Record<string, string> = chatgpt
    ? {resource: (await (await fetch(fixture.base + '/.well-known/oauth-protected-resource/mcp')).json()).resource as string}
    : {};
  const registered = await fetch(fixture.base + '/oauth/register', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(
      chatgpt
        ? {
            client_name: 'ChatGPT',
            redirect_uris: [redirect],
            token_endpoint_auth_method: 'private_key_jwt',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
          }
        : {client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none'},
    ),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  assert.equal(client.token_endpoint_auth_method, 'none', 'a public client');
  const clientId = client.client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const browser = cookieJar(who.cookie);
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(scope === undefined ? {} : {scope}),
    ...resource,
  });
  const authorize = await fetch(`${fixture.base}/oauth/authorize?${query}`, {headers: {cookie: browser.header}, redirect: 'manual'});
  assert.equal(authorize.status, 302);
  browser.take(authorize);
  const consentPath = authorize.headers.get('location')!;
  const consent = await (await fetch(fixture.base + consentPath, {headers: {cookie: browser.header}})).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(consent)![1]!;
  const allowed = await fetch(fixture.base + '/oauth/consent', {
    method: 'POST',
    headers: {cookie: browser.header, 'content-type': 'application/x-www-form-urlencoded', origin: fixture.base, 'sec-fetch-site': 'same-origin'},
    body: new URLSearchParams({req: consentPath.split('=')[1]!, csrf, decision: 'allow'}),
    redirect: 'manual',
  });
  assert.equal(allowed.status, 302);
  const back = new URL(allowed.headers.get('location')!);
  assert.equal(back.origin + back.pathname, redirect);
  const code = back.searchParams.get('code')!;
  const exchanged = await fetch(fixture.base + '/oauth/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: verifier, ...resource}),
  });
  const tokens = await exchanged.json();
  assert.equal(exchanged.status, 200, JSON.stringify(tokens));
  return {token: tokens.access_token, scope: tokens.scope, consent, iss: back.searchParams.get('iss')};
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
  return {status: response.status, json};
}
type ToolAnswer = {isError?: boolean; content: {type: string; text: string}[]; structuredContent: any};
const tool = async (token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
  const answer = await mcp(token, 'tools/call', {name, arguments: args});
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json.result;
};
const ok = (answer: ToolAnswer) => {
  assert.equal(answer.isError, undefined, answer.content[0]?.text);
  return answer.structuredContent;
};
const refusal = (answer: ToolAnswer, code: string) => {
  assert.equal(answer.isError, true, JSON.stringify(answer.structuredContent));
  assert.equal(answer.structuredContent.error.code, code, answer.content[0]?.text);
  return answer.structuredContent.error;
};

/** An editor's live stream of a file (src/design/realtime): the `change` events after `since`. */
async function openEditor(who: Person, fileId: string, since: number) {
  const controller = new AbortController();
  const response = await fetch(`${fixture.base}/api/design-files/${fileId}/events?since=${since}`, {
    headers: {cookie: who.cookie, accept: 'text/event-stream'},
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async nextChange(): Promise<{version: number; patch: any; by: string | null; user: string}> {
      for (;;) {
        const end = buffered.indexOf('\n\n');
        if (end >= 0) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = block
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
          if (event === 'change') return JSON.parse(data);
          continue;
        }
        const {value, done} = await reader.read();
        if (done) throw new Error('the stream ended');
        buffered += decoder.decode(value, {stream: true});
      }
    },
    close: () => controller.abort(),
  };
}

test('should offer the right to change files, list the editing tools and ask the person for it by name', async () => {
  const resource = await (await fetch(fixture.base + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(resource.scopes_supported, ['read', 'write']);
  const server = await (await fetch(fixture.base + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(server.scopes_supported, ['read', 'write', 'offline_access']);
  const hello = await mcp(undefined, 'initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '0'}}, CHATGPT_AGENT);
  assert.match(hello.json.result.instructions, /morfa_undo/);
  const listed = (await mcp(undefined, 'tools/list', undefined, CHATGPT_AGENT)).json.result.tools as {name: string; annotations: Record<string, unknown>}[];
  const named = new Map(listed.map(entry => [entry.name, entry]));
  for (const name of ['morfa_create_file', 'morfa_add_page', 'morfa_create_layers', 'morfa_update_layers', 'morfa_delete_layers', 'morfa_duplicate_layers', 'morfa_add_color_styles', 'morfa_undo'])
    assert.equal(named.get(name)?.annotations.readOnlyHint, false, name);
  assert.equal(named.get('morfa_delete_layers')?.annotations.destructiveHint, true);
  assert.equal(named.has('morfa_look_at'), false, 'no render service in the tests');

  const owner = await person('asks');
  const both = await connect(owner);
  assert.equal(both.scope, 'read write');
  assert.match(both.consent, /Change files you can edit/);
  const reading = await connect(owner, 'read');
  assert.equal(reading.scope, 'read', 'reading only, as asked; allowing again replaces the earlier consent');
  assert.match(reading.consent, /Change nothing/);
});

test('should let ChatGPT sign in the way its connectors do and build in a file', async () => {
  const listed = (await mcp(undefined, 'tools/list', undefined, CHATGPT_AGENT)).json.result.tools as {name: string; _meta?: {securitySchemes?: unknown}}[];
  for (const entry of listed)
    assert.deepEqual(
      entry._meta?.securitySchemes,
      [{type: 'oauth2', scopes: entry.name.startsWith('morfa_get_') || ['morfa_list_files', 'morfa_show_file'].includes(entry.name) ? ['read'] : ['read', 'write']}],
      entry.name,
    );
  const server = await (await fetch(fixture.base + '/.well-known/oauth-authorization-server')).json();
  assert.equal(server.authorization_response_iss_parameter_supported, true);

  const owner = await person('chatgpt');
  const {token, scope, iss} = await connect(owner, 'openid read write offline_access', 'chatgpt');
  assert.equal(scope, 'read write offline_access', 'openid passed over');
  assert.equal(iss, server.issuer, 'RFC 9207: ChatGPT compares it exactly');
  const made = ok(await tool(token, 'morfa_create_file', {name: 'From ChatGPT'}));
  const fileId = made.file.id as string;
  const built = ok(
    await tool(token, 'morfa_create_layers', {
      fileId,
      parent: null,
      layers: [{id: 'card', type: 'FRAME', name: 'Card', width: 390, height: 200, fill: '#FFFFFF'}],
    }),
  );
  assert.equal(built.version, made.file.version + 1);
  ok(await tool(token, 'morfa_undo', {fileId}));
});

test('should build in a new file, show each change in an open editor, and undo its own changes in order', async () => {
  const owner = await person('builder');
  const {token} = await connect(owner, 'read write offline_access');

  const made = ok(await tool(token, 'morfa_create_file', {name: 'Coffee shop landing'}));
  const fileId = made.file.id as string;
  assert.equal(made.file.link, `http://127.0.0.1:5400/#design/${fileId}`);
  const pageId = made.pageId as string;
  const editor = await openEditor(owner, fileId, made.file.version);

  const built = ok(
    await tool(token, 'morfa_create_layers', {
      fileId,
      parent: null,
      layers: [
        {id: 'screen', type: 'FRAME', name: 'Home', width: 1440, height: 900, fill: '#FFFDF8', layout: {mode: 'VERTICAL', gap: 24, padding: {top: 64, right: 120, bottom: 64, left: 120}}},
        {id: 'title', parent: 'screen', type: 'TEXT', name: 'Heading', width: 800, height: 64, text: {characters: 'Coffee we roast ourselves', fontFamily: 'Inter', fontSize: 56, fontWeight: 700, color: '#1E1E1E'}, sizing: {horizontal: 'FILL', vertical: 'HUG'}},
        {id: 'photo', parent: 'screen', type: 'IMAGE', name: 'Photo', width: 1200, height: 480, image: {description: 'Beans in a roasting drum'}},
      ],
    }),
  );
  assert.equal(built.changed, true);
  assert.equal(built.version, made.file.version + 1);
  const [screen] = built.created as string[];
  assert.equal(built.layers, 3);
  const live = await editor.nextChange();
  assert.equal(live.version, built.version, 'the open editor gets the change');
  assert.equal(live.user, owner.id);
  assert.equal(live.by, null, 'no editor tab made it, so every tab applies it');
  assert.equal(live.patch.nodes[screen!].name, 'Home');

  // The person's own editor reads what the assistant made, through the ordinary API.
  let doc = (await documentOf(owner, fileId)).document;
  assert.equal(doc.nodes[screen!].parentId, pageId);
  assert.equal(doc.nodes[screen!].children.length, 2);
  const titleId = doc.nodes[screen!].children.find((child: string) => doc.nodes[child].type === 'TEXT');

  const changed = ok(await tool(token, 'morfa_update_layers', {fileId, updates: [{id: titleId, text: {characters: 'Fresh roast every week'}}, {id: 'nope', name: 'x'}]}));
  assert.match(changed.result, /nope: no such layer/);
  assert.equal((await editor.nextChange()).version, changed.version);
  const copied = ok(await tool(token, 'morfa_duplicate_layers', {fileId, ids: [screen]}));
  const [copy] = copied.copies as string[];
  await editor.nextChange();
  const styled = ok(await tool(token, 'morfa_add_color_styles', {fileId, group: 'Brand', colors: [{name: 'Primary', color: '#6F4E37'}]}));
  await editor.nextChange();
  const paged = ok(await tool(token, 'morfa_add_page', {fileId, name: 'Mobile version'}));
  await editor.nextChange();
  doc = (await documentOf(owner, fileId)).document;
  assert.equal(doc.nodes[titleId].text.characters, 'Fresh roast every week');
  assert.ok(doc.nodes[copy!] && doc.nodes[copy!].x > doc.nodes[screen!].x + 1440, 'the copy stands right of the original');
  assert.deepEqual(Object.values(doc.styles).map((style: any) => style.name), ['Brand/Primary']);
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.nodes[paged.page.id].name, 'Mobile version');
  assert.equal(styled.changed, true);

  // Undo, newest first: the page, then the colours, then the copy.
  const kept = await fixture.db.many<{label: string}>('SELECT label FROM mcp_edits WHERE file_id=$1 ORDER BY created_at', [fileId]);
  assert.deepEqual(kept.map(row => row.label), ['New layers', 'Edit layers', 'Duplicate', 'Palette', 'New page']);
  refusal(await tool(token, 'morfa_undo', {fileId, editId: copied.editId}), 'conflict');
  assert.equal(ok(await tool(token, 'morfa_undo', {fileId})).undone.label, 'New page');
  assert.equal(ok(await tool(token, 'morfa_undo', {fileId, editId: styled.editId})).undone.label, 'Palette');
  const undone = ok(await tool(token, 'morfa_undo', {fileId}));
  assert.equal(undone.undone.label, 'Duplicate');
  assert.equal(undone.undoable, 2);
  doc = (await documentOf(owner, fileId)).document;
  assert.equal(doc.nodes[copy!], undefined);
  assert.deepEqual(doc.styles, {});
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.nodes[titleId].text.characters, 'Fresh roast every week', 'what came before stays');
  editor.close();

  // The person changes the title themselves: the assistant's change to it can no longer be undone without losing theirs.
  const current = await documentOf(owner, fileId);
  const mine = {...current.document.nodes[titleId], name: 'My heading'};
  const patched = await api(owner, 'PATCH', `/api/design-files/${fileId}/document`, {
    baseVersion: current.file.version,
    patch: {nodes: {[titleId]: mine}},
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const conflict = refusal(await tool(token, 'morfa_undo', {fileId}), 'conflict');
  assert.match(conflict.message, new RegExp(titleId));
  assert.equal((await documentOf(owner, fileId)).document.nodes[titleId].name, 'My heading');
});

test('should refuse a read-only connection, a file it may only view, someone else\'s file, and stop with the connection', async () => {
  const owner = await person('owner'),
    viewer = await person('viewer');
  const made = await api(owner, 'POST', '/api/design-files', {name: 'Foreign mockup'});
  assert.equal(made.status, 201);
  const fileId = made.json.file.id as string;
  const before = (await documentOf(owner, fileId)).file.version;
  const layer = {fileId, layers: [{id: 'a', type: 'RECTANGLE', width: 10, height: 10}]};

  const reading = await connect(owner, 'read');
  refusal(await tool(reading.token, 'morfa_create_layers', layer), 'insufficient_scope');

  await fixture.db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'viewer')", [fileId, viewer.id]);
  const viewing = await connect(viewer);
  ok(await tool(viewing.token, 'morfa_get_file', {fileId}));
  refusal(await tool(viewing.token, 'morfa_create_layers', layer), 'forbidden');
  refusal(await tool(viewing.token, 'morfa_undo', {fileId}), 'not_found');
  const stranger = await connect(await person('stranger'));
  refusal(await tool(stranger.token, 'morfa_create_layers', layer), 'not_found');
  assert.equal((await documentOf(owner, fileId)).file.version, before, 'nothing was saved');

  // Made an editor: the same connection may change it now.
  await fixture.db.execute("UPDATE design_file_members SET role='editor' WHERE file_id=$1 AND user_id=$2", [fileId, viewer.id]);
  const edited = ok(await tool(viewing.token, 'morfa_create_layers', layer));
  assert.equal(edited.version, before + 1);

  // "Disconnect": the grant is revoked; the next call is refused at the door, and the write's own check refuses it too.
  const [connection] = (await api(viewer, 'GET', '/api/mcp/connections')).json.connections;
  assert.equal((await api(viewer, 'DELETE', `/api/mcp/connections/${connection.id}`)).status, 200);
  assert.equal((await mcp(viewing.token, 'tools/call', {name: 'morfa_create_layers', arguments: layer})).status, 401);
  const {lockMcpWriter} = await import('../server/mcp/authority');
  const token = await fixture.db.one<{id: string}>(
    "SELECT k.id FROM oauth_tokens k JOIN oauth_grants g ON g.id=k.grant_id WHERE g.user_id=$1 AND k.kind='access' LIMIT 1",
    [owner.id],
  );
  assert.equal(await fixture.db.transaction(tx => lockMcpWriter(tx, owner.id, token!.id)), false, 'a read-only grant may not write');
  assert.equal(await fixture.db.transaction(tx => lockMcpWriter(tx, viewer.id, token!.id)), false, 'nor for another account');
});

test('should stop offering and accepting edits when editing is switched off', async () => {
  const owner = await person('switch');
  const {token} = await connect(owner);
  const fileId = ok(await tool(token, 'morfa_create_file', {name: 'File'})).file.id;
  process.env.ENABLE_MCP_EDITS = '0';
  try {
    const listed = (await mcp(token, 'tools/list')).json.result.tools as {name: string}[];
    assert.ok(!listed.some(entry => entry.name === 'morfa_create_layers'));
    const called = await mcp(token, 'tools/call', {name: 'morfa_create_layers', arguments: {fileId, layers: []}});
    assert.ok(called.json.error || called.json.result?.isError, 'an unknown tool now');
    const grant = await fixture.db.one<{id: string}>(
      "SELECT k.id FROM oauth_tokens k JOIN oauth_grants g ON g.id=k.grant_id WHERE g.user_id=$1 AND k.kind='access'",
      [owner.id],
    );
    const {lockMcpWriter} = await import('../server/mcp/authority');
    assert.equal(await fixture.db.transaction(tx => lockMcpWriter(tx, owner.id, grant!.id)), false);
    ok(await tool(token, 'morfa_get_file', {fileId}));
  } finally {
    process.env.ENABLE_MCP_EDITS = '1';
  }
});

test('should put the assistant\'s own pictures in a file: a link, an image from ChatGPT, base64 and an upload from the computer', async () => {
  const sharp = (await import('sharp')).default;
  const png = await sharp({create: {width: 64, height: 48, channels: 3, background: '#C4C0FF'}}).png().toBuffer();
  // A web server with a picture and a page, reachable here because the guard is pointed at loopback (production refuses it).
  const {createServer} = await import('node:http');
  const site = createServer((req, res) => {
    if (req.url === '/cat.png') return void res.writeHead(200, {'content-type': 'image/png'}).end(png);
    if (req.url === '/download') return void res.writeHead(200, {'content-type': 'application/octet-stream'}).end(png);
    res.writeHead(200, {'content-type': 'text/html'}).end('<p>not a picture</p>');
  });
  await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
  const port = (site.address() as {port: number}).port,
    origin = `http://127.0.0.1:${port}`;
  const {pictureFetch} = await import('../server/mcp/uploads');
  const {DEFAULT_POLICY} = await import('../server/design/link-preview');
  pictureFetch.policy = {...DEFAULT_POLICY, isBlocked: () => false, ports: new Set([port])};
  try {
    const listed = (await mcp(undefined, 'tools/list', undefined, CHATGPT_AGENT)).json.result.tools as {name: string; _meta?: Record<string, unknown>}[];
    const place = listed.find(entry => entry.name === 'morfa_place_image')!;
    assert.deepEqual(place._meta?.['openai/fileParams'], ['file'], 'ChatGPT hands images from the chat to this argument');

    const owner = await person('own-pictures');
    const {token} = await connect(owner);
    const fileId = ok(await tool(token, 'morfa_create_file', {name: 'Own pictures'})).file.id as string;
    const images = async () => (await fixture.db.one<{n: number}>('SELECT count(*)::int AS n FROM design_images WHERE file_id=$1', [fileId]))!.n;
    const layerOf = async (id: string) => (await documentOf(owner, fileId)).document.nodes[id];

    // The picture itself, as a new layer.
    const inline = ok(await tool(token, 'morfa_place_image', {fileId, data: png.toString('base64'), name: 'Cover'}));
    assert.deepEqual(inline.picture, {width: 64, height: 48});
    assert.equal((await layerOf(inline.layer)).name, 'Cover');
    assert.ok(inline.editId, 'morfa_undo takes it back');
    assert.match(inline.file.link, new RegExp(`#design/${fileId}`));
    // A link, into a rectangle.
    const box = ok(await tool(token, 'morfa_create_layers', {fileId, parent: null, layers: [{id: 'r', type: 'RECTANGLE', name: 'Photo', width: 320, height: 240, fill: '#EEEEEE'}]}));
    const rect = (box.created as string[])[0]!;
    const linked = ok(await tool(token, 'morfa_place_image', {fileId, nodeId: rect, url: `${origin}/cat.png`}));
    assert.equal(linked.layer, rect);
    assert.match(JSON.stringify((await layerOf(rect)).fills), /IMAGE/);
    // ChatGPT's file from the chat (its download link says only octet-stream).
    const chat = ok(await tool(token, 'morfa_place_image', {fileId, file: {download_url: `${origin}/download`, file_id: 'file_1', mime_type: 'image/png', file_name: 'cat.png'}}));
    assert.equal((await layerOf(chat.layer)).name, 'cat');
    assert.equal(await images(), 3);
    refusal(await tool(token, 'morfa_place_image', {fileId, url: `${origin}/page`}), 'unavailable');
    refusal(await tool(token, 'morfa_place_image', {fileId, url: 'http://10.0.0.1/x.png'}), 'invalid_input');
    refusal(await tool(token, 'morfa_place_image', {fileId, data: Buffer.from('<svg/>').toString('base64')}), 'invalid_input');
    refusal(await tool(token, 'morfa_place_image', {fileId}), 'invalid_input');
    refusal(await tool(token, 'morfa_place_image', {fileId, data: 'AAAA', url: `${origin}/cat.png`}), 'invalid_input');
    refusal(await tool(token, 'morfa_place_image', {fileId, nodeId: 'nope', url: `${origin}/cat.png`}), 'not_found');
    assert.equal(await images(), 3, 'nothing stored for a refusal');

    // A file on the computer: an address, a PUT, then the place.
    const slot = ok(await tool(token, 'morfa_upload_image', {fileId}));
    assert.match(slot.uploadUrl, /\/mcp\/uploads\/[A-Za-z0-9_-]{43}$/);
    const put = (path: string, body: Buffer, method = 'PUT') =>
      fetch(fixture.base + path, {method, headers: {'content-type': 'image/png', 'x-file-name': 'screen.png'}, body: new Uint8Array(body)});
    const path = new URL(slot.uploadUrl).pathname;
    const early = await tool(token, 'morfa_place_image', {fileId, uploadId: slot.uploadId});
    refusal(early, 'not_found');
    const preflight = await fetch(fixture.base + path, {method: 'OPTIONS'});
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    const sent = await put(path, png);
    assert.equal(sent.status, 201);
    assert.equal((await sent.json()).uploadId, slot.uploadId);
    assert.equal((await put(path, png)).status, 404, 'an address takes one picture');
    assert.equal((await put('/mcp/uploads/' + 'x'.repeat(43), png)).status, 404);
    const uploaded = ok(await tool(token, 'morfa_place_image', {fileId, uploadId: slot.uploadId}));
    assert.equal((await layerOf(uploaded.layer)).name, 'screen');
    const other = ok(await tool(token, 'morfa_create_file', {name: 'Other'})).file.id;
    refusal(await tool(token, 'morfa_place_image', {fileId: other, uploadId: slot.uploadId}), 'invalid_input');
    const junk = ok(await tool(token, 'morfa_upload_image', {fileId}));
    assert.equal((await put(new URL(junk.uploadUrl).pathname, Buffer.from('not a picture'), 'POST')).status, 415);
    assert.equal(await images(), 4);

    // Someone else's connection cannot place this one's upload; a reading connection gets no address.
    const stranger = await person('stranger-pictures');
    const theirs = await connect(stranger);
    refusal(await tool(theirs.token, 'morfa_place_image', {fileId, uploadId: slot.uploadId}), 'not_found');
    const reading = await connect(owner, 'read');
    refusal(await tool(reading.token, 'morfa_upload_image', {fileId}), 'insufficient_scope');
    // A connection revoked after asking for an address can no longer send to it.
    const late = ok(await tool(token, 'morfa_upload_image', {fileId}));
    await fixture.db.execute('UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=(SELECT grant_id FROM mcp_uploads WHERE id=$1)', [late.uploadId]);
    assert.equal((await put(new URL(late.uploadUrl).pathname, png)).status, 403);
  } finally {
    pictureFetch.policy = DEFAULT_POLICY;
    site.close();
  }
});

test('should show the person a card for the file in the chat, as an MCP App Claude and ChatGPT draw', async () => {
  const owner = await person('card');
  const {token} = await connect(owner);
  const listed = (await mcp(token, 'tools/list')).json.result.tools as {name: string; _meta?: Record<string, any>}[];
  const show = listed.find(entry => entry.name === 'morfa_show_file')!;
  assert.equal(show._meta?.ui?.resourceUri, 'ui://morfa/file-card.html');
  assert.equal(show._meta?.['openai/outputTemplate'], 'ui://morfa/file-card.html');
  assert.equal(listed.filter(entry => entry._meta?.ui).length, 1, 'one card per conversation, not one per change');
  const resources = (await mcp(token, 'resources/list')).json.result.resources as {uri: string; mimeType: string}[];
  assert.deepEqual(resources.map(entry => [entry.uri, entry.mimeType]), [['ui://morfa/file-card.html', 'text/html;profile=mcp-app']]);
  const page = (await mcp(token, 'resources/read', {uri: 'ui://morfa/file-card.html'})).json.result.contents[0];
  assert.equal(page.mimeType, 'text/html;profile=mcp-app');
  assert.match(page.text, /Open in Morfa/);
  assert.doesNotMatch(page.text, /https?:\/\/(?!www\.w3)/, 'the page loads nothing from anywhere');

  const made = ok(await tool(token, 'morfa_create_file', {name: 'Card'}));
  const box = ok(await tool(token, 'morfa_create_layers', {fileId: made.file.id, parent: null, layers: [{id: 's', type: 'FRAME', name: 'Screen', width: 390, height: 844}]}));
  const frame = (box.created as string[])[0]!;
  const card = ok(await tool(token, 'morfa_show_file', {fileId: made.file.id, nodeId: frame}));
  assert.equal(card.file.name, 'Card');
  assert.equal(card.file.link, `http://127.0.0.1:5400/#design/${made.file.id}?node=${encodeURIComponent(frame)}`);
  assert.deepEqual(card.frame, {id: frame, name: 'Screen', width: 390, height: 844});
  assert.deepEqual([card.pages, card.layers], [1, 1]);
});

test('should erase the kept changes with the connection, the file and the account', async () => {
  const owner = await person('erase');
  const {token} = await connect(owner);
  const fileId = ok(await tool(token, 'morfa_create_file', {name: 'Temporary'})).file.id;
  ok(await tool(token, 'morfa_add_page', {fileId, name: 'Second'}));
  const count = async () => (await fixture.db.one<{n: number}>('SELECT count(*)::int AS n FROM mcp_edits WHERE file_id=$1', [fileId]))!.n;
  assert.equal(await count(), 1);
  const {eraseMcpOf} = await import('../server/mcp/oauth/store');
  await fixture.db.transaction(tx => eraseMcpOf(tx, owner.id));
  assert.equal(await count(), 0);
});
