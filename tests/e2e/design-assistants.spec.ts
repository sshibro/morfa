import {test, expect} from './fixtures';
import {PHONE} from './phone';

// "Claude and ChatGPT" (src/design/assistants, docs/mcp-server.md §Connections): a card in the file browser's sidebar, not in the settings,
// for an account the MCP server is open to; it opens the screen that connects an assistant in three steps, lists the connected ones,
// disconnects them, and shows one the person allows in another tab on its own.

const openMcp = async (page: import('@playwright/test').Page, accountId: string, connected?: 'Claude' | 'ChatGPT') => {
  const response = await page.request.post('/__e2e/mcp', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {accountId, connected}});
  expect(response.ok()).toBe(true);
};

test.describe('with the MCP server open to the account', () => {
  test('should show the connected assistant, connect another in steps, and disconnect', async ({page, seed}) => {
    await openMcp(page, seed.accountId, 'Claude');
    await page.goto('/#designs');
    const card = page.locator('.dz-assist-card');
    await expect(card).toContainText('Claude and ChatGPT');
    await expect(card).toContainText('Connected: Claude');
    await card.click();

    const dialog = page.getByRole('dialog', {name: 'Connections'});
    await expect(dialog.getByRole('heading', {name: 'Your Claude or ChatGPT works right inside Morfa'})).toBeVisible();
    await expect(dialog.locator('.dz-assist-copy-value')).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await expect(dialog.getByRole('link', {name: 'Add to Claude'})).toHaveAttribute('href', 'https://claude.ai/customize/connectors');
    await expect(dialog.locator('.dz-assist-tile.is-claude')).toHaveClass(/is-live/);
    await expect(dialog.locator('.dz-assist-tile.is-chatgpt')).not.toHaveClass(/is-live/);

    await dialog.getByRole('radio', {name: 'ChatGPT'}).click();
    await expect(dialog.getByRole('link', {name: 'Add to ChatGPT'})).toBeVisible();
    await dialog.getByRole('radio', {name: 'For developers'}).click();
    await expect(dialog.locator('.dz-assist-copy-value').first()).toHaveText(/^claude mcp add --transport http morfa http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    // ChatGPT allowed in another tab: it appears here on its own.
    await openMcp(page, seed.accountId, 'ChatGPT');
    const rows = dialog.locator('.dz-assist-row');
    await expect(rows).toHaveCount(2, {timeout: 10_000});
    await expect(page.getByText('ChatGPT connected to Morfa')).toBeVisible();
    await expect(dialog.locator('.dz-assist-tile.is-chatgpt')).toHaveClass(/is-live/);

    for (const name of ['ChatGPT', 'Claude']) await rows.filter({hasText: name}).getByRole('button', {name: 'Disconnect'}).click();
    await expect(dialog.getByText('Waiting for a connection.', {exact: false})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toContainText('Connect to Morfa');
  });
});

test('should not offer it where the MCP server is not open to the account', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await expect(page.locator('.dz-files-sidebar')).toBeVisible();
  await expect(page.locator('.dz-assist-card')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use(PHONE);

  test('should open from "Sections" and keep the chosen tab inside its bar, with thumb-sized tabs', async ({page, seed}) => {
    await openMcp(page, seed.accountId);
    await page.goto('/#designs');
    // On a phone the sidebar, and the card in it, is behind "Sections".
    await page.getByRole('button', {name: 'Sections'}).click();
    await page.locator('.dz-assist-card').click();
    const dialog = page.getByRole('dialog', {name: 'Connections'});
    const bar = (await dialog.locator('.dz-assist-tabs').boundingBox())!;
    const chosen = (await dialog.getByRole('radio', {name: 'Claude'}).boundingBox())!;
    expect(chosen.height).toBeGreaterThanOrEqual(44);
    expect(chosen.y + chosen.height).toBeLessThanOrEqual(bar.y + bar.height + 0.5);
    await dialog.screenshot({path: test.info().outputPath('phone-dialog.png')});
  });
});
