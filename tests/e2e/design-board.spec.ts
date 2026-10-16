import {test, expect} from './fixtures';
import type {Browser, BrowserContext, Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';
import {decodePng} from '../../src/design/panels/design/layout/export/png';

// "Board" (docs/board.md): the FigJam alternative as a person coming from FigJam uses it. A board is made from the file browser and
// opens in its own editor; stickies, shapes, connectors that follow their objects, the marker and its eraser, templates from "+",
// comments and export. Every check reads what the server saved (autosave) or the editor's store (the dev server's test hook).
// Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type Saved = {file: {name: string; version: number; kind?: string}; document: DesignDocument};
type Pt = {x: number; y: number};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const objects = (file: Saved, kind: string) => Object.values(file.document.nodes).filter(node => node.board?.kind === kind);
const textOf = (file: Saved, object: SceneNode) =>
  (object.children ?? []).map(id => file.document.nodes[id]).find(node => node?.board?.kind === 'part' && node.board.part === 'text')?.text?.characters ?? null;
const storeState = (page: Page) => page.evaluate(() => {
  const state = (window as unknown as {__morfaDesignTest: {store: {getState(): {tool: string; selection: string[]; editing: {id: string} | null; viewport: {zoom: number}}}}}).__morfaDesignTest.store.getState();
  return {tool: state.tool, selection: state.selection, editing: state.editing?.id ?? null};
});

/** A new board: its template sheet is closed, the page origin is at the canvas's centre at 100 %. */
async function openNewBoard(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  // A new, empty board offers its templates first (FigJam); Escape puts the sheet away.
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  const box = (await canvas.boundingBox())!;
  const centre = {x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2)};
  const at = (x: number, y: number): Pt => ({x: centre.x + x, y: centre.y + y});
  return {id: fileIdFrom(page), at};
}

async function drag(page: Page, from: Pt, to: Pt, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, {steps});
  await page.mouse.up();
}

test('a new board is a file of its own kind: its own editor and card, counted among the files', async ({page, seed: _seed}) => {
  const {id} = await openNewBoard(page);
  await expect(page.getByRole('toolbar', {name: 'Board tools'})).toBeVisible();
  // No design panels: the board is its own frame.
  await expect(page.getByRole('tab', {name: 'Design', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Share'})).toBeVisible();
  const file = await saved(page, id);
  expect(file.file.kind).toBe('board');
  expect(file.document.board).toBe(true);
  expect(file.file.name).toBe('Untitled board');
  await expect(page).toHaveTitle('Untitled board — Board');

  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Back to files', exact: true}).click();
  await expect(page).toHaveURL(/#designs$/);
  const card = page.locator('.dz-file').filter({hasText: 'Untitled board'});
  await expect(card.locator('.dz-file-kind')).toHaveText('Board');
  const list = await (await page.request.get('/api/design-files')).json() as {files: {kind?: string}[]; usage: {files: number}};
  expect(list.files.map(entry => entry.kind)).toEqual(['board']);
  expect(list.usage.files, 'a board counts as a file').toBe(1);
});

test('stickies: S places one open for typing, Escape selects the note, ⌘↵ makes the next one beside it', async ({page, seed: _seed}) => {
  const {id, at} = await openNewBoard(page);
  await page.keyboard.press('KeyS');
  expect((await storeState(page)).tool).toBe('board-sticky');
  await page.mouse.click(at(-200, 0).x, at(-200, 0).y);
  await page.keyboard.type('First idea');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.type('Second');
  await page.keyboard.press('Escape');
  await expect.poll(async () => objects(await saved(page, id), 'sticky').length).toBe(2);
  const file = await saved(page, id);
  const [first, second] = objects(file, 'sticky').sort((a, b) => a.x - b.x);
  expect(textOf(file, first)).toBe('First idea');
  expect(textOf(file, second)).toBe('Second');
  expect(second.x).toBeGreaterThanOrEqual(first.x + first.width);
  expect(Math.abs(second.y - first.y)).toBeLessThan(1);
  // The note is selected, never the text inside it; the context toolbar offers the note's colour.
  await expect.poll(async () => (await storeState(page)).selection).toEqual([second.id]);
  await expect(page.getByRole('toolbar', {name: 'Selection properties'}).getByRole('button', {name: 'Sticky color'})).toBeVisible();

  // FigJam's single keys: S is a sticky here (never "Slice"), F (frame) does nothing on a board, V is back to moving.
  await page.keyboard.press('KeyF');
  expect((await storeState(page)).tool).toBe('move');
  await page.keyboard.press('KeyS');
  expect((await storeState(page)).tool).toBe('board-sticky');
  await page.keyboard.press('KeyV');
  expect((await storeState(page)).tool).toBe('move');

  // Recolour from the context toolbar: one undo step.
  await page.getByRole('button', {name: 'Sticky color'}).click();
  await page.getByRole('button', {name: 'Blue', exact: true}).click();
  await expect.poll(async () => {
    const next = await saved(page, id);
    const fill = next.document.nodes[second.id].fills[0];
    return fill.type === 'SOLID' ? Math.round(fill.color.b * 255) : null;
  }).toBe(0xff);
});

test('a shape opens for typing, a connector joins it to an ellipse and follows the ellipse when it moves', async ({page, seed: _seed}) => {
  const {id, at} = await openNewBoard(page);
  await page.keyboard.press('KeyR');
  await drag(page, at(-320, -100), at(-120, 40));
  await page.keyboard.type('Start');
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyO');
  await page.mouse.click(at(200, -30).x, at(200, -30).y);
  await page.keyboard.press('Escape');
  await expect.poll(async () => objects(await saved(page, id), 'shape').length).toBe(2);
  let file = await saved(page, id);
  const square = objects(file, 'shape').find(node => node.board?.kind === 'shape' && node.board.shape === 'square')!;
  const ellipse = objects(file, 'shape').find(node => node.board?.kind === 'shape' && node.board.shape === 'ellipse')!;
  expect(textOf(file, square)).toBe('Start');
  expect(Math.round(square.width)).toBe(200);

  await page.keyboard.press('KeyX');
  await drag(page, at(-220, -30), at(200, -30));
  await expect.poll(async () => objects(await saved(page, id), 'connector').length).toBe(1);
  file = await saved(page, id);
  const connector = objects(file, 'connector')[0];
  expect(connector.board).toMatchObject({kind: 'connector', start: {node: square.id}, end: {node: ellipse.id}});
  // The connector hands back to "Move" with itself selected.
  expect((await storeState(page)).tool).toBe('move');

  // Move the ellipse 240 px down: the connector's end goes with it.
  const lineEnd = (saved: Saved) => {
    const group = saved.document.nodes[connector.id];
    const line = saved.document.nodes[group.children![0]];
    const commands = line.vectorPaths![0].commands.filter(command => command.type !== 'Z') as {x: number; y: number}[];
    const last = commands[commands.length - 1];
    return {x: group.x + line.x + last.x, y: group.y + line.y + last.y};
  };
  const before = lineEnd(file);
  await page.mouse.click(at(400, 300).x, at(400, 300).y);
  await drag(page, at(200, -30), at(200, 210));
  await expect.poll(async () => Math.round(lineEnd(await saved(page, id)).y - before.y)).toBe(240);
});

test('the marker draws, the highlighter blends, the eraser takes strokes away and leaves stickies', async ({page, seed: _seed}) => {
  const {id, at} = await openNewBoard(page);
  await page.keyboard.press('KeyS');
  await page.mouse.click(at(0, 0).x, at(0, 0).y);
  await page.keyboard.type('I stay');
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyM');
  await expect(page.getByRole('group', {name: 'Marker'})).toBeVisible();
  await drag(page, at(-300, -200), at(300, -200), 20);
  await page.keyboard.press('Shift+KeyM');
  await drag(page, at(-300, 0), at(300, 0), 20);
  await expect.poll(async () => objects(await saved(page, id), 'stroke').length).toBe(2);
  const file = await saved(page, id);
  const highlighter = objects(file, 'stroke').find(node => node.board?.kind === 'stroke' && node.board.tool === 'highlighter')!;
  expect(highlighter.blendMode).toBe('MULTIPLY');
  // The tool stays for the next stroke (FigJam); the eraser sweeps across both strokes and the sticky.
  expect((await storeState(page)).tool).toBe('board-marker');
  await page.keyboard.press('Shift+Backspace');
  await drag(page, at(0, -260), at(0, 60), 30);
  await expect.poll(async () => objects(await saved(page, id), 'stroke').length).toBe(0);
  expect(objects(await saved(page, id), 'sticky')).toHaveLength(1);
});

test('a template from "+" lands with its sections and notes, zoomed to fit; stamps and stickers from the sheet', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  await sheet.getByRole('searchbox', {name: 'Search templates, stickers and stamps'}).fill('retro');
  await sheet.getByRole('button', {name: /Retrospective/}).click();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => objects(await saved(page, id), 'sticky').length).toBe(18);
  const file = await saved(page, id);
  const sections = Object.values(file.document.nodes).filter(node => node.type === 'SECTION').map(node => node.name);
  expect(sections).toEqual(expect.arrayContaining(['What went well', 'What got in the way', 'What we will try', 'Agreements']));
  expect(objects(file, 'table')).toHaveLength(1);
  // Zoomed out to show the whole template.
  const zoom = await page.getByRole('button', {name: /^Zoom \d+%$/}).getAttribute('aria-label');
  expect(Number(/\d+/.exec(zoom!)![0])).toBeLessThan(100);

  // "+" again: a drawn sticker lands in the middle of the view, selected.
  await page.getByRole('button', {name: 'More: stickers, templates, stamps'}).click();
  await sheet.getByRole('tab', {name: 'Stickers'}).click();
  await sheet.getByRole('button', {name: 'Rocket', exact: true}).click();
  await expect.poll(async () => objects(await saved(page, id), 'sticker').length).toBe(1);
  // A stamp from the sheet arms the stamp tool.
  await page.getByRole('button', {name: 'More: stickers, templates, stamps'}).click();
  await sheet.getByRole('tab', {name: 'Stamps'}).click();
  await sheet.getByRole('button', {name: 'Star', exact: true}).click();
  expect((await storeState(page)).tool).toBe('board-stamp');
});

test('comment mode opens the comments sidebar; export and the version history are in the main menu', async ({page, seed: _seed}) => {
  await openNewBoard(page);
  await page.keyboard.press('KeyC');
  await expect(page.getByRole('complementary', {name: 'Comments'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', {name: 'Comments'})).toBeHidden();
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'File', exact: true}).click();
  await page.getByRole('menuitem', {name: /^Export…/}).click();
  const exportDialog = page.getByRole('dialog', {name: 'Export board', exact: true});
  await expect(exportDialog).toBeVisible();
  // An empty board has nothing to export: the button waits for something on it.
  await expect(exportDialog.getByRole('button', {name: 'Export'})).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'File', exact: true}).click();
  await page.getByRole('menuitem', {name: /^Version history/}).click();
  await expect(page.getByRole('complementary', {name: 'Version history'})).toBeVisible();
});

// ── A team's board: co-editing and roles, exactly as a design file's (docs/design-tool.md "Co-editing") ─────────

async function account(browser: Browser, page: Page, baseURL: string, name: string): Promise<{context: BrowserContext; page: Page}> {
  const response = await page.request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {}});
  expect(response.ok(), 'An isolated account').toBeTruthy();
  const seed = (await response.json()) as {token: string};
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}});
  await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL, httpOnly: true, sameSite: 'Lax'}]);
  const opened = await context.newPage();
  expect((await opened.request.put('/api/settings', {data: {name, workspace: 'Studio'}})).ok()).toBeTruthy();
  return {context, page: opened};
}
type LiveNode = {id: string; board?: {kind: string}; children?: string[]; text?: {characters: string}};
const liveTexts = (page: Page) => page.evaluate(() => {
  const nodes = (window as unknown as {__morfaDesignTest?: {store: {getState(): {doc: {nodes: Record<string, LiveNode>}}}}}).__morfaDesignTest?.store.getState().doc.nodes ?? {};
  return Object.values(nodes).filter(node => node.board?.kind === 'sticky').map(node => (node.children ?? []).map(id => nodes[id]).find(child => child?.text)?.text?.characters ?? '').sort();
});
async function openBoard(page: Page, id: string) {
  await page.goto('/#design/' + encodeURIComponent(id));
  await expect(page.getByRole('toolbar', {name: 'Board tools'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);
}
async function addSticky(page: Page, dx: number, text: string) {
  const box = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  await page.keyboard.press('KeyS');
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2);
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
}

test('a team\'s board: an editor and the owner see each other\'s stickies live, a viewer watches read-only', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(120_000);
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith', workspace: 'Studio'}})).ok()).toBeTruthy();
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'North Studio'}})).json()) as {team: {id: string}}).team.id;
  const invite = async (role: string) => ((await (await page.request.post(`/api/design-teams/${teamId}/invites`, {data: {role, days: 7, maxUses: 1}})).json()) as {token: string}).token;
  const boris = await account(browser, page, baseURL!, 'Boris Petrov');
  const vera = await account(browser, page, baseURL!, 'Vera Fox');
  expect((await boris.page.request.post(`/api/design-teams/invites/${await invite('editor')}/accept`)).ok()).toBeTruthy();
  expect((await vera.page.request.post(`/api/design-teams/invites/${await invite('viewer')}/accept`)).ok()).toBeTruthy();
  const created = await page.request.post('/api/design-files', {data: {name: 'Team retro', teamId, kind: 'board'}});
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as {file: {id: string; kind: string}}).file.id;

  await openBoard(page, id);
  await page.keyboard.press('Escape');
  await openBoard(boris.page, id);
  await boris.page.keyboard.press('Escape');
  await expect(page.getByRole('group', {name: 'People in this file'}).getByRole('button', {name: /Follow: Boris Petrov/})).toBeVisible();

  await addSticky(page, -300, 'Anna\'s idea');
  await expect.poll(() => liveTexts(boris.page)).toEqual(['Anna\'s idea']);
  await addSticky(boris.page, 300, 'Boris\'s idea');
  await expect.poll(() => liveTexts(page)).toEqual(['Anna\'s idea', 'Boris\'s idea']);
  await expect.poll(async () => objects(await saved(page, id), 'sticky').length).toBe(2);

  // The viewer: the board's drawing tools are not offered, its keys draw nothing, the others' work arrives live.
  await openBoard(vera.page, id);
  const toolbar = vera.page.getByRole('toolbar', {name: 'Board tools'});
  await expect(toolbar.getByRole('button', {name: 'Move'})).toBeVisible();
  await expect(toolbar.getByRole('button', {name: 'Comment'})).toBeVisible();
  await expect(toolbar.getByRole('button', {name: 'Marker'})).toHaveCount(0);
  await expect(toolbar.getByRole('button', {name: 'Sticky'})).toHaveCount(0);
  await vera.page.keyboard.press('KeyS');
  expect((await storeState(vera.page)).tool).toBe('move');
  await addSticky(page, 0, 'Third');
  await expect.poll(() => liveTexts(vera.page)).toEqual(['Anna\'s idea', 'Boris\'s idea', 'Third']);
  await boris.context.close();
  await vera.context.close();
});

test('"Export board": the whole board as one PNG on white, and as one PDF page', async ({page, seed: _seed}) => {
  const {at} = await openNewBoard(page);
  await page.keyboard.press('KeyS');
  await page.mouse.click(at(-150, 0).x, at(-150, 0).y);
  await page.keyboard.type('Export');
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyR');
  await page.mouse.click(at(200, 0).x, at(200, 0).y);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  const dialog = page.getByRole('dialog', {name: 'Export board', exact: true});
  await expect(dialog).toBeVisible();
  const [png] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: 'Export'}).click()]);
  // The download is named after the board.
  expect(png.suggestedFilename()).toBe('Untitled board.png');
  const bytes = await (await import('node:fs/promises')).readFile((await png.path())!);
  expect([...bytes.subarray(1, 4)].map(code => String.fromCharCode(code)).join('')).toBe('PNG');
  // At 2×: the sticky (240) and the square (200) side by side with their gap, twice as wide; on white, not transparent.
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  expect(height).toBeGreaterThanOrEqual(480);
  expect(width).toBeGreaterThan(2 * (240 + 200));
  // Below the square, past its bottom edge, the board's paper: white and opaque.
  const decoded = decodePng(new Uint8Array(bytes))!;
  const corner = (decoded.width * decoded.height - 1) * 4;
  expect([...decoded.rgba.subarray(corner, corner + 4)]).toEqual([255, 255, 255, 255]);

  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  await dialog.getByRole('radio', {name: 'PDF'}).click();
  const [pdf] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: 'Export'}).click()]);
  expect(pdf.suggestedFilename()).toBe('Untitled board.pdf');
  const pdfBytes = await (await import('node:fs/promises')).readFile((await pdf.path())!);
  expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});
