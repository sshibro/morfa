import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from '../shared/design/defaults';
import {createBoardDocument} from '../shared/design/board/document';
import {worldBox} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import {normalizeDocument} from '../shared/design/normalize';
import {validateDocument, validatePatch} from '../shared/design/schema';
import {documentTarget, mergeChange} from '../shared/design/merge';
import type {DesignDocument, NodeId, PathCommand, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {pickAt} from '../src/design/engine/hit-test';
import {
  createBoardText, createConnector, createShape, createStamp, createSticker, createSticky, createStroke, createTable, createWashi, insertPieces, type BoardBuild,
} from '../shared/design/board/create';
import {boardObjectOf, childPart} from '../shared/design/board/model';
import {STICKERS} from '../shared/design/board/art';
import {BOARD_SHAPES} from '../shared/design/board/shapes';
import {connectorsOf} from '../shared/design/board/normalize';
import {installBoardSteps} from '../shared/design/board/install';
import {readFileSync} from 'node:fs';

// "Board" (docs/board.md §Objects): board objects are ordinary layers with a `board` field; normalization fits a sticky's text,
// grows a shape with its text and runs connectors again when their ends move.

test('a design file never carries the board steps: normalize.ts imports none of them (the board editor installs them)', () => {
  const source = readFileSync(new URL('../shared/design/normalize.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '\.\/board\//);
  for (const file of ['../src/design/engine/store.ts', '../src/design/editor/DesignEditor.tsx', '../src/design/engine/hit-test.ts']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /board\/(normalize|install|connectors|create)'/, file);
  }
});

installBoardSteps();

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
let serial = 0;
const ids = () => 'n' + ++serial;

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
const textOf = (doc: DesignDocument, id: NodeId) => childPart(get(doc), doc.nodes[id], 'text')!;
const valid = (doc: DesignDocument) => {
  const result = validateDocument(doc);
  assert.ok(result.ok, result.ok ? '' : `${result.error} at ${result.path}`);
  assert.deepEqual(result.ok && result.value, doc, 'the schema keeps every board field');
};
const endsOf = (doc: DesignDocument, connectorId: NodeId) => {
  const line = childPart(get(doc), doc.nodes[connectorId], 'line')!;
  const commands = line.vectorPaths![0].commands.filter((c): c is Extract<PathCommand, {x: number}> => c.type !== 'Z');
  const box = worldBox(doc, line.id);
  const first = commands[0], last = commands[commands.length - 1];
  return {start: {x: box.x + first.x, y: box.y + first.y}, end: {x: box.x + last.x, y: box.y + last.y}};
};

test('a sticky takes the largest font that fits, shrinks as text grows, then grows itself', () => {
  let doc = add(createBoardDocument('page'), createSticky(ids, {x: 0, y: 0, text: 'Idea'}));
  const sticky = Object.values(doc.nodes).find(node => node.board?.kind === 'sticky')!;
  valid(doc);
  assert.equal(textOf(doc, sticky.id).text!.style.fontSize, 24);
  assert.equal(doc.nodes[sticky.id].height, 240, 'a short note keeps its square');
  const long = 'Words '.repeat(40);
  doc = edit(doc, tx => tx.update(textOf(doc, sticky.id).id, {text: {...textOf(doc, sticky.id).text!, characters: long}}));
  const smaller = textOf(doc, sticky.id).text!.style.fontSize;
  assert.ok(smaller < 24 && smaller >= 10, `smaller: ${smaller}`);
  assert.equal(doc.nodes[sticky.id].height, 240);
  doc = edit(doc, tx => tx.update(textOf(doc, sticky.id).id, {text: {...textOf(doc, sticky.id).text!, characters: long.repeat(6)}}));
  assert.equal(textOf(doc, sticky.id).text!.style.fontSize, 10, 'the smallest size, then');
  assert.ok(doc.nodes[sticky.id].height > 240, 'the note grows when even the smallest size needs room');
  valid(doc);
});

test('a sticky resized by hand keeps that height as its least height; a wide sticky is twice as wide', () => {
  let doc = add(createBoardDocument('page'), createSticky(ids, {x: 0, y: 0, text: 'Yes'}), createSticky(ids, {x: 300, y: 0, wide: true}));
  const [square, wide] = Object.values(doc.nodes).filter(node => node.board?.kind === 'sticky');
  assert.equal(wide.width, 480);
  doc = edit(doc, tx => tx.update(square.id, {height: 360, layoutSizingVertical: 'FIXED'}));
  assert.equal(doc.nodes[square.id].layoutSizingVertical, 'HUG');
  assert.equal(doc.nodes[square.id].minHeight, 360);
  assert.equal(doc.nodes[square.id].height, 360);
});

test('a shape with text grows when its text needs room, its figure follows, every figure validates', () => {
  let doc = createBoardDocument('page');
  doc = add(doc, ...BOARD_SHAPES.map((shape, i) => createShape(ids, {x: i * 240, y: 0, shape: shape.id, text: shape.label})));
  valid(doc);
  const square = Object.values(doc.nodes).find(node => node.board?.kind === 'shape' && node.board.shape === 'square')!;
  assert.equal(square.height, 200);
  doc = edit(doc, tx => tx.update(textOf(doc, square.id).id, {text: {...textOf(doc, square.id).text!, characters: 'A very long piece of text '.repeat(10)}}));
  const grown = doc.nodes[square.id];
  assert.ok(grown.height > 200, `grown: ${grown.height}`);
  assert.equal(childPart(get(doc), grown, 'shape')!.height, grown.height, 'the figure stretches with the frame');
});

test('a connector runs between the facing sides of two objects and follows them; an end left without its object stays put', () => {
  let doc = add(createBoardDocument('page'), createShape(ids, {x: 0, y: 0, shape: 'square'}), createShape(ids, {x: 400, y: 0, shape: 'ellipse'}));
  const [a, b] = Object.values(doc.nodes).filter(node => node.board?.kind === 'shape');
  doc = add(doc, createConnector(ids, {start: {node: a.id, magnet: 'auto'}, end: {node: b.id, magnet: 'auto'}, line: 'elbow'}));
  const connector = Object.values(doc.nodes).find(node => node.board?.kind === 'connector')!;
  valid(doc);
  assert.deepEqual(endsOf(doc, connector.id), {start: {x: 200, y: 100}, end: {x: 400, y: 100}}, 'right side of A to left side of B');
  // B moves below A: the line now leaves A's bottom and enters B's top.
  doc = edit(doc, tx => tx.update(b.id, {x: 0, y: 500}));
  assert.deepEqual(endsOf(doc, connector.id), {start: {x: 100, y: 200}, end: {x: 100, y: 500}});
  // Moving the parent of an end's object (here: putting A in a moved section is the same as moving A) follows too.
  doc = edit(doc, tx => tx.update(a.id, {x: -300}));
  assert.deepEqual(endsOf(doc, connector.id).start, {x: -200, y: 200});
  // B is deleted: its end stays where it was, free.
  doc = edit(doc, tx => tx.remove(b.id));
  const meta = doc.nodes[connector.id].board;
  assert.ok(meta?.kind === 'connector' && !('node' in meta.end), 'the end came off');
  assert.deepEqual(endsOf(doc, connector.id).end, {x: 100, y: 500});
  valid(doc);
});

test('straight and curved connectors, a label in the middle, and a connector dragged alone comes off its objects', () => {
  let doc = add(createBoardDocument('page'), createShape(ids, {x: 0, y: 0, shape: 'square'}), createShape(ids, {x: 600, y: 300, shape: 'square'}));
  const [a, b] = Object.values(doc.nodes).filter(node => node.board?.kind === 'shape');
  doc = add(doc, createConnector(ids, {start: {node: a.id, magnet: 'right'}, end: {node: b.id, magnet: 'left'}, line: 'straight', label: 'yes'}));
  const connector = Object.values(doc.nodes).find(node => node.board?.kind === 'connector')!;
  assert.deepEqual(endsOf(doc, connector.id), {start: {x: 200, y: 100}, end: {x: 600, y: 400}});
  const label = childPart(get(doc), doc.nodes[connector.id], 'label')!;
  const labelBox = worldBox(doc, label.id);
  assert.ok(Math.abs(labelBox.x + labelBox.width / 2 - 400) < 1 && Math.abs(labelBox.y + labelBox.height / 2 - 250) < 1, 'the label sits on the middle');
  doc = edit(doc, tx => tx.update(connector.id, {board: {...(doc.nodes[connector.id].board as Extract<SceneNode['board'], {kind: 'connector'}>), line: 'curved'}}));
  const line = childPart(get(doc), doc.nodes[connector.id], 'line')!;
  assert.equal(line.vectorPaths![0].commands[1].type, 'C');
  // Dragged by itself (its objects stay): both ends come off and move with it.
  const group = doc.nodes[connector.id];
  doc = edit(doc, tx => tx.update(connector.id, {x: group.x + 50, y: group.y + 20}));
  const moved = doc.nodes[connector.id].board!;
  assert.ok(moved.kind === 'connector' && !('node' in moved.start) && !('node' in moved.end));
  assert.deepEqual(endsOf(doc, connector.id), {start: {x: 250, y: 120}, end: {x: 650, y: 420}});
  // Dragged together with both its objects: it stays on them.
  let together = add(createBoardDocument('page'), createShape(ids, {x: 0, y: 0, shape: 'square'}), createShape(ids, {x: 400, y: 0, shape: 'square'}));
  const [c, d] = Object.values(together.nodes).filter(node => node.board?.kind === 'shape');
  together = add(together, createConnector(ids, {start: {node: c.id, magnet: 'auto'}, end: {node: d.id, magnet: 'auto'}}));
  const joined = Object.values(together.nodes).find(node => node.board?.kind === 'connector')!;
  together = edit(together, tx => {
    for (const id of [c.id, d.id, joined.id]) tx.update(id, {x: together.nodes[id].x + 30, y: together.nodes[id].y + 30});
  });
  const still = together.nodes[joined.id].board!;
  assert.ok(still.kind === 'connector' && 'node' in still.start && 'node' in still.end);
  assert.deepEqual(endsOf(together, joined.id), {start: {x: 230, y: 130}, end: {x: 430, y: 130}});
});

test('tables, stamps, stickers, strokes, washi tape and text are valid documents; a table row keeps its cells one height', () => {
  let doc = add(
    createBoardDocument('page'),
    createTable(ids, {x: 0, y: 0, cells: [['What', 'Who', 'When'], ['Research into users and their habits over the course of a week', 'Anna', 'Mon']], header: true}),
    createStamp(ids, {x: 0, y: 400, stamp: 'heart'}),
    createStamp(ids, {x: 60, y: 400, stamp: 'plus-one'}),
    createStamp(ids, {x: 120, y: 400, stamp: 'avatar', by: 'Kyle Ivanov'}),
    ...STICKERS.map((sticker, i) => createSticker(ids, {x: i * 130, y: 600, sticker: sticker.id})!),
    createStroke(ids, {tool: 'marker', color: '#1E1E1E', weight: 4, commands: [{type: 'M', x: 10, y: 10}, {type: 'Q', x1: 40, y1: 0, x: 80, y: 30}]}),
    createStroke(ids, {tool: 'highlighter', color: '#FFE14D', weight: 20, commands: [{type: 'M', x: 10, y: 50}, {type: 'L', x: 200, y: 50}]}),
    createWashi(ids, {from: {x: 0, y: 900}, to: {x: 200, y: 950}, color: '#B48CFF', width: 28}),
    createBoardText(ids, {x: 0, y: 1000, text: 'Brainstorm', handwriting: true, size: 64}),
  );
  valid(doc);
  const table = Object.values(doc.nodes).find(node => node.board?.kind === 'table')!;
  const second = doc.nodes[doc.nodes[table.id].children![1]];
  const heights = second.children!.map(id => doc.nodes[id].height);
  assert.ok(heights[0] > 48, 'the long cell grew');
  assert.deepEqual(new Set(heights).size, 1, `one height across the row: ${heights}`);
  const avatar = Object.values(doc.nodes).find(node => node.board?.kind === 'stamp' && node.board.stamp === 'avatar')!;
  assert.equal(doc.nodes[avatar.children![0]].text!.characters, 'KI');
});

test('a click on a layer inside a board object selects the object; the object of a layer is found from any part', () => {
  const doc = add(createBoardDocument('page'), createSticky(ids, {x: 0, y: 0, text: 'Hello'}), createTable(ids, {x: 400, y: 0}));
  const sticky = Object.values(doc.nodes).find(node => node.board?.kind === 'sticky')!;
  const table = Object.values(doc.nodes).find(node => node.board?.kind === 'table')!;
  assert.equal(pickAt(doc, 'page', {x: 40, y: 40}), sticky.id, 'not the text inside it, as a frame on the canvas would give');
  assert.equal(pickAt(doc, 'page', {x: 420, y: 20}), table.id);
  const text = textOf(doc, sticky.id);
  assert.equal(boardObjectOf(get(doc), text.id)?.id, sticky.id);
  assert.equal(pickAt(doc, 'page', {x: 40, y: 40}, {deep: true}), text.id, '⌘-click still reaches the layer');
});

test('connectors are indexed per node table; a design file never runs the board steps', () => {
  const plain = createBoardDocument('page');
  assert.equal(connectorsOf(plain.nodes).size, 0);
  // The same objects in a design file stay as they are made: no font fit, no routing (their layers draw the same).
  const design = add(createDocument('page'), createSticky(ids, {x: 0, y: 0, text: 'Words '.repeat(60)}));
  const sticky = Object.values(design.nodes).find(node => node.board?.kind === 'sticky')!;
  assert.equal(textOf(design, sticky.id).text!.style.fontSize, 24, 'a design file does not fit sticky text');
  let doc = add(createBoardDocument('page'), createShape(ids, {x: 0, y: 0, shape: 'square'}));
  const shape = Object.values(doc.nodes).find(node => node.board?.kind === 'shape')!;
  doc = add(doc, createConnector(ids, {start: {node: shape.id, magnet: 'auto'}, end: {x: 500, y: 500}}));
  assert.equal(connectorsOf(doc.nodes).size, 1);
  // Normalizing the whole file again is a no-op: every board step is idempotent.
  assert.equal(normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer}), doc);
});

test('co-editing: two people moving a connector\'s two ends both land', () => {
  let doc = add(createBoardDocument('page'), createShape(ids, {x: 0, y: 0, shape: 'square'}), createShape(ids, {x: 400, y: 0, shape: 'square'}), createShape(ids, {x: 0, y: 400, shape: 'square'}));
  const [a, b, c] = Object.values(doc.nodes).filter(node => node.board?.kind === 'shape');
  doc = add(doc, createConnector(ids, {start: {node: a.id, magnet: 'auto'}, end: {node: b.id, magnet: 'auto'}}));
  const connector = Object.values(doc.nodes).find(node => node.board?.kind === 'connector')!;
  const meta = doc.nodes[connector.id].board as Extract<SceneNode['board'], {kind: 'connector'}>;
  const theirs = edit(doc, tx => tx.update(connector.id, {board: {...meta, start: {node: c.id, magnet: 'top'}}}));
  const mine = {...doc.nodes[connector.id], board: {...meta, end: {x: 900, y: 0}}};
  assert.ok(validatePatch({nodes: {[connector.id]: mine}}).ok);
  const merged = mergeChange(documentTarget(theirs), {nodes: {[connector.id]: mine}}, {nodes: {[connector.id]: doc.nodes[connector.id]}});
  const result = merged.patch.nodes![connector.id]!.board as Extract<SceneNode['board'], {kind: 'connector'}>;
  assert.deepEqual(result.start, {node: c.id, magnet: 'top'});
  assert.deepEqual(result.end, {x: 900, y: 0});
});
