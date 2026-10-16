import {test, expect} from './fixtures';

// "Duplicate to personal files" in the trash, Figma's "Duplicate to drafts" (docs/figma-parity-shell.md; lane S's
// POST /api/design-files/:id/duplicate-to-drafts): a copy of a trashed file appears in the personal files and opens from the
// toast; the trashed file stays in the trash.

test('should copy a trashed file into the personal files and leave it in the trash', async ({page, seed: _seed}) => {
  const created = await (await page.request.post('/api/design-files', {data: {name: 'Old version'}})).json() as {file: {id: string}};
  expect((await page.request.delete('/api/design-files/' + created.file.id)).ok()).toBeTruthy();
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'Trash', exact: true}).click();
  const trashed = page.locator('.dz-file').filter({hasText: 'Old version'});
  await trashed.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Duplicate to personal files'}).click();
  const toast = page.locator('.dz-toast').filter({hasText: 'Copy of "Old version" in your personal files'});
  await expect(toast).toBeVisible();
  await expect(trashed).toBeVisible();

  await page.getByRole('button', {name: 'Recent', exact: true}).click();
  await expect(page.locator('.dz-file')).toHaveCount(1);
  await toast.getByRole('button', {name: 'Open'}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  expect(page.url()).not.toContain(created.file.id);
});
