import './helpers/linux-platform';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {findByShortcut, registerCoreCommands} from '../src/design/engine/commands';
import {bands, suggestLayoutDeep} from '../src/design/engine/commands/suggest-layout';
import {createDesignStore} from '../src/design/engine/store';

// "Suggest auto layout" (⌃⇧A): a whole screen gets auto layout at once — its rows wrapped in rows, the screen a column
// over them — and nothing moves.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

const box = (doc: DesignDocument, id: NodeId) => {
  const r = worldBox(doc, id);
  return [r.x, r.y, r.width, r.height];
};

test('should split layers into rows where they overlap top to bottom', () => {
  const items = [
    {id: 'a', rect: {x: 0, y: 0, width: 50, height: 20}},
    {id: 'b', rect: {x: 60, y: 5, width: 50, height: 20}},
    {id: 'c', rect: {x: 0, y: 40, width: 50, height: 20}},
  ];
  assert.deepEqual(bands(items, 'y'), [['a', 'b'], ['c']]);
  assert.deepEqual(bands(items, 'x'), [['a', 'c'], ['b']]);
});

test('should give a screen auto layout over a row it wraps, keeping every layer in place', () => {
  // A title on top, then two buttons side by side, all 20 from the screen's edges.
  const doc = build(add => {
    add('FRAME', 'screen', 'page', {width: 300, height: 200});
    add('RECTANGLE', 'title', 'screen', {x: 20, y: 20, width: 200, height: 40});
    add('RECTANGLE', 'ok', 'screen', {x: 20, y: 80, width: 100, height: 40});
    add('RECTANGLE', 'cancel', 'screen', {x: 140, y: 80, width: 100, height: 40});
  });
  const store = createDesignStore({doc, measurer});
  store.setSelection(['screen']);
  const before = ['title', 'ok', 'cancel'].map(id => box(doc, id));

  assert.deepEqual(suggestLayoutDeep(store), ['screen']);

  const next = store.getState().doc;
  assert.equal(next.nodes.screen.autoLayout?.layoutMode, 'VERTICAL');
  const row = next.nodes[next.nodes.ok.parentId!];
  assert.equal(row.parentId, 'screen');
  assert.equal(row.autoLayout?.layoutMode, 'HORIZONTAL');
  assert.equal(next.nodes.cancel.parentId, row.id);
  assert.deepEqual(['title', 'ok', 'cancel'].map(id => box(next, id)), before, 'nothing moves');
  store.undo();
  assert.equal(store.getState().doc.nodes.ok.parentId, 'screen', 'one undo step');
});

test('should leave a frame whose layers overlap both ways free', () => {
  const doc = build(add => {
    add('FRAME', 'stack', 'page', {width: 200, height: 200});
    add('RECTANGLE', 'a', 'stack', {x: 10, y: 10, width: 100, height: 100});
    add('RECTANGLE', 'b', 'stack', {x: 50, y: 50, width: 100, height: 100});
  });
  const store = createDesignStore({doc, measurer});
  store.setSelection(['stack']);

  assert.deepEqual(suggestLayoutDeep(store), []);
  assert.equal(store.getState().doc.nodes.stack.autoLayout?.layoutMode ?? 'NONE', 'NONE');
});

test('should run on Ctrl+Alt+Shift+A off a Mac', () => {
  registerCoreCommands();
  assert.equal(findByShortcut({code: 'KeyA', ctrlKey: true, altKey: true, shiftKey: true, metaKey: false}, false)?.id, 'object.suggest-auto-layout');
});
