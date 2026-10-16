// These tests assume a host that is not a Mac (their shortcut cases say so): pin it before any design module loads.
import './helpers/linux-platform';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {booleanGeometry} from '../shared/design/boolean';
import {worldBox} from '../shared/design/geometry';
import {flattenPath} from '../shared/design/paths';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, GradientPaint, NodeId, SceneNode, VectorPath} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {findByShortcut, registerCoreCommands, runCommand, type CommandContext} from '../src/design/engine/commands';
import {applyBoolean, BOOLEAN_MESSAGES, planBoolean} from '../src/design/engine/commands/boolean';
import {MASK_GROUP_NAME, toggleMask} from '../src/design/engine/commands/mask';
import {flattenSelection, outlineStrokeSelection, VECTOR_MESSAGES} from '../src/design/engine/commands/vector';
import {createDesignStore} from '../src/design/engine/store';
import {installVectorEditing} from '../src/design/engine/vector-edit/session';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const close = (a: number, b: number, message?: string, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, message ?? `${a} ≈ ${b}`);
const RED = solid({r: 1, g: 0, b: 0});
const BLUE = solid({r: 0, g: 0, b: 1});

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

function setup(doc: DesignDocument, selection: NodeId[] = []) {
  registerCoreCommands();
  const store = createDesignStore({doc, measurer});
  const messages: string[] = [];
  installVectorEditing(store, {notify: message => void messages.push(message)});
  store.setSelection(selection);
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  return {store, ctx, messages};
}

/** Filled area of paths (shoelace over a fine flattening; holes count negative under NONZERO as polygon-clipping winds them). */
function area(paths: readonly VectorPath[]): number {
  let total = 0;
  for (const path of paths) for (const line of flattenPath(path.commands, 0.01)) {
    const p = line.points;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      total += a.x * b.y - b.x * a.y;
    }
  }
  return Math.abs(total / 2);
}

/** Two overlapping 100×100 squares: «a» at (0, 0) below, «b» at (50, 50) on top. */
const squares = (extra?: (add: Parameters<Parameters<typeof build>[0]>[0]) => void) => build(add => {
  add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 100, height: 100, fills: [BLUE]});
  add('RECTANGLE', 'b', 'page', {x: 50, y: 50, width: 100, height: 100, fills: [RED], strokes: [BLUE], strokeWeight: 3});
  extra?.(add);
});

test('boolean commands wrap the layers in a BOOLEAN_OPERATION with the right area', () => {
  const expected = {UNION: 17500, SUBTRACT: 7500, INTERSECT: 2500, EXCLUDE: 15000} as const;
  for (const [operation, value] of Object.entries(expected) as [keyof typeof expected, number][]) {
    const {store} = setup(squares(), ['a', 'b']);
    const id = applyBoolean(store, operation)!;
    const doc = store.getState().doc;
    const node = doc.nodes[id];
    assert.equal(node.type, 'BOOLEAN_OPERATION');
    assert.equal(node.booleanOperation, operation);
    assert.deepEqual(node.children, ['a', 'b'], 'children keep their order');
    assert.deepEqual(doc.nodes.page.children, [id]);
    assert.deepEqual(store.getState().selection, [id]);
    assert.deepEqual([node.x, node.y, node.width, node.height], [0, 0, 150, 150]);
    // Children keep their place on screen.
    assert.deepEqual(worldBox(doc, 'b'), {x: 50, y: 50, width: 100, height: 100});
    close(area(booleanGeometry(doc, id)), value, `${operation}: ${area(booleanGeometry(doc, id))} ≈ ${value}`, 1);
    // The look: the top layer's, the bottom one's for subtract (its shape with holes).
    assert.deepEqual(node.fills, operation === 'SUBTRACT' ? [BLUE] : [RED]);
    if (operation !== 'SUBTRACT') assert.equal(node.strokeWeight, 3);
    store.undo();
    assert.deepEqual(store.getState().doc.nodes.page.children, ['a', 'b']);
  }
});

test('a selected boolean changes its operation; names follow while they are the default', () => {
  const {store} = setup(squares(), ['a', 'b']);
  const id = applyBoolean(store, 'UNION')!;
  assert.equal(store.getState().doc.nodes[id].name, 'Union');
  assert.equal(applyBoolean(store, 'INTERSECT'), id);
  assert.equal(store.getState().doc.nodes[id].booleanOperation, 'INTERSECT');
  assert.equal(store.getState().doc.nodes[id].name, 'Intersect');
  store.transact('rename', tx => tx.update(id, {name: 'Badge'}));
  applyBoolean(store, 'EXCLUDE');
  assert.equal(store.getState().doc.nodes[id].name, 'Badge');
});

test('boolean shortcuts are ⌥⇧U/S/I/X and work on the Russian layout', () => {
  registerCoreCommands();
  const key = (code: string) => ({code, metaKey: false, ctrlKey: false, shiftKey: true, altKey: true});
  assert.equal(findByShortcut(key('KeyU'), true)?.id, 'object.boolean-union');
  assert.equal(findByShortcut(key('KeyS'), true)?.id, 'object.boolean-subtract');
  assert.equal(findByShortcut(key('KeyI'), false)?.id, 'object.boolean-intersect');
  assert.equal(findByShortcut(key('KeyX'), false)?.id, 'object.boolean-exclude');
  assert.equal(findByShortcut({code: 'KeyE', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false}, true)?.id, 'object.flatten');
  assert.equal(findByShortcut({code: 'KeyO', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true}, true)?.id, 'object.outline-stroke');
  // ⌃⌘M on a Mac, Ctrl+Alt+M elsewhere (registered for the platform; node is not a Mac).
  assert.equal(findByShortcut({code: 'KeyM', metaKey: false, ctrlKey: true, shiftKey: false, altKey: true}, false)?.id, 'object.mask');
  assert.equal(findByShortcut({code: 'KeyP', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false}, true)?.id, 'tool-pen');
  assert.equal(findByShortcut({code: 'KeyP', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false}, true)?.id, 'tool-pencil');
});

test('text takes no part in a boolean and says so; a single shape is not enough', () => {
  const text = createNode('TEXT', {id: 't', parentId: 'page', text: defaultTextProps('Hello')});
  const doc = squares(add => add('TEXT', 't', 'page', {text: text.text}));
  const {store, messages, ctx} = setup(doc, ['a', 'b', 't']);
  const id = applyBoolean(store, 'UNION')!;
  assert.deepEqual(store.getState().doc.nodes[id].children, ['a', 'b']);
  assert.equal(store.getState().doc.nodes.t.parentId, 'page', 'the text stays where it was');
  assert.equal(messages.at(-1), BOOLEAN_MESSAGES.textSkipped);
  store.setSelection(['t', id]);
  assert.equal(planBoolean(store.getState().doc, ['t', id]).kind, 'none');
  assert.ok(runCommand('object.boolean-union', ctx), 'enabled, so it can explain');
  assert.equal(messages.at(-1), BOOLEAN_MESSAGES.text);
  store.setSelection(['a']);
  assert.ok(!runCommand('object.boolean-union', ctx), 'one shape cannot make a boolean');
});

test('layers from different parents meet in the top one\'s parent and keep their place', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 300, y: 300, width: 200, height: 200});
    add('RECTANGLE', 'inner', 'f', {x: 10, y: 10, width: 50, height: 50});
    add('ELLIPSE', 'top', 'page', {x: 320, y: 320, width: 50, height: 50});
  });
  const {store} = setup(doc, ['inner', 'top']);
  const id = applyBoolean(store, 'UNION')!;
  const after = store.getState().doc;
  assert.equal(after.nodes[id].parentId, 'page');
  assert.deepEqual(worldBox(after, 'inner'), {x: 310, y: 310, width: 50, height: 50});
  assert.ok(after.nodes.f, 'the frame stays');
});

test('flatten turns a boolean into one VECTOR with its geometry; text inside a group is kept', () => {
  const {store, messages} = setup(squares(), ['a', 'b']);
  const id = applyBoolean(store, 'SUBTRACT')!;
  const before = area(booleanGeometry(store.getState().doc, id));
  const vector = flattenSelection(store)!;
  const doc = store.getState().doc;
  assert.equal(doc.nodes[vector].type, 'VECTOR');
  assert.equal(doc.nodes[id], undefined);
  assert.deepEqual(store.getState().selection, [vector]);
  close(area(doc.nodes[vector].vectorPaths!), before, 'same area', 1);
  assert.deepEqual(doc.nodes[vector].fills, [BLUE]);

  const grouped = build(add => {
    add('GROUP', 'g', 'page', {x: 0, y: 0, width: 200, height: 200});
    add('RECTANGLE', 'r', 'g', {x: 0, y: 0, width: 100, height: 100});
    add('TEXT', 't', 'g', {x: 120, y: 120, text: defaultTextProps('Caption')});
  });
  const second = setup(grouped, ['g']);
  const flat = flattenSelection(second.store)!;
  const after = second.store.getState().doc;
  assert.equal(after.nodes.g, undefined);
  assert.equal(after.nodes.t?.parentId, 'page', 'the text moved out of the flattened group');
  assert.deepEqual(after.nodes.page.children, [flat, 't']);
  assert.match(second.messages.at(-1) ?? '', /Text/);
  // Text alone: nothing to flatten, and the reason.
  second.store.setSelection(['t']);
  assert.equal(flattenSelection(second.store), null);
  assert.match(second.messages.at(-1) ?? '', /Text/);
  void messages;
});

test('outline stroke: the stroke becomes a filled vector; text is skipped with a message', () => {
  const doc = build(add => {
    add('LINE', 'l', 'page', {x: 0, y: 0, width: 100, strokes: [RED], strokeWeight: 4});
    add('TEXT', 't', 'page', {x: 0, y: 50, text: defaultTextProps('Text'), strokes: [RED]});
    add('RECTANGLE', 'plain', 'page', {x: 0, y: 100});
  });
  const {store, messages} = setup(doc, ['l', 't']);
  const [created] = outlineStrokeSelection(store);
  const after = store.getState().doc;
  assert.equal(after.nodes.l, undefined);
  assert.equal(after.nodes[created].type, 'VECTOR');
  assert.deepEqual(after.nodes[created].fills, [RED]);
  close(area(after.nodes[created].vectorPaths!), 400, 'a 100 × 4 band', 1);
  assert.equal(messages.at(-1), VECTOR_MESSAGES.outlineText);
  store.setSelection(['plain']);
  outlineStrokeSelection(store);
  assert.equal(messages.at(-1), VECTOR_MESSAGES.outlineNothing);
  assert.equal(store.getState().doc.nodes.plain.type, 'RECTANGLE');
});

test('mask: the bottom layer masks the others in the "Mask group"; again takes the mask off', () => {
  const doc = squares(add => add('ELLIPSE', 'c', 'page', {x: 20, y: 20, width: 60, height: 60}));
  const {store, ctx} = setup(doc, ['b', 'c']);
  const [group] = toggleMask(store);
  const after = store.getState().doc;
  assert.equal(after.nodes[group].type, 'GROUP');
  assert.equal(after.nodes[group].name, MASK_GROUP_NAME);
  assert.deepEqual(after.nodes[group].children, ['b', 'c'], 'paint order kept');
  assert.equal(after.nodes.b.isMask, true, 'the bottom-most selected layer is the mask');
  assert.equal(after.nodes.c.isMask, false);
  assert.deepEqual(after.nodes.page.children, ['a', group], 'the group stands where the top layer was');
  assert.deepEqual(store.getState().selection, [group]);
  assert.deepEqual(worldBox(after, 'c'), {x: 20, y: 20, width: 60, height: 60});
  // Toggle off on the mask itself.
  store.setSelection(['b']);
  assert.ok(runCommand('object.mask', ctx));
  assert.equal(store.getState().doc.nodes.b.isMask, false);
  // One layer alone becomes a mask in place.
  store.setSelection(['a']);
  toggleMask(store);
  assert.equal(store.getState().doc.nodes.a.isMask, true);
  assert.equal(store.getState().doc.nodes.a.parentId, 'page');
  store.undo();
  assert.equal(store.getState().doc.nodes.a.isMask, false);
});

test('gradients keep their place when a boolean takes them on', () => {
  const gradient: GradientPaint = {type: 'GRADIENT_LINEAR', opacity: 1, visible: true, blendMode: 'NORMAL', gradientStops: [{position: 0, color: {r: 1, g: 0, b: 0, a: 1}}, {position: 1, color: {r: 0, g: 0, b: 1, a: 1}}], gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}]};
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'b', 'page', {x: 100, y: 0, width: 100, height: 100, fills: [gradient]});
  });
  const {store} = setup(doc, ['a', 'b']);
  const id = applyBoolean(store, 'UNION')!;
  const paint = store.getState().doc.nodes[id].fills[0] as GradientPaint;
  // The gradient ran across «b» (x 100 → 200); in the 200-wide boolean that is 0.5 → 1.
  close(paint.gradientHandlePositions[0].x, 0.5, undefined, 1e-9);
  close(paint.gradientHandlePositions[1].x, 1, undefined, 1e-9);
});
