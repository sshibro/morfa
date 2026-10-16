import {test, expect, waitEditorReady} from './fixtures';
import type {Locator, Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// The "Design" panel as a designer coming from Figma uses it (the acceptance sweep of 2026-10-07): a page that never
// had its own colour follows the editor's theme and says "Default", a colour picked stays in both themes and
// "Default color" gives the page back to the theme. Every check reads the canvas's pixels, the panel's fields or the
// saved document. Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type Saved = {file: {name: string; version: number}; document: DesignDocument};
type Pt = {x: number; y: number};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const firstPage = (file: Saved): SceneNode => file.document.nodes[file.document.pages[0]];
const waitSaved = (page: Page) => expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();

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
  return {id: fileIdFrom(page), canvas, box, at, design: page.getByRole('tabpanel', {name: 'Design'})};
}

/** The scene canvas's colour at a page point, as hex. */
async function pixel(canvas: Locator, point: Pt): Promise<string> {
  return canvas.page().evaluate(([px, py]) => {
    const element = document.querySelector<HTMLCanvasElement>('.dz-canvas__scene')!;
    const rect = element.getBoundingClientRect();
    const scale = element.width / rect.width;
    const data = element.getContext('2d')!.getImageData(Math.round((px - rect.left) * scale), Math.round((py - rect.top) * scale), 1, 1).data;
    return [data[0], data[1], data[2]].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  }, [point.x, point.y] as const);
}

test('a new page follows the theme until it has a colour of its own; "Default color" gives it back', async ({page, seed: _seed}) => {
  await page.emulateMedia({colorScheme: 'light'});
  const {id, canvas, at, design} = await openNewFile(page);
  const hex = design.getByRole('textbox', {name: 'Page background'});
  await expect.poll(() => pixel(canvas, at(0, 0))).toBe('F5F5F5');
  await expect(hex).toHaveValue('F5F5F5');
  await expect(design.getByText('Default', {exact: true})).toBeVisible();
  await waitSaved(page);
  expect(firstPage(await saved(page, id)).backgroundColor).toBeUndefined();

  // The system turns dark while the file is open: the default canvas turns with it, as in Figma.
  await page.emulateMedia({colorScheme: 'dark'});
  await expect.poll(() => pixel(canvas, at(0, 0))).toBe('1E1E1E');
  await expect(hex).toHaveValue('1E1E1E');

  // A colour typed in is the page's own: it repaints the canvas at once and stays in the light theme too.
  await hex.fill('FFE0E0');
  await hex.press('Enter');
  await expect.poll(() => pixel(canvas, at(0, 0))).toBe('FFE0E0');
  await expect(design.getByText('Default', {exact: true})).toBeHidden();
  await page.emulateMedia({colorScheme: 'light'});
  await expect.poll(() => pixel(canvas, at(0, 0))).toBe('FFE0E0');
  await expect.poll(async () => firstPage(await saved(page, id)).backgroundColor).toBeTruthy();

  await design.getByRole('button', {name: 'Default color'}).click();
  await expect.poll(() => pixel(canvas, at(0, 0))).toBe('F5F5F5');
  await expect(design.getByText('Default', {exact: true})).toBeVisible();
  await expect.poll(async () => firstPage(await saved(page, id)).backgroundColor).toBeUndefined();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pixel(canvas, at(0, 0))).toBe('FFE0E0');
  await waitSaved(page);
});

/** A tool key, then a drag from `from` by `size` (page px at 100 %); the new layer stays selected. */
async function drawWith(page: Page, key: string, from: Pt, size: {width: number; height: number}) {
  await page.keyboard.press(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + size.width / 2, from.y + size.height / 2, {steps: 4});
  await page.mouse.move(from.x + size.width, from.y + size.height, {steps: 4});
  await page.mouse.up();
}
const nodeOf = async (page: Page, id: string, type: SceneNode['type']) => Object.values((await saved(page, id)).document.nodes).find(node => node.type === type)!;
/** The same, undefined until a save has the node: polls retry a value, not a thrown error. */
const maybeNode = async (page: Page, id: string, type: SceneNode['type']): Promise<SceneNode | undefined> => Object.values((await saved(page, id)).document.nodes).find(node => node.type === type);

test('a scrub lands on whole pixels, and ⌘Z in a committed field undoes the document', async ({page, seed: _seed}) => {
  const {id, at, design} = await openNewFile(page);
  await drawWith(page, 'r', at(-100, -60), {width: 200, height: 120});
  const width = design.getByRole('spinbutton', {name: 'Width'});
  await expect(width).toHaveValue('200');

  // Pointer events report fractions of a pixel on high-density screens: the width still moves in whole pixels.
  const label = (await design.locator('.dz-number-prefix', {hasText: /^W$/}).first().boundingBox())!;
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
  await page.mouse.down();
  await page.mouse.move(label.x + label.width / 2 + 23.3, label.y + label.height / 2 + 0.4, {steps: 9});
  await page.mouse.up();
  await expect(width).toHaveValue(/^\d+$/);
  const scrubbed = Number(await width.inputValue());
  expect(scrubbed).toBeGreaterThan(200);
  await expect.poll(async () => (await maybeNode(page, id, 'RECTANGLE'))?.width).toBe(scrubbed);

  // A value typed and committed: the field keeps focus and ⌘Z undoes the change itself, ⇧⌘Z brings it back.
  await width.fill('300');
  await width.press('Enter');
  await expect(width).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(width).toHaveValue(String(scrubbed));
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(width).toHaveValue('300');
  // Something typed and not committed: ⌘Z is the field's own text undo, the document keeps 300.
  await width.fill('444');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(width).toHaveValue('300');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await maybeNode(page, id, 'RECTANGLE'))?.width).toBe(300);
});

test('auto layout: four padding fields stay open once typed equal; "Auto" gap and wrapping turn a hugging side fixed', async ({page, seed: _seed}) => {
  const {id, at, design} = await openNewFile(page);
  await drawWith(page, 'f', at(-150, -75), {width: 300, height: 150});
  await drawWith(page, 'r', at(-130, -55), {width: 40, height: 40});
  await page.getByRole('treeitem', {name: /Frame 1/}).first().click();
  await design.getByRole('button', {name: 'Add auto layout'}).click();
  // The sides differ (the layer sits off-centre): the four fields open by themselves …
  await expect(design.getByRole('button', {name: 'Horizontal and vertical padding'})).toBeVisible();
  // Each side is committed (the field shows it and the document holds it) before the next is typed: the panel
  // re-renders on every commit, and a key sent into a field mid re-render can be lost.
  const sides = [['Padding left', 'paddingLeft'], ['Padding top', 'paddingTop'], ['Padding right', 'paddingRight'], ['Padding bottom', 'paddingBottom']] as const;
  for (const [name, key] of sides) {
    const field = design.getByRole('spinbutton', {name});
    await field.fill('16');
    await field.press('Enter');
    await expect(field).toHaveValue('16');
    await expect.poll(async () => (await maybeNode(page, id, 'FRAME'))?.autoLayout?.[key]).toBe(16);
  }
  // … and stay open when they become equal, until the designer folds them.
  await expect(design.getByRole('spinbutton', {name: 'Padding bottom'})).toHaveValue('16');
  await design.getByRole('button', {name: 'Horizontal and vertical padding'}).click();
  await expect(design.getByRole('spinbutton', {name: 'Horizontal padding'})).toHaveValue('16');

  const frame = () => maybeNode(page, id, 'FRAME');
  await expect.poll(async () => (await frame())?.layoutSizingHorizontal).toBe('HUG');
  // "Auto" spreads the layers along the row: a hugging width becomes a fixed one, in the same undo step.
  await design.getByRole('button', {name: 'Gap', exact: true}).click();
  await page.getByRole('menuitemradio', {name: /Auto/}).click();
  await expect.poll(async () => [(await frame())?.layoutSizingHorizontal, (await frame())?.autoLayout?.primaryAxisAlignItems]).toEqual(['FIXED', 'SPACE_BETWEEN']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => [(await frame())?.layoutSizingHorizontal, (await frame())?.autoLayout?.primaryAxisAlignItems]).toEqual(['HUG', 'MIN']);
  // Wrapping breaks rows at a width: the same.
  await design.getByRole('button', {name: 'Wrap'}).click();
  await expect.poll(async () => [(await frame())?.layoutSizingHorizontal, (await frame())?.autoLayout?.layoutWrap]).toEqual(['FIXED', 'WRAP']);
  await waitSaved(page);
});

test('a selection colour stepped with the arrows keeps its row; grid styles are listed with nothing selected', async ({page, seed: _seed}) => {
  const {id, box, at, design} = await openNewFile(page);
  await drawWith(page, 'r', at(-200, -60), {width: 100, height: 100});
  await drawWith(page, 'r', at(50, -60), {width: 100, height: 100});
  await page.keyboard.press('ControlOrMeta+a');
  const colours = design.getByRole('list', {name: 'Selection colors'});
  const opacity = colours.getByRole('spinbutton', {name: 'Opacity'}).first();
  await expect(opacity).toHaveValue('100%');
  // Each step changes the colour's key; the row (and the focus in it) stays for the next one.
  await opacity.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect(opacity).toBeFocused();
  await expect(opacity).toHaveValue('97%');
  await expect.poll(async () => Object.values((await saved(page, id)).document.nodes).filter(node => node.type === 'RECTANGLE').map(node => node.fills[0]?.opacity)).toEqual([0.97, 0.97]);

  // A grid style made from a frame's grid shows under "Grid styles" when nothing is selected, as Figma lists local styles.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await drawWith(page, 'f', at(-200, 100), {width: 200, height: 150});
  await design.getByRole('button', {name: 'Add grid'}).click();
  await design.getByRole('button', {name: 'Grid styles'}).click();
  await page.getByRole('menuitem', {name: 'Create style from grid'}).click();
  await expect(design.getByRole('button', {name: 'Detach style'})).toBeVisible();
  await page.mouse.click(box.x + 30, box.y + 30);
  const listed = page.getByRole('tabpanel', {name: 'Design'}).locator('.dz-section', {hasText: 'Grid styles'});
  await expect(listed).toBeVisible();
  await expect(listed.getByRole('button', {name: /Grid 1/})).toBeVisible();
  await listed.getByRole('button', {name: /Grid 1/}).click();
  await expect(page.getByRole('dialog').filter({hasText: 'Grid style'})).toBeVisible();
  await waitSaved(page);
});

test('the font and variable pickers open beside the panel, not over its fields', async ({page, seed: _seed}) => {
  const {at, design} = await openNewFile(page);
  const panelLeft = async () => (await page.locator('.dz-side-panel').last().boundingBox())!.x;
  // A number variable to bind (the picker lists the variables of the field's type).
  await design.getByRole('button', {name: 'Open variables'}).click();
  const variables = page.getByRole('dialog').filter({hasText: 'Collections'}).first();
  await variables.getByRole('button', {name: 'Create collection'}).first().click();
  await page.keyboard.press('Enter');
  await variables.getByRole('button', {name: 'Create variable'}).click();
  await page.getByRole('menuitem', {name: /Number/}).click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(variables).toBeHidden();

  await drawWith(page, 'r', at(-100, -60), {width: 200, height: 120});
  const widthField = design.locator('.dz-pl-number', {has: page.getByRole('spinbutton', {name: 'Width'})});
  await widthField.hover();
  await widthField.getByRole('button', {name: 'Apply variable'}).click();
  const picker = page.getByRole('dialog', {name: 'Variables'});
  await expect(picker).toBeVisible();
  const placed = (await picker.boundingBox())!;
  expect(placed.x + placed.width).toBeLessThanOrEqual(await panelLeft());
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await page.mouse.click(at(-100, 100).x, at(-100, 100).y);
  await page.keyboard.type('Font');
  await page.keyboard.press('Escape');
  await design.getByRole('button', {name: 'Font', exact: true}).click();
  const fonts = page.getByRole('dialog', {name: 'Fonts'});
  await expect(fonts).toBeVisible();
  const fontBox = (await fonts.boundingBox())!;
  expect(fontBox.x + fontBox.width).toBeLessThanOrEqual(await panelLeft());
  await page.keyboard.press('Escape');
});

test('"Text settings" set the paragraph indent and small capitals; a truncated text takes a line limit back', async ({page, seed: _seed}) => {
  const {id, at, design} = await openNewFile(page);
  await page.keyboard.press('t');
  await page.mouse.click(at(-150, -40).x, at(-150, -40).y);
  await page.keyboard.type('First paragraph');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second paragraph');
  await page.keyboard.press('Escape');
  const text = () => maybeNode(page, id, 'TEXT');
  await expect.poll(async () => (await text())?.text?.characters).toBe('First paragraph\nSecond paragraph');
  const width = (await text())!.width;

  await design.getByRole('button', {name: 'Text settings'}).click();
  const settings = page.getByRole('dialog', {name: 'Text settings'});
  const indent = settings.getByRole('spinbutton', {name: 'Paragraph indent'});
  await indent.fill('24');
  await indent.press('Enter');
  // The first line of each paragraph is set in: an auto-width text grows by the indent.
  await expect.poll(async () => (await text())?.text?.paragraphIndent).toBe(24);
  await expect.poll(async () => (await text())?.width).toBeGreaterThan(width + 20);
  await settings.getByRole('radio', {name: 'Small caps'}).click();
  await expect.poll(async () => (await text())?.text?.style.textCase).toBe('SMALL_CAPS');
  await expect(settings.getByRole('radio', {name: 'Small caps'})).toBeChecked();
  await page.keyboard.press('Escape');

  await design.getByRole('radio', {name: 'Truncate text'}).click();
  const lines = design.getByRole('spinbutton', {name: 'Max lines'});
  await expect(lines).toHaveAttribute('placeholder', 'All');
  await lines.fill('1');
  await lines.press('Enter');
  await expect.poll(async () => (await text())?.text?.maxLines).toBe(1);
  await design.getByRole('button', {name: 'All lines'}).click();
  await expect.poll(async () => (await text())?.text?.maxLines ?? null).toBeNull();
  await expect(design.getByRole('button', {name: 'All lines'})).toBeHidden();
  await waitSaved(page);
});

test('"Lock proportions" is stored on the layer: it survives a reload and the canvas handles keep the ratio', async ({page, seed: _seed}) => {
  const {id, at, design} = await openNewFile(page);
  await drawWith(page, 'r', at(-100, -50), {width: 200, height: 100});
  await design.getByRole('button', {name: 'Lock proportions'}).click();
  await expect(design.getByRole('button', {name: 'Unlock proportions'})).toHaveAttribute('aria-pressed', 'true');
  const width = design.getByRole('spinbutton', {name: 'Width'});
  await width.fill('300');
  await width.press('Enter');
  await expect(design.getByRole('spinbutton', {name: 'Height'})).toHaveValue('150');
  await expect.poll(async () => (await maybeNode(page, id, 'RECTANGLE'))?.constrainProportions).toBe(true);
  await waitSaved(page);

  // Another visit (or a teammate) finds the lock where it was left.
  await page.reload();
  // The first visit after a reload loads the editor's modules again (as the export spec waits for them).
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible({timeout: 30_000});
  await page.getByRole('treeitem', {name: /Rectangle 1/}).first().click();
  await expect(design.getByRole('button', {name: 'Unlock proportions'})).toHaveAttribute('aria-pressed', 'true');

  // The right edge handle, dragged 60 px without Shift: the height follows. A reopened file shows its content
  // centred at 100 %, so the layer's right edge is half its width right of the canvas's centre.
  const box = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const rect = await nodeOf(page, id, 'RECTANGLE');
  await expect(page.getByRole('button', {name: /100\s?%/}).first()).toBeVisible();
  const edge = {x: box.x + box.width / 2 + rect.width / 2, y: box.y + box.height / 2};
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 30, edge.y, {steps: 4});
  await page.mouse.move(edge.x + 60, edge.y, {steps: 4});
  await page.mouse.up();
  await expect.poll(async () => {
    const node = await maybeNode(page, id, 'RECTANGLE');
    return node ? Math.round((node.width / node.height) * 100) / 100 : null;
  }).toBe(2);
  await expect.poll(async () => (await maybeNode(page, id, 'RECTANGLE'))?.width).toBeGreaterThan(330);

  await design.getByRole('button', {name: 'Unlock proportions'}).click();
  await expect.poll(async () => (await maybeNode(page, id, 'RECTANGLE'))?.constrainProportions).toBeUndefined();
  await waitSaved(page);
});

test('a text with a coloured word reads "Mixed"; "+" gives it and a rectangle one fill', async ({page, seed: _seed}) => {
  const {id, at, design} = await openNewFile(page);
  await page.keyboard.press('t');
  await page.mouse.click(at(-100, -100).x, at(-100, -100).y);
  await page.keyboard.type('Hello world');
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  await design.getByRole('textbox', {name: 'Color'}).first().fill('0000FF');
  await design.getByRole('textbox', {name: 'Color'}).first().press('Enter');
  await page.keyboard.press('Escape');
  // The text as a whole: one word blue, the rest black — "Mixed", as Figma shows it.
  const fill = page.getByRole('tabpanel', {name: 'Design'}).locator('.dz-section', {hasText: 'Fill'}).first();
  await expect(fill.getByText('Click "+" to replace mixed fills')).toBeVisible();
  await page.keyboard.press('Escape');
  await drawWith(page, 'r', at(-100, 0), {width: 100, height: 60});
  await page.keyboard.press('ControlOrMeta+a');
  await expect(fill.getByText('Click "+" to replace mixed fills')).toBeVisible();
  await design.getByRole('button', {name: 'Add fill'}).click();
  await expect(fill.getByRole('textbox', {name: 'Color'})).toHaveValue('D9D9D9');
  await expect.poll(async () => {
    const file = await saved(page, id);
    const nodes = Object.values(file.document.nodes);
    const text = nodes.find(node => node.type === 'TEXT'), rect = nodes.find(node => node.type === 'RECTANGLE');
    return [JSON.stringify(text?.fills), text?.text?.runs.some(run => run.fills) ?? null, JSON.stringify(rect?.fills) === JSON.stringify(text?.fills)];
  }).toEqual([JSON.stringify([{type: 'SOLID', color: {r: 217 / 255, g: 217 / 255, b: 217 / 255}, opacity: 1, visible: true, blendMode: 'NORMAL'}]), false, true]);
  await waitSaved(page);
});
