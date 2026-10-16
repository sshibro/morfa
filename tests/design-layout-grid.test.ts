import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout} from '../shared/design/defaults';
import type {DesignDocument, GridChild, GridLayout, NodeType, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {normalizeDocument} from '../shared/design/normalize';
import {placeGridChildren, sizeGridTracks, trackOf} from '../shared/design/layout-grid';

// Grid auto layout against the behaviour Figma documents: cells in row-major auto flow
// with sparse packing, manual anchors with a fallback, auto rows, FIXED / FLEX / HUG tracks, FILL children stretched
// over their cells and the others aligned in them, a hugging frame sized by its tracks. The Rust stage is held to the
// same numbers by the stage oracle (tests/design-stage-diff.test.ts, scripts/layout/stage-diff.ts).

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

const grid = (props: Partial<GridLayout> = {}): GridLayout => ({rowCount: 2, columnCount: 2, rowGap: 0, columnGap: 0, rowSizes: [], columnSizes: [], autoTracks: 'NONE', itemsPositioning: 'ROW_AUTO_FLOW', ...props});
const gridFrame = (props: Partial<SceneNode> = {}, layout: Partial<GridLayout> = {}): Partial<SceneNode> => ({autoLayout: defaultAutoLayout('GRID'), grid: grid(layout), ...props});
const everything = (doc: DesignDocument) => new Set(Object.keys(doc.nodes));
const normalize = (doc: DesignDocument) => normalizeDocument(doc, everything(doc), {measurer});

function near(actual: number, expected: number, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≠ ${expected}`);
}
function nearBox(node: SceneNode, expected: Partial<Record<'x' | 'y' | 'width' | 'height', number>>, label = node.id) {
  for (const [key, value] of Object.entries(expected)) near(node[key as 'x'], value, `${label}.${key}`);
}
const child = (id: string, gridChild?: GridChild) => ({id, gridChild});

test('auto flow fills the cells row by row, spans pack sparsely, rows grow under auto tracks', () => {
  const flow = placeGridChildren(grid({columnCount: 3, rowCount: 1, autoTracks: 'ROWS'}), [child('a'), child('b', {columnSpan: 2}), child('c'), child('d', {rowSpan: 2}), child('e')]);
  // a at (0,0); b needs two columns: (0,1)-(0,2); c at (1,0); d at (1,1) two rows down; e at (1,2).
  assert.deepEqual([...flow.cells].map(([id, cell]) => [id, cell.row, cell.column, cell.rowSpan, cell.columnSpan]), [
    ['a', 0, 0, 1, 1], ['b', 0, 1, 1, 2], ['c', 1, 0, 1, 1], ['d', 1, 1, 2, 1], ['e', 1, 2, 1, 1],
  ]);
  assert.equal(flow.rows, 3, 'd spans into a third row');
  assert.equal(flow.columns, 3);
  // Without auto rows the stored count is a floor, never a ceiling.
  assert.equal(placeGridChildren(grid({columnCount: 3, rowCount: 5}), [child('a')]).rows, 5);
  assert.equal(placeGridChildren(grid({columnCount: 1, rowCount: 1}), [child('a'), child('b')]).rows, 2);
  // A span wider than the grid is clipped to it.
  assert.deepEqual(placeGridChildren(grid({columnCount: 2}), [child('a', {columnSpan: 9})]).cells.get('a'), {row: 0, column: 0, rowSpan: 1, columnSpan: 2});
  // The cursor never goes back: a small child after a wide one takes the next free cell, not an earlier hole.
  const sparse = placeGridChildren(grid({columnCount: 3, rowCount: 2}), [child('a', {columnSpan: 2}), child('b', {columnSpan: 2}), child('c')]);
  assert.deepEqual([sparse.cells.get('b'), sparse.cells.get('c')], [{row: 1, column: 0, rowSpan: 1, columnSpan: 2}, {row: 1, column: 2, rowSpan: 1, columnSpan: 1}]);
});

test('manual placement keeps anchored children in their cells; the rest flow from the first free cell', () => {
  const manual = placeGridChildren(grid({columnCount: 3, rowCount: 2, itemsPositioning: 'MANUAL'}), [
    child('late', {rowAnchorIndex: 1, columnAnchorIndex: 2}),
    child('taken', {rowAnchorIndex: 1, columnAnchorIndex: 2}),
    child('outside', {rowAnchorIndex: 0, columnAnchorIndex: 7}),
    child('loose'),
    child('wide', {rowAnchorIndex: 0, columnAnchorIndex: 1, columnSpan: 5}),
  ]);
  assert.deepEqual(manual.cells.get('late'), {row: 1, column: 2, rowSpan: 1, columnSpan: 1});
  assert.deepEqual(manual.cells.get('wide'), {row: 0, column: 1, rowSpan: 1, columnSpan: 2}, 'a span past the edge is clipped');
  // The three that could not sit where they said flow in layer order from (0,0): taken → (0,0), outside → (1,0), loose → (1,1).
  assert.deepEqual(manual.cells.get('taken'), {row: 0, column: 0, rowSpan: 1, columnSpan: 1});
  assert.deepEqual(manual.cells.get('outside'), {row: 1, column: 0, rowSpan: 1, columnSpan: 1});
  assert.deepEqual(manual.cells.get('loose'), {row: 1, column: 1, rowSpan: 1, columnSpan: 1});
  assert.equal(manual.rows, 2);
});

test('tracks: fixed, flex by weight, hug by content, and flex reads as hug on a hugged axis', () => {
  assert.deepEqual(trackOf([], 0), {kind: 'FLEX', value: 1});
  assert.deepEqual(trackOf([{type: 'FIXED'}], 0), {kind: 'FIXED', value: 0});
  assert.deepEqual(trackOf([{type: 'FLEX', value: -2}], 0), {kind: 'FLEX', value: 0});
  const spec = [{type: 'FIXED', value: 40}, {type: 'FLEX', value: 1}, {type: 'FLEX', value: 3}, {type: 'HUG'}] as const;
  type Cell = {start: number; span: number; content: number};
  const items: Cell[] = [{start: 3, span: 1, content: 25}, {start: 2, span: 2, content: 100}];
  // Fixed inner 300, gap 10: 40 + hug + 3 gaps leave the flex pair sharing 1:3.
  const sized = sizeGridTracks(spec, 4, 10, 300, items, item => [item.start, item.span], item => item.content);
  // Hug: 25 from the first item; the spanning item asks (100 − 10 − 0) / 1 = 90 of its only hug track (the flex track counts 0 here).
  near(sized[3], 90, 'hug');
  near(sized[0], 40, 'fixed');
  const free = 300 - (30 + 40 + 90);
  near(sized[1], free * 1 / 4, 'flex 1');
  near(sized[2], free * 3 / 4, 'flex 3');
  // Hugged axis: every flex track takes its content (the spanning item's 90 is shared by its two hug tracks); an empty one is 0.
  const hugged = sizeGridTracks(spec, 4, 10, undefined, items, item => [item.start, item.span], item => item.content);
  assert.deepEqual(hugged, [40, 0, 45, 45]);
});

test('a fixed grid: fill children stretch over their cells, the others align; gaps and padding count', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'g', x: 10, y: 20, width: 320, height: 200, ...gridFrame({autoLayout: {...defaultAutoLayout('GRID'), paddingLeft: 10, paddingRight: 10, paddingTop: 5, paddingBottom: 5}}, {
    columnCount: 2, rowCount: 2, columnGap: 20, rowGap: 10, columnSizes: [{type: 'FIXED', value: 100}, {type: 'FLEX'}], rowSizes: [{type: 'FLEX', value: 1}, {type: 'FLEX', value: 2}],
  })});
  add('RECTANGLE', {id: 'fill', width: 10, height: 10, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL'}, 'g');
  add('RECTANGLE', {id: 'centre', width: 30, height: 20, gridChild: {horizontalAlign: 'CENTER', verticalAlign: 'MAX'}}, 'g');
  add('RECTANGLE', {id: 'span', width: 10, height: 10, layoutSizingHorizontal: 'FILL', gridChild: {columnSpan: 2}}, 'g');
  const out = normalize(doc);
  // Inner 300 × 190; columns 100 and 300 − 100 − 20 = 180; rows share 190 − 10 = 180 as 60 and 120.
  nearBox(out.nodes.g, {x: 10, y: 20, width: 320, height: 200});
  nearBox(out.nodes.fill, {x: 10, y: 5, width: 100, height: 60});
  nearBox(out.nodes.centre, {x: 10 + 100 + 20 + (180 - 30) / 2, y: 5 + 60 - 20, width: 30, height: 20});
  nearBox(out.nodes.span, {x: 10, y: 5 + 60 + 10, width: 300, height: 10});
  assert.equal(normalize(out), out, 'normalizing a laid-out grid changes nothing');
});

test('a hugging grid takes its tracks: hug and flex tracks size by their content, fixed ones keep theirs', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'g', x: 0, y: 0, width: 50, height: 50, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', ...gridFrame({}, {
    columnCount: 3, rowCount: 1, columnGap: 4, rowGap: 6, autoTracks: 'ROWS', columnSizes: [{type: 'HUG'}, {type: 'FIXED', value: 50}, {type: 'FLEX'}],
  })});
  add('RECTANGLE', {id: 'a', width: 30, height: 20}, 'g');
  add('RECTANGLE', {id: 'b', width: 70, height: 10}, 'g');
  add('RECTANGLE', {id: 'c', width: 15, height: 40}, 'g');
  add('RECTANGLE', {id: 'd', width: 44, height: 12}, 'g');
  const out = normalize(doc);
  // Columns: hug 44 (a 30, d 44), fixed 50, flex-as-hug 15; two rows (auto): 40 and 12.
  nearBox(out.nodes.g, {width: 44 + 4 + 50 + 4 + 15, height: 40 + 6 + 12});
  nearBox(out.nodes.a, {x: 0, y: 0});
  nearBox(out.nodes.b, {x: 48, y: 0, width: 70, height: 10}, 'b overflows its fixed column and is not resized');
  nearBox(out.nodes.c, {x: 48 + 50 + 4, y: 0});
  nearBox(out.nodes.d, {x: 0, y: 46});
  assert.equal(normalize(out), out);
});

test('a grid without its object is one flex cell; absolute children and hidden ones stay out of the flow', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'g', x: 0, y: 0, width: 100, height: 80, autoLayout: defaultAutoLayout('GRID')});
  add('RECTANGLE', {id: 'a', width: 10, height: 10, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FILL'}, 'g');
  add('RECTANGLE', {id: 'abs', x: 70, y: 60, width: 10, height: 10, layoutPositioning: 'ABSOLUTE'}, 'g');
  add('RECTANGLE', {id: 'hidden', x: 3, y: 3, width: 10, height: 10, visible: false}, 'g');
  const out = normalize(doc);
  nearBox(out.nodes.a, {x: 0, y: 0, width: 100, height: 80});
  nearBox(out.nodes.abs, {x: 70, y: 60});
  nearBox(out.nodes.hidden, {x: 3, y: 3});
});
