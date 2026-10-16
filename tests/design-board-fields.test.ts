import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoardDocument} from '../shared/design/board/document';
import {worldBox} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import {validateDocument} from '../shared/design/schema';
import type {DesignDocument, NodeId, PathCommand, SceneNode, Vec} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createConnector, createShape, insertPieces, type BoardBuild} from '../shared/design/board/create';
import {childPart} from '../shared/design/board/model';
import {BOARD_FLOWCHART_SHAPES, boardShapeGeometry} from '../shared/design/board/shapes';
import {endAtPoint, pathMidpoint, pathPointAt, routeConnector, samplePath} from '../shared/design/board/connectors';
import {installBoardSteps} from '../shared/design/board/install';
import type {BoardMeta} from '../shared/design/board/types';

// The board's new document fields: a connector end anywhere on an object, the
// label's place along the line, waypoints, merged table cells, the section's flags, FigJam's other flowchart figures. The
// schema cases mirror crates/model/tests/document.rs `board_fields_of_step_three` (scripts/model/check.ts --parity runs them
// against Rust on the fixtures and 10 000 mutants). Connector geometry is TypeScript only: boards normalize in TypeScript
// (shared/design/normalize.ts declines the Rust pass for a board), so there is no Rust path to compare it with.

installBoardSteps();

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
let serial = 0;
const ids = () => 'f' + ++serial;
function add(doc: DesignDocument, ...builds: BoardBuild[]): DesignDocument {
  const tx = beginTransaction(doc);
  for (const build of builds) insertPieces(tx, build, doc.pages[0]);
  return tx.commit({measurer}).doc;
}
const edit = (doc: DesignDocument, recipe: (tx: ReturnType<typeof beginTransaction>) => void) => {
  const tx = beginTransaction(doc);
  recipe(tx);
  return tx.commit({measurer}).doc;
};
const get = (doc: DesignDocument) => (id: NodeId | null | undefined) => (id ? doc.nodes[id] : undefined);
type Connector = Extract<BoardMeta, {kind: 'connector'}>;
const meta = (doc: DesignDocument, id: NodeId) => doc.nodes[id].board as Connector;
/** The line's points in page space (curves sampled). */
const linePoints = (doc: DesignDocument, connectorId: NodeId): Vec[] => {
  const line = childPart(get(doc), doc.nodes[connectorId], 'line')!;
  const box = worldBox(doc, line.id);
  return samplePath(line.vectorPaths![0].commands).map(p => ({x: box.x + p.x, y: box.y + p.y}));
};
const near = (a: Vec, b: Vec, eps = 1e-6) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
const valid = (doc: DesignDocument) => {
  const result = validateDocument(doc);
  assert.ok(result.ok, result.ok ? '' : `${result.error} at ${result.path}`);
  assert.deepEqual(result.ok && result.value, doc, 'the schema keeps every board field');
};

/** A page with one rectangle whose `board` is `meta`: the verdict of `validateDocument`. */
function verdict(board: unknown): boolean {
  const doc = createBoardDocument('page');
  const node = {...boardShapeNode(), board} as unknown as SceneNode;
  return validateDocument({...doc, nodes: {...doc.nodes, page: {...doc.nodes.page, children: [node.id]}, [node.id]: node}}).ok;
}
function boardShapeNode(): SceneNode {
  const build = createShape(() => 'rect', {x: 0, y: 0, shape: 'square'});
  return {...build.pieces[0].node, parentId: 'page'};
}

test('the schema takes the new fields, each optional and bounded (as crates/model validate.rs does)', () => {
  const connector = (extra: object) => ({kind: 'connector', line: 'curved', start: {node: 'frame', magnet: 'auto'}, end: {x: 0, y: 0}, ...extra});
  assert.ok(verdict(connector({end: {node: 'frame', at: {x: 0.25, y: 1}}})));
  assert.ok(!verdict(connector({end: {node: 'frame', at: {x: 1.5, y: 0}}})));
  assert.ok(!verdict(connector({end: {node: 'bad id', at: {x: 0, y: 0}}})));
  assert.ok(verdict(connector({labelAt: 0, points: []})));
  assert.ok(verdict(connector({labelAt: 1, points: [{x: -5, y: 1e9}]})));
  assert.ok(!verdict(connector({labelAt: 1.01})));
  assert.ok(!verdict(connector({points: [{x: 1}]})));
  assert.ok(!verdict(connector({points: Array.from({length: 1001}, () => ({x: 0, y: 0}))})));
  assert.ok(verdict({kind: 'part', part: 'cell', colSpan: 2, rowSpan: 1000}));
  assert.ok(!verdict({kind: 'part', part: 'cell', colSpan: 0}));
  assert.ok(!verdict({kind: 'part', part: 'cell', rowSpan: 1.5}));
  assert.ok(!verdict({kind: 'part', part: 'cell', rowSpan: 1001}));
  assert.ok(verdict({kind: 'section'}));
  assert.ok(verdict({kind: 'section', hidden: true, backgroundLocked: false}));
  assert.ok(!verdict({kind: 'section', hidden: 1}));
  for (const shape of BOARD_FLOWCHART_SHAPES) assert.ok(verdict({kind: 'shape', shape: shape.id}), shape.id);
  assert.ok(!verdict({kind: 'shape', shape: 'cloud'}));
});

test('FigJam\'s other flowchart figures draw inside their box', () => {
  for (const shape of BOARD_FLOWCHART_SHAPES) {
    const {type, fields} = boardShapeGeometry(shape.id, 200, 120);
    assert.equal(type, 'VECTOR', shape.id);
    for (const path of fields.vectorPaths!) for (const c of path.commands as PathCommand[]) {
      if (c.type === 'Z') continue;
      assert.ok(c.x >= -1e-9 && c.x <= 200 + 1e-9 && c.y >= -1e-9 && c.y <= 120 + 1e-9, `${shape.id}: ${JSON.stringify(c)}`);
    }
  }
});

test('an end anywhere on an object sits at its fraction of the box and leaves along the nearest side', () => {
  const object = {node: {width: 200, height: 100}, world: [[1, 0, 10], [0, 1, 20]] as [[number, number, number], [number, number, number]]};
  assert.deepEqual(endAtPoint(object, {x: 0.25, y: 1}), {point: {x: 60, y: 120}, normal: {x: 0, y: 1}, side: 'bottom'});
  assert.deepEqual(endAtPoint(object, {x: 1, y: 0.4}), {point: {x: 210, y: 60}, normal: {x: 1, y: 0}, side: 'right'});
  assert.deepEqual(endAtPoint(object, {x: 0.5, y: 0.5}), {point: {x: 110, y: 70}, normal: null, side: null}, 'the centre has no side');
  // A turned object: the point and the normal turn with it.
  const turned = {node: {width: 100, height: 100}, world: [[0, -1, 0], [1, 0, 0]] as [[number, number, number], [number, number, number]]};
  const end = endAtPoint(turned, {x: 1, y: 0.5});
  assert.ok(near(end.point, {x: -50, y: 100}) && near(end.normal!, {x: 0, y: 1}));
});

test('waypoints: every line kind passes through them in order; the label sits at labelAt of the length', () => {
  const free = (point: Vec) => ({point, normal: null, side: null});
  const waypoints = [{x: 100, y: 0}, {x: 100, y: 100}];
  const straight = routeConnector(free({x: 0, y: 0}), free({x: 200, y: 100}), 'straight', waypoints);
  assert.deepEqual(straight, [{type: 'M', x: 0, y: 0}, {type: 'L', x: 100, y: 0}, {type: 'L', x: 100, y: 100}, {type: 'L', x: 200, y: 100}]);
  for (const line of ['elbow', 'curved'] as const) {
    const points = samplePath(routeConnector(free({x: 0, y: 0}), free({x: 200, y: 100}), line, waypoints), 64);
    for (const w of waypoints) assert.ok(points.some(p => Math.hypot(p.x - w.x, p.y - w.y) < 13), `${line} passes by ${JSON.stringify(w)}`);
  }
  // Without waypoints the route is what it was.
  assert.deepEqual(routeConnector(free({x: 0, y: 0}), free({x: 10, y: 0}), 'straight'), [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 0}]);
  assert.deepEqual(pathPointAt(straight, 0), {x: 0, y: 0});
  assert.deepEqual(pathPointAt(straight, 1), {x: 200, y: 100});
  assert.deepEqual(pathPointAt(straight, 0.5), {x: 100, y: 50});
  assert.deepEqual(pathMidpoint(straight), pathPointAt(straight, 0.5));
});

test('a connector with ends anywhere on its objects, waypoints and a label place runs through normalization', () => {
  let doc = add(createBoardDocument('page'), createShape(ids, {x: 0, y: 0, shape: 'square'}), createShape(ids, {x: 600, y: 0, shape: 'square'}));
  const [a, b] = Object.values(doc.nodes).filter(node => node.board?.kind === 'shape');
  doc = add(doc, createConnector(ids, {start: {node: a.id, magnet: 'auto'}, end: {node: b.id, magnet: 'auto'}, line: 'straight', label: 'yes'}));
  const connector = Object.values(doc.nodes).find(node => node.board?.kind === 'connector')!;
  doc = edit(doc, tx => tx.update(connector.id, {
    board: {...meta(doc, connector.id), start: {node: a.id, at: {x: 1, y: 0.25}}, end: {node: b.id, at: {x: 0, y: 0.75}}, points: [{x: 400, y: 50}, {x: 400, y: 150}], labelAt: 0},
  }));
  valid(doc);
  const points = linePoints(doc, connector.id);
  const [w, h] = [a.width, a.height];
  assert.ok(near(points[0], {x: w, y: h * 0.25}), `starts on A at (1, 0.25): ${JSON.stringify(points[0])}`);
  assert.ok(near(points[points.length - 1], {x: 600, y: h * 0.75}), 'ends on B at (0, 0.75)');
  for (const p of [{x: 400, y: 50}, {x: 400, y: 150}]) assert.ok(points.some(q => near(q, p)), `through ${JSON.stringify(p)}`);
  const label = childPart(get(doc), doc.nodes[connector.id], 'label')!;
  const box = worldBox(doc, label.id);
  assert.ok(near({x: box.x + box.width / 2, y: box.y + box.height / 2}, points[0], 1e-6), 'labelAt 0: the label sits on the start');
  // B moves: the end follows its point of B.
  doc = edit(doc, tx => tx.update(b.id, {y: 100}));
  const after = linePoints(doc, connector.id);
  assert.ok(near(after[after.length - 1], {x: 600, y: 100 + h * 0.75}));
  // Dragged alone: the waypoints go with it.
  const group = doc.nodes[connector.id];
  doc = edit(doc, tx => tx.update(connector.id, {x: group.x + 10, y: group.y + 5}));
  assert.deepEqual(meta(doc, connector.id).points, [{x: 410, y: 55}, {x: 410, y: 155}]);
  valid(doc);
});
