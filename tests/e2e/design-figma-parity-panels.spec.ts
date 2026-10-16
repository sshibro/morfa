import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument, Reaction, SceneNode} from '../../shared/design/types';
import {createDocument, createNode} from '../../shared/design/defaults';

// Figma Design parity (lane FD, docs/figma-parity.md): the "Design" panel groups a layer's properties as UI3 does —
// "Position" (X, Y, rotation, constraints), "Layout" (W, H, sizing, clipping), "Appearance" (blend, opacity, corner
// radius) — and a main component's ⌘D copy and pasted copy are its instances, as its ⌥-drag copy already was. Every
// check reads the page's sections or the saved document.

type Saved = {document: DesignDocument};
type Pt = {x: number; y: number};

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
  await waitEditorReady(page);
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number): Pt => ({x: box.x + Math.round(box.width / 2) + x, y: box.y + Math.round(box.height / 2) + y});
  await page.mouse.click(box.x + 30, box.y + 30);
  return {id: fileIdFrom(page), at};
}

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, {steps: 6});
  await page.mouse.up();
}

test('a rectangle’s properties are grouped as UI3: "Position", "Layout", "Appearance", then the paints', async ({page, seed: _seed}) => {
  const {at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-50, -50), at(50, 50));
  const design = page.getByRole('tabpanel', {name: 'Design'});
  await expect(design.getByRole('region', {name: 'Layout', exact: true})).toBeVisible();

  const titles = await design.locator('section.dz-section').evaluateAll(sections => sections.map(section => section.getAttribute('aria-label')));
  expect(titles.slice(0, 7)).toEqual(['Position', 'Layout', 'Appearance', 'Fill', 'Stroke', 'Effects', 'Export']);
  const position = design.getByRole('region', {name: 'Position'});
  await expect(position.getByRole('spinbutton', {name: 'Position X'})).toBeVisible();
  await expect(position.getByRole('spinbutton', {name: 'Rotation'})).toBeVisible();
  await expect(position.getByRole('spinbutton', {name: 'Width'})).toHaveCount(0);
  await expect(design.getByRole('region', {name: 'Layout', exact: true}).getByRole('spinbutton', {name: 'Width'})).toBeVisible();
  const appearance = design.getByRole('region', {name: 'Appearance'});
  await expect(appearance.getByRole('spinbutton', {name: 'Corner radius'})).toBeVisible();
  await expect(appearance.getByRole('spinbutton', {name: 'Layer opacity'})).toBeVisible();
});

test('a main component’s ⌘D copy and its pasted copy are instances of it', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-200, -100), at(-100, 0));
  await page.keyboard.press('ControlOrMeta+Alt+k');
  await expect.poll(async () => ofType(await saved(page, id), 'COMPONENT').length).toBe(1);
  const main = ofType(await saved(page, id), 'COMPONENT')[0];

  // The main is selected: copy it, then ⌘D.
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => ofType(await saved(page, id), 'INSTANCE').map(node => node.componentId)).toEqual([main.id]);
  expect(ofType(await saved(page, id), 'COMPONENT')).toHaveLength(1);

  // The copied main pastes as a second instance.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => ofType(await saved(page, id), 'INSTANCE').map(node => node.componentId)).toEqual([main.id, main.id]);
  expect(ofType(await saved(page, id), 'COMPONENT')).toHaveLength(1);
});

test('a page’s menu copies the link that opens the file on that page', async ({page, context, seed: _seed}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const {id} = await openNewFile(page);
  await page.getByRole('option', {name: 'Page 1', exact: true}).click({button: 'right'});

  await page.getByRole('menuitem', {name: 'Copy link to page'}).click();

  await expect(page.getByText('Link to page copied')).toBeVisible();
  const pageId = (await saved(page, id)).document.pages[0];
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/#design/${encodeURIComponent(id)}?node=${pageId}`);
});

test('a point selected in the vector editor shows its X and Y under "Point", and a typed X moves it', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(0, 0), at(100, 50));
  await page.keyboard.press('Enter');
  const design = page.getByRole('tabpanel', {name: 'Design'});
  await expect(design.getByRole('region', {name: 'Point'})).toHaveCount(0);

  // The top-right corner of the outline.
  await page.mouse.click(at(100, 0).x, at(100, 0).y);
  const point = design.getByRole('region', {name: 'Point'});
  await expect(point.getByRole('spinbutton', {name: 'Point X'})).toHaveValue('100');
  await expect(point.getByRole('spinbutton', {name: 'Point Y'})).toHaveValue('0');

  await point.getByRole('spinbutton', {name: 'Point X'}).fill('160');
  await page.keyboard.press('Enter');
  await expect.poll(async () => {
    const vector = ofType(await saved(page, id), 'VECTOR')[0];
    return vector ? [vector.x, vector.width] : null;
  }).toEqual([0, 160]);
});

test('the panel shows no property captions until "Property labels" in the zoom menu turns them on', async ({page, seed: _seed}) => {
  const {at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-50, -50), at(50, 50));
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const position = design.getByRole('region', {name: 'Position'});
  await expect(position.getByRole('spinbutton', {name: 'Rotation'})).toBeVisible();
  await expect(position.getByText('Rotation', {exact: true})).toHaveCount(0);

  await page.getByRole('button', {name: /^Zoom/}).first().click();
  await page.getByRole('menuitemcheckbox', {name: 'Property labels'}).click();

  await expect(position.getByText('Rotation', {exact: true})).toBeVisible();
  await expect(position.getByText('Alignment', {exact: true})).toBeVisible();
  await expect(design.getByRole('region', {name: 'Appearance'}).getByText('Opacity', {exact: true})).toBeVisible();
});

test('"Appearance" holds opacity and radius in one row, the blend modes behind its droplet, the corners in "Corner radius"', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-50, -50), at(50, 50));
  const appearance = page.getByRole('tabpanel', {name: 'Design'}).getByRole('region', {name: 'Appearance'});
  await expect(appearance.getByRole('spinbutton', {name: 'Layer opacity'})).toBeVisible();
  await expect(appearance.getByRole('spinbutton', {name: 'Corner radius'})).toBeVisible();

  await appearance.getByRole('button', {name: 'Blend mode'}).click();
  await page.getByRole('menuitemradio', {name: 'Multiply'}).click();
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE')[0]?.blendMode).toBe('MULTIPLY');

  await appearance.getByRole('button', {name: 'Individual corners'}).click();
  const details = page.getByRole('dialog', {name: 'Corner radius'});
  await details.getByRole('spinbutton', {name: 'Top left'}).fill('12');
  await page.keyboard.press('Enter');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE')[0]?.rectangleCornerRadii).toEqual([12, 0, 0, 0]);
  await expect(details.getByRole('slider', {name: 'Corner smoothing'})).toBeVisible();
});

test('a frame’s "Flow" turns auto layout on and off, and the section is titled "Auto layout" while it is on', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-100, -100), at(100, 100));
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const flow = design.getByRole('radiogroup', {name: 'Flow'});
  await expect(flow.getByRole('radio', {name: 'Freeform'})).toBeChecked();
  await expect(design.getByRole('region', {name: 'Layout', exact: true})).toBeVisible();

  await flow.getByRole('radio', {name: 'Vertical'}).click();

  await expect.poll(async () => ofType(await saved(page, id), 'FRAME')[0]?.autoLayout?.layoutMode).toBe('VERTICAL');
  await expect(design.getByRole('region', {name: 'Auto layout', exact: true})).toBeVisible();
  await expect(design.getByRole('group', {name: 'Alignment'}).last()).toBeVisible();
  await design.getByRole('radiogroup', {name: 'Flow'}).getByRole('radio', {name: 'Freeform'}).click();
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME')[0]?.autoLayout?.layoutMode).toBe('NONE');
  await expect(design.getByRole('region', {name: 'Layout', exact: true})).toBeVisible();
});

test('the navigation bar along the left edge switches the left panel’s views and opens the variables', async ({page, seed: _seed}) => {
  await openNewFile(page);
  const nav = page.getByRole('navigation', {name: 'Navigation'});
  const views = nav.getByRole('tablist', {name: 'Left panel'});
  await expect(views).toHaveAttribute('aria-orientation', 'vertical');
  await expect(views.getByRole('tab', {name: 'File'})).toHaveAttribute('aria-selected', 'true');
  await expect(nav.getByRole('button', {name: 'Main menu'})).toBeVisible();

  await views.getByRole('tab', {name: 'File'}).focus();
  await page.keyboard.press('ArrowDown');
  await expect(views.getByRole('tab', {name: 'Assets'})).toHaveAttribute('aria-selected', 'true');
  await expect(views.getByRole('tab', {name: 'Assets'})).toBeFocused();

  await nav.getByRole('button', {name: 'Variables'}).click();
  await expect(page.getByRole('dialog').filter({hasText: /Variables/}).first()).toBeVisible();
});

test('with nothing selected "Prototype" starts with "Prototype settings", then the flows', async ({page, seed: _seed}) => {
  await openNewFile(page);
  await page.getByRole('tab', {name: 'Prototype'}).click();
  const panel = page.getByRole('tabpanel', {name: 'Prototype'});
  await expect(panel.getByRole('region', {name: 'Prototype settings'})).toBeVisible();
  const titles = await panel.locator('section.dz-section').evaluateAll(sections => sections.map(section => section.getAttribute('aria-label')));
  expect(titles).toEqual(['Prototype settings', 'Flows']);
  await expect(panel.getByRole('region', {name: 'Prototype settings'}).getByRole('combobox', {name: 'Device'}).or(panel.getByRole('button', {name: /Device/})).first()).toBeVisible();
});

test('inside auto layout W and H carry their sizing in the field, and its menu sets fill and the min and max', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(0, 0), at(80, 40));
  await page.keyboard.press('Shift+a');
  const design = page.getByRole('tabpanel', {name: 'Design'});
  // The new auto-layout frame hugs its rectangle: the chip in W reads "Hug".
  await expect(design.getByRole('button', {name: 'Horizontal resizing'})).toContainText('Hug');
  await page.keyboard.press('Enter');
  const width = design.getByRole('button', {name: 'Horizontal resizing'});
  await width.click();
  await page.getByRole('menuitemradio', {name: 'Fill container'}).click();
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE')[0]?.layoutSizingHorizontal).toBe('FILL');
  await expect(width).toContainText('Fill');
  await width.click();
  await page.getByRole('menuitem', {name: 'Add min width'}).click();
  await expect(design.getByRole('spinbutton', {name: 'Min width'})).toBeVisible();
});

test('the header names the kind of layer, and "Frame ▾" gives a frame another preset size', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-100, -100), at(100, 100));
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const header = design.getByRole('button', {name: 'Frame: frame size'});
  await expect(header).toHaveText('Frame');

  await header.click();
  await page.getByRole('menuitem', {name: 'Phone'}).hover();
  await page.getByRole('menuitem', {name: /iPhone 16 Pro Max/}).click();

  await expect.poll(async () => {
    const frame = ofType(await saved(page, id), 'FRAME')[0];
    return frame && [frame.x, frame.y, frame.width, frame.height];
  }).toEqual([-100, -100, 440, 956]);
  await page.keyboard.press('r');
  await drag(page, at(200, 0), at(260, 60));
  await expect(design.locator('.dz-pl-header-title')).toHaveText('Rectangle');
});

test('the colour picker checks contrast against what is behind, and a missed level fixes the colour', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('t');
  await page.mouse.click(at(0, 0).x, at(0, 0).y);
  await page.keyboard.type('Caption');
  await page.keyboard.press('Escape');
  const design = page.getByRole('tabpanel', {name: 'Design'});
  await design.getByRole('textbox', {name: 'Color'}).first().fill('BBBBBB');
  await page.keyboard.press('Enter');
  await design.getByRole('button', {name: 'Open palette'}).first().click();
  const picker = page.getByRole('dialog').last();
  await picker.getByRole('button', {name: 'Check contrast'}).click();
  const contrast = picker.getByRole('group', {name: 'Contrast'});
  await expect(contrast).toContainText('Normal text');
  await expect(contrast).toContainText(/1\.\d : 1/);

  await contrast.getByRole('button', {name: 'AA: fails, fix', exact: true}).click();

  await expect(contrast.getByRole('button', {name: 'AA: passes', exact: true})).toBeVisible();
  await expect.poll(async () => {
    const text = ofType(await saved(page, id), 'TEXT')[0];
    const paint = text?.fills[0];
    return paint?.type === 'SOLID' ? paint.color.r < 0.5 : null;
  }).toBe(true);
});

test('the interaction details carry the trigger in the header with "Add action", and the action its glyph', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-200, -100), at(-100, 0));
  await page.keyboard.press('f');
  await drag(page, at(100, -100), at(200, 0));
  await page.keyboard.press('Escape');
  await page.mouse.click(at(-150, -50).x, at(-150, -50).y);
  await page.getByRole('tab', {name: 'Prototype', exact: true}).click();
  await page.getByRole('button', {name: 'Add interaction'}).click();

  const editor = page.getByRole('dialog', {name: 'Interaction'});
  const header = editor.locator('.dz-proto-popover__header');
  await expect(header.getByRole('button', {name: 'Trigger', exact: true})).toHaveText(/On click/);
  await expect(header.getByRole('button', {name: 'Add action'})).toBeVisible();
  // One action goes untitled; its kind shows the action's glyph.
  await expect(editor.locator('.dz-proto-group__title')).toHaveCount(0);
  await expect(editor.getByRole('button', {name: 'Action', exact: true}).locator('.dz-select-icon svg')).toBeVisible();
  await editor.getByRole('button', {name: 'Destination', exact: true}).click();
  await page.getByRole('menuitemradio').first().click();
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').some(frame => frame.reactions?.[0]?.actions?.[0]?.type === 'NODE')).toBe(true);
  await expect(editor.getByRole('group', {name: 'State'}).getByRole('checkbox', {name: 'Preserve scroll position'})).toBeVisible();

  // A second action titles both, so they can be told apart.
  await header.getByRole('button', {name: 'Add action'}).click();
  await expect(editor.getByRole('region', {name: 'Action 1'})).toBeVisible();
  await expect(editor.getByRole('region', {name: 'Action 2'})).toBeVisible();
});

test('"=" typed in a number field opens its variable list, as Figma does', async ({page, seed: _seed}) => {
  const {at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(0, 0), at(80, 40));
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const width = design.getByRole('spinbutton', {name: 'Width'});
  await width.click();
  await page.keyboard.press('=');
  await expect(page.getByRole('dialog', {name: 'Variables'})).toBeVisible();
  await expect(width).not.toHaveValue(/=/);
});

test('a text box resizes in "Layout", and paragraph spacing waits behind "Text settings", as in UI3', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('t');
  await page.mouse.click(at(0, 0).x, at(0, 0).y);
  await page.keyboard.type('Hello');
  await page.keyboard.press('Escape');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT').length).toBe(1);
  const design = page.getByRole('tabpanel', {name: 'Design'});
  const layout = design.getByRole('region', {name: 'Layout', exact: true});
  const text = design.getByRole('region', {name: 'Text', exact: true});
  const resize = layout.getByRole('radiogroup', {name: 'Box size'}).or(layout.getByRole('group', {name: 'Box size'}));
  await expect(resize).toBeVisible();
  await expect(text.getByRole('spinbutton', {name: 'Paragraph spacing'})).toHaveCount(0);

  await resize.getByRole('radio', {name: 'Truncate text'}).click();
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT')[0]?.text?.textAutoResize).toBe('TRUNCATE');
  await expect(layout.getByRole('spinbutton', {name: 'Max lines'})).toBeVisible();

  await text.getByRole('button', {name: 'Text settings'}).click();
  const settings = page.getByRole('dialog', {name: 'Text settings'});
  await settings.getByRole('spinbutton', {name: 'Paragraph spacing'}).fill('12');
  await page.keyboard.press('Enter');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT')[0]?.text?.paragraphSpacing).toBe(12);
});

test('"Shape builder" from the boolean menu: a click on an overlap makes it a layer of its own, Escape leaves', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(-100, -50), at(0, 50));
  await page.keyboard.press('r');
  await drag(page, at(-50, -50), at(50, 50));
  await page.keyboard.press('ControlOrMeta+a');
  const design = page.getByRole('tabpanel', {name: 'Design'});
  await design.getByRole('button', {name: 'Boolean operations'}).last().click();
  await page.getByRole('menuitem', {name: 'Shape builder'}).click();

  await page.mouse.click(at(-25, 0).x, at(-25, 0).y);
  await expect.poll(async () => ofType(await saved(page, id), 'VECTOR').map(node => Math.round(node.width)).sort((a, b) => a - b)).toEqual([50, 50, 50]);
  expect(ofType(await saved(page, id), 'RECTANGLE')).toHaveLength(0);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE')).toHaveLength(2);
});

test('"Pages" folds behind its chevron, names the current page while folded, and stays folded after a reload', async ({page, seed: _seed}) => {
  await openNewFile(page);
  const fold = page.getByRole('button', {name: /^Pages/});
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(fold).toContainText('Page 1');
  await expect(page.getByRole('listbox', {name: 'Pages', exact: true})).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', {name: /^Pages/})).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', {name: /^Pages/}).click();
  await expect(page.getByRole('listbox', {name: 'Pages', exact: true})).toBeVisible();
});

test('⌘R with several layers opens "Rename layers": numbered names in the panel’s order, one undo step', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  for (const x of [-150, -50, 50]) {
    await page.keyboard.press('r');
    await drag(page, at(x, 0), at(x + 60, 60));
  }
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+r');
  const dialog = page.getByRole('dialog', {name: 'Rename layers: 3'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', {name: 'Replace with'}).fill('Card ');
  await dialog.getByRole('button', {name: 'Number ↑'}).click();
  await expect(dialog.getByRole('list', {name: 'New names'})).toContainText('Card 1');
  await dialog.getByRole('button', {name: 'Rename'}).click();
  // The panel lists the last drawn on top: it is number 1.
  await expect.poll(async () => {
    const doc = (await saved(page, id)).document;
    return ofType({document: doc}, 'RECTANGLE').sort((a, b) => a.x - b.x).map(node => node.name);
  }).toEqual(['Card 3', 'Card 2', 'Card 1']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => node.name).sort()).toEqual(['Rectangle 1', 'Rectangle 2', 'Rectangle 3']);
});

test('Edit ▸ "Select all with same" ▸ "Same fill" selects the layers that share the fill', async ({page, seed: _seed}) => {
  const {at} = await openNewFile(page);
  for (const x of [-150, -50, 50]) {
    await page.keyboard.press('r');
    await drag(page, at(x, 0), at(x + 60, 60));
  }
  await page.mouse.click(at(-120, 30).x, at(-120, 30).y);
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Edit', exact: true}).hover();
  await page.getByRole('menuitem', {name: 'Select all with same'}).hover();
  await page.getByRole('menuitem', {name: 'Same fill'}).click();
  await expect(page.getByRole('treeitem', {selected: true})).toHaveCount(3);
});

test('an empty page named "---" is a divider in the pages list: a line, not opened by a click', async ({page, seed: _seed}) => {
  await openNewFile(page);
  await page.getByRole('button', {name: 'Add page'}).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('---');
  await page.keyboard.press('Enter');
  const pages = page.getByRole('listbox', {name: 'Pages', exact: true});
  const divider = pages.getByRole('option', {name: 'Divider "---"'});
  await expect(divider).toBeVisible();
  await pages.getByRole('option', {name: 'Page 1'}).click();
  await expect(pages.getByRole('option', {name: 'Page 1'})).toHaveAttribute('aria-selected', 'true');
  // A divider is not an option to pick (aria-disabled): the click is forced, and must not open it.
  await divider.click({force: true});
  await expect(pages.getByRole('option', {name: 'Page 1'})).toHaveAttribute('aria-selected', 'true');
});

test('with nothing selected the arrows pan the canvas, with a selection they nudge it', async ({page, seed: _seed}) => {
  const {at} = await openNewFile(page);
  type Hook = {__morfaDesignTest: {store: {getState(): {viewports: Record<string, {x: number; y: number; zoom: number}>; pageId: string; selection: string[]}}}};
  const viewport = () => page.evaluate(() => {
    const state = (window as unknown as Hook).__morfaDesignTest.store.getState();
    return state.viewports[state.pageId];
  });
  const before = await viewport();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => {
    const now = await viewport();
    return [Math.round((now.x - before.x) * now.zoom), Math.round((now.y - before.y) * now.zoom)];
  }).toEqual([40, 240]);

  await page.keyboard.press('r');
  await drag(page, at(0, 0), at(60, 60));
  const after = await viewport();
  await page.keyboard.press('ArrowRight');
  expect(await viewport()).toEqual(after);
});

test('a drawing tool and Enter place the layer a click makes, in the middle of the view', async ({page, seed: _seed}) => {
  const {id} = await openNewFile(page);
  type Hook = {__morfaDesignTest: {store: {getState(): {viewports: Record<string, {x: number; y: number; zoom: number}>; pageId: string}}}};
  await page.keyboard.press('r');
  await page.keyboard.press('Enter');
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').length).toBe(1);
  const rect = ofType(await saved(page, id), 'RECTANGLE')[0];
  expect([rect.width, rect.height]).toEqual([100, 100]);
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = await page.evaluate(({width, height}) => {
    const state = (window as unknown as Hook).__morfaDesignTest.store.getState();
    const view = state.viewports[state.pageId];
    return {x: view.x + width / 2 / view.zoom, y: view.y + height / 2 / view.zoom};
  }, {width: canvas.width, height: canvas.height});
  expect(Math.abs(rect.x + 50 - centre.x)).toBeLessThan(2);
  expect(Math.abs(rect.y + 50 - centre.y)).toBeLessThan(2);
});

test('F6 moves the focus through the toolbar, the left panel, the right panel and back to the canvas; ⇧F6 the other way', async ({page, seed: _seed}) => {
  await openNewFile(page);
  const region = () => page.evaluate(() => {
    const active = document.activeElement;
    if (active?.closest('[role="toolbar"][aria-label="Tools"]')) return 'toolbar';
    if (active?.closest('.dz-left')) return 'left';
    if (active?.closest('.dz-right')) return 'right';
    return 'canvas';
  });
  const order: string[] = [];
  for (let k = 0; k < 4; k++) {
    await page.keyboard.press('F6');
    order.push(await region());
  }
  expect(order).toEqual(['toolbar', 'left', 'right', 'canvas']);
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Move', exact: true})).not.toBeFocused();
  await page.keyboard.press('Shift+F6');
  expect(await region()).toBe('right');
});

test('the text tool and Enter start a text in the middle of the view, ready to type', async ({page, seed: _seed}) => {
  const {id} = await openNewFile(page);
  await page.keyboard.press('t');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Heading');
  await page.keyboard.press('Escape');
  await expect.poll(async () => ofType(await saved(page, id), 'TEXT').map(node => node.text?.characters)).toEqual(['Heading']);
});

test('keyboard selection: ⌥Space / Ctrl+Space, the arrows and Enter pick a layer; ⌘/Ctrl with the arrows makes a box', async ({page, seed: _seed}) => {
  const {at} = await openNewFile(page);
  await page.keyboard.press('r');
  await drag(page, at(20, 20), at(80, 80));
  await page.keyboard.press('r');
  await drag(page, at(100, 20), at(160, 80));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await page.keyboard.press(mac ? 'Alt+Space' : 'Control+Space');
  // From the middle of the view, 6 steps of 8 px right and down: inside the first rectangle.
  for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowRight');
  for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('treeitem', {selected: true})).toHaveCount(1);
  await expect(page.getByRole('treeitem', {selected: true})).toContainText('Rectangle 1');

  // Back to the middle's left and up, then a box to the far corner takes both.
  for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowLeft');
  for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowUp');
  const mod = mac ? 'Meta' : 'Control';
  for (let k = 0; k < 5; k++) await page.keyboard.press(`${mod}+Shift+ArrowRight`);
  for (let k = 0; k < 3; k++) await page.keyboard.press(`${mod}+Shift+ArrowDown`);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('treeitem', {selected: true})).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
});

/** Three screens, each with "Bar / Next"; the first two go to "Done", the third back to the first. */
function screensDocument(): DesignDocument {
  const doc = createDocument('0:1', 'Main');
  const go = (to: string): Reaction => ({trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: to, transition: {type: 'INSTANT'}}]} as Reaction);
  const add = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    doc.nodes[parent.id] = {...parent, children: [...(parent.children ?? []), node.id]};
  };
  ([['s1', 0, 'done'], ['s2', 500, 'done'], ['s3', 1000, 's1']] as const).forEach(([screen, x, target]) => {
    add(createNode('FRAME', {id: screen, name: 'Screen ' + screen, parentId: '0:1', x, y: 0, width: 390, height: 600}));
    add(createNode('FRAME', {id: screen + 'bar', name: 'Bar', parentId: screen, x: 0, y: 500, width: 390, height: 100}));
    add(createNode('RECTANGLE', {id: screen + 'b', name: 'Next', parentId: screen + 'bar', x: 20, y: 20, width: 120, height: 48, reactions: [go(target)]}));
  });
  add(createNode('FRAME', {id: 'done', name: 'Done', parentId: '0:1', x: 1500, y: 0, width: 390, height: 600}));
  return doc;
}

test('"Select matching interactions" selects the same button in the other screens, and their interaction is then edited at once', async ({page, seed: _seed}) => {
  const created = await page.request.post('/api/design-files', {data: {name: 'Screens', document: screensDocument()}});
  expect(created.ok()).toBeTruthy();
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['s1b']));
  await page.getByRole('tab', {name: 'Prototype', exact: true}).click();
  const panel = page.getByRole('tabpanel', {name: 'Prototype'});
  await panel.locator('.dz-proto-interaction__main').first().click();
  await page.getByRole('dialog', {name: 'Interaction'}).getByRole('button', {name: 'Select matching interactions'}).click();
  await expect(page.getByRole('treeitem', {selected: true})).toHaveCount(2);

  // Both have the same interaction: the details stay open and edit it for both.
  const editor = page.getByRole('dialog', {name: 'Interaction'});
  await expect(editor).toBeVisible();
  await editor.getByRole('button', {name: 'Trigger', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'While hovering'}).click();
  await expect.poll(async () => {
    const doc = (await saved(page, id)).document;
    return ['s1b', 's2b', 's3b'].map(each => doc.nodes[each].reactions[0]?.trigger.type);
  }).toEqual(['ON_HOVER', 'ON_HOVER', 'ON_CLICK']);
});

test('⌘C in the interaction details copies the interaction, ⌘V adds it to the selected layer', async ({page, context, baseURL, seed: _seed}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: baseURL});
  const created = await page.request.post('/api/design-files', {data: {name: 'Screens', document: screensDocument()}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  const select = (ids: string[]) => page.evaluate(each => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(each), ids);
  await select(['s1b']);
  await page.getByRole('tab', {name: 'Prototype', exact: true}).click();
  await page.getByRole('tabpanel', {name: 'Prototype'}).locator('.dz-proto-interaction__main').first().click();
  const editor = page.getByRole('dialog', {name: 'Interaction'});
  await editor.getByRole('button', {name: 'Trigger', exact: true}).focus();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);

  await select(['s3']);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await saved(page, id)).document.nodes.s3.reactions.map(reaction => reaction.actions[0]?.type === 'NODE' && reaction.actions[0].destinationId)).toEqual(['done']);
  expect(ofType(await saved(page, id), 'RECTANGLE')).toHaveLength(3);
});

test('a right click on the eye in "Appearance" binds a boolean variable to the layer’s visibility', async ({page, seed: _seed}) => {
  const doc = createDocument('0:1', 'Main');
  doc.variableCollections = {c: {id: 'c', name: 'States', modes: [{modeId: 'm', name: 'Default'}], defaultModeId: 'm', variableIds: ['v']}} as unknown as DesignDocument['variableCollections'];
  doc.variables = {v: {id: 'v', name: 'Show banner', collectionId: 'c', type: 'BOOLEAN', valuesByMode: {m: false}, description: ''}} as unknown as DesignDocument['variables'];
  const banner = createNode('RECTANGLE', {id: 'banner', name: 'Banner', parentId: '0:1', width: 200, height: 80});
  doc.nodes.banner = banner;
  doc.nodes['0:1'] = {...doc.nodes['0:1'], children: ['banner']};
  const created = await page.request.post('/api/design-files', {data: {name: 'Banner', document: doc}});
  expect(created.ok()).toBeTruthy();
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['banner']));
  const design = page.getByRole('tabpanel', {name: 'Design'});
  await design.getByRole('region', {name: 'Appearance', exact: true}).getByRole('button', {name: 'Hide layer'}).click({button: 'right'});
  await page.getByRole('dialog', {name: 'Variables'}).getByRole('option', {name: /Show banner/}).click();
  await expect.poll(async () => {
    const node = (await saved(page, id)).document.nodes.banner;
    return [node.visible, JSON.stringify(node.boundVariables ?? {})];
  }).toEqual([false, expect.stringContaining('visible')]);
});

test('text takes variables: the content from "Text"’s hexagon, the size from a right click on its field', async ({page, seed: _seed}) => {
  const doc = createDocument('0:1', 'Main');
  doc.variableCollections = {c: {id: 'c', name: 'Texts', modes: [{modeId: 'm', name: 'Default'}], defaultModeId: 'm', variableIds: ['greeting', 'size']}} as unknown as DesignDocument['variableCollections'];
  doc.variables = {
    greeting: {id: 'greeting', name: 'Greeting', collectionId: 'c', type: 'STRING', valuesByMode: {m: 'Good day'}, description: ''},
    size: {id: 'size', name: 'Heading size', collectionId: 'c', type: 'FLOAT', valuesByMode: {m: 32}, description: ''},
  } as unknown as DesignDocument['variables'];
  doc.nodes.title = createNode('TEXT', {id: 'title', name: 'Heading', parentId: '0:1', width: 200, height: 20});
  doc.nodes.title.text!.characters = 'Hello';
  doc.nodes['0:1'] = {...doc.nodes['0:1'], children: ['title']};
  const created = await page.request.post('/api/design-files', {data: {name: 'Texts', document: doc}});
  expect(created.ok()).toBeTruthy();
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['title']));
  const text = page.getByRole('tabpanel', {name: 'Design'}).getByRole('region', {name: 'Text', exact: true});

  await text.getByRole('button', {name: 'Apply variable'}).first().click();
  await page.getByRole('dialog', {name: 'Variables'}).getByRole('option', {name: /Greeting/}).click();
  await expect.poll(async () => (await saved(page, id)).document.nodes.title.text?.characters).toBe('Good day');

  await text.getByRole('spinbutton', {name: 'Font size'}).click({button: 'right'});
  await page.getByRole('dialog', {name: 'Variables'}).getByRole('option', {name: /Heading size/}).click();
  await expect.poll(async () => (await saved(page, id)).document.nodes.title.text?.style.fontSize).toBe(32);
});

test('Enter with several texts selected edits them as one: each takes the new content, one more undo step', async ({page, seed: _seed}) => {
  const doc = createDocument('0:1', 'Main');
  for (const [id, y] of [['t1', 0], ['t2', 100]] as const) {
    doc.nodes[id] = createNode('TEXT', {id, name: id, parentId: '0:1', y, width: 200, height: 20});
    doc.nodes[id].text!.characters = 'Buy';
  }
  doc.nodes['0:1'] = {...doc.nodes['0:1'], children: ['t1', 't2']};
  const created = await page.request.post('/api/design-files', {data: {name: 'Buttons', document: doc}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['t1', 't2']));
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Check out');
  await page.keyboard.press('Escape');
  await expect.poll(async () => {
    const nodes = (await saved(page, id)).document.nodes;
    return [nodes.t1.text?.characters, nodes.t2.text?.characters];
  }).toEqual(['Check out', 'Check out']);
});

test('⇧ with an alignment button aligns each selected layer inside its own frame', async ({page, seed: _seed}) => {
  const doc = createDocument('0:1', 'Main');
  const add = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!] = {...doc.nodes[node.parentId!], children: [...(doc.nodes[node.parentId!].children ?? []), node.id]};
  };
  add(createNode('FRAME', {id: 'f1', name: 'Card 1', parentId: '0:1', x: 0, y: 0, width: 200, height: 100}));
  add(createNode('FRAME', {id: 'f2', name: 'Card 2', parentId: '0:1', x: 300, y: 0, width: 200, height: 100}));
  add(createNode('RECTANGLE', {id: 'a', name: 'a', parentId: 'f1', x: 10, y: 10, width: 20, height: 20}));
  add(createNode('RECTANGLE', {id: 'b', name: 'b', parentId: 'f2', x: 50, y: 30, width: 40, height: 20}));
  const created = await page.request.post('/api/design-files', {data: {name: 'Cards', document: doc}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['a', 'b']));
  await page.getByRole('tabpanel', {name: 'Design'}).getByRole('toolbar', {name: 'Alignment'}).getByRole('button', {name: 'Align right'}).click({modifiers: ['Shift']});
  await expect.poll(async () => {
    const nodes = (await saved(page, id)).document.nodes;
    return [nodes.a.x, nodes.b.x];
  }).toEqual([180, 160]);
});

test('Q inside a component set selects the same layer in every variant; an edit then reaches them all', async ({page, seed: _seed}) => {
  const doc = createDocument('0:1', 'Main');
  const add = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!] = {...doc.nodes[node.parentId!], children: [...(doc.nodes[node.parentId!].children ?? []), node.id]};
  };
  add(createNode('COMPONENT_SET', {id: 'set', name: 'Button', parentId: '0:1', width: 300, height: 100}));
  for (const [variant, x] of [['v1', 20], ['v2', 160]] as const) {
    add(createNode('COMPONENT', {id: variant, name: 'Type=' + variant, parentId: 'set', x, y: 20, width: 120, height: 60}));
    add(createNode('RECTANGLE', {id: variant + 'icon', name: 'Icon', parentId: variant, x: 10, y: 10, width: 20, height: 20}));
  }
  const created = await page.request.post('/api/design-files', {data: {name: 'Button', document: doc}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['v1icon']));
  await page.keyboard.press('q');
  await expect(page.getByRole('treeitem', {selected: true})).toHaveCount(2);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => {
    const nodes = (await saved(page, id)).document.nodes;
    return [nodes.v1icon.x, nodes.v2icon.x];
  }).toEqual([11, 11]);
});

test('a click with the frame tool makes a frame the size of the last top-level frame made', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-300, -150), at(-150, -50));
  await page.keyboard.press('f');
  await page.mouse.click(at(100, 100).x, at(100, 100).y);
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').map(frame => [Math.round(frame.width), Math.round(frame.height)])).toEqual([[150, 100], [150, 100]]);
});

test('the frame tool’s "+" beside a frame adds a copy of it on that side', async ({page, seed: _seed}) => {
  const {id, at} = await openNewFile(page);
  await page.keyboard.press('f');
  await drag(page, at(-300, -150), at(-150, -50));
  await page.keyboard.press('f');
  const plus = at(-150 + 18, -100);
  await page.mouse.move(plus.x - 30, plus.y);
  await page.mouse.move(plus.x, plus.y, {steps: 3});
  await page.mouse.click(plus.x, plus.y);
  await expect.poll(async () => ofType(await saved(page, id), 'FRAME').map(frame => [Math.round(frame.width), Math.round(frame.height)])).toEqual([[150, 100], [150, 100]]);
  const xs = ofType(await saved(page, id), 'FRAME').map(frame => Math.round(frame.x)).sort((a, b) => a - b);
  expect(xs[1] - xs[0]).toBe(250);
});

/** A frame with four squares, no auto layout yet, through the files API; the editor open on it and ready. */
async function openFourSquares(page: Page) {
  const doc = createDocument('0:1', 'Main');
  const add = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!] = {...doc.nodes[node.parentId!], children: [...(doc.nodes[node.parentId!].children ?? []), node.id]};
  };
  add(createNode('FRAME', {id: 'f', name: 'Tiles', parentId: '0:1', width: 400, height: 300}));
  for (const k of [0, 1, 2, 3]) add(createNode('RECTANGLE', {id: 'r' + k, name: 'Tile ' + (k + 1), parentId: 'f', x: 20 + k * 90, y: 20, width: 60, height: 60}));
  const created = await page.request.post('/api/design-files', {data: {name: 'Tiles', document: doc}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await waitEditorReady(page, id);
  const select = (ids: string[]) => page.evaluate(each => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(each), ids);
  return {id, select};
}

test('"Grid" in "Flow" makes a grid auto layout; the picker sets its size, the gaps and track sizes their own', async ({page, seed: _seed}) => {
  const {id, select} = await openFourSquares(page);
  await select(['f']);
  const design = page.getByRole('tabpanel', {name: 'Design'});
  await design.getByRole('radiogroup', {name: 'Flow'}).getByRole('radio', {name: 'Grid'}).click();
  await expect.poll(async () => {
    const frame = (await saved(page, id)).document.nodes.f;
    return [frame.autoLayout?.layoutMode, frame.grid?.columnCount, frame.grid?.autoTracks];
  }).toEqual(['GRID', 2, 'ROWS']);
  await expect(design.getByRole('region', {name: 'Auto layout', exact: true})).toBeVisible();
  await expect(page.locator('[data-row-id="f"] svg').first()).toBeVisible();

  await design.getByRole('button', {name: 'Grid: 2 × 2'}).click();
  await page.getByRole('dialog', {name: 'Grid size'}).getByRole('gridcell', {name: '2 × 3'}).click();
  await expect.poll(async () => {
    const grid = (await saved(page, id)).document.nodes.f.grid!;
    return [grid.rowCount, grid.columnCount, grid.autoTracks];
  }).toEqual([2, 3, 'NONE']);

  const columnGap = design.getByRole('spinbutton', {name: 'Gap between columns'});
  await columnGap.fill('12');
  await columnGap.press('Enter');
  await expect.poll(async () => (await saved(page, id)).document.nodes.f.grid?.columnGap).toBe(12);

  await design.getByRole('button', {name: 'Row and column sizes'}).click();
  const tracks = page.getByRole('dialog', {name: 'Row and column sizes'});
  await tracks.getByRole('group', {name: 'Column 1'}).getByRole('button', {name: 'Size'}).click();
  await page.getByRole('menuitemradio', {name: 'Fixed'}).click();
  await expect.poll(async () => (await saved(page, id)).document.nodes.f.grid?.columnSizes[0]).toEqual({type: 'FIXED', value: 100});
});

test('a grid child spans cells, aligns in its cell, and under manual placement takes a cell of its own', async ({page, seed: _seed}) => {
  const {id, select} = await openFourSquares(page);
  await select(['f']);
  const design = page.getByRole('tabpanel', {name: 'Design'});
  await design.getByRole('radiogroup', {name: 'Flow'}).getByRole('radio', {name: 'Grid'}).click();
  await expect.poll(async () => (await saved(page, id)).document.nodes.f.autoLayout?.layoutMode).toBe('GRID');
  await design.getByRole('button', {name: 'Automatic placement'}).click();
  await expect.poll(async () => (await saved(page, id)).document.nodes.f.grid?.itemsPositioning).toBe('MANUAL');

  await select(['r0']);
  const span = design.getByRole('spinbutton', {name: 'Column span'});
  await span.fill('2');
  await span.press('Enter');
  await expect.poll(async () => (await saved(page, id)).document.nodes.r0.gridChild?.columnSpan).toBe(2);

  await design.getByRole('toolbar', {name: 'Alignment'}).getByRole('button', {name: 'Align right'}).click();
  await expect.poll(async () => (await saved(page, id)).document.nodes.r0.gridChild?.horizontalAlign).toBe('MAX');

  await select(['r3']);
  const row = design.getByRole('spinbutton', {name: 'Cell row'});
  await row.fill('4');
  await row.press('Enter');
  await expect.poll(async () => (await saved(page, id)).document.nodes.r3.gridChild?.rowAnchorIndex).toBe(3);
});

test('text links: ⌘K links the selected words, a caret in a link shows its card, a pasted address links the words it covers', async ({page, seed: _seed}) => {
  const doc = createDocument('0:1', 'Main');
  doc.nodes.t = createNode('TEXT', {id: 't', name: 'Help', parentId: '0:1', width: 240, height: 20});
  doc.nodes.t.text!.characters = 'Read the docs';
  doc.nodes['0:1'] = {...doc.nodes['0:1'], children: ['t']};
  const created = await page.request.post('/api/design-files', {data: {name: 'Links', document: doc}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await waitEditorReady(page, id);
  await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void}}}).__morfaDesignTest.store.setSelection(['t']));
  const textOf = async () => JSON.stringify((await saved(page, id)).document.nodes.t.text);

  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+k');
  const field = page.getByRole('dialog', {name: 'Link'}).getByRole('textbox', {name: 'Link address'});
  await expect(field).toBeFocused();
  await expect(page.getByRole('dialog', {name: 'Actions'})).toHaveCount(0);
  await field.fill('example.com/docs');
  await field.press('Enter');
  await expect.poll(textOf).toContain('"url":"https://example.com/docs"');
  await expect(page.getByRole('dialog', {name: 'Link'})).toHaveCount(0);

  await page.keyboard.press('ArrowRight');
  const card = page.getByRole('group', {name: 'Text link'});
  await expect(card.getByRole('link', {name: 'example.com/docs'})).toBeVisible();
  await card.getByRole('button', {name: 'Remove link'}).click();
  await expect.poll(textOf).not.toContain('example.com');
  await expect(card).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+a');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'https://morfa.example/help');
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  });
  await expect.poll(textOf).toContain('"url":"https://morfa.example/help"');
  expect((await saved(page, id)).document.nodes.t.text?.characters).toBe('Read the docs');
});

test('in the player a click on linked words opens their address in a new tab', async ({page, seed: _seed}) => {
  const doc = createDocument('0:1', 'Main');
  doc.nodes.f = createNode('FRAME', {id: 'f', name: 'Screen', parentId: '0:1', width: 400, height: 300});
  doc.nodes.t = createNode('TEXT', {id: 't', name: 'Link', parentId: 'f', x: 20, y: 20, width: 300, height: 30});
  doc.nodes.t.text = {...doc.nodes.t.text!, characters: 'Open site', textAutoResize: 'NONE', style: {...doc.nodes.t.text!.style, fontSize: 24, hyperlink: {type: 'URL', url: 'https://example.com/docs'}}};
  doc.nodes.f.children = ['t'];
  doc.nodes['0:1'] = {...doc.nodes['0:1'], children: ['f']};
  const created = await page.request.post('/api/design-files', {data: {name: 'Link in prototype', document: doc}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  // Nothing leaves the test: the address answers from here.
  await page.context().route('https://example.com/**', route => route.fulfill({status: 200, contentType: 'text/html', body: '<title>Docs</title>'}));
  await page.goto(`/#design/${id}?present=f`);
  const screen = page.locator('.dz-player-screen');
  await expect(screen).toBeVisible({timeout: 20_000});
  await expect(page.locator('.dz-player-loading')).toHaveCount(0, {timeout: 20_000});
  const box = (await page.locator('.dz-player-canvas').boundingBox())!;
  const scale = box.width / 400;
  const opened = page.context().waitForEvent('page', {timeout: 5_000});
  await page.mouse.click(box.x + 40 * scale, box.y + 32 * scale);
  const tab = await opened;
  expect(tab.url()).toBe('https://example.com/docs');
  await tab.close();
});

test('a layer link pasted over words links them to that frame: the card names it and goes there, the player navigates to it', async ({page, seed: _seed}) => {
  const doc = createDocument('0:1', 'Main');
  doc.nodes.f = createNode('FRAME', {id: 'f', name: 'Main screen', parentId: '0:1', width: 400, height: 300});
  doc.nodes.g = createNode('FRAME', {id: 'g', name: 'Pricing', parentId: '0:1', x: 600, width: 400, height: 300});
  doc.nodes.t = createNode('TEXT', {id: 't', name: 'Link', parentId: 'f', x: 20, y: 20, width: 300, height: 30});
  doc.nodes.t.text = {...doc.nodes.t.text!, characters: 'View pricing', textAutoResize: 'NONE', style: {...doc.nodes.t.text!.style, fontSize: 24}};
  doc.nodes.f.children = ['t'];
  doc.nodes['0:1'] = {...doc.nodes['0:1'], children: ['f', 'g']};
  const created = await page.request.post('/api/design-files', {data: {name: 'Link to frame', document: doc}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await waitEditorReady(page, id);
  const store = () => (window as unknown as {__morfaDesignTest: {store: {setSelection(ids: string[]): void; getState(): {selection: string[]}}}}).__morfaDesignTest.store;
  await page.evaluate(`(${store})().setSelection(['t'])`);

  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  const layerLink = await page.evaluate(fileId => `${location.origin}${location.pathname}#design/${fileId}?node=g`, id);
  await page.evaluate(address => {
    const data = new DataTransfer();
    data.setData('text/plain', address);
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  }, layerLink);
  await expect.poll(async () => JSON.stringify((await saved(page, id)).document.nodes.t.text)).toContain('"hyperlink":{"type":"NODE","nodeId":"g"}');

  await page.keyboard.press('ArrowRight');
  const card = page.getByRole('group', {name: 'Text link'});
  await expect(card).toContainText('Pricing');
  await card.getByRole('button', {name: 'Go to layer'}).click();
  await expect.poll(() => page.evaluate(`(${store})().getState().selection`)).toEqual(['g']);

  await page.goto(`/#design/${id}?present=f`);
  await expect(page.locator('.dz-player-screen')).toBeVisible({timeout: 20_000});
  await expect(page.locator('.dz-player-loading')).toHaveCount(0, {timeout: 20_000});
  const box = (await page.locator('.dz-player-canvas').boundingBox())!;
  const scale = box.width / 400;
  await page.mouse.click(box.x + 40 * scale, box.y + 32 * scale);
  await expect(page.locator('.dz-player-frame')).toHaveText('Pricing');
});
