import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// "Morfa Design": the assembled editor (src/design/editor/DesignEditor.tsx). A new file opens on an
// empty canvas; a rectangle is drawn (R + drag), undone and redone, moved, saved by autosave, still
// there after a reload; the file is renamed and the editor left for the files. Needs ENABLE_DESIGN_TOOL=1
// on the test server (scripts/e2e-server.ts).

type SavedNode = {id: string; type: string; x: number; y: number; width: number; height: number; parentId: string | null};
type Saved = {file: {name: string; version: number}; document: {pages: string[]; nodes: Record<string, SavedNode>}};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}

const rectangles = (file: Saved) => Object.values(file.document.nodes).filter(node => node.type === 'RECTANGLE');

/** The scene canvas's colour at a point of the canvas (CSS px from its top-left). */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(([px, py]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.dz-canvas__scene')!;
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    const data = canvas.getContext('2d')!.getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data;
    return [data[0], data[1], data[2]] as [number, number, number];
  }, [x, y]);
}

/** Default shape grey (#D9D9D9) on the page background (#F5F5F5). */
const isShapeGrey = ([r, g, b]: [number, number, number]) => Math.abs(r - 217) < 6 && Math.abs(g - 217) < 6 && Math.abs(b - 217) < 6;
const isBackground = ([r, g, b]: [number, number, number]) => r > 238 && g > 238 && b > 238;

async function waitSaved(page: Page) {
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
}

test('a rectangle is drawn, undone, redone, moved and still there after a reload; the file is renamed and left', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  const toolbar = page.getByRole('toolbar', {name: 'Tools'});
  await expect(toolbar.getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number) => ({x: box.x + x, y: box.y + y});
  const centre = {x: Math.round(box.width / 2), y: Math.round(box.height / 2)};

  const drawable = await toolbar.getByRole('button', {name: 'Rectangle', exact: true}).count() > 0;
  if (drawable) {
    // R, then a drag: the rectangle appears where it was drawn and the tool hands back to "Move".
    await canvas.click({position: {x: 40, y: 40}});
    await page.keyboard.press('r');
    await expect(toolbar.getByRole('button', {name: 'Rectangle', exact: true})).toHaveAttribute('aria-pressed', 'true');
    const from = at(centre.x - 100, centre.y - 60), to = at(centre.x + 100, centre.y + 60);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {steps: 4});
    await page.mouse.move(to.x, to.y, {steps: 4});
    await page.mouse.up();
    await expect.poll(() => pixel(page, centre.x, centre.y).then(isShapeGrey)).toBe(true);
    await expect(toolbar.getByRole('button', {name: 'Move', exact: true})).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(1);

    // ⌘Z takes it away, ⇧⌘Z brings it back; autosave follows both.
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => pixel(page, centre.x, centre.y).then(isBackground)).toBe(true);
    await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(0);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => pixel(page, centre.x, centre.y).then(isShapeGrey)).toBe(true);
    await expect.poll(async () => rectangles(await saved(page, id)).length).toBe(1);
  } else {
    // Until the shape tools ship, the toolbar leaves the tool out (never a fake entry) and R says it is not there yet; the rest of
    // the flow runs on a rectangle written through the API.
    test.info().annotations.push({type: 'pending-feature', description: 'The rectangle tool is not registered on this build; the rectangle was seeded.'});
    await expect(toolbar.getByRole('button', {name: 'Rectangle', exact: true})).toHaveCount(0);
    await page.keyboard.press('r');
    await expect(page.getByText('The Rectangle tool is not available yet.')).toBeVisible();
    const file = await saved(page, id);
    const pageId = file.document.pages[0];
    const response = await page.request.put(`/api/design-files/${encodeURIComponent(id)}/document`, {
      headers: {Origin: new URL(page.url()).origin},
      data: {baseVersion: file.file.version, document: {...file.document, nodes: {
        ...file.document.nodes,
        [pageId]: {...file.document.nodes[pageId], children: ['e2e-rect']},
        'e2e-rect': seededRectangle(pageId),
      }}},
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    await page.reload();
    await expect(canvas).toBeVisible();
    await expect.poll(() => pixel(page, centre.x, centre.y).then(isShapeGrey)).toBe(true);
  }

  // Move it with the pointer: one undo step, saved.
  const before = rectangles(await saved(page, id))[0];
  await page.mouse.move(box.x + centre.x, box.y + centre.y);
  await page.mouse.down();
  await page.mouse.move(box.x + centre.x + 60, box.y + centre.y + 30, {steps: 6});
  await page.mouse.move(box.x + centre.x + 120, box.y + centre.y + 60, {steps: 6});
  await page.mouse.up();
  // The canvas shows it at its new place at once, and nothing where it was.
  await expect.poll(() => pixel(page, centre.x + 120, centre.y + 60).then(isShapeGrey)).toBe(true);
  await expect.poll(() => pixel(page, centre.x - 90, centre.y - 50).then(isBackground)).toBe(true);
  await expect.poll(async () => rectangles(await saved(page, id))[0]?.x).not.toBe(before.x);
  const moved = rectangles(await saved(page, id))[0];
  expect(moved.y).not.toBe(before.y);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => rectangles(await saved(page, id))[0]?.x).toBe(before.x);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => rectangles(await saved(page, id))[0]?.x).toBe(moved.x);
  await waitSaved(page);

  // A reload opens the saved file: the rectangle is there, fitted on screen.
  await page.reload();
  await expect(canvas).toBeVisible();
  await expect.poll(() => pixel(page, centre.x, centre.y).then(isShapeGrey)).toBe(true);
  expect(rectangles(await saved(page, id))).toHaveLength(1);

  // Rename in the title, then back to the files through the main menu.
  await page.locator('.dz-file-name').click();
  const title = page.getByRole('textbox', {name: 'File name', exact: true});
  await title.fill('Rectangle from the test');
  await title.press('Enter');
  await expect.poll(async () => (await saved(page, id)).file.name).toBe('Rectangle from the test');
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Back to files', exact: true}).click();
  await expect(page).toHaveURL(/#designs$/);
  await expect(page.locator('.dz-file').filter({hasText: 'Rectangle from the test'})).toBeVisible();
});

test('the menus, quick actions and shortcuts come from the command registry', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();

  // View ▸ Outline mode is a toggle with ⌘Y; the menu shows only registered commands.
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'View', exact: true}).hover();
  await expect(page.getByRole('menuitemcheckbox', {name: /Outline mode/})).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await canvas.click({position: {x: 20, y: 20}});
  await page.keyboard.press('ControlOrMeta+y');
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'View', exact: true}).hover();
  await expect(page.getByRole('menuitemcheckbox', {name: /Outline mode/})).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ⌘/ opens "Actions" (as ⌘K does); a search finds the command by name; Enter runs it.
  await canvas.click({position: {x: 20, y: 20}});
  await page.keyboard.press('ControlOrMeta+Slash');
  const quick = page.getByRole('dialog', {name: 'Actions'});
  await expect(quick).toBeVisible();
  await quick.getByRole('combobox').fill('shortcuts');
  await expect(quick.getByRole('option').first()).toContainText('Keyboard shortcuts');
  await page.keyboard.press('Enter');
  const shortcuts = page.getByRole('dialog', {name: 'Keyboard shortcuts'});
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByText('Group selection', {exact: true})).toBeVisible();
  await shortcuts.getByRole('textbox', {name: 'Search commands'}).fill('outline');
  await expect(shortcuts.getByText('Outline mode', {exact: true})).toBeVisible();
  await expect(shortcuts.getByText('Group selection', {exact: true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(shortcuts).toBeHidden();

  // Right-click on the empty canvas: paste, the interface and the zoom.
  await canvas.click({button: 'right', position: {x: 200, y: 200}});
  await expect(page.getByRole('menuitem', {name: 'Paste here', exact: true})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Zoom', exact: true})).toBeVisible();
  await page.keyboard.press('Escape');

  // "Code" loads with its first opening; with nothing selected it offers "Export to React…", the same
  // dialog as File ▸ Export to React….
  await page.getByRole('tab', {name: 'Code', exact: true}).click();
  await expect(page.getByText('Select a layer', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Export to React…', exact: true}).click();
  const reactExport = page.getByRole('dialog', {name: 'Export to React'});
  await expect(reactExport).toBeVisible();
  await reactExport.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(reactExport).toBeHidden();
  await page.getByRole('button', {name: 'Main menu', exact: true}).click();
  await page.getByRole('menuitem', {name: 'File', exact: true}).hover();
  await expect(page.getByRole('menuitem', {name: /Export to React/})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', {name: 'Design', exact: true}).click();

  // "Pages": add one, switch back.
  await page.getByRole('button', {name: 'Add page', exact: true}).click();
  await expect(page.getByRole('option', {name: 'Page 2', exact: true})).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('option', {name: 'Page 1', exact: true}).click();
  await expect(page.getByRole('option', {name: 'Page 1', exact: true})).toHaveAttribute('aria-selected', 'true');
  await waitSaved(page);
});

function seededRectangle(parentId: string) {
  return {
    id: 'e2e-rect', type: 'RECTANGLE', name: 'Rectangle 1', parentId, visible: true, locked: false, opacity: 1, blendMode: 'NORMAL', isMask: false,
    x: -100, y: -60, width: 200, height: 120, rotation: 0,
    fills: [{type: 'SOLID', color: {r: 217 / 255, g: 217 / 255, b: 217 / 255}, opacity: 1, visible: true, blendMode: 'NORMAL'}],
    strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', strokeCap: 'NONE', strokeJoin: 'MITER', strokeMiterLimit: 4, dashPattern: [], effects: [],
    constraints: {horizontal: 'MIN', vertical: 'MIN'}, layoutPositioning: 'AUTO', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
    exportSettings: [], reactions: [], cornerRadius: 0, cornerSmoothing: 0,
  };
}
