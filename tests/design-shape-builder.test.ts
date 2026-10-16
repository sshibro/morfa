import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {validateDocument} from '../shared/design/schema';
import {SHAPE_BUILDER_MESSAGES, shapeBuilder, type ShapeBuilder} from '../shared/design/shape-builder';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {registerCoreCommands, runCommand, type CommandContext} from '../src/design/engine/commands';
import {applyShapeBuilder, SHAPE_BUILDER_TOOL} from '../src/design/engine/commands/shape-builder';
import {createDesignStore} from '../src/design/engine/store';

// "Shape builder", Figma's Shape builder (help.figma.com "Create custom shapes with the shape builder tool"): shapes cut
// one another into regions; a click extracts a region into a layer, a drag merges regions, ⌥ takes them away. Destructive,
// one undo step, curves kept.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

/** «a» 100×100 at 0,0 under «b» 100×100 at 50,0: three regions. */
const twoSquares = (bType: SceneNode['type'] = 'RECTANGLE') => build(add => {
  add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 100, height: 100});
  add(bType, 'b', 'page', {x: 50, y: 0, width: 100, height: 100});
});

const builderOf = (doc: DesignDocument, ids: NodeId[]) => {
  const builder = shapeBuilder(doc, ids);
  assert.ok(!('error' in builder), 'the builder starts');
  return builder as ShapeBuilder;
};
const regionWith = (builder: ShapeBuilder, owners: NodeId[]) =>
  builder.regions.findIndex(region => region.owners.map(k => builder.operands[k]).sort().join() === [...owners].sort().join());

function storeWith(doc: DesignDocument) {
  registerCoreCommands();
  const store = createDesignStore({doc, measurer});
  return store;
}

test('should cut overlapping shapes into the regions each set of them covers', () => {
  const builder = builderOf(twoSquares(), ['b', 'a']);
  assert.deepEqual(builder.operands, ['a', 'b'], 'bottom to top');
  assert.equal(builder.regions.length, 3);
  for (const owners of [['a'], ['b'], ['a', 'b']]) assert.ok(regionWith(builder, owners) >= 0, `a region of ${owners}`);
  assert.equal(builder.regions[builder.hit({x: 75, y: 50})].owners.length, 2, 'the overlap is under 75,50');
  assert.equal(builder.hit({x: 400, y: 50}), -1);
});

test('should extract a clicked region into a layer above the shapes it came from, in one undo step', () => {
  const doc = twoSquares();
  const store = storeWith(doc);
  const builder = builderOf(doc, ['a', 'b']);
  const plan = builder.plan([regionWith(builder, ['a', 'b'])], 'merge')!;
  const selection = applyShapeBuilder(store, builder.parentId, builder.operands, plan, 'merge');

  const now = store.getState().doc;
  assert.ok(validateDocument(now).ok);
  const children = now.nodes.page.children!.map(id => now.nodes[id]);
  assert.equal(children.length, 3);
  assert.deepEqual(children.map(node => node.type), ['VECTOR', 'VECTOR', 'VECTOR']);
  assert.deepEqual(children.map(node => [Math.round(node.x), Math.round(node.width)]), [[0, 50], [100, 50], [50, 50]], 'a keeps its left half, b its right, the overlap on top');
  assert.deepEqual(store.getState().selection, selection);

  store.undo();
  assert.deepEqual(store.getState().doc.nodes.page.children, ['a', 'b']);
});

test('should take a region away from every shape with ⌥ and make no new layer', () => {
  const doc = twoSquares();
  const store = storeWith(doc);
  const builder = builderOf(doc, ['a', 'b']);
  applyShapeBuilder(store, builder.parentId, builder.operands, builder.plan([regionWith(builder, ['a', 'b'])], 'subtract')!, 'subtract');
  const now = store.getState().doc;
  const children = now.nodes.page.children!.map(id => now.nodes[id]);
  assert.deepEqual(children.map(node => [Math.round(node.x), Math.round(node.width)]), [[0, 50], [100, 50]]);
});

test('should merge every region a drag passes into one layer, and drop the shapes left with nothing', () => {
  const doc = twoSquares();
  const store = storeWith(doc);
  const builder = builderOf(doc, ['a', 'b']);
  const all = builder.regions.map((_, k) => k);
  applyShapeBuilder(store, builder.parentId, builder.operands, builder.plan(all, 'merge')!, 'merge');
  const now = store.getState().doc;
  const children = now.nodes.page.children!.map(id => now.nodes[id]);
  assert.equal(children.length, 1);
  assert.deepEqual([Math.round(children[0].x), Math.round(children[0].width), Math.round(children[0].height)], [0, 150, 100]);
  assert.equal(children[0].name, 'b', 'it looks like the topmost shape it took from');
});

test('should keep curves as curves where a region follows an ellipse', () => {
  const doc = twoSquares('ELLIPSE');
  const store = storeWith(doc);
  const builder = builderOf(doc, ['a', 'b']);
  applyShapeBuilder(store, builder.parentId, builder.operands, builder.plan([regionWith(builder, ['a', 'b'])], 'merge')!, 'merge');
  const now = store.getState().doc;
  const top = now.nodes[now.nodes.page.children!.at(-1)!];
  const commands = top.vectorPaths!.flatMap(path => path.commands);
  assert.ok(commands.some(command => command.type === 'C'), 'an arc, not a polyline');
  assert.ok(commands.length < 20, `a handful of commands (${commands.length})`);
});

test('should change nothing when a merge takes exactly one whole shape', () => {
  const doc = build(add => add('RECTANGLE', 'a', 'page', {width: 100, height: 100}));
  const builder = builderOf(doc, ['a']);
  assert.equal(builder.plan([0], 'merge'), null);
});

test('should refuse shapes in different parents, and text', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {width: 100, height: 100});
    add('FRAME', 'f', 'page', {x: 200, width: 100, height: 100});
    add('RECTANGLE', 'c', 'f', {width: 50, height: 50});
    add('TEXT', 't', 'page', {width: 50, height: 20});
  });
  assert.deepEqual(shapeBuilder(doc, ['a', 'c']), {error: SHAPE_BUILDER_MESSAGES.parents});
  assert.deepEqual(shapeBuilder(doc, ['t']), {error: SHAPE_BUILDER_MESSAGES.none});
});

test('should open the tool from "Shape builder" for shapes, and say why not for a text', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {width: 100, height: 100});
    add('TEXT', 't', 'page', {x: 200, width: 50, height: 20});
  });
  const store = storeWith(doc);
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  store.setSelection(['t']);
  runCommand('object.shape-builder', ctx);
  assert.notEqual(store.getState().tool, SHAPE_BUILDER_TOOL);
  store.setSelection(['a']);
  runCommand('object.shape-builder', ctx);
  assert.equal(store.getState().tool, SHAPE_BUILDER_TOOL);
});

test('should cut the pieces of an extract again: touching arcs leave no slivers and no error', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: -120, y: -60, width: 120, height: 120});
    add('ELLIPSE', 'b', 'page', {x: -60, y: -60, width: 120, height: 120});
  });
  const store = storeWith(doc);
  const builder = builderOf(doc, ['a', 'b']);
  const selection = applyShapeBuilder(store, builder.parentId, builder.operands, builder.plan([builder.hit({x: -30, y: 0})], 'merge')!, 'merge');
  const again = builderOf(store.getState().doc, selection);
  assert.equal(again.regions.length, 3, 'the three pieces, nothing between them');
});
