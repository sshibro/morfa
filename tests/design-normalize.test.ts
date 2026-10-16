import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps} from '../shared/design/defaults';
import type {AutoLayout, DesignDocument, NodeType, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {textBoxSize} from '../shared/design/text-layout';
import {applyPatch} from '../shared/design/patch';
import {worldBox} from '../shared/design/geometry';
import {boundsOf, resizeUpdates} from '../shared/design/constraints';
import type {NodeUpdates} from '../shared/design/constraints';
import {groupFitUpdates} from '../shared/design/group-fit';
import {emptyNormalizeStats, normalizeDocument} from '../shared/design/normalize';
import {budget} from './helpers/speed';

const measurer: TextMeasurer = {
  width: (text, font) => text.length * font.size * 0.5,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

function build(doc = createDocument('page')) {
  const add = (type: NodeType, props: Partial<SceneNode> & {id: string}, parentId = 'page') => {
    const node = createNode(type, {...props, parentId});
    doc.nodes[node.id] = node;
    doc.nodes[parentId].children!.push(node.id);
    return node;
  };
  return {doc, add};
}

const auto = (mode: 'HORIZONTAL' | 'VERTICAL', props: Partial<AutoLayout> = {}): AutoLayout => ({...defaultAutoLayout(mode), ...props});
const hug = {layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'} as const;
const everything = (doc: DesignDocument) => new Set(Object.keys(doc.nodes));
const normalize = (doc: DesignDocument, dirty: Iterable<string> = everything(doc)) => normalizeDocument(doc, new Set(dirty), {measurer});

/** A copy of `doc` with `fields` merged into node `id` (what a transaction's update does). */
function edit(doc: DesignDocument, id: string, fields: Partial<SceneNode>): DesignDocument {
  return applyPatch(doc, {nodes: {[id]: {...doc.nodes[id], ...fields}}});
}
function apply(doc: DesignDocument, updates: NodeUpdates): DesignDocument {
  const nodes: Record<string, SceneNode> = {};
  for (const [id, patch] of updates) nodes[id] = {...doc.nodes[id], ...patch};
  return applyPatch(doc, {nodes});
}
function near(actual: number, expected: number, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≠ ${expected}`);
}
function nearBox(actual: {x: number; y: number; width: number; height: number}, expected: Partial<Record<'x' | 'y' | 'width' | 'height', number>>, label = '') {
  for (const [key, value] of Object.entries(expected)) near(actual[key as 'x'], value, `${label}.${key}`);
}

test('nothing to do returns the same document', () => {
  const {doc, add} = build();
  add('RECTANGLE', {id: 'r'});
  assert.equal(normalize(doc, []), doc);
  assert.equal(normalize(doc), doc);
});

test('auto-width text grows away from its alignment edge, auto-height text grows down', () => {
  const {doc, add} = build();
  for (const [id, align] of [['left', 'LEFT'], ['centre', 'CENTER'], ['right', 'RIGHT']] as const) {
    add('TEXT', {id, x: 100, y: 10, width: 40, height: 16, text: {...defaultTextProps('Hello'), textAlignHorizontal: align}});
  }
  add('TEXT', {id: 'turned', x: 100, y: 100, width: 40, height: 16, rotation: 90, text: {...defaultTextProps('Hello'), textAlignHorizontal: 'CENTER'}});
  add('TEXT', {id: 'para', x: 0, y: 0, width: 30, height: 16, text: {...defaultTextProps('Hello'), textAutoResize: 'HEIGHT', textAlignHorizontal: 'CENTER'}});
  let next = normalize(doc);
  const lengthened = {...defaultTextProps('Hello, world'), textAlignHorizontal: 'CENTER' as const};
  const centreOf = (d: DesignDocument, id: string) => {
    const box = worldBox(d, id);
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
  };
  const before = centreOf(next, 'turned');
  for (const id of ['left', 'centre', 'right', 'turned']) next = edit(next, id, {text: {...next.nodes[id].text!, characters: 'Hello, world'}});
  const out = normalize(next, ['left', 'centre', 'right', 'turned']);
  const size = textBoxSize({...out.nodes.left, text: lengthened}, measurer);
  const grow = size.width - next.nodes.left.width;
  near(out.nodes.left.x, 100, 'left');
  near(out.nodes.centre.x, 100 - grow / 2, 'centre');
  near(out.nodes.right.x, 100 - grow, 'right');
  near(centreOf(out, 'turned').x, before.x, 'a turned centred text keeps its centre');
  near(centreOf(out, 'turned').y, before.y, 'a turned centred text keeps its centre');
  near(out.nodes.para.x, 0, 'auto-height text keeps its position');
});

test('groups fit their children, rotated ones by their bounds, without moving anything on screen', () => {
  const {doc, add} = build();
  add('GROUP', {id: 'g', x: 50, y: 50, width: 100, height: 100, rotation: 30});
  add('RECTANGLE', {id: 'a', width: 50, height: 50}, 'g');
  add('RECTANGLE', {id: 'b', x: 50, y: 50, width: 50, height: 50}, 'g');
  add('RECTANGLE', {id: 'c', x: 20, y: 20, width: 40, height: 10, rotation: 45}, 'g');
  const laidOut = normalize(doc);
  assert.equal(laidOut, normalize(laidOut), 'stable');
  const moved = edit(laidOut, 'b', {x: 130, y: -40});
  const out = normalize(moved, ['b']);
  for (const id of ['a', 'b', 'c']) nearBox(worldBox(out, id), worldBox(moved, id), id);
  const fitted = ['a', 'b', 'c'].map(id => boundsOf(out.nodes[id]));
  near(Math.min(...fitted.map(r => r.x)), 0, 'children start at the group origin');
  near(Math.min(...fitted.map(r => r.y)), 0, 'children start at the group origin');
  const spread = ['a', 'b', 'c'].map(id => boundsOf(moved.nodes[id]));
  near(out.nodes.g.width, Math.max(...spread.map(r => r.x + r.width)) - Math.min(...spread.map(r => r.x)), 'g.width');
  near(out.nodes.g.height, Math.max(...spread.map(r => r.y + r.height)) - Math.min(...spread.map(r => r.y)), 'g.height');
  near(out.nodes.g.width, 180, 'g.width');
  assert.equal(normalize(out), out);
});

test('an emptied group is removed, and so is a group it empties', () => {
  const {doc, add} = build();
  add('GROUP', {id: 'outer'});
  add('GROUP', {id: 'inner'}, 'outer');
  add('RECTANGLE', {id: 'r', x: 10, y: 10, width: 10, height: 10}, 'inner');
  const laidOut = normalize(doc);
  const nodes: Record<string, SceneNode> = {...laidOut.nodes, inner: {...laidOut.nodes.inner, children: []}};
  delete nodes.r;
  const removed = {...laidOut, nodes};
  const {removed: gone} = groupFitUpdates(removed, ['inner']);
  assert.deepEqual(gone.sort(), ['inner', 'outer']);
  const out = normalize(removed, ['r', 'inner']);
  assert.equal(out.nodes.inner, undefined);
  assert.equal(out.nodes.outer, undefined);
  assert.deepEqual(out.nodes.page.children, []);
});

test('text in a group in an auto-layout frame: the group refits, then the frame lays out again', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'row', ...hug, autoLayout: auto('HORIZONTAL', {itemSpacing: 10})});
  add('GROUP', {id: 'g'}, 'row');
  add('TEXT', {id: 't', text: defaultTextProps('ab')}, 'g');
  add('RECTANGLE', {id: 'after', width: 10, height: 10}, 'row');
  const laidOut = normalize(doc);
  const changed = edit(laidOut, 't', {text: {...laidOut.nodes.t.text!, characters: 'abcdefghij'}});
  const stats = emptyNormalizeStats();
  const out = normalizeDocument(changed, new Set(['t']), {measurer, stats});
  const width = textBoxSize(out.nodes.t, measurer).width;
  near(out.nodes.g.width, width, 'group');
  near(out.nodes.after.x, width + 10, 'the next child moves');
  near(out.nodes.row.width, width + 20, 'the frame hugs');
  assert.ok(stats.rounds >= 2, 'layout ran again after the group refit');
  assert.equal(normalize(out), out);
});

test('sizing that no longer applies is corrected', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', ...hug, autoLayout: auto('HORIZONTAL')});
  add('RECTANGLE', {id: 'fill', layoutSizingHorizontal: 'FILL'}, 'f');
  add('FRAME', {id: 'plain'});
  const laidOut = normalize(doc);
  // The rectangle moves to a plain frame and the auto layout is turned off.
  let next = applyPatch(laidOut, {nodes: {
    f: {...laidOut.nodes.f, children: [], autoLayout: auto('HORIZONTAL', {layoutMode: 'NONE'})},
    plain: {...laidOut.nodes.plain, children: ['fill']},
    fill: {...laidOut.nodes.fill, parentId: 'plain'},
  }});
  next = normalize(next, ['f', 'plain', 'fill']);
  assert.equal(next.nodes.fill.layoutSizingHorizontal, 'FIXED');
  assert.equal(next.nodes.f.layoutSizingHorizontal, 'FIXED');
  assert.equal(next.nodes.f.layoutSizingVertical, 'FIXED');
});

test('auto-layout frames resized by constraints lay out their children, also when a layout resized their parent', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'shell', width: 300, layoutSizingVertical: 'HUG', autoLayout: auto('VERTICAL')});
  add('FRAME', {id: 'panel', width: 300, height: 50, layoutSizingHorizontal: 'FILL'}, 'shell');
  add('FRAME', {id: 'bar', x: 10, y: 10, width: 280, height: 30, constraints: {horizontal: 'STRETCH', vertical: 'MIN'}, autoLayout: auto('HORIZONTAL', {itemSpacing: 10})}, 'panel');
  add('RECTANGLE', {id: 'a', layoutSizingHorizontal: 'FILL', height: 30}, 'bar');
  add('RECTANGLE', {id: 'b', layoutSizingHorizontal: 'FILL', height: 30}, 'bar');
  const laidOut = normalize(doc);
  near(laidOut.nodes.a.width, 135, 'a');

  // By hand: the shell gets wider, the panel fills it, the bar stretches, its children share it.
  const updates = resizeUpdates(laidOut, 'shell', {x: 0, y: 0, width: 500, height: laidOut.nodes.shell.height});
  const out = normalize(apply(laidOut, updates), updates.keys());
  near(out.nodes.panel.width, 500, 'panel');
  near(out.nodes.bar.width, 480, 'bar');
  near(out.nodes.a.width, 235, 'a');
  near(out.nodes.b.x, 245, 'b');
  assert.equal(normalize(out), out);
});

test('normalizing is idempotent on a mixed document', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'screen', width: 375, height: 812});
  add('FRAME', {id: 'stack', x: 16, y: 40, width: 343, layoutSizingVertical: 'HUG', constraints: {horizontal: 'STRETCH', vertical: 'MIN'}, autoLayout: auto('VERTICAL', {itemSpacing: 12, paddingTop: 8, paddingBottom: 8})}, 'screen');
  add('TEXT', {id: 'title', ...{text: {...defaultTextProps('Heading'), style: {...defaultTextProps().style, fontSize: 28}}}}, 'stack');
  add('FRAME', {id: 'chips', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', autoLayout: auto('HORIZONTAL', {layoutWrap: 'WRAP', itemSpacing: 8, counterAxisSpacing: 8})}, 'stack');
  for (let i = 0; i < 7; i++) {
    add('FRAME', {id: `chip${i}`, ...hug, autoLayout: auto('HORIZONTAL', {paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6})}, 'chips');
    add('TEXT', {id: `chip${i}-label`, text: defaultTextProps('Label '.repeat(i % 3 + 1).trim())}, `chip${i}`);
  }
  add('GROUP', {id: 'icons'}, 'stack');
  add('ELLIPSE', {id: 'dot1', width: 8, height: 8}, 'icons');
  add('ELLIPSE', {id: 'dot2', x: 12, width: 8, height: 8, rotation: 20}, 'icons');
  add('TEXT', {id: 'body', text: {...defaultTextProps('Paragraph text'), textAutoResize: 'HEIGHT'}, layoutSizingHorizontal: 'FILL'}, 'stack');
  const once = normalize(doc);
  assert.notEqual(once, doc);
  assert.equal(normalize(once), once);
  for (const id of Object.keys(once.nodes)) assert.equal(normalize(once, [id]), once, `dirty ${id}`);
  const rows = new Set(Array.from({length: 7}, (_, i) => once.nodes[`chip${i}`].y));
  assert.ok(rows.size > 1, 'the chips wrap into rows');
});

test('after one edit in a 20 000-node file only the affected chain is evaluated', () => {
  const doc = createDocument('page');
  const {add} = build(doc);
  add('FRAME', {id: 'board', width: 2000, height: 2000});
  const cards = 2900;
  for (let i = 0; i < cards; i++) {
    add('FRAME', {id: `card${i}`, x: (i % 50) * 40, y: Math.floor(i / 50) * 40, ...hug, autoLayout: auto('VERTICAL', {itemSpacing: 4, paddingLeft: 8, paddingRight: 8})}, 'board');
    add('TEXT', {id: `title${i}`, text: defaultTextProps(`Card ${i}`)}, `card${i}`);
    add('TEXT', {id: `body${i}`, text: {...defaultTextProps('Text'), textAutoResize: 'HEIGHT'}, layoutSizingHorizontal: 'FILL'}, `card${i}`);
    add('FRAME', {id: `row${i}`, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', autoLayout: auto('HORIZONTAL', {primaryAxisAlignItems: 'SPACE_BETWEEN'})}, `card${i}`);
    add('TEXT', {id: `price${i}`, text: defaultTextProps('990 ₽')}, `row${i}`);
    add('RECTANGLE', {id: `icon${i}`, width: 12, height: 12}, `row${i}`);
    add('RECTANGLE', {id: `rule${i}`, height: 1, layoutSizingHorizontal: 'FILL'}, `card${i}`);
  }
  assert.ok(Object.keys(doc.nodes).length > 20_000);
  const laidOut = normalize(doc);

  let calls = 0;
  const counting: TextMeasurer = {width: (text, font) => (calls++, measurer.width(text, font)), metrics: font => measurer.metrics(font)};
  const changed = edit(laidOut, 'title7', {text: {...laidOut.nodes.title7.text!, characters: 'Card with a long title'}});
  const stats = emptyNormalizeStats();
  const started = performance.now();
  const out = normalizeDocument(changed, new Set(['title7']), {measurer: counting, stats});
  const elapsed = performance.now() - started;
  const width = textBoxSize({...out.nodes.title7}, measurer).width;
  near(out.nodes.card7.width, width + 16, 'the card hugs the longer title');
  near(out.nodes.body7.width, width, 'the body fills the new width');
  near(out.nodes.icon7.x, width - 12, 'space between pushes the icon to the edge');
  assert.equal(out.nodes.card8, laidOut.nodes.card8, 'other cards keep their objects');
  assert.ok(stats.measured + stats.arranged <= 10, `frames evaluated: ${stats.measured} measured, ${stats.arranged} arranged`);
  assert.ok(stats.textMeasured <= 6, `texts measured: ${stats.textMeasured}`);
  assert.ok(calls <= 60, `measurer calls: ${calls} (the file holds ${cards * 3} texts)`);
  assert.ok(elapsed < budget(250), `normalize took ${elapsed.toFixed(1)} ms`);
});
