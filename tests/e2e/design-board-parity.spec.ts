import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// Lane FJ (docs/figjam-parity.md): what a person coming from FigJam does that the board did not do, or did wrongly, checked in the
// running app. Each check reads what the server saved or the editor's store.

type Saved = {file: {name: string; kind?: string}; document: DesignDocument};
const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const objects = (file: Saved, kind: string): SceneNode[] => Object.values(file.document.nodes).filter(node => node.board?.kind === kind);
const tool = (page: Page) => page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {getState(): {tool: string}}}}).__morfaDesignTest.store.getState().tool);

async function openNewBoard(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  const box = (await canvas.boundingBox())!;
  return {id: fileIdFrom(page), centre: {x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2)}};
}

test('should open the stamp wheel at the pointer when E is pressed, and stamp the stamp picked from it', async ({page, seed: _seed}) => {
  const {id, centre} = await openNewBoard(page);
  await page.mouse.move(centre.x - 200, centre.y);
  await page.keyboard.press('KeyE');
  const wheel = page.getByRole('menu', {name: 'Stamp wheel'});
  await expect(wheel).toBeVisible();
  expect(await tool(page)).toBe('board-stamp');
  // Centred on the pointer.
  const ring = (await wheel.boundingBox())!;
  expect(Math.abs(ring.x + ring.width / 2 - (centre.x - 200))).toBeLessThan(2);
  expect(Math.abs(ring.y + ring.height / 2 - centre.y)).toBeLessThan(2);

  await wheel.getByRole('menuitemradio', {name: 'Star'}).click();
  await expect(wheel).toBeHidden();
  expect(await tool(page), 'the stamp stays in hand').toBe('board-stamp');
  await page.mouse.click(centre.x + 100, centre.y + 100);
  await expect.poll(async () => objects(await saved(page, id), 'stamp').map(node => node.board?.kind === 'stamp' ? node.board.stamp : null)).toEqual(['star']);

  // E with the stamp in hand brings the wheel back; 1–9 pick by place.
  await page.keyboard.press('KeyE');
  await expect(wheel).toBeVisible();
  await page.keyboard.press('Digit1');
  await expect(wheel).toBeHidden();
  await page.mouse.click(centre.x - 100, centre.y + 100);
  await expect.poll(async () => objects(await saved(page, id), 'stamp').length).toBe(2);
  const file = await saved(page, id);
  expect(objects(file, 'stamp').map(node => node.board?.kind === 'stamp' ? node.board.stamp : null).sort()).toEqual(['heart', 'star']);
  // E with the wheel open: more stamps and emoji (the "+" sheet on "Emoji").
  await page.keyboard.press('KeyE');
  await expect(wheel).toBeVisible();
  await page.keyboard.press('KeyE');
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('tab', {name: 'Emoji'})).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('should leave the stamp tool when Escape is pressed or the board is clicked with the wheel open', async ({page, seed: _seed}) => {
  const {id, centre} = await openNewBoard(page);
  const wheel = page.getByRole('menu', {name: 'Stamp wheel'});
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.press('KeyE');
  await expect(wheel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(wheel).toBeHidden();
  expect(await tool(page)).toBe('move');
  await page.keyboard.press('KeyE');
  await expect(wheel).toBeVisible();
  await page.mouse.click(centre.x + 300, centre.y + 200);
  await expect(wheel).toBeHidden();
  expect(await tool(page)).toBe('move');
  expect(objects(await saved(page, id), 'stamp'), 'a press elsewhere places nothing').toHaveLength(0);
});

test('should pick the stamp under the pointer when a held E is released over it', async ({page, seed: _seed}) => {
  const {centre} = await openNewBoard(page);
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.down('KeyE');
  const wheel = page.getByRole('menu', {name: 'Stamp wheel'});
  await expect(wheel).toBeVisible();
  const item = (await wheel.getByRole('menuitemradio', {name: '+1'}).boundingBox())!;
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2, {steps: 4});
  await page.waitForTimeout(300);
  await page.keyboard.up('KeyE');
  await expect(wheel).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('morfa.board.choices.v1') ?? '{}').stamp)).toBe('plus-one');
});

test('should list only what a board does in "Actions" and run a board tool from it', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  await page.keyboard.press('ControlOrMeta+KeyK');
  const search = page.getByRole('combobox');
  await expect(search).toBeFocused();
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option', {name: /^Sticky/})).toBeVisible();
  await expect(list.getByRole('option', {name: /Sort stickies by color/})).toBeVisible();
  for (const design of ['Annotations', 'Libraries…', 'UPPERCASE']) await expect(list.getByRole('option', {name: new RegExp(`^${design}`)})).toHaveCount(0);
  await expect(page.getByRole('tab', {name: 'Assets'})).toHaveCount(0);
  await search.fill('washi');
  await page.keyboard.press('Enter');
  await expect.poll(() => tool(page)).toBe('board-marker');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('morfa.board.choices.v1') ?? '{}').marker)).toBe('washi');
});

test('should turn pasted lines into stickies and pasted spreadsheet cells into a table', async ({page, seed: _seed}) => {
  const {id} = await openNewBoard(page);
  const paste = (text: string) => page.evaluate(value => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, text);
  await paste('Idea one\nIdea two\nIdea three');
  await expect.poll(async () => objects(await saved(page, id), 'sticky').length).toBe(3);
  await paste('Name\tRole\nAnna\tDesign');
  await expect.poll(async () => objects(await saved(page, id), 'table').length).toBe(1);
  const file = await saved(page, id);
  const texts = Object.values(file.document.nodes).filter(node => node.type === 'TEXT').map(node => node.text?.characters);
  expect(texts).toEqual(expect.arrayContaining(['Idea one', 'Idea two', 'Idea three', 'Anna', 'Design']));
});

test('should list the board\'s keys in "Keyboard shortcuts", not the design tools\'', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  await page.keyboard.press('Control+Shift+Slash');
  const dialog = page.getByRole('dialog', {name: 'Keyboard shortcuts'});
  await expect(dialog).toBeVisible();
  const tools = dialog.getByRole('region', {name: 'Tools'});
  await expect(tools.getByText('Sticky', {exact: true})).toBeVisible();
  await expect(tools.getByText('Washi tape', {exact: true})).toBeVisible();
  for (const design of ['Frame', 'Slice', 'Pen']) await expect(dialog.getByText(design, {exact: true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The design editor's dialog is back for a design file.
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Back to files', exact: true}).click();
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  // The editor takes keys, and co-editing and the meeting have mounted (fixtures.ts `waitEditorReady`).
  await waitEditorReady(page);
  await page.keyboard.press('Control+Shift+Slash');
  await expect(page.getByRole('dialog', {name: 'Keyboard shortcuts'}).getByText('Frame', {exact: true})).toBeVisible();
});

test('should leave focus on the board when a tool is clicked, so the next key is the board\'s and no ring shows', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const bar = page.getByRole('toolbar', {name: 'Board tools'});
  await bar.getByRole('button', {name: 'Sticky', exact: true}).click();
  expect(await tool(page)).toBe('board-sticky');
  expect(await page.evaluate(() => document.activeElement?.closest('.bd-toolbar') === null)).toBe(true);
  await page.keyboard.press('KeyM');
  expect(await tool(page)).toBe('board-marker');
  expect(await page.evaluate(() => document.querySelector('.bd-toolbar :focus-visible'))).toBeNull();
});

test('should add a connected sticky when the pointer travels from a sticky out to its right dot and clicks', async ({page, seed: _seed}) => {
  const {id, centre} = await openNewBoard(page);
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.type('One');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // The note is 240 px wide at 100 %: its right dot is 18 px past its right edge.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.move(centre.x + 120 + 18, centre.y, {steps: 20});
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => objects(await saved(page, id), 'sticky').length).toBe(2);
  const file = await saved(page, id);
  expect(objects(file, 'connector')).toHaveLength(1);
});

test('should open the stamp wheel above the toolbar\'s "Stamp" when it is clicked', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const button = page.getByRole('toolbar', {name: 'Board tools'}).getByRole('button', {name: 'Stamp', exact: true});
  await button.click();
  const wheel = page.getByRole('menu', {name: 'Stamp wheel'});
  await expect(wheel).toBeVisible();
  const [ring, at] = [(await wheel.boundingBox())!, (await button.boundingBox())!];
  expect(Math.abs(ring.x + ring.width / 2 - (at.x + at.width / 2))).toBeLessThan(2);
  expect(ring.y + ring.height).toBeLessThan(at.y);
  await expect(page.getByRole('group', {name: 'Stamp'}), 'no tray beside the wheel').toHaveCount(0);
});

test('should show the author\'s name at the foot of a new sticky, as FigJam does', async ({page, seed: _seed}) => {
  const {id, centre} = await openNewBoard(page);
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.type('Idea');
  await page.keyboard.press('Escape');
  await expect.poll(async () => objects(await saved(page, id), 'sticky').length).toBe(1);
  await expect.poll(async () => {
    const file = await saved(page, id);
    const author = Object.values(file.document.nodes).find(node => node.board?.kind === 'part' && node.board.part === 'author');
    return author ? {visible: author.visible !== false, named: !!author.text?.characters} : null;
  }).toEqual({visible: true, named: true});
});

test('should attach a stamp put on a sticky, so it moves with the sticky', async ({page, seed: _seed}) => {
  const {id, centre} = await openNewBoard(page);
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.type('Idea');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.mouse.move(centre.x + 400, centre.y);
  await page.keyboard.press('KeyE');
  await page.getByRole('menu', {name: 'Stamp wheel'}).getByRole('menuitemradio', {name: 'Heart'}).click();
  await page.mouse.click(centre.x + 80, centre.y - 80);
  await expect.poll(async () => objects(await saved(page, id), 'stamp').length).toBe(1);
  const before = await saved(page, id);
  const sticky = objects(before, 'sticky')[0];
  expect(objects(before, 'stamp')[0].parentId).toBe(sticky.id);
  // Drag the note by an empty part of it: the stamp goes along.
  await page.keyboard.press('KeyV');
  await page.mouse.move(centre.x - 60, centre.y + 80);
  await page.mouse.down();
  await page.mouse.move(centre.x - 360, centre.y + 80, {steps: 10});
  await page.mouse.up();
  await expect.poll(async () => Math.round(objects(await saved(page, id), 'sticky')[0].x)).toBe(Math.round(sticky.x - 300));
  const after = await saved(page, id);
  expect(objects(after, 'stamp')[0].parentId).toBe(sticky.id);
});

test('should offer "Back to board" when the view has left everything, and bring the board back', async ({page, seed: _seed}) => {
  const {centre} = await openNewBoard(page);
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const back = page.getByRole('button', {name: 'Back to board'});
  await expect(back).toHaveCount(0);
  await page.mouse.move(centre.x, centre.y);
  for (let k = 0; k < 30; k++) await page.mouse.wheel(0, 400);
  await expect(back).toBeVisible();
  await back.click();
  await expect(back).toHaveCount(0);
});

test('should draw a straight marker line while Shift is held', async ({page, seed: _seed}) => {
  const {id, centre} = await openNewBoard(page);
  await page.keyboard.press('KeyM');
  await page.mouse.move(centre.x - 200, centre.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(centre.x - 200 + k * 40, centre.y + (k % 2 ? 60 : -60));
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(async () => objects(await saved(page, id), 'stroke').length).toBe(1);
  const stroke = objects(await saved(page, id), 'stroke')[0];
  expect(stroke.height, 'a straight line from the press to the release, not the zigzag').toBeLessThan(80);
});
