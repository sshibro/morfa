import {test, expect} from './fixtures';

// The file browser by keyboard alone and without a network: what a screen reader is told, where the
// focus goes, what Escape does, and plain words when the network is gone.

test('should say in plain words that the network is gone and read the files again when it is back', async ({page, seed: _seed}) => {
  await page.request.post('/api/design-files', {data: {name: 'Alpha'}});
  await page.goto('/#designs');
  await expect(page.locator('.dz-file')).toHaveCount(1);

  await page.context().setOffline(true);
  const banner = page.locator('.dz-banner.is-offline');
  await expect(banner).toHaveText(/No internet connection/);
  await expect(banner).toHaveAttribute('role', 'status');
  await page.locator('.dz-files-actions').getByRole('button', {name: 'New file', exact: true}).click();
  await expect(page.locator('.dz-toast').filter({hasText: 'No internet connection'})).toBeVisible();
  await expect(page.locator('.dz-toast').filter({hasText: /fetch/i})).toHaveCount(0);

  await page.request.post('/api/design-files', {data: {name: 'Beta'}});
  await page.context().setOffline(false);
  await expect(banner).toHaveCount(0);
  await expect(page.locator('.dz-file')).toHaveCount(2);
});

test('should name a file\'s menu after the file for a screen reader', async ({page, seed: _seed}) => {
  await page.request.post('/api/design-files', {data: {name: 'Alpha'}});
  await page.goto('/#designs');
  await page.locator('.dz-file-hit').first().focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', {name: 'File actions "Alpha"'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dz-file-hit').first()).toBeFocused();
});

test('should keep the focus in the list when Delete trashes the focused file', async ({page, seed: _seed}) => {
  for (const name of ['Second', 'First']) await page.request.post('/api/design-files', {data: {name}});
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'Sort'}).click();
  await page.getByRole('menuitemradio', {name: 'Name'}).click();
  await expect(page.locator('.dz-file-name')).toHaveText(['First', 'Second']);

  await page.locator('.dz-file-hit').first().focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.dz-file')).toHaveCount(1);
  await expect(page.locator('.dz-file').filter({hasText: 'Second'}).locator('.dz-file-hit')).toBeFocused();

  await page.keyboard.press('Delete');
  await expect(page.locator('.dz-empty')).toBeVisible();
  await expect(page.locator('.dz-files-content .dz-empty button').first()).toBeFocused();
});

test('should close the team dialog with one Escape from its field and make no team', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'Create team'}).click();
  const dialog = page.getByRole('dialog', {name: 'Create team'});
  await dialog.getByRole('textbox', {name: 'Team name'}).fill('Studio');
  await expect(dialog.getByRole('textbox', {name: 'Team name'})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', {name: 'Create team'})).toBeFocused();
  expect((await (await page.request.get('/api/design-teams')).json()).teams ?? []).toEqual([]);
});
