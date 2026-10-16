import {crc32, deflateSync} from 'node:zlib';
import {test, expect, fileChooser, waitEditorReady} from './fixtures';
import type {Locator, Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// "Morfa Design" behaving as a designer coming from Figma expects (the QA findings of 2026-10-07): Space
// held during a drag keeps a layer out of frames; a layer lifted out of a clipping auto-layout row draws
// outside it while dragged; a placed picture keeps its natural size; new layers are numbered across the
// page; a frame moves by its title; ⌥> and ⌥⇧> step letter spacing and line height; Escape from a colour
// picker gives focus back to its swatch and Space still pans; a component's description takes several
// lines; a previewed version lists its own layers; a long name leaves the panel's header (its kind) and width alone.
// Every check reads the saved document, the canvas's pixels or the page's focus.

type Saved = {file: {name: string; version: number}; document: DesignDocument};
type Pt = {x: number; y: number};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}

const ofType = (file: Saved, type: SceneNode['type']) => Object.values(file.document.nodes).filter(node => node.type === type);

/** A new empty file: the page origin at the canvas's centre, at 100 %. */
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
  return {id: fileIdFrom(page), canvas, box, at};
}

async function drag(page: Page, from: Pt, to: Pt, hold?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x * 2 + to.x) / 3, (from.y * 2 + to.y) / 3, {steps: 5});
  await hold?.();
  await page.mouse.move(to.x, to.y, {steps: 5});
  await page.mouse.up();
}

async function pixel(canvas: Locator, point: Pt): Promise<[number, number, number]> {
  return canvas.page().evaluate(([px, py]) => {
    const element = document.querySelector<HTMLCanvasElement>('.dz-canvas__scene')!;
    const rect = element.getBoundingClientRect();
    const scale = element.width / rect.width;
    const data = element.getContext('2d')!.getImageData(Math.round((px - rect.left) * scale), Math.round((py - rect.top) * scale), 1, 1).data;
    return [data[0], data[1], data[2]] as [number, number, number];
  }, [point.x, point.y] as const);
}
const isGrey = ([r, g, b]: number[]) => Math.abs(r - 217) < 8 && Math.abs(g - 217) < 8 && Math.abs(b - 217) < 8;

/** A plain grey PNG of the given size (an RGB image, one deflated IDAT). */
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
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({length: height}, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('Space held mid-drag keeps a layer out of the frame; new layers are numbered across the page; a frame moves by its title', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-200, -150), at(100, 150));
  await page.keyboard.press('r');
  await drag(page, at(-180, -120), at(-120, -60));
  await page.keyboard.press('r');
  await drag(page, at(200, 100), at(260, 160));
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => node.name).sort()).toEqual(['Rectangle 1', 'Rectangle 2']);
  const frame = ofType(await saved(page, id), 'FRAME')[0];
  const loose = ofType(await saved(page, id), 'RECTANGLE').find(node => node.parentId !== frame.id)!;
  expect(loose.name).toBe('Rectangle 2');

  // Space pressed once the drag runs: the rectangle crosses into the frame and stays on the page.
  await drag(page, at(230, 130), at(0, 0), async () => {
    await page.keyboard.down('Space');
  });
  await page.keyboard.up('Space');
  await expect.poll(async () => (await saved(page, id)).document.nodes[loose.id].x).toBeLessThan(100);
  expect((await saved(page, id)).document.nodes[loose.id].parentId).toBe((await saved(page, id)).document.pages[0]);
  // Without it, the same move nests it.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await saved(page, id)).document.nodes[loose.id].x).toBe(200);
  await drag(page, at(230, 130), at(0, 0));
  await expect.poll(async () => (await saved(page, id)).document.nodes[loose.id].parentId).toBe(frame.id);

  // The frame's title (above its top-left corner) drags the frame.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await drag(page, at(-190, -158), at(-170, -128));
  await expect.poll(async () => {
    const node = (await saved(page, id)).document.nodes[frame.id];
    return [node.x, node.y];
  }).toEqual([frame.x + 20, frame.y + 30]);
});

test('a layer lifted out of a clipping auto-layout row draws outside it while it is dragged', async ({page, seed: _seed}) => {
  const {id, canvas, at} = await openNewFile(page);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('r');
    await drag(page, at(-200 + i * 80, -100), at(-140 + i * 80, -40));
  }
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Shift+a');
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').filter(node => node.autoLayout?.layoutMode === 'HORIZONTAL').length).toBe(1);
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const clip = design.getByRole('checkbox', {name: 'Clip content'});
  if (!(await clip.isChecked())) await clip.click();
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME')[0].clipsContent).toBe(true);
  const row = ofType(await saved(page, id), 'FRAME')[0];
  // Grab the first rectangle by its middle and carry it down to the row's bottom edge: half of it hangs
  // below the row, where a clipped child would not show.
  const first = (await saved(page, id)).document.nodes[row.children![0]];
  const grab = at(row.x + first.x + 30, row.y + first.y + 30);
  const to = at(row.x + 100, row.y + row.height - 4);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y - 20, {steps: 5});
  await page.mouse.move(to.x, to.y, {steps: 5});
  const below = {x: to.x, y: to.y + 20};
  await expect.poll(async () => isGrey(await pixel(canvas, below))).toBe(true);
  await page.mouse.up();
  await expect.poll(async () => (await saved(page, id)).document.nodes[first.id].layoutPositioning).toBe('AUTO');
});

test('a picture placed with ⇧⌘K and a click comes in at its natural size', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  const chooser = await fileChooser(page, () => page.keyboard.press('ControlOrMeta+Shift+k'));
  await chooser.setFiles({name: 'Screenshot.png', mimeType: 'image/png', buffer: png(393, 852)});
  // The image tool waits for a click to place it.
  await page.waitForTimeout(300);
  await page.mouse.click(at(0, 0).x, at(0, 0).y);
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.name, node.width, node.height])).toEqual([['Screenshot', 393, 852]]);
});

test('⌥> and ⌥⇧> step letter spacing and line height of a selected text', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('t');
  await page.mouse.click(at(0, 0).x, at(0, 0).y);
  await page.keyboard.type('Heading');
  await page.keyboard.press('Escape');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT').map(node => node.text?.characters)).toEqual(['Heading']);
  const before = ofType(await saved(page, id), 'TEXT')[0].text!.style;
  await page.keyboard.press('Alt+Period');
  await page.keyboard.press('Alt+Period');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT')[0].text!.style.letterSpacing?.value).toBe((before.letterSpacing?.value ?? 0) + 2);
  await page.keyboard.press('Alt+Shift+Comma');
  await expect.poll(async () => {
    const lineHeight = ofType(await saved(page, id), 'TEXT')[0].text!.style.lineHeight;
    return lineHeight.unit === 'AUTO' ? 'AUTO' : lineHeight.unit;
  }).toBe('PIXELS');
  // Typed into: the keys format the selection instead of typing a character.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Alt+Comma');
  await page.keyboard.press('Escape');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT')[0].text!.style.letterSpacing?.value).toBe((before.letterSpacing?.value ?? 0) + 1);
  expect(ofType(await saved(page, id), 'TEXT')[0].text!.characters).toBe('Heading');
});

test('Escape from a colour picker gives focus back to its swatch, and Space still pans the canvas', async ({page, seed: _seed}) => {
  const {at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-60, -40), at(60, 40));
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const swatch = design.getByRole('button', {name: 'Open palette'}).first();
  await swatch.click();
  const picker = page.getByRole('dialog', {name: 'Fill'});
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(swatch).toBeFocused();
  // Space held with a drag pans; the swatch is not pressed by it.
  const scene = page.locator('.dz-canvas__scene');
  const before = await scene.screenshot();
  await page.keyboard.down('Space');
  await drag(page, at(200, 200), at(260, 240));
  await page.keyboard.up('Space');
  await expect(picker).toBeHidden();
  await expect.poll(async () => Buffer.compare(await scene.screenshot(), before) !== 0).toBe(true);
  // Enter opens it from the keyboard.
  await swatch.focus();
  await page.keyboard.press('Enter');
  await expect(picker).toBeVisible();
});

test('a component’s description takes several lines and grows with them', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-60, -40), at(60, 40));
  await page.keyboard.press('ControlOrMeta+Alt+k');
  const field = page.getByRole('textbox', {name: 'Component description'});
  await expect(field).toBeVisible();
  const oneLine = (await field.boundingBox())!.height;
  await field.click();
  await page.keyboard.type('Primary button for forms.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('One per screen; for secondary actions, use the secondary one.');
  await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThan(oneLine * 2);
  await page.mouse.click(at(300, 250).x, at(300, 250).y);
  await expect.poll(async () => ofType(await saved(page, id), 'COMPONENT').map(node => node.description))
    .toEqual(['Primary button for forms.\nOne per screen; for secondary actions, use the secondary one.']);
});

test('a previewed version lists its own layers; a long name ellipsizes in the panel header', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-200, -150), at(100, 150));
  await page.keyboard.press('r');
  await drag(page, at(-180, -120), at(-120, -60));
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(1);
  // A long name: the header's title ellipsizes and the alignment row stays inside the panel.
  await page.keyboard.press('ControlOrMeta+r');
  const rename = page.getByRole('textbox', {name: 'Layer name'});
  await expect(rename).toBeFocused();
  await rename.fill('Product card with a long name that does not fit in the panel header');
  await page.keyboard.press('Enter');
  const panel = (await page.locator('.dz-side-panel.is-right').boundingBox())!;
  // As UI3, the header names the kind of layer (lane FD): the long name stays in the layers, the panel keeps its width.
  const title = page.locator('.dz-pl-header-title');
  await expect(title).toHaveText('Rectangle');
  const [titleBox, align] = [(await title.boundingBox())!, (await page.locator('.dz-pl-align').boundingBox())!];
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(panel.x + panel.width);
  expect(align.x + align.width).toBeLessThanOrEqual(panel.x + panel.width);
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE')[0].name).toMatch(/^Product card/);

  await page.keyboard.press('ControlOrMeta+Alt+s');
  const history = page.getByRole('complementary', {name: 'Version history'});
  await expect(history.getByRole('textbox', {name: 'Version name'})).toBeFocused();
  await page.keyboard.type('With the card');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Version "With the card" saved')).toBeVisible();
  await history.getByRole('button', {name: 'Close version history', exact: true}).click();
  // Now remove the card: the file's layers no longer list it.
  await page.mouse.click(at(-150, -90).x, at(-150, -90).y);
  await page.keyboard.press('Delete');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(0);
  const fileTree = page.getByRole('tree', {name: 'Layers', exact: true});
  await expect(fileTree.getByRole('treeitem', {name: /Product card/})).toHaveCount(0);

  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'File', exact: true}).hover();
  await page.getByRole('menuitem', {name: 'Version history', exact: true}).click();
  await history.getByText('With the card', {exact: true}).click();
  await expect(page.getByText(/You are viewing the version "With the card"/)).toBeVisible();
  const versionTree = page.getByRole('tree', {name: 'Version layers'});
  await expect(versionTree.getByRole('treeitem', {name: /^Frame 1/})).toBeVisible();
  await expect(versionTree.getByRole('treeitem', {name: /^Product card/})).toBeVisible();
  await expect(fileTree).toBeHidden();
  await page.getByRole('button', {name: 'Back to current', exact: true}).click();
  await expect(versionTree).toHaveCount(0);
  await expect(fileTree).toBeVisible();
});
