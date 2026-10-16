import {randomBytes} from 'node:crypto';
import type {Locator, Page} from '@playwright/test';
import {test, expect} from './fixtures';
import {PHONE, auditPhone} from './phone-audit';

// The shell on a phone: the sign-in, the file browser and its dialogs at 390 × 844 with touch.
// No screen scrolls sideways or puts a control under a thumb's 44 px, every dialog and menu is a sheet that fits the screen,
// and a person gets from the sign-in to a shared, renamed and deleted file by touch alone.

test.use(PHONE);

const personName = () => `phone ${randomBytes(4).toString('hex')}`;

/** Nothing sideways, nothing under 44 px, nothing past an edge (once what slides in has arrived). */
async function expectFits(page: Page, scope?: string) {
  await expect.poll(() => auditPhone(page, scope), {message: `the screen at ${scope ?? 'body'}`}).toEqual({overflow: 0, small: [], offscreen: []});
}

/** A sheet: the screen's whole width, resting on its bottom edge (once its entrance has run), its top on the screen. */
async function expectSheet(page: Page, sheet: Locator) {
  const viewport = page.viewportSize()!;
  await expect.poll(async () => {
    const box = (await sheet.boundingBox())!;
    return {x: box.x, width: Math.round(box.width), bottom: Math.round(box.y + box.height), onScreen: box.y > 0};
  }).toEqual({x: 0, width: viewport.width, bottom: viewport.height, onScreen: true});
}

/** Holds a finger on an element for `ms`, as a long press does (Playwright's touchscreen only taps). */
async function hold(page: Page, target: Locator, ms = 700) {
  const box = (await target.boundingBox())!;
  const point = {x: box.x + box.width / 2, y: box.y + box.height / 2};
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [point]});
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await cdp.detach();
}

/** Drags a finger from the middle of `target` down by `distance` px. */
async function swipeDown(page: Page, target: Locator, distance: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
  for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y: y + (distance * step) / 8}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await cdp.detach();
  // Chromium's gesture detector swallows the click of a tap that follows a fling at once; a person's next tap comes later.
  await page.waitForTimeout(600);
}

async function makeFiles(page: Page, names: string[]) {
  for (const name of names) expect((await page.request.post('/api/design-files', {data: {name}})).ok()).toBeTruthy();
}

test('should fit the sign-in screen when a phone opens it', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Welcome to Morfa', exact: true})).toBeVisible();
  await expectFits(page);
  const field = page.getByRole('textbox', {name: 'Your name'});
  // Safari zooms the page into a field under 16 px.
  expect(await field.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
});

test('should give the files the width and the places a drawer when a phone opens the browser', async ({page, seed: _seed}) => {
  await makeFiles(page, ['Design', 'Banking mobile app with a very long name']);
  await page.goto('/#designs');
  await expect(page.locator('.dz-file')).toHaveCount(2);
  await expect(page.getByRole('navigation', {name: 'Sections'})).toBeHidden();
  await expectFits(page, '.dz-files-app');
  expect(await page.getByRole('searchbox', {name: 'Search files'}).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);

  // Two columns of cards, each "⋯" shown without hover.
  const cards = await page.locator('.dz-file').evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)));
  expect(cards[0]).toBe(cards[1]);
  await expect(page.getByRole('button', {name: 'File actions'}).first()).toHaveCSS('opacity', '1');

  // The drawer: the account (its theme and "Sign out"), the places; a choice closes it.
  await page.getByRole('button', {name: 'Sections', exact: true}).tap();
  const places = page.getByRole('navigation', {name: 'Sections'});
  await expect(places).toBeVisible();
  await expect(places.getByRole('button', {name: 'Account'})).toBeVisible();
  await expectFits(page, '.dz-drawer');
  await places.getByRole('button', {name: 'Trash', exact: true}).tap();
  await expect(places).toBeHidden();
  await expect(page.getByRole('heading', {name: 'Trash', exact: true})).toBeVisible();

  // A tap on the dimmed page closes it too.
  await page.getByRole('button', {name: 'Sections', exact: true}).tap();
  await expect(places).toBeVisible();
  await page.mouse.click(380, 400);
  await expect(places).toBeHidden();

  // Escape closes the drawer.
  await page.getByRole('button', {name: 'Sections', exact: true}).tap();
  await expect(places).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(places).toBeHidden();
});

test('should open a file with a tap and its menu with a long press when a finger is used', async ({page, seed: _seed}) => {
  await makeFiles(page, ['Touch']);
  await page.goto('/#designs');
  const card = page.locator('.dz-file').filter({hasText: 'Touch'});
  await hold(page, card.locator('.dz-file-hit'));
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', {name: 'Rename'})).toBeVisible();
  await expectSheet(page, menu);
  await expectFits(page, '[role=menu]');
  // The dimmed page above the sheet closes it, and the "Sections" button under that spot is not pressed too.
  await page.locator('.dz-sheet-backdrop').tap({position: {x: 20, y: 20}});
  await expect(menu).toBeHidden();
  await expect(page.getByRole('navigation', {name: 'Sections'})).toBeHidden();

  await card.locator('.dz-file-hit').tap();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
});

test('should leave the sheet open when the finger that opened it lifts over a row', async ({page, seed: _seed}) => {
  await makeFiles(page, ['First', 'Second', 'Third']);
  await page.goto('/#designs');
  await expect(page.locator('.dz-file')).toHaveCount(3);
  // The third card sits in the second row, where the menu's sheet rises: the finger stays down until it is there.
  const card = page.locator('.dz-file').nth(2).locator('.dz-file-hit');
  const menu = page.getByRole('menu');
  await hold(page, card, 1200);
  await expect(menu.getByRole('menuitem', {name: 'Rename'})).toBeVisible();
  const box = (await card.boundingBox())!;
  const sheet = (await menu.boundingBox())!;
  expect(box.y + box.height / 2, 'the finger is over the sheet').toBeGreaterThan(sheet.y);
  // The lift pressed nothing: the sheet stays, the file is not opened, renamed or trashed.
  await page.waitForTimeout(400);
  await expect(menu).toBeVisible();
  await expect(page).toHaveURL(/#designs$/);
  await expect(page.getByRole('textbox', {name: 'New file name'})).toHaveCount(0);
  await expect(page.locator('.dz-file')).toHaveCount(3);
  // A press that begins in the sheet acts.
  await menu.getByRole('menuitem', {name: 'Rename'}).tap();
  await expect(page.getByRole('textbox', {name: 'New file name'})).toBeVisible();
});

test('should sign in, make, rename, share and delete a file when only touch is used', async ({page}) => {
  await page.goto('/');
  await page.getByRole('textbox', {name: 'Your name'}).tap();
  await page.getByRole('textbox', {name: 'Your name'}).fill(personName());
  await page.getByRole('button', {name: 'Continue'}).tap();
  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();
  await expectFits(page, '.dz-files-app');

  // "New file" is in the bar at the bottom, its label and "New board"'s whole, also at 360 px.
  for (const width of [390, 360]) {
    await page.setViewportSize({width, height: 844});
    const cut = await page.locator('.dz-files-bar .dz-btn-label').evaluateAll(labels => labels.filter(label => label.scrollWidth > label.clientWidth + 0.5).map(label => label.textContent));
    expect(cut, `labels cut at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({width: 390, height: 844});
  const create = page.locator('.dz-files-bar').getByRole('button', {name: 'New file', exact: true});
  const box = (await create.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 80);
  await create.tap();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  await page.goBack();
  await expect(page.locator('.dz-file')).toHaveCount(1);

  // Rename through "⋯".
  await page.getByRole('button', {name: 'File actions'}).tap();
  await page.getByRole('menuitem', {name: 'Rename', exact: true}).tap();
  const field = page.getByRole('textbox', {name: 'New file name', exact: true});
  await field.fill('From phone');
  await field.press('Enter');
  await expect(page.locator('.dz-file').filter({hasText: 'From phone'})).toBeVisible();

  // Share: the dialog is a sheet that fits, and "Close" closes it.
  await page.getByRole('button', {name: 'File actions'}).tap();
  await page.getByRole('menuitem', {name: 'Share…', exact: true}).tap();
  const share = page.getByRole('dialog', {name: /Share/});
  await expect(share).toBeVisible();
  await expect(share.getByText('Copy link')).toBeVisible();
  await expectSheet(page, share.locator('.dz-dialog-surface'));
  await expectFits(page, 'dialog');
  await share.getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(share).toBeHidden();

  // Delete: into the trash, with the toast above the bar.
  await page.getByRole('button', {name: 'File actions'}).tap();
  await page.getByRole('menuitem', {name: 'Move to trash', exact: true}).tap();
  await expect(page.locator('.dz-file')).toHaveCount(0);
  const toast = page.locator('.dz-toast').filter({hasText: 'moved to the trash'});
  await expect(toast).toBeVisible();
  const toastBox = (await toast.boundingBox())!;
  const barBox = (await page.locator('.dz-files-bar').boundingBox())!;
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(barBox.y);
});

test('should show every dialog as a sheet that fits and closes by a swipe down when a phone opens it', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();

  await page.getByRole('button', {name: 'Import'}).tap();
  await page.getByRole('menuitem', {name: 'Import from Figma…'}).tap();
  const figma = page.getByRole('dialog', {name: 'Import from Figma'});
  await expect(figma).toBeVisible();
  await expectSheet(page, figma.locator('.dz-dialog-surface'));
  await expectFits(page, 'dialog');
  await swipeDown(page, figma.locator('.dz-dialog-header'), 200);
  await expect(figma).toBeHidden();

  // A short drag springs back.
  await page.getByRole('button', {name: 'Workspace'}).tap();
  await page.getByRole('menuitemradio', {name: 'Create team…'}).tap();
  const team = page.getByRole('dialog', {name: 'Create team'});
  await expect(team).toBeVisible();
  await expectFits(page, 'dialog');
  await swipeDown(page, team.locator('.dz-dialog-header'), 30);
  await expect(team).toBeVisible();
  await expectSheet(page, team.locator('.dz-dialog-surface'));
  await team.getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(team).toBeHidden();

  // The templates are a sheet too.
  await page.getByRole('button', {name: 'New file from a template'}).tap();
  const templates = page.getByRole('dialog', {name: 'Templates'});
  await expect(templates).toBeVisible();
  await expectSheet(page, templates);
  await expectFits(page, '.dz-popover');
});
