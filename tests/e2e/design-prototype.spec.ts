import {test, expect} from './fixtures';
import type {Locator, Page} from '@playwright/test';
import {createDocument, createNode, defaultTextProps, defaultTextStyle, solid} from '../../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';

// "Morfa Design" prototyping (src/design/prototype): a three-screen flow is written through the API;
// the "Prototype" tab lists its flow, a connection is drawn on the canvas with the "+" handle, ▶ opens
// the player in a new tab, which follows the editor's edits live, and a player opened without an
// editor reads the saved file. Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

const hex = (value: string) => {
  const n = parseInt(value.slice(1), 16);
  return {r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255};
};

/** "Sign in" → (Get code, PUSH) → "Code" (Back: BACK; Confirm: no interaction yet) and "Done". */
function loginFlow(): DesignDocument {
  let doc = createDocument('page', 'Prototype');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  const update = (id: NodeId, partial: Partial<SceneNode>) => {
    doc = {...doc, nodes: {...doc.nodes, [id]: {...doc.nodes[id], ...partial}}};
  };
  const text = (id: string, parentId: string, characters: string, y: number, size: number, color: string) =>
    add('TEXT', {id, parentId, name: characters, x: 0, y, width: 345, height: size * 1.4, fills: [solid(hex(color))],
      text: {...defaultTextProps(characters), style: {...defaultTextStyle(), fontSize: size, fontWeight: 600}, textAutoResize: 'NONE', textAlignHorizontal: 'CENTER'}});
  update('page', {prototypeDevice: {type: 'PRESET', presetId: 'iphone-16', rotation: 0}, flowStartingPoints: [{nodeId: 'login', name: 'Phone sign-in'}]});
  add('FRAME', {id: 'login', parentId: 'page', name: 'Sign in', x: 0, y: 0, width: 393, height: 852, fills: [solid(hex('#FFFFFF'))]});
  add('FRAME', {id: 'getCode', parentId: 'login', name: 'Get code', x: 24, y: 700, width: 345, height: 52, cornerRadius: 14, fills: [solid(hex('#0D99FF'))]});
  text('getCodeLabel', 'getCode', 'Get code', 14, 17, '#FFFFFF');
  add('FRAME', {id: 'code', parentId: 'page', name: 'Code', x: 493, y: 0, width: 393, height: 852, fills: [solid(hex('#FFFFFF'))]});
  add('RECTANGLE', {id: 'back', parentId: 'code', name: 'Back', x: 16, y: 60, width: 40, height: 40, cornerRadius: 20, fills: [solid(hex('#E6E6E6'))]});
  add('FRAME', {id: 'confirm', parentId: 'code', name: 'Confirm', x: 24, y: 380, width: 345, height: 60, cornerRadius: 30, fills: [solid(hex('#14AE5C'))]});
  text('confirmLabel', 'confirm', 'Confirm', 18, 17, '#FFFFFF');
  add('FRAME', {id: 'done', parentId: 'page', name: 'Done', x: 986, y: 0, width: 393, height: 852, fills: [solid(hex('#14AE5C'))]});
  update('getCode', {reactions: [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: 'code', transition: {type: 'PUSH', direction: 'LEFT', duration: 0.3, easing: 'EASE_OUT'}}]}]});
  update('back', {reactions: [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'BACK'}]}]});
  return doc;
}

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<{file: {version: number}; document: DesignDocument}> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return response.json();
}

/** Clicks a point of the presented 393-wide screen, in the screen's own units. */
async function tapScreen(player: Page, x: number, y: number) {
  const box = (await player.locator('.dz-player-screen').boundingBox())!;
  const k = box.width / 393;
  await player.mouse.click(box.x + x * k, box.y + y * k);
}

/** The "+" handle (at the middle of the selection's right edge) shows while the pointer is near the
 *  selection: sweeps across the canvas until it does. */
async function handleCentre(handle: Locator, canvas: Locator) {
  if (!(await handle.isVisible())) {
    const area = (await canvas.boundingBox())!;
    for (let x = area.x + 10; x < area.x + area.width && !(await handle.isVisible()); x += 30) await handle.page().mouse.move(x, area.y + area.height / 2);
  }
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

test('a connection drawn on the canvas reaches the open player; the player plays the flow', async ({page, context, seed: _seed}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push('editor: ' + error.message));
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  const file = await saved(page, id);
  const response = await page.request.put(`/api/design-files/${encodeURIComponent(id)}/document`, {
    headers: {Origin: new URL(page.url()).origin},
    data: {baseVersion: file.file.version, document: loginFlow()},
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.reload();
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible({timeout: 30_000});

  // "Prototype" with nothing selected lists the page's flows.
  await page.getByRole('tab', {name: 'Prototype', exact: true}).click();
  await expect(page.getByText('Flows', {exact: true})).toBeVisible();
  await expect(page.getByText('Phone sign-in', {exact: true})).toBeVisible();

  // Where things are on screen: the handle sits at the middle of a selected frame's right edge.
  const handle = page.locator('.dz-proto-handle');
  await page.locator('[data-row-id="login"]').click();
  const login = await handleCentre(handle, canvas);
  await page.mouse.move(5, 5);
  await page.locator('[data-row-id="code"]').click();
  const code = await handleCentre(handle, canvas);
  const zoom = (code.x - login.x) / 493;
  expect(zoom).toBeGreaterThan(0.1);
  const at = (x: number, y: number) => ({x: login.x + (x - 393) * zoom, y: login.y + (y - 426) * zoom});

  // ▶ with nothing selected plays the page's first flow, in a new tab.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const opened = context.waitForEvent('page');
  await page.getByRole('button', {name: 'Present', exact: true}).click();
  const player = await opened;
  player.on('pageerror', error => errors.push('player: ' + error.message));
  await expect(player.locator('.dz-player-frame')).toHaveText('Sign in', {timeout: 15_000});
  await expect(player.locator('.dz-player-flow')).toContainText('Phone sign-in');

  // In the editor, "Confirm" gets a connection to "Done": its handle dragged onto the frame.
  await page.bringToFront();
  const confirm = at(493 + 196, 410);
  await page.mouse.click(confirm.x, confirm.y);
  await expect(page.locator('[data-row-id="confirm"]')).toHaveAttribute('aria-selected', 'true');
  const from = await handleCentre(handle, canvas);
  const target = at(986 + 196, 300);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + target.x) / 2, from.y + 20, {steps: 6});
  await page.mouse.move(target.x, target.y, {steps: 6});
  await page.mouse.up();
  // A new connection is a click that goes there at once, and its interaction opens for editing.
  await expect(page.getByRole('dialog', {name: 'Interaction'})).toBeVisible();
  await expect.poll(async () => (await saved(page, id)).document.nodes.confirm?.reactions?.[0]).toMatchObject({
    trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: 'done', transition: {type: 'INSTANT'}}],
  });
  await page.keyboard.press('Escape');

  // The player: PUSH to "Code", BACK, again, then the connection drawn after it opened.
  await player.bringToFront();
  await tapScreen(player, 196, 726);
  await expect(player.locator('.dz-player-frame')).toHaveText('Code');
  await expect(player.locator('.dz-player-count')).toHaveText('2 of 3');
  await player.waitForTimeout(400);
  await tapScreen(player, 36, 80);
  await expect(player.locator('.dz-player-frame')).toHaveText('Sign in');
  await player.waitForTimeout(400);
  await tapScreen(player, 196, 726);
  await expect(player.locator('.dz-player-frame')).toHaveText('Code');
  await player.waitForTimeout(400);
  await tapScreen(player, 196, 410);
  await expect(player.locator('.dz-player-frame')).toHaveText('Done');
  // R starts the flow again.
  await player.keyboard.press('r');
  await expect(player.locator('.dz-player-frame')).toHaveText('Sign in');

  // With no editor open, a player reads the saved file.
  await player.close();
  await page.goto('/#designs');
  const lone = await context.newPage();
  lone.on('pageerror', error => errors.push('player: ' + error.message));
  await lone.goto(`/#design/${encodeURIComponent(id)}?present=code`);
  await expect(lone.locator('.dz-player-frame')).toHaveText('Code', {timeout: 15_000});
  await tapScreen(lone, 196, 410);
  await expect(lone.locator('.dz-player-frame')).toHaveText('Done');
  expect(errors).toEqual([]);
});
