import type {Effect, NodeId, Paint, PathCommand, SceneNode, StrokeMarker, TextProps, Vec} from '../types';
import {createNode, defaultAutoLayout, defaultTextProps, solid} from '../defaults';
import {parsePathData, transformPath} from '../paths';
import {part} from './model';
import {boardShapeGeometry, boardShapeTextInsets, BOARD_SHAPE_LABELS} from './shapes';
import {hexToRgb, inkOn, sectionChipOf, SECTION_BORDER_OPACITY, stickyColor} from './palette';
import {avatarColor, initialsOf, stampSpec, stickerSpec} from './art';
import type {BoardShapeKind, ConnectorEnd, ConnectorLine, StampId, StrokeTool} from './types';

// "Board": the layers of each board object (docs/board.md §Objects), made the same way by the tools, the templates, paste and the
// AI. A factory answers the pieces in creation order: the object first (its parent is the caller's), then each layer under its
// parent. `insertPieces` puts them into a transaction; templates add them to their builder.

export type NewId = () => string;
export type BoardPiece = {node: SceneNode; parent: NodeId};
/** The object (`pieces[0].node`) and every layer, parents before children. */
export type BoardBuild = {id: NodeId; pieces: BoardPiece[]};

/** The handwriting face of a board (FigJam's "Handwriting"): Caveat, self-hosted with the catalogue, Cyrillic included. */
export const HANDWRITING_FONT = 'Caveat';
export const BOARD_FONT = 'Inter';
export const BOARD_INK = '#1E1E1E';

/** Adds a build to a transaction-like writer (`tx.create`): the object under `parentId` (at `index`), its layers under theirs. */
export function insertPieces(tx: {create(node: SceneNode, parentId: NodeId, index?: number): void}, build: BoardBuild, parentId: NodeId, index?: number): void {
  build.pieces.forEach((piece, i) => tx.create(piece.node, i === 0 ? parentId : piece.parent, i === 0 ? index : undefined));
}

const ink = (hex: string, opacity = 1): Paint => solid(hexToRgb(hex), opacity);

function textProps(characters: string, options: {family?: string; size: number; weight?: number; align?: TextProps['textAlignHorizontal']; valign?: TextProps['textAlignVertical']; resize?: TextProps['textAutoResize']; lineHeight?: number}): TextProps {
  const base = defaultTextProps(characters);
  return {
    ...base,
    style: {
      ...base.style,
      fontFamily: options.family ?? BOARD_FONT,
      fontWeight: options.weight ?? 400,
      fontSize: options.size,
      lineHeight: options.lineHeight ? {unit: 'PERCENT', value: options.lineHeight} : {unit: 'AUTO'},
    },
    textAlignHorizontal: options.align ?? 'LEFT',
    textAlignVertical: options.valign ?? 'TOP',
    textAutoResize: options.resize ?? 'HEIGHT',
  };
}

const textName = (characters: string, fallback: string) => characters.replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;

// ── Stickies ─────────────────────────────────────────────────────────────────────────────────────

export const STICKY_SHADOW: Effect[] = [
  {type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.06}, offset: {x: 0, y: 1}, radius: 2, spread: 0, visible: true, blendMode: 'NORMAL'},
  {type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.1}, offset: {x: 0, y: 4}, radius: 10, spread: -2, visible: true, blendMode: 'NORMAL'},
];

export type StickyOptions = {x: number; y: number; color?: string; text?: string; author?: string; showAuthor?: boolean; wide?: boolean; family?: string};

export function createSticky(newId: NewId, options: StickyOptions): BoardBuild {
  const id = newId(), textId = newId(), authorId = newId();
  const color = stickyColor(options.color ?? 'yellow');
  const width = options.wide ? 480 : 240, height = 240;
  const sticky = createNode('FRAME', {
    id, name: 'Sticky', x: options.x, y: options.y, width, height, minHeight: height,
    fills: [ink(color.hex)], cornerRadius: 2, effects: STICKY_SHADOW, clipsContent: false,
    layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG',
    autoLayout: {...defaultAutoLayout('VERTICAL'), primaryAxisAlignItems: 'SPACE_BETWEEN', paddingTop: 24, paddingRight: 24, paddingBottom: 20, paddingLeft: 24, itemSpacing: 8},
    board: options.wide ? {kind: 'sticky', wide: true} : {kind: 'sticky'},
  });
  const characters = options.text ?? '';
  const text = createNode('TEXT', {
    id: textId, parentId: id, name: textName(characters, 'Text'), fills: [ink(inkOn(hexToRgb(color.hex)))],
    text: textProps(characters, {family: options.family, size: 24, lineHeight: 125}),
    width: width - 48, height: 30, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', board: part('text'),
  });
  const author = createNode('TEXT', {
    id: authorId, parentId: id, name: 'Author', fills: [ink(BOARD_INK, 0.55)], visible: !!options.showAuthor && !!options.author,
    text: textProps(options.author ?? '', {size: 12, weight: 500}),
    width: width - 48, height: 15, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', board: part('author'),
  });
  return {id, pieces: [{node: sticky, parent: ''}, {node: text, parent: id}, {node: author, parent: id}]};
}

// ── Shapes with text ─────────────────────────────────────────────────────────────────────────────

export type ShapeOptions = {x: number; y: number; width?: number; height?: number; shape: BoardShapeKind; fill?: string; stroke?: string | null; text?: string; size?: number; family?: string};

export const SHAPE_DEFAULT_FILL = '#BDE3FF';
export const SHAPE_DEFAULT_STROKE = '#0A7CD1';

export function createShape(newId: NewId, options: ShapeOptions): BoardBuild {
  const id = newId(), figureId = newId(), textId = newId();
  const width = options.width ?? 200, height = options.height ?? (options.shape === 'arrow-right' || options.shape === 'arrow-left' ? 120 : 200);
  const fill = options.fill ?? SHAPE_DEFAULT_FILL;
  const insets = boardShapeTextInsets(options.shape);
  const frame = createNode('FRAME', {
    id, name: BOARD_SHAPE_LABELS[options.shape], x: options.x, y: options.y, width, height, minHeight: height, fills: [], clipsContent: false,
    layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG',
    autoLayout: {
      ...defaultAutoLayout('VERTICAL'), primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER',
      paddingTop: Math.round(height * insets.top), paddingBottom: Math.round(height * insets.bottom),
      paddingLeft: Math.round(width * insets.left), paddingRight: Math.round(width * insets.right),
    },
    board: {kind: 'shape', shape: options.shape},
  });
  const geometry = boardShapeGeometry(options.shape, width, height);
  const stroke = options.stroke === undefined ? null : options.stroke;
  const figure = createNode(geometry.type, {
    id: figureId, parentId: id, name: 'Shape', x: 0, y: 0, width, height, fills: [ink(fill)],
    strokes: stroke ? [ink(stroke)] : [], strokeWeight: 2, strokeAlign: 'INSIDE',
    layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}, board: part('shape'), ...geometry.fields,
  });
  const characters = options.text ?? '';
  const text = createNode('TEXT', {
    id: textId, parentId: id, name: textName(characters, 'Text'), fills: [ink(inkOn(hexToRgb(fill)))],
    text: textProps(characters, {family: options.family, size: options.size ?? 18, align: 'CENTER', valign: 'CENTER', lineHeight: 125}),
    width: Math.max(1, width * (1 - insets.left - insets.right)), height: 23, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', board: part('text'),
  });
  return {id, pieces: [{node: frame, parent: ''}, {node: figure, parent: id}, {node: text, parent: id}]};
}

// ── Connectors ───────────────────────────────────────────────────────────────────────────────────

export type ConnectorOptions = {
  start: ConnectorEnd; end: ConnectorEnd; line?: ConnectorLine; color?: string; weight?: number; startArrow?: boolean; endArrow?: boolean; label?: string; dashed?: boolean;
  /** Point styles that win over `startArrow` / `endArrow` (FigJam's five: none, line arrow, solid arrow, triangle, diamond). */
  startMarker?: StrokeMarker; endMarker?: StrokeMarker;
};

export function createConnector(newId: NewId, options: ConnectorOptions): BoardBuild {
  const id = newId(), lineId = newId();
  const group = createNode('GROUP', {id, name: 'Connector', board: {kind: 'connector', start: options.start, end: options.end, line: options.line ?? 'elbow'}});
  const line = createNode('VECTOR', {
    id: lineId, parentId: id, name: 'Line', width: 0, height: 0, fills: [], strokes: [ink(options.color ?? BOARD_INK)], strokeWeight: options.weight ?? 3,
    strokeAlign: 'CENTER', strokeCap: 'ROUND', strokeJoin: 'ROUND', dashPattern: options.dashed ? [8, 8] : [],
    strokeStartMarker: options.startMarker ?? (options.startArrow ? 'LINE_ARROW' : 'NONE'), strokeEndMarker: options.endMarker ?? (options.endArrow === false ? 'NONE' : 'LINE_ARROW'),
    vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 0, y: 0}]}], board: part('line'),
  });
  const pieces: BoardPiece[] = [{node: group, parent: ''}, {node: line, parent: id}];
  if (options.label) pieces.push(...connectorLabelPieces(newId, id, options.label));
  return {id, pieces};
}

/** A connector's label: a white chip with a text (in the line's colour, `color`), placed on the line's middle by normalization. */
export function connectorLabelPieces(newId: NewId, connectorId: NodeId, characters: string, color = BOARD_INK): BoardPiece[] {
  const labelId = newId(), textId = newId();
  const label = createNode('FRAME', {
    id: labelId, parentId: connectorId, name: 'Label', fills: [ink('#FFFFFF')], cornerRadius: 4, clipsContent: false,
    layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', width: 40, height: 24,
    autoLayout: {...defaultAutoLayout('HORIZONTAL'), paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8},
    board: part('label'),
  });
  const text = createNode('TEXT', {
    id: textId, parentId: labelId, name: textName(characters, 'Label'), fills: [ink(color)],
    text: textProps(characters, {size: 14, resize: 'WIDTH_AND_HEIGHT'}), board: part('text'),
  });
  return [{node: label, parent: connectorId}, {node: text, parent: labelId}];
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

export type BoardTextOptions = {x: number; y: number; text?: string; size?: number; handwriting?: boolean; weight?: number; color?: string; width?: number};

export function createBoardText(newId: NewId, options: BoardTextOptions): BoardBuild {
  const id = newId();
  const characters = options.text ?? '';
  const node = createNode('TEXT', {
    id, name: textName(characters, 'Text'), x: options.x, y: options.y, fills: [ink(options.color ?? BOARD_INK)],
    text: textProps(characters, {family: options.handwriting ? HANDWRITING_FONT : BOARD_FONT, size: options.size ?? 24, weight: options.weight, resize: options.width ? 'HEIGHT' : 'WIDTH_AND_HEIGHT', lineHeight: 120}),
    ...(options.width ? {width: options.width, layoutSizingHorizontal: 'FIXED' as const} : {}),
  });
  return {id, pieces: [{node, parent: ''}]};
}

// ── Stamps ───────────────────────────────────────────────────────────────────────────────────────

export const STAMP_SIZE = 48;
const STAMP_SHADOW: Effect[] = [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.18}, offset: {x: 0, y: 2}, radius: 6, spread: 0, visible: true, blendMode: 'NORMAL'}];

/** A stamp badge; `size` (default STAMP_SIZE) is how far it was grown by holding and wiggling (FigJam), everything scaled with it. */
export function createStamp(newId: NewId, options: {x: number; y: number; stamp: StampId; by?: string; size?: number}): BoardBuild {
  const id = newId(), iconId = newId();
  const size = options.size ?? STAMP_SIZE, k = size / STAMP_SIZE;
  const spec = stampSpec(options.stamp);
  const color = options.stamp === 'avatar' ? avatarColor(options.by) : spec.color;
  const badge = createNode('FRAME', {
    id, name: 'Stamp: ' + spec.label, x: options.x, y: options.y, width: size, height: size, cornerRadius: size / 2,
    fills: [ink(color)], strokes: [ink('#FFFFFF')], strokeWeight: 3 * k, strokeAlign: 'INSIDE', effects: STAMP_SHADOW, clipsContent: false,
    board: options.by ? {kind: 'stamp', stamp: options.stamp, by: options.by} : {kind: 'stamp', stamp: options.stamp},
  });
  const pieces: BoardPiece[] = [{node: badge, parent: ''}];
  const glyph = options.stamp === 'avatar' ? initialsOf(options.by) : spec.glyph;
  if (glyph) {
    const glyphSize = Math.round((glyph.length > 1 ? 17 : 22) * k);
    pieces.push({
      node: createNode('TEXT', {
        id: iconId, parentId: id, name: glyph, x: 0, y: 0, width: size, height: size, fills: [ink('#FFFFFF')],
        text: textProps(glyph, {size: glyphSize, weight: 700, align: 'CENTER', valign: 'CENTER', resize: 'NONE'}),
      }),
      parent: id,
    });
  } else if (spec.icon) {
    const scale = k, icon = 24 * k, offset = (size - icon) / 2;
    const commands = transformPath(parsePathData(spec.icon), [[scale, 0, 0], [0, scale, 0]]);
    pieces.push({
      node: createNode('VECTOR', {
        id: iconId, parentId: id, name: 'Icon', x: offset, y: offset, width: icon, height: icon,
        fills: spec.stroke ? [] : [ink('#FFFFFF')], strokes: spec.stroke ? [ink('#FFFFFF')] : [], strokeWeight: 3 * k, strokeCap: 'ROUND', strokeJoin: 'ROUND',
        vectorPaths: [{windingRule: 'NONZERO', commands}],
      }),
      parent: id,
    });
  }
  return {id, pieces};
}

// ── Stickers ─────────────────────────────────────────────────────────────────────────────────────

export function createSticker(newId: NewId, options: {x: number; y: number; sticker: string; size?: number}): BoardBuild | null {
  const spec = stickerSpec(options.sticker);
  if (!spec) return null;
  const size = options.size ?? 120, scale = size / 96;
  const id = newId();
  const group = createNode('GROUP', {id, name: 'Sticker: ' + spec.label, x: options.x, y: options.y, width: size, height: size, board: {kind: 'sticker', sticker: spec.id}});
  const pieces: BoardPiece[] = [{node: group, parent: ''}];
  spec.layers.forEach((layer, i) => {
    const fills = layer.fill ? [ink(layer.fill)] : [];
    const strokes = layer.stroke ? [ink(layer.stroke)] : [];
    const strokeWeight = (layer.width ?? 3) * scale;
    if ('ellipse' in layer) {
      const [cx, cy, rx, ry] = layer.ellipse;
      pieces.push({node: createNode('ELLIPSE', {id: newId(), parentId: id, name: 'Layer ' + (i + 1), x: (cx - rx) * scale, y: (cy - ry) * scale, width: rx * 2 * scale, height: ry * 2 * scale, fills, strokes, strokeWeight, strokeAlign: 'CENTER'}), parent: id});
      return;
    }
    const commands = transformPath(parsePathData(layer.d), [[scale, 0, 0], [0, scale, 0]]);
    const box = pathBox(commands);
    pieces.push({
      node: createNode('VECTOR', {
        id: newId(), parentId: id, name: 'Layer ' + (i + 1), x: box.x, y: box.y, width: box.width, height: box.height, fills, strokes, strokeWeight,
        strokeAlign: 'CENTER', strokeCap: layer.cap === 'round' ? 'ROUND' : 'NONE', strokeJoin: 'ROUND',
        vectorPaths: [{windingRule: 'NONZERO', commands: transformPath(commands, [[1, 0, -box.x], [0, 1, -box.y]])}],
      }),
      parent: id,
    });
  });
  return {id, pieces};
}

function pathBox(commands: readonly PathCommand[]): {x: number; y: number; width: number; height: number} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const command of commands) {
    const points: [number, number][] = command.type === 'Z' ? [] : command.type === 'C' ? [[command.x1, command.y1], [command.x2, command.y2], [command.x, command.y]] : command.type === 'Q' ? [[command.x1, command.y1], [command.x, command.y]] : [[command.x, command.y]];
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (minX === Infinity) return {x: 0, y: 0, width: 0, height: 0};
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

// ── Tables ───────────────────────────────────────────────────────────────────────────────────────

export const TABLE_CELL = {width: 160, height: 48};
const TABLE_LINE = '#C4C4C4';

export type TableOptions = {x: number; y: number; rows?: number; columns?: number; cells?: string[][]; cellWidth?: number; header?: boolean};

/** One cell: a frame with a text, its right and bottom lines drawn by the cell (the table draws the outer frame). */
export function tableCellPieces(newId: NewId, rowId: NodeId, characters: string, width: number, header: boolean): BoardPiece[] {
  const cellId = newId(), textId = newId();
  const cell = createNode('FRAME', {
    id: cellId, parentId: rowId, name: 'Cell', width, height: TABLE_CELL.height, minHeight: TABLE_CELL.height,
    fills: [ink(header ? '#F2F2F2' : '#FFFFFF')], strokes: [ink(TABLE_LINE)], strokeWeight: 1, strokeAlign: 'INSIDE',
    individualStrokeWeights: {top: 0, right: 1, bottom: 1, left: 0}, clipsContent: false,
    layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FILL',
    autoLayout: {...defaultAutoLayout('VERTICAL'), primaryAxisAlignItems: 'CENTER', paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12},
    board: part('cell'),
  });
  const text = createNode('TEXT', {
    id: textId, parentId: cellId, name: textName(characters, 'Text'), fills: [ink(BOARD_INK)], width: width - 24, height: 18,
    text: textProps(characters, {size: 14, weight: header ? 600 : 400, lineHeight: 130}), layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', board: part('text'),
  });
  return [{node: cell, parent: rowId}, {node: text, parent: cellId}];
}

export function tableRowPieces(newId: NewId, tableId: NodeId, cells: readonly string[], widths: readonly number[], header: boolean): BoardPiece[] {
  const rowId = newId();
  const row = createNode('FRAME', {
    id: rowId, parentId: tableId, name: 'Row', fills: [], clipsContent: false, height: TABLE_CELL.height, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'FIXED',
    autoLayout: {...defaultAutoLayout('HORIZONTAL'), counterAxisAlignItems: 'MIN'}, board: part('row'),
  });
  return [{node: row, parent: tableId}, ...widths.flatMap((width, i) => tableCellPieces(newId, rowId, cells[i] ?? '', width, header))];
}

export function createTable(newId: NewId, options: TableOptions): BoardBuild {
  const rows = options.cells?.length ?? options.rows ?? 3;
  const columns = options.cells ? Math.max(...options.cells.map(row => row.length), 1) : options.columns ?? 3;
  const id = newId();
  const table = createNode('FRAME', {
    id, name: 'Table', x: options.x, y: options.y, fills: [ink('#FFFFFF')], strokes: [ink(TABLE_LINE)], strokeWeight: 1, strokeAlign: 'OUTSIDE', cornerRadius: 0, clipsContent: true,
    layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', autoLayout: {...defaultAutoLayout('VERTICAL')}, board: {kind: 'table'},
  });
  const widths = Array.from({length: columns}, () => options.cellWidth ?? TABLE_CELL.width);
  const pieces: BoardPiece[] = [{node: table, parent: ''}];
  for (let r = 0; r < rows; r++) pieces.push(...tableRowPieces(newId, id, options.cells?.[r] ?? [], widths, !!options.header && r === 0));
  return {id, pieces};
}

// ── Strokes ──────────────────────────────────────────────────────────────────────────────────────

export const STROKE_NAMES: Record<StrokeTool, string> = {marker: 'Marker', highlighter: 'Highlighter', washi: 'Washi tape'};

/** A marker or highlighter stroke through `points` (page space of its parent), already smoothed by the tool. */
export function createStroke(newId: NewId, options: {tool: 'marker' | 'highlighter'; commands: PathCommand[]; color: string; weight: number}): BoardBuild {
  const id = newId();
  const box = pathBox(options.commands);
  const highlighter = options.tool === 'highlighter';
  const node = createNode('VECTOR', {
    id, name: STROKE_NAMES[options.tool], x: box.x, y: box.y, width: box.width, height: box.height, fills: [],
    strokes: [ink(options.color, highlighter ? 0.8 : 1)], strokeWeight: options.weight, strokeAlign: 'CENTER', strokeCap: 'ROUND', strokeJoin: 'ROUND',
    blendMode: highlighter ? 'MULTIPLY' : 'NORMAL',
    vectorPaths: [{windingRule: 'NONZERO', commands: transformPath(options.commands, [[1, 0, -box.x], [0, 1, -box.y]])}],
    board: {kind: 'stroke', tool: options.tool},
  });
  return {id, pieces: [{node, parent: ''}]};
}

/** Washi tape from `from` to `to`, `width` wide: a strip with torn ends and lighter stripes across it. */
/** Washi tape from `from` to `to`; with `image` (and the picture's natural height) printed with that picture, tiled along it. */
export function createWashi(newId: NewId, options: {from: Vec; to: Vec; color: string; width: number; image?: {ref: string; height: number}}): BoardBuild {
  const id = newId(), bodyId = newId(), stripesId = newId();
  const {from, to, width} = options;
  const length = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
  const along = {x: (to.x - from.x) / length, y: (to.y - from.y) / length}, across = {x: -along.y, y: along.x};
  const at = (s: number, t: number): Vec => ({x: from.x + along.x * s + across.x * t, y: from.y + along.y * s + across.y * t});
  // Torn ends: a small zigzag at each end.
  const teeth = 5, depth = Math.min(4, length / 8), half = width / 2;
  const outline: Vec[] = [];
  for (let i = 0; i <= teeth; i++) outline.push(at(i % 2 ? depth : 0, -half + (width * i) / teeth));
  for (let i = teeth; i >= 0; i--) outline.push(at(length - (i % 2 ? depth : 0), -half + (width * i) / teeth));
  const bodyCommands: PathCommand[] = [...outline.map((p, i) => ({type: i ? 'L' : 'M', x: p.x, y: p.y}) as PathCommand), {type: 'Z'}];
  const stripeCommands: PathCommand[] = [{type: 'M', ...at(depth, 0)}, {type: 'L', ...at(length - depth, 0)}];
  const box = pathBox(bodyCommands);
  const group = createNode('GROUP', {id, name: STROKE_NAMES.washi, x: box.x, y: box.y, width: box.width, height: box.height, board: {kind: 'stroke', tool: 'washi'}});
  const body = createNode('VECTOR', {
    id: bodyId, parentId: id, name: 'Tape', x: 0, y: 0, width: box.width, height: box.height, strokes: [],
    fills: options.image ? [{type: 'IMAGE', imageRef: options.image.ref, scaleMode: 'TILE', scalingFactor: width / Math.max(1, options.image.height), visible: true, opacity: 1, blendMode: 'NORMAL'}] : [ink(options.color, 0.88)],
    vectorPaths: [{windingRule: 'NONZERO', commands: transformPath(bodyCommands, [[1, 0, -box.x], [0, 1, -box.y]])}],
  });
  const stripesBox = pathBox(stripeCommands);
  const stripes = createNode('VECTOR', {
    id: stripesId, parentId: id, name: 'Pattern', x: stripesBox.x - box.x, y: stripesBox.y - box.y, width: stripesBox.width, height: stripesBox.height,
    fills: [], strokes: [ink('#FFFFFF', 0.32)], strokeWeight: width * 0.78, strokeAlign: 'CENTER', strokeCap: 'NONE', dashPattern: [5, 7],
    vectorPaths: [{windingRule: 'NONZERO', commands: transformPath(stripeCommands, [[1, 0, -stripesBox.x], [0, 1, -stripesBox.y]])}],
  });
  // A printed tape keeps its picture plain: no stripes over it.
  return {id, pieces: options.image ? [{node: group, parent: ''}, {node: body, parent: id}] : [{node: group, parent: ''}, {node: body, parent: id}, {node: stripes, parent: id}]};
}

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────

export function createBoardSection(newId: NewId, options: {x: number; y: number; width: number; height: number; name: string; fill: string}): BoardBuild {
  const id = newId();
  // A thin border in the chip's colour (FigJam's board picture); a fill outside the palette has none.
  const chip = sectionChipOf(options.fill);
  const border = chip ? {strokes: [ink(chip, SECTION_BORDER_OPACITY)], strokeWeight: 1, strokeAlign: 'INSIDE' as const} : {};
  const node = createNode('SECTION', {id, name: options.name, x: options.x, y: options.y, width: options.width, height: options.height, fills: [ink(options.fill)], cornerRadius: 16, ...border});
  return {id, pieces: [{node, parent: ''}]};
}

// ── Link cards ───────────────────────────────────────────────────────────────────────────────────

/** What a link card shows (lane D's link preview: `GET /api/design-files/:id/link-preview`). */
export type LinkCardContent = {url: string; title: string | null; description: string | null; site: string | null; image: string | null};

const CARD_WIDTH = 320, CARD_PAD = 16, CARD_IMAGE = {width: 304, height: 160};

/** A pasted link as FigJam shows it: a card with the page's picture, its title (the link), a line or three of its description and
 *  its site. A group of ordinary layers, so the board picks and moves it whole and any editor or export draws it; the texts are cut
 *  with an ellipsis at their lines. */
export function createLinkCard(newId: NewId, options: {x: number; y: number; content: LinkCardContent}): BoardBuild {
  const {content} = options;
  const id = newId();
  const host = (() => {
    try {
      return new URL(content.url).host.replace(/^www\./, '');
    } catch {
      return content.url;
    }
  })();
  const pieces: BoardPiece[] = [];
  let y = content.image ? 8 + CARD_IMAGE.height + 12 : CARD_PAD;
  const textWidth = CARD_WIDTH - CARD_PAD * 2;
  const line = (characters: string, size: number, lines: number, color: string, weight = 400, link = false) => {
    const height = Math.round(size * 1.3) * lines;
    const props = textProps(characters, {size, weight, lineHeight: 130, resize: 'TRUNCATE'});
    const node = createNode('TEXT', {
      id: newId(), parentId: id, name: textName(characters, 'Link'), x: CARD_PAD, y, width: textWidth, height, fills: [ink(color)],
      text: {...props, maxLines: lines, style: link ? {...props.style, hyperlink: {type: 'URL', url: content.url}} : props.style},
    });
    y += height + 6;
    return node;
  };
  const texts = [
    line(content.title || host, 15, 2, BOARD_INK, 600, true),
    ...(content.description ? [line(content.description, 13, 3, '#5C5C5C')] : []),
    line(content.site || host, 12, 1, '#8C8C8C'),
  ];
  const height = y - 6 + CARD_PAD;
  const background = createNode('RECTANGLE', {
    id: newId(), parentId: id, name: 'Card', x: 0, y: 0, width: CARD_WIDTH, height, cornerRadius: 12, fills: [ink('#FFFFFF')],
    strokes: [ink('#E6E6E6')], strokeWeight: 1, strokeAlign: 'INSIDE', effects: STAMP_SHADOW,
  });
  const group = createNode('GROUP', {id, name: 'Link: ' + textName(content.title || host, host), x: options.x, y: options.y, width: CARD_WIDTH, height});
  pieces.push({node: group, parent: ''}, {node: background, parent: id});
  if (content.image) {
    pieces.push({node: createNode('RECTANGLE', {
      id: newId(), parentId: id, name: 'Picture', x: 8, y: 8, ...CARD_IMAGE, cornerRadius: 8,
      fills: [{type: 'IMAGE', imageRef: content.image, scaleMode: 'FILL', visible: true, opacity: 1, blendMode: 'NORMAL'}],
    }), parent: id});
  }
  for (const text of texts) pieces.push({node: text, parent: id});
  return {id, pieces};
}
