import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {test, expect} from './fixtures';
import type {Browser, BrowserContext, Page} from '@playwright/test';

// Sharing a file by its copied link, as a person would (docs/design-tool.md §Teams, "File access"): the owner opens "Share", lets anyone with the link edit, copies the link (the clipboard holds
// the file's address); a second account opens that address in a browser of its own, sees the file and edits it, and both see each
// other's change. The file browser's "Copy link" gives the same address.
// Screenshots for the owner: output/share-preview/share-*.png.

const SHOTS = path.join(process.cwd(), 'output', 'share-preview');
mkdirSync(SHOTS, {recursive: true});
const shot = (page: Page, name: string) => page.screenshot({path: path.join(SHOTS, name + '.png'), animations: 'disabled'});

type Node = {id: string; type: string; x: number; y: number};
type TestHost = {__morfaDesignTest?: {store: {getState(): {doc: {nodes: Record<string, Node>}}}}};
const nodesOf = (page: Page) => page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest?.store.getState().doc.nodes ?? {});
const rectangles = async (page: Page) => Object.values(await nodesOf(page)).filter(node => node.type === 'RECTANGLE').length;

/** A second person: a new account signed in, in a browser of its own (tests/e2e/design-multiplayer.spec.ts's way). */
async function person(browser: Browser, page: Page, baseURL: string, name: string): Promise<{context: BrowserContext; page: Page}> {
  const response = await page.request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {}});
  expect(response.ok(), 'An isolated account').toBeTruthy();
  const seed = (await response.json()) as {token: string};
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}});
  await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL, httpOnly: true, sameSite: 'Lax'}]);
  const opened = await context.newPage();
  expect((await opened.request.put('/api/settings', {data: {name}})).ok()).toBeTruthy();
  return {context, page: opened};
}

async function openFile(page: Page) {
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as TestHost).__morfaDesignTest)).toBe(true);
}

async function drawRectangle(page: Page, dx: number) {
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

test('a file shared by its copied link: a second person opens it, and both edit it and see each other’s change', async ({page, seed: _seed, browser, baseURL, context}) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: baseURL!});
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith'}})).ok()).toBeTruthy();
  const created = await page.request.post('/api/design-files', {data: {name: 'Coffee shop landing'}});
  const fileId = ((await created.json()) as {file: {id: string}}).file.id;
  const address = `${baseURL}/#design/${fileId}`;

  // ── The owner: "Share" → anyone with the link may edit → "Copy link" ──
  await page.goto('/#design/' + fileId);
  await openFile(page);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await page.locator('.dz-right-header').getByRole('button', {name: 'Share', exact: true}).click();
  const share = page.getByRole('dialog', {name: 'Share "Coffee shop landing"'});
  await expect(share.getByRole('button', {name: 'Link access', exact: true})).toHaveText(/Invited people only/);
  await share.getByRole('button', {name: 'Link access', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'Anyone with the link can edit'}).click();
  await expect(share).toContainText('Anyone who signs in to Morfa with the link can edit');
  await shot(page, 'share-dialog-before-copy');
  const copy = share.locator('.dz-dialog-header').getByRole('button', {name: 'Copy link'});
  await copy.click();
  await expect(share.locator('.dz-dialog-header').getByRole('button', {name: 'Link copied'})).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(address);
  await shot(page, 'share-dialog-after-copy');
  await share.getByRole('button', {name: 'Done', exact: true}).click();
  await expect(share).toBeHidden();

  // ── Boris (another account) opens the copied address: the file, editable ──
  const boris = await person(browser, page, baseURL!, 'Boris Petrov');
  await boris.page.goto(copied.replace(baseURL!, ''));
  await openFile(boris.page);
  await expect(boris.page.locator('.dz-file-name').first()).toHaveText('Coffee shop landing');
  await expect(boris.page.getByText('View only', {exact: true})).toHaveCount(0);

  // ── Both edit: each one's rectangle reaches the other without a reload ──
  await drawRectangle(page, -200);
  await expect.poll(() => rectangles(boris.page)).toBe(1);
  await drawRectangle(boris.page, 200);
  await expect.poll(() => rectangles(page)).toBe(2);
  await expect.poll(async () => Object.values(((await (await page.request.get('/api/design-files/' + fileId)).json()) as {document: {nodes: Record<string, Node>}}).document.nodes)
    .filter(node => node.type === 'RECTANGLE').length).toBe(2);
  await expect(page.getByRole('group', {name: 'People in this file'}).getByRole('button', {name: /Boris Petrov/})).toBeVisible();
  await shot(boris.page, 'share-second-person-editing');
  await shot(page, 'share-owner-sees-change');
  await boris.context.close();
});

test('the file browser’s "Copy link" copies the same address as the editor’s', async ({page, seed: _seed, baseURL, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: baseURL!});
  const created = await page.request.post('/api/design-files', {data: {name: 'Business card'}});
  const fileId = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#designs');
  const card = page.locator('.dz-file').filter({hasText: 'Business card'});
  await expect(card).toBeVisible();
  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Copy link', exact: true}).click();
  await expect(page.getByText('Link copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${baseURL}/#design/${fileId}`);
});
