import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore, currentViewport} from '../src/design/engine/store';
import {NO_SNAP, type ToolContext, type ToolPointerEvent} from '../src/design/engine/tools/types';
import {pageToScreen, screenToPage} from '../src/design/engine/viewport';
import {TOUCH_SELECT_TOOL, TouchSelectTool, followSelectionOff} from '../src/design/engine/touch/select-tool';

// "Select" on a phone (src/design/engine/touch/select-tool.ts): while it is on, a
// tap adds a layer to the selection or takes it out, a one-finger drag draws a marquee that adds what it touches.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function page(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('RECTANGLE', {id: 'a', x: 0, y: 0, width: 40, height: 40}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'b', x: 100, y: 0, width: 40, height: 40}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'c', x: 0, y: 100, width: 40, height: 40}), 'page');
  return tx.commit({measurer}).doc;
}

function setup() {
  const store = createDesignStore({doc: page(), measurer, tool: TOUCH_SELECT_TOOL});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const tool = new TouchSelectTool();
  const ctx: ToolContext = {
    store, measurer, snap: NO_SNAP, index: () => null, setCursor: () => {}, requestOverlay: () => {}, setOverlayItems: () => {}, enterEdit: () => {},
    setTool: id => store.setTool(id), modifiers: () => ({shift: false, alt: false, mod: false}),
    view: {
      viewport: () => currentViewport(store.getState()), size: () => ({width: 400, height: 800}),
      screenToPage: p => screenToPage(currentViewport(store.getState()), p), pageToScreen: p => pageToScreen(currentViewport(store.getState()), p),
      setViewport: v => store.setViewport(v), pixel: () => 1 / currentViewport(store.getState()).zoom,
    },
  };
  const ev = (x: number, y: number): ToolPointerEvent => ({screen: {x, y}, page: {x, y}, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, pointerId: 1, pointerType: 'touch', pressure: 0.5, detail: 1, timeStamp: 0});
  const tap = (x: number, y: number) => {
    tool.onPointerDown(ev(x, y), ctx);
    tool.onPointerUp(ev(x, y), ctx);
  };
  const drag = (from: {x: number; y: number}, to: {x: number; y: number}) => {
    tool.onPointerDown(ev(from.x, from.y), ctx);
    for (let i = 1; i <= 4; i++) tool.onPointerMove(ev(from.x + ((to.x - from.x) * i) / 4, from.y + ((to.y - from.y) * i) / 4), ctx);
    tool.onPointerUp(ev(to.x, to.y), ctx);
  };
  return {store, tool, ctx, tap, drag};
}

test('should add a layer to the selection when it is tapped with "Select" on', () => {
  const {store, tap} = setup();
  store.setSelection(['a']);

  tap(120, 20);

  assert.deepEqual(store.getState().selection, ['a', 'b']);
});

test('should take a selected layer out of the selection when it is tapped again', () => {
  const {store, tap} = setup();
  store.setSelection(['a', 'b']);

  tap(20, 20);

  assert.deepEqual(store.getState().selection, ['b']);
});

test('should add what a one-finger marquee touches to the selection, even when it starts on a layer', () => {
  const {store, drag} = setup();
  store.setSelection(['b']);

  drag({x: 10, y: 10}, {x: 30, y: 130});

  assert.deepEqual([...store.getState().selection].sort(), ['a', 'b', 'c']);
});

test('should clear the selection when empty canvas is tapped', () => {
  const {store, tap} = setup();
  store.setSelection(['a', 'b']);

  tap(300, 500);

  assert.deepEqual(store.getState().selection, []);
});

test('should turn "Select" off when the selection becomes empty', () => {
  const {store} = setup();
  store.setSelection(['a']);
  const stop = followSelectionOff(store);

  store.setSelection([]);

  assert.equal(store.getState().tool, 'move');
  stop();
});

test('should keep "Select" on when it is turned on with nothing selected', () => {
  const {store} = setup();
  const stop = followSelectionOff(store);

  store.setTool(TOUCH_SELECT_TOOL);

  assert.equal(store.getState().tool, TOUCH_SELECT_TOOL);
  stop();
});
