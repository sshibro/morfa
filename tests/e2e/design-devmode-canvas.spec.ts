import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';

// "Morfa Design": the canvas in "Code" (Figma's Dev Mode, ⇧D; docs/design-tool.md §Toolbar, "Actions" and modes).
// A click selects the layer under the pointer however deep it lies, hovering another layer measures to it from the selection
// without ⌥, an auto-layout frame shows its padding and gaps, and nothing is dragged or opened for editing; "Design" keeps
// Figma's rules. The canvas aids (src/design/editor/Rulers.tsx) are read back pixel by pixel: the measurements' red, the
// spacing's pink.

type Saved = {file: {name: string; version: number}; document: DesignDocument};
type Pt = {x: number; y: number};
type Probe = {getState(): {selection: readonly NodeId[]; hoverId: NodeId | null; editing: unknown; doc: DesignDocument; ui: {devMode: boolean}}; setViewport(viewport: {x: number; y: number; zoom: number}): void};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
const saved = async (page: Page, id: string) => (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as Saved;

/** A screen with a card (auto layout: 16 px padding, 12 px between a title and a button) and a caption under it. */
function screenDocument(): DesignDocument {
  let doc = createDocument('page', 'Screen');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  const ink = [solid({r: 0.1, g: 0.1, b: 0.1})];
  const fixed = {layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED'} as const;
  add('FRAME', {id: 'screen', parentId: 'page', name: 'Screen', x: 0, y: 0, width: 600, height: 400, fills: [solid({r: 1, g: 1, b: 1})]});
  add('FRAME', {id: 'card', parentId: 'screen', name: 'Card', x: 40, y: 40, width: 300, height: 120, fills: [solid({r: 0.95, g: 0.95, b: 0.97})],
    autoLayout: {...defaultAutoLayout('HORIZONTAL'), paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, itemSpacing: 12}});
  add('TEXT', {id: 'title', parentId: 'card', name: 'Heading', x: 16, y: 16, width: 120, height: 24, fills: ink, ...fixed, text: {...defaultTextProps('Heading'), textAutoResize: 'NONE'}});
  add('RECTANGLE', {id: 'button', parentId: 'card', name: 'Button', x: 148, y: 16, width: 80, height: 40, fills: [solid({r: 0.05, g: 0.6, b: 1})]});
  add('TEXT', {id: 'caption', parentId: 'screen', name: 'Caption', x: 40, y: 240, width: 200, height: 24, fills: ink, ...fixed, text: {...defaultTextProps('Caption'), textAutoResize: 'NONE'}});
  return doc;
}

async function openScreen(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  const opened = await saved(page, id);
  const written = await page.request.put(`/api/design-files/${encodeURIComponent(id)}/document`, {headers: {Origin: new URL(page.url()).origin}, data: {baseVersion: opened.file.version, document: screenDocument()}});
  expect(written.ok(), await written.text()).toBeTruthy();
  await page.reload();
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible({timeout: 30_000});
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);
  // Page point (0, 0) 100 px in from the canvas's corner, at 100 %.
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.setViewport({x: -100, y: -100, zoom: 1}));
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number): Pt => ({x: box.x + 100 + x, y: box.y + 100 + y});
  return {id, canvas, at};
}

const state = (page: Page) => page.evaluate(() => {
  const {selection, hoverId, editing, ui} = (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.getState();
  return {selection: [...selection], hoverId, editing, devMode: ui.devMode};
});
const nodeX = (page: Page, id: NodeId) => page.evaluate(nodeId => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.getState().doc.nodes[nodeId].x, id);

/** How many pixels of the canvas aids are the measurements' red (--dz-guide) and the spacing's pink (#E83D9A). */
const aidColours = (page: Page) => page.evaluate(() => {
  const canvas = document.querySelector<HTMLCanvasElement>('.dz-canvas-aids__paint')!;
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let red = 0, pink = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 200 || r < 200 || g > 120) continue;
    if (b < 90) red++;
    else if (b > 120) pink++;
  }
  return {red, pink};
});

const modes = (page: Page) => page.getByRole('toolbar', {name: 'Tools'}).getByRole('radiogroup', {name: 'Mode'});
const row = (page: Page, id: NodeId) => page.locator(`[data-row-id="${id}"]`);

test('"Code": one click selects a text inside a card, a double click or a drag edits nothing; in "Design" the same click picks the card', async ({page, seed: _seed}) => {
  const {at} = await openScreen(page);
  const title = at(40 + 16 + 30, 40 + 16 + 12);

  // "Design": Figma's rules, the card is picked whole (the frame on the canvas lets its layers be picked).
  await page.mouse.click(title.x, title.y);
  await expect.poll(async () => (await state(page)).selection).toEqual(['card']);
  await expect(row(page, 'card')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Shift+d');
  await expect(modes(page).getByRole('radio', {name: 'Code'})).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await state(page)).devMode).toBe(true);
  // The hover lights what the click selects.
  await page.mouse.move(title.x + 2, title.y);
  await expect.poll(async () => (await state(page)).hoverId).toBe('title');
  await page.mouse.click(title.x, title.y);
  await expect.poll(async () => (await state(page)).selection).toEqual(['title']);
  await expect(row(page, 'title')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.dz-code-header-name')).toHaveText('Heading');

  // The file is inspected: a double click opens no text editor, a drag from the text moves nothing (it draws a marquee).
  await page.mouse.dblclick(title.x, title.y);
  expect((await state(page)).editing).toBeNull();
  await page.mouse.move(title.x, title.y);
  await page.mouse.down();
  await page.mouse.move(title.x + 40, title.y + 30, {steps: 5});
  await page.mouse.move(title.x + 80, title.y + 60, {steps: 5});
  await page.mouse.up();
  expect(await nodeX(page, 'title')).toBe(16);
  expect(await nodeX(page, 'card')).toBe(40);

  // Back in "Design" a drag moves again.
  await page.keyboard.press('Shift+d');
  await expect.poll(async () => (await state(page)).devMode).toBe(false);
  await page.mouse.click(title.x, title.y);
  await expect.poll(async () => (await state(page)).selection).toEqual(['card']);
  await page.mouse.move(title.x, title.y);
  await page.mouse.down();
  await page.mouse.move(title.x + 20, title.y, {steps: 5});
  await page.mouse.move(title.x + 40, title.y, {steps: 5});
  await page.mouse.up();
  await expect.poll(() => nodeX(page, 'card')).toBeGreaterThan(60);
});

test('"Code": with a selection, hovering another layer shows the distances to it without ⌥; "Design" still needs ⌥', async ({page, seed: _seed}) => {
  const {at} = await openScreen(page);
  const title = at(40 + 16 + 30, 40 + 16 + 12), caption = at(40 + 100, 240 + 12), outside = at(700, 300);

  // "Design": hovering shows no distances until ⌥ is held.
  await page.mouse.click(title.x, title.y);
  await page.mouse.move(caption.x, caption.y, {steps: 4});
  await expect.poll(async () => (await state(page)).hoverId).toBe('caption');
  await page.waitForTimeout(100);
  expect((await aidColours(page)).red).toBe(0);
  await page.keyboard.down('Alt');
  await page.mouse.move(caption.x + 4, caption.y, {steps: 2});
  await expect.poll(async () => (await aidColours(page)).red).toBeGreaterThan(40);
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await aidColours(page)).red).toBe(0);

  // "Code": the text in the card selected, the caption hovered: the red lines and their numbers, no modifier held.
  await page.keyboard.press('Shift+d');
  await page.mouse.click(title.x, title.y);
  await expect.poll(async () => (await state(page)).selection).toEqual(['title']);
  // Over the selection itself there is nothing to measure.
  await expect.poll(async () => (await aidColours(page)).red).toBe(0);
  await page.mouse.move(caption.x, caption.y, {steps: 4});
  await expect.poll(async () => (await state(page)).hoverId).toBe('caption');
  await expect.poll(async () => (await aidColours(page)).red).toBeGreaterThan(40);
  // Off every layer, nothing is measured.
  await page.mouse.move(outside.x, outside.y, {steps: 4});
  await expect.poll(async () => (await state(page)).hoverId).toBeNull();
  await expect.poll(async () => (await aidColours(page)).red).toBe(0);
});

test('"Code": an auto-layout frame shows its padding and gap in pink, selected or hovered; "Design" does not', async ({page, seed: _seed}) => {
  const {at} = await openScreen(page);
  // The card's empty area (right of the button): a click there selects the card itself.
  const cardSpace = at(40 + 270, 40 + 90), outside = at(700, 300);
  await page.mouse.click(cardSpace.x, cardSpace.y);
  await expect.poll(async () => (await state(page)).selection).toEqual(['card']);
  await page.waitForTimeout(100);
  expect((await aidColours(page)).pink).toBe(0);

  await page.keyboard.press('Shift+d');
  await expect.poll(async () => (await state(page)).devMode).toBe(true);
  await expect.poll(async () => (await aidColours(page)).pink).toBeGreaterThan(500);
  // Nothing selected: the hovered auto-layout frame shows its own.
  await page.mouse.click(outside.x, outside.y);
  await expect.poll(async () => (await state(page)).selection).toEqual([]);
  await expect.poll(async () => (await aidColours(page)).pink).toBe(0);
  await page.mouse.move(cardSpace.x, cardSpace.y, {steps: 4});
  await expect.poll(async () => (await state(page)).hoverId).toBe('card');
  await expect.poll(async () => (await aidColours(page)).pink).toBeGreaterThan(500);
});
