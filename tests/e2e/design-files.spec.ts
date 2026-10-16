import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// Morfa: the file browser and the editor route (docs/design-tool.md), inside Morfa's shell (src/App.tsx): every address that
// is not a file is the file browser's, and "Sign out" signs out to the sign-in screen (src/auth).

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function savedName(page: Page, id: string) {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as {file: {name: string}}).file.name;
}

test('a new design file is created, renamed in the editor and in the browser, opened and left', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();
  await expect(page.locator('.dz.dz-root')).toBeVisible();

  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  await expect(page.getByRole('button', {name: 'Main menu', exact: true})).toBeVisible();
  await expect(page.getByRole('tab', {name: 'Design', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('toolbar', {name: 'Tools'})).toBeVisible();

  // Rename in the title of the left panel.
  await page.locator('.dz-file-name').click();
  const title = page.getByRole('textbox', {name: 'File name', exact: true});
  await title.fill('Test mockup');
  await title.press('Enter');
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await expect.poll(() => savedName(page, id)).toBe('Test mockup');

  // ⌘\ hides the interface and Escape brings it back.
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(page.getByRole('toolbar', {name: 'Tools'})).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', {name: 'Tools'})).toBeVisible();

  // Back to the files through the main menu.
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Back to files', exact: true}).click();
  await expect(page).toHaveURL(/#designs$/);
  const card = page.locator('.dz-file').filter({hasText: 'Test mockup'});
  await expect(card).toBeVisible();

  // Rename from the card's context menu.
  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Rename', exact: true}).click();
  const inline = page.getByRole('textbox', {name: 'New file name', exact: true});
  await inline.fill('Test mockup 2');
  await inline.press('Enter');
  await expect(page.locator('.dz-file').filter({hasText: 'Test mockup 2'})).toBeVisible();
  await expect.poll(() => savedName(page, id)).toBe('Test mockup 2');

  // Double-click opens; the browser's Back returns to the files; "Sign out" in the account's menu signs out and leaves the area.
  await page.locator('.dz-file').filter({hasText: 'Test mockup 2'}).locator('.dz-file-hit').dblclick();
  await expect(page).toHaveURL(new RegExp('#design/' + encodeURIComponent(id) + '$'));
  await expect(page.locator('.dz-file-name')).toHaveText('Test mockup 2');
  await page.goBack();
  await expect(page).toHaveURL(/#designs$/);
  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Account', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Sign out', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Welcome to Morfa', exact: true})).toBeVisible();
  await expect(page.locator('.dz.dz-root')).toHaveCount(0);
  expect(await (await page.request.get('/api/auth/me')).json()).toBeNull();
});

test('the server enables the tool, an address that is not a file opens the files, and a missing file explains itself', async ({page, seed: _seed}) => {
  const config = await (await page.request.get('/api/config')).json() as {designTool?: boolean};
  expect(config.designTool).toBe(true);
  // An old address (#sites) of a page Morfa does not have: only the files are there.
  await page.goto('/#sites');
  await expect(page).toHaveURL(/#designs$/);
  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();

  await page.goto('/#design/no-such-file');
  await expect(page.getByRole('heading', {name: 'File not found', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Back to files', exact: true}).click();
  await expect(page).toHaveURL(/#designs$/);
});

test('a file address set while the session is still loading opens that file', async ({page, seed: _seed}) => {
  // The address listeners attach once the session is read (src/App.tsx); a change before that must not be lost.
  let release = () => {};
  const held = new Promise<void>(resolve => (release = resolve));
  await page.route('**/api/auth/me', async route => {
    await held;
    await route.continue();
  });
  await page.goto('/#designs');
  const response = await page.request.post('/api/design-files', {headers: {Origin: new URL(page.url()).origin}, data: {name: 'Link on load'}});
  expect(response.ok(), await response.text()).toBeTruthy();
  const {file} = (await response.json()) as {file: {id: string}};
  await page.evaluate(id => {
    location.hash = '#design/' + id;
  }, file.id);
  release();
  await expect(page).toHaveTitle('Link on load — Design');
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
});

test('files go to the trash, come back, and are erased only after confirmation', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Back to files', exact: true}).click();

  const card = page.locator('.dz-file').filter({has: page.locator(`a[href="#design/${encodeURIComponent(id)}"]`)});
  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Move to trash', exact: true}).click();
  await expect(card).toHaveCount(0);

  await page.getByRole('button', {name: 'Trash', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Trash', exact: true})).toBeVisible();
  await expect(card).toBeVisible();
  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Restore', exact: true}).click();
  await expect(card).toHaveCount(0);

  await page.getByRole('button', {name: 'Recent', exact: true}).click();
  await expect(card).toBeVisible();
  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Move to trash', exact: true}).click();
  await page.getByRole('button', {name: 'Trash', exact: true}).click();
  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Delete permanently', exact: true}).click();
  const confirm = page.getByRole('dialog', {name: 'Delete permanently?'});
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', {name: 'Delete', exact: true}).click();
  await expect(card).toHaveCount(0);
  expect((await page.request.get('/api/design-files/' + encodeURIComponent(id))).status()).toBe(404);
});
