import type {NodeId, Paint, SceneNode, StrokeMarker, TextProps, TextStyle} from '../../../shared/design/types';
import {createNode, newId, solid} from '../../../shared/design/defaults';
import {boardObjectOf, childPart, isConnector, isShapeWithText, isSticky, isStroke, partOf} from '../../../shared/design/board/model';
import {BOARD_SHAPE_LABELS, boardShapeGeometry} from '../../../shared/design/board/shapes';
import {hexToRgb, inkOn, rgbToHex, sectionChipOf, SECTION_BORDER_OPACITY, stickyColor} from '../../../shared/design/board/palette';
import {BOARD_FONT, HANDWRITING_FONT} from '../../../shared/design/board/create';
import type {BoardShapeKind, ConnectorLine} from '../../../shared/design/board/types';
import {userUpdate} from '../engine/user-edit';
import {rememberConnectorLook} from './state';
import type {Transaction} from '../../../shared/design/transaction';
import type {DesignStore} from '../engine/store';

// The edits the board's context toolbar makes (docs/board.md §Context toolbar), each one undo step through the hand-edit door
// (`userUpdate`). They act on board objects whatever part of them is selected or being typed into.

export type BoardSelectionKind = 'sticky' | 'shape' | 'connector' | 'text' | 'section' | 'table' | 'stamp' | 'sticker' | 'stroke' | 'other';

type Get = (id: NodeId | null | undefined) => SceneNode | undefined;
const getter = (store: DesignStore): Get => id => (id ? store.getState().doc.nodes[id] : undefined);

export function kindOf(node: SceneNode): BoardSelectionKind {
  switch (node.board?.kind) {
    case 'sticky': case 'shape': case 'connector': case 'table': case 'stamp': case 'sticker': case 'stroke':
      return node.board.kind;
  }
  if (node.type === 'TEXT') return 'text';
  if (node.type === 'SECTION') return 'section';
  return 'other';
}

/** The objects the toolbar acts on: the selection, or the object whose text is being typed into. */
export function targetObjects(store: DesignStore): SceneNode[] {
  const state = store.getState();
  const get = getter(store);
  const ids = state.editing?.kind === 'text' ? [state.editing.id] : state.selection;
  const out = new Map<NodeId, SceneNode>();
  for (const id of ids) {
    const node = get(id);
    if (!node) continue;
    const object = boardObjectOf(get, id) ?? (partOf(node) === 'text' ? null : node);
    if (object) out.set(object.id, object);
    else if (node.type === 'TEXT') out.set(node.id, node);
  }
  return [...out.values()];
}

/** The texts an object's type controls change: its own text, its label's, a sticky's or a shape's. */
function textsOf(get: Get, object: SceneNode): SceneNode[] {
  if (object.type === 'TEXT') return [object];
  if (isSticky(object) || isShapeWithText(object)) return [childPart(get, object, 'text')].filter((node): node is SceneNode => !!node?.text);
  if (isConnector(object)) {
    const label = childPart(get, object, 'label');
    return [childPart(get, label, 'text')].filter((node): node is SceneNode => !!node?.text);
  }
  if (object.board?.kind === 'table') {
    const out: SceneNode[] = [];
    for (const rowId of object.children ?? []) for (const cellId of get(rowId)?.children ?? []) {
      const text = childPart(get, get(cellId), 'text');
      if (text?.text) out.push(text);
    }
    return out;
  }
  return [];
}

/** A text's base style changed, and the same fields taken out of its runs (so the change shows everywhere in it). */
export function restyle(text: TextProps, style: Partial<TextStyle>): TextProps {
  const keys = Object.keys(style) as (keyof TextStyle)[];
  const runs = text.runs.map(run => {
    if (!keys.some(key => key in run.style)) return run;
    const next = {...run.style};
    for (const key of keys) delete next[key];
    return {...run, style: next};
  });
  return {...text, runs, style: {...text.style, ...style}};
}

const solidHex = (paints: readonly Paint[]): string | null => {
  const paint = paints.find(entry => entry.type === 'SOLID' && entry.visible);
  return paint?.type === 'SOLID' ? rgbToHex(paint.color) : null;
};

/** The colour an object shows (its paper, fill, line or ink), for the toolbar's swatch. */
export function colorOf(get: Get, object: SceneNode): string | null {
  if (isSticky(object) || object.type === 'SECTION' || object.board?.kind === 'stamp') return solidHex(object.fills);
  if (isShapeWithText(object)) return solidHex(childPart(get, object, 'shape')?.fills ?? []);
  if (isConnector(object)) return solidHex(childPart(get, object, 'line')?.strokes ?? []);
  if (isStroke(object)) return object.board?.kind === 'stroke' && object.board.tool === 'washi' ? solidHex(get(object.children?.[0])?.fills ?? []) : solidHex(object.strokes);
  if (object.type === 'TEXT') return solidHex(object.fills);
  return null;
}

/** Recolours objects: a sticky's paper (by swatch id or hex), a shape's fill, a connector's line, a stroke's ink, a text's ink. Text
 *  on a recoloured sticky or shape keeps contrast (dark on light, white on dark) unless its colour was picked. */
export function setColor(store: DesignStore, objects: readonly SceneNode[], hex: string, label = 'Color') {
  store.transact(label, tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    const paint = solid(hexToRgb(hex));
    for (const object of objects) {
      if (isSticky(object) || isShapeWithText(object)) {
        const target = isSticky(object) ? object : childPart(get, object, 'shape');
        if (!target) continue;
        const before = solidHex(target.fills);
        userUpdate(tx, target.id, {fills: [paint]});
        const text = childPart(get, object, 'text');
        const ink = text && solidHex(text.fills);
        if (text && (!ink || !before || ink === inkOn(hexToRgb(before)).toUpperCase())) userUpdate(tx, text.id, {fills: [solid(hexToRgb(inkOn(paint.color)))]});
      } else if (isConnector(object)) {
        const line = childPart(get, object, 'line');
        if (line) userUpdate(tx, line.id, {strokes: [paint]});
        rememberConnectorLook({color: hex});
        // The label follows: on the new colour when it has a background, in the new colour when it has none.
        paintLabel(tx, get, object, hex, labelBackgroundOf(get, object) ?? false);
      } else if (isStroke(object)) {
        const meta = object.board?.kind === 'stroke' ? object.board : null;
        if (meta?.tool === 'washi') {
          const body = get(object.children?.[0]);
          if (body) userUpdate(tx, body.id, {fills: [solid(paint.color, 0.88)]});
        } else userUpdate(tx, object.id, {strokes: [solid(paint.color, meta?.tool === 'highlighter' ? 0.8 : 1)]});
      } else if (object.type === 'TEXT') userUpdate(tx, object.id, {fills: [paint]});
      else if (object.type === 'SECTION') {
        // The border follows the colour (FigJam's board picture): the new chip colour, light, inside the edge.
        const chip = sectionChipOf(hex);
        userUpdate(tx, object.id, chip ? {fills: [paint], strokes: [solid(hexToRgb(chip), SECTION_BORDER_OPACITY)], strokeWeight: 1, strokeAlign: 'INSIDE'} : {fills: [paint]});
      } else if (object.board?.kind === 'stamp') userUpdate(tx, object.id, {fills: [paint]});
    }
  });
}

/** A table's cells: every cell, or only `only` (the cell being typed in) when given. */
export function tableCells(get: Get, table: SceneNode, only?: NodeId | null): SceneNode[] {
  const cells: SceneNode[] = [];
  for (const rowId of table.children ?? []) for (const cellId of get(rowId)?.children ?? []) {
    const cell = get(cellId);
    if (cell && partOf(cell) === 'cell' && (!only || cell.id === only)) cells.push(cell);
  }
  return cells;
}

/** FigJam's cell background (help.figma.com "Tables in FigJam"): the cells' fill, their text kept readable on it. */
export function setCellColor(store: DesignStore, cells: readonly SceneNode[], hex: string) {
  store.transact('Cell color', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    const paint = solid(hexToRgb(hex));
    for (const cell of cells) {
      userUpdate(tx, cell.id, {fills: [paint]});
      const text = childPart(get, get(cell.id), 'text');
      if (text) userUpdate(tx, text.id, {fills: [solid(hexToRgb(inkOn(paint.color)))]});
    }
  });
}

export const cellColorOf = (cells: readonly SceneNode[]) => (cells[0] ? solidHex(cells[0].fills) : null);

/** A section's switches (FigJam's "Hide section", "Lock background only"; lane G's `{kind: 'section', hidden, backgroundLocked}`). */
export const sectionFlags = (object: SceneNode) => (object.type === 'SECTION' && object.board?.kind === 'section' ? object.board : {kind: 'section' as const});

export function setSectionFlag(store: DesignStore, objects: readonly SceneNode[], flag: 'hidden' | 'backgroundLocked', on: boolean) {
  const label = flag === 'hidden' ? (on ? 'Hide section contents' : 'Show section contents') : on ? 'Lock section background' : 'Unlock section background';
  store.transact(label, tx => {
    for (const object of objects) {
      const node = tx.get(object.id);
      if (node?.type !== 'SECTION') continue;
      const {[flag]: _old, ...rest} = sectionFlags(node);
      userUpdate(tx, node.id, {board: on ? {...rest, kind: 'section', [flag]: true} : {...rest, kind: 'section'}});
    }
  });
}

/** FigJam's wide sticky: twice as wide (480 × 240), and back. The note keeps its top-left corner; its text fits again. */
export function setStickyWide(store: DesignStore, objects: readonly SceneNode[], wide: boolean) {
  store.transact(wide ? 'Wide sticky' : 'Regular sticky', tx => {
    for (const object of objects) {
      const node = tx.get(object.id);
      if (node?.board?.kind !== 'sticky' || !!node.board.wide === wide) continue;
      const side = Math.min(node.width / (node.board.wide ? 2 : 1), node.minHeight ?? node.height);
      userUpdate(tx, node.id, {width: Math.round(wide ? side * 2 : side), board: wide ? {kind: 'sticky', wide: true} : {kind: 'sticky'}});
    }
  });
}
export const isWideSticky = (object: SceneNode) => object.board?.kind === 'sticky' && !!object.board.wide;

export const setStickyColor = (store: DesignStore, objects: readonly SceneNode[], id: string) => setColor(store, objects.filter(isSticky), stickyColor(id).hex, 'Sticky color');

/** Outline of shapes: a colour or none. */
export function setShapeStroke(store: DesignStore, objects: readonly SceneNode[], hex: string | null) {
  store.transact('Stroke', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) {
      const figure = isShapeWithText(object) ? childPart(get, object, 'shape') : null;
      if (figure) userUpdate(tx, figure.id, {strokes: hex ? [solid(hexToRgb(hex))] : [], strokeWeight: 2});
    }
  });
}

/** FigJam's dashed or solid outline for shapes (help.figma.com "Visualize information using shapes with text"). */
export function setShapeDashed(store: DesignStore, objects: readonly SceneNode[], dashed: boolean) {
  store.transact(dashed ? 'Dashed stroke' : 'Solid stroke', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) {
      const figure = isShapeWithText(object) ? childPart(get, object, 'shape') : null;
      if (figure) userUpdate(tx, figure.id, {dashPattern: dashed ? [6, 4] : []});
    }
  });
}
export const isShapeDashed = (get: Get, object: SceneNode) => (childPart(get, object, 'shape')?.dashPattern.length ?? 0) > 0;

/** Another figure for shapes: the figure layer is made again in the new kind, with its paints. */
export function setShapeKind(store: DesignStore, objects: readonly SceneNode[], shape: BoardShapeKind) {
  store.transact('Shape', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) {
      if (!isShapeWithText(object)) continue;
      const figure = childPart(get, object, 'shape');
      if (!figure) continue;
      const geometry = boardShapeGeometry(shape, figure.width, figure.height);
      const index = object.children!.indexOf(figure.id);
      tx.remove(figure.id);
      tx.create(createNode(geometry.type, {
        id: newId(), parentId: object.id, name: figure.name, x: figure.x, y: figure.y, width: figure.width, height: figure.height,
        fills: figure.fills, strokes: figure.strokes, strokeWeight: figure.strokeWeight, strokeAlign: figure.strokeAlign, dashPattern: figure.dashPattern,
        layoutPositioning: 'ABSOLUTE', constraints: figure.constraints, board: figure.board, ...geometry.fields,
      }), object.id, index);
      tx.update(object.id, {board: {kind: 'shape', shape}, name: shapeName(shape, object.name)});
    }
  });
}
const shapeName = (shape: BoardShapeKind, current: string) => (Object.values(BOARD_SHAPE_LABELS).includes(current) ? BOARD_SHAPE_LABELS[shape] : current);

export type TextSize = 's' | 'm' | 'l' | 'xl';
export const TEXT_SIZES: Record<'text' | 'shape', Record<TextSize, number>> = {
  text: {s: 16, m: 24, l: 40, xl: 64},
  shape: {s: 14, m: 18, l: 28, xl: 40},
};
export const TEXT_SIZE_LABELS: Record<TextSize, string> = {s: 'S', m: 'M', l: 'L', xl: 'XL'};

/** The size step a text shows (or null between steps). */
export function textSizeOf(get: Get, object: SceneNode): TextSize | null {
  const text = textsOf(get, object)[0];
  if (!text?.text) return null;
  const table = object.type === 'TEXT' ? TEXT_SIZES.text : TEXT_SIZES.shape;
  return (Object.keys(table) as TextSize[]).find(size => table[size] === text.text!.style.fontSize) ?? null;
}

export function setTextSize(store: DesignStore, objects: readonly SceneNode[], size: TextSize) {
  store.transact('Text size', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) {
      // A sticky's text sizes itself to the note.
      if (isSticky(object)) continue;
      const value = (object.type === 'TEXT' ? TEXT_SIZES.text : TEXT_SIZES.shape)[size];
      for (const text of textsOf(get, object)) userUpdate(tx, text.id, {text: restyle(text.text!, {fontSize: value})});
    }
  });
}

export const isHandwriting = (get: Get, object: SceneNode) => textsOf(get, object)[0]?.text?.style.fontFamily === HANDWRITING_FONT;

export function setHandwriting(store: DesignStore, objects: readonly SceneNode[], on: boolean) {
  store.transact(on ? 'Handwriting font' : 'Regular font', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) for (const text of textsOf(get, object)) {
      userUpdate(tx, text.id, {text: restyle(text.text!, {fontFamily: on ? HANDWRITING_FONT : BOARD_FONT, fontWeight: on ? 500 : 400})});
    }
  });
}

export function toggleBold(store: DesignStore, objects: readonly SceneNode[]) {
  const get = getter(store);
  const bold = objects.some(object => (textsOf(get, object)[0]?.text?.style.fontWeight ?? 400) < 600);
  store.transact(bold ? 'Bold' : 'Regular weight', tx => {
    const read: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) for (const text of textsOf(read, object)) userUpdate(tx, text.id, {text: restyle(text.text!, {fontWeight: bold ? 700 : text.text!.style.fontFamily === HANDWRITING_FONT ? 500 : 400})});
  });
}

export function setAlign(store: DesignStore, objects: readonly SceneNode[], align: TextProps['textAlignHorizontal']) {
  store.transact('Text alignment', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) for (const text of textsOf(get, object)) userUpdate(tx, text.id, {text: {...text.text!, textAlignHorizontal: align}});
  });
}

export const alignOf = (get: Get, object: SceneNode) => textsOf(get, object)[0]?.text?.textAlignHorizontal ?? null;

// ── Connectors ─────────────────────────────────────────────────────────────────────────────────

export const lineOf = (object: SceneNode): ConnectorLine | null => (object.board?.kind === 'connector' ? object.board.line : null);

export function setConnectorLine(store: DesignStore, objects: readonly SceneNode[], line: ConnectorLine) {
  store.transact('Connector type', tx => {
    for (const object of objects) {
      const node = tx.get(object.id);
      if (node?.board?.kind === 'connector') tx.update(object.id, {board: {...node.board, line}});
    }
  });
}

/** FigJam's five start and end point styles (help.figma.com "Create diagrams and flows with connectors"): none, a line arrow, a
 *  solid arrow, a triangle pointing in, a diamond. */
export const END_STYLES: readonly {marker: StrokeMarker; label: string}[] = [
  {marker: 'NONE', label: 'None'},
  {marker: 'LINE_ARROW', label: 'Arrow'},
  {marker: 'TRIANGLE_ARROW', label: 'Filled arrow'},
  {marker: 'REVERSED_TRIANGLE', label: 'Triangle'},
  {marker: 'DIAMOND', label: 'Diamond'},
];
export type ConnectorEndSide = 'start' | 'end';

/** The style of a connector's start or end point. */
export function endStyleOf(get: Get, object: SceneNode, side: ConnectorEndSide): StrokeMarker | null {
  const line = childPart(get, object, 'line');
  if (!line) return null;
  return (side === 'start' ? line.strokeStartMarker : line.strokeEndMarker) ?? 'NONE';
}

export function setEndStyle(store: DesignStore, objects: readonly SceneNode[], side: ConnectorEndSide, marker: StrokeMarker) {
  store.transact(side === 'start' ? 'Start point' : 'End point', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) {
      const line = childPart(get, object, 'line');
      if (line) userUpdate(tx, line.id, side === 'start' ? {strokeStartMarker: marker} : {strokeEndMarker: marker});
    }
    rememberConnectorLook(side === 'start' ? {startMarker: marker} : {endMarker: marker});
  });
}

const WHITE = '#FFFFFF';

/** Whether a connector's label sits on the connector's colour (true) or on the canvas (false); null without a label. */
export function labelBackgroundOf(get: Get, object: SceneNode): boolean | null {
  const label = childPart(get, object, 'label');
  if (!label) return null;
  const fill = solidHex(label.fills);
  return !!fill && fill.toUpperCase() !== WHITE;
}

function paintLabel(tx: Transaction, get: Get, object: SceneNode, lineHex: string, background: boolean) {
  const label = childPart(get, object, 'label');
  const text = label && childPart(get, label, 'text');
  if (!label || !text) return;
  const line = hexToRgb(lineHex);
  userUpdate(tx, label.id, {fills: [solid(background ? line : hexToRgb(WHITE))]});
  userUpdate(tx, text.id, {fills: [solid(background ? hexToRgb(inkOn(line)) : line)]});
}

/** FigJam's "text background" for a connector's label: on, the label is a chip in the connector's colour with text that reads on it;
 *  off (the default), the text is in the connector's colour on the canvas. */
export function setLabelBackground(store: DesignStore, objects: readonly SceneNode[], background: boolean) {
  store.transact(background ? 'Label background' : 'No label background', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) {
      const line = childPart(get, object, 'line');
      const hex = line && solidHex(line.strokes);
      if (hex) paintLabel(tx, get, object, hex, background);
    }
  });
}

export const CONNECTOR_WEIGHTS = {thin: 2, medium: 3, thick: 6} as const;
export type ConnectorWeight = keyof typeof CONNECTOR_WEIGHTS;
export function weightOf(get: Get, object: SceneNode): ConnectorWeight | null {
  const line = childPart(get, object, 'line');
  if (!line) return null;
  return (Object.keys(CONNECTOR_WEIGHTS) as ConnectorWeight[]).find(key => CONNECTOR_WEIGHTS[key] === line.strokeWeight) ?? null;
}

export function setConnectorStyle(store: DesignStore, objects: readonly SceneNode[], style: {weight?: ConnectorWeight; dashed?: boolean}) {
  store.transact('Connector line', tx => {
    const get: Get = id => (id ? tx.get(id) : undefined);
    for (const object of objects) {
      const line = childPart(get, object, 'line');
      if (!line) continue;
      userUpdate(tx, line.id, {
        ...(style.weight ? {strokeWeight: CONNECTOR_WEIGHTS[style.weight]} : {}),
        ...(style.dashed !== undefined ? {dashPattern: style.dashed ? [line.strokeWeight * 2.5, line.strokeWeight * 2.5] : []} : {}),
      });
    }
  });
  rememberConnectorLook({...(style.weight ? {weight: CONNECTOR_WEIGHTS[style.weight]} : {}), ...(style.dashed === undefined ? {} : {dashed: style.dashed})});
}

export const isDashed = (get: Get, object: SceneNode) => (childPart(get, object, 'line')?.dashPattern.length ?? 0) > 0;

/** Locks or unlocks objects (FigJam's lock on the toolbar). */
export function setLocked(store: DesignStore, objects: readonly SceneNode[], locked: boolean) {
  store.transact(locked ? 'Lock' : 'Unlock', tx => {
    for (const object of objects) userUpdate(tx, object.id, {locked});
  }, locked ? {select: []} : {});
}
