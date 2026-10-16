import {existsSync} from 'node:fs';
import {test, expect} from './fixtures';
import type {Page, WebSocket} from '@playwright/test';
import {createDocument, createNode} from '../../shared/design/defaults';

// The cutover of docs/BACKEND.md §7 in the real editor: one account, two tabs on one file. They edit over SSE +
// PATCH (legacy); the account's switch flips to rust and both tabs move to collab's socket through /session without a reload; they
// keep editing and undo goes on working across the flip (an edit made before it is undone after it); the switch flips back and both
// tabs return to SSE + PATCH. Every edit is in the stored document at the end. The protocol-level twin is
// tests/postgresql-runtime-design-collab-cutover.test.ts.
//
// Needs the client's socket transport (lane B3, src/design/realtime/transport/) and lane B1's collab binary, which
// scripts/e2e-server.ts starts beside the API when it is built; skipped without either.

type Node = {id: string; type: string; x: number; y: number};
type Store = {getState(): {doc: {nodes: Record<string, Node>}}; transact(label: string, recipe: (tx: {update(id: string, partial: object): void}) => void): void; undo(): boolean; redo(): boolean};
type TestHost = {__morfaDesignTest?: {store: Store}};

const clientSpeaksCollab = existsSync(new URL('../../src/design/realtime/transport/ws.ts', import.meta.url));
const runKey = () => ({'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!});

const nodeOf = (page: Page, id: string) => page.evaluate(key => (window as unknown as TestHost).__morfaDesignTest?.store.getState().doc.nodes[key] ?? null, id);
const move = (page: Page, id: string, partial: Partial<Node>) =>
  page.evaluate(([key, change]) => (window as unknown as TestHost).__morfaDesignTest!.store.transact('Move', tx => tx.update(key, change)), [id, partial] as const);
const undo = (page: Page) => page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.store.undo());

async function openFile(page: Page, id: string) {
  await page.goto('/#design/' + encodeURIComponent(id));
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as TestHost).__morfaDesignTest)).toBe(true);
}

/** The tab's collab sockets and its SSE stream opens, as they happen. */
function watch(page: Page) {
  const sockets: WebSocket[] = [];
  let streams = 0;
  page.on('websocket', socket => {
    if (socket.url().includes('/collab/')) sockets.push(socket);
  });
  page.on('request', request => {
    if (/\/api\/design-files\/[^/]+\/events/.test(request.url())) streams++;
  });
  return {
    open: () => sockets.filter(socket => !socket.isClosed()).length,
    opened: () => sockets.length,
    streams: () => streams,
  };
}

test('cutover: two tabs move from SSE to the collab socket and back, no edit lost, undo intact', async ({page, seed, context}) => {
  test.skip(!clientSpeaksCollab, 'the client socket transport (lane B3) is not on this branch');
  test.setTimeout(180_000);
  const flip = (mode: string) => page.request.post('/__e2e/collab', {headers: runKey(), data: {accountId: seed.accountId, mode}});
  const ready = await flip('legacy');
  test.skip(ready.status() === 503, 'no collab binary built (cargo build -p morfa-collab)');
  expect(ready.ok()).toBeTruthy();

  const doc = createDocument('page');
  const frame = createNode('FRAME', {id: 'F', parentId: 'page', x: 0, y: 0, width: 800, height: 600});
  const r1 = createNode('RECTANGLE', {id: 'r1', parentId: 'F', x: 40, y: 40, width: 80, height: 80});
  const r2 = createNode('RECTANGLE', {id: 'r2', parentId: 'F', x: 200, y: 40, width: 80, height: 80});
  frame.children = ['r1', 'r2'];
  doc.nodes = {...doc.nodes, page: {...doc.nodes.page, children: ['F']}, F: frame, r1, r2};
  const created = await page.request.post('/api/design-files', {data: {name: 'Switchover', document: doc}});
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as {file: {id: string}}).file.id;

  const tabB = await context.newPage();
  const [a, b] = [watch(page), watch(tabB)];
  await openFile(page, id);
  await openFile(tabB, id);
  const sees = (tab: Page, key: string, field: 'x' | 'y', value: number) => expect.poll(async () => (await nodeOf(tab, key))?.[field], {timeout: 15_000}).toBe(value);

  // ── Legacy: SSE down, PATCH up ──
  expect(a.opened() + b.opened()).toBe(0);
  await move(page, 'r1', {x: 111});
  await sees(tabB, 'r1', 'x', 111);
  await move(tabB, 'r2', {y: 222});
  await sees(page, 'r2', 'y', 222);

  // ── Flip to rust: both tabs move to the socket without a reload ──
  expect((await flip('rust')).ok()).toBeTruthy();
  await expect.poll(() => a.open(), {timeout: 20_000}).toBe(1);
  await expect.poll(() => b.open(), {timeout: 20_000}).toBe(1);
  await move(page, 'r1', {x: 333});
  await sees(tabB, 'r1', 'x', 333);
  await move(tabB, 'r2', {y: 444});
  await sees(page, 'r2', 'y', 444);
  // Undo across the flip: A's edit made on the socket, then A's edit made over PATCH before the flip.
  expect(await undo(page)).toBe(true);
  await sees(page, 'r1', 'x', 111);
  await sees(tabB, 'r1', 'x', 111);
  expect(await undo(page)).toBe(true);
  await sees(page, 'r1', 'x', 40);
  await sees(tabB, 'r1', 'x', 40);
  await expect.poll(async () => ((await (await page.request.get('/api/design-files/' + id)).json()) as {document: {nodes: Record<string, Node>}}).document.nodes.r1.x, {timeout: 15_000}).toBe(40);

  // ── Flip back: the node lets go, both tabs return to SSE + PATCH ──
  const streamsBefore = [a.streams(), b.streams()];
  expect((await flip('legacy')).ok()).toBeTruthy();
  await expect.poll(() => a.open() + b.open(), {timeout: 20_000}).toBe(0);
  await expect.poll(() => a.streams() > streamsBefore[0] && b.streams() > streamsBefore[1], {timeout: 30_000}).toBe(true);
  await move(page, 'r1', {x: 555});
  await sees(tabB, 'r1', 'x', 555);
  await move(tabB, 'r2', {y: 666});
  await sees(page, 'r2', 'y', 666);

  // ── Nothing lost: the stored document has every edit, and both tabs hold it ──
  await expect.poll(async () => {
    const stored = ((await (await page.request.get('/api/design-files/' + id)).json()) as {document: {nodes: Record<string, Node>}}).document.nodes;
    return [stored.r1.x, stored.r2.y];
  }, {timeout: 15_000}).toEqual([555, 666]);
  for (const tab of [page, tabB]) {
    expect((await nodeOf(tab, 'r1'))?.x).toBe(555);
    expect((await nodeOf(tab, 'r2'))?.y).toBe(666);
  }
  await tabB.close();
});
