import type {NodeId, Vec} from '../types';

// "Board" (docs/board.md §Objects): what the layers of a board object are. A board object is made of ordinary layers (a sticky
// is an auto-layout frame with a text, a connector a group with a vector, a table frames of frames), so the renderer, export,
// co-editing and hit testing need nothing new. `SceneNode.board` names what a layer is and holds the few facts the layers
// cannot carry (a connector's ends, a stamp's id). Types only: safe to import from anywhere.

/** The shapes of "Shapes" (shared/design/board/shapes.ts draws each one). */
export type BoardShapeKind =
  | 'square' | 'rounded' | 'ellipse' | 'diamond' | 'triangle' | 'triangle-down' | 'parallelogram' | 'parallelogram-left'
  | 'trapezoid' | 'hexagon' | 'pentagon' | 'octagon' | 'star' | 'plus' | 'arrow-right' | 'arrow-left' | 'chevron'
  | 'cylinder' | 'document' | 'speech'
  // FigJam's other flowchart figures appended: older files never hold them.
  | 'cylinder-horizontal' | 'file' | 'folder' | 'documents' | 'predefined-process' | 'shield' | 'manual-input' | 'internal-storage'
  | 'or' | 'summing-junction';

/** Where a connector's end sits on an object: a side's middle, its centre, or the side facing the other end ('auto'). */
export type ConnectorMagnet = 'auto' | 'top' | 'right' | 'bottom' | 'left' | 'center';
/** A connector's end: on an object at a magnet, on an object anywhere (`at`: a point of the object's box in 0…1 fractions of its
 *  width and height; it follows the object), or a free point in the connector's parent space. */
export type ConnectorEnd = {node: NodeId; magnet: ConnectorMagnet} | {node: NodeId; at: Vec} | {x: number; y: number};
export type ConnectorLine = 'straight' | 'elbow' | 'curved';

/** The stamp wheel (E): FigJam's set, plus the author's own avatar. */
export type StampId = 'heart' | 'like' | 'dislike' | 'star' | 'question' | 'plus-one' | 'check' | 'fire' | 'avatar';

/** The marker tray: a stroke drawn with the marker, the highlighter (multiplied under what it crosses) or washi tape. */
export type StrokeTool = 'marker' | 'highlighter' | 'washi';

/** A layer inside a board object: the sticky's text and author line, the shape's figure and text, the connector's line and
 *  label, a table's rows and cells. */
export type BoardPart = 'text' | 'author' | 'shape' | 'line' | 'label' | 'row' | 'cell';

export type BoardMeta =
  /** An auto-layout frame (fill, shadow) holding the text (`part: 'text'`) and the author line (`part: 'author'`). Its font fits
   *  the note by itself (shared/design/board/normalize.ts). `wide`: the wide sticky (2:1). */
  | {kind: 'sticky'; wide?: boolean}
  /** A shape with text: an auto-layout frame holding the figure (`part: 'shape'`, absolutely placed, stretched) and the text
   *  (`part: 'text'`), centred; the frame grows when the text needs room. */
  | {kind: 'shape'; shape: BoardShapeKind}
  /** A group holding the line (`part: 'line'`, a vector with arrowheads) and an optional label (`part: 'label'`, a frame with a
   *  text). The line follows the objects its ends are on (normalize.ts). `labelAt`: where the label sits along the line, 0 (the
   *  start) to 1 (the end; absent: the middle). `points`: a reshaped connector's waypoints in its parent space, which the line
   *  passes through in order (connectors.ts `routeConnector`). */
  | {kind: 'connector'; start: ConnectorEnd; end: ConnectorEnd; line: ConnectorLine; labelAt?: number; points?: Vec[]}
  /** A round badge with an icon (or the author's initials for 'avatar'); `by`: who put it there. */
  | {kind: 'stamp'; stamp: StampId; by?: string}
  /** A drawn sticker (shared/design/board/stickers.ts), a group of vectors. */
  | {kind: 'sticker'; sticker: string}
  /** A table: a vertical auto-layout frame of rows (`part: 'row'`) of cells (`part: 'cell'`), each cell a frame with a text. */
  | {kind: 'table'}
  /** A marker, highlighter or washi-tape stroke: a vector (a group for washi tape). */
  | {kind: 'stroke'; tool: StrokeTool}
  /** A layer of a board object. A table's cell (`part: 'cell'`) may span columns and rows (`colSpan`, `rowSpan`: whole numbers
   *  from 1; absent: 1). */
  | {kind: 'part'; part: BoardPart; colSpan?: number; rowSpan?: number}
  /** A SECTION of the board: `hidden` hides what it holds (FigJam's "hide contents"), `backgroundLocked` locks the section itself
   *  but not what it holds ("lock background only"). */
  | {kind: 'section'; hidden?: boolean; backgroundLocked?: boolean};

export type BoardKind = BoardMeta['kind'];
