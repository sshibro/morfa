import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import {Fingers, PHONE, savedFile, shot} from './phone';

// The board on a phone: the canvas is the screen, the big toolbar at the bottom with
// its trays and the "+" sheet above it, stickies by a tap. 390 × 844 with touch; checks read the saved document or the layout.

test.use(PHONE);

const objectsOf = (file: Awaited<ReturnType<typeof savedFile>>, kind: string) => Object.values(file.document.nodes).filter(node => node.board?.kind === kind);

async function openNewPhoneBoard(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().tap();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await shot(page, 'board-390-templates');
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
  return {id, sheet};
}

test('should fit the board\'s chrome on the screen when a board opens on a phone', async ({page, seed: _seed}) => {
  const {sheet} = await openNewPhoneBoard(page);
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.x).toBeGreaterThanOrEqual(0);
  expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await shot(page, 'board-390');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const bar = (await page.getByRole('toolbar', {name: 'Board tools'}).boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(390);
  expect(bar.y + bar.height).toBeLessThanOrEqual(844);
});

test('should place a sticky with a tap, type on it and recolour it from the context toolbar', async ({page, seed: _seed}) => {
  const {id, sheet} = await openNewPhoneBoard(page);
  await page.getByRole('toolbar', {name: 'Board tools'}).getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(sheet).toBeHidden();
  const fingers = await Fingers.on(page);
  await page.getByRole('toolbar', {name: 'Board tools'}).getByRole('button', {name: 'Sticky', exact: true}).tap();
  // The sticky tray rises above the toolbar, inside the screen.
  const tray = (await page.locator('.bd-tray').first().boundingBox())!;
  expect(tray.x).toBeGreaterThanOrEqual(0);
  expect(tray.x + tray.width).toBeLessThanOrEqual(390);
  await fingers.tap({x: 195, y: 360});
  await page.keyboard.type('Idea');
  await page.keyboard.press('Escape');
  await expect.poll(async () => objectsOf(await savedFile(page, id), 'sticky').length).toBe(1);
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await expect(context).toBeVisible();
  const box = (await context.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await shot(page, 'board-390-sticky');
  await context.getByRole('button', {name: 'Sticky color'}).tap();
  await page.getByRole('button', {name: 'Blue', exact: true}).tap();
  await expect.poll(async () => {
    const sticky = objectsOf(await savedFile(page, id), 'sticky')[0];
    const fill = sticky.fills[0];
    return fill.type === 'SOLID' ? Math.round(fill.color.b * 255) : null;
  }).toBe(0xff);
});

test('should pan the board with one finger and move a sticky once it is selected', async ({page, seed: _seed}) => {
  const {id, sheet} = await openNewPhoneBoard(page);
  await page.getByRole('toolbar', {name: 'Board tools'}).getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(sheet).toBeHidden();
  const fingers = await Fingers.on(page);
  await page.getByRole('toolbar', {name: 'Board tools'}).getByRole('button', {name: 'Sticky', exact: true}).tap();
  await fingers.tap({x: 195, y: 360});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(async () => objectsOf(await savedFile(page, id), 'sticky').length).toBe(1);
  const placed = objectsOf(await savedFile(page, id), 'sticky')[0];
  // Nothing selected: a drag across the sticky pans the board and leaves it where it is.
  await fingers.tap({x: 40, y: 700});
  await fingers.drag([{x: 195, y: 360}], [{x: 195, y: 300}]);
  await page.waitForTimeout(300);
  expect(objectsOf(await savedFile(page, id), 'sticky')[0].y).toBe(placed.y);
  // Tapped, then dragged: it moves with the finger.
  await fingers.tap({x: 195, y: 300});
  await fingers.drag([{x: 195, y: 300}], [{x: 235, y: 330}]);
  await expect.poll(async () => {
    const sticky = objectsOf(await savedFile(page, id), 'sticky')[0];
    return [sticky.x - placed.x, sticky.y - placed.y];
  }).toEqual([40, 30]);
});

test('should open the board\'s comments as a sheet inside the screen', async ({page, seed: _seed}) => {
  const {sheet} = await openNewPhoneBoard(page);
  await page.getByRole('toolbar', {name: 'Board tools'}).getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(sheet).toBeHidden();
  await page.locator('.bd-top-right').getByRole('button', {name: /^Comments/}).tap();
  const sidebar = page.getByRole('complementary', {name: 'Comments'});
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => {
    const box = (await sidebar.boundingBox())!;
    return box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844 && box.y > 844 / 3;
  }).toBe(true);
  const fingers = await Fingers.on(page);
  await fingers.tap({x: 195, y: 200});
  const draft = page.getByRole('dialog', {name: 'New comment'});
  await expect(draft).toBeVisible();
  const card = (await draft.boundingBox())!;
  const side = (await sidebar.boundingBox())!;
  expect(card.x + card.width).toBeLessThanOrEqual(390);
  expect(card.y + card.height, 'the card stands above the comments sheet').toBeLessThanOrEqual(side.y);
  await shot(page, 'board-390-comments');
});

test('should raise each tray of the board\'s bar inside the screen and draw with the marker by finger', async ({page, seed: _seed}) => {
  const {id, sheet} = await openNewPhoneBoard(page);
  const bar = page.getByRole('toolbar', {name: 'Board tools'});
  await bar.getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(sheet).toBeHidden();
  for (const [tool, tray] of [['Sticky', 'Sticky color'], ['Shapes and connectors', 'Shapes and connectors'], ['Marker', 'Marker']]) {
    await bar.getByRole('button', {name: tool, exact: true}).tap();
    const group = page.getByRole('group', {name: tray, exact: true});
    await expect(group).toBeVisible();
    await expect.poll(async () => {
      const box = (await group.boundingBox())!;
      const barBox = (await bar.boundingBox())!;
      return box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= barBox.y;
    }, {message: `${tray}: inside the screen, above the bar`}).toBe(true);
  }
  // The marker's tray: a thick line and another colour, one tap each; the marker stays in hand.
  const tray = page.getByRole('group', {name: 'Marker', exact: true});
  await tray.getByRole('button', {name: 'Thick line'}).tap();
  await expect(tray.getByRole('button', {name: 'Thick line'})).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'board-390-marker-tray');
  const fingers = await Fingers.on(page);
  await fingers.drag([{x: 100, y: 300}], [{x: 280, y: 380}], 12);
  await expect.poll(async () => Object.values((await savedFile(page, id)).document.nodes).filter(node => node.type === 'VECTOR').length).toBeGreaterThan(0);
  await expect(tray).toBeVisible();
});

test('should show the board\'s whole name in the top-left pill on a phone', async ({page, seed: _seed}) => {
  const {sheet} = await openNewPhoneBoard(page);
  await page.getByRole('toolbar', {name: 'Board tools'}).getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(sheet).toBeHidden();
  const name = page.locator('.bd-top-left .dz-file-name');
  await expect(name).toHaveText('Untitled board');
  expect(await name.evaluate(element => element.scrollWidth - element.clientWidth), 'the name is not cut').toBeLessThanOrEqual(1);
  const left = (await page.locator('.bd-top-left').boundingBox())!, right = (await page.locator('.bd-top-right').boundingBox())!;
  expect(left.x + left.width, 'the pills do not overlap').toBeLessThanOrEqual(right.x);
  // The timer is still one tap away, in "Reactions and meeting".
  await page.locator('.bd-top-right').getByRole('button', {name: 'Reactions and meeting'}).tap();
  await expect(page.getByText('Shared by everyone, with music')).toBeVisible();
  await shot(page, 'board-390');
});

test('should vote on a sticky by tap and take the vote back with "Remove vote" on a phone', async ({page, seed: _seed}) => {
  test.setTimeout(90_000);
  const {sheet} = await openNewPhoneBoard(page);
  const bar = page.getByRole('toolbar', {name: 'Board tools'});
  await bar.getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(sheet).toBeHidden();
  const fingers = await Fingers.on(page);
  await bar.getByRole('button', {name: 'Sticky', exact: true}).tap();
  await fingers.tap({x: 195, y: 360});
  await page.keyboard.type('Yes');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.bd-top-right').getByRole('button', {name: 'Reactions and meeting'}).tap();
  await page.getByRole('button', {name: /Voting…/}).tap();
  await page.getByRole('dialog', {name: 'Voting'}).getByRole('button', {name: 'Start voting'}).tap();
  const voteBar = page.getByRole('region', {name: 'Voting'});
  await expect(voteBar).toBeVisible();
  const startVoting = voteBar.getByRole('button', {name: 'Vote', exact: true});
  if (await startVoting.count()) await startVoting.tap();
  const status = voteBar.getByRole('status');
  const left = async () => Number((await status.textContent())?.match(/(\d+) of \d+ left/)?.[1] ?? NaN);
  const before = await left();
  await fingers.tap({x: 300, y: 450});
  await expect.poll(left).toBe(before - 1);
  await voteBar.getByRole('button', {name: 'Remove vote', exact: true}).tap();
  await expect(voteBar.getByRole('button', {name: 'Remove vote', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await fingers.tap({x: 300, y: 450});
  // The vote is back; with none left to take back the switch goes off by itself, and a tap votes again.
  await expect.poll(left).toBe(before);
  await expect(voteBar.getByRole('button', {name: 'Remove vote', exact: true})).toHaveCount(0);
  await fingers.tap({x: 300, y: 450});
  await expect.poll(left).toBe(before - 1);
  const box = (await voteBar.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y, 'the voting bar is at the bottom, clear of the pills').toBeGreaterThan(844 / 2);
  // A running timer widens the right pill: the left one gives way, they do not overlap.
  const leftPill = (await page.locator('.bd-top-left').boundingBox())!, rightPill = (await page.locator('.bd-top-right').boundingBox())!;
  expect(leftPill.x + leftPill.width).toBeLessThanOrEqual(rightPill.x);
});

test('should style a connector by touch: its ends, its colour and "Label background" from sheets inside the screen', async ({page, seed: _seed}) => {
  const {id, sheet} = await openNewPhoneBoard(page);
  const bar = page.getByRole('toolbar', {name: 'Board tools'});
  await bar.getByRole('button', {name: 'Close', exact: true}).tap();
  await expect(sheet).toBeHidden();
  const fingers = await Fingers.on(page);
  await bar.getByRole('button', {name: 'Shapes and connectors', exact: true}).tap();
  await page.getByRole('group', {name: 'Shapes and connectors', exact: true}).getByRole('button', {name: /Straight connector/}).tap();
  await fingers.drag([{x: 80, y: 300}], [{x: 300, y: 420}], 10);
  await expect.poll(async () => objectsOf(await savedFile(page, id), 'connector').length).toBe(1);
  // A double tap on the line gives it a label.
  await fingers.tap({x: 190, y: 360});
  await page.waitForTimeout(60);
  await fingers.tap({x: 190, y: 360});
  await page.keyboard.type('Yes');
  await page.keyboard.press('Escape');
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await expect(context).toBeVisible();
  // The ends' point styles: a menu inside the screen.
  await context.getByRole('button', {name: 'Start point'}).tap();
  const menu = page.getByRole('menu').last();
  await expect(menu).toBeVisible();
  // A sheet from the bottom on a phone: inside the screen once it has slid in.
  await expect.poll(async () => {
    const box = (await menu.boundingBox())!;
    return box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844.5;
  }).toBe(true);
  await page.keyboard.press('Escape');
  // The colour opens as a sheet at the bottom with "Label background" in it, a finger's tap away.
  await context.getByRole('button', {name: 'Line color'}).tap();
  const palette = page.getByRole('dialog', {name: 'Line color'});
  await expect(palette).toBeVisible();
  await expect.poll(async () => {
    const box = (await palette.boundingBox())!;
    return box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844.5;
  }).toBe(true);
  const background = palette.getByRole('button', {name: 'Label background'});
  expect((await background.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  const pressed = await background.getAttribute('aria-pressed');
  await background.tap();
  await expect(background).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
  await page.keyboard.press('Escape');
  await shot(page, 'board-390-connector');
  // The toolbar is wider than the screen with a label: it scrolls under a finger to "More".
  const contextBox = (await context.boundingBox())!;
  expect(contextBox.x + contextBox.width).toBeLessThanOrEqual(390);
  const more = context.getByRole('button', {name: 'More', exact: true});
  const y = contextBox.y + contextBox.height / 2;
  await fingers.drag([{x: contextBox.x + contextBox.width - 20, y}], [{x: contextBox.x + 20, y}], 8);
  await expect.poll(async () => {
    const box = (await more.boundingBox())!;
    return box.x + box.width <= 390;
  }).toBe(true);
});

test('should import a CSV from the board\'s menu and grow a stamp held and wiggled by finger', async ({page, seed: _seed}) => {
  const {id, sheet} = await openNewPhoneBoard(page);
  // A stamp from the sheet's "Stamps": a finger held and wiggled grows it (FJ's hold and wiggle).
  await sheet.getByRole('tab', {name: 'Stamps'}).tap();
  await sheet.locator('.bd-sheet-item').first().tap();
  await expect(sheet).toBeHidden();
  const fingers = await Fingers.on(page);
  const at = {x: 195, y: 400};
  await fingers.down([at]);
  for (let k = 0; k < 12; k++) await fingers.move([{x: at.x + (k % 2 ? -30 : 30), y: at.y}]);
  await fingers.move([at]);
  // Rest before lifting (a flick's fling would eat the next tap; phone.ts Fingers.drag).
  await page.waitForTimeout(120);
  await fingers.up();
  await expect.poll(async () => objectsOf(await savedFile(page, id), 'stamp')[0]?.width ?? 0).toBeGreaterThan(60);
  // "Import table from CSV…" is in "File" of the board's menu, by touch.
  const file = page.getByRole('menuitem', {name: 'File', exact: true});
  await expect(async () => {
    if (!(await file.isVisible())) await page.locator('.bd-top-left').getByRole('button', {name: 'Main menu'}).tap();
    await expect(file).toBeVisible({timeout: 2000});
  }).toPass();
  await file.tap();
  const item = page.getByRole('menuitem', {name: 'Import table from CSV…'});
  await expect(item).toBeVisible();
  const box = (await item.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const chooser = page.waitForEvent('filechooser');
  await item.tap();
  await (await chooser).setFiles({name: 'list.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Role\nAnna,Design\nBoris,Code\n')});
  await expect.poll(async () => objectsOf(await savedFile(page, id), 'table').length).toBe(1);
});
