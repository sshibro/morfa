import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, Effect, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {blurReach, hasOpenPath, localRenderBounds, markerSize, renderBounds, strokeOutsets} from '../shared/design/bounds';

const BLACK = {r: 0, g: 0, b: 0};

function docWith(...nodes: Array<Partial<SceneNode> & {id: string; type: SceneNode['type']; parentId?: string}>): DesignDocument {
  const doc = createDocument('page');
  for (const {type, parentId = 'page', ...props} of nodes) {
    doc.nodes[props.id] = createNode(type, {...props, parentId});
    doc.nodes[parentId].children!.push(props.id);
  }
  return doc;
}

const shadow = (x: number, y: number, radius: number, spread = 0): Effect => ({type: 'DROP_SHADOW', color: {...BLACK, a: 0.5}, offset: {x, y}, radius, spread, visible: true, blendMode: 'NORMAL'});
const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} ≠ ${expected}`);
function rectClose(actual: {x: number; y: number; width: number; height: number} | null, expected: {x: number; y: number; width: number; height: number}) {
  assert.ok(actual);
  close(actual.x, expected.x, 'x');
  close(actual.y, expected.y, 'y');
  close(actual.width, expected.width, 'width');
  close(actual.height, expected.height, 'height');
}

test('a plain rectangle paints its box', () => {
  const doc = docWith({id: 'r', type: 'RECTANGLE', x: 10, y: 20, width: 100, height: 50});
  rectClose(renderBounds(doc, 'r'), {x: 10, y: 20, width: 100, height: 50});
});

test('strokes reach out by their alignment, per side for individual weights', () => {
  const base = {strokes: [solid(BLACK)], strokeWeight: 4};
  const inside = createNode('RECTANGLE', {id: 'a', ...base, strokeAlign: 'INSIDE'});
  const center = createNode('RECTANGLE', {id: 'b', ...base, strokeAlign: 'CENTER'});
  const outside = createNode('RECTANGLE', {id: 'c', ...base, strokeAlign: 'OUTSIDE'});
  assert.deepEqual(strokeOutsets(inside), {left: 0, top: 0, right: 0, bottom: 0});
  assert.equal(strokeOutsets(center).left, 2);
  assert.equal(strokeOutsets(outside).left, 4);
  const sides = createNode('RECTANGLE', {id: 'd', ...base, strokeAlign: 'OUTSIDE', individualStrokeWeights: {top: 1, right: 2, bottom: 3, left: 4}});
  assert.deepEqual(strokeOutsets(sides), {left: 4, top: 1, right: 2, bottom: 3});
  // A hidden stroke paints nothing.
  assert.equal(strokeOutsets({...outside, strokes: [{...solid(BLACK), visible: false}]}).left, 0);
  // Sharp vector corners with miter joins can reach the miter limit.
  const star = createNode('STAR', {id: 'e', ...base, strokeAlign: 'CENTER', strokeJoin: 'MITER', strokeMiterLimit: 4});
  assert.equal(strokeOutsets(star).left, 8);
});

test('open paths stroke centred and their markers reach past the ends', () => {
  const line = createNode('LINE', {id: 'l', width: 100, strokes: [solid(BLACK)], strokeWeight: 2, strokeAlign: 'INSIDE'});
  assert.ok(hasOpenPath(line));
  assert.equal(strokeOutsets(line).top, 1);
  const arrow = {...line, strokeEndMarker: 'TRIANGLE_ARROW' as const};
  assert.equal(strokeOutsets(arrow).top, markerSize(2));
  const closed = createNode('VECTOR', {id: 'v', vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 0}, {type: 'L', x: 0, y: 10}, {type: 'Z'}]}]});
  assert.equal(hasOpenPath(closed), false);
});

test('drop shadows grow by offset, spread and blur; layer blur by its reach', () => {
  const node = createNode('RECTANGLE', {id: 'r', width: 100, height: 100, effects: [shadow(10, 20, 8, 4)]});
  const grow = 4 + blurReach(8);
  // 16 px of spread and blur reach back past the 10 px offset on the left, not past the 20 px one on top.
  rectClose(localRenderBounds(node), {x: 10 - grow, y: 0, width: 100 + 2 * grow, height: 20 + grow + 100});
  const left = createNode('RECTANGLE', {id: 'q', width: 100, height: 100, effects: [shadow(-30, 0, 0)]});
  rectClose(localRenderBounds(left), {x: -30, y: 0, width: 130, height: 100});
  const blurred = createNode('RECTANGLE', {id: 'b', width: 100, height: 100, effects: [{type: 'LAYER_BLUR', radius: 10, visible: true}]});
  rectClose(localRenderBounds(blurred), {x: -15, y: -15, width: 130, height: 130});
  // Inner shadows and background blur stay inside; hidden effects count for nothing.
  const inner = createNode('RECTANGLE', {id: 'i', width: 100, height: 100, effects: [{...shadow(10, 10, 10, 10), type: 'INNER_SHADOW'} as Effect, {type: 'BACKGROUND_BLUR', radius: 20, visible: true}, {...shadow(50, 50, 50), visible: false}]});
  rectClose(localRenderBounds(inner), {x: 0, y: 0, width: 100, height: 100});
});

test('rotation turns the painted box, shadows included', () => {
  const doc = docWith({id: 'r', type: 'RECTANGLE', x: 0, y: 0, width: 100, height: 0.0001, rotation: -90});
  // −90° turns clockwise on screen: the box now hangs down from the origin.
  rectClose(renderBounds(doc, 'r'), {x: -0.0001, y: 0, width: 0.0001, height: 100});
  const withShadow = docWith({id: 's', type: 'RECTANGLE', x: 0, y: 0, width: 10, height: 10, rotation: 180, effects: [shadow(5, 0, 0)]});
  // The offset turns with the node: +5 local x is −5 page x.
  rectClose(renderBounds(withShadow, 's'), {x: -15, y: -10, width: 15, height: 10});
});

test('containers: clipping frames stop at their box, groups unite visible children and add their effects', () => {
  const doc = docWith(
    {id: 'f', type: 'FRAME', x: 100, y: 100, width: 50, height: 50},
    {id: 'inside', type: 'RECTANGLE', parentId: 'f', x: -20, y: -20, width: 200, height: 200},
    {id: 'g', type: 'GROUP', x: 0, y: 0, width: 30, height: 30, effects: [shadow(0, 10, 0)]},
    {id: 'a', type: 'RECTANGLE', parentId: 'g', x: 0, y: 0, width: 10, height: 10},
    {id: 'b', type: 'RECTANGLE', parentId: 'g', x: 20, y: 20, width: 10, height: 10},
    {id: 'hidden', type: 'RECTANGLE', parentId: 'g', x: 500, y: 500, width: 10, height: 10, visible: false},
    {id: 'open', type: 'FRAME', x: 300, y: 0, width: 10, height: 10, clipsContent: false},
    {id: 'out', type: 'RECTANGLE', parentId: 'open', x: 0, y: 0, width: 40, height: 5},
  );
  rectClose(renderBounds(doc, 'f'), {x: 100, y: 100, width: 50, height: 50});
  rectClose(renderBounds(doc, 'g'), {x: 0, y: 0, width: 30, height: 40});
  rectClose(renderBounds(doc, 'open'), {x: 300, y: 0, width: 40, height: 10});
  assert.equal(renderBounds(doc, 'hidden'), null);
  rectClose(renderBounds(doc, 'hidden', {includeHidden: true}), {x: 500, y: 500, width: 10, height: 10});
});

test('a slice answers with its box; text counts lines that overflow its box', () => {
  const doc = docWith({id: 's', type: 'SLICE', x: 5, y: 6, width: 7, height: 8});
  rectClose(renderBounds(doc, 's'), {x: 5, y: 6, width: 7, height: 8});
  const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
  const text = {...defaultTextProps('one\ntwo\nthree\nfour'), textAutoResize: 'NONE' as const};
  const node = createNode('TEXT', {id: 't', width: 100, height: 10, text});
  const bounds = localRenderBounds(node, measurer);
  assert.ok(bounds.height >= 4 * 16 - 1e-6, `four lines of 16 px overflow the 10 px box: ${bounds.height}`);
  assert.equal(localRenderBounds(node).height, 10);
});
