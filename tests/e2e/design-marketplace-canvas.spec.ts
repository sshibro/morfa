import type {Page} from '@playwright/test';
import {test, expect, waitEditorReady} from './fixtures';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';

// Card Canvas (docs/marketplaces.md §Card Canvas): a new file that opens on a WB card, Spec Lint checking it live — text contrast
// measured off the rendered card, banned words, a finding that selects its layer —, layer roles and "Show on", the card
// moved to Ozon; then the "Marketplaces" frame presets, a plain frame refitted to 900 × 1200 and made a card, and the badge
// zones' switch in "View".

type Probe = {
  getState(): {selection: readonly NodeId[]; doc: DesignDocument; pageId: NodeId; ui: {cardZones: boolean}};
  setSelection(ids: readonly NodeId[]): void;
  transact(label: string, recipe: (tx: {create(node: SceneNode, parentId: NodeId): void}) => void): void;
};
const probe = (page: Page) => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest);

/** The id of the first layer named `name`, selected. */
async function select(page: Page, name: string): Promise<NodeId> {
  const id = await page.evaluate(name => {
    const store = (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store;
    const node = Object.values(store.getState().doc.nodes).find(n => n.name === name);
    if (node) store.setSelection([node.id]);
    return node?.id ?? null;
  }, name);
  expect(id, name).toBeTruthy();
  return id!;
}

const nodeOf = (page: Page, id: NodeId) => page.evaluate(nodeId => {
  const node = (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.getState().doc.nodes[nodeId];
  return node ? {name: node.name, width: node.width, height: node.height, pluginData: node.pluginData ?? null, locked: node.locked} : null;
}, id);

const selection = (page: Page) => page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.getState().selection);

/** Puts a layer into the open file the way a paste would (no UI path makes this exact text quickly). */
async function addLayer(page: Page, parentName: string, layer: Partial<SceneNode> & {type: SceneNode['type']}) {
  return page.evaluate(([parentName, layer]) => {
    const store = (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store;
    const doc = store.getState().doc;
    const parent = parentName ? Object.values(doc.nodes).find(n => n.name === parentName)!.id : store.getState().pageId;
    const id = `e2e${Math.random().toString(36).slice(2, 10)}`;
    const base = {
      id, parentId: parent, name: layer.name ?? 'Layer', visible: true, locked: false, opacity: 1, blendMode: 'NORMAL', isMask: false, x: 0, y: 0, width: 100, height: 100,
      rotation: 0, fills: [], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', strokeCap: 'NONE', strokeJoin: 'MITER', strokeMiterLimit: 4, dashPattern: [],
      effects: [], constraints: {horizontal: 'MIN', vertical: 'MIN'}, layoutPositioning: 'AUTO', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
      exportSettings: [], reactions: [],
    };
    store.transact('e2e', tx => tx.create({...base, ...layer, id, parentId: parent} as SceneNode, parent));
    return id;
  }, [parentName, layer] as const);
}

const grey = (value: number) => [{type: 'SOLID', visible: true, opacity: 1, blendMode: 'NORMAL', color: {r: value, g: value, b: value}}];
const text = (characters: string, size: number, fill: number): Partial<SceneNode> => ({
  fills: grey(fill) as SceneNode['fills'],
  text: {
    characters, runs: [], textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', textAutoResize: 'NONE', paragraphSpacing: 0, paragraphIndent: 0,
    style: {fontFamily: 'Inter', fontWeight: 500, italic: false, fontSize: size, lineHeight: {unit: 'AUTO'}, letterSpacing: {unit: 'PERCENT', value: 0}, textDecoration: 'NONE', textCase: 'ORIGINAL'},
  },
});

test('a new WB card: Spec Lint measures it live, a finding selects its layer, roles and marketplaces change what is checked', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file from a template', exact: true}).click();
  await page.getByRole('button', {name: /^Marketplace card/}).click();
  await expect(page.getByRole('heading', {name: 'Marketplace card'})).toBeVisible();
  await expect(page.getByRole('radio', {name: /^Wildberries/})).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', {name: /^One card/}).click();
  await page.getByRole('button', {name: 'Create file', exact: true}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/, {timeout: 20_000});
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible({timeout: 30_000});
  await waitEditorReady(page);
  await expect.poll(() => probe(page)).toBe(true);

  // The card: its tab "Check" with the verdict and the three marketplaces.
  const card = await select(page, 'WB · Main photo');
  await expect(page.getByRole('heading', {name: 'WB card', exact: true})).toBeVisible();
  await expect(page.getByRole('tab', {name: 'Check'})).toHaveAttribute('aria-selected', 'true');
  const verdict = page.locator('.dz-mp-verdict');
  // One picture: WB keeps it out of search, the one remark of the starter.
  await expect(verdict).toContainText('Will pass Wildberries moderation');
  await expect(page.getByRole('radio', {name: /^Wildberries: 1 remark/})).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', {name: /^Ozon:/})).toBeVisible();
  await expect(page.getByText('Rules as of 22.09.2026')).toBeVisible();
  // Contrast is measured off the rendered card: it leaves "No data" and passes.
  await page.locator('.dz-mp-passed').click();
  await expect(page.locator('.dz-mp-checks.is-passed').getByText('Text contrast')).toBeVisible({timeout: 20_000});

  // A pale caption with a sales word (Russian on purpose: the banned-word rules match the Russian text sellers put on cards): two failures, both pointing at it.
  const caption = await addLayer(page, 'WB · Main photo', {type: 'TEXT', name: 'Caption', x: 64, y: 300, width: 500, height: 40, ...text('Скидка 50 % только сегодня', 28, 0.85)});
  await page.evaluate(id => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.setSelection([id]), card);
  await expect(verdict).toContainText('Will not pass Wildberries moderation');
  const words = page.locator('.dz-mp-check', {hasText: 'Banned words'});
  await expect(words).toContainText('Error');
  // 28 px is large text: 3:1 is enough, and a pale grey on white has far less.
  await expect(page.locator('.dz-mp-check', {hasText: 'Text contrast'})).toContainText(/contrast 1\.\d:1, needs 3\.0:1 for large text/, {timeout: 20_000});

  // The finding selects the caption; the layer's panel lists what is wrong with it.
  await words.getByRole('button', {name: /Скидка/}).click();
  await expect.poll(() => selection(page)).toEqual([caption]);
  await expect(page.getByRole('heading', {name: 'Layer on the WB card', exact: true})).toBeVisible();
  await expect(page.getByRole('list', {name: 'Layer remarks'})).toContainText('Скидка');

  // A role: as a logo it fails WB too; hidden for WB, nothing about it is WB's problem any more.
  await page.getByRole('button', {name: 'Role on the card'}).click();
  await page.getByRole('menuitemradio', {name: 'Brand logo'}).click();
  await expect.poll(async () => (await nodeOf(page, caption))?.pluginData?.['morfa.mp.role']).toBe('logo');
  await expect(page.getByRole('list', {name: 'Layer remarks'})).toContainText('logos');
  const shown = page.getByRole('group', {name: 'Show on'});
  await shown.getByRole('button', {name: 'WB'}).click();
  await expect(shown.getByRole('button', {name: 'WB'})).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('list', {name: 'Layer remarks'})).toHaveCount(0);
  // "Product" locks the layer and says so.
  await page.getByRole('button', {name: 'Role on the card'}).click();
  await page.getByRole('menuitemradio', {name: 'Product'}).click();
  await expect(page.getByText('The layer is locked so it is not moved by accident.')).toBeVisible();
  await expect.poll(async () => (await nodeOf(page, caption))?.locked).toBe(true);

  // Back to the card, and the card moved to Ozon: its name follows, the checks are Ozon's.
  await page.getByRole('button', {name: 'Card check'}).click();
  await expect.poll(() => selection(page)).toEqual([card]);
  await page.getByRole('radio', {name: /^Ozon:/}).click();
  await expect.poll(async () => (await nodeOf(page, card))?.name).toBe('Ozon · Main photo');
  await expect(page.getByRole('heading', {name: 'Ozon card', exact: true})).toBeVisible();
  await expect(page.getByRole('radio', {name: /^Ozon:/})).toHaveAttribute('aria-checked', 'true');
});

test('"Marketplaces" frames, a plain frame refitted and made a card, the badge zones\' switch', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  await waitEditorReady(page);
  await expect.poll(() => probe(page)).toBe(true);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + 30);

  // F: the frame sizes, with the marketplaces' cards among them.
  await page.keyboard.press('f');
  await expect(page.getByRole('list', {name: 'Marketplaces'})).toBeVisible();
  await page.getByRole('button', {name: 'Yandex Market, 900 by 1200'}).click();
  await expect(page.getByRole('heading', {name: 'YM card', exact: true})).toBeVisible();
  const [ym] = await selection(page);
  expect((await nodeOf(page, ym))?.name).toBe('YM · Main photo');

  // A square frame: refit to 900 × 1200, then make it a WB card.
  const square = await addLayer(page, '', {type: 'FRAME', name: 'Square', x: 2000, y: 0, width: 1080, height: 1080, fills: grey(1) as SceneNode['fills']});
  await select(page, 'Square');
  const section = page.locator('.dz-mp-make');
  await section.getByRole('radio', {name: 'WB'}).click();
  await expect(section).toContainText('not 3:4');
  await section.getByRole('button', {name: 'Fit to 900 × 1200'}).click();
  await expect.poll(async () => {
    const node = await nodeOf(page, square);
    return node && [node.width, node.height];
  }).toEqual([900, 1200]);
  await section.getByRole('button', {name: 'Make card'}).click();
  await expect(page.getByRole('heading', {name: 'WB card', exact: true})).toBeVisible();
  expect(JSON.parse((await nodeOf(page, square))!.pluginData!['morfa.mp.card']).marketplace).toBe('wb');

  // "View ▸ Marketplace badge zones" hides the zones.
  const zones = () => page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.getState().ui.cardZones);
  expect(await zones()).toBe(true);
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'View', exact: true}).hover();
  await page.getByRole('menuitemcheckbox', {name: /Marketplace badge zones/}).click();
  await expect.poll(zones).toBe(false);
});
