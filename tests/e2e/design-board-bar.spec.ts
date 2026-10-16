import {test, expect} from './fixtures';
import type {Locator, Page} from '@playwright/test';

// The board's bar and its trays as FigJam has them: sizes,
// order and the tray over the bar, and "easy to use" — big targets, one click keeps the tool, the chosen colour on the drawn
// marker, Escape and V back to Move, the keyboard, and a context toolbar that never sits under the bar.

const tool = (page: Page) => page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {getState(): {tool: string}}}}).__morfaDesignTest.store.getState().tool);
const box = async (locator: Locator) => (await locator.boundingBox())!;

async function openNewBoard(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  const canvas = await box(page.getByRole('application', {name: 'Canvas'}));
  return {x: canvas.x + Math.round(canvas.width / 2), y: canvas.y + Math.round(canvas.height / 2)};
}

test('should lay the bar out as the owner\'s picture: 64 px, radius 14, three groups, no comment button', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const bar = page.getByRole('toolbar', {name: 'Board tools'});
  const barBox = await box(bar);
  expect(barBox.height).toBe(64);
  expect(barBox.width).toBeGreaterThan(680);
  expect(barBox.width).toBeLessThan(740);
  expect(await bar.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('14px');
  const labels = await bar.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  expect(labels).toEqual(['Move', 'Hand', 'Marker', 'Sticky', 'Shapes and connectors', 'Text', 'Section', 'Table', 'Stamp', 'Actions', 'More: stickers, templates, stamps']);
  // Full-height rules between the groups.
  for (const rule of await bar.locator('.bd-divider').all()) expect((await box(rule)).height).toBe(64);
  const move = await box(bar.getByRole('button', {name: 'Move'}));
  expect([move.width, move.height]).toEqual([44, 44]);
  // Every target is 40 px or more.
  for (const button of await bar.getByRole('button').all()) {
    const each = await box(button);
    expect(Math.min(each.width, each.height), await button.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(40);
  }
});

test('should open the marker tray straight over the bar, keep the marker through one-click picks, and show the colour on its tip', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const bar = page.getByRole('toolbar', {name: 'Board tools'});
  await bar.getByRole('button', {name: 'Marker', exact: true}).click();
  const tray = page.getByRole('group', {name: 'Marker', exact: true});
  await expect(tray).toBeVisible();
  // It rises from the bar in 160 ms: measured once it stands.
  await expect.poll(async () => (await box(tray)).height).toBe(52);
  const [trayBox, barBox] = [await box(tray), await box(bar)];
  expect(Math.round(barBox.y - (trayBox.y + trayBox.height))).toBe(12);
  expect(Math.abs(trayBox.x - (barBox.x - 6))).toBeLessThanOrEqual(1);
  expect(Math.abs(trayBox.width - (barBox.width + 12))).toBeLessThanOrEqual(1);
  for (const target of await tray.locator('button, label').all()) {
    const each = await box(target);
    expect(Math.min(each.width, each.height), await target.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(40);
  }
  // One click each: a kind, a weight, a colour; the marker stays in hand and the tray stays open.
  await tray.getByRole('button', {name: 'Highlighter'}).click();
  await tray.getByRole('button', {name: 'Marker', exact: true}).click();
  await tray.getByRole('button', {name: 'Thick line'}).click();
  const red = tray.locator('.bd-swatch-hit').nth(1);
  await red.click();
  expect(await tool(page)).toBe('board-marker');
  await expect(tray).toBeVisible();
  await expect(red).toHaveAttribute('aria-pressed', 'true');
  const chosen = await red.locator('.bd-swatch').evaluate(element => getComputedStyle(element).getPropertyValue('--bd-swatch').trim().toUpperCase());
  const tip = await bar.locator('.bd-art-marker path').first().getAttribute('fill');
  expect(tip?.toUpperCase()).toBe(chosen);
  // Escape gives the board back to "Move" and puts the tray away; so does V.
  await page.keyboard.press('Escape');
  expect(await tool(page)).toBe('move');
  await expect(tray).toBeHidden();
  await page.keyboard.press('KeyM');
  await expect(tray).toBeVisible();
  await page.keyboard.press('KeyV');
  expect(await tool(page)).toBe('move');
  await expect(tray).toBeHidden();
});

test('should move along the bar with the arrows and press with Enter, saying which tool is in hand', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const bar = page.getByRole('toolbar', {name: 'Board tools'});
  await bar.getByRole('button', {name: 'Move'}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', {name: 'Hand'})).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await tool(page)).toBe('hand');
  await expect(bar.getByRole('button', {name: 'Hand'})).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('End');
  await expect(bar.getByRole('button', {name: 'More: stickers, templates, stamps'})).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('button', {name: 'Move'})).toBeFocused();
});

test('should keep the context toolbar off the bar when the selection reaches the bottom of the view', async ({page, seed: _seed}) => {
  const centre = await openNewBoard(page);
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.type('Idea');
  await page.keyboard.press('Escape');
  // Zoomed in so the note fills more than the view: no room above it, and below it is the bar.
  for (let k = 0; k < 3; k++) await page.keyboard.press('ControlOrMeta+Equal');
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await expect(context).toBeVisible();
  const [contextBox, barBox] = [await box(context), await box(page.getByRole('toolbar', {name: 'Board tools'}))];
  expect(contextBox.y + contextBox.height).toBeLessThanOrEqual(barBox.y);
});

test('should keep a colour picked with the rainbow under "Board colors" after the rainbow, one click away', async ({page, seed: _seed}) => {
  const centre = await openNewBoard(page);
  await page.keyboard.press('KeyM');
  const tray = page.getByRole('group', {name: 'Marker', exact: true});
  await expect(tray).toBeVisible();
  // The palette button comes last, after the rainbow.
  const targets = await tray.locator('.bd-tray-row.is-colors > *').evaluateAll(items => items.map(item => item.getAttribute('aria-label') ?? item.querySelector('[aria-label]')?.getAttribute('aria-label')));
  expect(targets.slice(-2)).toEqual(['Custom color', 'Board colors']);
  // Each kind's drawing fills its tile.
  for (const svg of await tray.locator('.bd-marker-kind svg').all()) expect((await box(svg)).width).toBe(28);
  await tray.locator('input[type="color"]').fill('#123456');
  await page.mouse.move(centre.x - 100, centre.y - 100);
  await page.mouse.down();
  await page.mouse.move(centre.x + 100, centre.y - 60, {steps: 8});
  await page.mouse.up();
  await tray.locator('.bd-swatch-hit').first().click();
  await tray.getByRole('button', {name: 'Board colors'}).click();
  const own = page.getByRole('group', {name: 'Board colors'});
  await expect(own).toBeVisible();
  await own.getByRole('button', {name: '#123456'}).click();
  await expect(own).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('morfa.board.choices.v1') ?? '{}').colors.marker)).toBe('#123456');
  expect(await tool(page)).toBe('board-marker');
});
