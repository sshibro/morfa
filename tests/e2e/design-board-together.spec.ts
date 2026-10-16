import {test, expect, fileChooser} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument} from '../../shared/design/types';

// "Working together" on a board as FigJam's help has it (help.figma.com "Stamps, emotes, and high-fives"; lane FJ): ⇧-click with the
// stamp tool bursts the stamp as an emote for everyone here and places nothing.

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
async function stamps(page: Page, id: string) {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  const file = (await response.json()) as {document: DesignDocument};
  return Object.values(file.document.nodes).filter(node => node.board?.kind === 'stamp').length;
}

test('should burst the stamp as an emote on ⇧-click with the stamp tool, and place nothing', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  // The meeting runs once co-editing is live: its timer is in the pill.
  await expect(page.locator('.bd-top-right').getByRole('button', {name: 'Timer'})).toBeVisible();
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2};
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.press('KeyE');
  await page.getByRole('menu', {name: 'Stamp wheel'}).getByRole('menuitemradio', {name: 'Fire'}).click();
  await page.keyboard.down('Shift');
  await page.mouse.click(centre.x + 120, centre.y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.dz-meet-burst').first()).toContainText('🔥');
  // A plain click still stamps.
  await page.mouse.click(centre.x - 120, centre.y);
  const id = fileIdFrom(page);
  await expect.poll(() => stamps(page, id)).toBe(1);
});

test('should grow a stamp held and wiggled on the canvas, and put it where the press began', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page.getByRole('dialog', {name: 'More: templates, stickers, stamps'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.bd-top-left').getByRole('status')).toHaveText('Saved');
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2};
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.press('KeyE');
  await page.getByRole('menu', {name: 'Stamp wheel'}).getByRole('menuitemradio', {name: 'Fire'}).click();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let k = 0; k < 8; k++) await page.mouse.move(centre.x + (k % 2 ? -30 : 30), centre.y, {steps: 4});
  await page.mouse.move(centre.x, centre.y, {steps: 2});
  await page.mouse.up();
  const id = fileIdFrom(page);
  await expect.poll(async () => {
    const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
    const file = (await response.json()) as {document: DesignDocument};
    return Object.values(file.document.nodes).find(node => node.board?.kind === 'stamp')?.width ?? 0;
  }).toBeGreaterThan(60);
});

test('should delete a section alone on ⌘⌫ and keep the sticky inside it on the board', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page.getByRole('dialog', {name: 'More: templates, stickers, stamps'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.bd-top-left').getByRole('status')).toHaveText('Saved');
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2};
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.type('Idea');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // A section drawn around the sticky takes it in.
  await page.keyboard.press('Shift+KeyS');
  await page.mouse.move(centre.x - 250, centre.y - 220);
  await page.mouse.down();
  await page.mouse.move(centre.x + 250, centre.y + 220, {steps: 8});
  await page.mouse.up();
  const id = fileIdFrom(page);
  const kinds = async () => {
    const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
    const file = (await response.json()) as {document: DesignDocument};
    const nodes = Object.values(file.document.nodes);
    const sticky = nodes.find(node => node.board?.kind === 'sticky');
    return {sections: nodes.filter(node => node.type === 'SECTION').length, stickyIn: sticky ? file.document.nodes[sticky.parentId!]?.type : null};
  };
  await expect.poll(kinds).toEqual({sections: 1, stickyIn: 'SECTION'});
  await page.keyboard.press('ControlOrMeta+Backspace');
  await expect.poll(kinds).toEqual({sections: 0, stickyIn: 'PAGE'});
});

test('should import a CSV file as a table from "Actions"', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page.getByRole('dialog', {name: 'More: templates, stickers, stamps'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.bd-top-left').getByRole('status')).toHaveText('Saved');
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('combobox').fill('CSV');
  const chooser = await fileChooser(page, () => page.keyboard.press('Enter'));
  await chooser.setFiles({name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from('Task;Who\n"Layout, first";Anna\nTexts;Boris\n')});
  const id = fileIdFrom(page);
  await expect.poll(async () => {
    const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
    const file = (await response.json()) as {document: DesignDocument};
    return Object.values(file.document.nodes).filter(node => node.type === 'TEXT').map(node => node.text?.characters).sort();
  }).toEqual(expect.arrayContaining(['Task', 'Who', 'Layout, first', 'Anna', 'Texts', 'Boris']));
});

test('should stick a highlight drawn over a sticky to the sticky', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page.getByRole('dialog', {name: 'More: templates, stickers, stamps'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.bd-top-left').getByRole('status')).toHaveText('Saved');
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const centre = {x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2};
  await page.keyboard.press('KeyS');
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.type('Idea');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+KeyM');
  await page.mouse.move(centre.x - 30, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 30, centre.y + 2, {steps: 6});
  await page.mouse.up();
  const id = fileIdFrom(page);
  await expect.poll(async () => {
    const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
    const file = (await response.json()) as {document: DesignDocument};
    const stroke = Object.values(file.document.nodes).find(node => node.board?.kind === 'stroke');
    return stroke ? file.document.nodes[stroke.parentId!]?.board?.kind : null;
  }).toBe('sticky');
});

test('should type the timer\'s minutes and seconds, step them with the arrows and start it with Return', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page.getByRole('dialog', {name: 'More: templates, stickers, stamps'})).toBeVisible();
  await page.keyboard.press('Escape');
  const pill = page.locator('.bd-top-right');
  await pill.getByRole('button', {name: 'Timer'}).click();
  const panel = page.getByRole('dialog', {name: 'Timer'});
  await panel.getByRole('textbox', {name: 'Minutes'}).fill('12');
  await panel.getByRole('textbox', {name: 'Seconds'}).click();
  await panel.getByRole('textbox', {name: 'Seconds'}).fill('30');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(panel.getByRole('textbox', {name: 'Seconds'})).toHaveValue('35');
  await page.keyboard.press('Enter');
  await expect(pill.locator('.dz-meet-timer')).toHaveAttribute('aria-label', /Timer: 12:3\d/);
});

test('should run a vote with a prompt and hidden cursors, then find it among the past votes', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New board', exact: true}).first().click();
  await expect(page.getByRole('dialog', {name: 'More: templates, stickers, stamps'})).toBeVisible();
  await page.keyboard.press('Escape');
  const pill = page.locator('.bd-top-right');
  await expect(pill.getByRole('button', {name: 'Timer'})).toBeVisible();
  await pill.getByRole('button', {name: 'Reactions and meeting'}).click();
  await page.getByRole('button', {name: /^Voting…/}).click();
  const setup = page.getByRole('dialog', {name: 'Voting'});
  await setup.getByRole('textbox', {name: 'Voting question'}).fill('Pick the three best ideas');
  await expect(setup.getByRole('checkbox', {name: 'Hide participants’ cursors'})).toBeChecked();
  await setup.getByRole('button', {name: 'Start voting'}).click();
  const bar = page.getByRole('region', {name: 'Voting'});
  await expect(bar).toContainText('Pick the three best ideas');
  await expect(page.locator('.dz[data-meet-hide-cursors="true"]')).toHaveCount(1);
  await bar.getByRole('button', {name: 'End', exact: true}).click();
  await bar.getByRole('button', {name: 'End for everyone'}).click();
  await expect(page.getByRole('region', {name: 'Voting results'})).toContainText('Pick the three best ideas');
  await expect(page.locator('.dz[data-meet-hide-cursors="true"]')).toHaveCount(0);
  await pill.getByRole('button', {name: 'Reactions and meeting'}).click();
  await page.getByRole('button', {name: /^Past votes/}).click();
  await expect(page.getByRole('dialog', {name: 'Past votes'})).toContainText('Pick the three best ideas');
});
