import {test, expect, waitEditorReady} from './fixtures';
import type {Locator, Page} from '@playwright/test';
import {createDocument} from '../../shared/design/defaults';
import {createVariable, createVariableCollection, setVariableValue} from '../../shared/design/variables';
import type {DesignDocument} from '../../shared/design/types';

// The variables table as Figma's (a designer's report: at 17 modes "Add mode" had scrolled away with the modes).

async function openTable(page: Page, modes: number, variables: number) {
  let doc: DesignDocument = createDocument('0:1', 'Main');
  doc = createVariableCollection(doc, {id: 'c', name: 'Theme', modes: Array.from({length: modes}, (_, i) => ({modeId: 'm' + i, name: 'Mode ' + (i + 1)}))}).doc;
  for (let i = 0; i < variables; i++) {
    doc = createVariable(doc, {id: 'v' + i, name: (i < 3 ? '' : i < 12 ? 'Spacing/' : 'Colors/Background/') + 'Value ' + (i + 1), collectionId: 'c', type: 'FLOAT'}).doc;
    doc = setVariableValue(doc, 'v' + i, 'm0', i).doc;
  }
  const created = await page.request.post('/api/design-files', {data: {name: 'Variables', document: doc}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + id);
  await waitEditorReady(page, id);
  await page.getByRole('navigation', {name: 'Navigation'}).getByRole('button', {name: 'Variables'}).click();
  const dialog = page.getByRole('dialog', {name: 'Variables'});
  await expect(dialog).toBeVisible();
  return {id, dialog};
}

const box = async (locator: Locator) => (await locator.boundingBox())!;
/** Whether `inner` lies wholly inside `outer`. */
const inside = async (inner: Locator, outer: Locator) => {
  const a = await box(inner), b = await box(outer);
  return a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
};
const scrollModes = (dialog: Locator, to: 'start' | 'middle' | 'end') => dialog.locator('.dz-variables-hbar-scroll').evaluate((bar, where) => {
  bar.scrollLeft = where === 'start' ? 0 : where === 'end' ? bar.scrollWidth : (bar.scrollWidth - bar.clientWidth) / 2;
  bar.dispatchEvent(new Event('scroll'));
}, to);

test('"Add mode" stays pinned at the head\'s right edge however many modes there are, at both ends of the scroll', async ({page, seed: _seed}) => {
  const {dialog} = await openTable(page, 1, 4);
  const add = dialog.getByRole('button', {name: 'Add mode'});
  const heads = dialog.getByRole('columnheader').filter({hasText: /^Mode \d+/});
  // Add modes until the table overflows (17, as in the report): the button never leaves the dialog.
  for (let n = 2; n <= 17; n++) {
    await add.click();
    await page.keyboard.press('Enter');
    await expect(heads).toHaveCount(n);
    expect(await inside(add, dialog), `after mode ${n}`).toBe(true);
  }
  for (const where of ['start', 'middle', 'end'] as const) {
    await scrollModes(dialog, where);
    expect(await inside(add, dialog), `scrolled to the ${where}`).toBe(true);
    // The last visible mode ends where the pinned column starts, never under it.
    const addBox = await box(add);
    const last = await box(heads.last());
    if (where === 'end') expect(last.x + last.width).toBeLessThanOrEqual(addBox.x + 0.5);
  }
  // Clickable without scrolling: a trial click (no scrolling into view) lands on it.
  await add.click({trial: true});
  await add.click();
  await page.keyboard.press('Enter');
  await expect(heads).toHaveCount(18);
  await expect(heads.last()).toBeInViewport();
});

test('the head row stays while the rows scroll, "Name" while the modes scroll; "Create variable" stays at the foot', async ({page, seed: _seed}) => {
  const {dialog} = await openTable(page, 12, 40);
  const head = dialog.getByRole('columnheader', {name: 'Name'});
  const create = dialog.getByRole('button', {name: 'Create variable'});
  const firstName = dialog.getByRole('rowheader').filter({hasText: 'Value 1'}).first();
  const before = {head: await box(head), create: await box(create), name: await box(firstName)};
  await dialog.locator('.dz-variables-scroll').evaluate(scroll => void (scroll.scrollTop = scroll.scrollHeight));
  expect((await box(head)).y).toBeCloseTo(before.head.y, 0);
  expect((await box(create)).y).toBeCloseTo(before.create.y, 0);
  expect(await inside(create, dialog)).toBe(true);
  await dialog.locator('.dz-variables-scroll').evaluate(scroll => void (scroll.scrollTop = 0));
  await scrollModes(dialog, 'end');
  expect((await box(firstName)).x).toBeCloseTo(before.name.x, 0);
  expect((await box(head)).x).toBeCloseTo(before.head.x, 0);
  // The modes did move: the first mode's head is out of the modes' view.
  const first = await box(dialog.getByRole('columnheader', {name: /^Mode 1(?!\d)/}));
  expect(first.x + first.width).toBeLessThanOrEqual(before.head.x + before.head.width + 0.5);
});

/** Opens a menu: Playwright scrolls a trigger in the sticky head into view first, and that scroll can close a menu
 *  just opened (menus close on any scroll), so the click is tried again until the menu stays. */
async function openMenu(page: Page, open: () => Promise<void>) {
  await expect(async () => {
    if (!(await page.getByRole('menu').count())) await open();
    await expect(page.getByRole('menu').first()).toBeVisible({timeout: 1000});
  }).toPass({timeout: 10_000});
}

async function saved(page: Page, id: string): Promise<DesignDocument> {
  const response = await page.request.get(`/api/design-files/${id}`);
  return ((await response.json()) as {document: DesignDocument}).document;
}

test('as Figma\'s table: a mode\'s menu and drag, column widths, folded groups, rows selected into a group, Enter down a column, an alias from a cell, search, full size', async ({page, seed: _seed}) => {
  const {id, dialog} = await openTable(page, 2, 14);
  const heads = dialog.getByRole('columnheader').filter({hasText: /^Mode \d+/});

  // A mode's "⋯": duplicate it (right after, "Mode 1 copy", with its values); then drag "Mode 2" before "Mode 1".
  await openMenu(page, () => dialog.getByRole('button', {name: 'Mode "Mode 1" actions'}).click());
  await page.getByRole('menuitem', {name: 'Duplicate mode'}).click();
  await expect(heads).toHaveText([/Mode 1(?! copy)/, /Mode 1 copy/, /Mode 2/]);
  await expect.poll(async () => {
    const doc = await saved(page, id);
    const copy = doc.variableCollections.c.modes[1].modeId;
    return doc.variables.v5.valuesByMode[copy];
  }).toBe(5);
  await heads.nth(2).dragTo(heads.nth(0));
  await expect(heads).toHaveText([/Mode 2/, /Mode 1(?! copy)/, /Mode 1 copy/]);

  // A column's edge dragged makes it wider; a double click gives the width back.
  const first = heads.nth(0);
  const before = (await first.boundingBox())!.width;
  const edge = first.getByRole('separator', {name: 'Column width'});
  const e = (await edge.boundingBox())!;
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.down();
  await page.mouse.move(e.x + 60, e.y + e.height / 2, {steps: 4});
  await page.mouse.up();
  expect((await first.boundingBox())!.width).toBeGreaterThan(before + 40);

  // Groups: "Spacing" folds and unfolds.
  const group = dialog.getByRole('row').filter({hasText: /^Spacing/});
  await group.getByRole('button', {name: 'Collapse group "Spacing"'}).click();
  await expect(dialog.getByRole('rowheader', {name: 'Value 4', exact: true})).toHaveCount(0);
  await group.getByRole('button', {name: 'Expand group "Spacing"'}).click();
  await expect(dialog.getByRole('rowheader', {name: 'Value 4', exact: true})).toBeVisible();

  // Two rows (click, ⇧-click) into "New group from selection".
  await dialog.getByRole('rowheader', {name: 'Value 1', exact: true}).click();
  await dialog.getByRole('rowheader', {name: 'Value 2', exact: true}).click({modifiers: ['Shift']});
  await openMenu(page, () => dialog.getByRole('rowheader', {name: 'Value 2', exact: true}).click({button: 'right'}));
  await page.getByRole('menuitem', {name: 'New group from selection'}).click();
  await page.keyboard.type('Basics');
  await page.keyboard.press('Enter');
  await expect.poll(async () => {
    const doc = await saved(page, id);
    return [doc.variables.v0.name, doc.variables.v1.name, doc.variables.v2.name];
  }).toEqual(['Basics/Value 1', 'Basics/Value 2', 'Value 3']);

  // A row dragged onto a group's head goes into that group.
  await dialog.getByRole('rowheader', {name: 'Value 3', exact: true}).dragTo(dialog.getByRole('row').filter({hasText: /^Spacing/}));
  await expect.poll(async () => (await saved(page, id)).variables.v2.name).toBe('Spacing/Value 3');

  // Enter in a value goes to the same mode in the next row.
  const value = (row: string) => dialog.getByRole('row').filter({has: page.getByRole('rowheader', {name: row, exact: true})}).getByRole('gridcell').first().getByRole('spinbutton');
  await value('Value 4').fill('40');
  await value('Value 4').press('Enter');
  await expect(value('Value 5')).toBeFocused();

  // A cell's menu makes an alias: a pill with the variable's name, detachable.
  await openMenu(page, () => dialog.getByRole('row').filter({has: page.getByRole('rowheader', {name: 'Value 6', exact: true})}).getByRole('gridcell').first().locator('.dz-variables-value').click({button: 'right', position: {x: 4, y: 4}}));
  await page.getByRole('menuitem', {name: 'Apply variable'}).hover();
  await page.getByRole('menuitemcheckbox', {name: 'Spacing/Value 4'}).click();
  const pill = dialog.locator('.dz-variables-alias').filter({hasText: 'Value 4'});
  await expect(pill).toBeVisible();
  await pill.getByRole('button', {name: 'Detach variable'}).click();
  await expect(pill).toHaveCount(0);

  // Search keeps the matching rows and their groups.
  await dialog.getByRole('textbox', {name: 'Search variables'}).fill('Value 13');
  await expect(dialog.getByRole('rowheader')).toHaveText([/^Colors/, /Background/, 'Value 13']);
  await dialog.getByRole('textbox', {name: 'Search variables'}).fill('');

  // Full size takes the window.
  await dialog.getByRole('button', {name: 'Full screen'}).click();
  const size = page.viewportSize()!;
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(size.width - 40);
});
