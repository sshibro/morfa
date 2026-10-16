import {readFile} from 'node:fs/promises';
import {test, expect, fileChooser, waitEditorReady} from './fixtures';
import type {Locator, Page} from '@playwright/test';

// "Morfa Design" panels and screens (src/design/panels, src/design/files, src/design/versions): a fill
// changed in the colour picker and undone, auto layout added and padded from the "Design" tab, a text
// style applied to a layer of a starter template, a PNG exported from the "Export" section and from the
// export dialog, a file carried out and back in as .rdesign, and a named version saved and restored.
// Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type SavedNode = {
  id: string; type: string; name: string; x: number; y: number; width: number; height: number; parentId: string | null;
  fills: {type: string; color?: {r: number; g: number; b: number}; opacity?: number}[];
  autoLayout?: {layoutMode: string; paddingLeft: number; paddingRight: number; paddingTop: number; paddingBottom: number};
  textStyleId?: string; text?: {style: {fontSize: number}};
};
type Saved = {file: {name: string; version: number}; document: {pages: string[]; nodes: Record<string, SavedNode>; styles: Record<string, {name: string; type: string}>}};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const ofType = (file: Saved, type: string) => Object.values(file.document.nodes).filter(node => node.type === type);
const hexOf = (color: {r: number; g: number; b: number} | undefined) =>
  color ? [color.r, color.g, color.b].map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('').toUpperCase() : '';

/** The scene canvas's colour at a point of the canvas (CSS px from its top-left). */
async function pixel(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(([px, py]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.dz-canvas__scene')!;
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    const data = canvas.getContext('2d')!.getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data;
    return [data[0], data[1], data[2]].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  }, [x, y]);
}

async function newFile(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  // The editor takes keys, and co-editing and the meeting have mounted (fixtures.ts `waitEditorReady`).
  await waitEditorReady(page);
  return {id: fileIdFrom(page), canvas};
}

/** R, then a 200 × 120 drag around the canvas's centre (dx moves it sideways); the rectangle stays selected. */
async function drawRectangle(page: Page, canvas: Locator, dx = 0) {
  const box = (await canvas.boundingBox())!;
  const centre = {x: box.x + box.width / 2 + dx, y: box.y + box.height / 2};
  await page.keyboard.press('r');
  await page.mouse.move(centre.x - 100, centre.y - 60);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y, {steps: 4});
  await page.mouse.move(centre.x + 100, centre.y + 60, {steps: 4});
  await page.mouse.up();
  return {x: box.width / 2 + dx, y: box.height / 2};
}

const waitSaved = (page: Page) => expect(page.getByRole('status').filter({hasText: /^Saved/})).toBeVisible();

/** Width and height from a PNG's IHDR. */
function pngSize(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

test('a fill changes in the colour picker, one undo brings the old colour back and the panel prints 100%', async ({page, seed: _seed}) => {
  const {id, canvas} = await newFile(page);
  await canvas.click({position: {x: 30, y: 30}});
  const centre = await drawRectangle(page, canvas);
  await expect.poll(() => pixel(page, centre.x, centre.y)).toBe('D9D9D9');
  const design = page.getByRole('tabpanel', {name: 'Design'});
  // One percent format everywhere: the fill's opacity reads like the layer's.
  await expect(design.getByRole('spinbutton', {name: 'Fill opacity'})).toHaveValue('100%');
  await expect(design.getByRole('spinbutton', {name: 'Layer opacity'})).toHaveValue('100%');

  await design.getByRole('button', {name: 'Open palette'}).first().click();
  const picker = page.getByRole('dialog', {name: 'Fill'});
  await expect(picker).toBeVisible();
  const hex = picker.getByRole('textbox', {name: 'Color in HEX'});
  await expect(hex).toHaveValue('D9D9D9');
  await hex.fill('0D99FF');
  await hex.press('Enter');
  await expect.poll(() => pixel(page, centre.x, centre.y)).toBe('0D99FF');
  await expect(design.getByRole('textbox', {name: 'Color'})).toHaveValue('0D99FF');
  await expect.poll(async () => hexOf(ofType(await saved(page, id), 'RECTANGLE')[0]?.fills[0]?.color)).toBe('0D99FF');

  // The first Escape leaves the field, the second closes the picker; the rectangle stays selected.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(design.getByRole('textbox', {name: 'Color'})).toHaveValue('0D99FF');

  // A drag in the colour area is one gesture: a single ⌘Z takes all of it back.
  await design.getByRole('button', {name: 'Open palette'}).first().click();
  await expect(picker).toBeVisible();
  const area = (await picker.getByRole('slider', {name: 'Saturation and brightness'}).locator('..').boundingBox())!;
  await page.mouse.move(area.x + area.width * 0.2, area.y + area.height * 0.2);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++) await page.mouse.move(area.x + area.width * (0.2 + step * 0.05), area.y + area.height * (0.2 + step * 0.06));
  await page.mouse.up();
  await expect.poll(() => pixel(page, centre.x, centre.y)).not.toBe('0D99FF');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(page, centre.x, centre.y)).toBe('0D99FF');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(page, centre.x, centre.y)).toBe('D9D9D9');
  await expect.poll(async () => hexOf(ofType(await saved(page, id), 'RECTANGLE')[0]?.fills[0]?.color)).toBe('D9D9D9');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => pixel(page, centre.x, centre.y)).toBe('0D99FF');
  await waitSaved(page);
});

test('⇧A wraps a layer in auto layout and the padding typed in the panel moves it, one undo step', async ({page, seed: _seed}) => {
  const {id, canvas} = await newFile(page);
  await canvas.click({position: {x: 30, y: 30}});
  await drawRectangle(page, canvas);
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(1);
  await page.keyboard.press('Shift+a');

  const design = page.getByRole('tabpanel', {name: 'Design'});
  await expect(design.getByRole('radiogroup', {name: 'Flow'})).toBeVisible();
  await expect(design.getByRole('radio', {name: 'Horizontal'})).toBeChecked();
  await expect(design.getByRole('button', {name: 'Remove auto layout'})).toBeVisible();
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME')[0]?.autoLayout?.layoutMode).toBe('HORIZONTAL');
  const frame = ofType(await saved(page, id), 'FRAME')[0];
  expect(ofType(await saved(page, id), 'RECTANGLE')[0].parentId).toBe(frame.id);

  const horizontal = design.getByRole('spinbutton', {name: 'Horizontal padding'});
  await horizontal.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('20+4');
  await page.keyboard.press('Enter');
  await expect(horizontal).toHaveValue('24');
  await expect.poll(async () => {
    const file = await saved(page, id);
    const padded = ofType(file, 'FRAME')[0];
    return [padded.autoLayout?.paddingLeft, padded.autoLayout?.paddingRight, padded.width, ofType(file, 'RECTANGLE')[0].x];
  }).toEqual([24, 24, frame.width + 48, 24]);

  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME')[0]?.autoLayout?.paddingLeft).toBe(0);
  await expect(horizontal).toHaveValue('0');
  await waitSaved(page);
});

test('the template gallery makes a file, and a text style from the panel restyles its heading', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file from a template', exact: true}).click();
  for (const name of ['Blank file', 'Mobile app', 'Website', 'Presentation', 'Social media', 'UI kit'])
    await expect(page.getByRole('button', {name: new RegExp('^' + name)})).toBeVisible();
  await page.getByRole('button', {name: /^Mobile app/}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/, {timeout: 20_000});
  const id = fileIdFrom(page);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await expect(page.locator('.dz-file-name')).toHaveText('Mobile app');
  const file = await saved(page, id);
  expect(file.document.pages.length).toBe(2);
  expect(Object.values(file.document.styles).some(style => style.type === 'TEXT' && style.name === 'Heading/H2')).toBe(true);

  // Profile ▸ Header ▸ "Profile" (H1, 28 px), picked in the layers tree.
  const tree = page.getByRole('tree', {name: 'Layers'});
  const row = (level: number, name: string) => tree.locator(`[role=treeitem][aria-level="${level}"]`).filter({has: page.locator('.dz-layer-name', {hasText: new RegExp(`^${name}$`)})}).first();
  await row(1, 'Profile').locator('[data-caret]').click();
  await row(2, 'Header').locator('[data-caret]').click();
  await row(3, 'Profile').click();
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const size = design.getByRole('spinbutton', {name: 'Font size'});
  await expect(size).toHaveValue('28');

  await design.getByRole('button', {name: 'Text styles'}).click();
  await page.getByRole('menuitemradio', {name: /Heading \/ H2/}).click();
  await expect(size).toHaveValue('22');
  const h2 = Object.entries(file.document.styles).find(([, style]) => style.name === 'Heading/H2')![0];
  const heading = () => saved(page, id).then(current => ofType(current, 'TEXT').find(node => node.name === 'Profile' && node.text?.style.fontSize !== undefined && node.parentId !== null && current.document.nodes[node.parentId]?.name === 'Header'));
  await expect.poll(async () => (await heading())?.textStyleId).toBe(h2);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(size).toHaveValue('28');
  await expect.poll(async () => (await heading())?.textStyleId).not.toBe(h2);
  await waitSaved(page);
});

test('PNG export from the "Export" section and the export dialog writes real pictures', async ({page, seed: _seed}) => {
  const {canvas} = await newFile(page);
  await canvas.click({position: {x: 30, y: 30}});
  await drawRectangle(page, canvas);
  // An ASCII name keeps the download's name readable on any test machine's locale.
  const layer = page.getByRole('tree', {name: 'Layers'}).locator('.dz-layer-name').first();
  await layer.dblclick();
  const rename = page.getByRole('textbox', {name: 'Layer name'});
  await rename.fill('Card');
  await rename.press('Enter');
  await expect(layer).toHaveText('Card');

  const design = page.getByRole('tabpanel', {name: 'Design'});
  await design.getByRole('button', {name: 'Add export setting'}).click();
  const exportButton = design.getByRole('button', {name: 'Export Card'});
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  expect(download.suggestedFilename()).toBe('Card.png');
  expect(pngSize(await readFile((await download.path())!))).toEqual({width: 200, height: 120});

  // 2× from the scale menu: twice the pixels (the name changes only with a suffix, as typed).
  await design.getByRole('button', {name: 'Scale'}).click();
  await page.getByRole('menuitemradio', {name: '2x', exact: true}).click();
  const [double] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  expect(double.suggestedFilename()).toBe('Card.png');
  expect(pngSize(await readFile((await double.path())!))).toEqual({width: 400, height: 240});

  // ⇧⌘E: the dialog lists the layer with a drawn thumbnail and exports the same file.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+e');
  const dialog = page.getByRole('dialog', {name: 'Export'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Card', {exact: true})).toBeVisible();
  await expect.poll(() => dialog.locator('.dz-xd-thumb img').evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length)).toBe(1);
  const [fromDialog] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: 'Export 1 file'}).click()]);
  expect(fromDialog.suggestedFilename()).toBe('Card.png');
  expect(pngSize(await readFile((await fromDialog.path())!))).toEqual({width: 400, height: 240});
  await expect(dialog).toBeHidden();
});

test('a file goes out as .rdesign and comes back in as a new file with the same layers', async ({page, seed: _seed}) => {
  const {id, canvas} = await newFile(page);
  await canvas.click({position: {x: 30, y: 30}});
  await drawRectangle(page, canvas);
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const colour = design.getByRole('textbox', {name: 'Color'});
  await colour.fill('14AE5C');
  await colour.press('Enter');
  await page.locator('.dz-file-name').click();
  const title = page.getByRole('textbox', {name: 'File name', exact: true});
  await title.fill('Round trip');
  await title.press('Enter');
  await expect.poll(async () => hexOf(ofType(await saved(page, id), 'RECTANGLE')[0]?.fills[0]?.color)).toBe('14AE5C');
  await waitSaved(page);
  const original = await saved(page, id);

  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Back to files', exact: true}).click();
  await expect(page).toHaveURL(/#designs$/);
  const card = page.locator('.dz-file').filter({has: page.locator(`a[href="#design/${encodeURIComponent(id)}"]`)});
  await card.click({button: 'right'});
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', {name: 'Save to computer (.rdesign)', exact: true}).click()]);
  expect(download.suggestedFilename()).toBe('Round trip.rdesign');
  const path = (await download.path())!;

  await page.getByRole('button', {name: 'Import', exact: true}).click();
  const chooser = await fileChooser(page, () => page.getByRole('menuitem', {name: 'Open .rdesign file…', exact: true}).click());
  await chooser.setFiles({name: 'Round trip.rdesign', mimeType: 'application/json', buffer: await readFile(path)});
  await expect(page.getByText('"Round trip" added')).toBeVisible();
  await page.getByRole('button', {name: 'Open', exact: true}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const copyId = fileIdFrom(page);
  expect(copyId).not.toBe(id);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  const copy = await saved(page, copyId);
  expect(copy.file.name).toBe('Round trip');
  expect(Object.keys(copy.document.nodes).length).toBe(Object.keys(original.document.nodes).length);
  const rectangle = ofType(copy, 'RECTANGLE')[0];
  expect([rectangle.width, rectangle.height, hexOf(rectangle.fills[0].color)]).toEqual([200, 120, '14AE5C']);
});

test('a named version is saved with Enter and restored from the history', async ({page, seed: _seed}) => {
  const {id, canvas} = await newFile(page);
  await canvas.click({position: {x: 30, y: 30}});
  const centre = await drawRectangle(page, canvas);
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(1);
  await waitSaved(page);

  // ⌥⌘S opens the form in the history panel; Enter in the name saves it.
  await page.keyboard.press('ControlOrMeta+Alt+s');
  const history = page.getByRole('complementary', {name: 'Version history'});
  await expect(history.getByRole('form', {name: 'Save version'})).toBeVisible();
  await expect(history.getByRole('textbox', {name: 'Version name'})).toBeFocused();
  await page.keyboard.type('One rectangle');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Version "One rectangle" saved')).toBeVisible();
  await expect(history.getByText('One rectangle', {exact: true})).toBeVisible();
  await history.getByRole('button', {name: 'Close version history', exact: true}).click();
  await expect(history).toBeHidden();

  // Delete the rectangle; it is gone from the canvas and the saved file.
  await canvas.click({position: {x: centre.x, y: centre.y}});
  await page.keyboard.press('Delete');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(0);
  await expect.poll(() => pixel(page, centre.x, centre.y)).not.toBe('D9D9D9');
  await waitSaved(page);

  // History ▸ the version: a read-only preview with a banner; "Restore" brings the rectangle back.
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'File', exact: true}).hover();
  await page.getByRole('menuitem', {name: 'Version history', exact: true}).click();
  await expect(history).toBeVisible();
  await history.getByText('One rectangle', {exact: true}).click();
  await expect(page.getByText(/You are viewing the version "One rectangle"/)).toBeVisible();
  await page.getByRole('button', {name: 'Restore', exact: true}).click();
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(1);
  await expect(page.getByText(/You are viewing the version/)).toBeHidden();
  await expect.poll(() => pixel(page, centre.x, centre.y)).toBe('D9D9D9');
});
