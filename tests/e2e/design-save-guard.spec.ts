import {readFile} from 'node:fs/promises';
import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// Morfa Design: saving never loses work (src/design/persistence/patch-guard.ts, recovery.ts). A layer the server
// would refuse is caught before it is sent, taken back with a toast that offers a copy, and everything after it
// saves; a picture of another account in a paste is dropped from the server's answer while its layer saves; a
// change refused again stops saving with "Saving stopped", a copy to download and a reload.

type SavedNode = {id: string; type: string; name: string; x: number; parentId: string | null};
type Saved = {file: {version: number}; document: {pages: string[]; nodes: Record<string, SavedNode>; images: Record<string, unknown>}};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const rectangles = (file: Saved) => Object.values(file.document.nodes).filter(node => node.type === 'RECTANGLE');
const savedStatus = (page: Page) => page.getByRole('status').filter({hasText: 'Saved'});
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQBXJ5kAAAAASUVORK5CYII=';

async function newFile(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  await expect(savedStatus(page)).toBeVisible();
  return {id: fileIdFrom(page), canvas, box: (await canvas.boundingBox())!};
}

/** R, then a drag from (x, y) of the canvas: a rectangle 120 × 80. */
async function drawRectangle(page: Page, box: {x: number; y: number}, x: number, y: number) {
  await page.keyboard.press('r');
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 60, box.y + y + 40, {steps: 4});
  await page.mouse.move(box.x + x + 120, box.y + y + 80, {steps: 4});
  await page.mouse.up();
}

test('a layer the server would refuse is taken back, the user told once, and everything after it saves', async ({page, seed: _seed}) => {
  const {id, canvas, box} = await newFile(page);
  await canvas.click({position: {x: 40, y: 40}});
  await drawRectangle(page, box, 200, 200);
  await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(1);

  // A layer with a link the server never stores (javascript:), put in through the store as a broken paste or
  // import would: no UI path makes one any more.
  await page.evaluate(() => {
    type Node = {id: string; type: string; x: number; name: string};
    const store = (window as unknown as {__morfaDesignTest: {store: {getState(): {doc: {nodes: Record<string, Node>}; pageId: string}; transact(label: string, recipe: (tx: {create(node: unknown, parentId: string): void}) => void): void}}}).__morfaDesignTest.store;
    const state = store.getState();
    const rect = Object.values(state.doc.nodes).find(node => node.type === 'RECTANGLE')!;
    store.transact('Paste', tx => tx.create({
      ...rect,
      id: 'e2e-bad-layer',
      name: 'Button',
      x: rect.x + 300,
      reactions: [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'javascript:alert(1)', openInNewTab: true}]}],
    }, state.pageId));
  });
  // The designer keeps working before the save goes.
  await drawRectangle(page, box, 200, 420);

  const toast = page.locator('.dz-toast').filter({hasText: 'Could not save layer "Button"'});
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('the link must start with http://, https:// or mailto:. The change was reverted.');
  await expect(page.locator('.dz-toast').filter({hasText: 'Could not save'})).toHaveCount(1);
  await expect(savedStatus(page)).toBeVisible();
  await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(2);
  expect((await saved(page, id)).document.nodes['e2e-bad-layer']).toBeUndefined();

  // "Download a copy": the open document as .rdesign.
  const download = page.waitForEvent('download');
  await toast.getByRole('button', {name: 'Download a copy', exact: true}).click();
  const file = await download;
  // (Only the downloaded content matters here.)
  const copy = JSON.parse(await readFile((await file.path())!, 'utf8')) as {format: string; document: Saved['document']};
  expect(copy.format).toBe('morfa-design');
  expect(Object.values(copy.document.nodes).filter(node => node.type === 'RECTANGLE')).toHaveLength(2);

  // After a reload the later work is there, and saving goes on.
  await page.reload();
  await expect(canvas).toBeVisible();
  await expect(savedStatus(page)).toBeVisible();
  expect(rectangles(await saved(page, id))).toHaveLength(2);
  await drawRectangle(page, box, 520, 200);
  await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(3);
  await expect(page.locator('.dz-toast').filter({hasText: 'Could not save'})).toHaveCount(0);
});

test('a pasted picture of another account is dropped from the server’s answer; its layer saves', async ({page, seed: _seed}) => {
  const {id, canvas, box} = await newFile(page);
  await canvas.click({position: {x: 40, y: 40}});
  // A copy made in another account: a layer filled with a picture this account does not own.
  const ref = 'dz-00000000-0000-4000-8000-00000000e2e0';
  // The browser may draw the picture while the paste waits for its save (here a 1 × 1 PNG); the server refuses its record.
  await page.route(`**/uploads/${ref}.webp`, route => route.fulfill({status: 200, contentType: 'image/png', body: Buffer.from(PIXEL, 'base64')}));
  const payload = JSON.stringify({
    morfaDesign: 1,
    roots: ['foreign'],
    nodes: {foreign: {id: 'foreign', type: 'RECTANGLE', name: 'Photo', x: 0, y: 0, width: 160, height: 100,
      fills: [{type: 'IMAGE', imageRef: ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]}},
    world: {foreign: [[1, 0, 100], [0, 1, 100]]},
    parentWorld: {foreign: [[1, 0, 0], [0, 1, 0]]},
    styles: {},
    images: {[ref]: {url: `/uploads/${ref}.webp`, width: 160, height: 100, name: 'Foreign photo.webp'}},
  });
  await page.evaluate(text => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, payload);
  const toast = page.locator('.dz-toast').filter({hasText: 'Could not save image "Foreign photo.webp"'});
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('image is not available to this account');
  await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(1);
  const stored = await saved(page, id);
  expect(rectangles(stored)[0].name).toBe('Photo');
  expect(stored.document.images).toEqual({});
  // Work after it saves.
  await drawRectangle(page, box, 420, 260);
  await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(2);
});

test('a change refused again stops saving with a banner: a copy first, then the stored file and saving again', async ({page, seed: _seed}) => {
  const {id, canvas, box} = await newFile(page);
  await canvas.click({position: {x: 40, y: 40}});
  await drawRectangle(page, box, 240, 220);
  await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(1);
  const rect = rectangles(await saved(page, id))[0];
  // A server that refuses this layer whatever it holds: a check the editor does not know of.
  const refuse = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fulfill({status: 400, json: {error: 'File not saved: The layer is locked.', code: 'design_document_invalid', path: `nodes.${rect.id}`, entry: {table: 'nodes', key: rect.id}, nodeId: rect.id}});
  };
  await page.route('**/api/design-files/*/document', refuse);
  // Nudge it: refused, put back, refused again: saving stops.
  await page.keyboard.press('Shift+ArrowRight');
  const banner = page.getByRole('alert').filter({hasText: 'Saving stopped'});
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(`Could not save layer "${rect.name}": the layer is locked.`);
  await expect(page.locator('.dz-save-status')).toHaveText('Not saved');
  await page.screenshot({path: test.info().outputPath('stopped-light.png')});
  await page.emulateMedia({colorScheme: 'dark'});
  await page.screenshot({path: test.info().outputPath('stopped-dark.png')});
  await page.emulateMedia({colorScheme: 'light'});

  // Work goes on in the editor and is kept for the copy, but nothing more is sent.
  await drawRectangle(page, box, 520, 220);
  const download = page.waitForEvent('download');
  await banner.getByRole('button', {name: 'Download a copy', exact: true}).click();
  const copy = JSON.parse(await readFile((await (await download).path())!, 'utf8')) as {document: Saved['document']};
  expect(Object.values(copy.document.nodes).filter(node => node.type === 'RECTANGLE')).toHaveLength(2);
  expect(rectangles(await saved(page, id))).toHaveLength(1);

  // "Reload file": the stored copy, the banner gone, saving back.
  await page.unroute('**/api/design-files/*/document', refuse);
  await banner.getByRole('button', {name: 'Reload file', exact: true}).click();
  await expect(banner).toBeHidden();
  await expect(savedStatus(page)).toBeVisible();
  await drawRectangle(page, box, 520, 420);
  await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(2);
});
