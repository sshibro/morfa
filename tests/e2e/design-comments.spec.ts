import {test, expect, waitEditorReady} from './fixtures';
import type {Browser, Page} from '@playwright/test';
import {createDocument, createNode} from '../../shared/design/defaults';

// "Morfa Design" comments (docs/design-tool.md §Teams "Comments"): the owner of a team file presses C, pins a comment on a frame and
// mentions a member picked from the list; the pin follows the frame when it moves. The member (a viewer) opens the thread from its link,
// sees the mention, replies; the owner's open file picks the reply up without a reload and resolves the thread, which moves to
// "Resolved". Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type SavedThread = {id: string; anchor: {nodeId: string | null}; resolvedAt: string | null; comments: {text: string; mentions: {userId: string}[]}[]};

const FRAME = '1:1';
function startingDocument() {
  const doc = createDocument('0:1', 'Home');
  const frame = createNode('FRAME', {id: FRAME, name: 'Sign-in screen', parentId: '0:1', x: 0, y: 0, width: 390, height: 600});
  doc.nodes[FRAME] = frame;
  doc.nodes['0:1'] = {...doc.nodes['0:1'], children: [FRAME]};
  return doc;
}

async function threads(page: Page, fileId: string): Promise<SavedThread[]> {
  const response = await page.request.get(`/api/design-files/${fileId}/comments`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as {threads: SavedThread[]}).threads;
}

/** The focused element's name (two windows: only one has the browser's focus, so `toBeFocused` cannot tell). */
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);

/** A second signed-in account in its own browser context. */
async function secondAccount(browser: Browser, page: Page, baseURL: string) {
  const response = await page.request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {}});
  expect(response.ok(), 'A second isolated account').toBeTruthy();
  const seed = (await response.json()) as {token: string; accountId: string};
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}});
  await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL, httpOnly: true, sameSite: 'Lax'}]);
  return {context, accountId: seed.accountId};
}

test('comments: pin on a frame with a mention, the pin follows the frame, a member replies from the link, the owner resolves', async ({page, context, seed: _seed, browser, baseURL}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: baseURL});
  // ── A team file and a viewer in the team ──
  const team = (await (await page.request.post('/api/design-teams', {data: {name: 'North Studio'}})).json()).team as {id: string};
  const created = await page.request.post('/api/design-files', {data: {teamId: team.id, name: 'App', document: startingDocument()}});
  expect(created.ok()).toBeTruthy();
  const fileId = ((await created.json()) as {file: {id: string}}).file.id;
  const invite = (await (await page.request.post(`/api/design-teams/${team.id}/invites`, {data: {role: 'viewer', days: 7, maxUses: 1}})).json()) as {token: string};
  const member = await secondAccount(browser, page, baseURL!);
  const guest = await member.context.newPage();
  expect((await guest.request.post(`/api/design-teams/invites/${invite.token}/accept`)).ok()).toBeTruthy();
  const guestName = ((await (await page.request.get(`/api/design-teams/${team.id}/members`)).json()) as {members: {userId: string; name: string}[]}).members.find(m => m.userId === member.accountId)!.name;

  // ── The owner pins a comment on the frame and mentions the member ──
  await page.bringToFront();
  await page.goto('/#design/' + fileId);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  await waitEditorReady(page);
  const toolbar = page.getByRole('toolbar', {name: 'Tools'});
  await canvas.click({position: {x: 8, y: 8}});
  await page.keyboard.press('c');
  await expect(toolbar.getByRole('button', {name: 'Comment', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tab', {name: /^Comments/})).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('No comments yet')).toBeVisible();
  // The design tools step aside while commenting.
  await expect(page.getByRole('tab', {name: 'Design', exact: true})).toHaveCount(0);
  const box = (await canvas.boundingBox())!;
  const pinAt = {x: box.width / 2, y: box.height / 2};
  await canvas.click({position: pinAt});
  const draft = page.getByRole('dialog', {name: 'New comment'});
  await expect(draft).toBeVisible();
  const field = draft.getByRole('combobox', {name: 'New comment'});
  await expect.poll(() => focusedLabel(page)).toBe('New comment');
  await field.pressSequentially('Shall we make the button bigger? @');
  const option = page.getByRole('option', {name: guestName});
  await expect(option).toBeVisible();
  await page.keyboard.press('Enter');
  await field.pressSequentially('take a look');
  await expect(field).toHaveValue(`Shall we make the button bigger? @${guestName} take a look`);
  await page.keyboard.press('Enter');
  const card = page.getByRole('dialog', {name: 'Thread'});
  await expect(card).toBeVisible();
  await expect(card.locator('.dz-mention')).toHaveText('@' + guestName);
  await expect.poll(async () => (await threads(page, fileId)).length).toBe(1);
  const [saved] = await threads(page, fileId);
  expect(saved.anchor.nodeId, 'the pin is on the frame').toBe(FRAME);
  expect(saved.comments[0].mentions.map(mention => mention.userId)).toEqual([member.accountId]);
  await expect(page.locator('.dz-comment-row')).toHaveCount(1);

  // ── The pin stays out of comment mode and follows the frame: Escape twice (the card, then comment mode), ⇧C, drag the frame, C ──
  const pin = page.locator(`.dz-comment-pin[data-thread="${saved.id}"]`);
  const before = (await pin.boundingBox())!;
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(toolbar.getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
  // Pins stay on the canvas outside comment mode, as Figma's; ⇧C hides them and shows them again.
  await expect(pin).toBeVisible();
  await page.keyboard.press('Shift+c');
  await expect(pin).toHaveCount(0);
  await page.keyboard.press('Shift+c');
  await expect(pin).toBeVisible();
  // Inside the frame, beside the pin: the move tool picks the frame and drags it.
  const grab = {x: box.x + pinAt.x - 60, y: box.y + pinAt.y + 60};
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 60, grab.y + 40, {steps: 6});
  await page.mouse.move(grab.x + 120, grab.y + 80, {steps: 6});
  await page.mouse.up();
  await page.keyboard.press('c');
  await expect(pin).toBeVisible();
  const after = (await pin.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBeGreaterThan(100);
  expect(Math.round(after.y - before.y)).toBeGreaterThan(60);

  // ── "Copy link" ──
  await pin.click();
  await expect(card).toBeVisible();
  await card.getByRole('button', {name: 'More', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Copy link', exact: true}).click();
  await expect(page.getByText('Comment link copied')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`#design/${fileId}\\?comment=${saved.id}$`));

  // ── The member opens the link: comment mode, the thread open, the mention is theirs; they reply ──
  await guest.bringToFront();
  await guest.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  const guestCard = guest.getByRole('dialog', {name: 'Thread'});
  await expect(guestCard).toBeVisible();
  await expect(guest.getByRole('status').filter({hasText: 'View only'})).toBeVisible();
  await expect(guestCard).toContainText('Shall we make the button bigger?');
  await expect(guestCard.locator('.dz-mention.is-you')).toHaveText('@' + guestName);
  // A viewer comments but does not resolve someone else's thread.
  await expect(guestCard.getByRole('button', {name: 'Mark as resolved'})).toHaveCount(0);
  const reply = guestCard.getByRole('combobox', {name: 'Reply'});
  await expect.poll(() => focusedLabel(guest)).toBe('Reply');
  // A mention as the last word: Enter picks the owner, the list closes on the finished mention, the next Enter sends once.
  await reply.pressSequentially('Will do, by 8 px @');
  await expect(guest.getByRole('option').first()).toBeVisible();
  await guest.keyboard.press('Enter');
  await expect(guest.getByRole('option')).toHaveCount(0);
  await guest.keyboard.press('Enter');
  await expect(guestCard.locator('.dz-comment')).toHaveCount(2);
  const sentReply = (await threads(guest, fileId))[0].comments[1];
  expect(sentReply.text).toMatch(/^Will do, by 8 px @\S/);
  expect(sentReply.text.match(/@/g), 'the mention is in once').toHaveLength(1);
  expect(sentReply.mentions).toHaveLength(1);
  await expect(guest.locator('.dz-comment-row')).toContainText('1 reply');

  // ── The owner's open thread gets the reply at once over the co-editing stream (no poll, no focus); open, it is read ──
  await page.bringToFront();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Will do, by 8 px');
  await expect(page.locator('.dz-comment-row.is-unread')).toHaveCount(0);
  await expect(page.getByRole('tab', {name: /^Comments/})).toHaveText('Comments');

  // ── Resolved: out of "Open", into "Resolved"; the member sees it resolved ──
  await card.getByRole('button', {name: 'Mark as resolved'}).click();
  await expect.poll(async () => (await threads(page, fileId))[0].resolvedAt).not.toBeNull();
  await expect(card.getByRole('button', {name: 'Reopen'})).toBeVisible();
  await card.getByRole('button', {name: 'Close'}).click();
  await expect(page.locator('.dz-comment-row')).toHaveCount(0);
  await page.getByRole('radio', {name: 'Resolved', exact: true}).click();
  await expect(page.locator('.dz-comment-row')).toHaveCount(1);
  // The member's open file hears of it over the stream too.
  await expect(guestCard).toHaveCount(1);
  await expect(guest.locator(`.dz-comment-pin[data-thread="${saved.id}"]`)).toHaveClass(/is-resolved/);
  await member.context.close();
});
