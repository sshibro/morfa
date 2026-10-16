import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoardDocument} from '../shared/design/board/document';
import {installBoardSteps} from '../shared/design/board/install';
import {createConnector, createShape, createSticky, createTable, insertPieces, type BoardBuild} from '../shared/design/board/create';
import {childPart} from '../shared/design/board/model';
import {tableShape} from '../shared/design/board/table';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {findByShortcut, getCommand, listCommands, runCommand, type CommandContext} from '../src/design/engine/commands';
import {createDesignStore} from '../src/design/engine/store';
import {installEditorCommands, menuCoverage} from '../src/design/editor/command-bridge';
import {registerFileCommands} from '../src/design/engine/commands/file';
import {registerExportCommands} from '../src/design/engine/commands/export';
import {registerCodeCommands} from '../src/design/engine/commands/code';
import {registerLinkCommands} from '../src/design/engine/commands/link';
import type {FontRegistry, ImageCache} from '../src/design/engine/contracts';
import {boardKeyAction} from '../src/design/board/keys';
import {BOARD_MENU, installBoardCommands} from '../src/design/board/commands';
import {createBoardObjects} from '../src/design/board/objects';
import {boardExportIds, fittingScale} from '../src/design/board/export';
import {cloneSubtrees} from '../src/design/engine/clipboard';
import {setStickyWide, setConnectorLine, setEndStyle, endStyleOf, setShapeKind, setHandwriting, isHandwriting} from '../src/design/board/edits';

// "Board" in the editor (docs/board.md §Keys, §Commands, §Meeting slot, §Context toolbar): FigJam's single keys by physical key, the
// board's menu wired to registered commands, the board-objects API the meeting module builds on, and the context toolbar's edits.

installBoardSteps();
installEditorCommands();
registerFileCommands();
registerExportCommands(() => {});
registerCodeCommands({fonts: {} as FontRegistry, images: {} as ImageCache, toast: () => {}, openDialog: () => {}});
registerLinkCommands();
const uninstall = installBoardCommands();
const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
let serial = 0;
const ids = () => 'e' + ++serial;

function board(...builds: BoardBuild[]) {
  const doc = createBoardDocument('page');
  const tx = beginTransaction(doc);
  for (const build of builds) insertPieces(tx, build, 'page');
  const store = createDesignStore({doc: tx.commit({measurer}).doc, measurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1200, height: 800}), enterEdit: () => {}, index: () => null};
  return {store, ctx, get: (doc: DesignDocument) => (id: NodeId | null | undefined) => (id ? doc.nodes[id] : undefined)};
}
const press = (code: string, extra: Partial<Record<'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey', boolean>> = {}) => ({code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...extra});

test('FigJam\'s single keys by physical key (the Russian layout types the same codes)', () => {
  const tool = (code: string, extra = {}) => {
    const action = boardKeyAction(press(code, extra), true);
    return action?.kind === 'tool' ? action.tool : action?.kind ?? null;
  };
  assert.equal(tool('KeyV'), 'move');
  assert.equal(tool('KeyH'), 'hand');
  assert.equal(tool('KeyS'), 'board-sticky');
  assert.equal(tool('KeyS', {shiftKey: true}), 'section');
  assert.equal(tool('KeyM'), 'board-marker');
  assert.deepEqual(boardKeyAction(press('KeyM', {shiftKey: true}), true), {kind: 'tool', tool: 'board-marker', choices: {marker: 'highlighter'}});
  assert.deepEqual(boardKeyAction(press('Backspace', {shiftKey: true}), true), {kind: 'tool', tool: 'board-marker', choices: {marker: 'eraser'}});
  assert.equal(tool('KeyX'), 'board-connector');
  assert.equal(tool('KeyT'), 'text');
  assert.equal(tool('KeyC'), 'comment');
  assert.equal(tool('KeyE'), 'stamp-wheel');
  assert.equal(tool('KeyK', {metaKey: true}), 'actions');
  assert.equal(tool('KeyK', {ctrlKey: true}), null, 'Ctrl on a Mac is not ⌘');
  assert.equal(boardKeyAction(press('KeyK', {ctrlKey: true}), false)?.kind, 'actions', 'Ctrl elsewhere');
  for (const code of ['KeyF', 'KeyA', 'KeyP']) assert.equal(tool(code), 'swallow', code);
  // ⌘C, ⌘Z and ⌥-chords stay the design editor's.
  assert.equal(boardKeyAction(press('KeyC', {metaKey: true}), true), null);
  assert.equal(boardKeyAction(press('KeyS', {altKey: true}), true), null);
});

test('the board\'s menu lists only registered commands, and its own keys meet no design command\'s', () => {
  const {waiting} = menuCoverage(BOARD_MENU);
  assert.deepEqual(waiting.filter(id => !['edit.find', 'help.guide', 'help.support'].includes(id)), [], 'every other entry is wired');
  for (const id of ['board.new', 'board.sort-color', 'board.section-fit', 'board.table-row-add', 'board.sticky-next']) assert.ok(getCommand(id), id);
  const next = getCommand('board.sticky-next')!.shortcut!;
  const holders = listCommands().filter(command => command.shortcut && command.shortcut.code === next.code && !!command.shortcut.mod === !!next.mod && !!command.shortcut.shift === !!next.shift && !command.shortcut.alt);
  assert.deepEqual(holders.map(command => command.id), ['board.sticky-next']);
  assert.equal(findByShortcut(press('Enter', {metaKey: true}), true, () => true)?.id, 'board.sticky-next');
});

test('⌘↵ makes the next sticky beside the selected one, of its colour; sorting by colour groups the notes', () => {
  const a = createSticky(ids, {x: 0, y: 0, color: 'blue', text: 'A'}), b = createSticky(ids, {x: 600, y: 0, color: 'yellow', text: 'B'}), c = createSticky(ids, {x: 1200, y: 0, color: 'blue', text: 'C'});
  const {store, ctx} = board(a, b, c);
  store.setSelection([a.id]);
  assert.ok(runCommand('board.sticky-next', ctx));
  let {doc} = store.getState();
  const next = store.getState().selection[0];
  assert.notEqual(next, a.id);
  assert.equal(doc.nodes[next].x, 264, 'beside it, a gap of 24');
  assert.deepEqual(doc.nodes[next].fills, doc.nodes[a.id].fills);
  store.setSelection([a.id, b.id, c.id]);
  assert.ok(runCommand('board.sort-color', ctx));
  doc = store.getState().doc;
  assert.deepEqual([a.id, b.id, c.id].map(id => [doc.nodes[id].x, doc.nodes[id].y]), [[336, 0], [0, 0], [600, 0]], 'yellow first, then the blue pair in a row');
  store.undo();
  assert.equal(store.getState().doc.nodes[c.id].x, 1200, 'one undo step');
});

test('a table grows and shrinks by rows and columns from the selected table', () => {
  const table = createTable(ids, {x: 0, y: 0, rows: 2, columns: 2, header: true});
  const {store, ctx, get} = board(table);
  store.setSelection([table.id]);
  assert.ok(runCommand('board.table-row-add', ctx));
  assert.ok(runCommand('board.table-column-add', ctx));
  assert.deepEqual(((shape) => [shape!.rows.length, shape!.columns])(tableShape(get(store.getState().doc), table.id)), [3, 3]);
  assert.ok(runCommand('board.table-row-remove', ctx));
  assert.ok(runCommand('board.table-column-remove', ctx));
  assert.deepEqual(((shape) => [shape!.rows.length, shape!.columns])(tableShape(get(store.getState().doc), table.id)), [2, 2]);
});

test('the context toolbar\'s edits: a wide sticky, a connector\'s line and arrowheads, another figure, the handwriting face', () => {
  const sticky = createSticky(ids, {x: 0, y: 0, text: 'Idea'});
  const square = createShape(ids, {x: 400, y: 0, shape: 'square', text: 'Step'});
  const ellipse = createShape(ids, {x: 900, y: 0, shape: 'ellipse'});
  const link = createConnector(ids, {start: {node: square.id, magnet: 'auto'}, end: {node: ellipse.id, magnet: 'auto'}});
  const {store, get} = board(sticky, square, ellipse, link);
  const node = (id: NodeId) => store.getState().doc.nodes[id];
  setStickyWide(store, [node(sticky.id)], true);
  assert.equal(node(sticky.id).width, 480);
  assert.deepEqual(node(sticky.id).board, {kind: 'sticky', wide: true});
  setStickyWide(store, [node(sticky.id)], false);
  assert.equal(node(sticky.id).width, 240);
  setConnectorLine(store, [node(link.id)], 'curved');
  assert.equal((node(link.id).board as {line?: string}).line, 'curved');
  const line = () => childPart(get(store.getState().doc), node(link.id), 'line')!;
  assert.ok(line().vectorPaths![0].commands.some(command => command.type === 'C'), 'a curved connector runs as a curve');
  setEndStyle(store, [node(link.id)], 'start', 'DIAMOND');
  assert.equal(endStyleOf(get(store.getState().doc), node(link.id), 'start'), 'DIAMOND');
  assert.equal(endStyleOf(get(store.getState().doc), node(link.id), 'end'), 'LINE_ARROW');
  setShapeKind(store, [node(square.id)], 'diamond');
  assert.deepEqual(node(square.id).board, {kind: 'shape', shape: 'diamond'});
  assert.equal(childPart(get(store.getState().doc), node(square.id), 'shape')!.type, 'VECTOR');
  assert.equal(node(square.id).name, 'Diamond');
  setHandwriting(store, [node(square.id)], true);
  assert.equal(isHandwriting(get(store.getState().doc), node(square.id)), true);
});

test('the meeting slot\'s board objects: what is under a point, what can be voted on, badges and click interceptors', () => {
  const sticky = createSticky(ids, {x: 0, y: 0, text: 'Vote on this'});
  const shape = createShape(ids, {x: 400, y: 0, shape: 'square'});
  const link = createConnector(ids, {start: {node: sticky.id, magnet: 'auto'}, end: {node: shape.id, magnet: 'auto'}});
  const {store} = board(sticky, shape, link);
  const objects = createBoardObjects({store, host: () => null, index: () => null});
  assert.equal(objects.objectAtPage({x: 40, y: 40}), sticky.id, 'the sticky\'s text answers the sticky');
  assert.equal(objects.objectAtPage({x: 500, y: 100}), shape.id);
  assert.equal(objects.objectAtPage({x: 5000, y: 5000}), null);
  assert.deepEqual(objects.votableObjects(), [sticky.id, shape.id], 'connectors are not voted on');
  assert.deepEqual(objects.objectBounds(sticky.id, 'page'), {x: 0, y: 0, width: 240, height: 240});
  assert.equal(objects.objectBounds(sticky.id, 'client'), null, 'no canvas, no client box');
  let heard = 0;
  const off = objects.subscribeBadges(() => heard++);
  objects.setBadges('voting', [{id: sticky.id, count: 3, tone: 'mine'}]);
  assert.deepEqual([...objects.badges().keys()], ['voting']);
  objects.setBadges('voting', []);
  assert.equal(objects.badges().size, 0);
  assert.equal(heard, 2);
  off();
  assert.equal(objects.pageId(), 'page');
  uninstallLater();
});

test('"Export board": the page\'s visible top-level objects or the selection, scaled down to what a browser encodes', () => {
  const a = createSticky(ids, {x: 0, y: 0}), b = createSticky(ids, {x: 300, y: 0});
  const {store} = board(a, b);
  store.transact('Hide', tx => tx.update(b.id, {visible: false}));
  const {doc} = store.getState();
  assert.deepEqual(boardExportIds(doc, 'page', 'page', []), [a.id]);
  assert.deepEqual(boardExportIds(doc, 'page', 'selection', [b.id, 'gone']), [b.id]);
  assert.equal(fittingScale({width: 1000, height: 500}, 2), 2);
  const huge = fittingScale({width: 20_000, height: 4_000}, 2);
  assert.ok(huge * 20_000 <= 16_384 && huge < 1);
  const square = fittingScale({width: 15_000, height: 15_000}, 2);
  assert.ok(15_000 * square * 15_000 * square <= 256_000_000);
});

test('a copied connector follows its copied objects; copied alone it stays on its objects', () => {
  const a = createSticky(ids, {x: 0, y: 0}), b = createShape(ids, {x: 500, y: 0, shape: 'square'});
  const link = createConnector(ids, {start: {node: a.id, magnet: 'auto'}, end: {node: b.id, magnet: 'right'}});
  const {store} = board(a, b, link);
  const {doc} = store.getState();
  const all = cloneSubtrees(doc.nodes, [a.id, b.id, link.id]);
  const copy = all.nodes.find(node => node.board?.kind === 'connector')!;
  assert.deepEqual(copy.board, {kind: 'connector', start: {node: all.ids.get(a.id), magnet: 'auto'}, end: {node: all.ids.get(b.id), magnet: 'right'}, line: 'elbow'});
  const half = cloneSubtrees(doc.nodes, [a.id, link.id]);
  const lone = half.nodes.find(node => node.board?.kind === 'connector')!;
  assert.deepEqual(lone.board, {kind: 'connector', start: {node: half.ids.get(a.id), magnet: 'auto'}, end: {node: b.id, magnet: 'right'}, line: 'elbow'});
  assert.deepEqual(cloneSubtrees(doc.nodes, [link.id]).nodes[0].board, doc.nodes[link.id].board);
});

function uninstallLater() {
  // The board's commands leave the registry when the board closes.
  uninstall();
  assert.equal(getCommand('board.sort-color'), undefined);
}
