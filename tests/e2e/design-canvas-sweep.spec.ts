import {crc32, deflateSync} from 'node:zlib';
import {test, expect, fileChooser, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument, Guide, SceneNode} from '../../shared/design/types';

// "Morfa Design": the canvas as a designer coming from Figma uses it (the second canvas sweep of 2026-10-07):
// ⌘/Ctrl + arrows resize, ⌘. hides the interface like ⌘\, a tool key switches the toolbar at once, a click selects a
// guide and Delete removes it (never the layer that was selected before) and leaves it where it is, a placed
// picture is one undo step and a copy made while it uploads gets it too, a paste of thousands of layers saves.
// Every check reads the document the server saved (autosave) or the page.

type Saved = {file: {name: string; version: number}; document: DesignDocument};
type Pt = {x: number; y: number};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}

const ofType = (file: Saved, type: SceneNode['type']) => Object.values(file.document.nodes).filter(node => node.type === type);
const guidesOf = (file: Saved): Guide[] => file.document.nodes[file.document.pages[0]]?.guides ?? [];

/** A new empty file: on its first look the page origin is at the canvas's centre, at 100 %. */
async function openNewFile(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  // The editor takes keys, and co-editing and the meeting have mounted (fixtures.ts `waitEditorReady`).
  await waitEditorReady(page);
  const box = (await canvas.boundingBox())!;
  const centre = {x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2)};
  const at = (x: number, y: number): Pt => ({x: centre.x + x, y: centre.y + y});
  await page.mouse.click(box.x + 30, box.y + 30);
  return {id: fileIdFrom(page), at};
}

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x * 2 + to.x) / 3, (from.y * 2 + to.y) / 3, {steps: 5});
  await page.mouse.move(to.x, to.y, {steps: 5});
  await page.mouse.up();
}

test('⌘/Ctrl + arrows resize the selection from its right and bottom sides, held keys undo in one step; ⌘. hides the interface', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-100, -60), at(100, 60));
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.x, node.y, node.width, node.height])).toEqual([[-100, -60, 200, 120]]);
  await page.keyboard.press('ControlOrMeta+ArrowRight');
  await page.keyboard.press('ControlOrMeta+ArrowRight');
  await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.x, node.y, node.width, node.height])).toEqual([[-100, -60, 202, 129]]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.width, node.height])).toEqual([[200, 120]]);

  const editor = page.locator('.dz-editor');
  await page.keyboard.press('ControlOrMeta+Period');
  await expect(editor).toHaveClass(/is-ui-hidden/);
  await page.keyboard.press('ControlOrMeta+Period');
  await expect(editor).not.toHaveClass(/is-ui-hidden/);
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(editor).toHaveClass(/is-ui-hidden/);
  // Esc lets the selection go first, then brings the interface back.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(editor).not.toHaveClass(/is-ui-hidden/);

  // ⇧\ folds the side panels into floating bars (Figma's Minimize UI): the file, its actions and the tools stay.
  await page.keyboard.press('Shift+Backslash');
  await expect(editor).toHaveClass(/is-ui-minimized/);
  await expect(page.locator('.dz-side-panel')).toHaveCount(0);
  await expect(page.getByRole('toolbar', {name: 'File', exact: true})).toBeVisible();
  await expect(page.getByRole('toolbar', {name: 'File actions'}).getByRole('button', {name: 'Export'})).toBeVisible();
  await expect(page.getByRole('toolbar', {name: 'Tools'})).toBeVisible();
  await page.getByRole('button', {name: 'Expand UI'}).click();
  await expect(editor).not.toHaveClass(/is-ui-minimized/);
  await expect(page.locator('.dz-side-panel')).toHaveCount(2);
});

test('a tool key switches the toolbar at once: no button fades between pressed and plain', async ({page, seed: _seed}) => {
  await openNewFile(page);
  const toolbar = page.getByRole('toolbar', {name: 'Tools'});
  const move = toolbar.getByRole('button', {name: 'Move', exact: true});
  const rectangle = toolbar.getByRole('button', {name: 'Rectangle', exact: true});
  await expect(move).toHaveAttribute('aria-pressed', 'true');
  // Computed colours read in the same task as the key: a transition would still show the old ones.
  const read = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.dz-toolbar .dz-icon-btn')].map(button => [button.getAttribute('aria-label'), getComputedStyle(button).backgroundColor, getComputedStyle(button).transitionDuration]));
  const before = new Map((await read()).map(([label, background]) => [label, background]));
  await page.keyboard.press('r');
  await expect(rectangle).toHaveAttribute('aria-pressed', 'true');
  const after = new Map((await read()).map(([label, background, duration]) => [label, [background, duration]]));
  expect(after.get('Rectangle')![0]).toBe(before.get('Move'));
  expect(after.get('Move')![0]).toBe(before.get('Rectangle'));
  expect(after.get('Move')![1]).toBe('0s');
});

test('guides: a click selects one and leaves it in place, Delete removes it and not the selected layer, ⌘Z brings it back', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-100, -60), at(100, 60));
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(1);
  await page.keyboard.press('Shift+r');
  // ⇧R shows the rulers on the next render: wait for the top one before measuring it.
  const topRuler = page.locator('.dz-ruler.is-top');
  await expect(topRuler).toBeVisible();
  const ruler = (await topRuler.boundingBox())!;
  // Out of the top ruler, down to y = 150 of the page (below the rectangle, which stays selected).
  await drag(page, {x: at(250, 0).x, y: ruler.y + ruler.height / 2}, at(250, 150));
  await expect.poll(async () => guidesOf(await saved(page, id))).toEqual([{axis: 'Y', offset: 150}]);

  // A click 2 px off the line grabs it, selects it and leaves it where it was.
  await page.mouse.click(at(-300, 152).x, at(-300, 152).y);
  await page.keyboard.press('Delete');
  await expect.poll(async () => guidesOf(await saved(page, id))).toEqual([]);
  expect(ofType(await saved(page, id), 'RECTANGLE')).toHaveLength(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => guidesOf(await saved(page, id))).toEqual([{axis: 'Y', offset: 150}]);

  // Esc lets a selected guide go: Delete then removes the selected layer, as usual.
  await page.mouse.click(at(-300, 150).x, at(-300, 150).y);
  await page.keyboard.press('Escape');
  await page.mouse.click(at(0, 0).x, at(0, 0).y);
  await page.keyboard.press('Backspace');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE')).toHaveLength(0);
  expect(guidesOf(await saved(page, id))).toEqual([{axis: 'Y', offset: 150}]);

  // Dragging still moves it by the pointer's travel.
  await drag(page, at(-300, 151), at(-300, 181));
  await expect.poll(async () => guidesOf(await saved(page, id))).toEqual([{axis: 'Y', offset: 180}]);
});

/** A plain RGB PNG of the given size (one deflated IDAT). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, 0x20);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({length: height}, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

type ImageFill = {type: string; imageRef?: string};
const imageRefs = (file: Saved) => ofType(file, 'RECTANGLE').map(node => ((node.fills[0] as ImageFill | undefined)?.type === 'IMAGE' ? (node.fills[0] as ImageFill).imageRef : null));

test('a placed picture is one undo step; a ⌘D copy made while it uploads gets the picture too', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  // The upload takes a moment, as on a slow connection: the copy is made before it lands.
  await page.route('**/api/design-files/*/images', async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.continue();
  });
  const chooser = await fileChooser(page, () => page.keyboard.press('ControlOrMeta+Shift+k'));
  await chooser.setFiles({name: 'Photo.png', mimeType: 'image/png', buffer: png(64, 48)});
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Image', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(at(0, 0).x, at(0, 0).y);
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => imageRefs(await saved(page, id))).toEqual([expect.stringMatching(/^dz-/), expect.stringMatching(/^dz-/)]);
  // ⌘Z takes the copy away, the next ⌘Z the picture: never an empty grey placeholder left behind.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => imageRefs(await saved(page, id))).toEqual([expect.stringMatching(/^dz-/)]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE')).toHaveLength(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => imageRefs(await saved(page, id))).toEqual([expect.stringMatching(/^dz-/)]);
});

test('a paste of thousands of layers saves, and later edits save after it', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  const {id} = await openNewFile(page);
  // 12 000 layers in one change: more than one PATCH may carry (8 MB), well within a file (20 MB).
  await page.evaluate(async () => {
    const {createNode} = await import('/shared/design/defaults.ts' as string) as {createNode(type: string, props: object): object};
    const store = (window as unknown as {__morfaDesignTest: {store: {getState(): {pageId: string}; transact(label: string, recipe: (tx: {create(node: object, parent: string): void}) => void): void}}}).__morfaDesignTest.store;
    const pageId = store.getState().pageId;
    store.transact('Paste', tx => {
      for (let i = 0; i < 12_000; i++) tx.create(createNode('RECTANGLE', {id: `big${i}`, name: `Layer ${i}`, x: (i % 120) * 12, y: Math.floor(i / 120) * 12, width: 10, height: 10}), pageId);
    });
  });
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length, {timeout: 60_000}).toBe(12_000);
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {transact(label: string, recipe: (tx: {update(id: string, partial: object): void}) => void): void}}}).__morfaDesignTest.store.transact('Rename', tx => tx.update('big0', {name: 'First'})));
  await expect.poll(async () => (await saved(page, id)).document.nodes.big0?.name, {timeout: 30_000}).toBe('First');
  await expect(page.getByText('Saved', {exact: true})).toBeVisible();
});
