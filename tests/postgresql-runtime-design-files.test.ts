import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {request, type IncomingMessage, type Server} from 'node:http';
import sharp from 'sharp';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createNode} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';
import {DESIGN_DOCUMENT_CAPS, DESIGN_LIMITS} from '../shared/design/limits';

// "Morfa Design" files API (docs/design-tool.md §Server API) against the real PostgreSQL schema, through the whole app:
// the Origin guard, the session and account header, the app's body readers, /uploads serving and /api/config.

type Account = {id: string; token: string};
type Answer = {status: number; data: any; type: string | null};

const png = (width: number, height: number) =>
  sharp({create: {width, height, channels: 4, background: {r: 200, g: 40, b: 90, alpha: 1}}}).png().toBuffer();

test('"Morfa Design" files: storage, isolation, versions, pictures and the trash', {timeout: 600000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const saved = {ENABLE_DESIGN_TOOL: process.env.ENABLE_DESIGN_TOOL, DESIGN_TOOL_ACCOUNTS: process.env.DESIGN_TOOL_ACCOUNTS, APP_ORIGIN: process.env.APP_ORIGIN};
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  process.env.ENABLE_DESIGN_TOOL = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const {sweepDesignTrash} = await import('../server/design/lifecycle');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
  });

  async function account(label: string): Promise<Account> {
    const id = `design:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token};
  }
  const cookie = (who: Account) => auth.authCookieName('session') + '=' + who.token;
  async function fetchAs(who: Account | null, url: string, init: RequestInit & {json?: unknown} = {}): Promise<Answer> {
    const {json, ...rest} = init;
    const headers: Record<string, string> = {...(who ? {cookie: cookie(who)} : {}), ...(json !== undefined ? {'content-type': 'application/json'} : {}), ...(rest.headers as Record<string, string>)};
    const response = await fetch(base + url, {...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const type = response.headers.get('content-type');
    const raw = Buffer.from(await response.arrayBuffer());
    let data: any = raw;
    if (type?.includes('json')) data = JSON.parse(raw.toString('utf8'));
    return {status: response.status, data, type};
  }
  const call = (who: Account | null, suffix: string, init: RequestInit & {json?: unknown} = {}) => fetchAs(who, '/api/design-files' + suffix, init);
  const create = async (who: Account, body: Record<string, unknown> = {}) => {
    const answer = await call(who, '', {method: 'POST', json: body});
    assert.ok(answer.status === 201 || answer.status === 200, JSON.stringify(answer.data));
    return answer.data.file as {id: string; name: string; version: number; thumbnailUrl: string | null; trashedAt: string | null};
  };
  const open = async (who: Account, id: string) => {
    const answer = await call(who, '/' + id);
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    return answer.data as {file: {version: number; name: string}; document: DesignDocument};
  };
  /** A patch adding a rectangle (optionally with a picture fill) on the first page. */
  const addRectangle = (doc: DesignDocument, id: string, picture?: {ref: string; asset: {url: string; width: number; height: number}}) => {
    const pageId = doc.pages[0],
      page = doc.nodes[pageId];
    const rect = createNode('RECTANGLE', {id, parentId: pageId, x: 10, y: 10, width: 200, height: 100});
    if (picture) rect.fills = [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}];
    return {
      nodes: {[id]: rect, [pageId]: {...page, children: [...page.children!, id]}},
      ...(picture ? {images: {[picture.ref]: picture.asset}} : {}),
    };
  };
  const patchDoc = (who: Account, id: string, baseVersion: number, patch: unknown, extra: Record<string, unknown> = {}) =>
    call(who, `/${id}/document`, {method: 'PATCH', json: {baseVersion, patch, ...extra}});
  const upload = async (who: Account, id: string, data: Buffer, name = 'Photo.png', type = 'image/png') => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], {type}), name);
    return call(who, `/${id}/images`, {method: 'POST', body: form});
  };
  const uploadsDir = path.join(f.dataDir, 'uploads');

  await t.test('the flag: off, nothing answers and /api/config says no; a rollout list names who gets it', async () => {
    const a = await account('flag');
    process.env.ENABLE_DESIGN_TOOL = '0';
    try {
      for (const who of [a, null]) {
        const answer = await call(who, '');
        assert.equal(answer.status, 404);
        assert.equal(answer.data.code, 'design_unavailable');
      }
      assert.equal((await fetchAs(a, '/api/config')).data.designTool, false);
    } finally {
      process.env.ENABLE_DESIGN_TOOL = '1';
    }
    process.env.DESIGN_TOOL_ACCOUNTS = 'someone-else@example.invalid';
    try {
      assert.equal((await call(a, '')).data.code, 'design_unavailable');
      assert.equal((await fetchAs(a, '/api/config')).data.designTool, false);
      process.env.DESIGN_TOOL_ACCOUNTS = 'someone-else@example.invalid, ' + a.id;
      assert.equal((await call(a, '')).status, 200);
    } finally {
      delete process.env.DESIGN_TOOL_ACCOUNTS;
    }
    assert.equal((await fetchAs(a, '/api/config')).data.designTool, true);
    assert.equal((await fetchAs(null, '/api/config')).data.designTool, false);
    assert.equal((await call(null, '')).status, 401);
  });

  await t.test('create, list, open, rename, duplicate, trash, restore and erase', async () => {
    const a = await account('crud');
    const file = await create(a);
    assert.equal(file.name, 'Untitled');
    assert.equal(file.version, 1);
    const opened = await open(a, file.id);
    assert.equal(opened.document.pages.length, 1);
    assert.equal(opened.document.nodes[opened.document.pages[0]].type, 'PAGE');
    const listed = await call(a, '');
    assert.deepEqual(listed.data.files.map((row: {id: string}) => row.id), [file.id]);
    assert.deepEqual(listed.data.usage, {files: 1, storageBytes: 0});
    assert.deepEqual(listed.data.limits, DESIGN_LIMITS);

    const renamed = await call(a, '/' + file.id, {method: 'PATCH', json: {name: '  Landing\u0000 page  '}});
    assert.equal(renamed.data.file.name, 'Landing  page');
    assert.equal((await call(a, '/' + file.id, {method: 'PATCH', json: {name: '   '}})).status, 400);
    const copy = await call(a, `/${file.id}/duplicate`, {method: 'POST'});
    assert.equal(copy.status, 201);
    assert.equal(copy.data.file.name, 'Landing  page (copy)');
    assert.deepEqual((await open(a, copy.data.file.id)).document, opened.document);

    assert.equal((await call(a, '/' + file.id, {method: 'DELETE'})).status, 200);
    assert.deepEqual((await call(a, '')).data.files.map((row: {id: string}) => row.id), [copy.data.file.id]);
    const trash = await call(a, '?trash=1');
    assert.deepEqual(trash.data.files.map((row: {id: string}) => row.id), [file.id]);
    assert.ok(trash.data.files[0].trashedAt);
    assert.equal((await patchDoc(a, file.id, 1, {})).status, 404, 'a file in the trash is not edited');
    assert.equal((await open(a, file.id)).file.name, 'Landing  page', 'but it can be looked at');
    const restored = await call(a, `/${file.id}/restore`, {method: 'POST'});
    assert.equal(restored.data.file.trashedAt, null);
    assert.equal((await call(a, `/${file.id}?permanent=1`, {method: 'DELETE'})).status, 200);
    assert.equal((await call(a, '/' + file.id)).status, 404);
    assert.equal((await db.one<{n: number}>('SELECT count(*) AS n FROM design_file_versions WHERE file_id=$1', [file.id]))!.n, 0);
  });

  await t.test('a retried create with the same client key makes one file', async () => {
    const a = await account('retry'),
      clientId = randomUUID();
    const first = await call(a, '', {method: 'POST', json: {name: 'Mockup', clientId}});
    const second = await call(a, '', {method: 'POST', json: {name: 'Mockup', clientId}});
    assert.deepEqual([first.status, second.status], [201, 200]);
    assert.equal(first.data.file.id, second.data.file.id);
    assert.equal((await call(a, '')).data.files.length, 1);
    assert.equal((await call(a, '', {method: 'POST', json: {clientId: 'short'}})).status, 400);
  });

  await t.test("another account's file is 404 on every route, and the session guards hold", async () => {
    const a = await account('owner'),
      b = await account('stranger');
    const file = await create(a, {name: 'Foreign'});
    const pictures = await upload(a, file.id, await png(40, 40));
    assert.equal(pictures.status, 200, JSON.stringify(pictures.data));
    const version = await call(a, `/${file.id}/versions`, {method: 'POST', json: {label: 'v1'}});
    const versionId = version.data.version.id;
    const routes: [string, RequestInit & {json?: unknown}][] = [
      ['/' + file.id, {}],
      [`/${file.id}/document`, {method: 'PATCH', json: {baseVersion: 1, patch: {}}}],
      [`/${file.id}/document`, {method: 'PUT', json: {baseVersion: 1, document: (await open(a, file.id)).document}}],
      ['/' + file.id, {method: 'PATCH', json: {name: 'Mine'}}],
      [`/${file.id}/duplicate`, {method: 'POST'}],
      ['/' + file.id, {method: 'DELETE'}],
      [`/${file.id}?permanent=1`, {method: 'DELETE'}],
      [`/${file.id}/restore`, {method: 'POST'}],
      [`/${file.id}/thumbnail`, {method: 'PUT', body: new Uint8Array(await png(10, 10)), headers: {'content-type': 'image/png'}}],
      [`/${file.id}/versions`, {}],
      [`/${file.id}/versions`, {method: 'POST', json: {label: 'foreign'}}],
      [`/${file.id}/versions/${versionId}`, {}],
      [`/${file.id}/versions/${versionId}/restore`, {method: 'POST', json: {baseVersion: 1}}],
      [`/${file.id}/versions/${versionId}/duplicate`, {method: 'POST', json: {}}],
      [`/${file.id}/versions/${versionId}`, {method: 'PATCH', json: {label: 'foreign'}}],
    ];
    for (const [suffix, init] of routes) {
      const answer = await call(b, suffix, init);
      assert.equal(answer.status, 404, `${init.method ?? 'GET'} ${suffix}: ${JSON.stringify(answer.data)}`);
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await png(10, 10))], {type: 'image/png'}), 'x.png');
    assert.equal((await call(b, `/${file.id}/images`, {method: 'POST', body: form})).status, 404);
    assert.equal((await call(b, '/not-a-uuid')).status, 404);
    assert.deepEqual((await call(b, '')).data.files, []);
    assert.equal((await fetchAs(b, pictures.data.asset.url)).status, 404, 'the picture is served to its owner only');
    assert.equal((await fetchAs(a, pictures.data.asset.url)).status, 200);
    // The account header of another tab, no session, and a write from another origin.
    assert.equal((await call(a, '', {headers: {'x-forma-account': b.id}})).status, 409);
    assert.equal((await call(null, '/' + file.id)).status, 401);
    assert.equal((await call(a, '', {method: 'POST', json: {}, headers: {origin: 'https://evil.example'}})).status, 403);
    assert.equal((await call(a, '', {method: 'POST', json: {}, headers: {'sec-fetch-site': 'cross-site'}})).status, 403);
    assert.equal((await db.one<{n: number}>('SELECT count(*) AS n FROM design_files WHERE user_id=$1', [a.id]))!.n, 1);
  });

  await t.test('autosave patches apply on their version; a stale version is 409 with the current one', async () => {
    const a = await account('patch');
    const file = await create(a);
    const {document} = await open(a, file.id);
    const first = await patchDoc(a, file.id, 1, addRectangle(document, 'r1'), {before: {r1: null}});
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.version, 2);
    assert.ok(first.data.updatedAt);
    const reopened = await open(a, file.id);
    assert.equal(reopened.file.version, 2);
    assert.equal(reopened.document.nodes.r1.type, 'RECTANGLE');
    const stale = await patchDoc(a, file.id, 1, addRectangle(document, 'r2'));
    assert.equal(stale.status, 409);
    assert.deepEqual([stale.data.code, stale.data.currentVersion], ['version_conflict', 2]);
    // An orphan node, an unsafe link, a broken page order: refused with a path, nothing stored.
    const orphan = await patchDoc(a, file.id, 2, {nodes: {r3: createNode('RECTANGLE', {id: 'r3', parentId: reopened.document.pages[0]})}});
    assert.equal(orphan.status, 400);
    assert.equal(orphan.data.code, 'design_document_invalid');
    assert.match(orphan.data.path, /nodes\./);
    // Every refusal names the entry the editor puts back (autosave recovery): the layer, also as `nodeId`.
    assert.deepEqual([orphan.data.entry, orphan.data.nodeId], [{table: 'nodes', key: 'r3'}, 'r3']);
    const rect = {...reopened.document.nodes.r1, reactions: [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'javascript:alert(1)', openInNewTab: true}]}]};
    const unsafe = await patchDoc(a, file.id, 2, {nodes: {r1: rect}});
    assert.equal(unsafe.data.code, 'design_document_invalid');
    assert.deepEqual([unsafe.data.path, unsafe.data.entry, unsafe.data.nodeId], ['nodes.r1.reactions.0.actions.0.url', {table: 'nodes', key: 'r1'}, 'r1']);
    // The client's `before` copy is not the patch: its refusal names no entry to put back.
    const before = await patchDoc(a, file.id, 2, addRectangle(reopened.document, 'r4'), {before: {r4: {bad: true}}});
    assert.equal(before.status, 400);
    assert.match(before.data.path, /^before\.nodes\.r4/);
    assert.equal(before.data.entry, undefined);
    const pages = await patchDoc(a, file.id, 2, {pages: []});
    assert.deepEqual([pages.status, pages.data.entry], [400, {table: 'pages', key: null}]);
    assert.equal((await patchDoc(a, file.id, 2, 'nonsense')).status, 400);
    assert.equal((await open(a, file.id)).file.version, 2);
    // An empty patch changes nothing.
    assert.deepEqual((await patchDoc(a, file.id, 2, {})).data.version, 2);
    // PUT replaces the whole document, validated in full.
    const replaced = await call(a, `/${file.id}/document`, {method: 'PUT', json: {baseVersion: 2, document}});
    assert.equal(replaced.data.version, 3);
    assert.equal((await open(a, file.id)).document.nodes.r1, undefined);
    assert.equal((await call(a, `/${file.id}/document`, {method: 'PUT', json: {baseVersion: 2, document}})).status, 409);
    const broken = structuredClone(document);
    broken.nodes[broken.pages[0]].children = ['ghost'];
    const refused = await call(a, `/${file.id}/document`, {method: 'PUT', json: {baseVersion: 3, document: broken}});
    assert.equal(refused.data.code, 'design_document_invalid');
    // PUT answers in the same shape as PATCH.
    assert.deepEqual([refused.data.path, refused.data.entry, refused.data.nodeId], [`nodes.${broken.pages[0]}.children.0`, {table: 'nodes', key: broken.pages[0]}, broken.pages[0]]);
    const badLink = structuredClone(document);
    badLink.nodes.r9 = {...createNode('RECTANGLE', {id: 'r9', parentId: badLink.pages[0]}), opacity: 4};
    badLink.nodes[badLink.pages[0]].children = ['r9'];
    const whole = await call(a, `/${file.id}/document`, {method: 'PUT', json: {baseVersion: 3, document: badLink}});
    assert.deepEqual([whole.status, whole.data.path, whole.data.nodeId], [400, 'nodes.r9.opacity', 'r9']);
    // A body over the patch cap is refused before it is parsed.
    const huge = await patchDoc(a, file.id, 3, {nodes: {}}, {padding: 'x'.repeat(8 * 1024 * 1024 + 10)});
    assert.equal(huge.status, 413);
    assert.equal(huge.data.code, 'design_document_too_large');
  });

  await t.test('a warm open (?have=): the file and access without the document only while the file is at that version', async () => {
    const a = await account('have');
    const other = await account('have-other');
    const file = await create(a);
    const {document} = await open(a, file.id);
    const current = await call(a, `/${file.id}?have=${file.version}`);
    assert.equal(current.status, 200, JSON.stringify(current.data));
    assert.equal(current.data.current, true);
    assert.equal(current.data.document, undefined);
    assert.equal(current.data.file.version, file.version);
    assert.equal(current.data.access.canEdit, true);
    // Saved since: the whole file, the same as a plain open.
    assert.equal((await patchDoc(a, file.id, file.version, addRectangle(document, 'h1'), {before: {h1: null}})).status, 200);
    const behind = await call(a, `/${file.id}?have=${file.version}`);
    const plain = await open(a, file.id);
    assert.equal(behind.data.current, undefined);
    assert.deepEqual(behind.data.document, plain.document);
    assert.equal(behind.data.file.version, file.version + 1);
    assert.equal(behind.data.document.nodes.h1.type, 'RECTANGLE');
    assert.equal((await call(a, `/${file.id}?have=${file.version + 1}`)).data.current, true);
    // Ahead of the server, or not a version: the whole file.
    assert.deepEqual((await call(a, `/${file.id}?have=${file.version + 9}`)).data.document, plain.document);
    assert.deepEqual((await call(a, `/${file.id}?have=1e3`)).data.document, plain.document);
    // Another account learns nothing from `have`.
    assert.equal((await call(other, `/${file.id}?have=${file.version + 1}`)).status, 404);
  });
  await t.test('the big-files switch (DESIGN_BIG_FILES): a document past the fixed cap is refused, then accepted', async () => {
    const a = await account('bigfiles');
    const big = (await open(a, (await create(a)).id)).document;
    const pageId = big.pages[0];
    const children = [...big.nodes[pageId].children!];
    for (let i = 0; i < DESIGN_DOCUMENT_CAPS.nodes; i++) {
      const id = 'b' + i;
      big.nodes[id] = createNode('RECTANGLE', {id, parentId: pageId, x: i % 1000, y: Math.floor(i / 1000), width: 1, height: 1});
      children.push(id);
    }
    big.nodes[pageId] = {...big.nodes[pageId], children};
    const body = JSON.stringify({name: 'Large', document: big});
    assert.ok(body.length > DESIGN_DOCUMENT_CAPS.bytes, `a 50 001-layer document is past the 20 MB cap (${body.length} bytes)`);
    const saved = process.env.DESIGN_BIG_FILES;
    try {
      delete process.env.DESIGN_BIG_FILES;
      const fixed = await call(a, '', {method: 'POST', body, headers: {'Content-Type': 'application/json'}});
      assert.equal(fixed.status, 413, JSON.stringify(fixed.data).slice(0, 200));
      assert.equal(fixed.data.code, 'design_document_too_large');
      process.env.DESIGN_BIG_FILES = '1';
      const accepted = await call(a, '', {method: 'POST', body, headers: {'Content-Type': 'application/json'}});
      assert.equal(accepted.status, 201, JSON.stringify(accepted.data).slice(0, 200));
      const file = accepted.data.file as {id: string; version: number};
      const reopened = await open(a, file.id);
      assert.equal(Object.keys(reopened.document.nodes).length, DESIGN_DOCUMENT_CAPS.nodes + 1);
      const row = await db.one<{node_count: number; bytes: string}>('SELECT node_count, bytes FROM design_files WHERE id=$1', [file.id]);
      assert.equal(Number(row!.node_count), DESIGN_DOCUMENT_CAPS.nodes + 1);
      // An autosave on it is accepted too (the patch check counts the layers against the caps in force).
      const more = await patchDoc(a, file.id, file.version, addRectangle(reopened.document, 'b_more'));
      assert.equal(more.status, 200, JSON.stringify(more.data).slice(0, 200));
      // Pages on demand (docs/decisions/big-files.md §3): the skeleton is the page nodes and the tables, a page comes on its own.
      const skeleton = await call(a, `/${file.id}?pages=skeleton`);
      assert.equal(skeleton.status, 200, JSON.stringify(skeleton.data).slice(0, 200));
      assert.deepEqual(Object.keys(skeleton.data.document.nodes), [pageId], 'page nodes only');
      const layers = Object.keys(reopened.document.nodes).length; // the page's layers after b_more (the page node itself is not one)
      assert.equal(skeleton.data.document.nodes[pageId].children.length, layers, 'the page keeps its list of layers');
      assert.deepEqual(skeleton.data.partial, {loaded: [], layers: {[pageId]: layers}});
      assert.equal(skeleton.data.file.version, more.data.version);
      const page = await call(a, `/${file.id}/pages/${pageId}`);
      assert.equal(page.status, 200, JSON.stringify(page.data).slice(0, 200));
      assert.equal(page.data.version, more.data.version);
      assert.equal(Object.keys(page.data.nodes).length, layers);
      assert.equal(page.data.nodes[pageId], undefined, 'the page node itself is the skeleton’s');
      const nowhere = await call(a, `/${file.id}/pages/nowhere`);
      assert.deepEqual([nowhere.status, nowhere.data.code], [404, 'page_not_found'], 'a page the server does not know (the editor loads one it made itself empty)');
      // A file the fixed caps hold answers `whole: 'small'` (opened as with big files off), unless the caller asks for pages.
      const small = await create(a);
      const smallSkeleton = await call(a, `/${small.id}?pages=skeleton`);
      assert.deepEqual([smallSkeleton.data.whole, smallSkeleton.data.document], ['small', undefined]);
      assert.ok((await call(a, `/${small.id}?pages=skeleton&always=1`)).data.partial, 'always=1: the skeleton');
      assert.equal((await call(a, `/${file.id}/pages/b_more`)).status, 404, 'a layer is not a page');
      // A file this process would not keep parsed (over half the parsed-copy budget; a 400 MB page) is not parsed for its
      // skeleton: the answer says `whole`, the editor reads GET /:id, which sends the stored text (lane O).
      const budget = process.env.DESIGN_DOCUMENT_CACHE_BYTES;
      const {forgetDocument} = await import('../server/design/document-cache');
      try {
        process.env.DESIGN_DOCUMENT_CACHE_BYTES = String(Number(row!.bytes));
        forgetDocument(file.id);
        const whole = await call(a, `/${file.id}?pages=skeleton`);
        assert.equal(whole.status, 200, JSON.stringify(whole.data).slice(0, 200));
        assert.deepEqual([whole.data.whole, whole.data.document, whole.data.partial, whole.data.file.version], ['big', undefined, undefined, more.data.version]);
        assert.equal(whole.data.access.canEdit, true);
        assert.equal(Object.keys((await open(a, file.id)).document.nodes).length, layers + 1, 'and the whole read opens it');
        assert.equal((await call(await account('bigfiles-other'), `/${file.id}?pages=skeleton`)).status, 404, 'another account learns nothing');
      } finally {
        if (budget === undefined) delete process.env.DESIGN_DOCUMENT_CACHE_BYTES;
        else process.env.DESIGN_DOCUMENT_CACHE_BYTES = budget;
      }
      // With the switch off again the file still opens (reading never checks the caps), but a save that grows it is refused.
      delete process.env.DESIGN_BIG_FILES;
      assert.equal((await open(a, file.id)).file.version, more.data.version);
      const refused = await patchDoc(a, file.id, more.data.version, addRectangle((await open(a, file.id)).document, 'b_refused'));
      assert.equal(refused.status, 400);
      // The page's list of layers trips the cap first (as the fixed list cap did before SQL013), else the count of layers does.
      assert.match(refused.data.error, /[\d,]+ layers, the limit is 50,000\./);
    } finally {
      if (saved === undefined) delete process.env.DESIGN_BIG_FILES;
      else process.env.DESIGN_BIG_FILES = saved;
    }
  });

  await t.test('versions: one automatic copy per 10 minutes of editing, named versions, read and restore', async () => {
    const a = await account('versions');
    const file = await create(a);
    let {document} = await open(a, file.id);
    const count = async () => (await db.one<{n: number}>('SELECT count(*) AS n FROM design_file_versions WHERE file_id=$1', [file.id]))!.n;
    assert.equal((await patchDoc(a, file.id, 1, addRectangle(document, 'a1'))).status, 200);
    assert.equal(await count(), 1, 'the first save keeps the document it replaced');
    document = (await open(a, file.id)).document;
    assert.equal((await patchDoc(a, file.id, 2, addRectangle(document, 'a2'))).status, 200);
    assert.equal(await count(), 1, 'within 10 minutes no second copy');
    await db.execute("UPDATE design_files SET auto_version_at=clock_timestamp()-interval '11 minutes' WHERE id=$1", [file.id]);
    document = (await open(a, file.id)).document;
    assert.equal((await patchDoc(a, file.id, 3, addRectangle(document, 'a3'))).status, 200);
    assert.equal(await count(), 2);
    const named = await call(a, `/${file.id}/versions`, {method: 'POST', json: {label: 'Before the client edits'}});
    assert.equal(named.status, 201);
    assert.deepEqual([named.data.version.label, named.data.version.version], ['Before the client edits', 4]);
    const list = await call(a, `/${file.id}/versions`);
    assert.deepEqual(list.data.versions.map((v: {version: number; label: string | null}) => [v.version, v.label]), [[4, 'Before the client edits'], [3, null], [1, null]]);
    const first = list.data.versions.find((v: {version: number}) => v.version === 1);
    const read = await call(a, `/${file.id}/versions/${first.id}`);
    assert.deepEqual(Object.keys(read.data.document.nodes).sort(), [read.data.document.pages[0]]);
    // "Duplicate" of a version: a new file in the same place holding the version's document; the file stays.
    const copy = await call(a, `/${file.id}/versions/${first.id}/duplicate`, {method: 'POST', json: {name: 'First version'}});
    assert.equal(copy.status, 201, JSON.stringify(copy.data));
    assert.equal(copy.data.file.name, 'First version');
    assert.notEqual(copy.data.file.id, file.id);
    assert.deepEqual((await open(a, copy.data.file.id)).document, read.data.document);
    assert.equal((await open(a, file.id)).document.pages.length, 1);
    const unnamed = await call(a, `/${file.id}/versions/${first.id}/duplicate`, {method: 'POST', json: {}});
    assert.equal(unnamed.status, 201, JSON.stringify(unnamed.data));
    assert.match(unnamed.data.file.name, / \(copy\)$/);
    assert.equal((await call(a, `/${file.id}/versions/${randomUUID()}/duplicate`, {method: 'POST', json: {}})).status, 404);
    for (const id of [copy.data.file.id, unnamed.data.file.id]) await call(a, `/${id}?permanent=1`, {method: 'DELETE'});
    // "Edit name": a named version takes the new label; an automatic one named this way becomes a named one.
    const renamed = await call(a, `/${file.id}/versions/${named.data.version.id}`, {method: 'PATCH', json: {label: 'Before the customer edits'}});
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    assert.equal(renamed.data.version.label, 'Before the customer edits');
    const auto = list.data.versions.find((v: {version: number}) => v.version === 3);
    assert.equal((await call(a, `/${file.id}/versions/${auto.id}`, {method: 'PATCH', json: {label: 'Approved'}})).data.version.label, 'Approved');
    assert.equal((await call(a, `/${file.id}/versions/${auto.id}`, {method: 'PATCH', json: {label: '   '}})).status, 400);
    assert.equal((await call(a, `/${file.id}/versions/${randomUUID()}`, {method: 'PATCH', json: {label: 'No such'}})).status, 404);
    await db.execute('UPDATE design_file_versions SET label=NULL WHERE id=$1', [auto.id]);
    await db.execute('UPDATE design_file_versions SET label=$1 WHERE id=$2', ['Before the client edits', named.data.version.id]);
    const restored = await call(a, `/${file.id}/versions/${first.id}/restore`, {method: 'POST', json: {baseVersion: 4}});
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.version, 5);
    assert.deepEqual((await open(a, file.id)).document, read.data.document);
    assert.equal(await count(), 4, 'the document before a restore is kept too');
    assert.equal((await call(a, `/${file.id}/versions/${first.id}/restore`, {method: 'POST', json: {baseVersion: 4}})).data.code, 'version_conflict');
    assert.equal((await call(a, `/${file.id}/versions/${randomUUID()}`)).status, 404);
    // History older than the history days is pruned when a new copy is taken; a named version stays.
    await db.execute('UPDATE design_file_versions SET created_at=clock_timestamp()-make_interval(days=>$2::int) WHERE file_id=$1', [file.id, DESIGN_LIMITS.historyDays + 10]);
    await db.execute("UPDATE design_files SET auto_version_at=NULL WHERE id=$1", [file.id]);
    document = (await open(a, file.id)).document;
    assert.equal((await patchDoc(a, file.id, 5, addRectangle(document, 'a4'))).status, 200);
    const kept = await db.many<{label: string | null; version: number}>('SELECT label,version FROM design_file_versions WHERE file_id=$1 ORDER BY version', [file.id]);
    assert.deepEqual(kept.map(row => [row.version, row.label]), [[4, 'Before the client edits'], [5, null]]);
  });

  await t.test('parallel reads of a document are gated: four per account at a time', async () => {
    // Each read holds the stored text and the answer built from it until the client takes it (about 20 MB each for
    // a large file); 40 readers that read nothing added 790 MB to the process, a few hundred would exhaust it.
    const a = await account('readers');
    const file = await create(a);
    const {document} = await open(a, file.id);
    const pageId = document.pages[0];
    const texts = Array.from({length: 40}, (_, i) => {
      const node = createNode('TEXT', {id: 'r' + i, parentId: pageId});
      // Cyrillic on purpose: two bytes per character in memory and on the wire.
      node.text = {...node.text!, characters: 'Ж'.repeat(90_000)};
      return node;
    });
    const filled = await patchDoc(a, file.id, 1, {nodes: {...Object.fromEntries(texts.map(node => [node.id, node])), [pageId]: {...document.nodes[pageId], children: texts.map(node => node.id)}}});
    assert.equal(filled.status, 200, JSON.stringify(filled.data));
    const url = new URL(base + '/api/design-files/' + file.id);
    const held: IncomingMessage[] = [];
    const statuses = await Promise.all(Array.from({length: 8}, () => new Promise<number>(resolve => {
      request({host: url.hostname, port: url.port, path: url.pathname, headers: {cookie: cookie(a)}}, res => {
        res.pause();
        held.push(res);
        resolve(res.statusCode ?? 0);
      }).end();
    })));
    try {
      assert.equal(statuses.filter(status => status === 200).length, 4, statuses.join());
      assert.equal(statuses.filter(status => status === 429).length, 4, statuses.join());
    } finally {
      for (const res of held) res.destroy();
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await call(a, '/' + file.id)).status, 200, 'a reader that went away gives its place back');
  });

  await t.test('slow senders hold only their own account\'s places: the server-wide gates are taken once a body is in', async () => {
    // 16 document bodies at a time on the server, 2 per account. Before, the server's place was taken before the body
    // was read, so 8 accounts trickling bodies held every place for the 5-minute body window and nobody else saved.
    const senders = await Promise.all(Array.from({length: 9}, (_, i) => account('slow-' + i)));
    const files = await Promise.all(senders.map(who => create(who)));
    const url = new URL(base + '/api/design-files/');
    const trickling: {req: ReturnType<typeof request>; answer: Promise<{status: number; body: string}>}[] = [];
    const slowPatch = (who: Account, id: string) => {
      let answer!: Promise<{status: number; body: string}>;
      const req = request({host: url.hostname, port: url.port, method: 'PATCH', path: `/api/design-files/${id}/document`, headers: {cookie: cookie(who), 'content-type': 'application/json', 'content-length': '200'}});
      answer = new Promise(resolve => {
        req.on('response', res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => (body += chunk));
          res.on('end', () => resolve({status: res.statusCode ?? 0, body}));
          res.on('error', () => resolve({status: res.statusCode ?? 0, body}));
        });
        req.on('error', () => resolve({status: 0, body: ''}));
      });
      req.flushHeaders();
      req.write('{"baseVersion":1,');
      trickling.push({req, answer});
      return answer;
    };
    const started = Date.now();
    try {
      // Eight accounts, two trickling bodies each: sixteen requests waiting for their bodies.
      for (let i = 0; i < 8; i++) {
        slowPatch(senders[i], files[i].id);
        slowPatch(senders[i], files[i].id);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      // A ninth account saves at once.
      const ninth = senders[8];
      const {document} = await open(ninth, files[8].id);
      const saved = await patchDoc(ninth, files[8].id, 1, addRectangle(document, 'r1'));
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      // The account gate still holds before the body: a third slow request of one account is refused at once.
      const third = await call(senders[0], `/${files[0].id}/document`, {method: 'PATCH', json: {baseVersion: 1, patch: {}}});
      assert.deepEqual([third.status, third.data.code], [429, 'rate_limited']);
      // A body that does not arrive in its window (15 seconds for a small one) is cut with 408.
      const answers = await Promise.all(trickling.map(entry => entry.answer));
      const waited = Date.now() - started;
      assert.ok(answers.every(answer => answer.status === 408), answers.map(answer => answer.status).join());
      assert.match(answers[0].body, /request_timeout/);
      assert.ok(waited >= 14_000 && waited < 30_000, `cut after ${waited} ms`);
      // The places are back.
      assert.equal((await call(senders[0], `/${files[0].id}/document`, {method: 'PATCH', json: {baseVersion: 1, patch: {}}})).status, 200);
    } finally {
      for (const entry of trickling) entry.req.destroy();
    }
  });

  await t.test('whole-document writes have their own allowance: 60 new files, replaces and restores in 10 minutes', async () => {
    // Each parses, checks and serializes a whole document (about 1.5 s of the event loop for 20 MB), a restore for a
    // body of a few bytes: under the autosave allowance alone (one a second) one account kept the API busy.
    const a = await account('whole');
    const file = await create(a);
    const {document} = await open(a, file.id);
    const versions = await call(a, `/${file.id}/versions`, {method: 'POST', json: {label: 'Start'}});
    let version = 1;
    for (let i = 0; i < 58; i++) {
      const replaced = await call(a, `/${file.id}/document`, {method: 'PUT', json: {baseVersion: version, document}});
      assert.equal(replaced.status, 200, `${i}: ${JSON.stringify(replaced.data)}`);
      version = replaced.data.version;
    }
    const restored = await call(a, `/${file.id}/versions/${versions.data.version.id}/restore`, {method: 'POST', json: {baseVersion: version}});
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const refused = await call(a, `/${file.id}/versions/${versions.data.version.id}/restore`, {method: 'POST', json: {baseVersion: restored.data.version}});
    assert.deepEqual([refused.status, refused.data.code], [429, 'rate_limited']);
    assert.equal((await call(a, `/${file.id}/document`, {method: 'PUT', json: {baseVersion: restored.data.version, document}})).status, 429);
    assert.equal((await call(a, '', {method: 'POST', json: {}})).status, 429);
    // Autosave goes on.
    assert.equal((await patchDoc(a, file.id, restored.data.version, addRectangle(document, 'w1'))).status, 200);
  });

  await t.test("an account's files and versions fit one cap: automatic versions give way, copies past it are refused", async () => {
    // A named version, a restore or a copy is a full copy of a document of up to 20 MB made by a request of a few
    // bytes: without a cap one free account filled the database at gigabytes a minute.
    const a = await account('documents');
    const file = await create(a);
    let {document} = await open(a, file.id);
    const pageId = document.pages[0];
    const texts = ['t1', 't2'].map((id, i) => {
      const node = createNode('TEXT', {id, parentId: pageId, y: i * 100});
      node.text = {...node.text!, characters: String(i).repeat(100_000)};
      return node;
    });
    const filled = await patchDoc(a, file.id, 1, {nodes: {t1: texts[0], t2: texts[1], [pageId]: {...document.nodes[pageId], children: ['t1', 't2']}}});
    assert.equal(filled.status, 200, JSON.stringify(filled.data));
    const size = (await db.one<{bytes: number}>('SELECT bytes FROM design_files WHERE id=$1', [file.id]))!.bytes;
    assert.ok(size > 200_000, String(size));
    const used = async () =>
      Number((await db.one<{n: number}>('SELECT (SELECT COALESCE(sum(bytes),0) FROM design_files WHERE user_id=$1)+(SELECT COALESCE(sum(bytes),0) FROM design_file_versions WHERE user_id=$1) AS n', [a.id]))!.n);
    const cap = 5 * size;
    process.env.DESIGN_ACCOUNT_DOCUMENT_BYTES = String(cap);
    try {
      const named = await call(a, `/${file.id}/versions`, {method: 'POST', json: {label: 'Large'}});
      assert.equal(named.status, 201, JSON.stringify(named.data));
      // Restores keep working: the copies they keep are automatic and the oldest give way to the newest.
      let version = 2;
      for (let i = 0; i < 12; i++) {
        const restored = await call(a, `/${file.id}/versions/${named.data.version.id}/restore`, {method: 'POST', json: {baseVersion: version}});
        assert.equal(restored.status, 200, JSON.stringify(restored.data));
        version = restored.data.version;
        assert.ok((await used()) <= cap, `restore ${i}: ${await used()} > ${cap}`);
      }
      // Named versions of the same 200 KB, each a request of a few bytes: refused once files and named versions fill it.
      let refused: Answer | null = null;
      for (let i = 0; i < 20 && !refused; i++) {
        const answer = await call(a, `/${file.id}/versions`, {method: 'POST', json: {label: 'Copy ' + i}});
        if (answer.status !== 201) refused = answer;
      }
      assert.ok(refused, 'twenty named copies of 200 KB fit a cap of 1 MB');
      assert.deepEqual([refused.status, refused.data.code], [413, 'design_documents_limit']);
      assert.match(refused.data.error, /Empty the trash/);
      assert.ok((await used()) <= cap);
      assert.equal((await call(a, `/${file.id}/duplicate`, {method: 'POST'})).data.code, 'design_documents_limit');
      assert.equal((await call(a, '', {method: 'POST', json: {document: (await open(a, file.id)).document}})).data.code, 'design_documents_limit');
      // A restore whose way back no longer fits is refused and changes nothing; a save that does not grow the file goes through.
      const full = await call(a, `/${file.id}/versions/${named.data.version.id}/restore`, {method: 'POST', json: {baseVersion: version}});
      assert.deepEqual([full.status, full.data.code], [413, 'design_documents_limit']);
      document = (await open(a, file.id)).document;
      const shorter = {...document.nodes.t2, text: {...document.nodes.t2.text!, characters: '1'.repeat(99_000)}};
      const saved = await patchDoc(a, file.id, version, {nodes: {t2: shorter}});
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      // Growing past the cap is refused (300 KB more than the room a refused 200 KB copy leaves).
      const more = ['t3', 't4', 't5'].map(id => {
        const node = createNode('TEXT', {id, parentId: pageId});
        node.text = {...node.text!, characters: id.repeat(50_000)};
        return node;
      });
      const grown = await patchDoc(a, file.id, saved.data.version, {nodes: {t3: more[0], t4: more[1], t5: more[2], [pageId]: {...document.nodes[pageId], children: ['t1', 't2', 't3', 't4', 't5']}}});
      assert.deepEqual([grown.status, grown.data.code], [413, 'design_documents_limit']);
      assert.ok((await used()) <= cap);
      // Emptying the trash makes room again.
      assert.equal((await call(a, '/' + file.id + '?permanent=1', {method: 'DELETE'})).status, 200);
      assert.equal(await used(), 0);
      assert.equal((await call(a, '', {method: 'POST', json: {}})).status, 201);
    } finally {
      delete process.env.DESIGN_ACCOUNT_DOCUMENT_BYTES;
    }
  });

  await t.test('pictures: re-encoded, served to the owner, counted against design storage, never in the site library', async () => {
    const a = await account('pictures'),
      b = await account('pictures-other');
    const file = await create(a);
    const big = await upload(a, file.id, await png(5000, 300));
    assert.equal(big.status, 200, JSON.stringify(big.data));
    assert.match(big.data.ref, /^dz-[0-9a-f-]{36}$/);
    assert.equal(big.data.asset.url, '/uploads/' + big.data.ref + '.png');
    assert.deepEqual([big.data.asset.width, big.data.asset.height, big.data.asset.name], [4096, 246, 'Photo.png']);
    const served = await fetchAs(a, big.data.asset.url);
    assert.equal(served.status, 200);
    assert.equal((await sharp(served.data as Buffer).metadata()).width, 4096);
    const photo = await upload(a, file.id, await sharp({create: {width: 800, height: 600, channels: 3, background: '#336699'}}).jpeg().toBuffer(), 'photo.jpg', 'image/jpeg');
    assert.equal(photo.data.asset.url.endsWith('.webp'), true);
    // Refused: not a picture, SVG, a fake type.
    assert.equal((await upload(a, file.id, Buffer.from('hello'), 'a.png')).status, 415);
    assert.equal((await upload(a, file.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg', 'image/svg+xml')).status, 415);
    // Used in the document, it saves; another account cannot point at it.
    const {document} = await open(a, file.id);
    const used = await patchDoc(a, file.id, 1, addRectangle(document, 'pic', big.data));
    assert.equal(used.status, 200, JSON.stringify(used.data));
    const other = await create(b);
    const foreign = await patchDoc(b, other.id, 1, addRectangle((await open(b, other.id)).document, 'pic', big.data));
    assert.equal(foreign.status, 403);
    assert.equal(foreign.data.code, 'design_document_invalid');
    // It names the picture's record, so the editor drops just that and saves the layer.
    assert.deepEqual([foreign.data.path, foreign.data.entry], [`images.${big.data.ref}`, {table: 'images', key: big.data.ref}]);
    // Usage counts design pictures; the site library and its quota never see them.
    const listed = await call(a, '');
    const bytes = (await db.one<{n: number}>('SELECT sum(bytes)::int AS n FROM design_images WHERE user_id=$1', [a.id]))!.n;
    assert.equal(listed.data.usage.storageBytes, bytes);
    assert.equal((await db.one<{n: number}>('SELECT count(*) AS n FROM uploads WHERE user_id=$1', [a.id]))!.n, 0);
    // Over the storage limit: 413 design_storage_limit, and nothing is left behind.
    const filler = DESIGN_LIMITS.storageBytes - bytes - 10,
      rows = Math.ceil(filler / 20_000_000);
    await db.execute(
      "INSERT INTO design_images(filename,user_id,kind,bytes,width,height) SELECT 'dz-filler-'||n||'-'||$3||'.webp',$1,'image',$2::int+CASE WHEN n=1 THEN $4::int ELSE 0 END,1,1 FROM generate_series(1,$5::int) n",
      [a.id, Math.floor(filler / rows), randomUUID(), filler - Math.floor(filler / rows) * rows, rows],
    );
    assert.equal((await call(a, '')).data.usage.storageBytes, DESIGN_LIMITS.storageBytes - 10);
    const full = await upload(a, file.id, await png(64, 64));
    assert.equal(full.status, 413);
    assert.equal(full.data.code, 'design_storage_limit');
    assert.equal((await db.one<{n: number}>("SELECT count(*) AS n FROM design_images WHERE user_id=$1 AND filename NOT LIKE 'dz-filler-%'", [a.id]))!.n, 2);
  });

  await t.test('thumbnails: re-encoded to a small WebP, replaced, served to the owner only', async () => {
    const a = await account('thumbs'),
      b = await account('thumbs-other');
    const file = await create(a);
    const put = (body: Buffer, type = 'image/png') => call(a, `/${file.id}/thumbnail`, {method: 'PUT', body: new Uint8Array(body), headers: {'content-type': type}});
    const first = await put(await png(1600, 900));
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const image = await fetchAs(a, first.data.thumbnailUrl);
    const meta = await sharp(image.data as Buffer).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 480, 270]);
    assert.equal((await fetchAs(b, first.data.thumbnailUrl)).status, 404);
    assert.equal((await call(a, '')).data.files[0].thumbnailUrl, first.data.thumbnailUrl);
    const second = await put(await sharp(await png(300, 300)).webp().toBuffer(), 'image/webp');
    assert.equal(second.status, 200);
    const old = path.basename(first.data.thumbnailUrl);
    assert.equal(existsSync(path.join(uploadsDir, old)), false, 'the replaced thumbnail is gone');
    assert.equal(await db.one('SELECT 1 FROM design_images WHERE filename=$1', [old]), undefined);
    assert.equal((await put(Buffer.from('not an image'))).status, 415);
    assert.equal((await put(Buffer.alloc(600 * 1024, 1))).status, 413);
    assert.equal((await put(await png(10, 10), 'text/plain')).status, 415);
  });

  await t.test('erasing a file takes its thumbnail and the pictures no other file uses', async () => {
    const a = await account('erase');
    const file = await create(a);
    const picture = (await upload(a, file.id, await png(50, 50))).data;
    const saved = await patchDoc(a, file.id, 1, addRectangle((await open(a, file.id)).document, 'p', picture));
    assert.equal(saved.status, 200);
    const unused = (await upload(a, file.id, await png(20, 20))).data;
    const thumb = (await call(a, `/${file.id}/thumbnail`, {method: 'PUT', body: new Uint8Array(await png(100, 100)), headers: {'content-type': 'image/png'}})).data;
    const copy = (await call(a, `/${file.id}/duplicate`, {method: 'POST'})).data.file;
    assert.notEqual(copy.thumbnailUrl, thumb.thumbnailUrl);
    const onDisk = (url: string) => existsSync(path.join(uploadsDir, path.basename(url)));
    assert.equal((await call(a, `/${file.id}?permanent=1`, {method: 'DELETE'})).status, 200);
    assert.equal(onDisk(picture.asset.url), true, 'the copy still uses the picture');
    assert.equal(onDisk(unused.asset.url), false, 'a picture nothing uses goes');
    assert.equal(onDisk(thumb.thumbnailUrl), false);
    assert.equal(onDisk(copy.thumbnailUrl), true);
    assert.equal((await fetchAs(a, picture.asset.url)).status, 200);
    assert.equal((await call(a, `/${copy.id}?permanent=1`, {method: 'DELETE'})).status, 200);
    assert.equal(onDisk(picture.asset.url), false);
    assert.equal((await db.one<{n: number}>('SELECT count(*) AS n FROM design_images WHERE user_id=$1', [a.id]))!.n, 0);
  });

  await t.test('files are not limited in number: an account keeps and adds as many as it likes', async () => {
    const a = await account('many');
    for (let i = 0; i < 6; i++) await create(a, {name: 'File ' + i});
    assert.equal((await call(a, '')).data.usage.files, 6);
  });

  await t.test('the trash sweep erases files kept longer than the trash days', async () => {
    const a = await account('sweep');
    const old = await create(a),
      recent = await create(a);
    for (const file of [old, recent]) assert.equal((await call(a, '/' + file.id, {method: 'DELETE'})).status, 200);
    await db.execute('UPDATE design_files SET trashed_at=clock_timestamp()-make_interval(days=>$2::int) WHERE id=$1', [old.id, DESIGN_LIMITS.trashDays + 1]);
    await db.execute("UPDATE design_files SET trashed_at=clock_timestamp()-interval '10 days' WHERE id=$1", [recent.id]);
    const result = await sweepDesignTrash();
    assert.ok(result.erased >= 1);
    assert.equal(await db.one('SELECT 1 FROM design_files WHERE id=$1', [old.id]), undefined);
    assert.ok(await db.one('SELECT 1 FROM design_files WHERE id=$1', [recent.id]));
  });
});
