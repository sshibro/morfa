import {test, expect} from './fixtures';
import type {Browser, BrowserContext, Page} from '@playwright/test';

// "Morfa Design" co-editing in the real app (docs/design-tool.md "Co-editing"): two accounts of one team edit
// one file at once and see each other's changes, cursors and selections; one follows the other; a viewer sees the changes
// live; a demoted editor turns read-only and a removed member is cut off. One account in two tabs edits without the old
// "File changed in another tab". Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type Node = {id: string; type: string; x: number; y: number; width: number; parentId: string | null; fills: {type: string; color?: {r: number; g: number; b: number}}[]};
type Saved = {file: {version: number}; document: {pages: string[]; nodes: Record<string, Node>}};
type TestHost = {__morfaDesignTest?: {store: {getState(): {doc: {nodes: Record<string, Node>}; pageId: string; viewports: Record<string, {x: number; y: number; zoom: number}>}; transact(label: string, recipe: (tx: {update(id: string, partial: object): void}) => void): void; setSelection(ids: string[]): void; setViewport(viewport: {x: number; y: number; zoom: number}): void}}};

async function account(browser: Browser, page: Page, baseURL: string, name: string): Promise<{context: BrowserContext; page: Page}> {
  const response = await page.request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {}});
  expect(response.ok(), 'An isolated account').toBeTruthy();
  const seed = (await response.json()) as {token: string};
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}});
  await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL, httpOnly: true, sameSite: 'Lax'}]);
  const opened = await context.newPage();
  expect((await opened.request.put('/api/settings', {data: {name, workspace: 'Studio'}})).ok()).toBeTruthy();
  return {context, page: opened};
}

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const nodesOf = (page: Page) => page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest?.store.getState().doc.nodes ?? {});
const rectanglesIn = (nodes: Record<string, Node>) => Object.values(nodes).filter(node => node.type === 'RECTANGLE');

// DESIGN_COLLAB=rust (docs/BACKEND.md §7, lane B3): the same spec with the server in rust mode; every open file then
// talks to collab over its WebSocket instead of the SSE stream and PATCH (the coordinator runs this project on the Mac).
const RUST = process.env.DESIGN_COLLAB === 'rust';

async function openFile(page: Page, id: string) {
  const socket = RUST ? page.waitForEvent('websocket', {predicate: ws => ws.url().includes('/collab/'), timeout: 15_000}) : null;
  await page.goto('/#design/' + encodeURIComponent(id));
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as TestHost).__morfaDesignTest)).toBe(true);
  if (socket) expect((await socket).url(), 'the file is edited over the collab socket').toContain('wire=');
}

async function drawRectangle(page: Page, dx = 0) {
  const canvas = page.getByRole('application', {name: 'Canvas'});
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width / 2 + dx,
    y = box.y + box.height / 2;
  await canvas.click({position: {x: 40, y: 40}});
  await page.keyboard.press('r');
  await page.mouse.move(x - 60, y - 40);
  await page.mouse.down();
  await page.mouse.move(x, y, {steps: 4});
  await page.mouse.move(x + 60, y + 40, {steps: 4});
  await page.mouse.up();
}

test('two people in one team file: changes, cursors, selections and following both ways; a viewer live; demotion and removal', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(120_000);
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith', workspace: 'Studio'}})).ok()).toBeTruthy();
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'North Studio'}})).json()) as {team: {id: string}}).team.id;
  const invite = async (role: string) => ((await (await page.request.post(`/api/design-teams/${teamId}/invites`, {data: {role, days: 7, maxUses: 1}})).json()) as {token: string}).token;
  const boris = await account(browser, page, baseURL!, 'Boris Petrov');
  const vera = await account(browser, page, baseURL!, 'Vera Fox');
  expect((await boris.page.request.post(`/api/design-teams/invites/${await invite('editor')}/accept`)).ok()).toBeTruthy();
  expect((await vera.page.request.post(`/api/design-teams/invites/${await invite('viewer')}/accept`)).ok()).toBeTruthy();
  const created = await page.request.post('/api/design-files', {data: {name: 'Shared design', teamId}});
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as {file: {id: string}}).file.id;

  await openFile(page, id);
  await openFile(boris.page, id);

  // ── Each sees the other in the header ──
  const avatarsA = page.getByRole('group', {name: 'People in this file'});
  await expect(avatarsA.getByRole('button', {name: /Follow: Boris Petrov/})).toBeVisible();
  await expect(avatarsA.getByRole('button', {name: /Follow: Boris Petrov/})).toHaveText('BP');
  await expect(boris.page.getByRole('group', {name: 'People in this file'}).getByRole('button', {name: /Follow: Anna Smith/})).toBeVisible();

  // ── Anna draws; Boris sees it without reloading ──
  await drawRectangle(page);
  await expect.poll(async () => rectanglesIn(await nodesOf(boris.page)).length).toBe(1);
  const rectId = rectanglesIn(await nodesOf(page))[0].id;

  // ── Boris's cursor and selection on Anna's canvas ──
  const canvasB = boris.page.getByRole('application', {name: 'Canvas'});
  const boxB = (await canvasB.boundingBox())!;
  for (let step = 0; step < 6; step++) await boris.page.mouse.move(boxB.x + 300 + step * 20, boxB.y + 200 + step * 10);
  const cursor = page.locator('.dz-live-cursor.is-shown');
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toContainText('Boris Petrov');
  await boris.page.evaluate(rect => (window as unknown as TestHost).__morfaDesignTest!.store.setSelection([rect]), rectId);
  await expect.poll(() => page.locator('.dz-live-outline').evaluateAll(paths => paths.map(path => path.getAttribute('d') ?? '').join(''))).toMatch(/^M.+Z$/);
  // ⌥⌘\ (Figma's View ▸ Multiplayer cursors) hides the others' cursors and keeps their selections; again shows them.
  await page.keyboard.press('ControlOrMeta+Alt+Backslash');
  await expect(cursor).toHaveCount(0);
  await expect.poll(() => page.locator('.dz-live-outline').evaluateAll(paths => paths.map(path => path.getAttribute('d') ?? '').join(''))).toMatch(/^M.+Z$/);
  await page.keyboard.press('ControlOrMeta+Alt+Backslash');
  await expect(cursor).toHaveCount(1);
  await boris.page.mouse.move(boxB.x - 40, boxB.y + 200);
  await page.screenshot({path: test.info().outputPath('presence-anna.png')});

  // ── Both edit the same rectangle at the same moment: Anna its fill, Boris its position. Both changes stay everywhere ──
  await Promise.all([
    page.evaluate(rect => (window as unknown as TestHost).__morfaDesignTest!.store.transact('Fill', tx => tx.update(rect, {fills: [{type: 'SOLID', color: {r: 1, g: 0, b: 0}, opacity: 1, visible: true, blendMode: 'NORMAL'}]})), rectId),
    boris.page.evaluate(rect => (window as unknown as TestHost).__morfaDesignTest!.store.transact('Position', tx => tx.update(rect, {x: 640})), rectId),
  ]);
  const both = (node: Node | undefined) => !!node && node.x === 640 && node.fills[0]?.color?.r === 1 && node.fills[0]?.color?.g === 0;
  await expect.poll(async () => both((await saved(page, id)).document.nodes[rectId])).toBe(true);
  await expect.poll(async () => both((await nodesOf(page))[rectId])).toBe(true);
  await expect.poll(async () => both((await nodesOf(boris.page))[rectId])).toBe(true);
  // Two layers added at once into the page both stay.
  await Promise.all([drawRectangle(page, -300), drawRectangle(boris.page, 300)]);
  await expect.poll(async () => rectanglesIn((await saved(page, id)).document.nodes).length).toBe(3);
  await expect.poll(async () => rectanglesIn(await nodesOf(page)).length).toBe(3);
  await expect.poll(async () => rectanglesIn(await nodesOf(boris.page)).length).toBe(3);
  await expect(page.getByRole('dialog', {name: /changed/})).toHaveCount(0);

  // ── Anna follows Boris: her view shows his until she moves ──
  await avatarsA.getByRole('button', {name: /Follow: Boris Petrov/}).click();
  await expect(page.getByRole('status').filter({hasText: 'Following: Boris Petrov'})).toBeVisible();
  await boris.page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.store.setViewport({x: 900, y: 700, zoom: 2}));
  const zoomOfAnna = () => page.evaluate(() => {
    const state = (window as unknown as TestHost).__morfaDesignTest!.store.getState();
    return state.viewports[state.pageId]?.zoom ?? 1;
  });
  await expect.poll(zoomOfAnna).toBeCloseTo(2, 1);
  await page.screenshot({path: test.info().outputPath('follow-anna.png')});
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status').filter({hasText: 'Following: Boris Petrov'})).toHaveCount(0);

  // ── Vera, a viewer, sees changes live ──
  await openFile(vera.page, id);
  await expect(vera.page.getByText('View only', {exact: true}).first()).toBeVisible();
  await expect(avatarsA.getByRole('button', {name: /Follow: Vera Fox/})).toBeVisible();
  await page.evaluate(rect => (window as unknown as TestHost).__morfaDesignTest!.store.transact('Position', tx => tx.update(rect, {y: 33})), rectId);
  await expect.poll(async () => (await nodesOf(vera.page))[rectId]?.y).toBe(33);

  // ── Boris made a viewer: his editor turns read-only at once; Vera removed: she is cut off ──
  const members = (await (await page.request.get(`/api/design-teams/${teamId}/members`)).json()) as {members: {userId: string; name: string}[]};
  const userOf = (name: string) => members.members.find(member => member.name === name)!.userId;
  expect((await page.request.patch(`/api/design-teams/${teamId}/members/${userOf('Boris Petrov')}`, {data: {role: 'viewer'}})).ok()).toBeTruthy();
  await expect(boris.page.getByText('You can now only view this file.')).toBeVisible();
  await expect(boris.page.getByText('View only', {exact: true}).first()).toBeVisible();
  expect((await page.request.delete(`/api/design-teams/${teamId}/members/${userOf('Vera Fox')}`)).ok()).toBeTruthy();
  await expect(vera.page.getByText('You no longer have access to this file.')).toBeVisible();
  await expect(vera.page).toHaveURL(/#designs/);
  await expect(avatarsA.getByRole('button', {name: /Vera Fox/})).toHaveCount(0);

  await boris.context.close();
  await vera.context.close();
});

test('one account in two tabs edits one file: each tab shows the other’s work, nothing conflicts', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as TestHost).__morfaDesignTest)).toBe(true);
  const second = await page.context().newPage();
  await openFile(second, id);
  // The other tab is this account: named so in the avatar.
  await expect(page.getByRole('group', {name: 'People in this file'}).getByRole('button', {name: /you, another tab/})).toBeVisible();

  await drawRectangle(page, -200);
  await expect.poll(async () => rectanglesIn(await nodesOf(second)).length).toBe(1);
  await drawRectangle(second, 200);
  await expect.poll(async () => rectanglesIn(await nodesOf(page)).length).toBe(2);
  await expect.poll(async () => rectanglesIn((await saved(page, id)).document.nodes).length).toBe(2);
  // Undo in one tab takes back only its own rectangle.
  await second.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => rectanglesIn((await saved(page, id)).document.nodes).length).toBe(1);
  await expect.poll(async () => rectanglesIn(await nodesOf(page)).length).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(second.getByRole('dialog')).toHaveCount(0);
  await second.close();
});
