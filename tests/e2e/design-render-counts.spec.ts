import {test, expect, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import {createDocument, createNode} from '../../shared/design/defaults';
import {createBoardDocument} from '../../shared/design/board/document';
import {createSticky, insertPieces} from '../../shared/design/board/create';
import {beginTransaction} from '../../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';

// "Morfa Design": what React re-renders while a designer drags and pans (docs/design-tool.md §Performance). Counts are
// taken with a React DevTools hook installed before the app loads (the commit walk DevTools does), so they do not
// depend on the machine's speed. Measured on 2026-10-07 before the fixes: dragging a frame re-rendered ~45 components
// of "Position" on every frame (rows handed fresh callbacks while only X and Y changed), and dragging a sticky re-rendered
// the board's hidden context toolbar on every frame.

type Counts = {commits: number; renders: Record<string, number>};
type StoreState = {doc: DesignDocument; pageId: NodeId; viewports: Record<NodeId, {x: number; y: number; zoom: number}>};
type TestWindow = {
  __counts: {start(): void; read(): Counts};
  __morfaDesignTest: {store: {getState(): StoreState; setSelection(ids: NodeId[]): void; setViewport(viewport: {x: number; y: number; zoom: number}): void}};
};

/** Installs the counting hook before the app loads; `window.__counts` starts and reads a count. */
async function countRenders(page: Page) {
  await page.addInitScript(() => {
    type Named = {displayName?: string; name?: string; type?: {displayName?: string; name?: string}; render?: {name?: string}};
    type Fiber = {tag: number; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; type?: Named; elementType?: Named};
    const COMPONENTS = new Set([0, 1, 11, 14, 15]);
    let counts: Map<string, number> | null = null;
    let commits = 0;
    const nameOf = (fiber: Fiber) => fiber.elementType?.displayName || fiber.type?.displayName || fiber.type?.name || fiber.type?.type?.displayName || fiber.type?.type?.name || fiber.type?.render?.name || '?';
    const walk = (next: Fiber, previous: Fiber | null) => {
      // Rendered in this commit: mounted, or PerformedWork on a component fiber (as React DevTools reads it).
      if (COMPONENTS.has(next.tag) && (!previous || (next.flags & 1) === 1)) {
        const name = nameOf(next).replace(/\d+$/, '');
        counts!.set(name, (counts!.get(name) ?? 0) + 1);
      }
      if (previous && next.child === previous.child) return;
      for (let child = next.child; child; child = child.sibling) walk(child, child.alternate);
    };
    const renderers = new Map<number, unknown>();
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        renderers, supportsFiber: true, isDisabled: false,
        inject(renderer: unknown) {
          renderers.set(renderers.size + 1, renderer);
          return renderers.size;
        },
        onCommitFiberRoot(_id: number, root: {current: Fiber}) {
          if (!counts) return;
          commits++;
          walk(root.current, root.current.alternate);
        },
        onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, setStrictMode() {}, onScheduleFiberRoot() {},
      },
      __counts: {
        start() {
          counts = new Map();
          commits = 0;
        },
        read: () => ({commits, renders: Object.fromEntries(counts ?? [])}),
      },
    });
  });
}

const start = (page: Page) => page.evaluate(() => (window as unknown as TestWindow).__counts.start());
const read = (page: Page) => page.evaluate(() => (window as unknown as TestWindow).__counts.read());
const total = (counts: Counts) => Object.values(counts.renders).reduce((sum, n) => sum + n, 0);
const frames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const select = (page: Page, ids: NodeId[]) => page.evaluate(list => (window as unknown as TestWindow).__morfaDesignTest.store.setSelection(list), ids);
const view = (page: Page, viewport: {x: number; y: number; zoom: number}) => page.evaluate(next => (window as unknown as TestWindow).__morfaDesignTest.store.setViewport(next), viewport);

async function openFile(page: Page, document: DesignDocument, kind?: 'board') {
  await page.goto('/#designs');
  const response = await page.request.post('/api/design-files', {headers: {Origin: new URL(page.url()).origin}, data: {name: 'Counters', document, ...(kind ? {kind} : {})}});
  expect(response.ok(), await response.text()).toBeTruthy();
  const {file} = (await response.json()) as {file: {id: string}};
  await page.goto('/#design/' + file.id);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as Partial<TestWindow>).__morfaDesignTest)).toBe(true);
  // Counting starts after the open settles: the first "Saved" re-renders the editor's chrome once, and co-editing and the
  // meeting mount after it (their chunks, /collab, /meeting's first read) — on a slow machine inside a measured gesture.
  await waitEditorReady(page, file.id);
}

/** A point of the node on screen (client px): its centre, or `at` (0..1 of its width and height). */
async function centreOf(page: Page, id: NodeId, at = {x: 0.5, y: 0.5}) {
  const box = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const point = await page.evaluate(([target, fraction]) => {
    const state = (window as unknown as TestWindow).__morfaDesignTest.store.getState();
    const viewport = state.viewports[state.pageId];
    let x = 0, y = 0;
    let node: SceneNode | undefined = state.doc.nodes[target as NodeId];
    const {width, height} = node!;
    while (node && node.type !== 'PAGE') {
      x += node.x;
      y += node.y;
      node = node.parentId ? state.doc.nodes[node.parentId] : undefined;
    }
    return {x: (x + width * fraction.x - viewport.x) * viewport.zoom, y: (y + height * fraction.y - viewport.y) * viewport.zoom};
  }, [id, at] as const);
  return {x: box.x + point.x, y: box.y + point.y};
}

/** Four screens of thirty layers: enough to fill the layers panel and the "Design" panel. */
function screens(): DesignDocument {
  const doc = createDocument('page', 'Page');
  const add = (node: SceneNode, parentId: NodeId) => {
    doc.nodes[node.id] = {...node, parentId};
    doc.nodes[parentId] = {...doc.nodes[parentId], children: [...(doc.nodes[parentId].children ?? []), node.id]};
  };
  for (let s = 0; s < 4; s++) {
    add(createNode('FRAME', {id: `screen${s}`, name: `Screen ${s + 1}`, x: s * 500, y: 0, width: 400, height: 600, cornerRadius: 8}), 'page');
    for (let i = 0; i < 30; i++) add(createNode(i % 2 ? 'RECTANGLE' : 'ELLIPSE', {id: `s${s}n${i}`, name: `Layer ${i + 1}`, x: 20 + (i % 5) * 70, y: 20 + Math.floor(i / 5) * 90, width: 60, height: 60}), `screen${s}`);
  }
  return doc;
}

test('dragging a frame re-renders only the X and Y of "Position"; panning re-renders no section', async ({page, seed: _seed}) => {
  await countRenders(page);
  await openFile(page, screens());
  await view(page, {x: 300, y: -100, zoom: 1});
  await select(page, ['screen1']);
  await expect(page.getByRole('spinbutton', {name: 'Position X'})).toHaveValue('500');
  // A spot of the frame no layer covers (its bottom right).
  const from = await centreOf(page, 'screen1', {x: 0.96, y: 0.97});
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 8, {steps: 2});
  await frames(page);
  await start(page);
  const steps = 20;
  for (let k = 1; k <= steps; k++) await page.mouse.move(from.x + 12 + k * 5, from.y + 8 + k * 3);
  const drag = await read(page);
  await test.info().attach('drag render counts', {body: JSON.stringify(drag), contentType: 'application/json'});
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).__morfaDesignTest.store.getState().doc.nodes.screen1.x)).toBeGreaterThan(560);
  expect(drag.commits, JSON.stringify(drag)).toBeGreaterThanOrEqual(steps / 2);
  // The section, its PanelSection and the X/Y row (Row, two PanelNumber, two NumberField) at most.
  expect(total(drag) / drag.commits, JSON.stringify(drag)).toBeLessThanOrEqual(10);
  for (const quiet of ['BindableNumber', 'VariableBindButton', 'IconButton', 'SmoothingField', 'Checkbox', 'SelectionHeader', 'LayerRow', 'LayersTree'])
    expect(drag.renders[quiet] ?? 0, `${quiet} re-rendered during the drag: ${JSON.stringify(drag)}`).toBe(0);

  // A pan with the frame selected changes none of the panels' values.
  const box = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 160);
  await start(page);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(i % 2 ? 30 : -30, 15);
  await frames(page);
  const pan = await read(page);
  await test.info().attach('pan render counts', {body: JSON.stringify(pan), contentType: 'application/json'});
  for (const quiet of ['DesignSections', 'PositionSection', 'SelectionHeader', 'PanelNumber', 'LayersPanel', 'PagesPanel'])
    expect(pan.renders[quiet] ?? 0, `${quiet} re-rendered during the pan: ${JSON.stringify(pan)}`).toBe(0);
});

test('dragging a sticky re-renders nothing of the board\'s chrome', async ({page, seed: _seed}) => {
  await countRenders(page);
  let seq = 0;
  const newId = () => `b${++seq}`;
  const tx = beginTransaction(createBoardDocument('page'));
  for (let i = 0; i < 12; i++) insertPieces(tx, createSticky(newId, {x: (i % 4) * 280, y: Math.floor(i / 4) * 280, text: `Idea ${i + 1}`}), 'page');
  const doc = tx.commit({measurer: {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})}}).doc;
  await openFile(page, doc, 'board');
  const sticky = await page.evaluate(() => {
    const state = (window as unknown as TestWindow).__morfaDesignTest.store.getState();
    return state.doc.nodes[state.pageId].children![0];
  });
  await view(page, {x: -200, y: -200, zoom: 1});
  await select(page, [sticky]);
  await expect(page.getByRole('toolbar', {name: 'Selection properties'})).toBeVisible();
  const from = await centreOf(page, sticky);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // The drag begins (the toolbar hides, once); its frames are counted.
  await page.mouse.move(from.x + 12, from.y + 8, {steps: 2});
  await frames(page);
  await start(page);
  for (let k = 1; k <= 15; k++) await page.mouse.move(from.x + 12 + k * 6, from.y + 8 + k * 4);
  const drag = await read(page);
  await test.info().attach('drag render counts', {body: JSON.stringify(drag), contentType: 'application/json'});
  await page.mouse.up();
  await expect.poll(() => page.evaluate(id => (window as unknown as TestWindow).__morfaDesignTest.store.getState().doc.nodes[id].x, sticky)).toBeGreaterThan(80);
  expect(total(drag), JSON.stringify(drag)).toBe(0);
  // After the drop the toolbar is back over the sticky.
  await expect(page.getByRole('toolbar', {name: 'Selection properties'})).toBeVisible();
});

test('an edit while "Assets" is open re-renders none of the component items', async ({page, seed: _seed}) => {
  // Every item re-rendered on every edit (2026-10-07: 600 items of a big library on each nudge) because the section handed them
  // a menu callback made anew each render.
  await countRenders(page);
  const doc = createDocument('page', 'Components');
  const add = (node: SceneNode) => {
    doc.nodes[node.id] = {...node, parentId: 'page'};
    doc.nodes.page = {...doc.nodes.page, children: [...doc.nodes.page.children!, node.id]};
  };
  for (let i = 0; i < 24; i++) add(createNode('COMPONENT', {id: `c${i}`, name: `Button ${i + 1}`, x: (i % 6) * 120, y: Math.floor(i / 6) * 120, width: 100, height: 40}));
  add(createNode('RECTANGLE', {id: 'r', name: 'Rectangle', x: 0, y: 600, width: 100, height: 100}));
  await openFile(page, doc);
  await page.getByRole('tab', {name: 'Assets'}).click();
  await expect(page.locator('[data-asset-id="c23"]')).toBeVisible();
  await frames(page);
  await start(page);
  await page.evaluate(() => {
    const store = (window as unknown as {__morfaDesignTest: {store: {transact(label: string, recipe: (tx: {get(id: string): SceneNode; update(id: string, partial: Partial<SceneNode>): void}) => void): void}}}).__morfaDesignTest.store;
    store.transact('Shift', tx => tx.update('r', {x: tx.get('r').x + 10}));
  });
  await frames(page);
  const edit = await read(page);
  await test.info().attach('edit render counts', {body: JSON.stringify(edit), contentType: 'application/json'});
  expect(edit.renders.ComponentItem ?? 0, JSON.stringify(edit)).toBe(0);
});
