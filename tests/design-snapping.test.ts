import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {OverlayItem} from '../src/design/engine/overlay';
import {alignDelta, collectTargets, createSmartGuides, snapPointTo, snapRect, spacingDelta, SPACING_COLOR, type SnapTargets} from '../src/design/engine/snapping';
import {createDesignStore} from '../src/design/engine/store';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const r = (x: number, y: number, width: number, height: number) => ({x, y, width, height});
const targets = (rects: SnapTargets['rects'], extra: Partial<SnapTargets> = {}): SnapTargets => ({rects, frames: [], guidesX: [], guidesY: [], ...extra});
const labels = (items: readonly OverlayItem[], color?: string) => items.filter(item => item.kind === 'label' && (!color || item.background === color)).map(item => (item.kind === 'label' ? item.text : ''));

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

test('edges and centres snap within the threshold, the nearest first', () => {
  const t = targets([r(0, 0, 100, 100)]);
  assert.equal(alignDelta(r(103, 200, 50, 50), t, 0, 5), -3, 'left edge onto the right edge');
  assert.equal(alignDelta(r(26, 200, 50, 50), t, 0, 5), -1, 'centre onto the centre (51 → 50)');
  assert.equal(alignDelta(r(48, 200, 50, 50), t, 0, 5), 2, 'right edge onto the right edge (98 → 100) beats nothing');
  assert.ok(Number.isNaN(alignDelta(r(110, 200, 50, 50), t, 0, 5)), 'beyond 5 px nothing snaps');
  assert.equal(alignDelta(r(0, 96, 10, 30), t, 1, 5), 4, 'vertical: top onto the bottom edge');
});

test('snapRect moves the box and draws red guides with crosses and the distance', () => {
  const t = targets([r(0, 0, 100, 100)]);
  const result = snapRect(r(2, 140, 50, 30), t, {threshold: 5});
  assert.equal(result.dx, -2);
  assert.equal(result.dy, 0);
  const line = result.guides.find(item => item.kind === 'line');
  assert.ok(line && line.kind === 'line');
  assert.deepEqual([line.from, line.to], [{x: 0, y: 0}, {x: 0, y: 170}], 'one line through both boxes along the shared left edge');
  assert.equal(line.color, '#F24822');
  assert.ok(result.guides.some(item => item.kind === 'point'), 'crosses where the edges meet the line');
  assert.deepEqual(labels(result.guides), ['40'], 'the gap between them');
});

test('frames and ruler guides are targets; frames are no spacing neighbours', () => {
  const frame = targets([], {frames: [r(0, 0, 400, 300)]});
  assert.equal(snapRect(r(397, 10, 50, 50), frame, {threshold: 5}).dx, 3, 'left edge on the frame’s right edge');
  const right = snapRect(r(347, 10, 50, 50), frame, {threshold: 5});
  assert.equal(right.dx, 3);
  const centred = snapRect(r(176, 10, 50, 50), frame, {threshold: 5});
  assert.equal(centred.dx, -1, 'centre on the frame’s centre line (201 → 200)');
  const guide = snapRect(r(98, 10, 50, 50), targets([], {guidesX: [100]}), {threshold: 5});
  assert.equal(guide.dx, 2, 'onto a vertical ruler guide');
});

test('equal spacing: centred between two neighbours, with pink gap badges', () => {
  const t = targets([r(0, 0, 100, 100), r(300, 0, 100, 100)]);
  const result = snapRect(r(173, 12, 50, 30), t, {threshold: 5});
  assert.equal(result.dx, 2, 'x 173 → 175: 75 on each side');
  assert.equal(result.dy, 0);
  assert.deepEqual(labels(result.guides, SPACING_COLOR), ['75', '75']);
});

test('equal spacing in a row: its pink badges give the gaps, no red distance repeats one', () => {
  const t = targets([r(0, 0, 100, 80), r(150, 0, 100, 80), r(300, 0, 100, 80)]);
  // The fourth lands 50 after the third (equal spacing) with its top on theirs (alignment).
  const result = snapRect(r(452, 3, 100, 80), t, {threshold: 5});
  assert.equal(result.dx, -2);
  assert.equal(result.dy, -3);
  assert.deepEqual(labels(result.guides, SPACING_COLOR), ['50', '50', '50']);
  assert.ok(result.guides.some(guide => guide.kind === 'line' && guide.color !== SPACING_COLOR), 'the alignment lines stay');
  assert.deepEqual(result.guides.filter(guide => guide.kind === 'label' && guide.background !== SPACING_COLOR), []);
});

test('equal spacing: repeats a gap the row already has', () => {
  // a and b are 40 apart; the moving box right of b lands 40 after it.
  const rects = [r(0, 0, 100, 100), r(140, 0, 100, 100)];
  const space = spacingDelta(r(283, 10, 50, 50), rects, 0, 5);
  assert.equal(space.gap, 40);
  assert.equal(space.delta, -3);
  const result = snapRect(r(283, 10, 50, 50), targets(rects), {threshold: 5});
  assert.equal(result.dx, -3);
  assert.deepEqual(labels(result.guides, SPACING_COLOR), ['40', '40'], 'both equal gaps are marked');
  assert.ok(Number.isNaN(spacingDelta(r(283, 300, 50, 50), rects, 0, 5).delta), 'boxes in another row do not count');
});

test('alignment wins over spacing at the same distance; pixels when nothing snaps', () => {
  // Spacing would move it 3 px right (to 175), the left edge of a layer in another row 3 px left.
  const t = targets([r(0, 0, 100, 100), r(300, 0, 100, 100), r(169, 500, 50, 50)]);
  const aligned = snapRect(r(172, 12, 50, 30), t, {threshold: 5});
  assert.equal(aligned.dx, -3);
  assert.equal(labels(aligned.guides, SPACING_COLOR).length, 0);
  const free = snapRect(r(1000.4, 2000.6, 10, 10), t, {threshold: 5, pixel: true});
  assert.ok(Math.abs(free.dx + 0.4) < 1e-9 && Math.abs(free.dy - 0.4) < 1e-9, 'whole pixels on both axes');
  assert.equal(free.guides.length, 0);
});

test('points snap per axis and only along the axes that move', () => {
  const t = targets([r(0, 0, 100, 100)]);
  const both = snapPointTo({x: 102, y: 97}, t, {threshold: 5});
  assert.deepEqual([both.x, both.y], [100, 100]);
  assert.ok(both.guides.some(item => item.kind === 'line'));
  const sideways = snapPointTo({x: 102, y: 97}, t, {threshold: 5, axes: {x: true, y: false}});
  assert.deepEqual([sideways.x, sideways.y], [100, 97]);
  const pixel = snapPointTo({x: 500.6, y: 400.2}, t, {threshold: 5, pixel: true});
  assert.deepEqual([pixel.x, pixel.y], [501, 400]);
});

test('targets: visible siblings on screen and the parent frame, not the moving layers', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 1000, height: 1000});
    add('RECTANGLE', 'a', 'f', {x: 10, y: 10, width: 50, height: 50});
    add('RECTANGLE', 'b', 'f', {x: 100, y: 10, width: 50, height: 50});
    add('RECTANGLE', 'hidden', 'f', {x: 200, y: 10, width: 50, height: 50, visible: false});
    add('RECTANGLE', 'far', 'f', {x: 900, y: 900, width: 50, height: 50});
    add('RECTANGLE', 'outside', 'page', {x: 2000, y: 0, width: 50, height: 50});
  });
  const t = collectTargets(doc, 'page', new Set(['f']), new Set(['a']), r(0, 0, 500, 500), null);
  assert.deepEqual(t.rects, [r(100, 10, 50, 50)], 'only b: a moves, hidden is hidden, far is off screen');
  assert.deepEqual(t.frames, [r(0, 0, 1000, 1000)]);
});

test('the hook snaps a drag against the store’s page, with ruler guides only while rulers show', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'b', 'page', {x: 500, y: 500, width: 100, height: 100});
  });
  const withGuides = {...doc, nodes: {...doc.nodes, page: {...doc.nodes.page, guides: [{axis: 'X' as const, offset: 300}]}}};
  const store = createDesignStore({doc: withGuides, measurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const hook = createSmartGuides({store, canvasSize: () => ({width: 1200, height: 900})});
  const context = {doc: withGuides, pageId: 'page', zoom: 1, exclude: new Set(['b'])};
  assert.equal(hook.snapMove(r(103, 300, 100, 100), context).dx, -3, 'b next to a');
  assert.equal(hook.snapMove(r(297, 600, 100, 100), context).dx, 0, 'no guide while the rulers are hidden');
  store.setUI({rulers: true});
  hook.end?.();
  assert.equal(hook.snapMove(r(297, 600, 100, 100), context).dx, 3, 'onto the guide');
  const zoomed = {...context, zoom: 4};
  assert.equal(hook.snapMove(r(103, 300, 100, 100), zoomed).dx, 0, 'at 400 % three page px are 12 screen px: too far');
});
