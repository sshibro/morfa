import {randomBytes} from 'node:crypto';
import {test, expect} from './fixtures';
import type {Browser, Page} from '@playwright/test';

// Morfa Design teams and comments, the paths between screens (docs/design-tool.md §Teams): a project made from the sidebar opens; a
// revoked link leaves the dialog; an invite accepted lands in its team; a member removed while the browser
// shows the team goes back to personal files; a comment's link opened signed out opens the thread after sign-in.
// Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

/** Another signed-in account in its own browser context, with a display name. */
async function account(browser: Browser, page: Page, baseURL: string, name: string) {
  const response = await page.request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {}});
  expect(response.ok(), 'An isolated account').toBeTruthy();
  const seed = (await response.json()) as {token: string; accountId: string};
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}});
  await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL, httpOnly: true, sameSite: 'Lax'}]);
  const opened = await context.newPage();
  expect((await opened.request.put('/api/settings', {data: {name, workspace: 'Studio'}})).ok()).toBeTruthy();
  return {context, page: opened, id: seed.accountId};
}
const invite = async (page: Page, teamId: string, role: string) =>
  ((await (await page.request.post(`/api/design-teams/${teamId}/invites`, {data: {role, days: 7, maxUses: 1}})).json()) as {token: string}).token;

test('teams: a new project opens, a revoked link goes, a joined team opens, a removed member falls back', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(150_000);
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith', workspace: 'Studio'}})).ok()).toBeTruthy();
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'North Studio'}})).json()) as {team: {id: string}}).team.id;
  const boris = await account(browser, page, baseURL!, 'Boris Petrov');
  expect((await boris.page.request.post(`/api/design-teams/invites/${await invite(page, teamId, 'editor')}/accept`)).ok()).toBeTruthy();

  // ── "New project" from the team's sidebar section opens the new project ──
  await page.goto('/#designs');
  const section = page.getByRole('group', {name: 'North Studio'});
  await section.getByRole('button', {name: 'All files'}).click();
  await expect(page.locator('.dz-files-eyebrow')).toContainText('Owner');
  await section.getByRole('button', {name: 'New project'}).click();
  await page.getByRole('textbox', {name: 'Project name'}).fill('Landing');
  await page.getByRole('button', {name: 'Create', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Landing', exact: true})).toBeVisible();
  await expect(section.getByRole('button', {name: 'Landing'})).toHaveAttribute('aria-current', 'page');

  // ── Members: two editors ──
  await section.getByRole('button', {name: 'Team'}).click();
  await page.getByRole('menuitem', {name: 'Members', exact: true}).click();
  const members = page.getByRole('dialog', {name: /Members/});
  await expect(members.locator('.dz-member')).toHaveCount(2);
  // A link made (one click, copied) and revoked: it leaves the dialog with its row, nothing left to copy.
  await members.getByRole('button', {name: 'Copy link', exact: true}).click();
  const linkField = members.getByRole('textbox', {name: 'Invite link'});
  await expect(linkField).toHaveValue(/designInvite=/);
  const editorLink = await linkField.inputValue();
  await expect(members.locator('.dz-invite-row')).toHaveCount(1);
  await members.locator('.dz-invite-row').getByRole('button', {name: 'Revoke'}).click();
  await expect(members.locator('.dz-invite-row')).toHaveCount(0);
  await expect(linkField).toHaveCount(0);
  await expect(members.getByRole('button', {name: 'Copied'})).toHaveCount(0);
  await members.getByRole('button', {name: 'Done'}).click();

  // ── Vera opens the revoked link, then a developer link: she lands in the team ──
  const vera = await account(browser, page, baseURL!, 'Vera Fox');
  await vera.page.goto(editorLink.replace(/^https?:\/\/[^/]+/, ''));
  await expect(vera.page.getByRole('dialog', {name: 'Invitation is no longer valid'})).toBeVisible();
  await vera.page.getByRole('button', {name: 'Got it'}).click();
  await vera.page.goto(`/?designInvite=${await invite(page, teamId, 'developer')}#designs`);
  const landing = vera.page.getByRole('dialog', {name: 'Team invitation'});
  await landing.getByRole('button', {name: 'Join'}).click();
  await expect(vera.page.locator('.dz-files-eyebrow')).toContainText('Developer');
  await expect(vera.page.getByRole('heading', {name: 'All files', exact: true})).toBeVisible();
  await expect(vera.page.getByText('You are in the team "North Studio"')).toBeVisible();
  // Into a file and back to the files in the same page load: the invite she accepted does not greet her again.
  const own = ((await (await vera.page.request.post('/api/design-files', {data: {name: 'My mockup'}})).json()) as {file: {id: string}}).file.id;
  await vera.page.goto('/#design/' + own);
  await expect(vera.page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await vera.page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await vera.page.getByRole('menuitem', {name: 'Back to files', exact: true}).click();
  await expect(vera.page.locator('.dz-files-main')).toBeVisible();
  await vera.page.waitForTimeout(500);
  await expect(vera.page.getByRole('dialog', {name: 'Team invitation'})).toHaveCount(0);
  await vera.page.getByRole('group', {name: 'North Studio'}).getByRole('button', {name: 'All files'}).click();
  await expect(vera.page.locator('.dz-files-eyebrow')).toContainText('Developer');

  // ── Vera, a developer, has a team file open with "Code"; made a viewer, the open file turns to the viewer's note at once. Made an
  // admin and back, Boris's open file is not reloaded under him ──
  const shared = ((await (await page.request.post('/api/design-files', {data: {name: 'Shared mockup', teamId}})).json()) as {file: {id: string}}).file.id;
  await vera.page.goto('/#design/' + shared);
  await expect(vera.page.getByRole('status').filter({hasText: 'View only'})).toBeVisible();
  await vera.page.getByRole('tab', {name: 'Code', exact: true}).click();
  await expect(vera.page.getByText(/Code is available to developers/)).toHaveCount(0);
  await boris.page.goto('/#design/' + shared);
  await expect(boris.page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await expect(boris.page.getByRole('group', {name: 'People in this file'})).toBeVisible();
  expect((await page.request.patch(`/api/design-teams/${teamId}/members/${vera.id}`, {data: {role: 'viewer'}})).ok()).toBeTruthy();
  await expect(vera.page.getByText('Your team role is now "Viewer".')).toBeVisible();
  await vera.page.getByRole('tab', {name: 'Code', exact: true}).click();
  await expect(vera.page.getByText(/Code is available to developers/)).toBeVisible();
  const borisId = ((await (await page.request.get(`/api/design-teams/${teamId}/members`)).json()) as {members: {userId: string; name: string}[]}).members.find(member => member.name === 'Boris Petrov')!.userId;
  expect((await page.request.patch(`/api/design-teams/${teamId}/members/${borisId}`, {data: {role: 'admin'}})).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/design-teams/${teamId}/members/${borisId}`, {data: {role: 'editor'}})).ok()).toBeTruthy();
  await boris.page.waitForTimeout(1500);
  await expect(boris.page.getByText(/Your team role is now/)).toHaveCount(0);
  await expect(boris.page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await vera.page.goto('/#designs');
  await vera.page.getByRole('group', {name: 'North Studio'}).getByRole('button', {name: 'All files'}).click();
  await expect(vera.page.locator('.dz-files-eyebrow')).toContainText('Viewer');

  // ── Vera removed while her browser shows the team: the next look at it goes back to her own files ──
  expect((await page.request.delete(`/api/design-teams/${teamId}/members/${vera.id}`)).ok()).toBeTruthy();
  await vera.page.getByRole('group', {name: 'North Studio'}).getByRole('button', {name: 'Trash'}).click();
  await expect(vera.page.getByText('You no longer have access to this team.')).toBeVisible();
  await expect(vera.page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();
  await expect(vera.page.getByRole('group', {name: 'North Studio'})).toHaveCount(0);
  await expect(vera.page.getByText('Could not load files')).toHaveCount(0);
  await vera.context.close();
  await boris.context.close();
});

test('a comment’s link opened signed out opens the file at its thread after sign-in', async ({page, browser, baseURL}) => {
  // The person, signed in by name in another browser,
  // has a file with a thread. This page has no session.
  const name = `link ${randomBytes(4).toString('hex')}`;
  const owner = await browser.newContext({baseURL});
  expect((await owner.request.post('/api/auth/name', {data: {name}})).ok(), 'The name sign-in').toBeTruthy();
  const created = await owner.request.post('/api/design-files', {data: {name: 'Link to the discussion'}});
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as {file: {id: string}}).file.id;
  const opened = (await (await owner.request.get('/api/design-files/' + fileId)).json()) as {document: {pages: string[]}};
  const thread = await owner.request.post(`/api/design-files/${fileId}/comments`, {data: {anchor: {pageId: opened.document.pages[0], x: 120, y: 80, nodeId: null, offset: null}, text: 'Check the spacing', mentions: []}});
  expect(thread.status()).toBe(201);
  const threadId = ((await thread.json()) as {thread: {id: string}}).thread.id;

  // Signed out: the link shows the sign-in screen and keeps its address.
  await page.goto(`/#design/${fileId}?comment=${threadId}`);
  await expect(page.getByRole('heading', {name: 'Welcome to Morfa', exact: true})).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#design/${fileId}\\?comment=${threadId}$`));
  // The same person signs in on that screen: the file opens at its thread.
  await page.getByRole('textbox', {name: 'Your name'}).fill(name);
  await page.getByRole('button', {name: 'Continue'}).click();
  await expect(page).toHaveURL(new RegExp(`#design/${fileId}\\?comment=${threadId}$`));
  const card = page.getByRole('dialog', {name: 'Thread'});
  await expect(card).toBeVisible();
  await expect(card).toContainText('Check the spacing');
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Comment', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await owner.close();
});
