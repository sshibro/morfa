import {test, expect, fileChooser} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument} from '../../shared/design/types';

// Diagrams on a board as FigJam's help has them (help.figma.com "Create mindmaps in FigJam"; lane FJ): a mind map from the shapes
// tray, grown with ⌘↵ (a child) and ⇧⌘↵ (a sibling). Each check reads what the server saved.

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
async function saved(page: Page, id: string): Promise<DesignDocument> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as {document: DesignDocument}).document;
}
const texts = (doc: DesignDocument) => Object.values(doc.nodes).filter(node => node.type === 'TEXT' && !node.board).map(node => node.text?.characters ?? '').sort();

async function openNewBoard(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page.getByRole('dialog', {name: 'More: templates, stickers, stamps'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.bd-top-left').getByRole('status')).toHaveText('Saved');
  return fileIdFrom(page);
}

test('should place a mind map from the shapes tray and grow it with ⌘↵ and ⇧⌘↵', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  await page.getByRole('button', {name: 'Shapes and connectors'}).click();
  await page.getByRole('button', {name: 'Mind map'}).click();
  await expect.poll(async () => texts(await saved(page, id))).toEqual(['Concept', 'Idea', 'Thought', 'Topic or question']);
  // The topic is selected: ⌘↵ adds a child open for typing, ⇧⌘↵ a sibling of it.
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.type('Fourth');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await page.keyboard.type('Fifth');
  await page.keyboard.press('Escape');
  await expect.poll(async () => texts(await saved(page, id))).toEqual(['Concept', 'Fifth', 'Fourth', 'Idea', 'Thought', 'Topic or question']);
  const doc = await saved(page, id);
  const fifth = Object.values(doc.nodes).find(node => node.text?.characters === 'Fifth')!;
  const topic = Object.values(doc.nodes).find(node => node.text?.characters === 'Topic or question')!;
  const branch = Object.values(doc.nodes).find(node => node.board?.kind === 'connector' && 'node' in node.board.end && node.board.end.node === fifth.id);
  expect(branch?.board?.kind === 'connector' && 'node' in branch.board.start ? branch.board.start.node : null).toBe(topic.id);
});

test('should start a mind map from a text\'s toolbar and drop an empty node with its branch', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  await page.keyboard.press('KeyT');
  await page.mouse.click(canvas.x + canvas.width / 2 - 200, canvas.y + canvas.height / 2);
  await page.keyboard.type('Plan');
  await page.keyboard.press('Escape');
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'Start mind map'}).click();
  await page.keyboard.type('Step');
  await page.keyboard.press('Escape');
  await expect.poll(async () => texts(await saved(page, id))).toEqual(['Plan', 'Step']);
  // An empty node goes, and its branch with it.
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('Escape');
  await expect.poll(async () => {
    const doc = await saved(page, id);
    return {texts: texts(doc), connectors: Object.values(doc.nodes).filter(node => node.board?.kind === 'connector').length};
  }).toEqual({texts: ['Plan', 'Step'], connectors: 1});
});

test('should turn a pasted Mermaid flowchart into shapes and connectors', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  await page.evaluate(value => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, 'flowchart TD\n  A[Start] --> B{Has access?}\n  B -->|yes| C(Open file)\n  B -->|no| D[Request access]\n');
  await expect.poll(async () => {
    const doc = await saved(page, id);
    const nodes = Object.values(doc.nodes);
    return {
      shapes: nodes.filter(node => node.board?.kind === 'shape').map(node => node.board?.kind === 'shape' ? node.board.shape : '').sort(),
      connectors: nodes.filter(node => node.board?.kind === 'connector').length,
    };
  }).toEqual({shapes: ['diamond', 'rounded', 'square', 'square'], connectors: 3});
});

test('should drag a table out to its size, colour its cells and export it as CSV', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const from = {x: canvas.x + 300, y: canvas.y + 200};
  await page.keyboard.press('Shift+KeyT');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 160 * 4, from.y + 48 * 2, {steps: 8});
  await page.mouse.up();
  const shape = async () => {
    const doc = await saved(page, id);
    const table = Object.values(doc.nodes).find(node => node.board?.kind === 'table');
    const rows = (table?.children ?? []).map(row => doc.nodes[row]);
    return {rows: rows.length, columns: rows[0]?.children?.length ?? 0};
  };
  await expect.poll(shape).toEqual({rows: 2, columns: 4});
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'Cell color'}).click();
  await page.locator('.bd-palette-popover').getByRole('button').nth(3).click();
  await expect.poll(async () => {
    const doc = await saved(page, id);
    const cells = Object.values(doc.nodes).filter(node => node.board?.kind === 'part' && node.board.part === 'cell');
    return new Set(cells.map(cell => JSON.stringify(cell.fills[0]))).size;
  }).toBe(1);
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('combobox').fill('CSV');
  const download = page.waitForEvent('download');
  await page.getByRole('option', {name: /Export table as CSV/}).click();
  const file = await download;
  // Headless Chromium may name a download "download" (design-board.spec.ts notes it).
  expect(file.suggestedFilename()).toMatch(/(\.csv|^download)$/);
});

test('should fill a section from "Templates" on its toolbar, and open new boards without the sheet once that is turned off', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  await page.keyboard.press('Shift+KeyS');
  await page.mouse.move(canvas.x + 300, canvas.y + 200);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 700, canvas.y + 500, {steps: 8});
  await page.mouse.up();
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'Template in section'}).click();
  await page.getByRole('menuitem', {name: 'Retrospective'}).click();
  await expect.poll(async () => {
    const doc = await saved(page, id);
    const section = Object.values(doc.nodes).find(node => node.type === 'SECTION' && node.parentId === doc.pages[0]);
    const inSection = (nodeId: string): boolean => !!nodeId && (nodeId === section?.id || inSection(doc.nodes[nodeId]?.parentId ?? ''));
    return Object.values(doc.nodes).filter(node => node.board?.kind === 'sticky' && inSection(node.id)).length > 0;
  }).toBe(true);
  // "Show templates for new boards" off: the next new board opens bare.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('combobox').fill('templates for new');
  // The list filters as the query is typed: act on the row itself, not on whichever is first when Enter lands.
  await page.getByRole('option', {name: /Show templates for new boards/}).click();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page.locator('.bd-top-left').getByRole('status')).toHaveText('Saved');
  await expect(page.getByRole('dialog', {name: 'More: templates, stickers, stamps'})).toHaveCount(0);
});

test('should align several objects from "Align" on their toolbar', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2};
  await page.keyboard.press('KeyR');
  await page.mouse.click(centre.x - 200, centre.y - 60);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyR');
  await page.mouse.click(centre.x + 200, centre.y + 60);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+KeyA');
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'Align'}).click();
  await page.getByRole('menuitem', {name: 'Align top'}).click();
  await expect.poll(async () => {
    const doc = await saved(page, id);
    const shapes = Object.values(doc.nodes).filter(node => node.board?.kind === 'shape');
    return shapes.length === 2 && shapes[0].y === shapes[1].y;
  }).toBe(true);
});

test('should export the board as a JPG on the dotted canvas, and its stickies as CSV with who wrote them', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  await page.keyboard.press('KeyS');
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.keyboard.type('Idea, first');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('dialog', {name: 'Export board', exact: true});
  const read = async (download: import('@playwright/test').Download) => (await import('node:fs/promises')).readFile((await download.path())!);
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  await dialog.getByRole('radio', {name: 'JPG'}).click();
  await dialog.getByRole('radio', {name: 'Grid'}).click();
  const [jpg] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: 'Export'}).click()]);
  expect([...(await read(jpg)).subarray(0, 2)]).toEqual([0xff, 0xd8]);
  // The dialog closes after a save: the next one opens once it has gone (its leaving copy is not the new one).
  await expect(dialog).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  await dialog.getByRole('radio', {name: 'CSV'}).click();
  await expect(dialog.getByRole('radio', {name: 'Stickies'})).toBeChecked();
  const [csv] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: 'Export'}).click()]);
  const text = (await read(csv)).toString('utf8').replace(/^﻿/, '');
  expect(text.split('\r\n')[0]).toBe('Text,Author');
  expect(text).toContain('"Idea, first"');
});

test('should grow a mind map node from the + on its right', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  await page.getByRole('button', {name: 'Shapes and connectors'}).click();
  await page.getByRole('button', {name: 'Mind map'}).click();
  await expect.poll(async () => texts(await saved(page, id)).length).toBe(4);
  await page.keyboard.press('Escape');
  const doc = await saved(page, id);
  const node = (text: string) => Object.values(doc.nodes).find(entry => entry.text?.characters === text)!;
  const root = node('Topic or question'), idea = node('Idea');
  // The map was placed around the view's middle at 100 %: the topic starts 160 px left of it.
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2};
  const client = (x: number, y: number) => ({x: centre.x + x - (root.x + 160), y: centre.y + y - (root.y + root.height / 2)});
  const middle = client(idea.x + idea.width / 2, idea.y + idea.height / 2);
  const plus = client(idea.x + idea.width + 18, idea.y + idea.height / 2);
  await page.mouse.move(middle.x, middle.y, {steps: 4});
  await page.mouse.move(plus.x, plus.y, {steps: 6});
  await page.mouse.click(plus.x, plus.y);
  await page.keyboard.type('Deeper');
  await page.keyboard.press('Escape');
  await expect.poll(async () => {
    const next = await saved(page, id);
    const deeper = Object.values(next.nodes).find(entry => entry.text?.characters === 'Deeper');
    const branch = deeper && Object.values(next.nodes).find(entry => entry.board?.kind === 'connector' && 'node' in entry.board.end && entry.board.end.node === deeper.id);
    return branch?.board?.kind === 'connector' && 'node' in branch.board.start ? next.nodes[branch.board.start.node]?.text?.characters : null;
  }).toBe('Idea');
});

test('should print washi tape with a picture uploaded from the marker tray', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  await page.keyboard.press('KeyW');
  const tray = page.getByRole('group', {name: 'Marker'});
  // A 2 × 2 PNG, red and blue.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4zwAEIOI/kAAAG/ID/VxhF44AAAAASUVORK5CYII=', 'base64');
  const chooser = await fileChooser(page, () => tray.getByRole('button', {name: 'Tape from picture'}).click());
  await chooser.setFiles({name: 'tape.png', mimeType: 'image/png', buffer: png});
  await expect(tray.getByRole('button', {name: 'Tape from picture'})).toHaveAttribute('aria-pressed', 'true');
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  await page.mouse.move(canvas.x + 300, canvas.y + 300);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 600, canvas.y + 320, {steps: 6});
  await page.mouse.up();
  await expect.poll(async () => {
    const doc = await saved(page, id);
    const tape = Object.values(doc.nodes).find(node => node.board?.kind === 'stroke' && node.board.tool === 'washi');
    const body = tape && doc.nodes[tape.children?.[0] ?? ''];
    return body?.fills[0]?.type ?? null;
  }).toBe('IMAGE');
});

test('should join a sticky dragged onto a mind map node', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  await page.getByRole('button', {name: 'Shapes and connectors'}).click();
  await page.getByRole('button', {name: 'Mind map'}).click();
  await expect.poll(async () => texts(await saved(page, id)).length).toBe(4);
  await page.keyboard.press('Escape');
  const doc = await saved(page, id);
  const node = (text: string) => Object.values(doc.nodes).find(entry => entry.text?.characters === text)!;
  const root = node('Topic or question'), idea = node('Idea');
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2};
  const client = (x: number, y: number) => ({x: centre.x + x - (root.x + 160), y: centre.y + y - (root.y + root.height / 2)});
  await page.keyboard.press('KeyS');
  await page.mouse.click(canvas.x + 200, canvas.y + canvas.height - 260);
  await page.keyboard.type('Another');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const target = client(idea.x + idea.width / 2, idea.y + idea.height / 2);
  await page.mouse.move(canvas.x + 200, canvas.y + canvas.height - 260);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, {steps: 12});
  await page.mouse.up();
  await expect.poll(async () => {
    const next = await saved(page, id);
    const sticky = Object.values(next.nodes).find(entry => entry.board?.kind === 'sticky');
    return Object.values(next.nodes).some(entry => entry.board?.kind === 'connector' && 'node' in entry.board.end && entry.board.end.node === sticky?.id && 'node' in entry.board.start && entry.board.start.node === idea.id);
  }).toBe(true);
});

test('should reshape a connector from its path handle, slide its label along it and put an end anywhere with ⌘', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const y = canvas.y + canvas.height / 2, left = canvas.x + 300, right = canvas.x + 700;
  await page.keyboard.press('KeyR');
  await page.mouse.click(right + 100, y);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // A straight connector from a free point to the shape's left side.
  await page.keyboard.press('KeyL');
  await page.mouse.move(left, y);
  await page.mouse.down();
  await page.mouse.move(right, y, {steps: 8});
  await page.mouse.up();
  await page.keyboard.press('KeyV');
  const connector = async () => {
    const doc = await saved(page, id);
    return Object.values(doc.nodes).find(node => node.board?.kind === 'connector');
  };
  await expect.poll(async () => !!(await connector())).toBe(true);
  // Selected after drawing: drag its middle down — a waypoint.
  const middle = {x: (left + right) / 2, y};
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x, middle.y + 120, {steps: 6});
  await page.mouse.up();
  await expect.poll(async () => {
    const board = (await connector())?.board;
    return board?.kind === 'connector' ? board.points?.length ?? 0 : -1;
  }).toBe(1);
  // ⌘-drag the free start onto the shape: it stays where it was dropped.
  await page.mouse.move(left, y);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.down();
  await page.mouse.move(right + 130, y + 40, {steps: 8});
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');
  await expect.poll(async () => {
    const board = (await connector())?.board;
    return board?.kind === 'connector' && 'at' in board.start;
  }).toBe(true);
});

test('should slide a connector\'s label along its path', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const y = canvas.y + canvas.height / 2, left = canvas.x + 300, right = canvas.x + 700;
  await page.keyboard.press('KeyL');
  await page.mouse.move(left, y);
  await page.mouse.down();
  await page.mouse.move(right, y, {steps: 8});
  await page.mouse.up();
  await page.keyboard.press('KeyV');
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'More'}).click();
  await page.getByRole('menuitem', {name: 'Label'}).click();
  await page.keyboard.type('yes');
  await page.keyboard.press('Escape');
  const labelAt = async () => {
    const doc = await saved(page, id);
    const board = Object.values(doc.nodes).find(node => node.board?.kind === 'connector')?.board;
    return board?.kind === 'connector' ? board.labelAt ?? 0.5 : null;
  };
  await expect.poll(labelAt).toBe(0.5);
  const middle = (left + right) / 2;
  await page.mouse.move(middle, y);
  await page.mouse.down();
  await page.mouse.move(left + 100, y + 10, {steps: 8});
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await labelAt())! - 0.25) < 0.05).toBe(true);
});

test('should merge a table cell with the next one from the toolbar while typing in it', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const at = {x: canvas.x + 300, y: canvas.y + 200};
  await page.keyboard.press('Shift+KeyT');
  await page.mouse.click(at.x, at.y);
  // The second row's first cell (160 × 48 cells from the click).
  await page.mouse.dblclick(at.x + 80, at.y + 48 + 24);
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'Merge with the cell to the right'}).click();
  await expect.poll(async () => {
    const doc = await saved(page, id);
    return Object.values(doc.nodes).some(node => node.board?.kind === 'part' && node.board.part === 'cell' && node.board.colSpan === 2);
  }).toBe(true);
});

test('should place one of FigJam\'s other flowchart figures from "More shapes" in the shapes tray', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  await page.getByRole('button', {name: 'Shapes and connectors'}).click();
  await page.getByRole('button', {name: 'More shapes'}).click();
  await page.getByRole('button', {name: 'Folder'}).click();
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await expect.poll(async () => {
    const doc = await saved(page, id);
    return Object.values(doc.nodes).find(node => node.board?.kind === 'shape')?.board;
  }).toEqual({kind: 'shape', shape: 'folder'});
});

test('should hide what a section holds from its toolbar, and lock only its background from "More"', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2};
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.type('Secret');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+KeyS');
  await page.mouse.move(centre.x - 250, centre.y - 220);
  await page.mouse.down();
  await page.mouse.move(centre.x + 250, centre.y + 220, {steps: 8});
  await page.mouse.up();
  const context = page.getByRole('toolbar', {name: 'Selection properties'});
  await context.getByRole('button', {name: 'Hide contents'}).click();
  const flags = async () => {
    const doc = await saved(page, id);
    return Object.values(doc.nodes).find(node => node.type === 'SECTION' && node.parentId === doc.pages[0])?.board ?? null;
  };
  await expect.poll(flags).toEqual({kind: 'section', hidden: true});
  // The sticky takes no click now: one where it was selects the section.
  await page.keyboard.press('Escape');
  await page.mouse.click(centre.x, centre.y);
  await expect(context.getByRole('button', {name: 'Show contents'})).toBeVisible();
  await context.getByRole('button', {name: 'Show contents'}).click();
  await context.getByRole('button', {name: 'More'}).click();
  await page.getByRole('menuitemcheckbox', {name: 'Lock background only'}).click();
  await expect.poll(flags).toEqual({kind: 'section', backgroundLocked: true});
});

test('should turn a pasted link into a card from the file\'s link preview', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  // The real route refuses pages on loopback; the test answers it as lane D's route would for a public page.
  await page.route('**/api/design-files/*/link-preview?*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({url: 'https://example.com/plan', title: 'Quarterly plan', description: 'What we do and when', image: null, imageAsset: null, site: 'Example'}),
  }));
  await page.evaluate(value => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, 'https://example.com/plan');
  await expect.poll(async () => {
    const doc = await saved(page, id);
    const card = Object.values(doc.nodes).find(node => node.type === 'GROUP' && node.name.startsWith('Link'));
    return card ? (card.children ?? []).map(child => doc.nodes[child]?.text?.characters).filter(Boolean) : null;
  }).toEqual(['Quarterly plan', 'What we do and when', 'Example']);
});

test('should paste a link as a sticky when its page gives no preview', async ({page, seed: _seed}) => {
  const id = await openNewBoard(page);
  await page.route('**/api/design-files/*/link-preview?*', route => route.fulfill({status: 422, contentType: 'application/json', body: JSON.stringify({code: 'link_preview_unavailable', reason: 'not_html'})}));
  await page.evaluate(value => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, 'https://example.com/file.zip');
  await expect.poll(async () => {
    const doc = await saved(page, id);
    const sticky = Object.values(doc.nodes).find(node => node.board?.kind === 'sticky');
    return sticky ? (sticky.children ?? []).map(child => doc.nodes[child]?.text?.characters)[0] : null;
  }).toBe('https://example.com/file.zip');
});
