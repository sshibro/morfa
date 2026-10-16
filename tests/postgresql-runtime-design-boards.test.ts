import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createSticky} from '../shared/design/board/create';
import type {DesignDocument, SceneNode} from '../shared/design/types';

// "Board" (docs/board.md §File kind) through the whole app on the real PostgreSQL schema: a board is a file of its own kind, kept by
// copies and versions, with its document marked as a board's and its objects stored as they are; a board counts as a file.

type Account = {id: string; token: string};
type Answer = {status: number; data: any};
type Summary = {id: string; name: string; version: number; kind?: string};

test('"Board": boards are files of their own kind', {timeout: 600000}, async t => {
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
    const id = `board:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Facilitator','')", [id, randomUUID() + '@example.invalid']);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token};
  }
  const call = async (who: Account, suffix: string, init: RequestInit & {json?: unknown} = {}): Promise<Answer> => {
    const {json, ...rest} = init;
    const headers: Record<string, string> = {cookie: auth.authCookieName('session') + '=' + who.token, ...(json !== undefined ? {'content-type': 'application/json'} : {})};
    const response = await fetch(base + '/api/design-files' + suffix, {...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const text = await response.text();
    return {status: response.status, data: text ? JSON.parse(text) : null};
  };
  const create = async (who: Account, body: Record<string, unknown> = {}): Promise<Summary> => {
    const answer = await call(who, '', {method: 'POST', json: body});
    assert.equal(answer.status, 201, JSON.stringify(answer.data));
    return answer.data.file;
  };
  const open = async (who: Account, id: string) => (await call(who, '/' + id)).data as {file: Summary; document: DesignDocument};

  await t.test('a board is made, listed, opened and copied as a board; a design file stays one', async () => {
    const a = await account('kinds');
    const board = await create(a, {kind: 'board'});
    assert.equal(board.kind, 'board');
    assert.equal(board.name, 'Untitled board');
    const design = await create(a);
    assert.equal(design.kind, 'design');
    assert.equal(design.name, 'Untitled');
    assert.equal((await call(a, '', {method: 'POST', json: {kind: 'whiteboard'}})).status, 400);

    const opened = await open(a, board.id);
    assert.equal(opened.file.kind, 'board');
    assert.equal(opened.document.board, true, 'the board\'s document is marked as one');
    assert.equal((await open(a, design.id)).document.board, undefined);
    const listed = (await call(a, '')).data.files as Summary[];
    assert.deepEqual(Object.fromEntries(listed.map(file => [file.id, file.kind])), {[board.id]: 'board', [design.id]: 'design'});

    const copy = (await call(a, `/${board.id}/duplicate`, {method: 'POST'})).data.file as Summary;
    assert.equal(copy.kind, 'board');
    assert.equal(copy.name, 'Untitled board (copy)');
    // The free plan holds 3 files (2026-10-10): the copy goes to the trash to make room for one more.
    assert.equal((await call(a, '/' + copy.id, {method: 'DELETE'})).status, 200);
    // A board made from a document the client built (a template) is marked as a board's too.
    const fromTemplate = await create(a, {kind: 'board', name: 'Retro', document: {...opened.document, board: undefined}});
    assert.equal((await open(a, fromTemplate.id)).document.board, true);
  });

  await t.test('board objects are stored as they are; a version\'s copy of a board is a board', async () => {
    const a = await account('objects');
    const board = await create(a, {kind: 'board'});
    const {document} = await open(a, board.id);
    const pageId = document.pages[0];
    let serial = 0;
    const sticky = createSticky(() => 'st' + ++serial, {x: 40, y: 40, text: 'First idea', color: 'green', author: 'Facilitator', showAuthor: true});
    const nodes: Record<string, SceneNode> = {};
    for (const [i, piece] of sticky.pieces.entries()) nodes[piece.node.id] = {...piece.node, parentId: i === 0 ? pageId : piece.parent, ...(piece.node.children ? {children: sticky.pieces.filter(p => p.parent === piece.node.id).map(p => p.node.id)} : {})};
    const page = document.nodes[pageId];
    const saved = await call(a, `/${board.id}/document`, {method: 'PATCH', json: {baseVersion: board.version, patch: {nodes: {...nodes, [pageId]: {...page, children: [...page.children!, sticky.id]}}}}});
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const stored = (await open(a, board.id)).document;
    assert.deepEqual(stored.nodes[sticky.id].board, {kind: 'sticky'});
    assert.deepEqual(stored.nodes[sticky.pieces[1].node.id].board, {kind: 'part', part: 'text'});
    // A board field the schema does not know is refused, not stored.
    const bad = await call(a, `/${board.id}/document`, {method: 'PATCH', json: {baseVersion: saved.data.version, patch: {nodes: {[sticky.id]: {...stored.nodes[sticky.id], board: {kind: 'sticky-note'}}}}}});
    assert.equal(bad.status, 400);
    assert.equal(bad.data.nodeId, sticky.id);

    const version = await call(a, `/${board.id}/versions`, {method: 'POST', json: {label: 'After the brainstorm'}});
    assert.equal(version.status, 201, JSON.stringify(version.data));
    const versions = (await call(a, `/${board.id}/versions`)).data.versions as {id: string; label: string | null}[];
    const named = versions.find(entry => entry.label === 'After the brainstorm')!;
    const copy = await call(a, `/${board.id}/versions/${named.id}/duplicate`, {method: 'POST', json: {}});
    assert.equal(copy.status, 201, JSON.stringify(copy.data));
    assert.equal(copy.data.file.kind, 'board');
  });
});
