import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// The context toolbar over a board's selection as FigJam's help shows it (help.figma.com "Sticky notes in FigJam", "Visualize
// information using shapes with text"; lane FJ): a sticky's colour, "Aa", bold, strikethrough, link, list and its author switch;
// a shape's figure, fill, outline and text; the rest under "More". Each check reads what the server saved.

type Saved = {document: DesignDocument};
const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const objects = (file: Saved, kind: string): SceneNode[] => Object.values(file.document.nodes).filter(node => node.board?.kind === kind);
const textOf = (file: Saved, object: SceneNode) => (object.children ?? []).map(child => file.document.nodes[child]).find(node => node?.board?.kind === 'part' && node.board.part === 'text');

async function boardWithSticky(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + Math.round(canvas.width / 2), y: canvas.y + Math.round(canvas.height / 2)};
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.type('Idea');
  await page.keyboard.press('Escape');
  const id = fileIdFrom(page);
  await expect.poll(async () => objects(await saved(page, id), 'sticky').length).toBe(1);
  return {id, centre};
}

test('should lay a sticky\'s toolbar out as FigJam\'s: colour, text, the author switch, "More"', async ({page, seed: _seed}) => {
  await boardWithSticky(page);
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await expect(context).toBeVisible();
  const labels = await context.locator(':scope > .bd-context-group > button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  expect(labels).toEqual(['Sticky color', 'Font', 'Bold', 'Strikethrough', 'Link', 'Bulleted list', 'Show author', 'More']);
  expect(await context.evaluate(element => getComputedStyle(element).height)).toBe('48px');
  // A new sticky shows its author: the switch is on, a filled violet tile.
  const author = context.getByRole('button', {name: 'Show author'});
  await expect(author).toHaveAttribute('aria-pressed', 'true');
  expect(await author.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(151, 71, 255)');
});

test('should strike through, list and link a sticky\'s whole text from its toolbar, and change its face from "Aa"', async ({page, seed: _seed}) => {
  const {id} = await boardWithSticky(page);
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'Strikethrough'}).click();
  await context.getByRole('button', {name: 'Bulleted list'}).click();
  await context.getByRole('button', {name: 'Link'}).click();
  await page.getByRole('textbox', {name: 'Link address'}).fill('example.com');
  await page.keyboard.press('Enter');
  await context.getByRole('button', {name: 'Font'}).click();
  await page.getByRole('menuitemradio', {name: 'Handwriting'}).click();
  await expect.poll(async () => {
    const file = await saved(page, id);
    const text = textOf(file, objects(file, 'sticky')[0])?.text;
    return {strike: text?.style.textDecoration, list: text?.listTypes?.[0], link: text?.style.hyperlink, face: text?.style.fontFamily};
  }).toEqual({strike: 'STRIKETHROUGH', list: 'UNORDERED', link: {type: 'URL', url: 'https://example.com/'}, face: 'Caveat'});
  await expect(context.getByRole('button', {name: 'Strikethrough'})).toHaveAttribute('aria-pressed', 'true');
});

test('should keep a sticky\'s width and lock under "More"', async ({page, seed: _seed}) => {
  const {id} = await boardWithSticky(page);
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'More'}).click();
  await page.getByRole('menuitemcheckbox', {name: 'Wide sticky'}).click();
  await expect.poll(async () => objects(await saved(page, id), 'sticky')[0].width).toBe(480);
  await context.getByRole('button', {name: 'More'}).click();
  await page.getByRole('menuitem', {name: 'Lock'}).click();
  await expect.poll(async () => objects(await saved(page, id), 'sticky')[0].locked).toBe(true);
});

test('should give a shape its figure, fill and outline, then its text, as FigJam does', async ({page, seed: _seed}) => {
  const {centre} = await boardWithSticky(page);
  await page.keyboard.press('KeyR');
  await page.mouse.click(centre.x + 320, centre.y);
  await page.keyboard.type('Step');
  await page.keyboard.press('Escape');
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await expect(context.getByRole('button', {name: 'Shape'})).toBeVisible();
  const labels = await context.locator(':scope > .bd-context-group > button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  expect(labels).toEqual(['Shape', 'Fill', 'Stroke', 'Font and size', 'Bold', 'Strikethrough', 'Link', 'Bulleted list', 'More']);
});

test('should give a connector FigJam\'s start and end styles and a label background in its colour', async ({page, seed: _seed}) => {
  const {id, centre} = await boardWithSticky(page);
  await page.keyboard.press('KeyR');
  await page.mouse.click(centre.x + 400, centre.y);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyX');
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 400, centre.y, {steps: 10});
  await page.mouse.up();
  await page.keyboard.press('KeyV');
  await page.mouse.click(centre.x + 200, centre.y);
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'Start point'}).click();
  await page.getByRole('menuitemradio', {name: 'Diamond'}).click();
  await context.getByRole('button', {name: 'End point'}).click();
  await page.getByRole('menuitemradio', {name: 'Filled arrow'}).click();
  const line = async () => {
    const file = await saved(page, id);
    const connector = objects(file, 'connector')[0];
    const vector = (connector?.children ?? []).map(child => file.document.nodes[child]).find(node => node?.board?.kind === 'part' && node.board.part === 'line');
    return {start: vector?.strokeStartMarker, end: vector?.strokeEndMarker};
  };
  await expect.poll(line).toEqual({start: 'DIAMOND', end: 'TRIANGLE_ARROW'});
  // A label, then its background from the colour picker.
  await context.getByRole('button', {name: 'More'}).click();
  await page.getByRole('menuitem', {name: 'Label'}).click();
  await page.keyboard.type('yes');
  await page.keyboard.press('Escape');
  await context.getByRole('button', {name: 'Line color'}).click();
  const background = page.getByRole('button', {name: 'Label background'});
  await expect(background).toHaveAttribute('aria-pressed', 'false');
  await background.click();
  await expect.poll(async () => {
    const file = await saved(page, id);
    const connector = objects(file, 'connector')[0];
    const label = (connector?.children ?? []).map(child => file.document.nodes[child]).find(node => node?.board?.kind === 'part' && node.board.part === 'label');
    const paint = label?.fills[0];
    return paint?.type === 'SOLID' && (paint.color.r < 0.9 || paint.color.g < 0.9 || paint.color.b < 0.9);
  }).toBe(true);
});
