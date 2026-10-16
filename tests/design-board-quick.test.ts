import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoardDocument} from '../shared/design/board/document';
import {installBoardSteps} from '../shared/design/board/install';
import {createBoardSection, createShape, createStamp, createStroke, createWashi, insertPieces} from '../shared/design/board/create';
import {hoveredStampAuthor} from '../src/design/board/tools/stamp-label';
import {boardEmote, registerBoardEmote} from '../src/design/board/meeting';
import {MARKER_COLORS, SECTION_BORDER_OPACITY, SECTION_COLORS, rgbToHex} from '../shared/design/board/palette';
import {setColor} from '../src/design/board/edits';
import {boardColors} from '../src/design/board/colors';
import {childPart} from '../shared/design/board/model';
import {beginTransaction} from '../shared/design/transaction';
import {installBoardCommands} from '../src/design/board/commands';
import {runCommand, type CommandContext} from '../src/design/engine/commands';
import {createDesignStore} from '../src/design/engine/store';
import {fixtureMeasurer} from './helpers/board-fixture';

// FigJam's quick create (help.figma.com "Visualize information using shapes with text"): ⌘↵ on a shape; and the
// marker tray's "Board colors".

installBoardSteps();
installBoardCommands();
let serial = 0;
const ids = () => 'q' + ++serial;

test('should make a blank shape of the same figure beside a selected one and open it for typing when ⌘↵ is pressed', () => {
  const shape = createShape(ids, {x: 0, y: 0, shape: 'diamond', text: 'Decision', fill: '#FFC7C2'});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, shape, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  store.setSelection([shape.id]);
  let typing: string | null = null;
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1200, height: 800}), enterEdit: id => void (typing = id), index: () => null};
  runCommand('board.shape-next', ctx);
  const {doc, selection} = store.getState();
  const made = doc.nodes[selection[0]];
  assert.notEqual(made.id, shape.id);
  assert.deepEqual(made.board, {kind: 'shape', shape: 'diamond'});
  assert.equal(made.x, doc.nodes[shape.id].width + 24);
  const get = (id: string | null | undefined) => (id ? doc.nodes[id] : undefined);
  assert.equal(childPart(get, made, 'text')?.text?.characters, '');
  assert.equal(typing, childPart(get, made, 'text')?.id);
});

test('should offer the colours already drawn with on the board, newest first, and none the tray already holds', () => {
  const tx = beginTransaction(createBoardDocument('page'));
  const line = (color: string) => createStroke(ids, {tool: 'marker', color, weight: 4, commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 10}]});
  for (const color of ['#123456', MARKER_COLORS[0].hex, '#ABCDEF', '#123456']) insertPieces(tx, line(color), 'page');
  insertPieces(tx, createWashi(ids, {from: {x: 0, y: 0}, to: {x: 100, y: 0}, color: '#00AA88', width: 24}), 'page');
  const doc = tx.commit({measurer: fixtureMeasurer}).doc;
  assert.deepEqual(boardColors(doc, 'marker'), ['#123456', '#ABCDEF']);
  assert.deepEqual(boardColors(doc, 'washi'), ['#00AA88']);
  assert.deepEqual(boardColors(doc, 'highlighter'), []);
});

test('should draw a board section with a thin border in its chip\'s colour, and move the border with its colour', () => {
  const violet = SECTION_COLORS.find(color => color.id === 'violet')!, green = SECTION_COLORS.find(color => color.id === 'green')!;
  const section = createBoardSection(ids, {x: 0, y: 0, width: 400, height: 300, name: 'Ideas', fill: violet.hex});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, section, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const border = () => {
    const node = store.getState().doc.nodes[section.id];
    const paint = node.strokes[0];
    return paint?.type === 'SOLID' ? {hex: rgbToHex(paint.color).toUpperCase(), opacity: paint.opacity, weight: node.strokeWeight, align: node.strokeAlign} : null;
  };
  assert.deepEqual(border(), {hex: violet.chip.toUpperCase(), opacity: SECTION_BORDER_OPACITY, weight: 1, align: 'INSIDE'});
  setColor(store, [store.getState().doc.nodes[section.id]], green.hex, 'Section color');
  assert.equal(border()?.hex, green.chip.toUpperCase());
});

test('should name who put the hovered stamp, from the stamp or its drawing, and nobody for a stamp without a name', () => {
  const named = createStamp(ids, {x: 0, y: 0, stamp: 'heart', by: 'Anna'});
  const plain = createStamp(ids, {x: 100, y: 0, stamp: 'star'});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, named, 'page');
  insertPieces(tx, plain, 'page');
  const doc = tx.commit({measurer: fixtureMeasurer}).doc;
  assert.deepEqual(hoveredStampAuthor(doc, named.id), {id: named.id, name: 'Anna'});
  assert.deepEqual(hoveredStampAuthor(doc, doc.nodes[named.id].children![0]), {id: named.id, name: 'Anna'});
  assert.equal(hoveredStampAuthor(doc, plain.id), null);
  assert.equal(hoveredStampAuthor(doc, null), null);
});

test('should hand a ⇧-click emote to the meeting while one runs, and nothing when none does', () => {
  assert.equal(boardEmote({x: 0, y: 0}, 'fire'), false);
  const got: string[] = [];
  const off = registerBoardEmote((_page, emote) => (got.push(emote), true));
  assert.equal(boardEmote({x: 0, y: 0}, 'fire'), true);
  off();
  assert.equal(boardEmote({x: 0, y: 0}, 'heart'), false);
  assert.deepEqual(got, ['fire']);
});

test('should grow a held stamp with the pointer\'s wiggle up to three times its size, everything scaled with it', async () => {
  const {grownStampSize, STAMP_MAX_SIZE} = await import('../src/design/board/tools/place');
  assert.equal(grownStampSize(0), 48);
  assert.equal(grownStampSize(4), 48);
  assert.equal(grownStampSize(240), 72);
  assert.equal(grownStampSize(1e6), STAMP_MAX_SIZE);
  assert.equal(STAMP_MAX_SIZE, 144);
  let n = 0;
  const big = createStamp(() => 'g' + n++, {x: 0, y: 0, stamp: 'heart', size: 96});
  const [badge, icon] = big.pieces.map(piece => piece.node);
  assert.deepEqual([badge.width, badge.height, badge.cornerRadius, badge.strokeWeight], [96, 96, 48, 6]);
  assert.deepEqual([icon.x, icon.width], [24, 48]);
});

test('should delete a selected section alone on ⌘⌫ and leave its contents where they were on the board, selected', () => {
  const section = createBoardSection(ids, {x: 100, y: 100, width: 600, height: 400, name: 'Ideas', fill: SECTION_COLORS[0].hex});
  const shape = createShape(ids, {x: 40, y: 60, shape: 'square', text: 'Inside', fill: '#FFC7C2'});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, section, 'page');
  insertPieces(tx, shape, section.id);
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  store.setSelection([section.id]);
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1200, height: 800}), index: () => null};
  runCommand('board.section-unwrap', ctx);
  const {doc, selection} = store.getState();
  assert.equal(doc.nodes[section.id], undefined);
  assert.deepEqual(selection, [shape.id]);
  assert.deepEqual([doc.nodes[shape.id].parentId, doc.nodes[shape.id].x, doc.nodes[shape.id].y], ['page', 140, 160]);
});

test('should read a CSV file as a table: quoted cells, doubled quotes, line breaks in a cell, a semicolon separator', async () => {
  const {csvPlan, parseCsv} = await import('../src/design/board/paste');
  assert.deepEqual(parseCsv('﻿Name,City\r\n"Smith, J.","London"\r\n"He said ""yes""",\n'), [['Name', 'City'], ['Smith, J.', 'London'], ['He said "yes"', '']]);
  assert.deepEqual(parseCsv('a;b,c;d\n1;"2\n3";4'), [['a', 'b,c', 'd'], ['1', '2\n3', '4']]);
  assert.deepEqual(csvPlan('x,y,z\n1\n'), {kind: 'table', cells: [['x', 'y', 'z'], ['1', '', '']]});
  assert.equal(csvPlan('\n\n'), null);
});

test('should stick a highlight drawn over a sticky to it, and leave one that runs off it on the board', async () => {
  const {highlightHolder} = await import('../src/design/board/tools/marker');
  const {createSticky} = await import('../shared/design/board/create');
  const sticky = createSticky(ids, {x: 100, y: 100, color: 'yellow', text: 'Idea'});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, sticky, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const ctx = {view: {} as never, index: () => null};
  assert.equal(highlightHolder(store.getState(), [{x: 130, y: 200}, {x: 300, y: 205}], ctx)?.id, sticky.id);
  assert.equal(highlightHolder(store.getState(), [{x: 130, y: 200}, {x: 420, y: 205}], ctx), null);
  assert.equal(highlightHolder(store.getState(), [{x: 30, y: 200}, {x: 200, y: 205}], ctx), null);
});

test('should set a connector\'s label on its colour or on the canvas in its colour, and keep that when the colour changes', async () => {
  const {createConnector, connectorLabelPieces} = await import('../shared/design/board/create');
  const {labelBackgroundOf, setLabelBackground} = await import('../src/design/board/edits');
  const link = createConnector(ids, {start: {x: 0, y: 0}, end: {x: 300, y: 0}});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, {...link, pieces: [...link.pieces, ...connectorLabelPieces(ids, link.id, 'Yes')]}, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const get = (id: string | null | undefined) => (id ? store.getState().doc.nodes[id] : undefined);
  const hexOf = (node: ReturnType<typeof get>) => {
    const paint = node?.fills[0];
    return paint?.type === 'SOLID' ? rgbToHex(paint.color).toUpperCase() : null;
  };
  const look = () => {
    const label = childPart(get, get(link.id), 'label');
    return {background: labelBackgroundOf(get, get(link.id)!), chip: hexOf(label), text: hexOf(childPart(get, label, 'text'))};
  };
  assert.equal(look().background, false);
  setColor(store, [get(link.id)!], '#0D99FF');
  assert.deepEqual(look(), {background: false, chip: '#FFFFFF', text: '#0D99FF'});
  setLabelBackground(store, [get(link.id)!], true);
  assert.deepEqual(look(), {background: true, chip: '#0D99FF', text: look().text});
  assert.notEqual(look().text, '#0D99FF');
  setColor(store, [get(link.id)!], '#E03E1A');
  assert.equal(look().chip, '#E03E1A');
});

test('should start a new connector with the style last set from the toolbar', async () => {
  const {createConnector} = await import('../shared/design/board/create');
  const {setEndStyle, setConnectorStyle} = await import('../src/design/board/edits');
  const {connectorLook} = await import('../src/design/board/state');
  const link = createConnector(ids, {start: {x: 0, y: 0}, end: {x: 300, y: 0}});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, link, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const node = () => store.getState().doc.nodes[link.id];
  setColor(store, [node()], '#0D99FF');
  setEndStyle(store, [node()], 'start', 'DIAMOND');
  setConnectorStyle(store, [node()], {weight: 'thick', dashed: true});
  assert.deepEqual(connectorLook(), {color: '#0D99FF', startMarker: 'DIAMOND', weight: 6, dashed: true});
  const next = createConnector(ids, {...connectorLook(), start: {x: 0, y: 100}, end: {x: 300, y: 100}});
  const line = next.pieces[1].node;
  assert.deepEqual([line.strokeStartMarker, line.strokeEndMarker, line.strokeWeight, line.dashPattern.length > 0], ['DIAMOND', 'LINE_ARROW', 6, true]);
});

test('should grow a mind map from a text: ⌘↵ a child to its right, ⇧⌘↵ a sibling under it, joined by grey curves', async () => {
  const {createBoardText} = await import('../shared/design/board/create');
  const {mindChildren, mindParent, MIND_LINE} = await import('../src/design/board/mind-map');
  const root = createBoardText(ids, {x: 0, y: 0, text: 'Topic', size: 24, weight: 700});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, root, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  store.setSelection([root.id]);
  let typing: string | null = null;
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1200, height: 800}), enterEdit: id => void (typing = id), index: () => null};
  runCommand('board.mind-child', ctx);
  const first = typing!;
  const doc = () => store.getState().doc;
  assert.equal(mindParent(doc(), first)?.id, root.id);
  assert.ok(doc().nodes[first].x > doc().nodes[root.id].x + doc().nodes[root.id].width);
  // While typing in the child, ⇧⌘↵ makes its sibling under it.
  store.setEditing({kind: 'text', id: first});
  runCommand('board.mind-sibling', ctx);
  const second = typing!;
  assert.notEqual(second, first);
  assert.deepEqual(mindChildren(doc(), root.id).map(node => node.id), [first, second]);
  assert.equal(doc().nodes[second].x, doc().nodes[first].x);
  assert.ok(doc().nodes[second].y > doc().nodes[first].y);
  const branch = Object.values(doc().nodes).find(node => node.board?.kind === 'connector' && 'node' in node.board.end && node.board.end.node === second)!;
  assert.equal((branch.board as {line: string}).line, 'curved');
  const line = childPart(id => (id ? doc().nodes[id] : undefined), branch, 'line')!;
  assert.equal(line.strokeEndMarker, 'NONE');
  assert.equal(line.strokes[0].type === 'SOLID' && rgbToHex(line.strokes[0].color).toUpperCase(), MIND_LINE);
});

test('should read a Mermaid flowchart: shapes, labelled, dashed and thick edges, chains, & and loops laid out in layers', async () => {
  const {parseMermaid, mermaidLayers, mermaidBuilds} = await import('../src/design/board/mermaid');
  assert.equal(parseMermaid('sequenceDiagram\n  A->>B: hi'), null);
  assert.equal(parseMermaid('just text'), null);
  const chart = parseMermaid('graph LR;A[Start]-->B{Yes?};B -- yes --> C([Done]) --> E;B-.->|no|A;C & B ==> D[(Base)]')!;
  assert.equal(chart.direction, 'LR');
  assert.deepEqual(chart.nodes.map(node => [node.id, node.text, node.shape]), [['A', 'Start', 'square'], ['B', 'Yes?', 'diamond'], ['C', 'Done', 'rounded'], ['E', 'E', 'square'], ['D', 'Base', 'cylinder']]);
  assert.deepEqual(chart.edges.map(edge => `${edge.from}${edge.dashed ? '.' : ''}${edge.thick ? '=' : ''}${edge.to}${edge.label ? ':' + edge.label : ''}`), ['AB', 'BC:yes', 'CE', 'B.A:no', 'C=D', 'B=D']);
  assert.deepEqual([...mermaidLayers(chart)], [['A', 0], ['B', 1], ['C', 2], ['E', 3], ['D', 3]]);
  let n = 0;
  const builds = mermaidBuilds(() => 'm' + n++, chart, {x: 0, y: 0});
  const shapes = builds.filter(build => build.pieces[0].node.board?.kind === 'shape').map(build => build.pieces[0].node);
  assert.equal(shapes.length, 5);
  assert.ok(shapes[1].x > shapes[0].x, 'left to right');
});

test('should size a dragged table, add above and to the left, move rows and columns, colour cells and export CSV', async () => {
  const {createTable} = await import('../shared/design/board/create');
  const {draggedTable} = await import('../src/design/board/tools/place');
  const {tableTexts, tableCsv} = await import('../shared/design/board/table');
  const {setCellColor, tableCells} = await import('../src/design/board/edits');
  assert.deepEqual(draggedTable({x: 0, y: 0}, null), {x: 0, y: 0, columns: 3, rows: 3});
  assert.deepEqual(draggedTable({x: 500, y: 500}, {x: 500 - 160 * 4, y: 500 + 48 * 2}), {x: 500 - 160 * 4, y: 500, columns: 4, rows: 2});
  const table = createTable(ids, {x: 0, y: 0, rows: 2, columns: 2, cells: [['a', 'b, c'], ['"d"', 'e']]});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, table, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const get = (id: string | null | undefined) => (id ? store.getState().doc.nodes[id] : undefined);
  const texts = () => tableTexts(get, table.id);
  const cellText = (row: number, column: number) => childPart(get, get(get(get(table.id)!.children![row])!.children![column]), 'text')!.id;
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1200, height: 800}), index: () => null};
  store.setEditing({kind: 'text', id: cellText(1, 1)});
  runCommand('board.table-row-up', ctx);
  assert.deepEqual(texts(), [['"d"', 'e'], ['a', 'b, c']]);
  store.setEditing({kind: 'text', id: cellText(0, 1)});
  runCommand('board.table-column-back', ctx);
  assert.deepEqual(texts(), [['e', '"d"'], ['b, c', 'a']]);
  store.setEditing({kind: 'text', id: cellText(0, 0)});
  runCommand('board.table-row-above', ctx);
  runCommand('board.table-column-left', ctx);
  assert.deepEqual(texts(), [['', '', ''], ['', 'e', '"d"'], ['', 'b, c', 'a']]);
  assert.equal(tableCsv(get, table.id), ',,\r\n,e,"""d"""\r\n,"b, c",a\r\n');
  setCellColor(store, tableCells(get, get(table.id)!), '#1E1E1E');
  const cell = get(get(get(table.id)!.children![1])!.children![1])!;
  assert.equal(cell.fills[0].type === 'SOLID' && rgbToHex(cell.fills[0].color).toUpperCase(), '#1E1E1E');
  const ink = childPart(get, cell, 'text')!.fills[0];
  assert.equal(ink.type === 'SOLID' && rgbToHex(ink.color).toUpperCase(), '#FFFFFF');
});

test('should put a template\'s content in a section and grow the section to hold it', async () => {
  const {fillSection} = await import('../src/design/board/section-commands');
  const section = createBoardSection(ids, {x: 100, y: 100, width: 300, height: 200, name: 'Retro', fill: SECTION_COLORS[0].hex});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, section, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  assert.equal(fillSection(store, section.id, 'retro', 'Template'), true);
  const doc = store.getState().doc;
  const inside = Object.values(doc.nodes).filter(node => node.board?.kind === 'sticky');
  assert.ok(inside.length > 0);
  const within = (id: string): boolean => id === section.id || (!!doc.nodes[id]?.parentId && doc.nodes[id].parentId !== 'page' && within(doc.nodes[id].parentId!));
  assert.ok(inside.every(node => within(node.id)), 'every sticky is in the section');
  assert.ok(doc.nodes[section.id].width > 300 && doc.nodes[section.id].height > 200);
  assert.deepEqual(store.getState().selection, [section.id]);
});

test('should give a shape a dashed outline that survives a change of figure, and list every figure in "Actions"', async () => {
  const {setShapeDashed, isShapeDashed, setShapeKind, setShapeStroke} = await import('../src/design/board/edits');
  const {BOARD_TOOL_COMMANDS} = await import('../src/design/board/actions');
  const {BOARD_SHAPES} = await import('../shared/design/board/shapes');
  const shape = createShape(ids, {x: 0, y: 0, shape: 'square', text: 'Step'});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, shape, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const get = (id: string | null | undefined) => (id ? store.getState().doc.nodes[id] : undefined);
  setShapeStroke(store, [get(shape.id)!], '#1E1E1E');
  setShapeDashed(store, [get(shape.id)!], true);
  setShapeKind(store, [get(shape.id)!], 'diamond');
  assert.equal(isShapeDashed(get, get(shape.id)!), true);
  const labels = BOARD_TOOL_COMMANDS.map(command => command.label);
  for (const figure of BOARD_SHAPES.filter(entry => entry.id !== 'square')) assert.ok(labels.includes(figure.label), figure.label);
});

test('should join an object dropped on a mind map text to it, and move a node from its old parent', async () => {
  const {createBoardText, createSticky} = await import('../shared/design/board/create');
  const {createMindMap, joinMindMap, mindParent, mindTargetAt} = await import('../src/design/board/mind-map');
  const builds = createMindMap(ids, {x: 0, y: 0});
  const sticky = createSticky(ids, {x: 600, y: 400, color: 'yellow', text: 'Separate'});
  const loose = createBoardText(ids, {x: 600, y: -300, text: 'Plain text'});
  const tx = beginTransaction(createBoardDocument('page'));
  for (const build of [...builds, sticky, loose]) insertPieces(tx, build, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const doc = () => store.getState().doc;
  const byText = (text: string) => Object.values(doc().nodes).find(node => node.text?.characters === text)!;
  const idea = byText('Idea');
  // Over a text of the map: it is the target; over a loose text, nothing.
  assert.equal(mindTargetAt(doc(), {x: idea.x + 2, y: idea.y + 2}, sticky.id)?.id, idea.id);
  assert.equal(mindTargetAt(doc(), {x: 602, y: -298}, sticky.id), null);
  assert.equal(joinMindMap(store, idea.id, sticky.id), true);
  assert.equal(mindParent(doc(), sticky.id)?.id, idea.id, 'its branch runs from the idea');
  assert.equal(joinMindMap(store, idea.id, sticky.id), false, 'once only');
  // "Thought" moves under "Idea": one parent still.
  const thought = byText('Thought');
  joinMindMap(store, idea.id, thought.id);
  assert.equal(mindParent(doc(), thought.id)?.id, idea.id);
  assert.equal(Object.values(doc().nodes).filter(node => node.board?.kind === 'connector' && 'node' in node.board.end && node.board.end.node === thought.id).length, 1);
});

test('should offer a connector\'s waypoints and stretch middles, and place its label by the nearest share of its length', async () => {
  const {createConnector} = await import('../shared/design/board/create');
  const {pathHandles, labelFractionAt} = await import('../src/design/board/tools/connector-path');
  const link = createConnector(ids, {start: {x: 0, y: 0}, end: {x: 400, y: 0}, line: 'straight'});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, link, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const doc = () => store.getState().doc;
  assert.deepEqual(pathHandles(doc(), link.id).map(handle => [handle.kind, handle.index, Math.round(handle.at.x), Math.round(handle.at.y)]), [['mid', 0, 200, 0]]);
  assert.equal(labelFractionAt(doc(), link.id, {x: 100, y: 30}), 0.25);
  store.transact('waypoint', t => {
    const node = t.get(link.id)!;
    if (node.board?.kind === 'connector') t.update(link.id, {board: {...node.board, points: [{x: 200, y: 200}]}});
  });
  const handles = pathHandles(doc(), link.id).map(handle => [handle.kind, handle.index, Math.round(handle.at.x), Math.round(handle.at.y)]);
  assert.deepEqual(handles, [['point', 0, 200, 200], ['mid', 0, 100, 100], ['mid', 1, 300, 100]]);
});

test('should put a connector end at the very point of an object when ⌘ is held', async () => {
  const {endAt} = await import('../src/design/board/tools/common');
  const shape = createShape(ids, {x: 0, y: 0, shape: 'square', text: ''});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, shape, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const view = {viewport: () => ({x: 0, y: 0, zoom: 1}), pixel: () => 1} as never;
  const ctx = {view, index: () => null};
  assert.deepEqual(endAt(store.getState(), {x: 50, y: 150}, ctx, undefined, true).end, {node: shape.id, at: {x: 0.25, y: 0.75}});
  assert.ok('magnet' in endAt(store.getState(), {x: 50, y: 150}, ctx).end);
});

test('should merge a cell with the next to the right and below, lay the merge out over its columns and rows, and unmerge it', async () => {
  const {createTable} = await import('../shared/design/board/create');
  const {tableCoverage} = await import('../shared/design/board/table');
  const table = createTable(ids, {x: 0, y: 0, rows: 3, columns: 3, cells: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, table, 'page');
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const get = (id: string | null | undefined) => (id ? store.getState().doc.nodes[id] : undefined);
  const cell = (r: number, c: number) => get(get(get(table.id)!.children![r])!.children![c])!;
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1200, height: 800}), index: () => null};
  const width = cell(1, 1).width, rowHeights = [0, 1, 2].map(r => get(get(table.id)!.children![r])!.height);
  store.setEditing({kind: 'text', id: childPart(get, cell(1, 0), 'text')!.id});
  runCommand('board.table-merge-right', ctx);
  store.setEditing({kind: 'text', id: childPart(get, cell(1, 0), 'text')!.id});
  runCommand('board.table-merge-down', ctx);
  assert.deepEqual(cell(1, 0).board, {kind: 'part', part: 'cell', colSpan: 2, rowSpan: 2});
  assert.equal(cell(1, 0).width, width * 2);
  assert.equal(cell(1, 0).height, rowHeights[1] + rowHeights[2]);
  assert.deepEqual([cell(1, 1).visible, cell(2, 0).visible, cell(2, 0).opacity, cell(2, 0).width, cell(2, 1).visible], [false, true, 0, width * 2, false]);
  assert.equal(tableCoverage(get, table.id).size, 3);
  // Typing in a covered cell goes to the merged one; unmerge gives every cell its place back.
  store.setEditing({kind: 'text', id: childPart(get, cell(2, 1), 'text')!.id});
  runCommand('board.table-unmerge', ctx);
  assert.deepEqual(cell(1, 0).board, {kind: 'part', part: 'cell'});
  assert.deepEqual([0, 1, 2].map(c => [cell(1, c).width, cell(2, c).width, cell(1, c).visible, cell(2, c).opacity]), [0, 1, 2].map(() => [width, width, true, 1]));
});

test('should offer FigJam\'s other flowchart figures in "Actions" and make shapes of them with text inside', async () => {
  const {BOARD_TOOL_COMMANDS} = await import('../src/design/board/actions');
  const {BOARD_FLOWCHART_SHAPES} = await import('../shared/design/board/shapes');
  const labels = BOARD_TOOL_COMMANDS.map(command => command.label);
  assert.equal(BOARD_FLOWCHART_SHAPES.length, 10);
  for (const figure of BOARD_FLOWCHART_SHAPES) {
    assert.ok(labels.includes(figure.label), figure.label);
    const shape = createShape(ids, {x: 0, y: 0, shape: figure.id, text: 'Step'});
    const tx = beginTransaction(createBoardDocument('page'));
    insertPieces(tx, shape, 'page');
    const doc = tx.commit({measurer: fixtureMeasurer}).doc;
    assert.deepEqual(doc.nodes[shape.id].board, {kind: 'shape', shape: figure.id});
  }
});

test('should hide what a section holds from paint and clicks, and lock only its background', async () => {
  const {setSectionFlag} = await import('../src/design/board/edits');
  const {hiddenSectionChildren} = await import('../shared/design/board/model');
  const {hitTest} = await import('../src/design/engine/hit-test');
  const section = createBoardSection(ids, {x: 0, y: 0, width: 800, height: 600, name: 'Ideas', fill: SECTION_COLORS[0].hex});
  const shape = createShape(ids, {x: 100, y: 100, shape: 'square', text: 'Inside'});
  const tx = beginTransaction(createBoardDocument('page'));
  insertPieces(tx, section, 'page');
  insertPieces(tx, shape, section.id);
  const store = createDesignStore({doc: tx.commit({measurer: fixtureMeasurer}).doc, measurer: fixtureMeasurer});
  const doc = () => store.getState().doc;
  const inShape = {x: 150, y: 150}, inSection = {x: 600, y: 500};
  const owner = (id: string | null) => (id === section.id ? 'section' : id && doc().nodes[id] ? 'inside' : null);
  assert.deepEqual([owner(hitTest(doc(), 'page', inShape)), owner(hitTest(doc(), 'page', inSection))], ['inside', 'section']);
  setSectionFlag(store, [doc().nodes[section.id]], 'hidden', true);
  assert.deepEqual([...(hiddenSectionChildren(doc()) ?? [])], [shape.id]);
  assert.equal(owner(hitTest(doc(), 'page', inShape)), 'section', 'the hidden shape takes no click');
  setSectionFlag(store, [doc().nodes[section.id]], 'hidden', false);
  assert.equal(hiddenSectionChildren(doc()), null);
  setSectionFlag(store, [doc().nodes[section.id]], 'backgroundLocked', true);
  assert.deepEqual(doc().nodes[section.id].board, {kind: 'section', backgroundLocked: true});
  assert.deepEqual([owner(hitTest(doc(), 'page', inShape)), hitTest(doc(), 'page', inSection)], ['inside', null]);
});

test('should know a pasted link, and make a card of its preview: title with the link, description, site, cut at their lines', async () => {
  const {linkOf} = await import('../src/design/board/link-card');
  const {createLinkCard} = await import('../shared/design/board/create');
  assert.equal(linkOf('  https://example.com/a?b=1 '), 'https://example.com/a?b=1');
  assert.equal(linkOf('example.com'), null);
  assert.equal(linkOf('https://a.com and text'), null);
  assert.equal(linkOf('javascript:alert(1)'), null);
  let n = 0;
  const card = createLinkCard(() => 'l' + n++, {x: 0, y: 0, content: {url: 'https://example.com/page', title: 'Title', description: 'Description', site: null, image: 'img'}});
  const nodes = card.pieces.map(piece => piece.node);
  assert.equal(nodes[0].type, 'GROUP');
  const texts = nodes.filter(node => node.type === 'TEXT');
  assert.deepEqual(texts.map(node => node.text?.characters), ['Title', 'Description', 'example.com']);
  assert.deepEqual(texts[0].text?.style.hyperlink, {type: 'URL', url: 'https://example.com/page'});
  assert.deepEqual(texts.map(node => [node.text?.textAutoResize, node.text?.maxLines]), [['TRUNCATE', 2], ['TRUNCATE', 3], ['TRUNCATE', 1]]);
  assert.ok(nodes.some(node => node.fills.some(paint => paint.type === 'IMAGE' && paint.imageRef === 'img')));
  assert.equal(nodes[0].height, nodes[1].height, 'the card is as tall as its contents');
});
