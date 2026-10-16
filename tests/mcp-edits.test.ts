import test from 'node:test';
import assert from 'node:assert/strict';
import {add, buttonFile, measurer} from './design-codegen-fixture';
// The server's modules read the database settings when they load: an address nothing listens on (nothing here reaches a database).
process.env.MORFA_DATABASE_URL ||= 'postgresql://morfa_runtime:unused@127.0.0.1:5999/morfa?sslmode=disable';
const {changeDocument, changedSince, createdRoots, editableLayer, layersBox, mcpAliases, pageView} = await import('../server/mcp/edits');
const {placePicture, runCanvas} = await import('../server/mcp/edit-tools');
const {ToolError} = await import('../server/mcp/errors');
const {parseScopes} = await import('../server/mcp/oauth/shared');
const {createGate, resetMcpRateLimits} = await import('../server/mcp/auth');
const {currentTools, EDIT_INSTRUCTIONS} = await import('../server/mcp/tool-list');
const {buildMcpServer, SERVER_INSTRUCTIONS} = await import('../server/mcp/endpoint');
type EditSession = import('../server/mcp/edits').EditSession;
import {applyPatch} from '../shared/design/patch';
import {createDocument} from '../shared/design/defaults';
import {LIBRARY_PAGE_ID, type DesignDocument} from '../shared/design/types';

// The MCP server's editing (server/mcp/edits.ts, edit-tools.ts) without a database: the canvas tools run on a document in a store of
// their own, with the document's ids in and out; the change is one patch with its way back; the switches decide the right and the tools.

const ON = {ENABLE_DESIGN_TOOL: '1', ENABLE_MCP_SERVER: '1', ENABLE_MCP_EDITS: '1'};
function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}

/** A page "Screen" frame holding a title, and a loose rectangle beside it. */
function screenFile(): DesignDocument {
  let doc = createDocument('p', 'Home');
  doc = add(doc, 'FRAME', {id: 'screen', parentId: 'p', name: 'Screen', x: 0, y: 0, width: 400, height: 800});
  doc = add(doc, 'RECTANGLE', {id: 'box', parentId: 'p', name: 'Square', x: 600, y: 0, width: 100, height: 60});
  return doc;
}
const run = (doc: DesignDocument, target: {pageId?: string; near?: string}, work: (session: EditSession) => ReturnType<typeof runCanvas>) =>
  changeDocument(doc, target, work, {measurer});

test('should give the call\'s ids aliases and turn the result\'s aliases back, never inside quoted text', () => {
  const doc = screenFile();
  const aliases = mcpAliases(id => editableLayer(doc, id));
  assert.equal(aliases.input('screen'), 'L900001');
  assert.equal(aliases.input('screen'), 'L900001', 'one alias per id');
  assert.equal(aliases.input('nope'), 'L900002');
  assert.equal(aliases.input(null), null);
  assert.equal(aliases.resolve('L900001'), 'screen');
  assert.equal(aliases.resolve('L900002'), null, 'an unknown id is no layer');
  assert.equal(aliases.resolve('L1'), null);
  assert.equal(aliases.alias('screen'), 'screen', 'results name layers by their ids');
  assert.equal(
    aliases.output('L900001 "a layer named L900001" and L900002, L900003 L12'),
    'screen "a layer named L900001" and nope, L900003 L12',
  );
  const pageOnly = mcpAliases(id => editableLayer(doc, id));
  for (const id of ['p', '__proto__', 'constructor']) assert.equal(pageOnly.resolve(pageOnly.input(id) as string), null, id);
});

test('should keep pages, the library and unknown ids out of reach', () => {
  let doc = screenFile();
  doc = {...doc, pages: [...doc.pages, LIBRARY_PAGE_ID], nodes: {...doc.nodes, [LIBRARY_PAGE_ID]: {...doc.nodes.p!, id: LIBRARY_PAGE_ID, children: ['lib']}}};
  doc = {...doc, nodes: {...doc.nodes, lib: {...doc.nodes.box!, id: 'lib', parentId: LIBRARY_PAGE_ID}}};
  assert.equal(editableLayer(doc, 'screen'), true);
  assert.equal(editableLayer(doc, 'p'), false);
  assert.equal(editableLayer(doc, 'lib'), false);
  assert.equal(editableLayer(doc, 'hasOwnProperty'), false);
});

test('should build with create_layers on the page, right of what is there, and name the new layers by id', async () => {
  const doc = screenFile();
  const changed = await run(doc, {}, session =>
    runCanvas(session, 'create_layers', {
      parent: null,
      layers: [
        {id: 'card', type: 'FRAME', name: 'Card', width: 320, height: 200, fill: '#FFFFFF', layout: {mode: 'VERTICAL', gap: 8, padding: {top: 16, right: 16, bottom: 16, left: 16}}},
        {id: 'title', parent: 'card', type: 'TEXT', name: 'Title', width: 200, height: 24, text: {characters: 'Plan "Pro"', fontFamily: 'inter', fontSize: 20, fontWeight: 600}, sizing: {horizontal: 'FILL', vertical: 'HUG'}},
        {id: 'photo', parent: 'card', type: 'IMAGE', name: 'Photo', width: 288, height: 120, image: {description: 'Coffee beans close up'}},
      ],
    }),
  );
  assert.ok(changed.patch);
  const [card] = changed.value.created;
  const node = changed.after.nodes[card!]!;
  assert.equal(node.name, 'Card');
  assert.deepEqual([node.x, node.y], [800, 0], 'in a row right of what is on the page, top-aligned');
  assert.deepEqual(createdRoots(changed.patch, doc), [card]);
  assert.equal(changed.value.createdCount, 3);
  const title = node.children!.map(id => changed.after.nodes[id]!).find(child => child.type === 'TEXT')!;
  assert.equal(title.text?.style.fontFamily, 'Inter', "the catalogue's spelling");
  const photo = node.children!.map(id => changed.after.nodes[id]!).find(child => child.name === 'Photo')!;
  assert.equal(photo.type, 'RECTANGLE', 'a picture placeholder is a rectangle');
  assert.match(changed.value.text, new RegExp(`card→${card}`), 'local ids map to the new ids');
  assert.doesNotMatch(changed.value.text, /\bL9\d{5}\b|alias|inspect_canvas|inspect the canvas/);
  // The way back is exact: the change then its inverse is the document again.
  assert.deepEqual(applyPatch(applyPatch(doc, changed.patch), changed.inverse).nodes, doc.nodes);
});

test('should change, move, copy and delete layers by their ids, and refuse a call that changes nothing at all', async () => {
  const doc = screenFile();
  const updated = await run(doc, {near: 'box'}, session =>
    runCanvas(session, 'update_layers', {
      updates: [
        {id: session.aliases.input('box'), name: 'Button', fill: '#0D99FF', cornerRadius: 8, parent: session.aliases.input('screen')},
        {id: session.aliases.input('missing'), name: 'x'},
      ],
    }),
  );
  const box = updated.after.nodes.box!;
  assert.equal(box.name, 'Button');
  assert.equal(box.parentId, 'screen');
  assert.equal(box.cornerRadius, 8);
  assert.match(updated.value.text, /missing: no such layer/, "a problem names the caller's id");

  const copied = await run(doc, {near: 'screen'}, session => runCanvas(session, 'duplicate_layers', {ids: [session.aliases.input('screen')]}));
  const [copy] = copied.value.created;
  assert.ok(copy && copy !== 'screen' && copied.after.nodes[copy]);
  assert.match(copied.value.text, new RegExp(`screen→${copy}`));

  const removed = await run(doc, {near: 'box'}, session => runCanvas(session, 'delete_layers', {ids: [session.aliases.input('box')]}));
  assert.equal(removed.after.nodes.box, undefined);
  assert.deepEqual(removed.patch?.nodes?.box, null);

  await assert.rejects(
    run(doc, {}, session => runCanvas(session, 'delete_layers', {ids: [session.aliases.input('p')]})),
    (error: unknown) => error instanceof ToolError && error.code === 'refused' && /Nothing deleted/.test(error.message),
  );
  await assert.rejects(
    run(doc, {}, session => runCanvas(session, 'create_layers', {parent: null, layers: [{id: 'x', type: 'TEXT', width: 10, height: 10, text: {characters: 'see https://evil.example'}}]})),
    (error: unknown) => error instanceof ToolError && error.code === 'refused' && /URL/.test(error.message),
    'the check refuses links in a layer',
  );
});

test('should save colour styles and add a page in one change each', async () => {
  const doc = screenFile();
  const styled = await run(doc, {}, session => runCanvas(session, 'add_color_styles', {group: 'Brand', colors: [{name: 'Primary', color: '#0D99FF'}]}));
  assert.deepEqual(Object.values(styled.after.styles).map(style => style.name), ['Brand/Primary']);
  assert.ok(styled.patch?.styles);
});

test('should put a picture into a layer or as a new layer, with its record, as one change', async () => {
  const doc = screenFile();
  const picture = {ref: 'pic1', asset: {url: '/uploads/pic1.png', width: 1024, height: 768}};
  const into = await changeDocument(doc, {near: 'box'}, session => placePicture(session, picture, 'box', 'Photo'), {measurer});
  assert.equal(into.value, 'box');
  assert.deepEqual(into.after.images.pic1, picture.asset);
  assert.ok(into.after.nodes.box!.fills.some(paint => paint.type === 'IMAGE' && paint.imageRef === 'pic1'));
  const beside = await changeDocument(doc, {}, session => placePicture(session, picture, undefined, 'Beans'), {measurer});
  const layer = beside.after.nodes[beside.value]!;
  assert.equal(layer.parentId, 'p');
  assert.equal(layer.name, 'Beans');
  assert.deepEqual([layer.x, layer.y], [800, 0], 'beside what stands on the page');
  const gone = await changeDocument(doc, {}, session => placePicture(session, picture, 'p', 'x'), {measurer}).catch(error => error);
  assert.ok(gone instanceof ToolError && gone.code === 'not_found');
});

test('should tell which entries of a kept change were changed again since', () => {
  const doc = screenFile();
  const patch = {nodes: {box: {...doc.nodes.box!, name: 'New'}, made: null}};
  const after = applyPatch(doc, patch);
  // Kept as JSON: undefined fields are gone, key order is the database's.
  const kept = JSON.parse(JSON.stringify(patch));
  assert.deepEqual(changedSince(after, kept), []);
  assert.deepEqual(changedSince(applyPatch(after, {nodes: {box: {...after.nodes.box!, name: 'Theirs'}}}), kept), ['box']);
  assert.deepEqual(changedSince(applyPatch(after, {nodes: {made: {...doc.nodes.box!, id: 'made'}}}), kept), ['made']);
  assert.deepEqual(changedSince(after, {pages: ['other']}), ['the page order']);
});

test('should put new top-level layers in a row right of what is on the page', () => {
  const doc = screenFile();
  assert.deepEqual(pageView(doc, 'p', {width: 320, height: 200}), {x: 800, y: 0, width: 320, height: 200});
  assert.deepEqual(pageView(createDocument('e', 'Empty'), 'e'), {x: 0, y: 0, width: 1440, height: 900});
  const moved = add(createDocument('q', 'Q'), 'FRAME', {id: 'f', parentId: 'q', x: -500, y: 300, width: 10, height: 10});
  assert.deepEqual(pageView(moved, 'q'), {x: -390, y: 300, width: 1440, height: 900});
  assert.deepEqual(layersBox([{id: 'a', width: 100, height: 50, x: 10}, {id: 'b', parent: 'a', width: 999, height: 999}, {id: 'c', width: 20, height: 20, y: 100}]), {width: 110, height: 120});
  assert.equal(layersBox([{id: 'a'}]), undefined);
});

test('should offer the write right and the editing tools only while editing is on', () => {
  withEnv({...ON, ENABLE_MCP_EDITS: undefined}, () => {
    assert.deepEqual(parseScopes(undefined)?.scopes, ['read']);
    assert.deepEqual(parseScopes('read write')?.scopes, ['read'], 'asked, but not offered');
    assert.ok(!currentTools().some(tool => tool.name === 'morfa_create_layers'));
  });
  withEnv(ON, () => {
    assert.deepEqual(parseScopes(undefined)?.scopes, ['read', 'write'], 'no right named: what the server offers');
    assert.deepEqual(parseScopes('offline_access')?.scopes, ['read', 'write']);
    assert.deepEqual(parseScopes('read')?.scopes, ['read'], 'reading only, as asked');
    assert.deepEqual(parseScopes('read write offline_access'), {scopes: ['read', 'write'], offlineAccess: true});
    assert.equal(parseScopes('admin'), undefined);
    const names = currentTools().map(tool => tool.name);
    assert.deepEqual(names, [
      'morfa_list_files',
      'morfa_get_file',
      'morfa_get_layers',
      'morfa_get_code',
      'morfa_get_variables',
      'morfa_show_file',
      'morfa_create_file',
      'morfa_add_page',
      'morfa_create_layers',
      'morfa_update_layers',
      'morfa_delete_layers',
      'morfa_duplicate_layers',
      'morfa_add_color_styles',
      'morfa_place_image',
      'morfa_upload_image',
      'morfa_undo',
    ]);
    assert.ok(!names.includes('morfa_look_at'), 'no render service here');
    const fonts = JSON.stringify(currentTools().find(tool => tool.name === 'morfa_create_layers')!.description);
    assert.ok(fonts.length > 0);
  });
});

/** The scope both sign-in challenges ask for: Claude's 401 header, and the one inside ChatGPT's tool error. */
async function signInScopes(env: Record<string, string | undefined>): Promise<string[]> {
  resetMcpRateLimits();
  const gate = createGate({verify: async () => ({ok: false, failure: 'revoked'}), toolErrorClients: () => ['chatgpt']});
  const call = {method: 'tools/call', id: 7, tool: true};
  const ask = (userAgent: string) => gate({authorization: undefined, userAgent, ip: '203.0.113.7', calls: [call]});
  // The gate answers a request without a credential before its first await: the switches are read while they are set.
  const [claude, chatgpt] = await withEnv(env, () => Promise.all([ask('claude-code/2.0'), ask('Mozilla/5.0 ChatGPT-User')]));
  const header = claude.ok ? undefined : claude.headers['WWW-Authenticate'];
  const inToolError = chatgpt.ok
    ? undefined
    : (chatgpt.body as {result: {_meta: Record<string, string[]>}}).result._meta['mcp/www_authenticate']?.[0];
  return [header, inToolError].map(challenge => /scope="([^"]*)"/.exec(challenge ?? '')?.[1] ?? 'none');
}

test('should ask the sign-in for every right on offer, so a new connection can edit while editing is on', async () => {
  // Hosts ask for the challenge's scope before the metadata's (MCP authorization, scope selection): "read" alone connected read-only.
  assert.deepEqual(await signInScopes(ON), ['read write', 'read write']);
  assert.deepEqual(await signInScopes({...ON, ENABLE_MCP_EDITS: undefined}), ['read', 'read']);
});

test('should describe the editing tools honestly to the client: hints, instructions', async () => {
  await withEnv(ON, async () => {
    const server = buildMcpServer();
    const listed = (
      server as unknown as {_registeredTools: Record<string, {annotations?: Record<string, unknown>; _meta?: Record<string, unknown>}>}
    )._registeredTools;
    assert.deepEqual(listed.morfa_create_layers?._meta?.securitySchemes, [{type: 'oauth2', scopes: ['read', 'write']}]);
    assert.deepEqual(listed.morfa_get_file?._meta?.securitySchemes, [{type: 'oauth2', scopes: ['read']}]);
    assert.equal(listed.morfa_get_file?.annotations?.readOnlyHint, true);
    assert.equal(listed.morfa_create_layers?.annotations?.readOnlyHint, false);
    assert.equal(listed.morfa_create_layers?.annotations?.destructiveHint, false);
    assert.equal(listed.morfa_delete_layers?.annotations?.destructiveHint, true);
    assert.match(EDIT_INSTRUCTIONS, /morfa_undo/);
    assert.doesNotMatch(SERVER_INSTRUCTIONS, /morfa_undo/);
  });
});

test("should change a main component as the editor does: its instances follow", async () => {
  const {doc} = buttonFile();
  const changed = await run(doc, {near: 'lg-icon'}, session =>
    runCanvas(session, 'update_layers', {updates: [{id: session.aliases.input('lg-icon'), name: 'Icon'}]}),
  );
  assert.equal(changed.after.nodes['lg-icon']!.name, 'Icon');
  assert.deepEqual(Object.keys(changed.patch?.nodes ?? {}).sort(), ['b1;lg-icon', 'b3;lg-icon', 'lg-icon'], 'the copies in the instances too');
  assert.equal(changed.after.nodes['b1;lg-icon']!.name, 'Icon');
});
