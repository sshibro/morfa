import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {buildClipboardPayload, choosePasteTarget} from '../src/design/engine/clipboard';
import {copySelection, pasteData, registerCoreCommands, type CommandContext} from '../src/design/engine/commands';
import {createDesignStore} from '../src/design/engine/store';

// Where a paste lands with nothing selected: the frame under the copy, as in Figma, but never the layer that was
// copied or one inside it (a frame copied and pasted back on its place does not nest in itself).

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const VIEW = {center: {x: 50, y: 50}, visible: {x: -500, y: -500, width: 2000, height: 2000}};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

const doc = build(add => {
  add('FRAME', 'board', 'page', {x: -200, y: -200, width: 600, height: 600});
  add('FRAME', 'card', 'board', {x: 200, y: 200, width: 100, height: 100});
  add('FRAME', 'inner', 'card', {x: 10, y: 10, width: 80, height: 80});
});

test('should paste a copied frame beside itself in its parent when nothing is selected', () => {
  const payload = buildClipboardPayload(doc, ['card'])!;

  const target = choosePasteTarget(doc, 'page', [], payload, VIEW, false);

  assert.equal(target.parentId, 'board', 'the frame under the copy that is not the copied frame');
});

test('should still paste into another frame under the copy when nothing is selected', () => {
  const payload = buildClipboardPayload(doc, ['inner'])!;
  const moved = {...payload, world: {inner: [[1, 0, 0], [0, 1, 0]] as [[number, number, number], [number, number, number]]}};

  const target = choosePasteTarget(doc, 'page', [], moved, VIEW, false);

  assert.equal(target.parentId, 'card', 'the copy of «inner» moved to the page origin stands on «card» (page 0..100)');
});

test('should paste in place into the parent, not the copied frame', () => {
  const payload = buildClipboardPayload(doc, ['card'])!;

  const target = choosePasteTarget(doc, 'page', [], payload, VIEW, true);

  assert.equal(target.parentId, 'board');
});

test('should paste a copy into each of several selected frames, in one undo step', () => {
  registerCoreCommands();
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'f1', x: 0, y: 0, width: 200, height: 200}), 'page');
  tx.create(createNode('FRAME', {id: 'f2', x: 300, y: 0, width: 200, height: 200}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'r', x: 600, y: 0, width: 20, height: 20}), 'page');
  const store = createDesignStore({doc: tx.commit({measurer}).doc, measurer});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  store.setSelection(['r']);
  const text = copySelection(ctx)!;
  store.setSelection(['f1', 'f2']);
  const created = pasteData(ctx, {text, html: null, files: []}, false)!;
  const doc = store.getState().doc;
  assert.equal(created.length, 2);
  assert.deepEqual(created.map(id => doc.nodes[id].parentId).sort(), ['f1', 'f2']);
  store.undo();
  assert.equal(store.getState().doc.nodes.f1.children?.length ?? 0, 0);
});

test('should spread layers copied from several frames over several frames in order, round again', () => {
  registerCoreCommands();
  const tx = beginTransaction(createDocument('page'));
  for (const [id, x] of [['f1', 0], ['f2', 300], ['f3', 600], ['f4', 900], ['f5', 1200]] as const) tx.create(createNode('FRAME', {id, x, y: 0, width: 200, height: 200}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'r1', name: 'One', width: 20, height: 20}), 'f1');
  tx.create(createNode('ELLIPSE', {id: 'r2', name: 'Two', width: 20, height: 20}), 'f2');
  const store = createDesignStore({doc: tx.commit({measurer}).doc, measurer});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  store.setSelection(['r1', 'r2']);
  const text = copySelection(ctx)!;
  store.setSelection(['f3', 'f4', 'f5']);
  pasteData(ctx, {text, html: null, files: []}, false);
  const doc = store.getState().doc;
  assert.deepEqual(['f3', 'f4', 'f5'].map(id => (doc.nodes[id].children ?? []).map(child => doc.nodes[child].type)), [['RECTANGLE'], ['ELLIPSE'], ['RECTANGLE']]);
});
