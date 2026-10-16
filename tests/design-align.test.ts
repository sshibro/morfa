// These tests assume a host that is not a Mac (their shortcut cases say so): pin it before any design module loads.
import './helpers/linux-platform';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {CORE_COMMANDS, findByShortcut, registerCoreCommands, runCommand, type CommandContext} from '../src/design/engine/commands';
import {alignAvailability, alignDeltas, alignSelection, canAlign, canDistribute, canTidyUp, distributeDeltas, distributeSelection, roundSelectionToPixels, tidyUpPositions, tidyUpSelection} from '../src/design/engine/commands/align';
import {addAutoLayout, removeAllAutoLayout, removeAutoLayout} from '../src/design/engine/commands/auto-layout';
import {createDesignStore} from '../src/design/engine/store';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const r = (x: number, y: number, width: number, height: number) => ({x, y, width, height});

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

function storeWith(doc: DesignDocument, selection: NodeId[]) {
  const store = createDesignStore({doc, measurer});
  store.setSelection(selection);
  return store;
}

const box = (doc: DesignDocument, id: NodeId) => {
  const b = worldBox(doc, id);
  return [b.x, b.y, b.width, b.height].map(v => Math.round(v * 1000) / 1000);
};

test('align deltas against a box', () => {
  const rects = [r(10, 10, 20, 20), r(50, 40, 40, 10)];
  const to = r(0, 0, 100, 60);
  assert.deepEqual(alignDeltas(rects, to, 'left'), [{x: -10, y: 0}, {x: -50, y: 0}]);
  assert.deepEqual(alignDeltas(rects, to, 'center-h'), [{x: 30, y: 0}, {x: -20, y: 0}]);
  assert.deepEqual(alignDeltas(rects, to, 'bottom'), [{x: 0, y: 30}, {x: 0, y: 10}]);
});

test('several layers line up against their bounds, across parents, on screen', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 10, y: 0, width: 50, height: 50});
    add('FRAME', 'f', 'page', {x: 100, y: 100, width: 300, height: 300});
    add('RECTANGLE', 'b', 'f', {x: 50, y: 20, width: 30, height: 30});
  });
  const store = storeWith(doc, ['a', 'b']);
  alignSelection(store, 'left');
  let next = store.getState().doc;
  assert.deepEqual(box(next, 'b'), [10, 120, 30, 30], 'b moves to x 10 on the page');
  assert.equal(next.nodes.b.x, -90, 'written in the frame’s space');
  assert.equal(next.nodes.b.parentId, 'f');
  store.undo();
  alignSelection(store, 'bottom');
  next = store.getState().doc;
  assert.deepEqual(box(next, 'a'), [10, 100, 50, 50], 'a’s bottom on b’s (150)');
  assert.deepEqual(box(next, 'b'), [150, 120, 30, 30]);
});

test('one layer aligns to its parent frame; on the page it cannot', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 200, height: 100});
    add('RECTANGLE', 'a', 'f', {x: 10, y: 10, width: 40, height: 20});
    add('RECTANGLE', 'lone', 'page', {x: 500, y: 0, width: 40, height: 20});
  });
  const store = storeWith(doc, ['a']);
  alignSelection(store, 'center-h');
  alignSelection(store, 'center-v');
  assert.deepEqual(box(store.getState().doc, 'a'), [80, 40, 40, 20]);
  assert.ok(!canAlign(doc, ['lone']));
  store.setSelection(['lone']);
  alignSelection(store, 'right');
  assert.equal(store.getState().doc.nodes.lone.x, 500);
});

test('layers an auto-layout frame places are left alone', () => {
  const doc = build(add => {
    add('FRAME', 'row', 'page', {x: 0, y: 0, width: 300, height: 100, autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 10}});
    add('RECTANGLE', 'a', 'row', {width: 40, height: 40});
    add('RECTANGLE', 'b', 'row', {width: 40, height: 60});
  });
  assert.ok(!canAlign(doc, ['a', 'b']));
});

test('the alignment row\'s availability agrees with the commands without measuring layers', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 200, height: 100});
    add('RECTANGLE', 'a', 'f', {x: 10, y: 10, width: 40, height: 20});
    add('RECTANGLE', 'b', 'f', {x: 60, y: 10, width: 40, height: 20});
    add('RECTANGLE', 'c', 'f', {x: 110, y: 10, width: 40, height: 20});
    add('RECTANGLE', 'lone', 'page', {x: 500, y: 0, width: 40, height: 20});
    add('FRAME', 'row', 'page', {x: 0, y: 300, width: 300, height: 100, autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 10}});
    add('RECTANGLE', 'in', 'row', {width: 40, height: 40});
  });
  for (const selection of [[], ['a'], ['lone'], ['a', 'b'], ['a', 'b', 'c'], ['f', 'a'], ['in'], ['in', 'lone']]) {
    assert.deepEqual(alignAvailability(doc, selection), {align: canAlign(doc, selection), distribute: canDistribute(doc, selection), tidy: canTidyUp(doc, selection)}, selection.join(','));
  }
  assert.deepEqual(alignAvailability(doc, ['a', 'b', 'c']), {align: true, distribute: true, tidy: true});
  assert.deepEqual(alignAvailability(doc, ['lone']), {align: false, distribute: false, tidy: false});
});

test('distribute keeps the outermost layers and evens the gaps', () => {
  const deltas = distributeDeltas([r(0, 0, 10, 10), r(100, 0, 30, 10), r(30, 0, 20, 10)], 'horizontal');
  // Span 0..130, sizes 60 → two gaps of 35: x 0, 45, 95.
  assert.deepEqual(deltas, [{x: 0, y: 0}, {x: 0, y: 0}, {x: 15, y: 0}]);
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 10, height: 10});
    add('RECTANGLE', 'b', 'page', {x: 0, y: 100, width: 10, height: 30});
    add('RECTANGLE', 'c', 'page', {x: 0, y: 20, width: 10, height: 10});
  });
  const store = storeWith(doc, ['a', 'b', 'c']);
  distributeSelection(store, 'vertical');
  assert.equal(store.getState().doc.nodes.c.y, 50, 'span 0..130 less 50 of layers: two gaps of 40');
  store.setSelection(['a', 'b']);
  assert.ok(!runCommand('arrange.distribute-v', {store, canvasSize: () => ({width: 800, height: 600})}), 'two layers have no gap to even');
});

test('tidy up makes a grid with the typical gaps', () => {
  // A rough 2 × 2 grid: gaps 18 and 19 across (median 18.5 → 19), 24 between the rows' bounds.
  const positions = tidyUpPositions([r(0, 0, 100, 50), r(118, 4, 80, 50), r(3, 82, 100, 40), r(122, 78, 100, 60)]);
  assert.deepEqual(positions, [{x: 0, y: 0}, {x: 119, y: 0}, {x: 0, y: 74}, {x: 119, y: 74}]);
  const row = tidyUpPositions([r(0, 0, 50, 50), r(55, 2, 50, 50), r(140, -3, 50, 50)]);
  assert.deepEqual(row, [{x: 0, y: -3}, {x: 70, y: -3}, {x: 140, y: -3}], 'a row: median gap 20 (5 and 35)');
  assert.deepEqual(tidyUpPositions([r(0, 0, 50, 50), r(20, 0, 50, 50), r(200, 0, 50, 50)]), [{x: 0, y: 0}, {x: 180, y: 0}, {x: 360, y: 0}], 'an overlap says nothing about spacing: the real gap (130) is kept');
  assert.deepEqual(tidyUpPositions([r(0, 0, 50, 50), r(10, 5, 50, 50)]), [{x: 0, y: 0}, {x: 60, y: 0}], 'only overlaps: 10 apart');
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 50, height: 50});
    add('RECTANGLE', 'b', 'page', {x: 55, y: 2, width: 50, height: 50});
    add('RECTANGLE', 'c', 'page', {x: 140, y: -3, width: 50, height: 50});
  });
  const store = storeWith(doc, ['a', 'b', 'c']);
  tidyUpSelection(store);
  const next = store.getState().doc;
  assert.deepEqual(['a', 'b', 'c'].map(id => [next.nodes[id].x, next.nodes[id].y]), [[0, -3], [70, -3], [140, -3]]);
});

test('round to pixels: whole positions and sizes, children follow', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 10.4, y: 0.6, width: 99.5, height: 50.2});
    add('RECTANGLE', 'child', 'f', {x: 0, y: 0, width: 10, height: 10, constraints: {horizontal: 'MAX', vertical: 'MIN'}});
  });
  const store = storeWith(doc, ['f']);
  roundSelectionToPixels(store);
  const next = store.getState().doc;
  assert.deepEqual([next.nodes.f.x, next.nodes.f.y, next.nodes.f.width, next.nodes.f.height], [10, 1, 100, 50]);
  assert.equal(next.nodes.child.x, 0.5, 'a right-pinned child keeps its distance to the right edge');
});

test('⇧A adds inferred auto layout to a frame and wraps other selections', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 300, height: 100});
    add('RECTANGLE', 'b', 'f', {x: 130, y: 20, width: 60, height: 60});
    add('RECTANGLE', 'a', 'f', {x: 20, y: 20, width: 100, height: 60});
    add('RECTANGLE', 'p', 'page', {x: 0, y: 200, width: 50, height: 50});
    add('RECTANGLE', 'q', 'page', {x: 0, y: 270, width: 50, height: 30});
  });
  const store = storeWith(doc, ['f']);
  assert.equal(addAutoLayout(store), 'f');
  let next = store.getState().doc;
  assert.equal(next.nodes.f.autoLayout?.layoutMode, 'HORIZONTAL');
  assert.equal(next.nodes.f.autoLayout?.itemSpacing, 10);
  assert.deepEqual(next.nodes.f.children, ['a', 'b'], 'flow in screen order');
  assert.deepEqual([next.nodes.a.x, next.nodes.b.x], [20, 130], 'nothing jumps');
  removeAutoLayout(store);
  assert.equal(store.getState().doc.nodes.f.autoLayout?.layoutMode, 'NONE');
  assert.equal(store.getState().doc.nodes.b.x, 130, 'layers stay where layout put them');

  store.setSelection(['q', 'p']);
  const frame = addAutoLayout(store)!;
  next = store.getState().doc;
  assert.notEqual(frame, null);
  assert.equal(next.nodes[frame].type, 'FRAME');
  assert.equal(next.nodes[frame].autoLayout?.layoutMode, 'VERTICAL');
  assert.deepEqual(next.nodes[frame].children, ['p', 'q']);
  assert.deepEqual(box(next, frame), [0, 200, 50, 100], 'hugs its content: 50 + 20 + 30');
  assert.deepEqual(store.getState().selection, [frame]);
  store.undo();
  assert.equal(store.getState().doc.nodes.p.parentId, 'page', 'one undo step');
});

test('should turn auto layout off on the frame and every frame inside it when "Remove all auto layout" runs', () => {
  const doc = build(add => {
    add('FRAME', 'outer', 'page', {width: 300, height: 200, autoLayout: defaultAutoLayout('VERTICAL')});
    add('FRAME', 'inner', 'outer', {width: 100, height: 50, autoLayout: defaultAutoLayout('HORIZONTAL')});
    add('RECTANGLE', 'r', 'inner', {width: 20, height: 20});
    add('FRAME', 'other', 'page', {x: 500, width: 100, height: 100, autoLayout: defaultAutoLayout('VERTICAL')});
  });
  const store = storeWith(doc, ['outer']);
  const before = box(store.getState().doc, 'r');

  removeAllAutoLayout(store);

  const next = store.getState().doc;
  assert.equal(next.nodes.outer.autoLayout?.layoutMode, 'NONE');
  assert.equal(next.nodes.inner.autoLayout?.layoutMode, 'NONE');
  assert.equal(next.nodes.other.autoLayout?.layoutMode, 'VERTICAL', 'frames outside the selection keep theirs');
  assert.deepEqual(box(next, 'r'), before, 'the layers stay where layout put them');
  store.undo();
  assert.equal(store.getState().doc.nodes.inner.autoLayout?.layoutMode, 'HORIZONTAL', 'one undo step');
});

test('arrange and auto-layout shortcuts are physical keys', () => {
  registerCoreCommands();
  const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods});
  assert.equal(findByShortcut(key('KeyA', {altKey: true}), true)?.id, 'arrange.align-left');
  assert.equal(findByShortcut(key('KeyS', {altKey: true}), true)?.id, 'arrange.align-bottom');
  // Registered for the platform (node is not a Mac): Alt+Shift+H / Alt+Shift+V distribute off a Mac,
  // as Ctrl+Alt+V there is "Paste properties".
  assert.equal(findByShortcut(key('KeyH', {altKey: true, shiftKey: true}), false)?.id, 'arrange.distribute-h');
  assert.equal(findByShortcut(key('KeyV', {altKey: true, shiftKey: true}), false)?.id, 'arrange.distribute-v');
  // Off a Mac (as here, in node) "Tidy up" is Ctrl+Alt+Shift+T: Ctrl+Alt+T is the text's "Text align center", as in Figma.
  assert.equal(findByShortcut(key('KeyT', {altKey: true, ctrlKey: true, shiftKey: true}), false)?.id, 'arrange.tidy-up');
  assert.notEqual(findByShortcut(key('KeyT', {altKey: true, ctrlKey: true}), false)?.id, 'arrange.tidy-up');
  assert.equal(findByShortcut(key('KeyA', {shiftKey: true}), true)?.id, 'object.auto-layout');
  assert.equal(findByShortcut(key('KeyA', {shiftKey: true, altKey: true}), true)?.id, 'object.remove-auto-layout');
  assert.equal(findByShortcut(key('KeyR', {shiftKey: true}), true)?.id, 'view.rulers');
  assert.equal(findByShortcut(key('KeyA'), true)?.id, 'tool-frame');
  assert.equal(findByShortcut(key('KeyK', {metaKey: true, shiftKey: true}), true)?.id, 'file.place-image');
  assert.ok(CORE_COMMANDS.some(command => command.id === 'arrange.round-to-pixels'));
  const store = createDesignStore({doc: createDocument('page'), measurer});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 800, height: 600})};
  assert.ok(runCommand('view.rulers', ctx));
  assert.equal(store.getState().ui.rulers, true);
  assert.ok(!runCommand('file.place-image', ctx), 'no upload bound: the command is off rather than broken');
});
