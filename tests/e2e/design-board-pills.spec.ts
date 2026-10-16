import {test, expect} from './fixtures';
import type {Locator, Page} from '@playwright/test';

// The board's top pills as FigJam's own pictures show them (help.figma.com, "Find and use FigJam templates"; lane FJ): top left the
// menu, the name in bold on one line, a rule, the pages with the current page's name; top right the people, reactions, comments,
// the timer and "Share", in that order.

const box = async (locator: Locator) => (await locator.boundingBox())!;

async function openNewBoard(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
}

test('should show the board\'s name in bold on one line, then the pages with the page\'s name', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const pill = page.locator('.bd-top-left');
  const name = pill.locator('.dz-file-name');
  expect(Number(await name.evaluate(element => getComputedStyle(element).fontWeight))).toBeGreaterThanOrEqual(600);
  // Saved is announced, not shown: the status keeps its words for a screen reader and takes no room.
  const status = pill.getByRole('status');
  await expect(status).toHaveText('Saved');
  expect((await box(status)).height).toBeLessThanOrEqual(1);
  const pages = pill.getByRole('button', {name: 'Pages: Page 1'});
  await expect(pages).toContainText('Page 1');
  // Name, rule, pages from left to right on one line.
  const [nameBox, ruleBox, pagesBox] = [await box(name), await box(pill.locator('.bd-pill-rule')), await box(pages)];
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(ruleBox.x);
  expect(ruleBox.x).toBeLessThan(pagesBox.x);
  expect(Math.abs(nameBox.y + nameBox.height / 2 - (pagesBox.y + pagesBox.height / 2))).toBeLessThan(3);
  // A second page: the icon carries the number, the pill the new page's name.
  await pages.click();
  await page.getByRole('menuitem', {name: 'New page'}).click();
  await expect(pill.getByRole('button', {name: 'Pages: Page 2'})).toBeVisible();
  await expect(pill.locator('.bd-pages-number')).toHaveText('2');
});

test('should put the timer just before "Share", after comments, as FigJam does', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const pill = page.locator('.bd-top-right');
  await expect(pill.getByRole('button', {name: 'Timer'})).toBeVisible();
  const order = async (label: string | RegExp) => (await box(pill.getByRole('button', {name: label}).first())).x;
  const [reactions, comments, timer, share] = [await order('Reactions and meeting'), await order(/^Comments/), await order('Timer'), await order('Share')];
  expect(reactions).toBeLessThan(comments);
  expect(comments).toBeLessThan(timer);
  expect(timer).toBeLessThan(share);
});

test('should set the pages icon and the page\'s name side by side', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const pages = page.locator('.bd-top-left').getByRole('button', {name: /^Pages/});
  const [icon, name] = [await box(pages.locator('.bd-pages-icon')), await box(pages.locator('.bd-pages-name'))];
  expect(icon.x + icon.width).toBeLessThanOrEqual(name.x);
  expect(Math.abs(icon.y + icon.height / 2 - (name.y + name.height / 2))).toBeLessThan(3);
});

test('should show a short board name whole, without an ellipsis', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const name = page.locator('.bd-top-left .dz-file-name');
  expect(await name.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('should name the comments sidebar and close it with its ×', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  await page.locator('.bd-top-right').getByRole('button', {name: /^Comments/}).click();
  const sidebar = page.getByRole('complementary', {name: 'Comments'});
  await expect(sidebar.getByRole('heading', {name: 'Comments'})).toBeVisible();
  await sidebar.getByRole('button', {name: 'Close comments'}).click();
  await expect(sidebar).toBeHidden();
});

test('should size zoom and help as FigJam\'s board picture: a 32 px round pill and a 32 px circle on the bar\'s bottom line', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const zoom = await box(page.locator('.bd-zoom'));
  const help = await box(page.getByRole('button', {name: 'Help'}));
  const bar = await box(page.locator('.bd-toolbar'));
  expect([zoom.height, help.height, help.width]).toEqual([32, 32, 32]);
  expect(Math.abs(zoom.y + zoom.height - (bar.y + bar.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(help.y + help.height - (bar.y + bar.height))).toBeLessThanOrEqual(1);
});
