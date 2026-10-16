import type {Page} from '@playwright/test';
import {test, expect} from './fixtures';

// Several files at once, as Figma's file browser (docs/figma-parity-shell.md): a click selects one, ⌘/Ctrl-click adds,
// Shift-click selects a run, ⌘A all, Escape or a click on the empty space none; a right click inside the selection shows
// the menu of all of them; Delete sends them all to the trash, and the toast's "Undo" brings them back.

async function makeFiles(page: Page, names: string[]) {
  for (const name of names) expect((await page.request.post('/api/design-files', {data: {name}})).ok()).toBeTruthy();
}

const card = (page: Page, name: string) => page.locator('.dz-file').filter({hasText: name});
const selectedNames = (page: Page) => page.locator('.dz-file.is-selected .dz-file-name').allTextContents();

test('should select several files with the command and shift keys and act on all of them from one menu', async ({page, seed: _seed}) => {
  await makeFiles(page, ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'File type'}).waitFor();
  await page.getByRole('button', {name: 'Sort'}).click();
  await page.getByRole('menuitemradio', {name: 'Name'}).click();

  await card(page, 'Alpha').locator('.dz-file-hit').click();
  await card(page, 'Charlie').locator('.dz-file-hit').click({modifiers: ['Shift']});
  expect(await selectedNames(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await card(page, 'Bravo').locator('.dz-file-hit').click({modifiers: ['ControlOrMeta']});
  expect(await selectedNames(page)).toEqual(['Alpha', 'Charlie']);
  await card(page, 'Delta').locator('.dz-file-hit').click({modifiers: ['ControlOrMeta']});
  expect(await selectedNames(page)).toEqual(['Alpha', 'Charlie', 'Delta']);
  // ⌘-click no longer opens a tab: it selects. The page stays.
  await expect(page).toHaveURL(/#designs$/);

  // The shared menu: how many, and what all of them allow.
  await card(page, 'Charlie').click({button: 'right'});
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Selected: 3 files')).toBeVisible();
  await menu.getByRole('menuitem', {name: 'Duplicate 3 files'}).click();
  await expect(page.locator('.dz-file')).toHaveCount(7);

  // A right click outside the selection is that file's own menu.
  await card(page, 'Alpha').first().locator('.dz-file-hit').click();
  await card(page, 'Bravo').first().locator('.dz-file-hit').click({modifiers: ['ControlOrMeta']});
  await card(page, 'Delta').first().click({button: 'right'});
  await expect(page.getByRole('menuitem', {name: 'Rename', exact: true})).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await selectedNames(page)).toEqual(['Delta']);
});

test('should select every file with command A, none with Escape or a click between them', async ({page, seed: _seed}) => {
  await makeFiles(page, ['One', 'Two', 'Three']);
  await page.goto('/#designs');
  await card(page, 'One').locator('.dz-file-hit').click();
  await page.keyboard.press('ControlOrMeta+a');
  expect(await selectedNames(page)).toHaveLength(3);
  await page.keyboard.press('Escape');
  expect(await selectedNames(page)).toHaveLength(0);

  await page.keyboard.press('ControlOrMeta+a');
  expect(await selectedNames(page)).toHaveLength(3);
  const content = (await page.locator('.dz-files-content').boundingBox())!;
  await page.mouse.click(content.x + content.width - 20, content.y + content.height - 20);
  expect(await selectedNames(page)).toHaveLength(0);
});

test('should trash the selected files with Delete and bring them back from the toast', async ({page, seed: _seed}) => {
  await makeFiles(page, ['First', 'Second', 'Third']);
  await page.goto('/#designs');
  await card(page, 'First').locator('.dz-file-hit').click();
  await card(page, 'Second').locator('.dz-file-hit').click({modifiers: ['ControlOrMeta']});
  await page.keyboard.press('Delete');
  await expect(page.locator('.dz-file')).toHaveCount(1);
  const toast = page.locator('.dz-toast').filter({hasText: 'Moved to the trash: 2 files'});
  await expect(toast).toBeVisible();
  await toast.getByRole('button', {name: 'Undo'}).click();
  await expect(page.locator('.dz-file')).toHaveCount(3);

  // In the trash: restore two at once.
  await card(page, 'First').locator('.dz-file-hit').click();
  await card(page, 'Third').locator('.dz-file-hit').click({modifiers: ['ControlOrMeta']});
  await page.keyboard.press('Delete');
  await expect(page.locator('.dz-file')).toHaveCount(1);
  await page.getByRole('button', {name: 'Trash', exact: true}).click();
  await expect(page.locator('.dz-file')).toHaveCount(2);
  await card(page, 'Third').locator('.dz-file-hit').click();
  await page.keyboard.press('ControlOrMeta+a');
  await card(page, 'First').click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Restore 2 files'}).click();
  await expect(page.locator('.dz-file')).toHaveCount(0);
});

test('should select the cards a box drawn from the empty space touches, and add to them with shift', async ({page, seed: _seed}) => {
  await makeFiles(page, ['One', 'Two', 'Three', 'Four']);
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'Sort'}).click();
  await page.getByRole('menuitemradio', {name: 'Name'}).click();
  // One row, by name: Four, One, Three, Two; empty space to its right.
  const content = (await page.locator('.dz-files-content').boundingBox())!;
  const middle = async (name: string) => {
    const box = (await card(page, name).boundingBox())!;
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
  };
  const sweep = async (to: {x: number; y: number}, shift = false) => {
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(content.x + content.width - 8, to.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y + 10, {steps: 8});
    await expect(page.locator('.dz-marquee')).toBeVisible();
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  };

  await sweep(await middle('Three'));
  await expect(page.locator('.dz-marquee')).toHaveCount(0);
  expect(await selectedNames(page)).toEqual(['Three', 'Two']);

  // Shift keeps what was selected and adds what the new box touches.
  await card(page, 'Four').locator('.dz-file-hit').click({modifiers: ['ControlOrMeta']});
  expect(await selectedNames(page)).toEqual(['Four', 'Three', 'Two']);
  await sweep(await middle('One'), true);
  expect(await selectedNames(page)).toEqual(['Four', 'One', 'Three', 'Two']);

  // A click on the empty space clears.
  await page.mouse.click(content.x + content.width - 8, content.y + content.height - 8);
  expect(await selectedNames(page)).toHaveLength(0);
});
