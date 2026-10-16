import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid, BLACK, WHITE} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, GradientPaint, NodeType, Paint, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {RunOverride} from '../shared/design/text-edit';
import {createCommitter, writePaints, type Runner} from '../src/design/panels/design/paint/editing';
import {editsPartOfText, textPaintsOf} from '../src/design/panels/design/paint/text-paints';
import {createDesignStore} from '../src/design/engine/store';
import {applyTextOp} from '../src/design/engine/commands/text';
import {setActiveTextEdit} from '../src/design/engine/text-editor/registry';
import {
  MIXED, addStop, commonList, convertPaint, displayOrder, fillsWithColor, flipGradient, modelIndex, newDropShadow, newFill, newStroke, removeStop, reorderRows,
  replacingFill, rotateGradient, rowIndex, sideMode, sidePatch, takesFills, takesMarkers, takesStrokes,
} from '../src/design/panels/design/paint/paints';
import {collectDocumentColors, collectSelectionColors, nodesUsingColor, replaceColorUpdates, sameSelectionColors} from '../src/design/panels/design/paint/selection-colors';
import {colorKey, toHex} from '../src/design/panels/design/paint/color';
import {dropIndex, slideOf} from '../src/design/panels/design/paint/reorder';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const RED = {r: 1, g: 0, b: 0}, GREEN = {r: 0, g: 1, b: 0}, BLUE = {r: 0, g: 0, b: 1};

function build(recipe: (add: (type: NodeType, props: Partial<SceneNode> & {id: string}, parent?: string) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, props, parent = 'page') => tx.create(createNode(type, props), parent));
  return tx.commit({measurer}).doc;
}

test('rows list the top paint first while the model keeps fills[0] at the bottom', () => {
  const fills: Paint[] = [solid(RED), solid(GREEN), solid(BLUE)];
  assert.deepEqual(displayOrder(fills).map(paint => paint.type === 'SOLID' && toHex(paint.color)), ['0000FF', '00FF00', 'FF0000']);
  assert.equal(modelIndex(0, 3), 2);
  assert.equal(rowIndex(2, 3), 0);
  // Dragging the top row (blue) to the bottom of the list puts it at fills[0].
  const moved = reorderRows(fills, 0, 2);
  assert.deepEqual(moved.map(paint => paint.type === 'SOLID' && toHex(paint.color)), ['0000FF', 'FF0000', '00FF00']);
  // And back: the bottom row (now blue, row 2) to the top.
  assert.deepEqual(reorderRows(moved, 2, 0), fills);
  assert.deepEqual(reorderRows(fills, 1, 1), fills);
});

test('«+» adds Figma\'s defaults: grey shapes, white frames, black text, 20 % black over existing fills', () => {
  const hex = (paint: Paint) => (paint.type === 'SOLID' ? `${toHex(paint.color)}:${paint.opacity}` : paint.type);
  assert.equal(hex(newFill('RECTANGLE', [])), 'D9D9D9:1');
  assert.equal(hex(newFill('ELLIPSE', [])), 'D9D9D9:1');
  assert.equal(hex(newFill('FRAME', [])), 'FFFFFF:1');
  assert.equal(hex(newFill('COMPONENT', [])), 'FFFFFF:1');
  assert.equal(hex(newFill('TEXT', [])), '000000:1');
  assert.equal(hex(newFill('RECTANGLE', [solid(RED)])), '000000:0.2');
  assert.equal(hex(newStroke()), '000000:1');
  const shadow = newDropShadow();
  assert.deepEqual({color: shadow.color, offset: shadow.offset, radius: shadow.radius, spread: shadow.spread}, {color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y: 4}, radius: 4, spread: 0});
});

test('which layers take fills, strokes and line ends', () => {
  assert.equal(takesFills('GROUP'), false);
  assert.equal(takesFills('LINE'), false);
  assert.equal(takesFills('TEXT'), true);
  assert.equal(takesStrokes('GROUP'), false);
  assert.equal(takesStrokes('LINE'), true);
  const open = createNode('VECTOR', {id: 'v', vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 10}]}]});
  const closed = createNode('VECTOR', {id: 'w', vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 10}, {type: 'Z'}]}]});
  assert.equal(takesMarkers(open), true);
  assert.equal(takesMarkers(closed), false);
  assert.equal(takesMarkers(createNode('LINE', {id: 'l'})), true);
});

test('switching paint kinds keeps the colour and the stops', () => {
  const linear = convertPaint(solid(RED, 0.5), 'GRADIENT_LINEAR') as GradientPaint;
  assert.equal(linear.type, 'GRADIENT_LINEAR');
  assert.deepEqual(linear.gradientStops, [{position: 0, color: {...RED, a: 0.5}}, {position: 1, color: {...RED, a: 0}}]);
  assert.equal(linear.opacity, 1);
  const radial = convertPaint(linear, 'GRADIENT_RADIAL') as GradientPaint;
  assert.deepEqual(radial.gradientStops, linear.gradientStops, 'stops survive a gradient type switch');
  assert.deepEqual(radial.gradientHandlePositions, [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}]);
  const diamond = convertPaint(radial, 'GRADIENT_DIAMOND') as GradientPaint;
  assert.deepEqual(diamond.gradientHandlePositions, radial.gradientHandlePositions, 'centred kinds share handles');
  const back = convertPaint(linear, 'SOLID');
  assert.deepEqual(back.type === 'SOLID' && {color: back.color, opacity: back.opacity}, {color: RED, opacity: 0.5});
  const picture = convertPaint(solid(RED), 'IMAGE');
  assert.deepEqual(picture.type === 'IMAGE' && {ref: picture.imageRef, mode: picture.scaleMode}, {ref: '', mode: 'FILL'});
});

test('gradient stops: added with the colour at that point, kept at two or more, flipped and turned', () => {
  const paint = convertPaint(solid(BLACK), 'GRADIENT_LINEAR') as GradientPaint;
  const two = {...paint, gradientStops: [{position: 0, color: {r: 0, g: 0, b: 0, a: 1}}, {position: 1, color: {r: 1, g: 1, b: 1, a: 1}}]};
  const added = addStop(two, 0.25);
  assert.equal(added.index, 2);
  assert.deepEqual(added.paint.gradientStops[2], {position: 0.25, color: {r: 0.25, g: 0.25, b: 0.25, a: 1}});
  assert.equal(removeStop(two, 0), two, 'two stops stay');
  assert.equal(removeStop(added.paint, 2).gradientStops.length, 2);
  assert.deepEqual(flipGradient(added.paint).gradientStops.map(stop => stop.position), [1, 0, 0.75]);
  let turned = two;
  for (let i = 0; i < 4; i++) turned = rotateGradient(turned, 200, 100);
  turned.gradientHandlePositions.forEach((p, i) => {
    assert.ok(Math.abs(p.x - two.gradientHandlePositions[i].x) < 1e-9 && Math.abs(p.y - two.gradientHandlePositions[i].y) < 1e-9);
  });
  // A quarter turn of a top-to-bottom gradient runs right to left on screen.
  const quarter = rotateGradient(two, 100, 100).gradientHandlePositions;
  assert.deepEqual(quarter.slice(0, 2).map(p => ({x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100})), [{x: 1, y: 0.5}, {x: 0, y: 0.5}]);
});

test('lists that differ between layers read as mixed', () => {
  const a = [solid(RED)], b = [solid(RED)], c = [solid(BLUE)];
  assert.equal(commonList([a, b]), a);
  assert.equal(commonList([a, c]), MIXED);
  assert.deepEqual(commonList([]), []);
});

test('strokes per side: all, one side, or their own', () => {
  assert.equal(sideMode(null), 'ALL');
  assert.equal(sideMode({top: 2, right: 0, bottom: 0, left: 0}), 'TOP');
  assert.equal(sideMode({top: 0, right: 0, bottom: 0, left: 3}), 'LEFT');
  assert.equal(sideMode({top: 1, right: 2, bottom: 1, left: 1}), 'CUSTOM');
  assert.deepEqual(sidePatch('BOTTOM', 4), {individualStrokeWeights: {top: 0, right: 0, bottom: 4, left: 0}, strokeWeight: 4});
  assert.deepEqual(sidePatch('ALL', 2), {individualStrokeWeights: null, strokeWeight: 2});
  assert.deepEqual(sidePatch('CUSTOM', 1).individualStrokeWeights, {top: 1, right: 1, bottom: 1, left: 1});
});

test('dragged rows land past the middle of the rows they cross; the rows between slide one step', () => {
  const tops = [0, 32, 64];
  assert.equal(dropIndex(tops, 24, 0, 12), 0);
  assert.equal(dropIndex(tops, 24, 0, 44), 1);
  assert.equal(dropIndex(tops, 24, 0, 90), 2);
  assert.equal(dropIndex(tops, 24, 2, 10), 0);
  assert.equal(slideOf(1, 0, 2, 32), -32);
  assert.equal(slideOf(2, 0, 1, 32), 0);
  assert.equal(slideOf(0, 2, 0, 32), 32);
});

function colorful() {
  return build(add => {
    add('FRAME', {id: 'frame', width: 400, height: 400, fills: [solid(WHITE)]});
    add('RECTANGLE', {id: 'a', fills: [solid(RED)], strokes: [solid(BLUE)]}, 'frame');
    add('ELLIPSE', {id: 'b', fills: [solid(RED, 0.5)], effects: [{...newDropShadow(), color: {...RED, a: 1}}]}, 'frame');
    add('TEXT', {id: 't', text: {...defaultTextProps('Garden fog'), runs: [{start: 0, end: 6, style: {}, fills: [solid(RED)]}]}, fills: [solid(BLACK)]}, 'frame');
    add('RECTANGLE', {id: 'outside', fills: [solid(RED)]});
  });
}

test('selection colours gather fills, strokes, text ranges and shadows of the subtrees', () => {
  const doc = colorful();
  const uses = collectSelectionColors(doc, ['frame']);
  assert.deepEqual(uses.map(use => `${use.key}×${use.count}`), ['FFFFFF:100×1', 'FF0000:100×3', '0000FF:100×1', 'FF0000:50×1', '000000:100×1']);
  assert.deepEqual(nodesUsingColor(doc, ['frame'], colorKey(RED, 1)).sort(), ['a', 'b', 't']);
  assert.equal(collectSelectionColors(doc, ['frame'], 2).length, 3, 'the walk stops after two layers (the frame and the rectangle)');
});

test('selection colours stay listed after edits that keep them, and are listed again after ones that do not', () => {
  const doc = colorful();
  const set = (d: DesignDocument, id: string, patch: Partial<SceneNode>): DesignDocument => ({...d, nodes: {...d.nodes, [id]: {...d.nodes[id], ...patch}}});
  const before = collectSelectionColors(doc, ['frame']);
  // Moving, resizing and renaming keep every colour: only the changed nodes are compared.
  const moved = set(set(doc, 'frame', {x: 40}), 'a', {width: 90, name: 'New name'});
  assert.equal(sameSelectionColors(id => doc.nodes[id], moved, ['frame', 'a']), true);
  assert.deepEqual(collectSelectionColors(moved, ['frame']), before, 'a fresh listing agrees');
  // A new colour, other children, a layer that moved to another parent: listed again.
  assert.equal(sameSelectionColors(id => doc.nodes[id], set(doc, 'a', {fills: [solid(GREEN)]}), ['a']), false);
  assert.equal(sameSelectionColors(id => doc.nodes[id], set(doc, 'frame', {children: ['a', 'b']}), ['frame']), false);
  assert.equal(sameSelectionColors(id => doc.nodes[id], set(doc, 'outside', {parentId: 'frame'}), ['outside']), false);
  const removed = {...doc, nodes: {...doc.nodes}};
  delete removed.nodes.b;
  assert.equal(sameSelectionColors(id => doc.nodes[id], removed, ['b']), false);
  // The same colours in another object (an undo, a re-applied style) count as kept.
  assert.equal(sameSelectionColors(id => doc.nodes[id], set(doc, 'b', {fills: [solid(RED, 0.5)]}), ['b']), true);
});

test('replacing a selection colour changes it everywhere in the selection, and nowhere else', () => {
  const doc = colorful();
  const updates = replaceColorUpdates(doc, ['frame'], colorKey(RED, 1), GREEN, 0.8);
  assert.deepEqual([...updates.keys()].sort(), ['a', 'b', 't']);
  const a = updates.get('a')!;
  assert.deepEqual(a.fills, [solid(GREEN, 0.8)]);
  assert.equal(a.strokes, undefined, 'blue strokes stay');
  const b = updates.get('b')!;
  assert.equal(b.fills, undefined, 'the 50 % red is another colour');
  assert.deepEqual(b.effects![0].type === 'DROP_SHADOW' && b.effects![0].color, {...GREEN, a: 0.8});
  const t = updates.get('t')!;
  assert.deepEqual(t.text!.runs[0].fills, [solid(GREEN, 0.8)]);
  assert.equal(t.fills, undefined);
  assert.equal(updates.has('outside'), false);
});

test('document colours are ordered by use and cached per node table', () => {
  const doc = colorful();
  const colors = collectDocumentColors(doc);
  assert.equal(colors[0].key, colorKey(RED, 1));
  assert.equal(colors[0].count, 4);
  assert.deepEqual(collectDocumentColors(doc), colors);
  assert.equal(collectDocumentColors(doc, 2).length, 2);
  const changed = {...doc, nodes: {...doc.nodes, outside: {...doc.nodes.outside, fills: [solid(BLUE)]}}};
  assert.equal(collectDocumentColors(changed)[0].count, 3, 'a new node table is read again');
});

test('a text being edited shows the colour of its selection, or of what the caret types next', () => {
  const doc = build(add => add('TEXT', {id: 't', text: {...defaultTextProps('Garden fog'), runs: [{start: 0, end: 6, style: {}, fills: [solid(RED)]}]}, fills: [solid(BLACK)]}));
  const node = doc.nodes.t;
  const snap = (start: number, end: number, pending?: RunOverride | null) => ({id: 't', start, end, pending, version: 1});
  // Not edited: the whole text's colour, "Mixed" while a word is coloured on its own (as Figma shows it).
  assert.equal(textPaintsOf(node, null), 'mixed', 'not edited: a red word and black text differ');
  const plain = build(add => add('TEXT', {id: 't', text: defaultTextProps('Garden fog'), fills: [solid(BLACK)]})).nodes.t;
  assert.deepEqual(textPaintsOf(plain, null), [solid(BLACK)], 'not edited, one colour: the node colour');
  assert.deepEqual(textPaintsOf(node, snap(0, 6)), [solid(RED)]);
  assert.equal(textPaintsOf(node, snap(3, 9)), 'mixed');
  assert.deepEqual(textPaintsOf(node, snap(8, 8)), [solid(BLACK)], 'the caret types the colour around it');
  assert.deepEqual(textPaintsOf(node, snap(8, 8, {style: {}, fills: [solid(BLUE)]})), [solid(BLUE)], 'or the pending one');
  assert.equal(textPaintsOf(node, {...snap(0, 6), id: 'other'}), 'mixed', 'another text being edited: this one whole');
  assert.equal(editsPartOfText(node, snap(0, 6)), true);
  assert.equal(editsPartOfText(node, snap(0, 10)), false, 'all of it is the whole layer');
  assert.equal(editsPartOfText(node, null), false);
});

test('text colour goes through the text commands: a picker drag colours the edited range as one undo step', () => {
  const doc = build(add => add('TEXT', {id: 't', text: defaultTextProps('Garden fog'), fills: [solid(BLACK)]}));
  const store = createDesignStore({doc, measurer});
  store.setSelection(['t']);
  setActiveTextEdit(store, {id: 't', range: () => ({start: 0, end: 6}), pendingStyle: () => undefined, setPendingStyle: () => {}, focus: () => {}});
  const committer = createCommitter(store);
  const colour = (fills: Paint[]): Runner => ({run: (gesture, label) => void applyTextOp(store, {kind: 'fills', fills}, label, {ids: ['t'], gesture: gesture ?? undefined})});
  committer.begin('Fill');
  for (const g of [0.2, 0.4, 0.6]) committer.set('Fill', colour([solid({r: 1, g, b: 0})]));
  committer.end();
  const after = store.getState().doc.nodes.t;
  assert.deepEqual(after.fills, [solid(BLACK)], 'the rest keeps the node colour');
  assert.deepEqual(after.text!.runs.map(run => [run.start, run.end, run.fills]), [[0, 6, [solid({r: 1, g: 0.6, b: 0})]]]);
  assert.equal(store.getState().history.undo, 'Fill');
  store.undo();
  assert.ok(store.getState().doc.nodes.t.text!.runs.every(run => !run.fills), 'one undo takes the whole drag back');
  // A single change outside a drag is its own step.
  committer.set('Color', colour([solid(BLUE)]));
  assert.deepEqual(store.getState().doc.nodes.t.text!.runs[0].fills, [solid(BLUE)]);
  setActiveTextEdit(store, null);
});

test('plain lists are rewritten for every layer', () => {
  const doc = build(add => {
    add('RECTANGLE', {id: 'a', fills: [solid(RED)]});
    add('ELLIPSE', {id: 'b', fills: [solid(BLUE)]});
  });
  const tx = beginTransaction(doc);
  writePaints(tx, ['a', 'b'], 'fills', (paints, node) => (node.id === 'b' ? null : [...paints, solid(GREEN)]));
  const next = tx.commit({measurer}).doc;
  assert.deepEqual(next.nodes.a.fills, [solid(RED), solid(GREEN)]);
  assert.deepEqual(next.nodes.b.fills, [solid(BLUE)], 'null leaves a layer alone');
});

test('"+" over differing fills gives every layer the same fill, a text all of it', () => {
  // A text with a red word and a rectangle: the panel says "Mixed"; "+" makes them agree.
  assert.deepEqual(replacingFill(['RECTANGLE', 'ELLIPSE']), solid(newFill('RECTANGLE', []).color));
  assert.deepEqual(replacingFill(['TEXT', 'TEXT']), solid(BLACK), 'texts: black, their own default');
  assert.deepEqual(replacingFill(['FRAME', 'COMPONENT']), solid(WHITE));
  assert.equal(toHex(replacingFill(['TEXT', 'RECTANGLE', 'FRAME']).color), 'D9D9D9', 'kinds that disagree: the shape grey');
  const doc = build(add => {
    add('TEXT', {id: 't', text: {...defaultTextProps('Garden fog'), runs: [{start: 0, end: 6, style: {}, fills: [solid(RED)]}]}, fills: [solid(BLACK)]});
    add('RECTANGLE', {id: 'r', fills: [solid(BLUE)]});
  });
  const tx = beginTransaction(doc);
  const fill = replacingFill(['TEXT', 'RECTANGLE']);
  writePaints(tx, ['t', 'r'], 'fills', () => [structuredClone(fill)]);
  const next = tx.commit({measurer}).doc;
  assert.deepEqual(next.nodes.t.fills, [fill]);
  assert.equal(next.nodes.t.text!.runs.some(run => run.fills), false, 'the red word takes the new fill too');
  assert.deepEqual(textPaintsOf(next.nodes.t, null), [fill]);
  assert.deepEqual(next.nodes.r.fills, [fill]);
});

test('the pipette recolours the top visible solid fill or adds one', () => {
  assert.deepEqual(fillsWithColor([solid(RED, 0.5), solid(BLUE)], GREEN), [solid(RED, 0.5), solid(GREEN)]);
  assert.deepEqual(fillsWithColor([solid(RED), {...solid(BLUE), visible: false}], GREEN), [solid(GREEN), {...solid(BLUE), visible: false}]);
  assert.deepEqual(fillsWithColor([], GREEN), [solid(GREEN)]);
  const bound = {...solid(RED), boundVariables: {color: {type: 'VARIABLE_ALIAS' as const, id: 'v'}}};
  assert.deepEqual(fillsWithColor([bound], GREEN), [solid(GREEN)], 'a picked colour unbinds the variable');
});
