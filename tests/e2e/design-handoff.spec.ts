import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import {createDocument, createNode, defaultTextProps, solid} from '../../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';

// "Morfa Design" handoff, export, import and versions (docs/design-tool.md §Export, §Server API): "Copy as" from a
// layer row, a slice saved as SVG, six pictures dropped at once, a version previewed with its own pages and copied
// into a new file, and a title that stays "Saved" through quick saves. Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type Saved = {file: {name: string; version: number}; document: DesignDocument};
const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
const saved = async (page: Page, id: string) => (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as Saved;
const waitSaved = (page: Page) => expect(page.getByRole('status').filter({hasText: /^Saved/})).toBeVisible();

function cardAndSlice(): DesignDocument {
  let doc = createDocument('page', 'Export');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  add('FRAME', {id: 'card', parentId: 'page', name: 'Card', x: 0, y: 0, width: 200, height: 100, fills: [solid({r: 1, g: 1, b: 1})], cornerRadius: 12});
  add('TEXT', {id: 'hello', parentId: 'card', name: 'Hello', x: 16, y: 40, width: 168, height: 24, fills: [solid({r: 0.1, g: 0.1, b: 0.1})], text: {...defaultTextProps('Hello, world'), textAutoResize: 'NONE'}});
  add('SLICE', {id: 'slice', parentId: 'page', name: 'Slice', x: -10, y: -10, width: 120, height: 60, exportSettings: [{format: 'SVG', suffix: '', constraint: {type: 'SCALE', value: 1}}]});
  return doc;
}

async function fileWith(page: Page, doc?: DesignDocument) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  if (doc) {
    const opened = await saved(page, id);
    const written = await page.request.put(`/api/design-files/${encodeURIComponent(id)}/document`, {headers: {Origin: new URL(page.url()).origin}, data: {baseVersion: opened.file.version, document: doc}});
    expect(written.ok(), await written.text()).toBeTruthy();
    await page.reload();
  }
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible({timeout: 30_000});
  // The editor takes keys, and co-editing and the meeting have mounted (fixtures.ts `waitEditorReady`).
  await waitEditorReady(page);
  return {id, canvas};
}

test('a layer row copies as SVG and CSS; a slice saves as an SVG of what its page shows; SVG with layer ids', async ({page, context, seed: _seed}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fileWith(page, cardAndSlice());
  const row = page.locator('[data-row-id="card"]');
  await row.click();

  // The layers panel's row menu carries "Copy as", as the canvas menu does (Figma's row menu has it too).
  await row.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Copy as', exact: true}).hover();
  await page.getByRole('menuitem', {name: 'Copy as SVG', exact: true}).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^<svg width="200" height="100"[^>]*>.*Hello, world/s);
  await row.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Copy as', exact: true}).hover();
  await page.getByRole('menuitem', {name: 'Copy as CSS', exact: true}).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('border-radius: 12px;');

  // The slice's SVG: its own size, the card moved by the slice's offset, and nothing of the card's right half.
  await page.locator('[data-row-id="slice"]').click();
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const [download] = await Promise.all([page.waitForEvent('download'), design.getByRole('button', {name: 'Export Slice'}).click()]);
  expect(download.suggestedFilename()).toBe('Slice.svg');
  const svg = (await readFile((await download.path())!)).toString('utf8');
  expect(svg).toMatch(/^<svg width="120" height="60" viewBox="0 0 120 60"/);
  expect(svg).toContain('transform="translate(10 10)"');

  // SVG with "Add layer ids" (Figma's "Include "id" attribute"): each layer's name as its element's id.
  await page.locator('[data-row-id="card"]').click();
  await design.getByRole('button', {name: 'Add export setting'}).click();
  const format = design.getByRole('button', {name: 'Format'});
  await format.scrollIntoViewIfNeeded();
  await format.click();
  await page.getByRole('menuitemradio', {name: 'SVG', exact: true}).click();
  await format.click();
  await page.getByRole('menuitemcheckbox', {name: /Add layer ids/}).click();
  await expect(design.getByRole('button', {name: 'Format'})).toHaveText('SVG');
  const [named] = await Promise.all([page.waitForEvent('download'), design.getByRole('button', {name: 'Export Card'}).click()]);
  const withIds = (await readFile((await named.path())!)).toString('utf8');
  expect(withIds).toContain('id="Card"');
  expect(withIds).toContain('id="Hello"');
});

test('six pictures dropped together all land on the canvas, each with its stored picture', async ({page, seed: _seed}) => {
  const {id} = await fileWith(page);
  const colours = [[255, 0, 0], [0, 160, 0], [0, 0, 255], [250, 200, 0], [120, 0, 200], [0, 180, 180]] as const;
  const files = await Promise.all(colours.map(async ([r, g, b], i) => ({
    name: `Picture ${i + 1}.png`,
    data: (await sharp({create: {width: 40 + i * 10, height: 30, channels: 3, background: {r, g, b}}}).png().toBuffer()).toString('base64'),
  })));
  const area = page.locator('.dz-canvas-aids').locator('..');
  const box = (await area.boundingBox())!;
  await page.evaluate(({files, x, y}) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))], file.name, {type: 'image/png'}));
    const target = document.querySelector('.dz-canvas-aids')!.parentElement!;
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y}));
  }, {files, x: box.x + box.width / 2, y: box.y + box.height / 2});
  // The server takes three picture uploads per account at a time; the editor queues the rest instead of losing them.
  await expect.poll(async () => {
    const document = (await saved(page, id)).document;
    return Object.values(document.nodes).filter(node => node.fills.some(fill => fill.type === 'IMAGE' && fill.imageRef && document.images[fill.imageRef])).length;
  }, {timeout: 30_000}).toBe(6);
  await expect(page.getByText('Wait for the image upload to finish.')).toHaveCount(0);
});

test('a picture pasted from the clipboard (a screenshot, a copied image) lands on the canvas with its stored picture; one ⌘Z takes it away', async ({page, seed: _seed}) => {
  const {id} = await fileWith(page);
  const data = (await sharp({create: {width: 120, height: 80, channels: 3, background: {r: 65, g: 105, b: 225}}}).png().toBuffer()).toString('base64');
  const picturesIn = async () => {
    const document = (await saved(page, id)).document;
    return Object.values(document.nodes).filter(node => node.fills.some(fill => fill.type === 'IMAGE' && fill.imageRef && document.images[fill.imageRef])).length;
  };
  const before = await picturesIn();
  await page.locator('.dz-canvas-aids').locator('..').click({position: {x: 300, y: 300}});
  // What the browser hands the page on ⌘V with an image on the clipboard: a paste event whose data holds the file.
  await page.evaluate(data => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'image.png', {type: 'image/png'}));
    (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: transfer}));
  }, data);
  await expect.poll(picturesIn, {timeout: 30_000}).toBe(before + 1);
  await expect(page.getByText('Wait for the image upload to finish.')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(picturesIn, {timeout: 15_000}).toBe(before);
});

test('a previewed version lists its own pages; the version copies into a new file, is renamed, and its link opens it', async ({page, context, seed: _seed}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const {id, canvas} = await fileWith(page);
  // The version: one page with a rectangle.
  const box = (await canvas.boundingBox())!;
  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, {steps: 4});
  await page.mouse.up();
  await waitSaved(page);
  await page.keyboard.press('ControlOrMeta+Alt+s');
  const history = page.getByRole('complementary', {name: 'Version history'});
  await history.getByRole('textbox', {name: 'Version name'}).fill('One page');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Version "One page" saved')).toBeVisible();
  await history.getByRole('button', {name: 'Close version history', exact: true}).click();
  // Since then: the page is renamed and a second page added.
  const pages = page.getByRole('listbox', {name: 'Pages', exact: true});
  await pages.getByRole('option').first().dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Home');
  await page.keyboard.press('Enter');
  await page.getByRole('button', {name: 'Add page'}).click();
  await page.keyboard.press('Enter');
  await expect(pages.getByRole('option')).toHaveCount(2);
  await waitSaved(page);

  // The preview: "Pages" lists the version's one page under its old name, not the file's two.
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'File', exact: true}).hover();
  await page.getByRole('menuitem', {name: 'Version history', exact: true}).click();
  await history.getByText('One page', {exact: true}).click();
  await expect(page.getByText(/You are viewing the version "One page"/)).toBeVisible();
  const versionPages = page.getByRole('listbox', {name: 'Version pages'});
  await expect(versionPages.getByRole('option')).toHaveText(['Page 1']);
  await expect(versionPages.getByRole('option', {name: 'Page 1'})).toHaveAttribute('aria-selected', 'true');
  await expect(pages).toBeHidden();
  await expect(page.getByRole('tree', {name: 'Version layers'}).getByRole('treeitem')).toHaveText(['Rectangle 1']);

  // "Duplicate file" from the version's menu: a new file holding the version; the file itself keeps its two pages.
  await page.getByRole('button', {name: 'Back to current'}).click();
  await expect(pages.getByRole('option')).toHaveCount(2);
  await history.getByText('One page', {exact: true}).click({button: 'right'});
  const created = page.waitForResponse(response => /\/versions\/[^/]+\/duplicate$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('menuitem', {name: 'Duplicate file'}).click();
  const answer = await created;
  expect(answer.status()).toBe(201);
  const copy = (await answer.json()) as {file: {id: string; name: string}};
  await expect(page.getByText(`File "${copy.file.name}" created from the version`)).toBeVisible();
  const copied = await saved(page, copy.file.id);
  expect(copied.document.pages.map(pageId => copied.document.nodes[pageId].name)).toEqual(['Page 1']);
  expect(Object.values(copied.document.nodes).filter(node => node.type === 'RECTANGLE')).toHaveLength(1);
  expect((await saved(page, id)).document.pages).toHaveLength(2);

  // "Edit version info…" (Figma's "Edit version info") renames it in place.
  await history.getByText('One page', {exact: true}).click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Edit version info…'}).click();
  const edit = history.getByRole('form', {name: 'Edit version'});
  await expect(edit.getByRole('textbox', {name: 'Version name'})).toHaveValue('One page');
  await expect(edit.getByText(/^Saved today at \d{1,2}:\d{2}$/)).toBeVisible();
  await edit.getByRole('textbox', {name: 'Version name'}).fill('First page');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Version "First page" renamed')).toBeVisible();
  await expect(history.getByText('First page', {exact: true})).toBeVisible();
  await expect(history.getByText('One page', {exact: true})).toHaveCount(0);

  // "Copy link to version": the link opens the file with that version shown.
  await history.getByText('First page', {exact: true}).click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Copy link to version'}).click();
  await expect(page.getByText('Version link copied')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`#design/${encodeURIComponent(id)}\\?version=[0-9a-f-]{36}$`));
  const other = await context.newPage();
  await other.goto(link);
  await expect(other.getByText(/You are viewing the version "First page"/)).toBeVisible({timeout: 30_000});
  await expect(other.getByRole('listbox', {name: 'Version pages'}).getByRole('option')).toHaveText(['Page 1']);
  await other.close();
});

test('quick saves keep the title at "Saved"; a lost connection shows at once and saving resumes', async ({page, context, seed: _seed}) => {
  const {id, canvas} = await fileWith(page);
  const box = (await canvas.boundingBox())!;
  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, {steps: 4});
  await page.mouse.up();
  const rectangle = async () => Object.values((await saved(page, id)).document.nodes).find(node => node.type === 'RECTANGLE');
  await expect.poll(rectangle).toBeTruthy();
  const start = (await rectangle())!.x;
  // Every text the status takes from here on, with the time since the last key (a busy machine may make a save slow
  // enough to be said; it may never be said the moment an edit starts saving, as it was).
  await page.evaluate(() => {
    const status = document.querySelector('.dz-save-status')!;
    const seen: {text: string; afterKey: number}[] = [];
    let key = 0;
    window.addEventListener('keydown', () => {key = performance.now();}, true);
    (window as unknown as {__statusSeen: typeof seen}).__statusSeen = seen;
    new MutationObserver(() => seen.push({text: status.textContent ?? '', afterKey: performance.now() - key})).observe(status, {childList: true, characterData: true, subtree: true});
  });
  const seen = () => page.evaluate(() => (window as unknown as {__statusSeen: {text: string; afterKey: number}[]}).__statusSeen);
  // Three nudges, each saved: the title does not flicker to "Saving…" as each save starts.
  for (let i = 1; i <= 3; i++) {
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await rectangle())!.x).toBe(start + i);
  }
  expect((await seen()).filter(entry => entry.text === 'Saving…' && entry.afterKey < 1400)).toEqual([]);
  await expect(page.getByRole('status').filter({hasText: /^Saved/})).toBeVisible();
  // Offline: "Offline" at once, and the nudge made meanwhile is stored once the connection is back.
  await context.setOffline(true);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('status').filter({hasText: 'Offline'})).toBeVisible({timeout: 15_000});
  await context.setOffline(false);
  await expect.poll(async () => (await rectangle())!.x, {timeout: 40_000}).toBe(start + 4);
  await expect(page.getByRole('status').filter({hasText: /^Saved/})).toBeVisible();
});
