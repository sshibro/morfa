import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// Big files (docs/decisions/big-files.md, lane BF): with `?bigFiles=1` in the address the editor opens a file as its skeleton plus
// the first page, fetches a page when it is shown (GET /:id/pages/:pageId), searches the loaded pages and offers the rest, and
// shows the memory budget under the file name. The server's own switch (DESIGN_BIG_FILES) only widens the caps; the e2e server
// runs with it off, so a small three-page file stands in for a 100 MB one.

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

const rect = (id: string, parentId: string, name: string) => ({
  id, type: 'RECTANGLE', name, parentId, visible: true, locked: false, opacity: 1, blendMode: 'PASS_THROUGH', isMask: false,
  x: 40, y: 40, width: 200, height: 120, rotation: 0,
  fills: [{type: 'SOLID', color: {r: 0.2, g: 0.4, b: 1}, opacity: 1, visible: true, blendMode: 'NORMAL'}],
  strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', strokeCap: 'NONE', strokeJoin: 'MITER', strokeMiterLimit: 4, dashPattern: [], effects: [],
  constraints: {horizontal: 'MIN', vertical: 'MIN'}, layoutPositioning: 'AUTO', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', exportSettings: [], reactions: [],
});

test('a big file opens page by page, finds across loaded pages and shows its memory budget', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  const id = fileIdFrom(page);
  // Three pages with one rectangle each, written whole over the new file.
  const opened = (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as {file: {version: number}; document: {pages: string[]; nodes: Record<string, {children?: string[]}>}};
  const first = opened.document.pages[0];
  const document = {
    ...opened.document,
    pages: [first, 'p2', 'p3'],
    nodes: {
      ...opened.document.nodes,
      [first]: {...opened.document.nodes[first], children: ['r1']},
      r1: rect('r1', first, 'First page layer'),
      p2: {...opened.document.nodes[first], id: 'p2', name: 'Second', children: ['r2']},
      r2: rect('r2', 'p2', 'Second page layer'),
      p3: {...opened.document.nodes[first], id: 'p3', name: 'Third', children: ['r3']},
      r3: rect('r3', 'p3', 'Third page layer'),
    },
  };
  const put = await page.request.put('/api/design-files/' + encodeURIComponent(id) + '/document', {data: {baseVersion: opened.file.version, document}, headers: {origin: new URL(page.url()).origin}});
  expect(put.ok(), await put.text()).toBeTruthy();

  // Open with the switch: the skeleton and the first page come, the others wait.
  const requests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/design-files/')) requests.push(url.pathname + url.search);
  });
  // `pages=1`: pages on demand for this small file too (a file the fixed caps hold otherwise opens whole, BIG.md stage G).
  await page.goto('/?bigFiles=1&pages=1#design/' + encodeURIComponent(id));
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  const layers = page.getByRole('tree', {name: 'Layers'});
  await expect(layers.getByRole('treeitem', {name: /First page layer/})).toBeVisible();
  expect(requests.some(url => url.includes('?pages=skeleton')), requests.join('\n')).toBeTruthy();
  expect(requests.some(url => url.endsWith('/pages/' + encodeURIComponent(first))), requests.join('\n')).toBeTruthy();
  expect(requests.some(url => url.endsWith('/pages/p2'))).toBeFalsy();
  const meter = page.getByRole('meter', {name: /File memory/});
  await expect(meter).toBeVisible();
  await expect(meter).toHaveAttribute('aria-valuenow', /^\d+$/);

  // Showing the second page fetches it, then its layer is there.
  const pages = page.getByRole('listbox', {name: 'Pages'});
  await pages.getByRole('option', {name: 'Second'}).click();
  await expect(layers.getByRole('treeitem', {name: /Second page layer/})).toBeVisible();
  expect(requests.some(url => url.endsWith('/pages/p2')), requests.join('\n')).toBeTruthy();
  expect(requests.some(url => url.endsWith('/pages/p3'))).toBeFalsy();

  // Find: this page by default; "Search all pages" widens the scope and brings the third page.
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('textbox', {name: 'Find'}).first();
  await expect(find).toBeVisible();
  await find.fill('page');
  await expect(page.locator('#dz-find-status')).toHaveText(/of 1\b|Found: 1/);
  await page.getByRole('button', {name: 'Search all pages'}).click();
  await expect(page.locator('#dz-find-status')).toHaveText(/of 3\b|Found: 3/);
  expect(requests.some(url => url.endsWith('/pages/p3')), requests.join('\n')).toBeTruthy();
  await page.keyboard.press('Escape');

  // An edit on the loaded page saves as usual.
  await pages.getByRole('option', {name: 'Second'}).click();
  await layers.getByRole('treeitem', {name: /Second page layer/}).click();
  await page.keyboard.press('Delete');
  await expect(layers.getByRole('treeitem', {name: /Second page layer/})).toHaveCount(0);
  const stored = async () => ((await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as {document: {nodes: Record<string, unknown>}}).document.nodes;
  await expect.poll(async () => Object.hasOwn(await stored(), 'r2'), {timeout: 15_000}).toBe(false);
  const nodes = await stored();
  expect(nodes.r1).toBeDefined();
  expect(nodes.r3).toBeDefined();
});
