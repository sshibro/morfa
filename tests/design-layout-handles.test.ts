import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {AutoLayout, DesignDocument, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore, currentViewport} from '../src/design/engine/store';
import {NO_SNAP, type ToolContext, type ToolPointerEvent} from '../src/design/engine/tools/types';
import {pageToScreen, screenToPage} from '../src/design/engine/viewport';
import {MoveTool} from '../src/design/engine/tools/move';
import {barOf, hitLayoutHandle, layoutHandles, type LayoutHandle} from '../src/design/engine/layout-handles';

// Auto layout's padding and gap on the canvas (src/design/engine/layout-handles.ts, the move tool; docs/figma-parity.md 3.5):
// a selected auto-layout frame's padding bands and gaps have bars; a drag of one sets that padding (Alt: the opposite one
// too, Alt and Shift: all four) or the gap (from "Auto" it becomes fixed), as one undo step.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const VIEW = {x: 0, y: 0, zoom: 1};

function row(layout: Partial<AutoLayout> = {}): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  const base = createNode('FRAME', {id: 'x'}).autoLayout!;
  tx.create(createNode('FRAME', {id: 'row', x: 100, y: 100, width: 400, height: 200, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
    autoLayout: {...base, layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingTop: 10, paddingRight: 20, paddingBottom: 30, paddingLeft: 40, ...layout}}) as SceneNode, 'page');
  for (const id of ['a', 'b', 'c']) tx.create(createNode('RECTANGLE', {id, width: 50, height: 50}) as SceneNode, 'row');
  return tx.commit({measurer}).doc;
}

const handleOf = (doc: DesignDocument, pick: (h: LayoutHandle) => boolean) => {
  const handles = layoutHandles(doc, 'row', VIEW)!;
  return {handles, handle: handles.handles.find(pick)!};
};

test('a selected auto-layout frame has a bar in each padding band and in each gap, at the values it holds', () => {
  const doc = row();
  const {handles} = handleOf(doc, () => true);
  const padding = handles.handles.filter(h => h.kind === 'padding');
  assert.deepEqual(padding.map(h => h.kind === 'padding' && [h.side, h.value]), [['top', 10], ['right', 20], ['bottom', 30], ['left', 40]]);
  const gaps = handles.handles.filter(h => h.kind === 'gap');
  assert.equal(gaps.length, 2);
  // The children sit at 40, 98, 156 (left padding 40, 50 wide, gap 8): the gaps are 90–98 and 148–156, within the padding.
  assert.deepEqual(gaps.map(h => h.area), [{x: 90, y: 10, width: 8, height: 160}, {x: 148, y: 10, width: 8, height: 160}]);
  assert.ok(gaps.every(h => h.value === 8));
  // Each bar answers to the pointer at its middle.
  for (const h of handles.handles) {
    const [a, b] = barOf(handles, h, VIEW);
    assert.equal(hitLayoutHandle(handles, {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, VIEW), h);
  }
});

test('no bars on a frame without auto layout, a grid, or one too small on screen; no gap bars while it wraps', () => {
  assert.equal(layoutHandles(row({layoutMode: 'NONE'}), 'row', VIEW), null);
  assert.equal(layoutHandles(row(), 'row', {x: 0, y: 0, zoom: 0.1}), null, '40 × 20 px on screen');
  assert.equal(layoutHandles(row({layoutWrap: 'WRAP'}), 'row', VIEW)!.handles.filter(h => h.kind === 'gap').length, 0);
});

function setupContext(store: ReturnType<typeof createDesignStore>): ToolContext {
  return {
    store, measurer, snap: NO_SNAP, index: () => null, setCursor: () => {}, requestOverlay: () => {}, setOverlayItems: () => {}, enterEdit: () => {},
    setTool: id => store.setTool(id), modifiers: () => ({shift: false, alt: false, mod: false}),
    view: {
      viewport: () => currentViewport(store.getState()), size: () => ({width: 1000, height: 800}),
      screenToPage: p => screenToPage(currentViewport(store.getState()), p), pageToScreen: p => pageToScreen(currentViewport(store.getState()), p),
      setViewport: v => store.setViewport(v), pixel: () => 1 / currentViewport(store.getState()).zoom,
    },
  };
}

function setup(doc: DesignDocument) {
  const store = createDesignStore({doc, measurer});
  store.setViewport(VIEW);
  store.setSelection(['row']);
  const tool = new MoveTool();
  const ctx: ToolContext = {
    store, measurer, snap: NO_SNAP, index: () => null, setCursor: () => {}, requestOverlay: () => {}, setOverlayItems: () => {}, enterEdit: () => {},
    setTool: id => store.setTool(id), modifiers: () => ({shift: false, alt: false, mod: false}),
    view: {
      viewport: () => currentViewport(store.getState()), size: () => ({width: 1000, height: 800}),
      screenToPage: p => screenToPage(currentViewport(store.getState()), p), pageToScreen: p => pageToScreen(currentViewport(store.getState()), p),
      setViewport: v => store.setViewport(v), pixel: () => 1 / currentViewport(store.getState()).zoom,
    },
  };
  const ev = (x: number, y: number, mods: {alt?: boolean; shift?: boolean} = {}): ToolPointerEvent => ({screen: {x, y}, page: {x, y}, button: 0, buttons: 1, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false, ctrlKey: false, mod: false, pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0});
  /** Drags the bar of the handle `pick` chooses by (dx, dy) screen px. */
  const dragBar = (pick: (h: LayoutHandle) => boolean, dx: number, dy: number, mods: {alt?: boolean; shift?: boolean} = {}) => {
    const {handles, handle} = handleOf(store.getState().doc, pick);
    const [a, b] = barOf(handles, handle, VIEW);
    const from = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
    tool.onPointerDown(ev(from.x, from.y, mods), ctx);
    for (let i = 1; i <= 4; i++) tool.onPointerMove(ev(from.x + (dx * i) / 4, from.y + (dy * i) / 4, mods), ctx);
    tool.onPointerUp(ev(from.x + dx, from.y + dy, mods), ctx);
  };
  const layout = () => store.getState().doc.nodes.row.autoLayout!;
  const drag = (from: {x: number; y: number}, dx: number, dy: number) => {
    tool.onPointerDown(ev(from.x, from.y), ctx);
    for (let i = 1; i <= 4; i++) tool.onPointerMove(ev(from.x + (dx * i) / 4, from.y + (dy * i) / 4), ctx);
    tool.onPointerUp(ev(from.x + dx, from.y + dy), ctx);
  };
  return {store, dragBar, drag, layout};
}

test('a padding bar dragged inward sets that side; Alt the opposite one too; Alt and Shift all four; never below 0', () => {
  const {store, dragBar, layout} = setup(row());
  dragBar(h => h.kind === 'padding' && h.side === 'top', 0, 14);
  assert.deepEqual([layout().paddingTop, layout().paddingBottom], [24, 30]);
  assert.equal(store.getState().doc.nodes.a.y, 24, 'the layers moved with it (aligned to the top)');
  store.undo();
  assert.equal(layout().paddingTop, 10, 'one undo step');

  dragBar(h => h.kind === 'padding' && h.side === 'left', 6, 0, {alt: true});
  assert.deepEqual([layout().paddingLeft, layout().paddingRight], [46, 46]);
  dragBar(h => h.kind === 'padding' && h.side === 'right', 4, 0, {alt: true, shift: true});
  assert.deepEqual([layout().paddingTop, layout().paddingRight, layout().paddingBottom, layout().paddingLeft], [42, 42, 42, 42]);
  dragBar(h => h.kind === 'padding' && h.side === 'bottom', 0, 300);
  assert.equal(layout().paddingBottom, 0);
});

test('a gap bar dragged along the flow sets the gap; from "Auto" the gap shown becomes a fixed one', () => {
  const {store, dragBar, layout} = setup(row());
  dragBar(h => h.kind === 'gap' && h.index === 0, 12, 0);
  assert.equal(layout().itemSpacing, 20);
  assert.deepEqual(['a', 'b', 'c'].map(id => store.getState().doc.nodes[id].x), [40, 110, 180]);

  const spread = setup(row({primaryAxisAlignItems: 'SPACE_BETWEEN'}));
  // Spread over 400 − 40 − 20 = 340 px: three 50 px layers leave two 95 px gaps.
  spread.dragBar(h => h.kind === 'gap' && h.index === 1, -5, 0);
  assert.equal(spread.layout().itemSpacing, 90);
  assert.equal(spread.layout().primaryAxisAlignItems, 'MIN');
});

test('away from the bars the frame moves as before: a drag from its empty middle moves it, padding and gap as they were', () => {
  const {store, drag, layout} = setup(row());
  drag({x: 100 + 300, y: 100 + 100}, 30, 20);
  assert.deepEqual([store.getState().doc.nodes.row.x, store.getState().doc.nodes.row.y], [130, 120]);
  assert.deepEqual([layout().paddingTop, layout().itemSpacing], [10, 8]);
});

// ── Equal spacing on a selection (src/design/engine/spacing-handles.ts; docs/figma-parity.md 2.9) ──

function spaced(gaps: number[]): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  let x = 0;
  ['p', 'q', 'r', 's'].slice(0, gaps.length + 1).forEach((id, i) => {
    tx.create(createNode('RECTANGLE', {id, x, y: i * 3, width: 40 + i * 10, height: 30, rotation: 0}) as SceneNode, 'page');
    x += 40 + i * 10 + (gaps[i] ?? 0);
  });
  return tx.commit({measurer}).doc;
}

test('layers in a row with equal gaps have a bar in each gap; unequal gaps or one layer have none', async () => {
  const {spacingHandles} = await import('../src/design/engine/spacing-handles');
  const doc = spaced([20, 20, 20]);
  const handles = spacingHandles(doc, ['r', 'p', 's', 'q'])!;
  assert.equal(handles.axis, 'x');
  assert.equal(handles.gap, 20);
  assert.deepEqual(handles.items.map(i => i.id), ['p', 'q', 'r', 's'], 'in order along the row');
  assert.deepEqual(handles.gaps.map(g => g.area.x), [40, 110, 190]);
  assert.equal(spacingHandles(spaced([20, 21, 20]), ['p', 'q', 'r', 's']), null);
  assert.equal(spacingHandles(doc, ['p']), null);
  // A column.
  const tx = beginTransaction(createDocument('page'));
  for (const [id, y] of [['u', 0], ['v', 50], ['w', 100]] as const) tx.create(createNode('RECTANGLE', {id, x: 5, y, width: 30, height: 30}) as SceneNode, 'page');
  const column = spacingHandles(tx.commit({measurer}).doc, ['u', 'v', 'w'])!;
  assert.deepEqual([column.axis, column.gap], ['y', 20]);
});

test('a gap bar dragged sets every gap, the first layer staying; one undo step; never below 0', async () => {
  const {spacingBar, spacingHandles} = await import('../src/design/engine/spacing-handles');
  const doc = spaced([20, 20, 20]);
  const store = createDesignStore({doc, measurer});
  store.setViewport(VIEW);
  store.setSelection(['p', 'q', 'r', 's']);
  const tool = new MoveTool();
  const ctx = setupContext(store);
  const ev = (x: number, y: number): ToolPointerEvent => ({screen: {x, y}, page: {x, y}, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0});
  const drag = (index: number, dx: number) => {
    const handles = spacingHandles(store.getState().doc, store.getState().selection)!;
    const [a, b] = spacingBar(handles, index, VIEW);
    const from = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
    tool.onPointerDown(ev(from.x, from.y), ctx);
    for (let i = 1; i <= 4; i++) tool.onPointerMove(ev(from.x + (dx * i) / 4, from.y), ctx);
    tool.onPointerUp(ev(from.x + dx, from.y), ctx);
  };
  const xs = () => ['p', 'q', 'r', 's'].map(id => store.getState().doc.nodes[id].x);
  drag(1, 7);
  assert.deepEqual(xs(), [0, 67, 144, 231], 'gaps of 27: p stays, each next one 7 further than the last');
  store.undo();
  assert.deepEqual(xs(), [0, 60, 130, 210]);
  drag(0, -100);
  assert.deepEqual(xs(), [0, 40, 90, 150], 'gaps of 0');
  // The layers keep their own y.
  assert.deepEqual(['p', 'q', 'r', 's'].map(id => store.getState().doc.nodes[id].y), [0, 3, 6, 9]);
});
