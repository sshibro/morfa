import {test, expect, waitEditorReady} from './fixtures';
import type {Locator, Page} from '@playwright/test';
import {createDocument, createNode} from '../../shared/design/defaults';

// "Morfa Design" motion (docs/design-motion-audit.md): what the motion sweep fixed stays fixed. A pressed comment pin
// shrinks about its own middle and stays under the pointer (it used to jump ~30 px toward the canvas corner, so a slow
// click missed it); surfaces opened from the keyboard appear at once while the same surfaces opened by the pointer scale
// in from their trigger; a tool's key lights its toolbar button with no fade; a toast fades out before it leaves; a
// file's picture that is already loaded shows at full opacity. Needs ENABLE_DESIGN_TOOL=1 (scripts/e2e-server.ts).

function startingDocument() {
  const doc = createDocument('0:1', 'Home');
  doc.nodes['1:1'] = createNode('FRAME', {id: '1:1', name: 'Screen', parentId: '0:1', x: 0, y: 0, width: 390, height: 600});
  doc.nodes['0:1'] = {...doc.nodes['0:1'], children: ['1:1']};
  return doc;
}

async function createFile(page: Page, teamId?: string) {
  const created = await page.request.post('/api/design-files', {data: {name: 'Motion', document: startingDocument(), ...(teamId ? {teamId} : {})}});
  expect(created.ok()).toBeTruthy();
  return ((await created.json()) as {file: {id: string}}).file.id;
}

async function openFile(page: Page, fileId: string) {
  await page.goto('/#design/' + fileId);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await waitEditorReady(page);
}

const transitionOf = (locator: Locator) => locator.evaluate(element => {
  const style = getComputedStyle(element);
  return {property: style.transitionProperty, duration: style.transitionDuration, origin: style.transformOrigin};
});

test('a comment pin pressed far from the canvas corner stays under the pointer and opens its thread', async ({page, seed: _seed}) => {
  const team = (await (await page.request.post('/api/design-teams', {data: {name: 'Studio'}})).json()).team as {id: string};
  await openFile(page, await createFile(page, team.id));
  const canvas = page.getByRole('application', {name: 'Canvas'});
  const box = (await canvas.boundingBox())!;
  await canvas.click({position: {x: 8, y: 8}});
  await page.keyboard.press('c');
  // Bottom right: a 0.96 scale applied to the pin's offset (the old `transform: translate()`) moved it ~30 px here.
  await canvas.click({position: {x: box.width - 260, y: box.height - 260}});
  const draft = page.getByRole('dialog', {name: 'New comment'});
  await expect(draft).toBeVisible();
  await page.keyboard.type('Make the button bigger');
  await page.keyboard.press('Enter');
  const card = page.getByRole('dialog', {name: 'Thread'});
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  const pin = page.locator('.dz-comment-pin[data-thread]');
  const rest = (await pin.boundingBox())!;
  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2);
  await page.mouse.down();
  // Held past the 120 ms press: the pin has shrunk, about its own middle.
  await expect.poll(async () => (await pin.boundingBox())!.width).toBeLessThan(rest.width - 0.5);
  const pressed = (await pin.boundingBox())!;
  expect(Math.abs(pressed.x + pressed.width / 2 - (rest.x + rest.width / 2))).toBeLessThan(1);
  expect(Math.abs(pressed.y + pressed.height / 2 - (rest.y + rest.height / 2))).toBeLessThan(1);
  await page.mouse.up();
  await expect(card).toBeVisible();
  // The card scales from the pin's side; its position is a translate, so the scale never moves it across the canvas.
  const placed = await card.evaluate(element => ({translate: getComputedStyle(element).translate, transform: getComputedStyle(element).transform}));
  expect(placed.translate).not.toBe('none');
  expect(placed.transform).toBe('none');
});

test('keyboard-opened menus and dialogs appear at once, pointer-opened ones scale in from their trigger, tool keys never fade', async ({page, seed: _seed}) => {
  await openFile(page, await createFile(page));
  const canvas = page.getByRole('application', {name: 'Canvas'});
  const trigger = page.getByRole('button', {name: 'Main menu'});
  const menu = page.getByRole('menu', {name: 'Main menu'});

  // Pointer: opacity and a 0.97 scale from the trigger (the menu opens below it, so its origin is on the top edge).
  await trigger.click();
  await expect(menu).toBeVisible();
  const byPointer = await transitionOf(menu);
  expect(byPointer.property).toContain('opacity');
  expect(byPointer.property).toContain('scale');
  expect(byPointer.origin).toMatch(/px 0px$/);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Keyboard: Enter on the trigger opens it with no entrance at all.
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  expect((await transitionOf(menu)).property).toBe('none');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // A dialog from its shortcut: no entrance; the same dialog from the menu by pointer: 200 ms, centred.
  await canvas.click({position: {x: 8, y: 8}});
  const dialog = page.getByRole('dialog', {name: 'Keyboard shortcuts'});
  await page.keyboard.press('Control+Shift+Slash');
  await expect(dialog).toBeVisible();
  expect((await transitionOf(dialog)).property).toBe('none');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await menu.getByRole('menuitem', {name: 'Help', exact: true}).hover();
  await page.getByRole('menuitem', {name: 'Keyboard shortcuts'}).click();
  await expect(dialog).toBeVisible();
  const byMenu = await transitionOf(dialog);
  expect(byMenu.property).toContain('scale');
  expect(byMenu.duration.split(', ')[0]).toBe('0.2s');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Tool keys light the toolbar at once: the buttons carry no transition and nothing in the toolbar runs one.
  await canvas.click({position: {x: 8, y: 8}});
  const toolbar = page.getByRole('toolbar', {name: 'Tools'});
  for (const key of ['r', 'o', 't', 'v']) await page.keyboard.press(key);
  await expect(toolbar.getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
  expect((await transitionOf(toolbar.getByRole('button', {name: 'Move', exact: true}))).duration).toBe('0s');
  expect(await toolbar.evaluate(element => element.getAnimations({subtree: true}).length)).toBe(0);
});

test('a toast fades out before it leaves, and a file picture already loaded shows at full opacity', async ({page, seed: _seed}) => {
  const fileId = await createFile(page);
  // A picture for the card (a 1×1 PNG is a valid thumbnail).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const stored = await page.request.put(`/api/design-files/${fileId}/thumbnail`, {headers: {'content-type': 'image/png'}, data: png});
  expect(stored.ok(), await stored.text()).toBeTruthy();

  await openFile(page, fileId);
  await page.getByRole('button', {name: 'Main menu'}).click();
  await page.getByRole('menuitem', {name: 'File', exact: true}).hover();
  await page.getByRole('menuitem', {name: 'Duplicate file'}).click();
  const toast = page.locator('.dz-toast').filter({hasText: 'copy of'});
  await expect(toast).toBeVisible();
  // Record the classes a toast had when it left the DOM (the leaving state lasts only --dz-fast).
  await page.evaluate(() => {
    const host = document.querySelector('.dz-toasts')!;
    const left: string[] = [];
    (window as unknown as {leftToasts: string[]}).leftToasts = left;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) if (node instanceof HTMLElement) left.push(node.className);
    }).observe(host, {childList: true});
  });
  await toast.getByRole('button', {name: 'Dismiss notification'}).click();
  await expect(toast).toHaveCount(0);
  // It left fading (opacity and a 4 px drop at --dz-fast), not in one frame.
  expect(await page.evaluate(() => (window as unknown as {leftToasts: string[]}).leftToasts)).toEqual([expect.stringContaining('is-leaving')]);

  await page.goto('/#designs');
  const picture = page.locator('.dz-file-thumb img').first();
  await expect(picture).toHaveAttribute('data-loaded', '');
  await expect.poll(() => picture.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
});
