import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {layoutSizingUpdates} from '../shared/design/layout';
import {worldBox} from '../shared/design/geometry';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {layersLabel, mixedField, mixedOf, plural, sameValue} from '../src/design/panels/design/shared/mixed';
import {CONSTRAINT_LABELS, canBeAbsolute, constraintAfterClick, constraintParts, parentRelation} from '../src/design/panels/design/layout/constraints-model';
import {canLimit, limitValue, selectionSizingUpdates, showsSizing, sizingChoice} from '../src/design/panels/design/layout/sizing';
import {displayPlacement, displaySpaceId, isInFlow, positionUpdate, rotationUpdate, sizeUpdates} from '../src/design/panels/design/layout/geometry';
import {flipUpdates, rotateUpdates} from '../src/design/panels/design/layout/flip';
import {alignableIds} from '../src/design/engine/commands/align';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

const apply = (doc: DesignDocument, updates: Map<NodeId, Partial<SceneNode>>): DesignDocument => {
  const tx = beginTransaction(doc);
  for (const [id, partial] of updates) tx.update(id, partial);
  return tx.commit({measurer}).doc;
};

// ── Mixed values ───────────────────────────────────────────────────────────────────────────────

test('mixed values: one value, "Mixed", or nothing', () => {
  assert.equal(mixedOf([4, 4, 4]), 4);
  assert.equal(mixedOf([4, 5]), 'mixed');
  assert.equal(mixedOf([]), null);
  assert.equal(mixedOf([undefined, 3, undefined]), 3, 'nodes without the field are skipped');
  assert.notEqual(mixedOf([0.1 + 0.2, 0.3]), 'mixed', 'float noise is not a difference');
  assert.deepEqual(mixedOf([{horizontal: 'MIN', vertical: 'MAX'}, {horizontal: 'MIN', vertical: 'MAX'}]), {horizontal: 'MIN', vertical: 'MAX'});
  assert.equal(mixedOf([[1, 2], [1, 3]]), 'mixed');
  const a = createNode('RECTANGLE', {id: 'a', opacity: 0.5}), b = createNode('RECTANGLE', {id: 'b', opacity: 0.5}), c = createNode('ELLIPSE', {id: 'c', opacity: 1});
  assert.equal(mixedField([a, b], node => node.opacity), 0.5);
  assert.equal(mixedField([a, b, c], node => node.opacity), 'mixed');
  assert.equal(mixedField([a, c], node => node.cornerRadius), 0, 'an ellipse has no radius and does not make it mixed');
  assert.ok(sameValue({x: 1, y: undefined}, {x: 1}));
});

test('plurals for the layer count', () => {
  assert.equal(layersLabel(1), '1 layer');
  assert.equal(layersLabel(3), '3 layers');
  assert.equal(layersLabel(11), '11 layers');
  assert.equal(layersLabel(21), '21 layers');
  assert.equal(plural(12, 'file', 'files'), 'files');
});

// ── Constraints widget ─────────────────────────────────────────────────────────────────────────

test('constraint widget: clicks pin a side, ⇧ adds or removes the opposite side, centre lines centre', () => {
  assert.equal(constraintAfterClick('MIN', 'end', false), 'MAX');
  assert.equal(constraintAfterClick('MAX', 'start', false), 'MIN');
  assert.equal(constraintAfterClick('STRETCH', 'start', false), 'MIN', 'a plain click keeps only that side');
  assert.equal(constraintAfterClick('MIN', 'end', true), 'STRETCH');
  assert.equal(constraintAfterClick('MAX', 'start', true), 'STRETCH');
  assert.equal(constraintAfterClick('STRETCH', 'start', true), 'MAX', '⇧ on a stretched side takes it off');
  assert.equal(constraintAfterClick('STRETCH', 'end', true), 'MIN');
  assert.equal(constraintAfterClick('MIN', 'start', true), 'MIN');
  assert.equal(constraintAfterClick('CENTER', 'end', true), 'MAX');
  assert.equal(constraintAfterClick('SCALE', 'start', true), 'MIN');
  assert.equal(constraintAfterClick('MIN', 'center', false), 'CENTER');
  assert.equal(constraintAfterClick('STRETCH', 'center', true), 'CENTER');
  assert.deepEqual(constraintParts('MIN'), {start: true, end: false, center: false});
  assert.deepEqual(constraintParts('MAX'), {start: false, end: true, center: false});
  assert.deepEqual(constraintParts('STRETCH'), {start: true, end: true, center: false});
  assert.deepEqual(constraintParts('CENTER'), {start: false, end: false, center: true});
  assert.deepEqual(constraintParts('SCALE'), {start: false, end: false, center: false});
  assert.deepEqual(constraintParts('mixed'), {start: false, end: false, center: false});
  assert.equal(CONSTRAINT_LABELS.horizontal.STRETCH, 'Left and right');
  assert.equal(CONSTRAINT_LABELS.vertical.MAX, 'Bottom');
});

test('which relation the position section shows: constraints, flow or nothing', () => {
  const doc = build(add => {
    add('FRAME', 'plain', 'page', {width: 300, height: 300});
    add('RECTANGLE', 'inPlain', 'plain');
    add('FRAME', 'al', 'page', {autoLayout: defaultAutoLayout('HORIZONTAL')});
    add('RECTANGLE', 'flow', 'al');
    add('RECTANGLE', 'absolute', 'al', {layoutPositioning: 'ABSOLUTE'});
    add('GROUP', 'g', 'plain');
    add('RECTANGLE', 'inGroup', 'g');
    add('RECTANGLE', 'top', 'page');
  });
  const relation = (id: NodeId) => parentRelation(doc, doc.nodes[id]);
  assert.equal(relation('inPlain'), 'constraints');
  assert.equal(relation('flow'), 'flow');
  assert.equal(relation('absolute'), 'constraints');
  assert.equal(relation('inGroup'), null);
  assert.equal(relation('top'), null);
  assert.equal(relation('g'), 'constraints');
  assert.ok(canBeAbsolute(doc, doc.nodes.flow));
  assert.ok(!canBeAbsolute(doc, doc.nodes.inPlain));
});

// ── Sizing dropdowns ───────────────────────────────────────────────────────────────────────────

function layoutDoc() {
  return build(add => {
    add('FRAME', 'outer', 'page', {width: 400, height: 200, autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 10}, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'});
    add('RECTANGLE', 'a', 'outer', {width: 50, height: 40});
    add('RECTANGLE', 'b', 'outer', {width: 70, height: 60});
    add('TEXT', 't', 'outer', {text: defaultTextProps('Hello'), width: 40, height: 20});
    add('FRAME', 'plain', 'page', {x: 600, width: 100, height: 100});
    add('RECTANGLE', 'c', 'plain');
  });
}

test('sizing dropdown offers what every selected node can take', () => {
  const doc = layoutDoc();
  const nodes = (ids: NodeId[]) => ids.map(id => doc.nodes[id]);
  assert.deepEqual(sizingChoice(doc, nodes(['outer']), 'horizontal'), {value: 'HUG', hug: true, fill: false});
  assert.deepEqual(sizingChoice(doc, nodes(['a']), 'horizontal'), {value: 'FIXED', hug: false, fill: true});
  assert.deepEqual(sizingChoice(doc, nodes(['t']), 'horizontal'), {value: 'HUG', hug: true, fill: true});
  assert.deepEqual(sizingChoice(doc, nodes(['a', 't']), 'horizontal'), {value: 'mixed', hug: false, fill: true});
  assert.ok(showsSizing(doc, nodes(['outer'])));
  assert.ok(showsSizing(doc, nodes(['a', 't'])));
  assert.ok(!showsSizing(doc, nodes(['c'])), 'a child of a plain frame has nothing but fixed');
  assert.ok(!showsSizing(doc, nodes(['plain'])));
  assert.ok(canLimit(doc, doc.nodes.a) && canLimit(doc, doc.nodes.outer) && !canLimit(doc, doc.nodes.c));
});

test('sizing choices go through layoutSizingUpdates for each node in turn', () => {
  const doc = layoutDoc();
  // FILL on the main axis of a hugging parent: the child fills, the parent becomes fixed (Figma).
  const fill = selectionSizingUpdates(doc, ['a', 'b'], 'horizontal', 'FILL');
  assert.equal(fill.get('a')?.layoutSizingHorizontal, 'FILL');
  assert.equal(fill.get('b')?.layoutSizingHorizontal, 'FILL');
  assert.equal(fill.get('outer')?.layoutSizingHorizontal, 'FIXED');
  const single = layoutSizingUpdates(doc, 'a', 'horizontal', 'FILL');
  assert.deepEqual(fill.get('a'), single.get('a'), 'the same fields as the shared helper');
  // Text: hugging the width makes it auto-width; fixing it keeps an automatic height.
  const hug = selectionSizingUpdates(doc, ['t'], 'horizontal', 'FIXED');
  assert.equal(hug.get('t')?.text?.textAutoResize, 'HEIGHT');
  // An option a node cannot have changes nothing for it.
  assert.equal(selectionSizingUpdates(doc, ['a'], 'horizontal', 'HUG').size, 0);
  assert.equal(selectionSizingUpdates(doc, ['c'], 'horizontal', 'FILL').size, 0);
  // Applied, the layout engine fills the remaining width.
  const next = apply(doc, selectionSizingUpdates(doc, ['a'], 'horizontal', 'FILL'));
  assert.equal(next.nodes.a.layoutSizingHorizontal, 'FILL');
  assert.equal(next.nodes.outer.layoutSizingHorizontal, 'FIXED');
});

test('min/max limits read as mixed when only some nodes have them', () => {
  const a = createNode('RECTANGLE', {id: 'a', minWidth: 40}), b = createNode('RECTANGLE', {id: 'b', minWidth: 40}), c = createNode('RECTANGLE', {id: 'c'});
  assert.equal(limitValue([a, b], 'minWidth'), 40);
  assert.equal(limitValue([a, c], 'minWidth'), 'mixed');
  assert.equal(limitValue([c], 'minWidth'), undefined);
  assert.equal(limitValue([a, b], 'maxWidth'), undefined);
});

// ── Position and size ──────────────────────────────────────────────────────────────────────────

test('X and Y are shown in the frame space for layers inside groups', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 100, y: 100, width: 400, height: 400});
    add('GROUP', 'g', 'f', {x: 0, y: 0, width: 10, height: 10});
    add('RECTANGLE', 'r', 'g', {x: 30, y: 40, width: 20, height: 10});
    add('RECTANGLE', 's', 'g', {x: 80, y: 90, width: 20, height: 10});
  });
  // The group fits its children; the rectangle's own x is relative to the group.
  assert.equal(displaySpaceId(doc, 'r'), 'f');
  assert.notEqual(doc.nodes.r.x, 30, 'the group moved its children into its own space');
  assert.deepEqual(displayPlacement(doc, doc.nodes.r), {x: 30, y: 40, rotation: 0});
  const moved = apply(doc, new Map([['r', positionUpdate(doc, doc.nodes.r, 'x', 50)]]));
  assert.equal(displayPlacement(moved, moved.nodes.r).x, 50);
  assert.equal(displayPlacement(moved, moved.nodes.s).x, 80, 'the sibling stays put while the group refits');
  assert.equal(worldBox(moved, 'r').x, 150);
});

test('rotation turns the layer about its centre', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 0, y: 0, width: 100, height: 50}));
  const before = worldBox(doc, 'r');
  const next = apply(doc, new Map([['r', rotationUpdate(doc, doc.nodes.r, 90)]]));
  assert.equal(next.nodes.r.rotation, 90);
  const after = worldBox(next, 'r');
  assert.ok(Math.abs(after.x + after.width / 2 - (before.x + before.width / 2)) < 1e-6);
  assert.ok(Math.abs(after.y + after.height / 2 - (before.y + before.height / 2)) < 1e-6);
  assert.ok(Math.abs(after.width - 50) < 1e-6 && Math.abs(after.height - 100) < 1e-6);
  const turned = apply(doc, rotateUpdates(doc, ['r'], -90));
  assert.equal(turned.nodes.r.rotation, -90);
});

test('size edits go through resizeUpdates: constraints apply to children, proportions can be kept', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {width: 200, height: 100});
    add('RECTANGLE', 'right', 'f', {x: 150, y: 10, width: 40, height: 20, constraints: {horizontal: 'MAX', vertical: 'MIN'}});
    add('RECTANGLE', 'stretch', 'f', {x: 10, y: 10, width: 180, height: 20, constraints: {horizontal: 'STRETCH', vertical: 'MIN'}});
  });
  const wider = sizeUpdates(doc, 'f', {width: 300});
  assert.equal(wider.get('f')?.width, 300);
  assert.equal(wider.get('right')?.x, 250);
  assert.equal(wider.get('stretch')?.width, 280);
  const locked = sizeUpdates(doc, 'f', {width: 400}, true);
  assert.equal(locked.get('f')?.height, 200);
  const line = build(add => add('LINE', 'l', 'page', {width: 100}));
  assert.equal(sizeUpdates(line, 'l', {width: 50, height: 40}).get('l')?.height, undefined, 'a line keeps no height');
});

test('flow children of auto layout cannot be positioned by hand', () => {
  const doc = layoutDoc();
  assert.ok(isInFlow(doc, doc.nodes.a));
  assert.ok(!isInFlow(doc, doc.nodes.c));
  assert.deepEqual(alignableIds(doc, ['a', 'c']), ['c'], 'the alignment row agrees');
});

// ── Flips (the "Rotation" row) ──────────────────────────────────────────────────────────────────

function rowDoc() {
  return build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 10, height: 10});
    add('RECTANGLE', 'b', 'page', {x: 50, y: 20, width: 20, height: 30});
    add('RECTANGLE', 'c', 'page', {x: 200, y: 5, width: 10, height: 10});
    add('FRAME', 'f', 'page', {x: 400, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'child', 'f', {x: 10, y: 10, width: 20, height: 20});
  });
}

test('flip mirrors the selection as one piece', () => {
  const doc = rowDoc();
  const flipped = apply(doc, flipUpdates(doc, ['a', 'c'], 'x'));
  assert.equal(flipped.nodes.a.flipX, true);
  assert.ok(Math.abs(worldBox(flipped, 'a').x - 200) < 1e-6, 'the left layer ends up on the right');
  assert.ok(Math.abs(worldBox(flipped, 'c').x) < 1e-6);
});
