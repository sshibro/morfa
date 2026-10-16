import {readFile} from 'node:fs/promises';
import type {Download, Page} from '@playwright/test';
import {unzipSync} from 'fflate';
import sharp from 'sharp';
import {test, expect, waitEditorReady} from './fixtures';
import {createDocument, createNode, defaultTextProps, defaultTextStyle, solid} from '../../shared/design/defaults';
import {MP_CARD_KEY, MP_ROLE_KEY} from '../../shared/design/marketplace/meta';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';

// Card Canvas, part 2 (docs/marketplaces.md §One master, three exports, §Slide kits, §Russian text proofing): one 1:1 Ozon master card
// written through the API, exported from "Export" as one zip with a picture per marketplace — WB's without the brand's watermark and
// re-boxed to 3:4, Ozon's with it and kept square, the sizes listed —; its quality saved in one undo step; the five missing slides added
// to the right in one undo step; the whole set exported numbered by slide; and the free spelling check answering for the file's texts.

const hex = (value: string) => {
  const n = parseInt(value.slice(1), 16);
  return {r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255};
};

/** "Sneakers": an Ozon fresh 1:1 card with a headline, the product and a red brand watermark in the top-left corner. */
function masterCard(): DesignDocument {
  let doc = createDocument('page', 'Cards');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  add('FRAME', {id: 'card', parentId: 'page', name: 'Sneakers', x: 0, y: 0, width: 1200, height: 1200, fills: [solid(hex('#FFFFFF'))],
    pluginData: {[MP_CARD_KEY]: JSON.stringify({v: 1, marketplace: 'ozon', slide: 'main'})}});
  add('RECTANGLE', {id: 'product', parentId: 'card', name: 'Product photo', x: 300, y: 360, width: 600, height: 600, fills: [solid(hex('#D8D6D0'))],
    constraints: {horizontal: 'CENTER', vertical: 'CENTER'}, pluginData: {[MP_ROLE_KEY]: 'product'}});
  add('RECTANGLE', {id: 'mark', parentId: 'card', name: 'Watermark', x: 40, y: 40, width: 160, height: 160, fills: [solid(hex('#E53935'))],
    pluginData: {[MP_ROLE_KEY]: 'watermark'}});
  add('TEXT', {id: 'headline', parentId: 'card', name: 'Headline', x: 240, y: 80, width: 900, height: 80, fills: [solid(hex('#171717'))],
    pluginData: {[MP_ROLE_KEY]: 'headline'},
    text: {...defaultTextProps('Running shoes'), style: {...defaultTextStyle(), fontFamily: 'Inter', fontSize: 64, fontWeight: 700}, textAutoResize: 'NONE'}});
  return doc;
}

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

type Probe = {getState(): {doc: DesignDocument; history: {undo: string | null}}; undo(): boolean; redo(): boolean};
const editor = <T,>(page: Page, read: (store: Probe) => T) =>
  page.evaluate(`(${read.toString()})(window.__morfaDesignTest.store)`) as Promise<T>;
/** The card frames of the page: name, meta and box. */
const cards = (page: Page) =>
  editor(page, store => Object.values(store.getState().doc.nodes)
    .filter(node => node.pluginData?.['morfa.mp.card'])
    .map(node => ({id: node.id, name: node.name, x: node.x, y: node.y, width: node.width, height: node.height, meta: JSON.parse(node.pluginData!['morfa.mp.card'])}))
    .sort((a, b) => a.x - b.x));

/** The zip the click downloads, unpacked: path → bytes. */
async function zipOf(page: Page, click: () => Promise<void>): Promise<{name: string; files: Record<string, Uint8Array>}> {
  const download: Promise<Download> = page.waitForEvent('download', {timeout: 90_000});
  await click();
  const file = await download;
  return {name: file.suggestedFilename(), files: unzipSync(new Uint8Array(await readFile((await file.path())!)))};
}
/** Width, height and the colour at (x, y) of a JPEG. */
async function picture(bytes: Uint8Array, x: number, y: number) {
  const image = sharp(Buffer.from(bytes));
  const {width, height, format} = await image.metadata();
  const {data, info} = await image.removeAlpha().raw().toBuffer({resolveWithObject: true});
  const at = (y * info.width + x) * info.channels;
  return {format, width, height, pixel: [data[at], data[at + 1], data[at + 2]]};
}
const reddish = ([r, g, b]: number[]) => r > 180 && g < 110 && b < 110;

test('one master card exports for WB, Ozon and YM in one zip, grows into a six-slide set and exports it numbered', async ({page, seed: _seed}) => {
  test.setTimeout(180_000);
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  const origin = new URL(page.url()).origin;
  const opened = await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json();
  const written = await page.request.put(`/api/design-files/${encodeURIComponent(id)}/document`, {
    headers: {Origin: origin},
    data: {baseVersion: opened.file.version, document: masterCard()},
  });
  expect(written.ok(), await written.text()).toBeTruthy();

  // Spelling is free and answers for the texts of a file the account can open: a misspelled word with a suggestion, Latin left alone.
  // Cyrillic on purpose: the server checks Russian spelling (Hunspell ru_RU); the headline has a misspelled "sneakers" (Кросовки, correct: Кроссовки).
  const proof = await page.request.post('/api/marketplace/proof', {
    headers: {Origin: origin},
    data: {fileId: id, texts: [{id: 'headline', text: 'Кросовки для бега'}, {id: 'note', text: 'Подошва EVA, размеры 36–45'}]},
  });
  expect(proof.ok(), await proof.text()).toBeTruthy();
  const {issues} = await proof.json();
  expect(Object.keys(issues)).toEqual(['headline']);
  expect(issues.headline[0].word).toBe('Кросовки');
  expect(issues.headline[0].suggestions).toContain('Кроссовки');

  await page.reload();
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible({timeout: 30_000});
  await waitEditorReady(page);
  await page.locator('[data-row-id="card"]').click();
  await expect(page.getByText('Ozon card', {exact: true})).toBeVisible();
  await page.getByRole('tab', {name: 'Export', exact: true}).click();
  const panel = page.getByRole('tabpanel', {name: 'Export', exact: true});
  await expect(panel.getByRole('checkbox', {name: 'WB'})).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('checkbox', {name: 'Ozon'})).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('checkbox', {name: 'YM'})).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('button', {name: 'Whole set', exact: true})).toBeDisabled();

  // The quality is the card's: saved into its meta in one undo step.
  const quality = panel.getByRole('spinbutton', {name: 'Quality, %'});
  await quality.fill('80');
  await quality.press('Enter');
  await expect.poll(async () => (await cards(page))[0]?.meta.export).toEqual({format: 'jpg', quality: 80, scale: 1});
  expect(await editor(page, store => store.getState().history.undo)).toBe('Card export settings');

  // One zip, a picture per marketplace: WB drops the brand's watermark and takes 3:4; Ozon keeps both; YM keeps the watermark, 3:4.
  const single = await zipOf(page, () => panel.getByRole('button', {name: 'Export', exact: true}).click());
  expect(single.name).toMatch(/^(Sneakers\.zip|download)$/);
  expect(Object.keys(single.files).sort()).toEqual(['Sneakers/Ozon.jpg', 'Sneakers/WB.jpg', 'Sneakers/YM.jpg']);
  const wb = await picture(single.files['Sneakers/WB.jpg'], 100, 100);
  const ozon = await picture(single.files['Sneakers/Ozon.jpg'], 100, 100);
  const ym = await picture(single.files['Sneakers/YM.jpg'], 100, 100);
  expect([wb.format, wb.width, wb.height]).toEqual(['jpeg', 1200, 1600]);
  expect([ozon.format, ozon.width, ozon.height]).toEqual(['jpeg', 1200, 1200]);
  expect([ym.width, ym.height]).toEqual([1200, 1600]);
  expect(reddish(wb.pixel), `WB: no watermark (${wb.pixel})`).toBe(false);
  expect(reddish(ozon.pixel), `Ozon: the watermark (${ozon.pixel})`).toBe(true);
  expect(reddish(ym.pixel), `YM: the watermark (${ym.pixel})`).toBe(true);
  // The master itself is untouched.
  expect((await cards(page))[0]).toMatchObject({width: 1200, height: 1200});
  const listed = panel.getByRole('list', {name: 'Files'}).getByRole('listitem');
  await expect(listed).toHaveCount(3);
  await expect(listed.first()).toContainText(/\d+(\.\d+)? (KB|MB)/);

  // The set: five slides added to the right of the master in one undo step, each a card of the same group.
  const kit = panel.getByRole('list', {name: 'Slides of the set'});
  await expect(kit.getByLabel('In the set')).toHaveCount(1);
  await panel.getByRole('button', {name: 'Add the missing ones · 5'}).click();
  await expect(kit.getByLabel('In the set')).toHaveCount(6);
  let set = await cards(page);
  expect(set.map(card => card.meta.slide)).toEqual(['main', 'benefits', 'specs', 'howto', 'proof', 'lifestyle']);
  expect(new Set(set.map(card => card.meta.group))).toEqual(new Set(['card']));
  expect(set.slice(1).every(card => card.meta.marketplace === 'ozon' && card.x >= 1200 && card.y === 0 && card.width === 900 && card.height === 1200)).toBe(true);
  expect(await editor(page, store => store.getState().history.undo)).toBe('Add slides');
  await editor(page, store => store.undo());
  expect((await cards(page)).length).toBe(1);
  await editor(page, store => store.redo());
  set = await cards(page);
  expect(set.length).toBe(6);

  // The whole set for WB only: one folder, the slides numbered in swiping order.
  await page.locator('[data-row-id="card"]').click();
  await page.getByRole('tab', {name: 'Export', exact: true}).click();
  await panel.getByRole('checkbox', {name: 'Ozon'}).click();
  await panel.getByRole('checkbox', {name: 'YM'}).click();
  const whole = await zipOf(page, () => panel.getByRole('button', {name: 'Whole set · 6'}).click());
  expect(Object.keys(whole.files)).toEqual([
    'Sneakers/01 Main photo.jpg',
    'Sneakers/02 Benefits.jpg',
    'Sneakers/03 Specs and sizes.jpg',
    'Sneakers/04 How to use.jpg',
    'Sneakers/05 Reviews and trust.jpg',
    'Sneakers/06 In real life.jpg',
  ]);
  for (const [path, bytes] of Object.entries(whole.files)) {
    const shot = await picture(bytes, 0, 0);
    expect([shot.format, shot.width, shot.height], path).toEqual(['jpeg', path.includes('01 ') ? 1200 : 900, path.includes('01 ') ? 1600 : 1200]);
  }
  await expect(panel.getByRole('list', {name: 'Files'}).getByRole('listitem')).toHaveCount(6);
});
