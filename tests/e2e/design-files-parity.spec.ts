import {test, expect} from './fixtures';

// The file browser on a desktop, as Figma's (docs/figma-parity-shell.md): the account menu with the theme and "Sign out", the
// kind filter beside the sort, and "Share…" and "Copy link" in a file's menu.

test.use({permissions: ['clipboard-read', 'clipboard-write']});

test('should hold the theme and the sign-out in the account menu when the account button is pressed', async ({page, seed}) => {
  await page.goto('/#designs');
  // The button names the account once the session is read; the menu is built when it opens.
  await expect(page.locator('.dz-account-name')).not.toHaveText('Account');
  await page.getByRole('button', {name: 'Account', exact: true}).click();
  const menu = page.getByRole('menu', {name: 'Account'});
  // Sign-in is by name: the button names the account (the fixture's default name) and the menu holds no address, a synthetic one least of all.
  await expect(page.locator('.dz-account-name')).toHaveText('Browser check');
  await expect(menu.getByText(seed.email)).toHaveCount(0);
  await menu.getByRole('menuitem', {name: 'Theme'}).click();
  await page.getByRole('menuitemradio', {name: 'Dark'}).click();
  await expect(page.locator('.dz.dz-root')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', {name: 'Account', exact: true}).click();
  await expect(page.getByRole('menuitem', {name: 'Sign out', exact: true})).toBeVisible();
});

test('should show only the boards when the kind filter asks for boards', async ({page, seed: _seed}) => {
  await page.request.post('/api/design-files', {data: {name: 'Design'}});
  await page.request.post('/api/design-files', {data: {name: 'Standup', kind: 'board'}});
  await page.goto('/#designs');
  await expect(page.locator('.dz-file')).toHaveCount(2);

  await page.getByRole('button', {name: 'File type'}).click();
  await page.getByRole('menuitemradio', {name: 'Boards'}).click();
  await expect(page.locator('.dz-file')).toHaveCount(1);
  await expect(page.locator('.dz-file')).toContainText('Standup');

  // The choice is remembered, like the sort and the view.
  await page.reload();
  await expect(page.locator('.dz-file')).toHaveCount(1);
  await page.getByRole('button', {name: 'File type'}).click();
  await page.getByRole('menuitemradio', {name: 'All files'}).click();
  await expect(page.locator('.dz-file')).toHaveCount(2);
});

test('should share a file and copy its link when its menu is used', async ({page, seed: _seed}) => {
  const created = await (await page.request.post('/api/design-files', {data: {name: 'Shared design'}})).json() as {file: {id: string}};
  await page.goto('/#designs');
  const card = page.locator('.dz-file').filter({hasText: 'Shared design'});

  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Copy link', exact: true}).click();
  await expect(page.getByRole('status').or(page.locator('.dz-toast')).filter({hasText: 'Link copied'})).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('#design/' + created.file.id);

  await card.getByRole('button', {name: 'File actions'}).click();
  await page.getByRole('menuitem', {name: 'Share…', exact: true}).click();
  const share = page.getByRole('dialog', {name: 'Share "Shared design"'});
  await expect(share).toBeVisible();
  // Figma's dialog: "Copy link" in the header beside ×.
  await expect(share.locator('.dz-dialog-header').getByRole('button', {name: 'Copy link'})).toBeVisible();
  await share.getByRole('button', {name: 'Close', exact: true}).click();
  await expect(share).toBeHidden();
});

test.describe('on a tablet', () => {
  test.use({viewport: {width: 768, height: 1024}, hasTouch: true});

  test('should keep the sidebar and the top bar inside their columns when the window is 768 px wide', async ({page, seed: _seed}) => {
    await page.goto('/#designs');
    await expect(page.locator('.dz-files-sidebar')).toBeVisible();
    const spill = await page.evaluate(() => {
      const outside = (column: Element) => {
        const edge = column.getBoundingClientRect().right + 0.5;
        return [...column.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > edge).map(element => element.className.toString());
      };
      const top = document.querySelector('.dz-files-top')!;
      return {sidebar: outside(document.querySelector('.dz-files-sidebar')!), top: top.scrollWidth - top.clientWidth, page: document.documentElement.scrollWidth - innerWidth};
    });
    expect(spill).toEqual({sidebar: [], top: 0, page: 0});
    expect((await page.getByRole('searchbox', {name: 'Search files'}).boundingBox())!.width).toBeGreaterThanOrEqual(100);
  });
});

test('should put the file opened last first when the sort is by viewing', async ({page, seed: _seed}) => {
  for (const name of ['Old', 'Middle', 'New']) await page.request.post('/api/design-files', {data: {name}});
  await page.goto('/#designs');
  await page.locator('.dz-file').filter({hasText: 'Old'}).locator('.dz-file-hit').dblclick();
  await expect(page).toHaveURL(/#design\//);
  await page.goBack();
  await page.getByRole('button', {name: 'Sort'}).click();
  await page.getByRole('menuitemradio', {name: 'Last viewed'}).click();
  await expect(page.locator('.dz-file-name').first()).toHaveText('Old');
});

test('should sort the list by a column when its heading is clicked and name the trash column "Deleted"', async ({page, seed: _seed}) => {
  for (const name of ['Beta', 'Alpha']) await page.request.post('/api/design-files', {data: {name}});
  await page.goto('/#designs');
  await page.getByRole('radio', {name: 'List'}).click();
  await page.locator('.dz-files-head-cell').filter({hasText: 'Name'}).click();
  await expect(page.locator('.dz-file-name')).toHaveText(['Alpha', 'Beta']);
  await expect(page.getByRole('button', {name: 'Sort'})).toHaveText(/Name/);

  await page.locator('.dz-file').first().locator('.dz-file-hit').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.getByRole('button', {name: 'Trash', exact: true}).click();
  await expect(page.locator('.dz-files-head-cell').filter({hasText: 'Deleted'})).toBeVisible();
  await page.getByRole('button', {name: 'Sort'}).click();
  await expect(page.getByRole('menuitemradio', {name: 'Deleted'})).toBeVisible();
});

test('should show the list with Figma\'s large pictures and quiet headings', async ({page, seed: _seed}) => {
  await page.request.post('/api/design-files', {data: {name: 'Design'}});
  await page.goto('/#designs');
  await page.getByRole('radio', {name: 'List'}).click();
  const row = page.locator('.dz-files.is-list .dz-file').first();
  await expect(row).toBeVisible();
  expect(Math.round((await row.locator('.dz-file-thumb').boundingBox())!.width)).toBe(112);
  expect(Math.round((await row.boundingBox())!.height)).toBe(84);
  await expect(row.locator('.dz-file-name')).toHaveCSS('font-size', '13px');
  await expect(page.locator('.dz-files-head')).toHaveCSS('border-bottom-width', '0px');
});
