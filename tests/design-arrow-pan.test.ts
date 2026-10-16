import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {findByShortcut, isEnabled, registerCoreCommands, type CommandContext} from '../src/design/engine/commands';
import {PAN_STEP, PAN_STEP_LARGE} from '../src/design/engine/commands/view';
import {createDesignStore, currentViewport} from '../src/design/engine/store';

// The arrows pan the canvas with nothing selected (help.figma.com «Use Figma products with a keyboard»), ⇧ further; with a
// selection they nudge it, as before.

const measurer: TextMeasurer = {width: () => 0, metrics: () => ({ascent: 0, descent: 0})};

function setup() {
  registerCoreCommands();
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('RECTANGLE', {id: 'r', width: 10, height: 10}), 'page');
  const store = createDesignStore({doc: tx.commit({measurer}).doc, measurer});
  store.setViewport({x: 0, y: 0, zoom: 2});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  const key = (code: string, shiftKey = false) => findByShortcut({code, shiftKey, metaKey: false, ctrlKey: false, altKey: false}, false, command => isEnabled(command, ctx));
  return {store, ctx, key};
}

test('should pan the canvas with the arrows when nothing is selected, further with shift', () => {
  const {store, ctx, key} = setup();
  const right = key('ArrowRight')!;
  assert.equal(right.id, 'nudge-right', 'one command per key: it pans with nothing selected');
  void right.run(ctx);
  assert.equal(currentViewport(store.getState()).x, PAN_STEP / 2, 'screen px over the zoom');
  void key('ArrowUp', true)!.run(ctx);
  assert.equal(currentViewport(store.getState()).y, -PAN_STEP_LARGE / 2);
});

test('should keep the arrows nudging a selection', () => {
  const {store, key} = setup();
  store.setSelection(['r']);
  assert.equal(key('ArrowRight')!.id, 'nudge-right');
});
