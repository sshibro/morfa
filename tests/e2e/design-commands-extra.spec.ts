import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import {createDocument, createNode} from '../../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// "Morfa Design": the menu commands of src/design/engine/commands/{find,properties,link}.ts in the real
// editor. "Find and replace" (⌘F) finds text on this page or every page, jumps through the matches and
// replaces them all in one undo step; "Copy/Paste properties" (⌥⌘C / ⌥⌘V) carry a layer's look;
// "Copy link to layer" (⌘L) gives a link that opens the file with that layer selected.
// Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type Saved = {file: {version: number}; document: DesignDocument};

const solid = (r: number, g: number, b: number) => ({type: 'SOLID' as const, color: {r, g, b}, opacity: 1, visible: true, blendMode: 'NORMAL' as const});

function text(id: string, characters: string, props: Partial<SceneNode> = {}): SceneNode {
  const node = createNode('TEXT', {id, name: characters, width: 260, height: 20, ...props});
  return {...node, text: {...node.text!, characters, runs: [], style: {...node.text!.style, fontSize: 16}}};
}

/** Two pages: a card with two texts, a blue rounded button and a plain ellipse; another page with one text. */
function seedDocument(): DesignDocument {
  const doc = createDocument('p1', 'Home');
  const add = (node: SceneNode, parent: string) => {
    doc.nodes[node.id] = {...node, parentId: parent};
    doc.nodes[parent] = {...doc.nodes[parent], children: [...(doc.nodes[parent].children ?? []), node.id]};
  };
  doc.pages.push('p2');
  doc.nodes.p2 = {...createNode('PAGE', {id: 'p2', name: 'Catalog'}), parentId: null};
  add(createNode('FRAME', {id: 'card', name: 'Card', width: 360, height: 240, fills: [solid(1, 1, 1)]}), 'p1');
  add(text('title', 'Buy now', {x: 24, y: 24}), 'card');
  add(text('body', 'Buy in installments', {x: 24, y: 64}), 'card');
  add(createNode('RECTANGLE', {id: 'btn', name: 'Button', x: 24, y: 160, width: 140, height: 48, cornerRadius: 8, opacity: 0.8, fills: [solid(0.05, 0.6, 1)]}), 'card');
  add(createNode('ELLIPSE', {id: 'dot', name: 'Dot', x: 260, y: 160, width: 48, height: 48}), 'card');
  add(text('far', 'Buy on another page'), 'p2');
  return doc;
}

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}

async function openSeeded(page: Page): Promise<string> {
  await page.goto('/#designs');
  const response = await page.request.post('/api/design-files', {headers: {Origin: new URL(page.url()).origin}, data: {name: 'Commands', document: seedDocument()}});
  expect(response.ok(), await response.text()).toBeTruthy();
  const {file} = (await response.json()) as {file: {id: string}};
  await page.goto('/#design/' + file.id);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  return file.id;
}

const row = (page: Page, id: string) => page.locator(`.dz-layers-scroll [data-row-id="${id}"]`);
const characters = async (page: Page, file: string, id: string) => (await saved(page, file)).document.nodes[id]?.text?.characters;

test('find and replace: matches on every page, jumps between them, replaces all in one undo step', async ({page, seed: _seed}) => {
  const file = await openSeeded(page);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await canvas.click({position: {x: 800, y: 700}});
  await page.keyboard.press('ControlOrMeta+f');
  const bar = page.getByRole('search', {name: 'Find and replace'});
  const find = bar.getByRole('textbox', {name: 'Find', exact: true});
  await expect(find).toBeFocused();
  await page.keyboard.type('buy');
  await expect(bar.locator('.dz-find-count')).toHaveText('Found: 2');

  // Enter jumps to the first match (the top-most layer first) and selects it; ⇧Enter goes back.
  await page.keyboard.press('Enter');
  await expect(bar.locator('.dz-find-count')).toHaveText('1 of 2');
  await expect(row(page, 'body')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(row(page, 'title')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+Enter');
  await expect(row(page, 'body')).toHaveAttribute('aria-selected', 'true');

  // Every page: the other page's text joins, and a jump there switches the page.
  await bar.getByRole('button', {name: /On this page/}).click();
  await page.getByRole('menuitemradio', {name: 'On all pages'}).click();
  await expect(bar.locator('.dz-find-count')).toHaveText('Found: 3');
  await find.focus();
  // The first jump starts on the page in view; the third reaches "Catalog".
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
  await expect(bar.locator('.dz-find-count')).toHaveText('3 of 3');
  await expect(page.getByRole('option', {name: 'Catalog', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'far')).toHaveAttribute('aria-selected', 'true');

  // "Replace all": every text in one step, saved; ⌘Z brings them all back.
  await bar.getByRole('textbox', {name: 'Replace with'}).fill('Order');
  await bar.getByRole('button', {name: 'Replace all', exact: true}).click();
  await expect(page.getByText('Replaced 3 matches in 3 layers')).toBeVisible();
  await expect(bar.locator('.dz-find-count')).toHaveText('No matches');
  await expect.poll(() => characters(page, file, 'far')).toBe('Order on another page');
  expect(await characters(page, file, 'title')).toBe('Order now');
  expect(await characters(page, file, 'body')).toBe('Order in installments');
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => characters(page, file, 'far')).toBe('Buy on another page');
  expect(await characters(page, file, 'title')).toBe('Buy now');
  expect(await characters(page, file, 'body')).toBe('Buy in installments');
});

test('copy and paste properties carry the look of one layer onto another', async ({page, seed: _seed}) => {
  const file = await openSeeded(page);
  await row(page, 'card').locator('[data-caret]').click();
  await row(page, 'btn').click();
  await page.keyboard.press('ControlOrMeta+Alt+c');
  await expect(page.getByText('Properties copied')).toBeVisible();
  await row(page, 'dot').click();
  await expect(row(page, 'dot')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+Alt+v');
  await expect.poll(async () => (await saved(page, file)).document.nodes.dot.opacity).toBe(0.8);
  const {nodes} = (await saved(page, file)).document;
  expect(nodes.dot.fills).toEqual(nodes.btn.fills);
  expect(nodes.dot.cornerRadius).toBeUndefined();
  // The same through the menu: "Edit ▸ Paste properties" is there and enabled.
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Edit', exact: true}).hover();
  await expect(page.getByRole('menuitem', {name: /Paste properties/})).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('a copied link to a layer opens the file with that layer selected on its page', async ({page, context, seed: _seed}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const file = await openSeeded(page);
  await page.getByRole('option', {name: 'Catalog', exact: true}).click();
  await row(page, 'far').click();
  await page.keyboard.press('ControlOrMeta+l');
  await expect(page.getByText('Link to layer copied')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${new URL(page.url()).origin}/#design/${encodeURIComponent(file)}?node=far`);

  // Away to the files, then the link: the editor opens on "Catalog" with the text selected.
  await page.goto('/#designs');
  await page.goto(link);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await expect(page.getByRole('option', {name: 'Catalog', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'far')).toHaveAttribute('aria-selected', 'true');

  // A link to another layer of the open file, typed into the address bar, selects it too.
  await page.evaluate(id => {location.hash = `#design/${encodeURIComponent(id)}?node=btn`;}, file);
  await expect(page.getByRole('option', {name: 'Home', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'btn')).toHaveAttribute('aria-selected', 'true');
});
