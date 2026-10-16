import {test, expect, waitEditorReady} from './fixtures';
import type {Locator, Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// Morfa Design: the canvas as a designer coming from Figma uses it (src/design/engine/**, src/design/
// editor/CanvasView.tsx). Drawing, resizing, rotating and undoing; typing Russian on the Russian layout
// and making a word bold; dropping a layer into an auto-layout row with the insertion line; copying
// between two files open in two tabs; drawing with the pen; a boolean union; the frame's title; the
// number keys for opacity. Every check reads the document the server saved (autosave) or the pixels
// of the canvas. Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type Saved = {file: {name: string; version: number}; document: DesignDocument};
type Pt = {x: number; y: number};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}

const ofType = (file: Saved, type: SceneNode['type']) => Object.values(file.document.nodes).filter(node => node.type === type);
const round = (value: number) => Math.round(value * 100) / 100;

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
  /** Page point → screen point (CSS px of the page). */
  const at = (x: number, y: number): Pt => ({x: centre.x + x, y: centre.y + y});
  // Focus on the canvas (keys go to it from now on), on an empty spot.
  await page.mouse.click(box.x + 30, box.y + 30);
  return {id: fileIdFrom(page), canvas, box, at};
}

async function drag(page: Page, from: Pt, to: Pt, options: {hold?: (page: Page) => Promise<void>; steps?: number} = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x * 2 + to.x) / 3, (from.y * 2 + to.y) / 3, {steps: options.steps ?? 5});
  await page.mouse.move(to.x, to.y, {steps: options.steps ?? 5});
  await options.hold?.(page);
  await page.mouse.up();
}

/** Whether the browser reports a Mac: the editor's keys follow it (src/design/engine/keyboard.ts isMacPlatform). */
const onMac = (page: Page) => page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform));

// CDP modifier bits (Input.dispatchKeyEvent): Meta 4, Shift 8.
const CDP_META = 4, CDP_SHIFT = 8;

/** "Paste in place": ⇧⌘V on a Mac, Ctrl+Shift+V elsewhere. The editor leaves paste keys to the browser and acts on its paste
 *  event (src/design/engine/keyboard.ts). Off a Mac the browser's own key binding pastes; on a Mac the key's command comes
 *  from the app menu, which a headless browser has none of, and Playwright supplies it for ⌘V but not ⇧⌘V. So on a Mac the
 *  same key goes in with the command a Mac's Chrome runs for it, "paste". */
async function pasteInPlace(page: Page) {
  if (!(await onMac(page))) {
    await page.keyboard.press('ControlOrMeta+Shift+v');
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const key = {key: 'V', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: CDP_META | CDP_SHIFT};
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', ...key, commands: ['paste']});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', ...key});
  await cdp.detach();
}

/** RGBA of a canvas at a page-space screen point. */
async function pixel(canvas: Locator, which: 'scene' | 'overlay', point: Pt): Promise<[number, number, number, number]> {
  return canvas.page().evaluate(([selector, px, py]) => {
    const element = document.querySelector<HTMLCanvasElement>(selector as string)!;
    const rect = element.getBoundingClientRect();
    const scale = element.width / rect.width;
    const data = element.getContext('2d')!.getImageData(Math.round(((px as number) - rect.left) * scale), Math.round(((py as number) - rect.top) * scale), 1, 1).data;
    return [data[0], data[1], data[2], data[3]] as [number, number, number, number];
  }, [which === 'scene' ? '.dz-canvas__scene' : '.dz-canvas__overlay', point.x, point.y] as const);
}

const isGrey = ([r, g, b]: number[]) => Math.abs(r - 217) < 8 && Math.abs(g - 217) < 8 && Math.abs(b - 217) < 8;
const isAccent = ([r, g, b, a]: number[]) => a > 100 && r < 80 && g > 110 && b > 200;

const JCUKEN: Record<string, string> = {
  'й': 'KeyQ', 'ц': 'KeyW', 'у': 'KeyE', 'к': 'KeyR', 'е': 'KeyT', 'н': 'KeyY', 'г': 'KeyU', 'ш': 'KeyI', 'щ': 'KeyO', 'з': 'KeyP', 'х': 'BracketLeft', 'ъ': 'BracketRight',
  'ф': 'KeyA', 'ы': 'KeyS', 'в': 'KeyD', 'а': 'KeyF', 'п': 'KeyG', 'р': 'KeyH', 'о': 'KeyJ', 'л': 'KeyK', 'д': 'KeyL', 'ж': 'Semicolon', 'э': 'Quote',
  'я': 'KeyZ', 'ч': 'KeyX', 'с': 'KeyC', 'м': 'KeyV', 'и': 'KeyB', 'т': 'KeyN', 'ь': 'KeyM', 'б': 'Comma', 'ю': 'Period', 'ё': 'Backquote', ' ': 'Space', ',': 'Slash',
};

/** Types as the Russian layout does: each key press carries the physical code (к is KeyR) and the Cyrillic character. */
async function typeRussian(page: Page, text: string) {
  const cdp = await page.context().newCDPSession(page);
  for (const char of text) {
    const lower = char.toLowerCase();
    const code = JCUKEN[lower];
    if (!code) throw new Error('no key for ' + char);
    const shift = char !== lower ? 8 : 0;
    const keyCode = code === 'Space' ? 32 : 65;
    if (shift) await cdp.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8});
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: char, code, text: char, unmodifiedText: char, modifiers: shift, windowsVirtualKeyCode: keyCode});
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: char, code, modifiers: shift, windowsVirtualKeyCode: keyCode});
    if (shift) await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16});
  }
  await cdp.detach();
}

test('drawing, resizing by a corner, rotating, Alt-dragging a copy: one undo step each; four corner handles', async ({page, seed: _seed}) => {
  const {id, canvas, at} = await openNewFile(page);
  // R + drag: a 200 × 120 rectangle where it was drawn; the tool hands back to "Move".
  await page.keyboard.press('r');
  await drag(page, at(-100, -60), at(100, 60));
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.x, node.y, node.width, node.height])).toEqual([[-100, -60, 200, 120]]);
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
  // Handles on the corners only, as in Figma (a white square there), nothing in the middle of a side.
  expect(await pixel(canvas, 'overlay', at(-100, -60))).toEqual([255, 255, 255, 255]);
  expect((await pixel(canvas, 'overlay', at(0, -58)))[3]).toBe(0);

  // The bottom-right corner, with Shift: the proportions stay (200 × 120 → 250 × 150).
  await page.keyboard.down('Shift');
  await drag(page, at(100, 60), at(150, 70));
  await page.keyboard.up('Shift');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.x, node.y, node.width, node.height])).toEqual([[-100, -60, 250, 150]]);

  // Past the opposite side: the rectangle flips.
  await drag(page, at(150, 0), at(-150, 0));
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.x, node.width, !!node.flipX])).toEqual([[-150, 50, true]]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.x, node.width, !!node.flipX])).toEqual([[-100, 250, false]]);

  // Rotating by the ring outside a corner, with Shift: 15° steps.
  await page.keyboard.down('Shift');
  await drag(page, at(160, -70), at(200, 40));
  await page.keyboard.up('Shift');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => node.rotation !== 0 && round(Math.abs(node.rotation) % 15) === 0)).toEqual([true]);
  const turned = ofType(await saved(page, id), 'RECTANGLE')[0];
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => node.rotation)).toEqual([0]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => round(node.rotation))).toEqual([round(turned.rotation)]);
  await page.keyboard.press('ControlOrMeta+z');

  // Alt-drag: a copy where the pointer left it, the original in place; ⌘Z takes the copy away.
  await page.keyboard.down('Alt');
  await drag(page, at(25, 15), at(25, 215));
  await page.keyboard.up('Alt');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => node.y).sort((a, b) => a - b)).toEqual([-60, 140]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(1);

  // An ellipse with Shift is a circle.
  await page.keyboard.press('o');
  await page.keyboard.down('Shift');
  await drag(page, at(200, 100), at(260, 130));
  await page.keyboard.up('Shift');
  await expect.poll(async () => ofType(await saved(page, id), 'ELLIPSE').map(node => [node.width, node.height])).toEqual([[60, 60]]);
});

test('Russian typed on the Russian layout goes into the text, ⌘B makes a word bold, Esc leaves; undo walks back', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('t');
  await page.mouse.click(at(-150, -40).x, at(-150, -40).y);
  // Cyrillic test data on purpose: «к» is the R key and «т» the N key of the Russian layout; while typing they are letters, not tools.
  await typeRussian(page, 'Привет, мир');
  // The last word, selected backwards: ⌥⇧← on a Mac (there ⌘⇧← takes the whole line), Ctrl+Shift+← elsewhere.
  await page.keyboard.press(`${(await onMac(page)) ? 'Alt' : 'Control'}+Shift+ArrowLeft`);
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('Escape');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT').map(node => node.text!.characters)).toEqual(['Привет, мир']);
  const node = ofType(await saved(page, id), 'TEXT')[0];
  expect(node.name).toBe('Привет, мир');
  expect(node.text!.runs).toEqual([expect.objectContaining({start: 8, end: 11, style: expect.objectContaining({fontWeight: 700})})]);
  expect(node.width).toBeGreaterThan(40);
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
  // On the canvas the same key is a tool again: «к» (R) picks "Rectangle".
  await typeRussian(page, 'к');
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Rectangle', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  // ⌘Z undoes the bold first, then the typing.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT').map(each => each.text!.runs.length)).toEqual([0]);
  // A double click on the text opens it with everything selected: typing replaces it.
  const box = ofType(await saved(page, id), 'TEXT')[0];
  await page.mouse.dblclick(at(box.x + 10, box.y + box.height / 2).x, at(box.x + 10, box.y + box.height / 2).y);
  await typeRussian(page, 'Ёлка');
  await page.keyboard.press('Escape');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT').map(each => each.text!.characters)).toEqual(['Ёлка']);
});

test('a layer dragged into an auto-layout row follows the pointer, a blue line shows its slot, the drop puts it there', async ({page, seed: _seed}) => {
  const {id, canvas, at} = await openNewFile(page);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('r');
    await drag(page, at(-200 + i * 80, -100), at(-140 + i * 80, -40));
  }
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Shift+a');
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').filter(frame => frame.autoLayout?.layoutMode === 'HORIZONTAL').length).toBe(1);
  const row = ofType(await saved(page, id), 'FRAME')[0];
  const [first, second] = row.children!;
  await page.keyboard.press('r');
  await drag(page, at(0, 100), at(60, 160));
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(4);
  const loose = ofType(await saved(page, id), 'RECTANGLE').find(node => node.parentId !== row.id)!;
  // Between the first and the second (row-local 60…80): the gap's middle is page x = row.x + 70.
  const slot = row.x + 70;
  await page.mouse.move(at(30, 130).x, at(30, 130).y);
  await page.mouse.down();
  await page.mouse.move(at(0, 0).x, at(0, 0).y, {steps: 5});
  await page.mouse.move(at(slot + 5, row.y + 30).x, at(slot + 5, row.y + 30).y, {steps: 5});
  // Mid-drag: the layer is under the pointer (not snapped into a slot) and the line stands in the gap.
  await expect.poll(async () => isGrey(await pixel(canvas, 'scene', at(slot + 30, row.y + 55)))).toBe(true);
  await expect.poll(async () => isAccent(await pixel(canvas, 'overlay', at(slot, row.y + 5)))).toBe(true);
  await page.mouse.up();
  await expect.poll(async () => (await saved(page, id)).document.nodes[row.id].children).toEqual([first, loose.id, second, row.children![2]]);
  const dropped = (await saved(page, id)).document.nodes[loose.id];
  expect(dropped.layoutPositioning).toBe('AUTO');
  expect(dropped.x).toBe(80);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await saved(page, id)).document.nodes[loose.id].parentId).not.toBe(row.id);
});

test('layers copied in one file paste into another open in a second tab, in place with ⇧⌘V', async ({page, context, seed: _seed}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const a = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, a.at(-40, -30), a.at(80, 50));
  await page.keyboard.press('o');
  await drag(page, a.at(100, -30), a.at(160, 30));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');

  const other = await context.newPage();
  const b = await openNewFile(other);
  await pasteInPlace(other);
  await expect.poll(async () => ofType(await saved(other, b.id), 'RECTANGLE').map(node => [node.x, node.y, node.width, node.height])).toEqual([[-40, -30, 120, 80]]);
  await expect.poll(async () => ofType(await saved(other, b.id), 'ELLIPSE').map(node => [node.x, node.y])).toEqual([[100, -30]]);
  // A plain paste lands the copy too (where it fits the view), as a new layer each time.
  await other.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => ofType(await saved(other, b.id), 'RECTANGLE').length).toBe(2);
  await other.close();
});

test('the pen draws a closed curved path; Enter opens it in the vector editor', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('p');
  await page.mouse.click(at(-150, 0).x, at(-150, 0).y);
  await page.mouse.click(at(-50, -80).x, at(-50, -80).y);
  // A press dragged out makes a smooth point.
  await drag(page, at(50, 0), at(90, 60));
  await page.mouse.click(at(-150, 0).x, at(-150, 0).y);
  await page.keyboard.press('Escape');
  await expect.poll(async () => ofType(await saved(page, id), 'VECTOR').length).toBe(1);
  const commands = ofType(await saved(page, id), 'VECTOR')[0].vectorPaths!.flatMap(each => each.commands.map(command => command.type));
  expect(commands).toContain('C');
  expect(commands.at(-1)).toBe('Z');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('toolbar', {name: 'Path editing'})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'VECTOR').length).toBe(1);
});

test('two overlapping shapes make a union (⌥⇧U), flatten (⌘E) and come back with ⌘Z', async ({page, seed: _seed}) => {
  const {id, canvas, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-100, -60), at(20, 60));
  await page.keyboard.press('o');
  await drag(page, at(-20, -60), at(100, 60));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Alt+Shift+u');
  await expect.poll(async () => ofType(await saved(page, id), 'BOOLEAN_OPERATION').map(node => [node.booleanOperation, node.children!.length])).toEqual([['UNION', 2]]);
  await expect.poll(async () => isGrey(await pixel(canvas, 'scene', at(80, 0)))).toBe(true);
  await page.keyboard.press('ControlOrMeta+e');
  await expect.poll(async () => ofType(await saved(page, id), 'VECTOR').length).toBe(1);
  expect(ofType(await saved(page, id), 'BOOLEAN_OPERATION')).toHaveLength(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'BOOLEAN_OPERATION').length).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => [ofType(await saved(page, id), 'RECTANGLE').length, ofType(await saved(page, id), 'ELLIPSE').length]).toEqual([1, 1]);
});

test('a frame’s title selects it, double click renames it in place; number keys set opacity', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-150, -100), at(150, 100));
  await page.keyboard.press('r');
  await drag(page, at(-140, -90), at(140, 90));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // The title sits above the frame's top-left corner; the rectangle covers the frame itself.
  await page.mouse.click(at(-140, -108).x, at(-140, -108).y);
  await page.keyboard.press('5');
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').map(node => node.opacity)).toEqual([0.5]);
  // A save already on its way when «5» was pressed stores it at once: the next digit must come after the pair
  // window (OPACITY_PAIR_MS, 600 ms), or «7» would make «57» with it.
  await page.waitForTimeout(700);
  await page.keyboard.press('7');
  await page.keyboard.press('5');
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').map(node => node.opacity)).toEqual([0.75]);
  await page.keyboard.press('0');
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').map(node => node.opacity)).toEqual([1]);
  await page.mouse.dblclick(at(-140, -108).x, at(-140, -108).y);
  const field = page.getByRole('textbox', {name: 'Layer name'});
  await expect(field).toBeFocused();
  await field.fill('Home screen');
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').map(node => node.name)).toEqual(['Home screen']);
  // Keys reach the canvas again.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').map(node => node.name)).not.toEqual(['Home screen']);
});

/** Pixels of the scene canvas in a screen rect (CSS px) that differ from `ground`: the ink drawn there. */
async function inkIn(page: Page, rect: {x: number; y: number; width: number; height: number}, ground: [number, number, number]): Promise<number> {
  return page.evaluate(([x, y, width, height, r, g, b]) => {
    const element = document.querySelector<HTMLCanvasElement>('.dz-canvas__scene')!;
    const box = element.getBoundingClientRect();
    const scale = element.width / box.width;
    const data = element.getContext('2d')!.getImageData(Math.round((x - box.left) * scale), Math.round((y - box.top) * scale), Math.round(width * scale), Math.round(height * scale)).data;
    let ink = 0;
    for (let k = 0; k < data.length; k += 4) if (Math.abs(data[k] - r) + Math.abs(data[k + 1] - g) + Math.abs(data[k + 2] - b) > 24) ink++;
    return ink;
  }, [rect.x, rect.y, rect.width, rect.height, ...ground] as const);
}

type PageStore = {getState(): {pageId: string}; transact(label: string, recipe: (tx: {update(id: string, partial: object): void}) => void): void};
/** The page's own canvas colour (grey level 0–1), as a file made in the other theme keeps it. */
const setPageGrey = (page: Page, grey: number) => page.evaluate(level => {
  const store = (window as unknown as {__morfaDesignTest: {store: PageStore}}).__morfaDesignTest.store;
  store.transact('Background', tx => tx.update(store.getState().pageId, {backgroundColor: {r: level, g: level, b: level}}));
}, grey);

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`at ${deviceScaleFactor}×`, () => {
    test.use({deviceScaleFactor});
    // The owner's report (2026-10-07): renaming a component on its title showed a dark pill with the old name still
    // drawn beside it. The app's `input:focus-visible` pill rule outweighed the field's own, the field took the dark
    // theme's panel colour on a light page, and the scene kept drawing the name the field replaced.
    test('the rename field of a title stands on its name, which the canvas stops drawing; its look follows the page, not the theme', async ({page, seed: _seed}) => {
      await page.emulateMedia({colorScheme: 'dark'});
      const {at} = await openNewFile(page);
      await page.keyboard.press('f');
      await drag(page, at(-150, -100), at(150, 100));
      await page.keyboard.press('Alt+ControlOrMeta+k');
      await page.keyboard.press('Escape');
      await setPageGrey(page, 0.9);
      const ground: [number, number, number] = [230, 230, 230];
      // The component's name "Frame 1" starts 11 px in, after its icon; its baseline is 6 px above the edge.
      const strip = {x: at(-150 + 20, 0).x, y: at(0, -100 - 15).y, width: 30, height: 12};
      await expect.poll(() => inkIn(page, strip, ground)).toBeGreaterThan(10);
      await page.mouse.dblclick(at(-120, -108).x, at(-120, -108).y);
      const input = page.getByRole('textbox', {name: 'Layer name'});
      await expect(input).toBeFocused();
      await input.fill('ab');
      // The old name is gone from the canvas while the field is open, also past the shorter new one.
      await expect.poll(() => inkIn(page, strip, ground)).toBe(0);
      const field = page.locator('.dz-canvas-title');
      const look = await field.evaluate(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {radius: style.borderRadius, background: style.backgroundColor, color: style.color, shadow: style.boxShadow, inputBackground: getComputedStyle(element.querySelector('input')!).backgroundColor, x: rect.x, bottom: rect.bottom, height: rect.height, font: style.fontSize};
      });
      expect(look).toMatchObject({radius: '2px', background: 'rgb(255, 255, 255)', color: 'rgb(151, 71, 255)', inputBackground: 'rgba(0, 0, 0, 0)', height: 18, font: '11px'});
      expect(look.shadow).toContain('rgb(13, 153, 255) 0px 0px 0px 1px');
      // On the name: its text starts where the label's did (past the icon, inside 4 px of padding) and the field ends
      // a pixel above the frame's edge.
      expect(Math.abs(look.x - (at(-150, 0).x + 11 - 4))).toBeLessThan(1);
      expect(Math.abs(look.bottom - (at(0, -100).y - 1))).toBeLessThan(1);
      await page.keyboard.press('Escape');
      await expect(field).toHaveCount(0);
      await expect.poll(() => inkIn(page, strip, ground)).toBeGreaterThan(10);
      // A dark page: a dark field, in the light theme too.
      await page.emulateMedia({colorScheme: 'light'});
      await setPageGrey(page, 0.1);
      await page.mouse.dblclick(at(-120, -108).x, at(-120, -108).y);
      await expect(input).toBeFocused();
      await expect(field).toHaveCSS('background-color', 'rgb(44, 44, 44)');
      await page.keyboard.press('Enter');
      await expect(field).toHaveCount(0);
    });
  });
}
