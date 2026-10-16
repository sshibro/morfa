import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';

// "Morfa Design": the "Code" tab as Figma's Dev Mode (docs/design-tool.md §Design to code). On the "UI kit" template: a variant
// set reads as a component (its props with types and defaults, the states that became CSS) with a playground that writes the
// usage for any props; the code's settings (units, colours) change every value and are remembered; CSS reads as code or as a
// list; an icon drawn in every variant is one asset; the panel keeps its own, wider width; and nothing in "Code" changes the
// design but annotations: a nudge or a delete is refused with a way back to "Design".

type Probe = {getState(): {selection: readonly NodeId[]; doc: DesignDocument; ui: {devMode: boolean}}; setSelection(ids: readonly NodeId[]): void};

const probe = (page: Page) => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest);

async function openKit(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file from a template', exact: true}).click();
  await page.getByRole('button', {name: /^UI kit/}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/, {timeout: 20_000});
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible({timeout: 30_000});
  await waitEditorReady(page);
  await expect.poll(() => probe(page)).toBe(true);
}

/** Selects the first layer of `type` named `name` (the layers panel would need the tree unfolded). */
async function select(page: Page, type: SceneNode['type'], name: string, where?: string): Promise<NodeId> {
  const id = await page.evaluate(([type, name, where]) => {
    const store = (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store;
    const {doc} = store.getState();
    const node = Object.values(doc.nodes).find(n => n.type === type && n.name === name && (!where || doc.nodes[n.parentId ?? '']?.name === where));
    if (node) store.setSelection([node.id]);
    return node?.id ?? null;
  }, [type, name, where ?? ''] as const);
  expect(id, `${type} "${name}"`).toBeTruthy();
  return id!;
}

const nodeOf = (page: Page, id: NodeId) => page.evaluate(nodeId => {
  const node = (window as unknown as {__morfaDesignTest: {store: Probe}}).__morfaDesignTest.store.getState().doc.nodes[nodeId];
  return node ? {x: node.x, name: node.name} : null;
}, id);

const panel = (page: Page) => page.getByRole('complementary', {name: 'Properties'});

test('"Code": a variant set as a component, its playground, the code\'s settings, CSS as a list, the assets', async ({page, seed: _seed}) => {
  test.setTimeout(90_000);
  await openKit(page);
  const right = panel(page);
  const designWidth = (await right.boundingBox())!.width;
  await page.keyboard.press('Shift+d');
  await expect(page.getByRole('tab', {name: 'Code', exact: true})).toHaveAttribute('aria-selected', 'true');
  // "Code" keeps its own, wider panel; "Design" gets its width back.
  await expect.poll(async () => (await right.boundingBox())!.width).toBe(320);
  expect(designWidth).toBe(240);

  await select(page, 'COMPONENT_SET', 'Button');
  await expect(right.locator('.dz-code-header-name')).toHaveText('Button');
  const component = right.locator('.dz-code-component');
  await expect(component.locator('.dz-code-component-name')).toHaveText('<Button>');
  await expect(component.locator('.dz-code-component-element')).toHaveText('<button>');
  await expect(component.locator('.dz-code-prop-name')).toHaveText(['variant?', 'disabled?', 'children?', 'showIcon?']);
  await expect(component.locator('.dz-code-prop-type').first()).toHaveText("'primary' | 'secondary' | 'outline' | 'text'");
  await expect(component.locator('.dz-code-states')).toContainText(':hover');
  await expect(component.locator('.dz-code-states')).toContainText(':disabled');

  // The playground: any props, the usage that gives them; "Reset" goes back.
  await component.getByRole('button', {name: 'Playground', exact: true}).click();
  const playground = component.locator('.dz-code-playground');
  const usage = playground.locator('.dz-code-block');
  await expect(usage).toContainText('<Button>Button</Button>');
  await playground.getByRole('button', {name: 'Property variant', exact: true}).click();
  await page.getByRole('menuitemradio', {name: /^outline/}).click();
  await playground.getByRole('switch', {name: 'Property disabled', exact: true}).click();
  await playground.getByRole('switch', {name: 'Property showIcon', exact: true}).click();
  await playground.getByRole('textbox', {name: 'Property children', exact: true}).fill('Later');
  await expect(usage).toContainText('<Button variant="outline" disabled showIcon={false}>Later</Button>');
  await playground.getByRole('button', {name: 'Reset', exact: true}).click();
  await expect(usage).toContainText('<Button>Button</Button>');

  // The code: React + CSS Modules by default, the component's files as tabs.
  const code = right.locator('.dz-code-section');
  await expect(code.getByRole('button', {name: 'Code language', exact: true})).toContainText('React + CSS Modules');
  await expect(code.getByRole('tab', {name: 'Button.tsx', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(code.locator('.dz-code-output')).toContainText("export function Button({variant = 'primary'");

  // Layout in px, then rem from the settings (remembered after a reload).
  await expect(right.locator('.dz-code-measure').filter({hasText: 'Corner radius'})).toContainText('5px');
  await code.getByRole('button', {name: 'Code settings', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'rem (1rem = 16px)', exact: true}).click();
  await expect(right.locator('.dz-code-measure').filter({hasText: /^Height/})).toContainText('16.25rem');

  // CSS as a list of values.
  await code.getByRole('button', {name: 'Code language', exact: true}).click();
  await page.getByRole('menuitemradio', {name: 'CSS', exact: true}).click();
  await code.getByRole('radiogroup', {name: 'CSS view'}).getByRole('radio', {name: 'List'}).click();
  await expect(code.locator('.dz-code-list .dz-code-measure-label').first()).toBeVisible();
  await expect(code.locator('.dz-code-list')).toContainText('border-radius');

  // The icon of every variant is one asset, named as the code names it.
  const assets = right.locator('.dz-code-asset').filter({hasText: 'button-icon.svg'});
  await expect(assets).toHaveCount(1);
  await expect(assets).toContainText('12 layers');

  await page.reload();
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible({timeout: 30_000});
  await page.keyboard.press('Shift+d');
  await expect.poll(() => probe(page)).toBe(true);
  await select(page, 'COMPONENT_SET', 'Button');
  await expect(right.locator('.dz-code-section').getByRole('button', {name: 'Code language', exact: true})).toHaveText('CSS');
  await expect(right.locator('.dz-code-measure').filter({hasText: /^Height/})).toContainText('16.25rem');
  await expect(right.locator('.dz-code-list')).toBeVisible();
});

test('"Code": an instance shows its usage; a nudge, a delete or a duplicate changes nothing and says how to edit', async ({page, seed: _seed}) => {
  test.setTimeout(90_000);
  await openKit(page);
  await page.keyboard.press('Shift+d');
  const right = panel(page);
  const id = await select(page, 'INSTANCE', 'Button', 'Actions');
  const before = (await nodeOf(page, id))!;
  await expect(right.locator('.dz-code-component')).toContainText('Component instance');
  await expect(right.locator('.dz-code-section')).toContainText('<Button showIcon={false}>Open</Button>');

  // Keys that edit do nothing here.
  await page.getByRole('application', {name: 'Canvas'}).focus();
  await page.keyboard.press('ArrowRight');
  const notice = page.getByText("The design can't be edited in Dev Mode, only annotations and measurements.");
  await expect(notice).toBeVisible();
  await page.keyboard.press('Delete');
  await page.keyboard.press('ControlOrMeta+d');
  expect(await nodeOf(page, id)).toEqual(before);

  // The toast's button goes back to "Design", where the same key moves the button after its neighbour (auto layout).
  await page.getByRole('button', {name: 'Back to Design', exact: true}).click();
  await expect(page.getByRole('tab', {name: 'Design', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBe(240);
  await page.getByRole('application', {name: 'Canvas'}).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await nodeOf(page, id))!.x).toBeGreaterThan(before.x);
});
