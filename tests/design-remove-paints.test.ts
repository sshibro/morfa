// These tests assume a host that is not a Mac: pin it before any design module loads.
import './helpers/linux-platform';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {NodeId, Paint, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {findByShortcut, registerCoreCommands, runCommand} from '../src/design/engine/commands';
import {createDesignStore} from '../src/design/engine/store';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const red: Paint = {type: 'SOLID', color: {r: 1, g: 0, b: 0, a: 1}, opacity: 1, visible: true, blendMode: 'NORMAL'} as Paint;

function setup(selection: NodeId[]) {
  registerCoreCommands();
  const tx = beginTransaction(createDocument('page'));
  const add = (id: NodeId, props: Partial<SceneNode>) => tx.create(createNode('RECTANGLE', {id, width: 10, height: 10, ...props}), 'page');
  add('a', {fills: [red], strokes: [red], strokeWeight: 2, fillStyleId: 's1'});
  add('b', {fills: [red], strokes: []});
  add('locked', {fills: [red], strokes: [red], locked: true});
  const store = createDesignStore({doc: tx.commit({measurer}).doc, measurer});
  store.setSelection(selection);
  return {store, ctx: {store, canvasSize: () => ({width: 800, height: 600})}};
}

test('"Remove fill" ⌥/ takes the fills and their style off the selected layers in one undo step; locked layers keep theirs', () => {
  const {store, ctx} = setup(['a', 'b', 'locked']);
  assert.equal(findByShortcut({code: 'Slash', altKey: true, shiftKey: false, metaKey: false, ctrlKey: false}, false)?.id, 'object.remove-fill');
  assert.ok(runCommand('object.remove-fill', ctx));
  const {nodes} = store.getState().doc;
  assert.deepEqual([nodes.a.fills, nodes.b.fills, nodes.a.fillStyleId], [[], [], undefined]);
  assert.equal(nodes.a.strokes.length, 1, 'the stroke stays');
  assert.equal(nodes.locked.fills.length, 1);
  store.undo();
  assert.equal(store.getState().doc.nodes.a.fillStyleId, 's1');
  assert.equal(store.getState().doc.nodes.b.fills.length, 1);
});

test('"Remove stroke" ⇧/ takes the strokes off; with nothing left to take both commands are off', () => {
  const {store, ctx} = setup(['a', 'b']);
  assert.equal(findByShortcut({code: 'Slash', altKey: false, shiftKey: true, metaKey: false, ctrlKey: false}, false)?.id, 'object.remove-stroke');
  assert.ok(runCommand('object.remove-stroke', ctx));
  assert.deepEqual(store.getState().doc.nodes.a.strokes, []);
  assert.ok(!runCommand('object.remove-stroke', ctx), 'no stroke is left to take');
  store.setSelection(['locked']);
  assert.ok(!runCommand('object.remove-fill', ctx));
});
