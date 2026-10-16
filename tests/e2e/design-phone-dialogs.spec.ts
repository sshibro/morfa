import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import {Fingers, nodesOf, openNewPhoneFile, PHONE, pickTool, savedFile, shot} from './phone';

// Menus, pickers and dialogs of the design editor on a phone: each opens from its touch path and lies inside the 390 × 844 screen, nothing sideways.

test.use(PHONE);

const SCREEN = PHONE.viewport;

async function expectInside(page: Page, name: string, role: 'dialog' | 'search' | 'complementary' = 'dialog') {
  const dialogs = role === 'complementary' ? page.getByRole(role, {name: 'Version history'}) : page.getByRole(role);
  await expect(dialogs.first()).toBeVisible();
  // Sheets slide in from the bottom: measure once they have settled.
  await expect.poll(async () => {
    const outside: string[] = [];
    for (const dialog of await dialogs.all()) {
      if (!(await dialog.isVisible())) continue;
      const box = (await dialog.boundingBox())!;
      if (box.x < -0.5 || box.x + box.width > SCREEN.width + 0.5 || box.y + box.height > SCREEN.height + 0.5)
        outside.push(`${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`);
    }
    return outside;
  }, {message: `${name}: inside the screen`}).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${name}: no sideways scroll`).toBeLessThanOrEqual(0);
}

async function fromMenu(page: Page, path: (string | RegExp)[]) {
  await page.getByRole('button', {name: 'Main menu', exact: true}).tap();
  for (const step of path) await page.getByRole('menuitem', {name: step}).first().tap();
}

test('should fit the colour picker and the font picker on the screen when they open from the "Properties" sheet', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await pickTool(page, 'Rectangle');
  await fingers.drag([{x: 120, y: 200}], [{x: 220, y: 280}]);
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(1);
  await page.getByRole('button', {name: 'Properties', exact: true}).tap();
  await page.getByRole('dialog', {name: 'Properties'}).locator('.dz-paint-swatch').first().tap();
  await expectInside(page, 'colour picker');
  await shot(page, 'editor-colour-picker');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', {name: 'Properties'}).getByRole('button', {name: 'Close'}).tap();

  await pickTool(page, 'Text');
  await fingers.tap({x: 100, y: 450});
  await page.keyboard.type('Font');
  await page.keyboard.press('Escape');
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'TEXT').length).toBe(1);
  await page.getByRole('button', {name: 'Properties', exact: true}).tap();
  await page.getByRole('dialog', {name: 'Properties'}).getByRole('button', {name: 'Font', exact: true}).tap();
  await expectInside(page, 'font picker');
  await shot(page, 'editor-font-picker');
});

test('should fit export, find, shortcuts and versions on the screen when they open from the main menu', async ({page, seed: _seed}) => {
  await openNewPhoneFile(page);
  const cases: [string, (string | RegExp)[], ('dialog' | 'search' | 'complementary')?][] = [
    ['export', [/^File$/, /^Export…/]],
    ['find', [/^Edit$/, /^Find and replace/], 'search'],
    ['versions', [/^File$/, /^Version history/], 'complementary'],
    ['shortcuts', [/^Help$/, /Keyboard shortcuts/]],
  ];
  for (const [name, path, role] of cases) {
    await fromMenu(page, path);
    await expectInside(page, name, role);
    if (role === 'search') {
      const box = (await page.getByRole('search').boundingBox())!;
      const bar = (await page.getByRole('toolbar', {name: 'File', exact: true}).boundingBox())!;
      expect(box.y, 'find: below the top bar').toBeGreaterThanOrEqual(bar.y + bar.height);
    }
    await shot(page, `editor-${name}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(role === 'complementary' ? page.getByRole(role, {name: 'Version history'}) : page.getByRole(role ?? 'dialog')).toHaveCount(0);
  }
});

test('should keep the auto layout section and the interaction popover inside the screen in the "Properties" sheet', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await pickTool(page, 'Frame');
  await fingers.drag([{x: 60, y: 200}], [{x: 300, y: 500}]);
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'FRAME').length).toBe(1);
  await fromMenu(page, [/^Object$/, /Add auto layout/]);
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'FRAME')[0].autoLayout?.layoutMode ?? 'NONE').not.toBe('NONE');
  await page.getByRole('button', {name: 'Properties', exact: true}).tap();
  const sheet = page.getByRole('dialog', {name: 'Properties'});
  const section = sheet.locator('.dz-section', {hasText: 'Auto layout'}).first();
  await section.scrollIntoViewIfNeeded();
  const box = (await section.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(SCREEN.width);
  expect(await section.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await sheet.getByRole('tab', {name: 'Prototype'}).tap();
  await sheet.getByRole('button', {name: 'Add interaction'}).tap();
  await expectInside(page, 'interaction popover');
});
