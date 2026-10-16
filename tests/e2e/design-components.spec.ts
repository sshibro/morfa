import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import {createDocument, createNode, defaultTextProps, solid} from '../../shared/design/defaults';
import {syncInstances} from '../../shared/design/components';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';

// Morfa Design components in the real editor (docs/design-tool.md §The document): properties added from the
// "Component" section open their editor and drive the instances; a layer hidden inside an instance with ⇧⌘H stays
// hidden when the main changes; "Select all instances" from the canvas menu; an instance copied into another file
// becomes a frame there instead of claiming its main was deleted. Needs ENABLE_DESIGN_TOOL=1 (scripts/e2e-server.ts).

type Store = {
  getState(): {doc: DesignDocument; selection: NodeId[]};
  setSelection(ids: NodeId[]): void;
  transact(label: string, recipe: (tx: {update(id: NodeId, partial: Partial<SceneNode>): void}) => void): void;
};
const origin = (page: Page) => new URL(page.url()).origin;
const store = <T,>(page: Page, run: (store: Store, arg: unknown) => T, arg?: unknown) =>
  page.evaluate(([source, value]) => new Function('store', 'arg', `return (${source})(store, arg)`)((window as unknown as {__morfaDesignTest: {store: Store}}).__morfaDesignTest.store, value), [run.toString(), arg] as const) as Promise<T>;
const nodes = (page: Page) => store(page, s => s.getState().doc.nodes);
const select = (page: Page, ids: NodeId[]) => store(page, (s, arg) => s.setSelection(arg as NodeId[]), ids);

function build(recipe: (add: (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => void) => void): DesignDocument {
  let doc = createDocument('page', 'Page 1');
  recipe((type, props) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  });
  return syncInstances(doc, new Set(Object.keys(doc.nodes)));
}

/** "Card" (a badge and a title) with two instances, and "Button" with a dot. */
const kit = () => build(add => {
  add('COMPONENT', {id: 'card', parentId: 'page', name: 'Card', x: 100, y: 100, width: 240, height: 120, fills: [solid({r: 1, g: 1, b: 1})]});
  add('RECTANGLE', {id: 'badge', parentId: 'card', name: 'Badge', x: 16, y: 16, width: 32, height: 32, fills: [solid({r: 0.95, g: 0.28, b: 0.13})]});
  add('TEXT', {id: 'title', parentId: 'card', name: 'Title', x: 16, y: 64, width: 200, height: 24, text: {...defaultTextProps('Title'), textAutoResize: 'NONE'}});
  add('INSTANCE', {id: 'i1', parentId: 'page', name: 'Card', x: 400, y: 100, width: 240, height: 120, componentId: 'card'});
  add('INSTANCE', {id: 'i2', parentId: 'page', name: 'Card', x: 400, y: 300, width: 240, height: 120, componentId: 'card'});
  add('COMPONENT', {id: 'btn', parentId: 'page', name: 'Button', x: 100, y: 500, width: 160, height: 40, fills: [solid({r: 0.05, g: 0.6, b: 1})]});
  add('ELLIPSE', {id: 'dot', parentId: 'btn', name: 'Dot', x: 140, y: 16, width: 8, height: 8, fills: [solid({r: 1, g: 1, b: 1})]});
});

async function create(page: Page, name: string, document?: DesignDocument) {
  const response = await page.request.post('/api/design-files', {headers: {Origin: origin(page)}, data: {name, ...(document ? {document} : {})}});
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as {file: {id: string}}).file.id;
}

async function open(page: Page, id: string, name: string) {
  await page.goto('/#design/' + id);
  await expect(page).toHaveTitle(`${name} — Design`, {timeout: 30_000});
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await waitEditorReady(page);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: {store: unknown}}).__morfaDesignTest?.store)).toBe(true);
}

/** The middle of a top-level layer on screen. */
async function centreOf(page: Page, id: NodeId) {
  const area = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const {node, viewport} = await store(page, (s, arg) => {
    const state = s.getState() as unknown as {doc: DesignDocument; pageId: string; viewports: Record<string, {x: number; y: number; zoom: number}>};
    return {node: state.doc.nodes[arg as string], viewport: state.viewports[state.pageId] ?? {x: 0, y: 0, zoom: 1}};
  }, id);
  return {x: area.x + (node.x + node.width / 2 - viewport.x) * viewport.zoom, y: area.y + (node.y + node.height / 2 - viewport.y) * viewport.zoom};
}

test('a property added in "Component" opens its editor, binds a layer and drives the instance; a variant property takes a free name', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  await page.goto('/#designs');
  const id = await create(page, 'Properties', kit());
  await open(page, id, 'Properties');
  await select(page, ['btn']);
  await page.getByRole('button', {name: 'Add property'}).click();
  await page.getByRole('menuitem', {name: 'Boolean'}).click();
  const editor = page.getByRole('dialog', {name: 'Property "Property 1"'});
  await expect(editor, 'the new property opens its editor at once').toBeVisible();
  await editor.getByRole('button', {name: 'Bind layer'}).click();
  await page.getByRole('menuitemcheckbox', {name: /Dot/}).or(page.getByRole('menuitem', {name: /Dot/})).first().click();
  await expect(editor).toContainText('Dot');
  await page.keyboard.press('Escape');
  expect((await nodes(page)).dot.componentPropertyReferences?.visible).toMatch(/^Property 1#/);

  // An instance shows the switch; off hides its dot.
  await page.getByRole('button', {name: 'More component actions'}).click();
  await page.getByRole('menuitem', {name: 'Create instance'}).click();
  const instance = (await store(page, s => s.getState().selection))[0];
  await page.locator('.dz-cmp-row').filter({hasText: 'Property 1'}).getByRole('switch').click();
  await expect.poll(async () => (await nodes(page))[`${instance};dot`]?.visible).toBe(false);

  // "+ → Variant" makes a set whose variant property is not called "Property 1" a second time.
  await select(page, ['btn']);
  await page.getByRole('button', {name: 'Add property'}).click();
  await page.getByRole('menuitem', {name: 'Variant'}).click();
  await expect.poll(async () => Object.values(await nodes(page)).find(node => node.type === 'COMPONENT_SET')?.componentPropertyDefinitions?.['Property 2']?.type).toBe('VARIANT');
  await select(page, [instance]);
  const rows = await page.locator('.dz-cmp-row .dz-cmp-label').allInnerTexts();
  expect(new Set(rows).size, rows.join(', ')).toBe(rows.length);

  // A new property opens with its name selected: typing names it.
  const setId = Object.values(await nodes(page)).find(node => node.type === 'COMPONENT_SET')!.id;
  await select(page, [setId]);
  await page.getByRole('button', {name: 'Add property'}).click();
  await page.getByRole('menuitem', {name: 'Text', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'Property name'})).toBeFocused();
  await page.keyboard.type('Label');
  await page.keyboard.press('Enter');
  await expect.poll(async () => Object.keys((await nodes(page))[setId].componentPropertyDefinitions ?? {}).some(key => key.startsWith('Label#'))).toBe(true);
});

test('⇧⌘H inside an instance survives the main; "Select all instances"; an instance pasted in another file becomes a frame', async ({page, context, seed: _seed}) => {
  test.setTimeout(150_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#designs');
  const id = await create(page, 'Cards', kit());
  const other = await create(page, 'Other file');
  await open(page, id, 'Cards');

  // ⇧⌘H on the badge of "i1": an override the main's change does not undo.
  await select(page, ['i1;badge']);
  await page.keyboard.press('ControlOrMeta+Shift+h');
  await expect.poll(async () => (await nodes(page))['i1;badge'].visible).toBe(false);
  await store(page, s => s.transact('Width', tx => tx.update('badge', {width: 48})));
  const after = await nodes(page);
  expect(after['i1;badge'].width).toBe(48);
  expect(after['i1;badge'].visible).toBe(false);
  expect(after['i2;badge'].visible).toBe(true);

  // The canvas menu of the main: "Select all instances".
  await select(page, ['card']);
  const at = await centreOf(page, 'card');
  await page.mouse.click(at.x, at.y, {button: 'right'});
  await page.getByRole('menuitem', {name: 'Select all instances'}).click();
  await expect.poll(async () => [...await store(page, s => s.getState().selection)].sort()).toEqual(['i1', 'i2']);

  // Copy "i2" and paste it into the other file: a frame that looks the same, and the reason why.
  await select(page, ['i2']);
  await page.keyboard.press('ControlOrMeta+c');
  await open(page, other, 'Other file');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.getByText(/stayed in another file, so the instance was pasted as a frame/)).toBeVisible();
  const pasted = (await store(page, s => s.getState().selection))[0];
  const pastedNodes = await nodes(page);
  expect(pastedNodes[pasted].type).toBe('FRAME');
  expect(pastedNodes[pasted].children!.map(child => pastedNodes[child].name).sort()).toEqual(['Badge', 'Title']);
  await expect(page.getByText('Main component deleted')).toHaveCount(0);
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
});

test('a nested instance exposed from "Properties" shows its properties on the main\'s instances', async ({page, seed: _seed}) => {
  test.setTimeout(120_000);
  // "Button" with a text property "Label"; "Card" holds an instance of it; "c1" is an instance of the card.
  const doc = build(add => {
    add('COMPONENT', {id: 'btn', parentId: 'page', name: 'Button', x: 100, y: 100, width: 160, height: 40, fills: [solid({r: 0.05, g: 0.6, b: 1})],
      componentPropertyDefinitions: {'Label#1': {type: 'TEXT', defaultValue: 'Button'}}});
    add('TEXT', {id: 'label', parentId: 'btn', name: 'Label', x: 16, y: 10, width: 120, height: 20, text: {...defaultTextProps('Button'), textAutoResize: 'NONE'},
      componentPropertyReferences: {characters: 'Label#1'}});
    add('COMPONENT', {id: 'card', parentId: 'page', name: 'Card', x: 100, y: 300, width: 300, height: 160, fills: [solid({r: 1, g: 1, b: 1})]});
    add('INSTANCE', {id: 'nested', parentId: 'card', name: 'Button', x: 16, y: 100, width: 160, height: 40, componentId: 'btn'});
    add('INSTANCE', {id: 'c1', parentId: 'page', name: 'Card', x: 500, y: 300, width: 300, height: 160, componentId: 'card'});
  });
  await page.goto('/#designs');
  const id = await create(page, 'Nested', doc);
  await open(page, id, 'Nested');
  await select(page, ['card']);
  await page.getByRole('button', {name: 'Add property'}).click();
  await page.getByRole('menuitemcheckbox', {name: 'Button'}).or(page.getByRole('menuitem', {name: 'Button', exact: true})).first().click();
  await expect.poll(async () => (await nodes(page))['c1;nested']?.isExposedInstance).toBe(true);

  await select(page, ['c1']);
  const exposed = page.getByRole('group', {name: '"Button" properties'});
  await expect(exposed).toBeVisible();
  await exposed.getByRole('textbox', {name: 'Label'}).fill('Buy');
  await exposed.getByRole('textbox', {name: 'Label'}).press('Enter');
  await expect.poll(async () => (await nodes(page))['c1;nested;label']?.text?.characters).toBe('Buy');
  expect((await nodes(page))['nested;label'].text?.characters).toBe('Button');
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
});
