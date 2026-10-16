import {test, expect, waitEditorReady} from './fixtures';
import type {Locator, Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// Morfa Design: the tools added for Figma parity, each one's main flow in the real editor, read back from the document
// the server saved: "Text on path" (the Text group's second tool, its start handle and panel section), "Annotation"
// (Y: a note with live properties, on the canvas and in "Code", ⇧Y hides it), "Measure" (⇧M: a pinned distance that
// follows the layers), "Brush" (B) with "Width profile", and "Lasso" (Q). docs/design-tool.md §Text on a path,
// annotations, measurements and drawing tools.

type Saved = {file: {name: string; version: number}; document: DesignDocument};
type Pt = {x: number; y: number};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const nodes = async (page: Page, id: string) => Object.values((await saved(page, id)).document.nodes);
const ofType = async (page: Page, id: string, type: SceneNode['type']) => (await nodes(page, id)).filter(node => node.type === type);
const pageNode = async (page: Page, id: string) => (await nodes(page, id)).find(node => node.type === 'PAGE')!;

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
  return {id: fileIdFrom(page), canvas, box, at, toolbar: page.getByRole('toolbar', {name: 'Tools'}), design: page.getByRole('tabpanel', {name: 'Design'})};
}

async function drag(page: Page, from: Pt, to: Pt, steps = 8) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {steps});
  await page.mouse.move(to.x, to.y, {steps});
  await page.mouse.up();
}

async function stroke(page: Page, points: Pt[]) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y);
  await page.mouse.up();
}

/** The annotations canvas's colour at a screen point, as [r, g, b, a]. */
async function annotationPixel(canvas: Locator, point: Pt): Promise<number[]> {
  return canvas.page().evaluate(([px, py]) => {
    const element = document.querySelector<HTMLCanvasElement>('.dz-annotations-canvas')!;
    const rect = element.getBoundingClientRect();
    const scale = element.width / rect.width;
    const data = element.getContext('2d')!.getImageData(Math.round((px - rect.left) * scale), Math.round((py - rect.top) * scale), 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  }, [point.x, point.y] as const);
}
const isPink = ([r, g, b, a]: number[]) => a > 150 && r > 200 && g < 110 && b > 110;

/** A tool from its group's flyout in the bottom toolbar. */
async function pickFromFlyout(page: Page, toolbar: Locator, group: string, tool: string) {
  await toolbar.locator(`.dz-tool-flyout[aria-label="${group}"]`).click();
  await page.getByRole('menuitemradio', {name: new RegExp(tool)}).click();
}

/** A key as the Russian layout sends it: the physical code with the Cyrillic character (deliberate Cyrillic test data). */
async function russianKey(page: Page, char: string, code: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: char, code, text: char, unmodifiedText: char, windowsVirtualKeyCode: 65});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: char, code, windowsVirtualKeyCode: 65});
  await cdp.detach();
}

test('text on a path: the Text group\'s second tool puts a text on an ellipse; its handle and "Start" move where it starts', async ({page, seed: _seed}) => {
  const {id, at, toolbar, design} = await openNewFile(page);
  await page.keyboard.press('o');
  await drag(page, at(-100, -60), at(100, 60));
  await expect.poll(async () => (await ofType(page, id, 'ELLIPSE')).length).toBe(1);

  // A click and Escape without typing leaves nothing behind.
  await pickFromFlyout(page, toolbar, 'Text', 'Text on path');
  await page.mouse.click(at(0, 60).x, at(0, 60).y);
  await page.keyboard.press('Escape');
  await pickFromFlyout(page, toolbar, 'Text', 'Text on path');
  await expect(toolbar.getByRole('button', {name: 'Text on path', exact: true})).toHaveAttribute('aria-pressed', 'true');
  // The top of the ellipse: three quarters round from its start at 3 o'clock.
  await page.mouse.click(at(0, -60).x, at(0, -60).y);
  await page.keyboard.type('Hello around the circle');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await ofType(page, id, 'TEXT')).map(node => [node.text!.characters, node.textPath?.side, node.textPath?.startOffset]))
    .toEqual([['Hello around the circle', 'LEFT', 0.75]]);
  const text = (await ofType(page, id, 'TEXT'))[0];
  expect([text.x, text.y, text.width, text.height]).toEqual([-100, -60, 200, 120]);
  expect((await ofType(page, id, 'ELLIPSE')).length, 'the shape stays').toBe(1);

  // The panel section: "Start" in percent, the side, and no block size for a text on a path.
  const start = design.getByRole('spinbutton', {name: 'Text start on the path'});
  await expect(start).toHaveValue(/^75\s?%$/);
  await expect(design.getByRole('radiogroup', {name: 'Box size'}).or(design.getByRole('group', {name: 'Box size'}))).toHaveCount(0);

  // The start handle sits at the top of the ellipse; dragged to its right end, the text starts there. One undo step.
  await drag(page, at(0, -60), at(102, 0), 10);
  // The right end is where the ellipse's outline starts (0 % or, the other way round, 100 %).
  await expect.poll(async () => {
    const offset = (await ofType(page, id, 'TEXT'))[0].textPath!.startOffset;
    return Math.min(offset, 1 - offset);
  }).toBeLessThan(0.02);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await ofType(page, id, 'TEXT'))[0].textPath!.startOffset).toBe(0.75);

  await start.fill('25');
  await start.press('Enter');
  await expect.poll(async () => (await ofType(page, id, 'TEXT'))[0].textPath!.startOffset).toBe(0.25);
  await design.getByRole('button', {name: 'Other side of the path'}).click();
  await expect.poll(async () => (await ofType(page, id, 'TEXT'))[0].textPath!.side).toBe('RIGHT');
  await design.getByRole('button', {name: 'Detach from path'}).click();
  await expect.poll(async () => {
    const node = (await ofType(page, id, 'TEXT'))[0];
    return [node.textPath ?? null, node.text!.textAutoResize];
  }).toEqual([null, 'WIDTH_AND_HEIGHT']);
});

test('an annotation (Y) shows a layer\'s width live, on the canvas and in "Code"; ⇧Y hides notes and measurements', async ({page, seed: _seed}) => {
  const {id, at, toolbar, design} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-200, -100), at(-80, -10));
  await page.keyboard.press('y');
  await expect(toolbar.getByRole('button', {name: 'Annotation', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(at(-140, -55).x, at(-140, -55).y);
  const editor = page.getByRole('dialog', {name: 'New annotation'});
  await expect(editor).toBeVisible();
  // The card opens beside the layer's top-right corner (24 px off), not somewhere else on the canvas.
  const card = (await editor.boundingBox())!;
  expect(Math.abs(card.x - (at(-80, 0).x + 24))).toBeLessThanOrEqual(2);
  expect(Math.abs(card.y - at(0, -100).y)).toBeLessThanOrEqual(2);
  // The card focuses its field on the next frame: type only once it has the focus.
  await expect(editor.getByRole('textbox', {name: 'Annotation text'})).toBeFocused();
  // On the Russian layout "н" (deliberate Cyrillic test data) is KeyY, the tool's key: in the note it is a letter.
  await page.keyboard.type('Button "Buy", padding 16');
  await russianKey(page, 'н', 'KeyY');
  await expect(editor.getByRole('textbox', {name: 'Annotation text'})).toHaveValue('Button "Buy", padding 16н');
  await page.keyboard.press('Backspace');
  await editor.getByRole('radio', {name: 'Development'}).click();
  await editor.getByRole('button', {name: 'Property'}).click();
  await page.getByRole('menuitem', {name: /Width/}).click();
  await editor.getByRole('button', {name: 'Done'}).click();
  await expect(editor).toBeHidden();
  // Until the first save lands the file has no rectangle yet: poll the saved state, never read a layer that is not there.
  await expect.poll(async () => (await ofType(page, id, 'RECTANGLE'))[0]?.annotations?.map(note => [note.label, note.categoryId, note.properties?.map(p => p.type)]))
    .toEqual([['Button "Buy", padding 16', 'development', ['width']]]);
  const note = page.locator('.dz-annotation').filter({hasText: 'Button "Buy", padding 16'});
  await expect(note).toContainText('120px');

  // The width changes: the note says so at once.
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await page.mouse.click(at(-140, -55).x, at(-140, -55).y);
  const width = design.getByRole('spinbutton', {name: 'Width', exact: true});
  await width.fill('150');
  await width.press('Enter');
  await expect(note).toContainText('150px');

  // "Code": the selection's notes, a click away from the layer.
  await page.getByRole('tab', {name: 'Code'}).click();
  const code = page.getByRole('tabpanel', {name: 'Code'});
  await expect(code.getByRole('button', {name: /annotation of layer "Rectangle 1"/})).toContainText('150px');

  // ⇧Y hides the notes on the canvas ("View → Annotations"), ⇧Y again shows them.
  await page.mouse.click(at(300, 200).x, at(300, 200).y);
  await page.keyboard.press('Shift+Y');
  await expect(note).toBeHidden();
  await page.keyboard.press('Shift+Y');
  await expect(note).toBeVisible();
});

test('a measurement (⇧M) between two layers stays live as one moves, is listed in "Code", and Delete removes it', async ({page, seed: _seed}) => {
  const {id, at, canvas, toolbar, design} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-200, -50), at(-100, 50));
  await page.keyboard.press('r');
  await drag(page, at(60, -50), at(160, 50));
  await page.keyboard.press('Shift+M');
  await expect(toolbar.getByRole('button', {name: 'Measure', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await drag(page, at(-101, 0), at(62, 0), 12);
  await expect.poll(async () => (await pageNode(page, id)).measurements?.map(m => [m.start.side, m.end.side])).toEqual([['RIGHT', 'LEFT']]);
  // The pink line between the two edges.
  await expect.poll(async () => isPink(await annotationPixel(canvas, at(-40, 0)))).toBe(true);

  // "b" moves: the measurement follows (the "Code" list shows the new distance).
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await page.mouse.click(at(110, 0).x, at(110, 0).y);
  const x = design.getByRole('spinbutton', {name: 'Position X', exact: true});
  await x.fill('100');
  await x.press('Enter');
  await page.getByRole('tab', {name: 'Code'}).click();
  const code = page.getByRole('tabpanel', {name: 'Code'});
  await expect(code.locator('.dz-devnote.is-measure')).toContainText('200');
  await page.mouse.click(at(300, 250).x, at(300, 250).y);

  // Picked with the tool, Delete removes it; ⌘Z brings it back.
  await page.keyboard.press('Shift+M');
  await page.mouse.click(at(0, 0).x, at(0, 0).y);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await pageNode(page, id)).measurements ?? []).toEqual([]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await pageNode(page, id)).measurements?.length).toBe(1);
});

test('the brush (B) draws a smoothed vector with a width profile; "Width profile" changes it and the next stroke', async ({page, seed: _seed}) => {
  const {id, at, toolbar, design} = await openNewFile(page);
  await page.keyboard.press('b');
  await expect(toolbar.getByRole('button', {name: 'Brush', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await stroke(page, Array.from({length: 30}, (_, i) => at(-150 + i * 10, Math.sin(i / 4) * 40 + (i % 2 ? 3 : -3))));
  await expect.poll(async () => (await ofType(page, id, 'VECTOR')).map(node => [node.name, node.strokeWeight, node.variableWidthStrokeProperties?.widthProfile]))
    .toEqual([['Brush', 6, 'MIRRORED_TAPER']]);
  const profile = design.getByRole('button', {name: 'Width profile'});
  await expect(profile).toContainText('Taper both ends');
  await profile.click();
  await page.getByRole('menuitemradio', {name: /^Wedge/}).click();
  await expect.poll(async () => (await ofType(page, id, 'VECTOR'))[0].variableWidthStrokeProperties?.widthProfile).toBe('WEDGE');
  // The brush draws with the preset chosen last.
  await stroke(page, Array.from({length: 20}, (_, i) => at(-150 + i * 10, 150 + (i % 2 ? 2 : -2))));
  await expect.poll(async () => (await ofType(page, id, 'VECTOR')).map(node => node.variableWidthStrokeProperties?.widthProfile).sort()).toEqual(['WEDGE', 'WEDGE']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await ofType(page, id, 'VECTOR')).length).toBe(1);
});

test('the lasso (Q) selects the layers its loop touches; Shift adds', async ({page, seed: _seed}) => {
  const {at, toolbar, design} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-200, -50), at(-120, 30));
  await page.keyboard.press('o');
  await drag(page, at(60, -50), at(140, 30));
  await page.keyboard.press('Escape');
  await page.mouse.click(at(300, 250).x, at(300, 250).y);
  await page.keyboard.press('q');
  await expect(toolbar.getByRole('button', {name: 'Lasso', exact: true})).toHaveAttribute('aria-pressed', 'true');
  const loop = (cx: number, cy: number) => Array.from({length: 33}, (_, i) => at(cx + Math.cos((i / 32) * Math.PI * 2) * 70, cy + Math.sin((i / 32) * Math.PI * 2) * 60));
  await stroke(page, loop(-160, -10));
  // The panel's header names the kind (UI3); the layers name what the loop picked.
  await expect(design.locator('.dz-pl-header-title')).toHaveText('Rectangle');
  await expect(page.getByRole('treeitem', {selected: true})).toHaveText(/Rectangle 1/);
  await page.keyboard.down('Shift');
  await stroke(page, loop(100, -10));
  await page.keyboard.up('Shift');
  await expect(page.getByRole('treeitem', {selected: true})).toHaveCount(2);
});

test('the new tools\' keys are in "Keyboard shortcuts"', async ({page, seed: _seed}) => {
  await openNewFile(page);
  await page.keyboard.press('Control+Shift+Slash');
  const dialog = page.getByRole('dialog', {name: 'Keyboard shortcuts'});
  await expect(dialog).toBeVisible();
  for (const [label, key] of [['Annotation', /^Y$/], ['Measure', /^(Shift\+|⇧)M$/], ['Lasso', /^Q$/], ['Brush', /^B$/], ['Annotations', /^(Shift\+|⇧)Y$/]] as const) {
    const row = dialog.locator('.dz-shortcuts-row').filter({has: page.locator('dt', {hasText: new RegExp(`^${label}$`)})});
    await expect(row).toHaveCount(1);
    await expect(row.locator('dd')).toHaveText(key);
  }
});
