import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import {Fingers, nodesOf, openNewPhoneFile, savedFile, shot} from './phone';

// The editor and the board on a tablet: a touch screen 768–1023 px wide
// opens with both side panels folded; each opens over the canvas from its edge and folds again on a tap outside; the
// toolbar fits or scrolls. 820 × 1180 (an iPad Air) with touch.

const TABLET = {width: 820, height: 1180} as const;
test.use({viewport: TABLET, hasTouch: true, isMobile: true, deviceScaleFactor: 2});

const inside = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return box.x >= 0 && box.x + box.width <= TABLET.width && box.y + box.height <= TABLET.height;
};

test('should open with the panels folded and the toolbar inside the screen when a file opens on a tablet', async ({page, seed: _seed}) => {
  const {canvas} = await openNewPhoneFile(page);
  await shot(page, 'tablet-820');
  expect((await canvas.boundingBox())!.width).toBe(TABLET.width);
  await expect(page.getByRole('complementary', {name: 'Properties'})).toHaveCount(0);
  await expect(page.locator('.dz-left')).toHaveCount(0);
  expect(await inside(page, '.dz-toolbar')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

test('should open each panel over the canvas from its edge and fold it on a tap outside', async ({page, seed: _seed}) => {
  await openNewPhoneFile(page);
  await page.getByRole('button', {name: 'Expand UI'}).tap();
  const left = page.locator('.dz-tablet-panel.is-left');
  await expect(left).toBeVisible();
  await expect(left.getByRole('tab', {name: 'File'})).toBeVisible();
  await expect.poll(async () => (await left.boundingBox())!.x).toBe(0);
  await shot(page, 'tablet-820-left');
  await page.touchscreen.tap(TABLET.width - 40, TABLET.height / 2);
  await expect(left).toHaveCount(0);

  await page.getByRole('button', {name: 'Properties', exact: true}).tap();
  const right = page.locator('.dz-tablet-panel.is-right');
  await expect(right).toBeVisible();
  await expect(right.getByRole('tab', {name: 'Design'})).toBeVisible();
  await expect.poll(async () => {
    const box = (await right.boundingBox())!;
    return Math.round(box.x + box.width);
  }).toBe(TABLET.width);
  await page.touchscreen.tap(40, TABLET.height / 2);
  await expect(right).toHaveCount(0);
});

test('should keep the board\'s bar inside the screen on a tablet', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().tap();
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  const bar = page.getByRole('toolbar', {name: 'Board tools'});
  await bar.getByRole('button', {name: 'Close', exact: true}).tap();
  await shot(page, 'tablet-820-board');
  const box = (await bar.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(TABLET.width);
});

test('should fold an open panel with Escape and keep the selection', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await page.getByRole('toolbar', {name: 'Tools'}).locator('.dz-tool').and(page.getByRole('button', {name: 'Rectangle', exact: true})).tap();
  await fingers.drag([{x: 200, y: 300}], [{x: 400, y: 500}]);
  await expect.poll(async () => Object.values((await savedFile(page, id)).document.nodes).filter(node => node.type === 'RECTANGLE').length).toBe(1);
  await page.getByRole('button', {name: 'Properties', exact: true}).tap();
  const right = page.locator('.dz-tablet-panel.is-right');
  await expect(right.locator('.dz-section', {hasText: 'Position'}).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(right).toHaveCount(0);
  const selected = await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {getState(): {selection: string[]}}}}).__morfaDesignTest.store.getState().selection.length);
  expect(selected).toBe(1);
});

test('should open a layer\'s menu by long press and everything inside a frame from its caret\'s', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  for (const [from, to] of [[{x: 100, y: 200}, {x: 700, y: 900}], [{x: 200, y: 300}, {x: 600, y: 800}]] as const) {
    await page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Frame', exact: true}).tap();
    await fingers.drag([from], [to]);
  }
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'FRAME').length).toBe(2);
  await page.getByRole('button', {name: 'Expand UI'}).tap();
  const left = page.locator('.dz-tablet-panel.is-left');
  const rows = left.getByRole('treeitem');
  const hold = async (box: {x: number; y: number; width: number; height: number}) => {
    await fingers.down([{x: box.x + box.width / 2, y: box.y + box.height / 2}]);
    await page.waitForTimeout(700);
    await fingers.up();
  };
  // iPad Safari sends no contextmenu for a held finger: the layout sends one as the finger lifts.
  await hold((await rows.first().locator('.dz-layer-name').boundingBox())!);
  await expect(page.getByRole('menuitem', {name: /Rename/})).toBeVisible();
  // The menu keeps the focus: a keyboard's Escape closes it (an iPad with a keyboard).
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await hold((await rows.first().locator('.dz-layer-name').boundingBox())!);
  await expect(page.getByRole('menuitem', {name: /Rename/})).toBeVisible();
  // A tap outside closes the menu and leaves the panel open.
  await page.touchscreen.tap(TABLET.width - 40, TABLET.height / 2);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(left).toBeVisible();
  if ((await rows.first().getAttribute('aria-expanded')) === 'true') await rows.first().locator('[data-caret]').tap();
  await expect(rows).toHaveCount(1);
  await hold((await rows.first().locator('[data-caret]').boundingBox())!);
  await page.getByRole('menuitem', {name: 'Expand all nested'}).tap();
  await expect(rows).toHaveCount(2);
});
