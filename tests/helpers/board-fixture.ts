import {createBoardDocument} from '../../shared/design/board/document';
import {
  createBoardSection, createBoardText, createConnector, createShape, createStamp, createSticker, createSticky, createStroke, createTable, createWashi,
  insertPieces, type BoardBuild,
} from '../../shared/design/board/create';
import {buildBoardTemplate, insertBoardTemplate, BOARD_TEMPLATES} from '../../shared/design/board/templates';
import {beginTransaction} from '../../shared/design/transaction';
import type {DesignDocument} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';

// A board holding every kind of board object and the first two templates, as the factories made them before lane FJ (2026-10-10). The
// committed JSON (tests/fixtures/board-before-fj.json) is this board; a board made before must keep opening exactly as it was.
// The Russian sample text below is deliberate: it is byte-for-byte what the committed JSON holds (which crates/wasm/src/parts.rs also reads),
// so translating it here would break the comparison with the fixture.

export const fixtureMeasurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const TEMPLATE_STEP = 4000;

export function buildFixtureBoard(): DesignDocument {
  let serial = 0;
  const ids = () => 'f' + ++serial;
  const tx = beginTransaction(createBoardDocument('page'));
  const sticky = createSticky(ids, {x: 0, y: 0, text: 'Идея', author: 'Анна Петрова', showAuthor: true});
  const shape = createShape(ids, {x: 400, y: 0, shape: 'diamond', text: 'Решение'});
  const builds: BoardBuild[] = [
    sticky,
    createSticky(ids, {x: 0, y: 300, color: 'blue', wide: true}),
    shape,
    createConnector(ids, {start: {node: sticky.id, magnet: 'auto'}, end: {node: shape.id, magnet: 'left'}, line: 'curved', label: 'да', endArrow: true}),
    createConnector(ids, {start: {x: 0, y: 700}, end: {x: 300, y: 800}, line: 'elbow', dashed: true}),
    createBoardText(ids, {x: 800, y: 0, text: 'Заголовок', size: 48, handwriting: true}),
    createStamp(ids, {x: 800, y: 200, stamp: 'heart'}),
    createStamp(ids, {x: 900, y: 200, stamp: 'avatar', by: 'Кирилл'}),
    createSticker(ids, {x: 800, y: 300, sticker: 'light-bulb'})!,
    createTable(ids, {x: 0, y: 900, rows: 2, columns: 3, header: true, cells: [['А', 'Б', 'В'], ['1', '2', '3']]}),
    createStroke(ids, {tool: 'marker', color: '#1E1E1E', weight: 4, commands: [{type: 'M', x: 0, y: 1200}, {type: 'C', x1: 40, y1: 1180, x2: 80, y2: 1240, x: 120, y: 1210}]}),
    createStroke(ids, {tool: 'highlighter', color: '#FFE380', weight: 18, commands: [{type: 'M', x: 0, y: 1300}, {type: 'L', x: 200, y: 1300}]}),
    createWashi(ids, {from: {x: 0, y: 1400}, to: {x: 240, y: 1420}, color: '#9747FF', width: 24}),
    createBoardSection(ids, {x: -400, y: -400, width: 300, height: 200, name: 'Секция', fill: '#FFF5CC'}),
  ];
  for (const build of builds) insertPieces(tx, build, 'page');
  BOARD_TEMPLATES.slice(0, 2).forEach((template, k) => insertBoardTemplate(tx, buildBoardTemplate(template.id, ids), 'page', {x: (k + 1) * TEMPLATE_STEP, y: 0}));
  return tx.commit({measurer: fixtureMeasurer}).doc;
}
