import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoardDocument} from '../shared/design/board/document';
import {installBoardSteps} from '../shared/design/board/install';
import {createShape, createStamp, createSticky, createTable, insertPieces, type BoardBuild} from '../shared/design/board/create';
import {childPart} from '../shared/design/board/model';
import {neighbourCellText} from '../src/design/board/table-commands';
import {installBoardCommands} from '../src/design/board/commands';
import {runCommand} from '../src/design/engine/commands';
import {stampHolderAt} from '../src/design/board/tools/place';
import {offBoard} from '../src/design/board/chrome/Recenter';
import {pickAt} from '../src/design/engine/hit-test';
import {worldBox, type Rect} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument} from '../shared/design/types';
import type {SpatialIndex} from '../shared/design/tree';
import {hintCovered} from '../src/design/board/tools/decor';
import {fixtureMeasurer} from './helpers/board-fixture';
import {STAMPS} from '../shared/design/board/art';
import {isBoardAction} from '../src/design/board/commands';
import {boardKeyAction} from '../src/design/board/keys';
import {BOARD_TOOL_COMMANDS} from '../src/design/board/actions';
import {PASTE_MAX_STICKIES, pasteOnBoard, pastePlan, stickyGrid} from '../src/design/board/paste';
import {createDesignStore} from '../src/design/engine/store';
import type {CommandContext} from '../src/design/engine/commands';
import {sliceAt, slicePath, WHEEL_INNER, WHEEL_OUTER, WHEEL_RADIUS, WHEEL_REACH, wheelCentre, wheelSlots} from '../src/design/board/chrome/wheel';

// Lane FJ (docs/figjam-parity.md): the rows that were wrong, each pinned by a test that failed before its fix.

installBoardSteps();
installBoardCommands();
let serial = 0;
const ids = () => 'p' + ++serial;

function boardOf(...builds: BoardBuild[]): DesignDocument {
  const tx = beginTransaction(createBoardDocument('page'));
  for (const build of builds) insertPieces(tx, build, 'page');
  return tx.commit({measurer: fixtureMeasurer}).doc;
}
const meets = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const indexOf = (doc: DesignDocument): SpatialIndex => ({
  query: rect => Object.keys(doc.nodes).filter(id => id !== 'page' && meets(worldBox(doc, id), rect)),
});
const hintLine = {x: 16, y: 16, width: 200, height: 29};

test('should hide an empty sticky\'s hint when a shape is placed over it', () => {
  const sticky = createSticky(ids, {x: 0, y: 0});
  const doc = boardOf(sticky, createShape(ids, {x: 40, y: 0, shape: 'square'}));
  assert.equal(hintCovered(doc, indexOf(doc), sticky.id, hintLine), true);
});

test('should keep the hint when the overlapping object lies under the sticky', () => {
  const below = createShape(ids, {x: 40, y: 0, shape: 'square'});
  const sticky = createSticky(ids, {x: 0, y: 0});
  const doc = boardOf(below, sticky);
  assert.equal(hintCovered(doc, indexOf(doc), sticky.id, hintLine), false);
});

test('should keep the whole stamp wheel inside the canvas when E is pressed near an edge', () => {
  const area = {width: 1000, height: 700};
  assert.deepEqual(wheelCentre({x: 500, y: 300}, area), {x: 500, y: 300});
  assert.deepEqual(wheelCentre({x: 10, y: 690}, area), {x: WHEEL_REACH, y: 700 - WHEEL_REACH});
  assert.deepEqual(wheelCentre({x: 10, y: 10}, {width: 150, height: 150}), {x: 75, y: 75});
});

test('should pick the slice under the pointer, and none in the middle or outside the disc', () => {
  const count = STAMPS.length;
  assert.equal(sliceAt({x: 0, y: -WHEEL_RADIUS}, count), 0);
  for (const [k, slot] of wheelSlots(count).entries()) assert.equal(sliceAt(slot, count), k, `slot ${k}`);
  assert.equal(sliceAt({x: 0, y: 0}, count), null);
  assert.equal(sliceAt({x: 0, y: -(WHEEL_INNER - 1)}, count), null);
  assert.equal(sliceAt({x: WHEEL_OUTER + 1, y: 0}, count), null);
  assert.match(slicePath(0, count), /^M .+ Z$/);
});

test('should set the nine stamps on a ring clockwise from the top', () => {
  const slots = wheelSlots(STAMPS.length);
  assert.equal(slots.length, STAMPS.length);
  assert.deepEqual(slots[0], {x: 0, y: -WHEEL_RADIUS});
  assert.ok(slots[1].x > 0, 'the second stamp is to the right');
  for (const slot of slots) assert.ok(Math.abs(Math.hypot(slot.x, slot.y) - WHEEL_RADIUS) <= 1);
});

test('should offer a board\'s own commands and tools in "Quick actions", never the design editor\'s', () => {
  assert.equal(isBoardAction('board.tool-sticky'), true);
  assert.equal(isBoardAction('board.sort-color'), true);
  assert.equal(isBoardAction('edit.undo'), true, 'in the board\'s main menu');
  assert.equal(isBoardAction('arrange.align-left'), true);
  for (const id of ['view.annotations', 'text.uppercase', 'component.create', 'tool.frame']) assert.equal(isBoardAction(id), false, id);
});

test('should show each board tool\'s FigJam key beside it', () => {
  const key = (id: string) => BOARD_TOOL_COMMANDS.find(command => command.id === id)?.shortcut;
  assert.deepEqual(key('board.tool-sticky'), {code: 'KeyS'});
  assert.deepEqual(key('board.tool-section'), {code: 'KeyS', shift: true});
  assert.deepEqual(key('board.tool-washi'), {code: 'KeyW'});
  assert.deepEqual(key('board.tool-ellipse'), {code: 'KeyO'});
  assert.deepEqual(key('board.tool-straight'), {code: 'KeyL'});
  assert.deepEqual(key('board.tool-connector'), {code: 'KeyX'});
  assert.deepEqual(key('board.tool-table'), {code: 'KeyT', shift: true});
});

test('should make a sticky per pasted line, without the list\'s bullets', () => {
  assert.deepEqual(pastePlan('Idea one\n- Idea two\n\n2. Idea three\n'), {kind: 'stickies', lines: ['Idea one', 'Idea two', 'Idea three']});
  assert.deepEqual(pastePlan('   \n\n'), null);
  assert.equal((pastePlan(Array.from({length: 500}, (_, k) => `line ${k}`).join('\n')) as {lines: string[]}).lines.length, PASTE_MAX_STICKIES);
});

test('should make a table when cells copied from a spreadsheet are pasted', () => {
  assert.deepEqual(pastePlan('Name\tRole\r\nAnna\tDesign\r\nBob\n'), {kind: 'table', cells: [['Name', 'Role'], ['Anna', 'Design'], ['Bob', '']]});
});

test('should lay pasted notes out in a near-square grid around the view\'s centre', () => {
  const grid = stickyGrid(5, {x: 0, y: 0});
  assert.equal(grid.length, 5);
  assert.deepEqual(grid[0], {x: -384, y: -252});
  assert.deepEqual(grid[3], {x: -384, y: 12});
});

test('should paste lines as stickies on a board as one undo step, selected', () => {
  const store = createDesignStore({doc: boardOf(), measurer: fixtureMeasurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1200, height: 800}), enterEdit: () => {}, index: () => null};
  assert.equal(pasteOnBoard({text: 'One\nTwo', html: null, files: []}, ctx), true);
  const {doc, selection} = store.getState();
  const stickies = Object.values(doc.nodes).filter(node => node.board?.kind === 'sticky');
  assert.equal(stickies.length, 2);
  assert.deepEqual([...selection].sort(), stickies.map(node => node.id).sort());
  store.undo();
  assert.equal(Object.values(store.getState().doc.nodes).filter(node => node.board?.kind === 'sticky').length, 0);
});

test('should take a bent connector on X or ⇧L and a straight one on L, as FigJam\'s help says', () => {
  const press = (code: string, shiftKey = false) => boardKeyAction({code, shiftKey, altKey: false, metaKey: false, ctrlKey: false}, true);
  assert.deepEqual(press('KeyX'), {kind: 'tool', tool: 'board-connector', choices: {line: 'elbow'}});
  assert.deepEqual(press('KeyL', true), {kind: 'tool', tool: 'board-connector', choices: {line: 'elbow'}});
  assert.deepEqual(press('KeyL'), {kind: 'tool', tool: 'board-connector', choices: {line: 'straight'}});
});

test('should attach a stamp placed on a sticky, keep it where it was put, and pick it by itself', () => {
  const sticky = createSticky(ids, {x: 100, y: 100, text: 'Idea'});
  const doc = boardOf(sticky);
  const store = createDesignStore({doc, measurer: fixtureMeasurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const view = {pixel: () => 1} as unknown as Parameters<typeof stampHolderAt>[2]['view'];
  const holder = stampHolderAt(store.getState(), {x: 300, y: 120}, {view, index: () => null});
  assert.equal(holder?.id, sticky.id);
  const stamp = createStamp(ids, {x: 176, y: -4, stamp: 'heart'});
  store.transact('Stamp', tx => insertPieces(tx, {...stamp, pieces: stamp.pieces.map((piece, k) => (k ? piece : {...piece, node: {...piece.node, layoutPositioning: 'ABSOLUTE' as const}}))}, sticky.id));
  const placed = store.getState().doc.nodes[stamp.id];
  assert.deepEqual({x: placed.x, y: placed.y, parent: placed.parentId}, {x: 176, y: -4, parent: sticky.id}, "the note's layout leaves it where it was put");
  assert.equal(pickAt(store.getState().doc, 'page', {x: 300, y: 120}), stamp.id);
  assert.equal(pickAt(store.getState().doc, 'page', {x: 150, y: 250}), sticky.id, 'the note itself, elsewhere');
  store.transact('Shift', tx => tx.update(sticky.id, {x: 500}));
  assert.deepEqual(worldBox(store.getState().doc, stamp.id).x, 500 + 176, 'it moves with the note');
});

test('should offer to go back only when the page holds something and none of it is in view', () => {
  const doc = boardOf(createSticky(ids, {x: 0, y: 0}));
  const empty = boardOf();
  assert.equal(offBoard(doc, 'page', {x: 5000, y: 5000, width: 1000, height: 800}, indexOf(doc)), true);
  assert.equal(offBoard(doc, 'page', {x: -500, y: -500, width: 1000, height: 800}, indexOf(doc)), false);
  assert.equal(offBoard(empty, 'page', {x: 5000, y: 5000, width: 1000, height: 800}, indexOf(empty)), false, 'an empty board has nowhere to go back to');
});

test('should take washi tape on W and a table on ⇧T, as FigJam\'s help says', () => {
  const press = (code: string, shiftKey = false) => boardKeyAction({code, shiftKey, altKey: false, metaKey: false, ctrlKey: false}, true);
  assert.deepEqual(press('KeyW'), {kind: 'tool', tool: 'board-marker', choices: {marker: 'washi'}});
  assert.deepEqual(press('KeyT', true), {kind: 'tool', tool: 'board-table'});
  assert.deepEqual(press('KeyT'), {kind: 'tool', tool: 'text'});
});

test('should step to the next and the previous cell row by row, and nowhere past either end', () => {
  const table = createTable(ids, {x: 0, y: 0, rows: 2, columns: 2, cells: [['A', 'B'], ['C', 'D']]});
  const doc = boardOf(table);
  const get = (id: string | null | undefined) => (id ? doc.nodes[id] : undefined);
  const textOfCell = (r: number, c: number) => childPart(get, get(get(doc.nodes[table.id].children![r])!.children![c]), 'text')!.id;
  assert.equal(neighbourCellText(get, textOfCell(0, 0), 1), textOfCell(0, 1));
  assert.equal(neighbourCellText(get, textOfCell(0, 1), 1), textOfCell(1, 0), "Tab at a row's end goes to the next row");
  assert.equal(neighbourCellText(get, textOfCell(1, 0), -1), textOfCell(0, 1));
  assert.equal(neighbourCellText(get, textOfCell(1, 1), 1), null);
  assert.equal(neighbourCellText(get, textOfCell(0, 0), -1), null);
});

test('should turn a selected table into a sticky per filled cell as one undo step', () => {
  const table = createTable(ids, {x: 40, y: 60, rows: 2, columns: 2, cells: [['A', ''], ['C', 'D']]});
  const store = createDesignStore({doc: boardOf(table), measurer: fixtureMeasurer});
  store.setSelection([table.id]);
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1200, height: 800}), enterEdit: () => {}, index: () => null};
  runCommand('board.table-to-stickies', ctx);
  const {doc, selection} = store.getState();
  const stickies = Object.values(doc.nodes).filter(node => node.board?.kind === 'sticky');
  assert.equal(stickies.length, 3);
  assert.equal(doc.nodes[table.id], undefined);
  assert.equal(selection.length, 3);
  assert.deepEqual(stickies.map(node => [node.x, node.y]).sort((a, b) => a[1] - b[1] || a[0] - b[0]), [[40, 60], [40, 324], [304, 324]]);
  store.undo();
  assert.ok(store.getState().doc.nodes[table.id]);
});
