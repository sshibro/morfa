import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import {createDocument, createNode, solid} from '../../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// Morfa Design shared libraries (docs/design-tool.md §Teams, "Shared libraries") in the real editor: file A of a team publishes its
// "Button" ("Publish library…"), file B of the same team enables the library ("Libraries" in "Assets") and places the button
// from its library section, then overrides the instance's label; A changes the button and publishes again; B is greeted with
// "Updates are available for the library", reviews and takes the update, and the instance follows the library while keeping its label.
// Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

const LIBRARY_PAGE = 'morfa:library';
type Saved = {file: {version: number; teamId: string | null}; document: DesignDocument};

function kitDocument(): DesignDocument {
  const doc = createDocument('p1', 'Components');
  const add = (node: SceneNode, parent: string) => {
    doc.nodes[node.id] = {...node, parentId: parent};
    doc.nodes[parent] = {...doc.nodes[parent], children: [...(doc.nodes[parent].children ?? []), node.id]};
  };
  add(createNode('COMPONENT', {id: 'btn', name: 'Button', x: 100, y: 100, width: 160, height: 48, fills: [], description: 'Primary button'}), 'p1');
  add(createNode('RECTANGLE', {id: 'bg', name: 'Background', width: 160, height: 48, cornerRadius: 8, fills: [solid({r: 0.05, g: 0.6, b: 1})], constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}}), 'btn');
  const label = createNode('TEXT', {id: 'label', name: 'Label', x: 16, y: 14, width: 120, height: 20});
  add({...label, text: {...label.text!, characters: 'Button', textAutoResize: 'NONE', style: {...label.text!.style, fontSize: 16}}}, 'btn');
  return doc;
}

const origin = (page: Page) => new URL(page.url()).origin;
async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
async function waitSaved(page: Page) {
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
}
/** Opens a file and waits until its own editor (and its test hook) holds it: the previous file's editor may linger a moment. */
async function openFile(page: Page, id: string, name: string, node?: string) {
  await page.goto('/#design/' + id);
  await expect(page).toHaveTitle(`${name} — Design`);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await waitSaved(page);
  if (node)
    await expect.poll(() => page.evaluate(nodeId => !!(window as unknown as {__morfaDesignTest?: {store: {getState(): {doc: {nodes: Record<string, unknown>}}}}}).__morfaDesignTest?.store.getState().doc.nodes[nodeId], node)).toBe(true);
}
async function fileMenu(page: Page, item: string) {
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'File', exact: true}).hover();
  await page.getByRole('menuitem', {name: item, exact: true}).click();
}
/** The instance of the library's button in a saved document and its label copy. */
function instanceOf(doc: DesignDocument) {
  const instance = Object.values(doc.nodes).find(node => node.type === 'INSTANCE' && node.mainId === undefined && node.componentId?.endsWith(':btn'));
  const label = instance && Object.values(doc.nodes).find(node => node.id.startsWith(instance.id + ';') && node.mainId?.endsWith(':label'));
  const background = instance && Object.values(doc.nodes).find(node => node.id.startsWith(instance.id + ';') && node.mainId?.endsWith(':bg'));
  return {instance, label, background};
}

test('a team library: publish a button, use it in another file, republish, take the update with the override kept', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  await page.goto('/#designs');
  const created = await page.request.post('/api/design-teams', {headers: {Origin: origin(page)}, data: {name: 'North Studio'}});
  expect(created.ok(), await created.text()).toBeTruthy();
  const teamId = ((await created.json()) as {team: {id: string}}).team.id;
  const make = async (name: string, document?: DesignDocument) => {
    const response = await page.request.post('/api/design-files', {headers: {Origin: origin(page)}, data: {name, teamId, ...(document ? {document} : {})}});
    expect(response.ok(), await response.text()).toBeTruthy();
    return ((await response.json()) as {file: {id: string}}).file.id;
  };
  const kit = await make('UI kit', kitDocument());
  const landing = await make('Landing page');

  // ── A publishes its button ──
  await openFile(page, kit, 'UI kit');
  await fileMenu(page, 'Publish library…');
  const publish = page.getByRole('dialog', {name: 'Publish library'});
  await expect(publish).toContainText('North Studio');
  const row = publish.locator('.dz-publish-row').filter({hasText: 'Button'});
  await expect(row.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  await expect(publish.locator('.dz-publish-mark'), 'a first publication marks nothing as new').toHaveCount(0);
  await publish.getByRole('textbox').fill('First version');
  await publish.getByRole('button', {name: /^Publish · 1 asset$/}).click();
  await expect(page.getByText('Library published · version 1')).toBeVisible();
  await expect(publish).toHaveCount(0);

  // ── B enables the library and places the button from "Assets" ──
  await openFile(page, landing, 'Landing page');
  await page.getByRole('tab', {name: 'Assets', exact: true}).click();
  await page.getByRole('button', {name: 'Libraries', exact: true}).click();
  const libraries = page.getByRole('dialog', {name: 'Libraries'});
  await expect(libraries).toContainText('"North Studio" team libraries');
  const toggle = libraries.getByRole('switch', {name: 'Enable "UI kit"'});
  await expect(libraries.locator('.dz-library-row').filter({hasText: 'UI kit'})).toContainText('1 component · version 1');
  await toggle.click();
  await expect(libraries.getByRole('switch', {name: 'Disable "UI kit"'})).toHaveAttribute('aria-checked', 'true');
  await libraries.getByRole('button', {name: 'Close', exact: true}).click();
  const section = page.getByRole('region', {name: 'UI kit'});
  const asset = section.locator('[data-library-asset="btn"]');
  await expect(asset).toBeVisible();
  await asset.click();
  await expect.poll(async () => !!instanceOf((await saved(page, landing)).document).instance).toBe(true);
  let stored = (await saved(page, landing)).document;
  expect(stored.pages).not.toContain(LIBRARY_PAGE);
  expect(stored.nodes[LIBRARY_PAGE]?.children?.length).toBe(1);
  const {instance} = instanceOf(stored);
  expect(stored.nodes[instance!.componentId!].remote).toMatchObject({key: 'btn', version: 1});

  // The label of this instance becomes "Buy" (an override, as the text tool records it).
  await page.evaluate(() => {
    type Node = {id: string; type: string; mainId?: string; text?: {characters: string}};
    const store = (window as unknown as {__morfaDesignTest: {store: {getState(): {doc: {nodes: Record<string, Node>}}; transact(label: string, recipe: (tx: {update(id: string, partial: unknown): void}) => void): void}}}).__morfaDesignTest.store;
    const nodes = store.getState().doc.nodes;
    const label = Object.values(nodes).find(node => node.type === 'TEXT' && node.mainId?.endsWith(':label') && node.id.includes(';'))!;
    store.transact('Text', tx => tx.update(label.id, {text: {...label.text, characters: 'Buy'}, overrides: ['text.characters']}));
  });
  await expect.poll(async () => instanceOf((await saved(page, landing)).document).label?.text?.characters).toBe('Buy');

  // ── A changes the button and publishes again ──
  await openFile(page, kit, 'UI kit', 'bg');
  await page.evaluate(() => {
    const store = (window as unknown as {__morfaDesignTest: {store: {transact(label: string, recipe: (tx: {update(id: string, partial: unknown): void}) => void): void}}}).__morfaDesignTest.store;
    store.transact('Fill', tx => tx.update('bg', {fills: [{type: 'SOLID', color: {r: 0.08, g: 0.68, b: 0.36}, opacity: 1, visible: true, blendMode: 'NORMAL'}]}));
  });
  await expect.poll(async () => ((await saved(page, kit)).document.nodes.bg.fills[0] as {color: {g: number}}).color.g).toBeCloseTo(0.68);
  await fileMenu(page, 'Publish library…');
  const again = page.getByRole('dialog', {name: 'Publish library changes'});
  await expect(again.locator('.dz-publish-row').filter({hasText: 'Button'}).locator('.dz-publish-mark')).toHaveText('Changed');
  await again.getByRole('textbox').fill('Green button');
  await again.getByRole('button', {name: /^Publish/}).click();
  await expect(page.getByText('Library published · version 2')).toBeVisible();

  // ── B is told, reviews and takes the update ──
  await openFile(page, landing, 'Landing page');
  await expect(page.getByText('Updates are available for the library "UI kit"')).toBeVisible();
  await page.getByRole('button', {name: 'View', exact: true}).click();
  const updates = page.getByRole('dialog', {name: 'Library updates'});
  await expect(updates).toContainText('version 1 → 2');
  await expect(updates).toContainText('Green button');
  await expect(updates.locator('.dz-update-row').filter({hasText: 'Button'})).toBeVisible();
  await updates.getByRole('button', {name: 'Update all', exact: true}).click();
  await expect(updates).toHaveCount(0);
  await expect.poll(async () => {
    const doc = (await saved(page, landing)).document;
    const found = instanceOf(doc);
    return [doc.nodes[found.instance!.componentId!].remote?.version, found.label?.text?.characters, Math.round(((found.background?.fills[0] as {color: {g: number}}).color.g) * 100)];
  }).toEqual([2, 'Buy', 68]);
  stored = (await saved(page, landing)).document;
  expect(instanceOf(stored).instance!.id).toBe(instance!.id);

  // The update was marked as seen: a reload greets no more.
  await page.reload();
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await waitSaved(page);
  await page.waitForTimeout(1500);
  await expect(page.getByText('Updates are available for the library "UI kit"')).toHaveCount(0);
});
