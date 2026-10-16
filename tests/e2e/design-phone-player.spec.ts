import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import {PHONE, shot} from './phone';

// The prototype player on a phone: it opens from the editor's top bar, the screen fills the
// player, a tap plays a hotspot, a sideways flick steps through the flow, "Restart" starts over. 390 × 844 with touch.

test.use(PHONE);

async function fromGallery(page: Page, template: string) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file from a template', exact: true}).tap();
  await page.getByRole('button', {name: new RegExp('^' + template)}).tap();
  await expect(page).toHaveURL(/#design\/[^/?]+$/, {timeout: 20_000});
  await waitEditorReady(page);
}

async function play(page: Page) {
  const popup = page.context().waitForEvent('page');
  await page.getByRole('button', {name: 'Present', exact: true}).tap();
  const player = await popup;
  await expect(player.locator('.dz-player-screen')).toBeVisible({timeout: 20_000});
  await expect(player.locator('.dz-player-loading')).toHaveCount(0, {timeout: 20_000});
  return player;
}

/** A finger flick across the player's screen, by CDP touches. */
async function flick(player: Page, fromX: number, toX: number, y: number) {
  const cdp = await player.context().newCDPSession(player);
  const point = (x: number) => [{x, y, id: 0, radiusX: 4, radiusY: 4, force: 1}];
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: point(fromX)});
  for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: point(fromX + ((toX - fromX) * step) / 6)});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
}

/** Fingers held still on the player for 700 ms. */
async function hold(player: Page, points: {x: number; y: number}[]) {
  const cdp = await player.context().newCDPSession(player);
  const touchPoints = points.map((point, id) => ({...point, id, radiusX: 4, radiusY: 4, force: 1}));
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints});
  await player.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
}

test('should play a deck full screen and step through it with taps, flicks and "Restart"', async ({page, seed: _seed}) => {
  test.setTimeout(90_000);
  await fromGallery(page, 'Presentation');
  const player = await play(page);
  const frame = player.locator('.dz-player-frame');
  const first = await frame.textContent();
  await shot(player, 'player-390');
  const overflow = await player.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const screen = (await player.locator('.dz-player-screen').boundingBox())!;
  expect(screen.width).toBeGreaterThan(300);
  expect(screen.x).toBeGreaterThanOrEqual(0);
  expect(screen.x + screen.width).toBeLessThanOrEqual(390);
  const y = screen.y + screen.height / 2;
  await flick(player, 330, 120, y);
  await expect(frame).not.toHaveText(first!);
  const second = await frame.textContent();
  await flick(player, 120, 330, y);
  await expect(frame).toHaveText(first!);
  await player.locator('.dz-player-screen').tap();
  await expect(frame).toHaveText(second!);
  // Full-bleed: the bar is away until two fingers are held on the screen.
  await expect(player.locator('.dz-player-bar')).not.toBeInViewport();
  await hold(player, [{x: 150, y: y}, {x: 240, y: y}]);
  await expect(player.getByRole('button', {name: 'Close player', exact: true})).toBeInViewport();
  await player.getByRole('button', {name: 'Restart', exact: true}).tap();
  await expect(frame).toHaveText(first!);
  for (const name of ['Restart', 'Show hotspots', 'Close player']) {
    const button = player.getByRole('button', {name, exact: true});
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await player.close();
});

test('should show the hidden bar when a tap misses every hotspot', async ({page, seed: _seed}) => {
  test.setTimeout(90_000);
  await fromGallery(page, 'Mobile app');
  const player = await play(page);
  const bar = player.locator('.dz-player-bar');
  await expect(bar).not.toBeInViewport();
  // The top left corner of "Sign in" is plain background.
  const screen = (await player.locator('.dz-player-screen').boundingBox())!;
  await player.touchscreen.tap(screen.x + 12, screen.y + screen.height * 0.3);
  await expect(bar).toBeInViewport();
  await expect(player.locator('.dz-player-frame')).toHaveText('Sign in');
  await expect(player.getByRole('button', {name: 'Close player', exact: true})).toBeInViewport();
  await player.close();
});
