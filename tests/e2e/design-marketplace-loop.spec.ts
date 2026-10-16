import type {Page} from '@playwright/test';
import {test, expect, waitEditorReady} from './fixtures';
import {createDocument, createNode} from '../../shared/design/defaults';
import type {NodeId} from '../../shared/design/types';

// Performance Loop (docs/marketplaces.md §Performance Loop) in the real editor against the fake Wildberries of scripts/e2e-server.ts:
// a seller connects WB (a refused key first), links the card to a product, publishes it, the worker reads a day of numbers and the
// canvas strip shows the CTR; then a rotation of A against B runs to its end and B wears "Winner" on the canvas and in "Sales".


const harnessKey = () => ({'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!});
const origin = (page: Page) => new URL(page.url()).origin;

type Numbers = {views: number | null; clicks: number; carts: number; orders: number};
/** What the fake WB reports per frame live that day, then the loop's clock `hours` ahead (the worker's pass every three hours). */
async function marketplace(page: Page, numbers: Record<string, Numbers>, hours: number) {
  const response = await page.request.post('/__e2e/marketplace', {headers: harnessKey(), data: {numbers, advanceHours: hours}});
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as {uploads: number; calls: number};
}

const card = {'morfa.mp.card': JSON.stringify({v: 1, marketplace: 'wb', group: 'g-1'})};
/** A file with two WB cards side by side: "Cover A" and "Cover B". */
async function openCards(page: Page): Promise<string> {
  await page.goto('/#designs');
  const doc = createDocument('0:1', 'Cards');
  for (const [id, name, x] of [['1:1', 'Cover A', 0], ['1:2', 'Cover B', 1000]] as const) {
    doc.nodes[id] = {...createNode('FRAME', {id, name, parentId: '0:1', x, y: 0, width: 900, height: 1200}), pluginData: card};
    doc.nodes['0:1']!.children!.push(id);
  }
  const response = await page.request.post('/api/design-files', {headers: {Origin: origin(page)}, data: {name: 'Mug', document: doc}});
  expect(response.ok(), await response.text()).toBeTruthy();
  const {file} = (await response.json()) as {file: {id: string}};
  await page.goto('/#design/' + encodeURIComponent(file.id));
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await waitEditorReady(page);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);
  return file.id;
}

const select = (page: Page, id: NodeId) =>
  page.evaluate(id => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: NodeId[]): void}}}).__morfaDesignTest.store.setSelection([id]), id);
/** What the canvas drew under (and over) each card frame: frame id → text (metrics-overlay.ts, under webdriver only). */
const strips = (page: Page) => page.evaluate(() => (window as unknown as {__morfaMarketplaceStrips?: Record<string, string>}).__morfaMarketplaceStrips ?? {});
/** "Sales" opened again: the tab reads the file's numbers afresh. */
async function sales(page: Page) {
  await page.getByRole('tab', {name: 'Check'}).click();
  await page.getByRole('tab', {name: 'Sales'}).click();
}

test('connect WB, link and publish the card, its CTR on the canvas, a rotation A against B with B the winner', async ({page, seed: _seed}) => {
  test.setTimeout(180_000);
  const fileId = await openCards(page);
  await page.getByRole('application', {name: 'Canvas'}).click({position: {x: 20, y: 20}});
  await page.keyboard.press('Shift+Digit1');
  await select(page, '1:1');
  await expect(page.getByRole('heading', {name: 'WB card', exact: true})).toBeVisible();
  await page.getByRole('tab', {name: 'Sales'}).click();

  // Connect: a key WB refuses says so in the dialog; the right one connects (and never comes back to the page).
  await page.getByRole('button', {name: 'Connect Wildberries'}).click();
  const dialog = page.getByRole('dialog', {name: 'Connect Wildberries'});
  await dialog.getByLabel('API token').fill('bad-token-e2e-0000000000');
  await dialog.getByRole('button', {name: 'Connect', exact: true}).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('API token').fill('e2e-token-seller-7f3a91c2b4');
  await dialog.getByRole('button', {name: 'Connect', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('e2e-token-seller-7f3a91c2b4');

  // Link: the product found by name, the main photo.
  await page.getByRole('textbox', {name: 'Product'}).fill('Mug');
  await page.getByRole('list', {name: 'Products'}).getByRole('button', {name: /Ceramic mug 350 ml/}).click();
  await page.getByRole('button', {name: 'Link to product'}).click();
  await expect(page.getByText(/Wildberries · nmID 187654321 · photo 1/)).toBeVisible();
  await expect(page.getByText(/No numbers yet/)).toBeVisible();

  // Publish: the frame rendered and sent to WB's slot 1 (Spec Lint's errors, if any, asked about first).
  await page.getByRole('button', {name: 'Publish to Wildberries'}).click();
  const confirm = page.getByRole('alertdialog', {name: 'The check found errors'});
  const published = page.getByRole('status').filter({hasText: /^Live/});
  await expect(confirm.or(published)).toBeVisible({timeout: 30_000});
  if (await confirm.isVisible()) await confirm.getByRole('button', {name: 'Publish anyway'}).click();
  await expect(published).toBeVisible({timeout: 30_000});

  // A day later the worker has read WB's numbers: 31 card opens of 1 000 impressions on each day A was live.
  const uploads = (await marketplace(page, {'1:1': {views: 1000, clicks: 31, carts: 4, orders: 2}}, 24)).uploads;
  expect(uploads).toBe(1);
  await sales(page);
  const numbers = page.getByRole('region', {name: 'Sales'});
  await expect(numbers).toContainText(/CTR\s*3\.1%/);
  await expect(page.getByText('Card Score')).toBeVisible();
  await expect.poll(async () => (await strips(page))['1:1'] ?? '').toMatch(/CTR 3\.1%/);

  // A/B: "Cover B" against A in Morfa's rotation for two days, swapped at Moscow midnight.
  const ab = page.getByRole('region', {name: 'A/B test'});
  await expect(ab.getByRole('button', {name: 'Variant B'})).toContainText('Cover B');
  await ab.getByRole('radio', {name: 'Rotation in Morfa'}).click();
  const days = ab.getByRole('spinbutton', {name: 'Test days'});
  await days.fill('2');
  await days.press('Enter');
  await ab.getByRole('button', {name: 'Start rotation'}).click();
  await expect(ab).toContainText(/Rotation · \d+ days? left/, {timeout: 30_000});
  await expect(ab.getByRole('button', {name: 'Stop'}).first()).toBeVisible();

  // Three days on, B (6% CTR) beat A (1.5%): it stays live and the canvas marks it.
  await marketplace(page, {'1:1': {views: 1000, clicks: 15, carts: 2, orders: 1}, '1:2': {views: 1000, clicks: 60, carts: 8, orders: 4}}, 4 * 24);
  await sales(page);
  await expect(ab).toContainText('Winner: B "Cover B"', {timeout: 20_000});
  await expect(ab).toContainText(/CTR 1\.5%\s→\s6\.0%/);
  await expect.poll(async () => (await strips(page))['1:2'] ?? '').toContain('Winner');
  const cards = (await (await page.request.get(`/api/marketplace/files/${encodeURIComponent(fileId)}/cards`)).json()) as {
    tests: {winner: string; status: string}[];
    publications: {nodeId: string; status: string}[];
  };
  expect(cards.tests[0]).toMatchObject({status: 'finished', winner: 'b'});
  expect(cards.publications.find(publication => publication.status === 'live')?.nodeId).toBe('1:2');

  // "Next round from the winner": the card now stands for B, and a copy of B is the next variant.
  await ab.getByRole('button', {name: 'Next round from the winner'}).click();
  await expect.poll(async () => {
    const next = (await (await page.request.get(`/api/marketplace/files/${encodeURIComponent(fileId)}/cards`)).json()) as {links: {nodeId: string}[]};
    return next.links.map(link => link.nodeId);
  }).toEqual(['1:2']);
});
