import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import {createDocument, createNode, defaultTextProps, solid} from '../../shared/design/defaults';
import {cardMeta, withCardMeta, withLayerRole} from '../../shared/design/marketplace/meta';
import {catalogPageName, decodeCp1251} from '../../shared/design/marketplace/catalog';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';

// "Catalog from a table" (docs/marketplaces.md §Catalog run): a seller's CSV — Russian Excel's, semicolons in Windows-1251 (so its rows stay Cyrillic: deliberate test data) — over a
// simple WB card makes one card per row on a new page, each with its row's texts, its SKU in the card's meta and the template's
// styles; the saved file has them all.

type Saved = {file: {version: number}; document: DesignDocument};
type Probe = {getState(): {doc: DesignDocument; pageId: NodeId}; setSelection(ids: NodeId[]): void};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
const saved = async (page: Page, id: string) => (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as Saved;

/** A 900 × 1200 WB card: a bold headline "Title", a price with a {{Price}} placeholder and a benefit. */
function cardDocument(): DesignDocument {
  let doc = createDocument('page', 'Templates');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  const ink = [solid({r: 0.1, g: 0.1, b: 0.1})];
  add('FRAME', {id: 'card', parentId: 'page', name: 'Card', x: 0, y: 0, width: 900, height: 1200, fills: [solid({r: 1, g: 1, b: 1})],
    pluginData: withCardMeta(undefined, {v: 1, marketplace: 'wb', slide: 'main'})});
  add('TEXT', {id: 'title', parentId: 'card', name: 'Title', x: 60, y: 60, width: 220, height: 58, fills: ink, pluginData: withLayerRole(undefined, 'headline'),
    text: {...defaultTextProps('Title'), style: {...defaultTextProps().style, fontSize: 48, fontWeight: 700}}});
  add('TEXT', {id: 'price', parentId: 'card', name: 'Price', x: 60, y: 160, width: 100, height: 19, fills: ink, text: defaultTextProps('{{Price}} ₽')});
  add('TEXT', {id: 'benefit', parentId: 'card', name: 'Benefit', x: 60, y: 220, width: 100, height: 19, fills: ink, pluginData: withLayerRole(undefined, 'benefit'),
    text: defaultTextProps('Item')});
  return doc;
}

// Russian product data on purpose: the table is saved in Windows-1251, as Russian Excel does.
const ROWS = [
  ['WB-001', 'Крем для рук', '490', 'Увлажняет'],
  ['WB-002', 'Мыло «Ёлка»', '190', 'Без запаха'],
  ['WB-003', 'Шампунь', '650', 'Для всех типов волос'],
  ['WB-004', 'Бальзам', '720', 'Блеск'],
  ['WB-005', 'Маска для лица', '1 290', 'Питает'],
];

/** The table as Russian Excel saves "CSV (semicolon delimited)": Windows-1251. */
function excelCsv(): Buffer {
  const text = ['Article;Title;Price;Benefit', ...ROWS.map(row => row.join(';'))].join('\r\n') + '\r\n';
  const table = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) table.set(decodeCp1251(Uint8Array.of(byte)), byte);
  return Buffer.from([...text].map(char => table.get(char)!));
}

test('a 5-row CSV over a simple card makes 5 cards with their rows\' texts on a new page', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  const opened = await saved(page, id);
  const written = await page.request.put(`/api/design-files/${encodeURIComponent(id)}/document`, {headers: {Origin: new URL(page.url()).origin}, data: {baseVersion: opened.file.version, document: cardDocument()}});
  expect(written.ok(), await written.text()).toBeTruthy();
  await page.reload();
  await waitEditorReady(page, id);
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.setSelection(['card']));

  const panel = page.getByRole('tabpanel', {name: 'Design'});
  await panel.getByRole('tablist', {name: 'Card'}).getByRole('tab', {name: 'Generation'}).click();
  await panel.getByRole('button', {name: 'Catalog from a table'}).click();

  const dialog = page.getByRole('dialog', {name: 'Catalog from a table'});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Table with products').setInputFiles({name: 'products.csv', mimeType: 'text/csv', buffer: excelCsv()});
  await expect(dialog.getByText('5 rows · 4 columns · Windows-1251')).toBeVisible();
  await expect(dialog.getByRole('region', {name: 'First rows of the table'}).getByRole('cell', {name: ROWS[1][1]})).toBeVisible();
  await dialog.getByRole('button', {name: 'Next'}).click();

  // Matched automatically: the SKU, the headline by its sample text, the price by its placeholder, the benefit by its role.
  await expect(dialog.getByRole('button', {name: 'Article number column'})).toHaveText('Article');
  await expect(dialog.getByRole('button', {name: 'Texts: Title'})).toHaveText('Title');
  await expect(dialog.getByRole('button', {name: 'Texts: Price'})).toHaveText('Fill into {{…}}');
  await expect(dialog.getByRole('button', {name: 'Texts: Benefit'})).toHaveText('Benefit');
  await expect(dialog.getByText('490 ₽')).toBeVisible();
  await dialog.getByRole('button', {name: 'Create 5 cards'}).click();

  await expect(dialog.getByText('Done: 5 cards')).toBeVisible({timeout: 30_000});
  await dialog.getByRole('button', {name: 'Go to the catalog'}).click();
  await expect(dialog).toBeHidden();

  // The page is named by the browser's date (Moscow here), which may already be tomorrow for this process.
  const [year, month, day] = await page.evaluate(() => [new Date().getFullYear(), new Date().getMonth(), new Date().getDate()]);
  const pageName = catalogPageName(new Date(year, month, day), ['Templates']);
  const check = (doc: DesignDocument) => {
    const catalog = doc.pages.map(pageId => doc.nodes[pageId]).find(node => node?.name === pageName);
    expect(catalog, `a page "${pageName}"`).toBeTruthy();
    const cards = (catalog!.children ?? []).map(cardId => doc.nodes[cardId]);
    expect(cards).toHaveLength(5);
    cards.forEach((card, index) => {
      const [sku, title, price, benefit] = ROWS[index];
      expect(cardMeta(card)).toEqual({v: 1, marketplace: 'wb', slide: 'main', sku, group: 'card'});
      expect(card.name).toBe(sku);
      const texts = (card.children ?? []).map(child => doc.nodes[child]);
      const byName = (name: string) => texts.find(node => node.name === name)!;
      expect(byName('Title').text!.characters).toBe(title);
      expect(byName('Title').text!.style.fontWeight).toBe(700);
      expect(byName('Price').text!.characters).toBe(`${price} ₽`);
      expect(byName('Benefit').text!.characters).toBe(benefit);
    });
    // The template is as it was.
    expect(doc.nodes.title.text!.characters).toBe('Title');
  };
  const live = await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.getState());
  check(live.doc);
  expect(live.doc.nodes[live.pageId].name).toBe(pageName);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await expect.poll(async () => (await saved(page, id)).document.pages.length).toBe(2);
  check((await saved(page, id)).document);
});
