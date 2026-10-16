import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import sharp from 'sharp';
import {createDocument, createNode, defaultTextProps, solid} from '../../shared/design/defaults';
import {cardMeta, descendants, layerRole, withCardMeta, withLayerRole} from '../../shared/design/marketplace/meta';
import type {DesignDocument, ImageAsset, NodeId, NodeType, SceneNode} from '../../shared/design/types';

// "Generation" of a marketplace card (docs/marketplaces.md §Catalog Generation) in the real app: a studio photo is cut out into a locked
// "Product", a batch of variants and the WB cover pair land beside the card, and a brand kit is made in its dialog and applied. The saved
// file has it all.

type Saved = {file: {version: number}; document: DesignDocument};
type Probe = {getState(): {doc: DesignDocument; selection: NodeId[]}; setSelection(ids: NodeId[]): void};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
const origin = (page: Page) => new URL(page.url()).origin;
const saved = async (page: Page, id: string) => (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as Saved;
const live = (page: Page) => page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.getState().doc);

/** A studio shot: a red mug on an even light grey. */
const studioPhoto = async () => {
  const [width, height] = [600, 800];
  const data = Buffer.alloc(width * height * 3, 238);
  for (let y = 220; y < 640; y++) for (let x = 170; x < 430; x++) data.set(y < 240 ? [140, 20, 30] : [205, 35, 45], (y * width + x) * 3);
  return sharp(data, {raw: {width, height, channels: 3}}).png().toBuffer();
};

/** A WB card 900 × 1200: a white background, the photo, a headline. */
function cardDocument(photo: {ref: string; asset: ImageAsset}): DesignDocument {
  let doc = createDocument('page', 'Cards');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  doc = {...doc, images: {[photo.ref]: photo.asset}};
  add('FRAME', {id: 'card', parentId: 'page', name: 'Mug', x: 0, y: 0, width: 900, height: 1200, fills: [solid({r: 1, g: 1, b: 1})], pluginData: withCardMeta(undefined, {v: 1, marketplace: 'wb', slide: 'main'})});
  add('RECTANGLE', {id: 'photo', parentId: 'card', name: 'Mug photo', x: 150, y: 250, width: 600, height: 800,
    fills: [{type: 'IMAGE', imageRef: photo.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  add('TEXT', {id: 'title', parentId: 'card', name: 'Headline', x: 63, y: 150, width: 700, height: 70, fills: [solid({r: 0.1, g: 0.1, b: 0.1})], pluginData: withLayerRole(undefined, 'headline'),
    text: {...defaultTextProps('Thermo mug 450 ml'), style: {...defaultTextProps().style, fontSize: 56, fontWeight: 700}}});
  return doc;
}

test('cut out, variants, the WB covers and a brand kit from "Generation"', async ({page, seed: _seed}) => {
  test.setTimeout(180_000);
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  const uploaded = await page.request.post(`/api/design-files/${encodeURIComponent(id)}/images`, {headers: {Origin: origin(page)}, multipart: {file: {name: 'mug.png', mimeType: 'image/png', buffer: await studioPhoto()}}});
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const photo = (await uploaded.json()) as {ref: string; asset: ImageAsset};
  const opened = await saved(page, id);
  const written = await page.request.put(`/api/design-files/${encodeURIComponent(id)}/document`, {headers: {Origin: origin(page)}, data: {baseVersion: opened.file.version, document: cardDocument(photo)}});
  expect(written.ok(), await written.text()).toBeTruthy();
  await page.reload();
  await waitEditorReady(page, id);
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.setSelection(['card']));

  const panel = page.getByRole('tabpanel', {name: 'Design'});
  await panel.getByRole('tablist', {name: 'Card'}).getByRole('tab', {name: 'Generation'}).click();
  const product = panel.getByRole('region', {name: 'Product'});
  await expect(product.getByText('Works for studio photos')).toBeVisible();

  // "Remove background": the product is a locked layer over the hidden photo, its colours as shot.
  await product.getByRole('button', {name: 'Remove background'}).click();
  await expect(panel.getByRole('status').filter({hasText: 'Product cut out and locked.'})).toBeVisible({timeout: 30_000});
  await expect(product.getByText('Product colour as in the photo')).toBeVisible();
  let doc = await live(page);
  const cut = descendants(doc, 'card').find(node => layerRole(node) === 'product')!;
  expect([cut.name, cut.locked, doc.nodes.photo.visible]).toEqual(['Product', true, false]);
  expect(cut.x).toBeGreaterThan(150);
  expect(cut.width).toBeLessThan(600);

  // "Variants": three on the kit's colours, beside the card in one step.
  const variants = panel.getByRole('region', {name: 'Variants'});
  await variants.getByRole('spinbutton', {name: 'How many variants'}).fill('3');
  await variants.getByRole('spinbutton', {name: 'How many variants'}).press('Enter');
  await variants.getByRole('button', {name: /^Make 3 variants/}).click();
  await expect(panel.getByRole('status').filter({hasText: /^Done: 3 variants/})).toBeVisible({timeout: 60_000});
  doc = await live(page);
  const frames = (doc.nodes.page.children ?? []).map(child => doc.nodes[child]).filter(node => cardMeta(node)?.variant);
  expect(frames.map(frame => cardMeta(frame))).toEqual([1, 2, 3].map(variant => ({v: 1, marketplace: 'wb', slide: 'main', group: 'card', variant})));
  expect(frames.map(frame => frame.name)).toEqual(['Mug · variant 1', 'Mug · variant 2', 'Mug · variant 3']);
  expect(frames.every(frame => frame.x >= 900)).toBe(true);
  expect(cardMeta(doc.nodes.card)?.group).toBe('card');
  for (const frame of frames) {
    expect(descendants(doc, frame.id).filter(node => layerRole(node) === 'product' && node.visible)).toHaveLength(1);
    expect(descendants(doc, frame.id).some(node => layerRole(node) === 'badge')).toBe(true);
  }

  // "WB covers": the pair for new and returning buyers.
  await panel.getByRole('region', {name: 'WB covers'}).getByRole('button', {name: /^Pair of WB covers/}).click();
  await expect(panel.getByRole('status').filter({hasText: /The covers "New buyers" and "Returning buyers"/})).toBeVisible({timeout: 30_000});
  doc = await live(page);
  const covers = (doc.nodes.page.children ?? []).map(child => doc.nodes[child]).filter(node => cardMeta(node)?.audience);
  expect(covers.map(frame => [frame.name, cardMeta(frame)?.audience])).toEqual([['New buyers', 'new'], ['Returning buyers', 'returning']]);

  // "Brand kit": made in its dialog, then applied: the headline takes its colour.
  const brand = panel.getByRole('region', {name: 'Brand kit'});
  await brand.getByRole('button', {name: 'Create brand kit'}).click();
  const dialog = page.getByRole('dialog', {name: 'New brand kit'});
  await dialog.getByRole('textbox', {name: 'Brand kit name'}).fill('Warm home');
  await dialog.getByRole('textbox', {name: 'Text, HEX'}).fill('7a2e1f');
  await dialog.getByRole('textbox', {name: 'Text, HEX'}).press('Enter');
  await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog).toBeHidden();
  await expect(brand.getByRole('button', {name: 'Brand kit', exact: true})).toHaveText('Warm home');
  await brand.getByRole('button', {name: 'Apply to card'}).click();
  await expect(brand.getByText(/Brand kit "Warm home" applied/)).toBeVisible();
  doc = await live(page);
  const title = doc.nodes.title;
  expect(title.fills[0].type === 'SOLID' && Math.round(title.fills[0].color.r * 255)).toBe(0x7a);

  // Everything is in the saved file.
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible({timeout: 30_000});
  await expect.poll(async () => {
    const stored = (await saved(page, id)).document;
    return (stored.nodes.page.children ?? []).filter(child => cardMeta(stored.nodes[child])).length;
  }, {timeout: 30_000}).toBe(6);
});
