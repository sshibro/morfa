import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import {createDocument, createNode, solid} from '../../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';

// "Morfa Design" prototypes in the player (src/design/prototype/player): the starter templates are clickable as
// Figma's are ("Mobile app" and "Presentation" made from the gallery play their flows), the player lists
// the page's flows and switches between them, and a frame opened as an overlay closes on a click outside it,
// as the "Prototype" tab now sets it up. Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type Saved = {file: {version: number}; document: DesignDocument};
const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
const origin = (page: Page) => new URL(page.url()).origin;

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return response.json();
}

/** A layer's box in its top-level frame's space (the frames here are not rotated). */
function boxIn(doc: DesignDocument, id: NodeId) {
  const node = doc.nodes[id];
  let x = node.x, y = node.y;
  for (let parent = doc.nodes[node.parentId!]; parent && doc.nodes[parent.parentId!]?.type !== 'PAGE'; parent = doc.nodes[parent.parentId!]) {
    x += parent.x;
    y += parent.y;
  }
  return {x, y, width: node.width, height: node.height};
}

/** Clicks the middle of a layer on the presented screen (`width` is the frame's width in its own units). */
async function tapLayer(player: Page, doc: DesignDocument, id: NodeId, width: number) {
  const screen = (await player.locator('.dz-player-screen').boundingBox())!;
  const k = screen.width / width;
  const box = boxIn(doc, id);
  await player.mouse.click(screen.x + (box.x + box.width / 2) * k, screen.y + (box.y + box.height / 2) * k);
}

async function fromGallery(page: Page, template: string) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file from a template', exact: true}).click();
  await page.getByRole('button', {name: new RegExp('^' + template)}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/, {timeout: 20_000});
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await waitEditorReady(page);
  return fileIdFrom(page);
}

async function play(page: Page) {
  const popup = page.context().waitForEvent('page');
  await page.getByRole('button', {name: 'Present', exact: true}).click();
  const player = await popup;
  await expect(player.locator('.dz-player-screen')).toBeVisible({timeout: 20_000});
  await expect(player.locator('.dz-player-loading')).toHaveCount(0, {timeout: 20_000});
  return player;
}

const frameTitle = (player: Page) => player.locator('.dz-player-frame');

test('the "Mobile app" template plays: "Sign in" opens the feed, the tab bar the profile, "Dark theme" the dark feed', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  const id = await fromGallery(page, 'Mobile app');
  await page.getByRole('tab', {name: 'Prototype', exact: true}).click();
  await expect(page.locator('.dz-proto-flows')).toContainText('App sign-in');
  const doc = (await saved(page, id)).document;
  const withReaction = (frameName: string) => {
    const frame = Object.values(doc.nodes).find(node => node.name === frameName && doc.nodes[node.parentId!]?.type === 'PAGE')!;
    const out: SceneNode[] = [];
    const stack = [...frame.children!];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (node.reactions.length) out.push(node);
      stack.push(...(node.children ?? []));
    }
    return out;
  };
  const enter = withReaction('Sign in')[0];
  const profileTab = withReaction('Feed').find(node => node.mainId !== undefined)!;
  const darkRow = withReaction('Profile').find(node => node.name === 'Dark theme')!;

  const player = await play(page);
  await expect(player.locator('.dz-player-flow')).toContainText('App sign-in');
  await expect(frameTitle(player)).toHaveText('Sign in');
  await tapLayer(player, doc, enter.id, 393);
  await expect(frameTitle(player)).toHaveText('Feed');
  await tapLayer(player, doc, profileTab.id, 393);
  await expect(frameTitle(player)).toHaveText('Profile');
  await tapLayer(player, doc, darkRow.id, 393);
  await expect(frameTitle(player)).toHaveText('Feed — dark theme');
  // R starts over at "Sign in".
  await player.keyboard.press('KeyR');
  await expect(frameTitle(player)).toHaveText('Sign in');
  await player.close();
});

test('the "Presentation" template plays as a deck: → and a click go forward, ← back', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  await fromGallery(page, 'Presentation');
  const player = await play(page);
  await expect(frameTitle(player)).toHaveText('01 — Title');
  await player.keyboard.press('ArrowRight');
  await expect(frameTitle(player)).toHaveText('02 — Findings');
  const screen = (await player.locator('.dz-player-screen').boundingBox())!;
  await player.mouse.click(screen.x + screen.width / 2, screen.y + screen.height / 2);
  await expect(frameTitle(player)).toHaveText('03 — Growth');
  await player.keyboard.press('ArrowLeft');
  await expect(frameTitle(player)).toHaveText('02 — Findings');
  await player.close();
});

/** Two flows: "Main" (A, whose button opens "Menu" as an overlay) and "Second" (B). */
function twoFlows(): DesignDocument {
  let doc = createDocument('page', 'Prototype');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  doc.nodes.page = {...doc.nodes.page, flowStartingPoints: [{nodeId: 'a', name: 'Main'}, {nodeId: 'b', name: 'Second'}]};
  add('FRAME', {id: 'a', parentId: 'page', name: 'Screen A', x: 0, y: 0, width: 400, height: 600, fills: [solid({r: 1, g: 1, b: 1})]});
  add('RECTANGLE', {id: 'open', parentId: 'a', name: 'Open menu', x: 40, y: 40, width: 160, height: 48, fills: [solid({r: 0.05, g: 0.6, b: 1})]});
  add('FRAME', {id: 'b', parentId: 'page', name: 'Screen B', x: 500, y: 0, width: 400, height: 600, fills: [solid({r: 0.9, g: 0.96, b: 1})]});
  add('FRAME', {id: 'menu', parentId: 'page', name: 'Menu', x: 1000, y: 0, width: 200, height: 120, fills: [solid({r: 1, g: 0.95, b: 0.8})]});
  return doc;
}

test('the player lists the page\'s flows and starts the one picked; a new overlay closes on a click outside it', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#designs');
  const created = await page.request.post('/api/design-files', {headers: {Origin: origin(page)}, data: {name: 'Flows', document: twoFlows()}});
  expect(created.ok(), await created.text()).toBeTruthy();
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await waitEditorReady(page);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);

  // "Open menu" → "Open overlay" "Menu" in the "Prototype" tab.
  await page.getByRole('tab', {name: 'Prototype', exact: true}).click();
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['open']));
  await page.getByRole('button', {name: 'Add interaction'}).click();
  const editor = page.getByRole('dialog', {name: 'Interaction'});
  await editor.getByRole('button', {name: 'Action', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'Open overlay'}).click();
  await editor.getByRole('button', {name: 'Destination', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'Menu'}).click();
  await expect(editor.getByRole('checkbox', {name: 'Close when clicking outside'})).toBeChecked();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await saved(page, id)).document.nodes.menu.overlayBackgroundInteraction).toBe('CLOSE_ON_CLICK_OUTSIDE');

  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection([]));
  const player = await play(page);
  await expect(frameTitle(player)).toHaveText('Screen A');
  const doc = (await saved(page, id)).document;
  await tapLayer(player, doc, 'open', 400);
  // The overlay opens centred; a click on the screen outside it closes it (the screen does not change).
  const screen = (await player.locator('.dz-player-screen').boundingBox())!;
  const k = screen.width / 400;
  const menuColour = () => player.evaluate(([x, y]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.dz-player-canvas')!;
    const r = canvas.getBoundingClientRect();
    const d = canvas.getContext('2d')!.getImageData(Math.round((x - r.left) * (canvas.width / r.width)), Math.round((y - r.top) * (canvas.height / r.height)), 1, 1).data;
    return d[2] < 230 && d[0] > 240;
  }, [screen.x + 200 * k, screen.y + 300 * k]);
  await expect.poll(menuColour).toBe(true);
  await player.mouse.click(screen.x + 20 * k, screen.y + 580 * k);
  await expect.poll(menuColour).toBe(false);
  await expect(frameTitle(player)).toHaveText('Screen A');

  // The flow's name opens the list of flows; "Second" starts there.
  await player.getByRole('button', {name: 'Flow “Main”: choose another'}).click();
  await expect(player.getByRole('menuitemradio', {name: 'Main'})).toHaveAttribute('aria-checked', 'true');
  await player.getByRole('menuitemradio', {name: 'Second'}).click();
  await expect(frameTitle(player)).toHaveText('Screen B');
  await expect(player.locator('.dz-player-flow')).toContainText('Second');
  expect(player.url()).toContain('present=b');

  // The link to the prototype: this flow's start, for the people who can open the file.
  await player.getByRole('button', {name: /^Copy prototype link/}).click();
  await expect(player.getByRole('status').filter({hasText: 'Link copied'})).toBeVisible();
  expect(await player.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(player.url()).origin}/#design/${id}?present=b`);
  await player.close();
});

test('"Mouse down" acts as the button goes down, "Mouse up" as it comes up', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  let doc = twoFlows();
  doc = {...doc, nodes: {
    ...doc.nodes,
    open: {...doc.nodes.open, reactions: [{trigger: {type: 'MOUSE_DOWN'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: 'b', transition: {type: 'INSTANT'}}]}]},
    b: {...doc.nodes.b, reactions: [{trigger: {type: 'MOUSE_UP'}, actions: [{type: 'BACK'}]}]},
  }};
  await page.goto('/#designs');
  const created = await page.request.post('/api/design-files', {headers: {Origin: origin(page)}, data: {name: 'Mouse', document: doc}});
  expect(created.ok(), await created.text()).toBeTruthy();
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await page.getByRole('tab', {name: 'Prototype', exact: true}).click();
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['open']));
  await expect(page.locator('.dz-proto-interaction__trigger')).toHaveText('Mouse down');
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection([]));
  const player = await play(page);
  await expect(frameTitle(player)).toHaveText('Screen A');
  const screen = (await player.locator('.dz-player-screen').boundingBox())!;
  const k = screen.width / 400;
  await player.mouse.move(screen.x + 120 * k, screen.y + 64 * k);
  await player.mouse.down();
  await expect(frameTitle(player), 'before the button comes up').toHaveText('Screen B');
  await player.mouse.up();
  await expect(frameTitle(player), 'the release on the first screen\'s press is not taken by the next').toHaveText('Screen B');
  await player.mouse.down();
  await expect(frameTitle(player)).toHaveText('Screen B');
  await player.mouse.up();
  await expect(frameTitle(player)).toHaveText('Screen A');
  await player.close();
});
