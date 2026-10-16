import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument} from '../../shared/design/types';

// The "+" sheet's "All" tab as FigJam shows it ("Brainstorm
// together", "Run a meeting"…): a section per use, each with its templates and a sticker or two that go with it.

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
async function saved(page: Page, id: string): Promise<{document: DesignDocument}> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('should group the "All" tab by use, templates and stickers together, and place a sticker from it', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  const titles = await sheet.locator('.bd-sheet-section .bd-sheet-title').allTextContents();
  expect(titles.slice(0, 4)).toEqual(['Brainstorm together', 'Run a meeting', 'Plan', 'Draw a diagram']);
  const ideas = sheet.locator('.bd-sheet-section').filter({has: page.getByRole('heading', {name: 'Brainstorm together'})});
  await expect(ideas.getByRole('button', {name: /Brainstorm/})).toBeVisible();
  await expect(ideas.getByRole('button', {name: /Light bulb/})).toBeVisible();
  await ideas.getByRole('button', {name: /Light bulb/}).click();
  await expect(sheet).toBeHidden();
  const id = fileIdFrom(page);
  await expect.poll(async () => Object.values((await saved(page, id)).document.nodes).filter(node => node.board?.kind === 'sticker').length).toBe(1);
  // "All templates" opens the templates tab with every template.
  await page.getByRole('button', {name: 'More: stickers, templates, stamps'}).click();
  await sheet.getByRole('button', {name: 'All templates'}).click();
  await expect(sheet.getByRole('tab', {name: 'Templates'})).toHaveAttribute('aria-selected', 'true');
  await expect(sheet.locator('.bd-template:not(.is-sticker)')).toHaveCount(10);
});
