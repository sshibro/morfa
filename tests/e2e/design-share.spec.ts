import {randomBytes} from 'node:crypto';
import {test, expect, waitEditorReady} from './fixtures';
import type {Browser, Page} from '@playwright/test';

// "Share", Figma's way (docs/design-tool.md §Teams, "File access"): the editor's blue button shares one file without a team:
// the link can open the file to anyone signed in, and the access is taken back by closing it. A team file shows its team, and its
// managers reach the team's people from the dialog. People sign in by name.

/** A person signed in by name, in a browser of their own. */
async function person(browser: Browser, baseURL: string, label: string, name: string, signIn = true) {
  // A name of its own, so that parallel specs never meet in one account; the display name is set below.
  const signInName = `${label} ${randomBytes(4).toString('hex')}`;
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}});
  if (signIn) {
    expect((await context.request.post('/api/auth/name', {data: {name: signInName}})).ok(), 'The name sign-in').toBeTruthy();
    expect((await context.request.put('/api/settings', {data: {name}})).ok()).toBeTruthy();
  }
  return {context, page: await context.newPage(), signInName};
}
const opened = async (page: Page, id: string) => (await page.request.get('/api/design-files/' + encodeURIComponent(id))).status();

test('"Share" one file: the link, "Shared with me", taking access back', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(150_000);
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith'}})).ok()).toBeTruthy();
  const created = await page.request.post('/api/design-files', {data: {name: 'Coffee shop landing'}});
  const fileId = ((await created.json()) as {file: {id: string}}).file.id;
  const vera = await person(browser, baseURL!, 'vera', 'Vera Fox');

  // ── The editor's "Share": "Export" folds into an icon beside ▶, the share button is the one blue button ──
  await page.goto('/#design/' + fileId);
  await waitEditorReady(page);
  const header = page.locator('.dz-right-header');
  await expect(header.getByRole('button', {name: 'Export', exact: true})).toBeVisible();
  await header.getByRole('button', {name: 'Share', exact: true}).click();
  const share = page.getByRole('dialog', {name: 'Share "Coffee shop landing"'});
  await expect(share.getByRole('textbox')).toHaveCount(0);
  const people = share.getByRole('list', {name: 'People with access'});
  await expect(people.locator('.dz-member').filter({hasText: 'Anna Smith'})).toContainText('Owner');
  await expect(share.getByRole('button', {name: 'Link access', exact: true})).toHaveText(/Invited people only/);

  // ── The link: anyone signed in may view; Vera opens it, it stays in her "Shared with me"; closed again, it is gone ──
  expect(await opened(vera.page, fileId)).toBe(404);
  await share.getByRole('button', {name: 'Link access', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'Anyone with the link can view'}).click();
  await expect(share).toContainText('Anyone who signs in to Morfa with the link can view');
  await vera.page.goto('/#design/' + fileId);
  await expect(vera.page.getByRole('status').filter({hasText: 'View only'})).toBeVisible();
  expect(((await (await vera.page.request.get('/api/design-files?shared=1')).json()) as {files: {id: string}[]}).files.map(file => file.id)).toEqual([fileId]);
  await share.getByRole('button', {name: 'Link access', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'Invited people only'}).click();
  await expect.poll(() => opened(vera.page, fileId)).toBe(404);

  await share.getByRole('button', {name: 'Done', exact: true}).click();
  await vera.context.close();
});

test('an invite link opened signed out says what the sign-in leads to, then joins', async ({page, seed: _seed, browser, baseURL}) => {
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith'}})).ok()).toBeTruthy();
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'North'}})).json()) as {team: {id: string}}).team.id;
  const token = ((await (await page.request.post(`/api/design-teams/${teamId}/invites`, {data: {role: 'viewer', days: 7, maxUses: 1}})).json()) as {token: string}).token;
  const guest = await person(browser, baseURL!, 'vera', 'Vera', false);
  await guest.page.goto(`/?designInvite=${token}#designs`);
  await expect(guest.page.getByRole('heading', {name: 'Welcome to Morfa', exact: true})).toBeVisible();
  await expect(guest.page.getByRole('note').filter({hasText: 'You were invited to a team'})).toBeVisible();
  await guest.page.getByRole('textbox', {name: 'Your name'}).fill(guest.signInName);
  await guest.page.getByRole('button', {name: 'Continue'}).click();
  const landing = guest.page.getByRole('dialog', {name: 'Team invitation'});
  await expect(landing).toContainText('Anna Smith invites you to join the team');
  await landing.getByRole('button', {name: 'Join', exact: true}).click();
  await expect(guest.page.locator('.dz-files-eyebrow')).toContainText('Viewer');
  await guest.context.close();
});

test('a team board’s "Share": the team’s row, its people from the dialog, and someone outside the team', async ({page, seed: _seed, browser, baseURL}) => {
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'Retro'}})).json()) as {team: {id: string}}).team.id;
  const created = await page.request.post('/api/design-files', {data: {name: 'Team retro', teamId, kind: 'board'}});
  expect(created.status()).toBe(201);
  const boardId = ((await created.json()) as {file: {id: string}}).file.id;
  const lev = await person(browser, baseURL!, 'lev', 'Leo');
  await page.goto('/#design/' + boardId);
  await page.getByRole('button', {name: 'Share', exact: true}).click();
  const share = page.getByRole('dialog', {name: 'Share "Team retro"'});
  const team = share.getByRole('list', {name: 'People with access'}).locator('.dz-member').filter({hasText: 'Team "Retro"'});
  await expect(team).toContainText('1 member — by their roles in the team');
  // Someone outside the team gets the board only through its link. Given editing, Lev edits it.
  expect(await opened(lev.page, boardId)).toBe(404);
  await share.getByRole('button', {name: 'Link access', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'Anyone with the link can edit'}).click();
  // The menu choice is saved by a request of its own: Lev's view of the board follows it.
  await expect.poll(async () => ((await (await lev.page.request.get('/api/design-files/' + boardId)).json()) as {access?: unknown}).access)
    .toEqual({role: 'editor', canEdit: true, team: null, guest: true});
  expect((await lev.page.request.get(`/api/design-teams/${teamId}/members`)).status()).toBe(404);
  // The team's people, from the dialog, and back.
  await team.getByRole('button', {name: 'Members', exact: true}).click();
  const members = page.getByRole('dialog', {name: 'Members · Retro'});
  await expect(members.locator('.dz-member')).toHaveCount(1);
  await members.getByRole('button', {name: 'Back to board access'}).click();
  await expect(share).toBeVisible();
  await share.getByRole('button', {name: 'Done', exact: true}).click();
  await expect(share).toHaveCount(0);
  await lev.context.close();
});
