import {test, expect, waitEditorReady} from './fixtures';
import type {Browser, Page} from '@playwright/test';

// Morfa Design teams, step 1 (docs/design-tool.md §Teams): the owner makes a team and a file in it, invites a second account by link as
// "Viewer"; that account joins from the link, sees the team's file and opens it read-only (no edit reaches the server); the owner
// promotes it to "Editor", and its edit is saved. Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type SavedNode = {type: string};
type Saved = {file: {version: number; teamId: string | null}; access: {role: string; canEdit: boolean}; document: {nodes: Record<string, SavedNode>}};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const rectangles = (file: Saved) => Object.values(file.document.nodes).filter(node => node.type === 'RECTANGLE').length;

/** A second signed-in account in its own browser context (the fixture makes one account per call). */
async function secondAccount(browser: Browser, page: Page, baseURL: string) {
  const response = await page.request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {}});
  expect(response.ok(), 'A second isolated account').toBeTruthy();
  const seed = (await response.json()) as {token: string};
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}});
  await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL, httpOnly: true, sameSite: 'Lax'}]);
  return context;
}

async function drawRectangle(page: Page) {
  const canvas = page.getByRole('application', {name: 'Canvas'});
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await canvas.click({position: {x: 40, y: 40}});
  await page.keyboard.press('r');
  await page.mouse.move(x - 80, y - 50);
  await page.mouse.down();
  await page.mouse.move(x, y, {steps: 4});
  await page.mouse.move(x + 80, y + 50, {steps: 4});
  await page.mouse.up();
}

test('a team: invite by link, a viewer opens its file read-only, promoted to editor it edits', async ({page, seed: _seed, browser, baseURL}) => {
  // ── The owner makes a team and a file in it ──
  await page.goto('/#designs');
  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Create team', exact: true}).click();
  const nameField = page.getByRole('textbox', {name: 'Team name', exact: true});
  await nameField.fill('North Studio');
  await page.getByRole('button', {name: 'Create', exact: true}).click();
  // The next step is people, as in Figma: the new team's "Members" opens with the invite link ready to make; later here.
  const invite = page.getByRole('dialog', {name: /Members/});
  await expect(invite.getByRole('button', {name: 'Copy link', exact: true})).toBeVisible();
  await invite.getByRole('button', {name: 'Done', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'All files', exact: true})).toBeVisible();
  await expect(page.locator('.dz-files-eyebrow')).toContainText('North Studio');
  await expect(page.locator('.dz-files-eyebrow')).toContainText('Owner');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  expect((await saved(page, id)).file.teamId).toBeTruthy();
  await waitEditorReady(page);
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Back to files', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'All files', exact: true})).toBeVisible();

  // ── An invite link for a viewer ──
  await page.getByRole('button', {name: 'Members', exact: true}).click();
  const members = page.getByRole('dialog', {name: /Members/});
  await expect(members.locator('.dz-member')).toHaveCount(1);
  await members.getByRole('button', {name: 'Role for the link', exact: true}).click();
  await page.getByRole('menuitemradio', {name: /Viewer/}).click();
  await members.getByRole('button', {name: 'Copy link', exact: true}).click();
  const linkField = members.getByRole('textbox', {name: 'Invite link', exact: true});
  await expect(linkField).toHaveValue(/\?designInvite=[A-Za-z0-9_-]{43}#designs$/);
  const link = await linkField.inputValue();
  await expect(members.locator('.dz-invite-row')).toHaveCount(1);
  await members.getByRole('button', {name: 'Done', exact: true}).click();

  // ── The second account joins from the link ──
  const context = await secondAccount(browser, page, baseURL!);
  const guest = await context.newPage();
  await guest.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  const landing = guest.getByRole('dialog', {name: 'Team invitation'});
  await expect(landing).toContainText('North Studio');
  await expect(landing).toContainText('Role: Viewer');
  expect(new URL(guest.url()).search, 'the token leaves the address').toBe('');
  await landing.getByRole('button', {name: 'Join', exact: true}).click();
  await expect(guest.getByRole('heading', {name: 'All files', exact: true})).toBeVisible();
  await expect(guest.locator('.dz-files-eyebrow')).toContainText('Viewer');
  await expect(guest.getByRole('button', {name: 'New file', exact: true})).toHaveCount(0);
  const card = guest.locator('.dz-file').first();
  await expect(card).toBeVisible();

  // ── Read-only: "View only", select and hand only, nothing reaches the server ──
  await card.locator('.dz-file-hit').dblclick();
  await expect(guest).toHaveURL(new RegExp('#design/' + encodeURIComponent(id) + '$'));
  await expect(guest.getByRole('status').filter({hasText: 'View only'})).toBeVisible();
  const toolbar = guest.getByRole('toolbar', {name: 'Tools'});
  await expect(toolbar.getByRole('button', {name: 'Rectangle', exact: true})).toHaveCount(0);
  // Selecting and the hand, in one group as in Figma.
  await expect(toolbar.getByRole('button', {name: 'Move', exact: true})).toBeVisible();
  await toolbar.getByRole('button', {name: 'Move tools', exact: true}).click();
  await expect(guest.getByRole('menuitemradio', {name: /Hand/})).toBeVisible();
  await guest.keyboard.press('Escape');
  // A viewer's modes: no "Draw" (read-only) and no "Code" (the code is a developer's and an editor's).
  expect(await toolbar.getByRole('radio').evaluateAll(radios => radios.map(radio => radio.getAttribute('aria-label')))).toEqual(['Design', 'Prototype']);
  const before = await saved(guest, id);
  expect(before.access).toEqual({role: 'viewer', canEdit: false, team: expect.objectContaining({name: 'North Studio'})});
  await drawRectangle(guest);
  await expect(guest.getByText(/View only: team owners, admins and editors can edit team files/)).toBeVisible();
  await guest.waitForTimeout(1500);
  const after = await saved(guest, id);
  expect([after.file.version, rectangles(after)]).toEqual([before.file.version, 0]);
  await expect(guest.getByRole('tab', {name: 'Code', exact: true})).toBeVisible();

  // ── The owner promotes the viewer to editor ──
  await page.getByRole('button', {name: 'Members', exact: true}).click();
  const list = page.getByRole('dialog', {name: /Members/});
  await expect(list.locator('.dz-member')).toHaveCount(2);
  await list.locator('.dz-member').filter({hasNotText: /· you/}).getByRole('button', {name: /^Role: /}).click();
  await page.getByRole('menuitemradio', {name: 'Editor', exact: true}).click();
  await expect(list.locator('.dz-member').filter({hasNotText: /· you/})).toContainText('Editor');
  await list.getByRole('button', {name: 'Done', exact: true}).click();

  // ── Now an editor: the file opens editable and the edit is saved ──
  await guest.reload();
  await expect(guest.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await expect(guest.getByRole('status').filter({hasText: 'View only'})).toHaveCount(0);
  expect((await saved(guest, id)).access.canEdit).toBe(true);
  await drawRectangle(guest);
  await expect.poll(async () => rectangles(await saved(guest, id))).toBe(1);
  // The owner sees the member's edit.
  expect(rectangles(await saved(page, id))).toBe(1);
  await context.close();
});
