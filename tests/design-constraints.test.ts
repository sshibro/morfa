import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid, BLACK} from '../shared/design/defaults';
import type {DesignDocument, NodeType, SceneNode, ShadowEffect} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {applyPatch} from '../shared/design/patch';
import {worldBox} from '../shared/design/geometry';
import {boundsOf, constrainedBox, resizeUpdates, scaleUpdates, textModeAfterResize} from '../shared/design/constraints';
import type {NodeUpdates} from '../shared/design/constraints';
import {normalizeDocument} from '../shared/design/normalize';

const measurer: TextMeasurer = {
  width: (text, font) => text.length * font.size * 0.5,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

function build() {
  const doc = createDocument('page');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: string}, parentId = 'page') => {
    const node = createNode(type, {...props, parentId});
    doc.nodes[node.id] = node;
    doc.nodes[parentId].children!.push(node.id);
    return node;
  };
  return {doc, add};
}

/** The document with the updates merged in, as a transaction would. */
function apply(doc: DesignDocument, updates: NodeUpdates): DesignDocument {
  const nodes: Record<string, SceneNode | null> = {};
  for (const [id, patch] of updates) nodes[id] = {...doc.nodes[id], ...patch};
  return applyPatch(doc, {nodes});
}

function near(actual: number, expected: number, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≠ ${expected}`);
}
function nearBox(node: {x: number; y: number; width: number; height: number}, expected: Partial<Record<'x' | 'y' | 'width' | 'height', number>>, label = '') {
  for (const [key, value] of Object.entries(expected)) near(node[key as 'x'], value, `${label}.${key}`);
}

function constrained() {
  const {doc, add} = build();
  add('FRAME', {id: 'p', width: 100, height: 100});
  add('RECTANGLE', {id: 'min', x: 10, y: 10, width: 20, height: 20}, 'p');
  add('RECTANGLE', {id: 'max', x: 70, y: 70, width: 20, height: 20, constraints: {horizontal: 'MAX', vertical: 'MAX'}}, 'p');
  add('RECTANGLE', {id: 'center', x: 40, y: 40, width: 20, height: 20, constraints: {horizontal: 'CENTER', vertical: 'CENTER'}}, 'p');
  add('RECTANGLE', {id: 'stretch', x: 10, y: 10, width: 80, height: 80, constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}}, 'p');
  add('RECTANGLE', {id: 'scale', x: 10, y: 20, width: 20, height: 40, constraints: {horizontal: 'SCALE', vertical: 'SCALE'}}, 'p');
  return {doc, add};
}

test('children follow MIN, MAX, CENTER, STRETCH and SCALE when their frame is resized', () => {
  const {doc} = constrained();
  const before = JSON.stringify(doc);
  const out = apply(doc, resizeUpdates(doc, 'p', {x: 0, y: 0, width: 200, height: 150}));
  assert.equal(JSON.stringify(doc), before, 'the input document is not touched');
  nearBox(out.nodes.p, {width: 200, height: 150}, 'p');
  nearBox(out.nodes.min, {x: 10, y: 10, width: 20, height: 20}, 'min');
  nearBox(out.nodes.max, {x: 170, y: 120, width: 20, height: 20}, 'max');
  nearBox(out.nodes.center, {x: 90, y: 65, width: 20, height: 20}, 'center');
  nearBox(out.nodes.stretch, {x: 10, y: 10, width: 180, height: 130}, 'stretch');
  nearBox(out.nodes.scale, {x: 20, y: 30, width: 40, height: 60}, 'scale');
});

test('resizing from the left edge moves left-pinned children with it and keeps right-pinned ones', () => {
  const {doc} = constrained();
  const out = apply(doc, resizeUpdates(doc, 'p', {x: -50, y: 0, width: 150, height: 100}));
  nearBox(out.nodes.min, {x: 10}, 'min');
  nearBox(out.nodes.max, {x: 120}, 'max');
  near(worldBox(out, 'max').x, worldBox(doc, 'max').x, 'max stays on screen');
  near(worldBox(out, 'min').x, worldBox(doc, 'min').x - 50, 'min moves with the edge');
});

test('constraints work in the parent\'s own axes when the parent is rotated', () => {
  const {doc} = constrained();
  doc.nodes.p = {...doc.nodes.p, x: 300, y: 200, rotation: 30};
  const out = apply(doc, resizeUpdates(doc, 'p', {x: 300, y: 200, width: 160, height: 100}));
  nearBox(out.nodes.max, {x: 130, y: 70}, 'max');
  nearBox(out.nodes.stretch, {x: 10, width: 140}, 'stretch');
  const world = (d: DesignDocument, id: string) => worldBox(d, id);
  nearBox(world(out, 'min'), world(doc, 'min'), 'a pinned child stays put on screen when the far side moves');
});

test('a turned child is constrained by its bounding box', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'p', width: 100, height: 100});
  add('RECTANGLE', {id: 'r', x: 30, y: 70, width: 40, height: 20, rotation: 90, constraints: {horizontal: 'STRETCH', vertical: 'MAX'}}, 'p');
  const bounds = boundsOf(doc.nodes.r);
  const out = apply(doc, resizeUpdates(doc, 'p', {x: 0, y: 0, width: 150, height: 120}));
  nearBox(boundsOf(out.nodes.r), {x: bounds.x, y: bounds.y + 20, width: bounds.width + 50, height: bounds.height}, 'bounds');
  nearBox(out.nodes.r, {width: 40, height: 70}, 'its height runs across the parent');
  const zero = constrainedBox(doc.nodes.r, {width: 0, height: 0}, {width: 10, height: 10}, {horizontal: 'SCALE', vertical: 'SCALE'});
  assert.ok(Object.values(zero).every(Number.isFinite), 'scaling from a zero-size parent stays finite');
});

test('groups scale their children; vectors scale their paths', () => {
  const {doc, add} = build();
  add('GROUP', {id: 'g', width: 100, height: 100});
  add('RECTANGLE', {id: 'a', width: 50, height: 50, constraints: {horizontal: 'MAX', vertical: 'MAX'}}, 'g');
  add('VECTOR', {id: 'v', x: 50, y: 50, width: 50, height: 50, vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'C', x1: 10, y1: 0, x2: 50, y2: 40, x: 50, y: 50}]}]}, 'g');
  const out = apply(doc, resizeUpdates(doc, 'g', {x: 10, y: 0, width: 200, height: 50}));
  nearBox(out.nodes.g, {x: 10, width: 200, height: 50}, 'g');
  nearBox(out.nodes.a, {x: 0, y: 0, width: 100, height: 25}, 'a ignores its constraints inside a group');
  nearBox(out.nodes.v, {x: 100, y: 25, width: 100, height: 25}, 'v');
  assert.deepEqual(out.nodes.v.vectorPaths![0].commands, [{type: 'M', x: 0, y: 0}, {type: 'C', x1: 20, y1: 0, x2: 100, y2: 20, x: 100, y: 25}]);
});

test('text switches to a fixed side the way Figma does', () => {
  assert.equal(textModeAfterResize('WIDTH_AND_HEIGHT', true, false), 'HEIGHT');
  assert.equal(textModeAfterResize('WIDTH_AND_HEIGHT', true, true), 'NONE');
  assert.equal(textModeAfterResize('WIDTH_AND_HEIGHT', false, true), 'NONE');
  assert.equal(textModeAfterResize('HEIGHT', true, false), 'HEIGHT');
  assert.equal(textModeAfterResize('HEIGHT', false, true), 'NONE');
  assert.equal(textModeAfterResize('TRUNCATE', true, true), 'TRUNCATE');
  const {doc, add} = build();
  add('TEXT', {id: 't', width: 40, height: 16, text: defaultTextProps('Hello')});
  let updates = resizeUpdates(doc, 't', {x: 0, y: 0, width: 60, height: 16});
  assert.equal(updates.get('t')!.text!.textAutoResize, 'HEIGHT');
  assert.equal(updates.get('t')!.layoutSizingHorizontal, 'FIXED');
  assert.equal(updates.get('t')!.layoutSizingVertical, undefined, 'still hugs its height');
  updates = resizeUpdates(doc, 't', {x: 0, y: 0, width: 60, height: 30});
  assert.equal(updates.get('t')!.text!.textAutoResize, 'NONE');
  assert.equal(updates.get('t')!.layoutSizingVertical, 'FIXED');
});

test('a text stretched by its frame turns auto-height and gets its height in normalize', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'p', width: 100, height: 100});
  add('TEXT', {id: 't', x: 10, y: 10, width: 40, height: 16, text: defaultTextProps('Hello'), constraints: {horizontal: 'STRETCH', vertical: 'MIN'}}, 'p');
  const updates = resizeUpdates(doc, 'p', {x: 0, y: 0, width: 300, height: 100});
  const resized = apply(doc, updates);
  nearBox(resized.nodes.t, {x: 10, width: 240}, 't');
  assert.equal(resized.nodes.t.text!.textAutoResize, 'HEIGHT');
  const out = normalizeDocument(resized, new Set(updates.keys()), {measurer});
  near(out.nodes.t.width, 240, 'the width is kept, the height is measured');
});

test('auto-layout frames and children resized by hand stop hugging or filling on that side', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', width: 100, height: 40, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', autoLayout: defaultAutoLayout('HORIZONTAL')});
  add('RECTANGLE', {id: 'flow', width: 40, height: 40, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL'}, 'f');
  add('RECTANGLE', {id: 'pin', x: 90, y: 0, width: 10, height: 10, layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'MAX', vertical: 'MIN'}}, 'f');
  let updates = resizeUpdates(doc, 'f', {x: 0, y: 0, width: 150, height: 40});
  assert.deepEqual(updates.get('f'), {width: 150, layoutSizingHorizontal: 'FIXED'});
  assert.equal(updates.has('flow'), false, 'flow children wait for the layout');
  assert.deepEqual(updates.get('pin'), {x: 140});
  updates = resizeUpdates(doc, 'flow', {x: 0, y: 0, width: 40, height: 20});
  assert.deepEqual(updates.get('flow'), {height: 20, layoutSizingVertical: 'FIXED'});
});

test('nested frames pass the resize on, and sections leave their contents in place', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'p', width: 100, height: 100});
  add('FRAME', {id: 'q', x: 10, y: 10, width: 80, height: 80, constraints: {horizontal: 'STRETCH', vertical: 'MIN'}}, 'p');
  add('RECTANGLE', {id: 'r', x: 60, y: 0, width: 20, height: 20, constraints: {horizontal: 'MAX', vertical: 'MIN'}}, 'q');
  add('SECTION', {id: 's', width: 200, height: 200});
  add('RECTANGLE', {id: 'inside', x: 50, y: 50, width: 10, height: 10}, 's');
  let out = apply(doc, resizeUpdates(doc, 'p', {x: 0, y: 0, width: 200, height: 100}));
  nearBox(out.nodes.q, {width: 180}, 'q');
  nearBox(out.nodes.r, {x: 160}, 'r');
  out = apply(doc, resizeUpdates(doc, 's', {x: 20, y: 30, width: 180, height: 170}));
  nearBox(worldBox(out, 'inside'), worldBox(doc, 'inside'), 'inside');
});

test('the Scale tool scales sizes, positions, strokes, radii, effects, type and spacing', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'card', x: 10, y: 10, width: 100, height: 50, strokeWeight: 2, strokes: [solid(BLACK)], cornerRadius: 8, autoLayout: {...defaultAutoLayout('HORIZONTAL'), paddingLeft: 4, paddingTop: 6, itemSpacing: 5}});
  add('RECTANGLE', {id: 'r', x: 4, y: 6, width: 20, height: 20, rectangleCornerRadii: [1, 2, 3, 4], effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.2}, offset: {x: 2, y: 4}, radius: 8, spread: 1, visible: true, blendMode: 'NORMAL'}], effectStyleId: 'shadow'}, 'card');
  add('TEXT', {id: 't', x: 29, y: 6, width: 40, height: 16, textStyleId: 'body', text: {...defaultTextProps('Hello'), style: {...defaultTextProps().style, lineHeight: {unit: 'PIXELS', value: 20}, letterSpacing: {unit: 'PIXELS', value: 1}}, runs: [{start: 0, end: 2, style: {fontSize: 10}, textStyleId: 'small'}]}}, 'card');
  const out = apply(doc, scaleUpdates(doc, ['card', 'r'], {x: 10, y: 10}, 2, 2));
  nearBox(out.nodes.card, {x: 10, y: 10, width: 200, height: 100}, 'card');
  assert.equal(out.nodes.card.strokeWeight, 4);
  assert.equal(out.nodes.card.cornerRadius, 16);
  assert.deepEqual([out.nodes.card.autoLayout!.paddingLeft, out.nodes.card.autoLayout!.paddingTop, out.nodes.card.autoLayout!.itemSpacing], [8, 12, 10]);
  nearBox(out.nodes.r, {x: 8, y: 12, width: 40, height: 40}, 'r is scaled once, with its frame');
  assert.deepEqual(out.nodes.r.rectangleCornerRadii, [2, 4, 6, 8]);
  const shadow = out.nodes.r.effects[0] as ShadowEffect;
  assert.deepEqual([shadow.offset, shadow.radius, shadow.spread], [{x: 4, y: 8}, 16, 2]);
  assert.equal(out.nodes.r.effectStyleId, undefined, 'scaled values leave their style');
  const style = out.nodes.t.text!.style;
  assert.deepEqual([style.fontSize, style.lineHeight, style.letterSpacing], [32, {unit: 'PIXELS', value: 40}, {unit: 'PIXELS', value: 2}]);
  assert.deepEqual(out.nodes.t.text!.runs, [{start: 0, end: 2, style: {fontSize: 20}}]);
  assert.equal(out.nodes.t.textStyleId, undefined);
});
