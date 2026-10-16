import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// Lane E1: the engine switch in the real editor (shared/design/engine-switch.ts). By default the editor runs geometry
// in wasm (EDITOR_DEFAULTS): the engine loads in the background, the shadow document is loaded at idle, and the
// geometry readers (worldBox, worldMatrix), the booleans and the outline stroke answer from Rust. With
// MORFA_E2E_ENGINE=geometry:both (or `?engine=geometry:both`) every one of those calls is compared with TypeScript in
// the browser, and a difference fails the page. Counters from `__MORFA_ENGINE_REPORT__()`.

type Report = {
  modes: Record<string, string>;
  byDefault: Record<string, boolean>;
  wasm: boolean;
  shadow: {nodes: number} | null;
  modules: Record<string, {ts: number; wasm: number; both: number; fallback: number; diffs: number; skipped: number}>;
  calls: Record<string, {ts: number; wasm: number; both: number; fallback: number; diffs: number; skipped: number}>;
};
const report = (page: Page) => page.evaluate(() => (globalThis as unknown as {__MORFA_ENGINE_REPORT__: () => Report}).__MORFA_ENGINE_REPORT__());

async function openNewFile(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const centre = {x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2)};
  await page.mouse.click(box.x + 30, box.y + 30);
  return (x: number, y: number) => ({x: centre.x + x, y: centre.y + y});
}

async function drag(page: Page, from: {x: number; y: number}, to: {x: number; y: number}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {steps: 4});
  await page.mouse.move(to.x, to.y, {steps: 4});
  await page.mouse.up();
}

test('geometry answers from wasm in the editor: shapes drawn, aligned, moved and unioned', async ({page, seed: _seed}) => {
  const at = await openNewFile(page);
  const start = await report(page);
  const mode = process.env.MORFA_E2E_ENGINE ? start.modes.geometry : 'wasm';
  expect(start.modes.geometry).toBe(mode);
  await page.keyboard.press('r');
  await drag(page, at(-150, -80), at(-30, 40));
  await page.keyboard.press('o');
  await drag(page, at(-60, -40), at(90, 90));
  await page.keyboard.press('ControlOrMeta+a');
  // The shadow is loaded at idle, and the engine itself in the background: wait for both.
  await expect.poll(async () => (await report(page)).shadow !== null, {timeout: 15_000}).toBe(true);
  // Align left (⌥A), nudge, then union (⌥⇧U): selection boxes, world boxes and a boolean through the switch.
  await page.keyboard.press('Alt+a');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Alt+Shift+u');
  await expect.poll(async () => {
    const calls = (await report(page)).calls;
    return (calls['geometry.worldBox']?.wasm ?? 0) > 0 && (calls['geometry.combinePaths']?.wasm ?? 0) + (calls['geometry.combinePathsLive']?.wasm ?? 0) + (calls['geometry.combineAreas']?.wasm ?? 0) + (calls['geometry.fillArea']?.wasm ?? 0) > 0;
  }, {timeout: 15_000}).toBe(true);
  const end = await report(page);
  expect(end.modules.geometry.diffs).toBe(0);
  if (mode === 'both') expect(end.modules.geometry.both).toBeGreaterThan(0);
  expect(end.byDefault.geometry).toBe(!process.env.MORFA_E2E_ENGINE);
});

// Lane N1: normalize runs in wasm by default too (crates/layout on the store's own nodes). A commit runs the whole pass
// in Rust once the shadow is in and near the store's document; before that TypeScript answers (never a load inside a
// commit: `shadowNear`, the rule geometry's readers follow).
test('normalize answers from wasm in the editor: commits after the shadow is in run the Rust pass', async ({page, seed: _seed}) => {
  const at = await openNewFile(page);
  const start = await report(page);
  const mode = process.env.MORFA_E2E_ENGINE ? start.modes.normalize : 'wasm';
  expect(start.modes.normalize).toBe(mode);
  // The first shape may commit before the shadow is loaded: TypeScript answers, counted as a fallback, never a load.
  await page.keyboard.press('r');
  await drag(page, at(-150, -80), at(-30, 40));
  await expect.poll(async () => (await report(page)).shadow !== null, {timeout: 15_000}).toBe(true);
  // Another shape and a nudge: commits whose normalize pass the Rust side runs, the shadow a patch away at most.
  await page.keyboard.press('r');
  await drag(page, at(-60, -40), at(90, 90));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await report(page)).calls['normalize.normalizeDetailed']?.wasm ?? 0, {timeout: 15_000}).toBeGreaterThan(0);
  const end = await report(page);
  expect(end.modules.normalize.diffs).toBe(0);
  if (mode === 'both') expect(end.modules.normalize.both).toBeGreaterThan(0);
  if (!process.env.MORFA_E2E_ENGINE) expect(end.byDefault.normalize).toBe(true);
});
