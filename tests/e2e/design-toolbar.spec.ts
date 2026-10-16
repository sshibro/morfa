import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// "Morfa Design": the bottom toolbar as Figma's UI3 bar (src/design/editor/chrome/Toolbar.tsx): its size and groups, the flyouts,
// "Actions" (⌘K, src/design/editor/ActionsMenu.tsx) with the assets, and the modes at its right end.

type Saved = {document: DesignDocument};
const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}
const ofType = (file: Saved, type: SceneNode['type']) => Object.values(file.document.nodes).filter(node => node.type === type);

async function openNewFile(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  // The editor takes keys, and co-editing and the meeting have mounted (fixtures.ts `waitEditorReady`).
  await waitEditorReady(page);
  const box = (await canvas.boundingBox())!;
  const centre = {x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2)};
  await page.mouse.click(box.x + 30, box.y + 30);
  return {id: fileIdFrom(page), box, at: (x: number, y: number) => ({x: centre.x + x, y: centre.y + y})};
}

async function drag(page: Page, from: {x: number; y: number}, to: {x: number; y: number}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {steps: 4});
  await page.mouse.move(to.x, to.y, {steps: 4});
  await page.mouse.up();
}

const toolbar = (page: Page) => page.getByRole('toolbar', {name: 'Tools'});
const actions = (page: Page) => page.getByRole('dialog', {name: 'Actions'});
const motion = (element: Element) => getComputedStyle(element).transitionProperty;

for (const scheme of ['light', 'dark'] as const) {
  test(`the bar is Figma’s size in the ${scheme} theme: 48 px, 32 px buttons with 24 px glyphs, 16 px chevrons, the modes inset at the end`, async ({page, seed: _seed}) => {
    await page.emulateMedia({colorScheme: scheme});
    await openNewFile(page);
    const bar = toolbar(page);
    const geometry = await bar.evaluate(element => {
      const box = (selector: string) => {
        const rect = element.querySelector(selector)!.getBoundingClientRect();
        return {width: rect.width, height: rect.height};
      };
      const style = getComputedStyle(element);
      return {
        bar: {height: element.getBoundingClientRect().height, radius: style.borderRadius},
        tool: box('.dz-tool'), glyph: box('.dz-tool svg'), chevron: box('.dz-tool-flyout'), modes: box('.dz-toolbar-modes'), mode: box('.dz-toolbar-mode'),
        divider: box('.dz-toolbar-divider').height,
        groups: [...element.querySelectorAll('.dz-tool-group > .dz-tool')].map(button => button.getAttribute('aria-label')),
      };
    });
    expect(geometry).toMatchObject({
      bar: {height: 48, radius: '13px'}, tool: {width: 32, height: 32}, glyph: {width: 24, height: 24}, chevron: {width: 16, height: 32},
      modes: {height: 32}, mode: {width: 28, height: 28}, divider: 48,
      groups: ['Move', 'Frame', 'Rectangle', 'Pen', 'Text', 'Comment'],
    });
    // The tool buttons change at once (tools switch from the keyboard all day).
    expect(await bar.getByRole('button', {name: 'Move', exact: true}).evaluate(element => getComputedStyle(element).transitionDuration.split(', ').every(value => value === '0s'))).toBe(true);
  });
}

test('flyouts list each group as Figma does, with keys and a check on the current tool; a click scales one in, a key opens it at once', async ({page, seed: _seed}) => {
  await openNewFile(page);
  const bar = toolbar(page);
  const flyout = async (group: string) => {
    await bar.getByRole('button', {name: group, exact: true}).click();
    const menu = page.getByRole('menu', {name: group});
    await expect(menu).toBeVisible();
    const rows = await menu.getByRole('menuitemradio').evaluateAll(items => items.map(item => [item.querySelector('.dz-menu-label')?.textContent, item.querySelector('.dz-menu-shortcut')?.textContent ?? '', item.getAttribute('aria-checked')]));
    return {menu, rows};
  };
  const move = await flyout('Move tools');
  expect(move.rows).toEqual([['Move', 'V', 'true'], ['Hand', 'H', 'false'], ['Scale', 'K', 'false']]);
  expect(await move.menu.evaluate(motion)).toBe('opacity, scale');
  // Figma's rows: 32 px, the tool's icon in a 24 px box (measured once it has grown); the flyout grows from its chevron (its
  // bottom-left corner stands on it).
  await move.menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  expect(await move.menu.getByRole('menuitemradio').first().evaluate(item => ({row: item.getBoundingClientRect().height, icon: item.querySelector('.dz-menu-icon')!.getBoundingClientRect().width})))
    .toEqual({row: 32, icon: 24});
  const chevron = (await bar.getByRole('button', {name: 'Move tools', exact: true}).boundingBox())!;
  const flyoutBox = (await move.menu.boundingBox())!;
  const origin = await move.menu.evaluate(element => getComputedStyle(element).transformOrigin.split(' ').map(parseFloat));
  expect(Math.abs(flyoutBox.x + origin[0]! - chevron.x)).toBeLessThan(17);
  expect(Math.abs(flyoutBox.y + origin[1]! - chevron.y)).toBeLessThan(17);
  // Picked from the flyout: the group's button shows the hand now.
  await move.menu.getByRole('menuitemradio', {name: /Hand/}).click();
  await expect(bar.getByRole('button', {name: 'Hand', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('v');
  await expect(bar.getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
  const frame = await flyout('Frame tools');
  expect(frame.rows.map(row => row[0])).toEqual(['Frame', 'Section', 'Slice']);
  await page.keyboard.press('Escape');
  const shapes = await flyout('Shape tools');
  expect(shapes.rows.map(row => row[0])).toEqual(['Rectangle', 'Line', 'Arrow', 'Ellipse', 'Polygon', 'Star', 'Image']);
  await page.keyboard.press('Escape');
  const pen = await flyout('Pen and pencil');
  expect(pen.rows.map(row => row[0])).toEqual(['Pen', 'Pencil']);
  await page.keyboard.press('Escape');
  // A chevron only where the group has more than one registered tool.
  const listed = new Map<string, string[]>();
  for (const group of await bar.locator('.dz-tool-group').all()) {
    const chevron = group.locator('.dz-tool-flyout');
    if (!(await chevron.count())) continue;
    await chevron.click();
    const menu = page.getByRole('menu');
    expect(await menu.getByRole('menuitemradio').count()).toBeGreaterThan(1);
    listed.set((await menu.getAttribute('aria-label')) ?? '', await menu.locator('.dz-menu-label').allTextContents());
    await page.keyboard.press('Escape');
  }
  // Figma's Text and Comment flyouts: "Text on path" with Text, "Annotation" (Y) and "Measure" (⇧M) with Comment.
  expect(listed.get('Text')).toEqual(['Text', 'Text on path']);
  expect(listed.get('Comments')).toEqual(['Comment', 'Annotation', 'Measure']);
  // Figma Draw's lasso and brush are not on the "Design" bar.
  for (const rows of listed.values()) for (const name of ['Lasso', 'Brush']) expect(rows).not.toContain(name);
  // From the keyboard: Enter on the chevron opens the flyout with no entrance.
  await bar.getByRole('button', {name: 'Frame tools', exact: true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', {name: 'Frame tools'})).toBeVisible();
  expect(await page.getByRole('menu', {name: 'Frame tools'}).evaluate(motion)).toBe('none');
  await page.keyboard.press('Escape');
});

test('"Actions": ⌘K and ⌘/ open it at once, its button lets it grow from itself; search by name and keyword, Tab to "Assets", recent first', async ({page, seed: _seed}) => {
  const {at} = await openNewFile(page);
  const bar = toolbar(page);
  await page.keyboard.press('ControlOrMeta+k');
  const menu = actions(page);
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(motion)).toBe('none');
  await expect(bar.getByRole('button', {name: 'Actions'})).toHaveAttribute('aria-expanded', 'true');
  // Over the toolbar, as wide as it, 8 px above it.
  const [menuBox, barBox] = [(await menu.boundingBox())!, (await bar.boundingBox())!];
  expect(Math.abs(menuBox.y + menuBox.height + 8 - barBox.y)).toBeLessThan(1.5);
  expect(Math.abs(menuBox.x - barBox.x)).toBeLessThan(1.5);
  // No AI section, and no "Plugins" tab or catalogue.
  await expect(menu.getByText('All commands', {exact: true})).toBeVisible();
  await expect(menu.getByRole('tab')).toHaveText(['All', 'Assets']);
  const search = menu.getByRole('combobox');
  for (const [query, first] of [['rectang', 'Rectangle'], ['rectangle', 'Rectangle'], ['group sel', 'Group selection']] as const) {
    await search.fill(query);
    await expect(menu.getByRole('option').first()).toContainText(first);
  }
  // Tab: "Assets" and back.
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('tab', {name: 'Assets'})).toHaveAttribute('aria-selected', 'true');
  await expect(search).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu.getByRole('tab', {name: 'All'})).toHaveAttribute('aria-selected', 'true');
  // Enter runs the top row: the rectangle tool.
  await search.fill('rectang');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(bar.getByRole('button', {name: 'Rectangle', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  // ⌘/ too; what ran last is first in "Recent".
  await page.mouse.click(at(-300, -200).x, at(-300, -200).y);
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(menu.getByText('Recent', {exact: true})).toBeVisible();
  await expect(menu.getByRole('option').first()).toContainText('Rectangle');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // Its button: a click opens it from there (opacity and scale, from the button's centre), a second click closes it.
  const button = bar.getByRole('button', {name: 'Actions'});
  await button.click();
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(motion)).toBe('opacity, scale');
  // Measured once it has grown (its box is scaled while it does).
  await menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const origin = await menu.evaluate(element => getComputedStyle(element).transformOrigin.split(' ').map(parseFloat));
  const [box, from] = [(await menu.boundingBox())!, (await button.boundingBox())!];
  expect(Math.abs(box.x + origin[0]! - (from.x + from.width / 2))).toBeLessThan(2);
  expect(Math.abs(box.y + origin[1]! - (from.y + from.height / 2))).toBeLessThan(2);
  await button.click();
  await expect(menu).toBeHidden();
  // Reduced motion keeps the fade and drops the scale (src/styles/motion.css limits every transition to colours and opacity).
  await page.emulateMedia({reducedMotion: 'reduce'});
  await button.click();
  await expect(menu).toBeVisible();
  const reduced = (await menu.evaluate(motion)).split(', ');
  expect(reduced).toContain('opacity');
  expect(reduced).not.toContain('scale');
  await button.click();
  await expect(menu).toBeHidden();
});

test('"Actions" ▸ "Assets": a click places a component at the view’s centre, a drag where it is dropped; a style applies to the selection', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-300, -200), at(-200, -100));
  await page.keyboard.press('Alt+ControlOrMeta+k');
  await expect.poll(async () => ofType(await saved(page, id), 'COMPONENT').length).toBe(1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+k');
  const menu = actions(page);
  await page.keyboard.press('Tab');
  const tile = menu.locator('.dz-asset-item').first();
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(menu).toBeHidden();
  await expect.poll(async () => ofType(await saved(page, id), 'INSTANCE').map(node => [Math.round(node.x + node.width / 2), Math.round(node.y + node.height / 2)])).toEqual([[0, 0]]);
  // A drag: the menu steps aside, the instance lands under the pointer.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('Tab');
  const from = (await tile.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(at(150, -150).x, at(150, -150).y, {steps: 6});
  await expect(menu).toHaveClass(/is-dragging/);
  await page.mouse.move(at(200, -200).x, at(200, -200).y, {steps: 2});
  await page.mouse.up();
  await expect(menu).toBeHidden();
  await expect.poll(async () => ofType(await saved(page, id), 'INSTANCE').map(node => [Math.round(node.x + node.width / 2), Math.round(node.y + node.height / 2)]).sort()).toEqual([[0, 0], [200, -200]].sort());
  // The file's colour style, applied to the selected rectangle from "Assets".
  await page.evaluate(() => {
    type Store = {transact(label: string, recipe: (tx: {setStyle(style: object): void}) => void): void};
    const store = (window as unknown as {__morfaDesignTest: {store: Store}}).__morfaDesignTest.store;
    store.transact('Style', tx => tx.setStyle({id: 'S:brand', type: 'FILL', name: 'Brand/Primary', description: '', paints: [{type: 'SOLID', color: {r: 1, g: 0, b: 0}, opacity: 1, visible: true, blendMode: 'NORMAL'}]}));
  });
  await page.keyboard.press('r');
  await drag(page, at(100, 100), at(160, 160));
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('Tab');
  await menu.getByRole('combobox').fill('prim');
  await menu.getByRole('button', {name: /Primary/}).click();
  await expect(menu).toBeHidden();
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => node.fillStyleId)).toEqual(['S:brand']);
});

test('modes at the right end: "Code" (⇧D) is the right panel’s tab and Dev Mode’s short bar, a drawing key brings "Design" back; "Draw" shows the drawing tools', async ({page, seed: _seed}) => {
  await openNewFile(page);
  const bar = toolbar(page);
  const modes = bar.getByRole('radiogroup', {name: 'Mode'});
  await expect(modes.getByRole('radio')).toHaveText(['', '', '', '']);
  expect(await modes.getByRole('radio').evaluateAll(radios => radios.map(radio => radio.getAttribute('aria-label')))).toEqual(['Draw', 'Design', 'Prototype', 'Code']);
  await expect(modes.getByRole('radio', {name: 'Design'})).toHaveAttribute('aria-checked', 'true');
  const tools = () => bar.locator('.dz-tool-group > .dz-tool').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  // ⇧D: Dev Mode — the "Code" tab, a bar to look, measure and comment.
  await page.keyboard.press('Shift+d');
  await expect(modes.getByRole('radio', {name: 'Code'})).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('tab', {name: 'Code', exact: true})).toHaveAttribute('aria-selected', 'true');
  expect(await tools()).toEqual(['Move', 'Comment']);
  await page.keyboard.press('Shift+d');
  await expect(modes.getByRole('radio', {name: 'Design'})).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('tab', {name: 'Design', exact: true})).toHaveAttribute('aria-selected', 'true');
  // The right panel's tab is the mode.
  await page.getByRole('tab', {name: 'Prototype', exact: true}).click();
  await expect(modes.getByRole('radio', {name: 'Prototype'})).toHaveAttribute('aria-checked', 'true');
  // In "Code", R picks a tool its bar has no button for: back to "Design".
  await modes.getByRole('radio', {name: 'Code'}).click();
  await page.getByRole('application', {name: 'Canvas'}).click({position: {x: 30, y: 30}});
  await page.keyboard.press('r');
  await expect(modes.getByRole('radio', {name: 'Design'})).toHaveAttribute('aria-checked', 'true');
  await expect(bar.getByRole('button', {name: 'Rectangle', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  // "Draw": the drawing tools; the arrows move between the modes.
  await modes.getByRole('radio', {name: 'Draw'}).click();
  // Draw's own tools: the brush on a button of its own, the lasso in the selection flyout.
  const drawing = await tools();
  expect(drawing).toEqual(['Move', 'Rectangle', 'Pen', 'Pencil', 'Brush', 'Text']);
  for (const name of ['Frame', 'Comment']) expect(drawing).not.toContain(name);
  await bar.getByRole('button', {name: 'Selection', exact: true}).click();
  await expect(page.getByRole('menu', {name: 'Selection'}).locator('.dz-menu-label')).toHaveText(['Move', 'Hand', 'Lasso']);
  await page.keyboard.press('Escape');
  await modes.getByRole('radio', {name: 'Draw'}).focus();
  await expect(page.getByRole('tab', {name: 'Design', exact: true})).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(modes.getByRole('radio', {name: 'Design'})).toHaveAttribute('aria-checked', 'true');
  await expect(modes.getByRole('radio', {name: 'Design'})).toBeFocused();
  // Q (the lasso) from "Design" shows "Draw", whose bar has it.
  await page.getByRole('application', {name: 'Canvas'}).click({position: {x: 30, y: 30}});
  await page.keyboard.press('q');
  await expect(modes.getByRole('radio', {name: 'Draw'})).toHaveAttribute('aria-checked', 'true');
  await expect(bar.getByRole('button', {name: 'Lasso', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('v');
  // The tooltip names the mode and its key.
  await modes.getByRole('radio', {name: 'Code'}).hover();
  await expect(page.getByRole('tooltip')).toContainText('Code — Dev Mode');
  await expect(page.getByRole('tooltip')).toContainText(/⇧D|Shift\+D/);
});
