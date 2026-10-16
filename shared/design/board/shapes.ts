import type {NodeType, PathCommand, SceneNode, VectorPath} from '../types';
import type {BoardShapeKind} from './types';

// "Board": the figures of "Shapes" (docs/board.md §Objects). A square, a rounded square and an ellipse are a rectangle and an
// ellipse; every other figure is a vector whose path is written here in a 100 × 100 box and scaled to the figure's size, so a
// resized shape keeps its outline (a vector scales its paths when resized). The order is the shapes tray's.

export type BoardShapeSpec = {id: BoardShapeKind; label: string};

export const BOARD_SHAPES: readonly BoardShapeSpec[] = [
  {id: 'square', label: 'Square'},
  {id: 'ellipse', label: 'Ellipse'},
  {id: 'rounded', label: 'Rounded square'},
  {id: 'diamond', label: 'Diamond'},
  {id: 'triangle', label: 'Triangle'},
  {id: 'triangle-down', label: 'Triangle down'},
  {id: 'parallelogram', label: 'Parallelogram'},
  {id: 'parallelogram-left', label: 'Parallelogram left'},
  {id: 'trapezoid', label: 'Trapezoid'},
  {id: 'hexagon', label: 'Hexagon'},
  {id: 'pentagon', label: 'Pentagon'},
  {id: 'octagon', label: 'Octagon'},
  {id: 'star', label: 'Star'},
  {id: 'plus', label: 'Plus'},
  {id: 'arrow-right', label: 'Arrow right'},
  {id: 'arrow-left', label: 'Arrow left'},
  {id: 'chevron', label: 'Chevron'},
  {id: 'cylinder', label: 'Cylinder (database)'},
  {id: 'document', label: 'Document'},
  {id: 'speech', label: 'Speech bubble'},
];

/** FigJam's other flowchart figures: in the document's model, not in the tray (the board places them). */
export const BOARD_FLOWCHART_SHAPES: readonly BoardShapeSpec[] = [
  {id: 'cylinder-horizontal', label: 'Horizontal cylinder'},
  {id: 'file', label: 'File'},
  {id: 'folder', label: 'Folder'},
  {id: 'documents', label: 'Multiple documents'},
  {id: 'predefined-process', label: 'Predefined process'},
  {id: 'shield', label: 'Shield'},
  {id: 'manual-input', label: 'Manual input'},
  {id: 'internal-storage', label: 'Internal storage'},
  {id: 'or', label: 'OR'},
  {id: 'summing-junction', label: 'Summing junction'},
];

export const BOARD_SHAPE_LABELS = Object.fromEntries([...BOARD_SHAPES, ...BOARD_FLOWCHART_SHAPES].map(shape => [shape.id, shape.label])) as Record<BoardShapeKind, string>;

type Pt = [number, number];
const polygon = (points: Pt[]): PathCommand[] => [...points.map(([x, y], i) => ({type: i ? 'L' : 'M', x, y}) as PathCommand), {type: 'Z'}];
const regular = (count: number, rotate = -Math.PI / 2): Pt[] =>
  Array.from({length: count}, (_, i) => {
    const a = rotate + (i * 2 * Math.PI) / count;
    return [50 + 50 * Math.cos(a), 50 + 50 * Math.sin(a)] as Pt;
  });
/** A quarter-ellipse arc as a cubic (kappa), from (x0, y0) to (x1, y1) bending away from the corner (cx, cy). */
const K = 0.5523;
const line = (points: Pt[]): PathCommand[] => points.map(([x, y], i) => ({type: i ? 'L' : 'M', x, y}) as PathCommand);
/** The circle (an ellipse in the box) of centre (cx, cy) and radii rx, ry, as four cubics. */
const oval = (cx: number, cy: number, rx: number, ry: number): PathCommand[] => [
  {type: 'M', x: cx + rx, y: cy},
  {type: 'C', x1: cx + rx, y1: cy + ry * K, x2: cx + rx * K, y2: cy + ry, x: cx, y: cy + ry},
  {type: 'C', x1: cx - rx * K, y1: cy + ry, x2: cx - rx, y2: cy + ry * K, x: cx - rx, y: cy},
  {type: 'C', x1: cx - rx, y1: cy - ry * K, x2: cx - rx * K, y2: cy - ry, x: cx, y: cy - ry},
  {type: 'C', x1: cx + rx * K, y1: cy - ry, x2: cx + rx, y2: cy - ry * K, x: cx + rx, y: cy},
  {type: 'Z'},
];
/** A document's outline in the box (x0, y0)–(x1, y1): a wavy bottom edge. */
const documentOutline = (x0: number, y0: number, x1: number, y1: number): PathCommand[] => {
  const w = x1 - x0, h = y1 - y0;
  const p = (u: number, v: number) => ({x: x0 + (u / 100) * w, y: y0 + (v / 100) * h});
  return [
    {type: 'M', ...p(0, 0)},
    {type: 'L', ...p(100, 0)},
    {type: 'L', ...p(100, 86)},
    {type: 'C', x1: p(75, 74).x, y1: p(75, 74).y, x2: p(60, 100).x, y2: p(60, 100).y, ...p(34, 96)},
    {type: 'C', x1: p(18, 94).x, y1: p(18, 94).y, x2: p(8, 88).x, y2: p(8, 88).y, ...p(0, 86)},
    {type: 'Z'},
  ];
};

/** The figure's outline in a 100 × 100 box; null for figures drawn by a rectangle or an ellipse. */
function unitPaths(kind: BoardShapeKind): PathCommand[][] | null {
  switch (kind) {
    case 'square':
    case 'rounded':
    case 'ellipse':
      return null;
    case 'diamond':
      return [polygon([[50, 0], [100, 50], [50, 100], [0, 50]])];
    case 'triangle':
      return [polygon([[50, 0], [100, 100], [0, 100]])];
    case 'triangle-down':
      return [polygon([[0, 0], [100, 0], [50, 100]])];
    case 'parallelogram':
      return [polygon([[22, 0], [100, 0], [78, 100], [0, 100]])];
    case 'parallelogram-left':
      return [polygon([[0, 0], [78, 0], [100, 100], [22, 100]])];
    case 'trapezoid':
      return [polygon([[20, 0], [80, 0], [100, 100], [0, 100]])];
    case 'hexagon':
      return [polygon([[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]])];
    case 'pentagon': {
      const points = regular(5);
      // Stretched to the box: the regular pentagon is 95 % as tall as wide.
      const ys = points.map(p => p[1]), top = Math.min(...ys), bottom = Math.max(...ys);
      return [polygon(points.map(([x, y]) => [x, ((y - top) / (bottom - top)) * 100]))];
    }
    case 'octagon':
      return [polygon([[29, 0], [71, 0], [100, 29], [100, 71], [71, 100], [29, 100], [0, 71], [0, 29]])];
    case 'star': {
      const points: Pt[] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 20 : 50;
        points.push([50 + r * Math.cos(a), 52.5 + r * Math.sin(a) * 1.05]);
      }
      const ys = points.map(p => p[1]), top = Math.min(...ys), bottom = Math.max(...ys);
      return [polygon(points.map(([x, y]) => [x, ((y - top) / (bottom - top)) * 100]))];
    }
    case 'plus':
      return [polygon([[33, 0], [67, 0], [67, 33], [100, 33], [100, 67], [67, 67], [67, 100], [33, 100], [33, 67], [0, 67], [0, 33], [33, 33]])];
    case 'arrow-right':
      return [polygon([[0, 28], [62, 28], [62, 0], [100, 50], [62, 100], [62, 72], [0, 72]])];
    case 'arrow-left':
      return [polygon([[100, 28], [38, 28], [38, 0], [0, 50], [38, 100], [38, 72], [100, 72]])];
    case 'chevron':
      return [polygon([[0, 0], [72, 0], [100, 50], [72, 100], [0, 100], [28, 50]])];
    case 'cylinder': {
      // The body (its top and bottom are half-ellipses 12 high) and the rim of the top as a second, closed outline.
      const ry = 12;
      const body: PathCommand[] = [
        {type: 'M', x: 0, y: ry},
        {type: 'C', x1: 0, y1: ry - ry * K, x2: 50 - 50 * K, y2: 0, x: 50, y: 0},
        {type: 'C', x1: 50 + 50 * K, y1: 0, x2: 100, y2: ry - ry * K, x: 100, y: ry},
        {type: 'L', x: 100, y: 100 - ry},
        {type: 'C', x1: 100, y1: 100 - ry + ry * K, x2: 50 + 50 * K, y2: 100, x: 50, y: 100},
        {type: 'C', x1: 50 - 50 * K, y1: 100, x2: 0, y2: 100 - ry + ry * K, x: 0, y: 100 - ry},
        {type: 'Z'},
      ];
      const rim: PathCommand[] = [
        {type: 'M', x: 0, y: ry},
        {type: 'C', x1: 0, y1: ry + ry * K, x2: 50 - 50 * K, y2: 2 * ry, x: 50, y: 2 * ry},
        {type: 'C', x1: 50 + 50 * K, y1: 2 * ry, x2: 100, y2: ry + ry * K, x: 100, y: ry},
      ];
      return [body, rim];
    }
    case 'document':
      return [[
        {type: 'M', x: 0, y: 0},
        {type: 'L', x: 100, y: 0},
        {type: 'L', x: 100, y: 86},
        {type: 'C', x1: 75, y1: 74, x2: 60, y2: 100, x: 34, y: 96},
        {type: 'C', x1: 18, y1: 94, x2: 8, y2: 88, x: 0, y: 86},
        {type: 'Z'},
      ]];
    case 'cylinder-horizontal': {
      // The cylinder lying down: its ends are half-ellipses 12 wide, the rim of the right end a second outline.
      const rx = 12;
      const body: PathCommand[] = [
        {type: 'M', x: rx, y: 0},
        {type: 'L', x: 100 - rx, y: 0},
        {type: 'C', x1: 100 - rx + rx * K, y1: 0, x2: 100, y2: 50 - 50 * K, x: 100, y: 50},
        {type: 'C', x1: 100, y1: 50 + 50 * K, x2: 100 - rx + rx * K, y2: 100, x: 100 - rx, y: 100},
        {type: 'L', x: rx, y: 100},
        {type: 'C', x1: rx - rx * K, y1: 100, x2: 0, y2: 50 + 50 * K, x: 0, y: 50},
        {type: 'C', x1: 0, y1: 50 - 50 * K, x2: rx - rx * K, y2: 0, x: rx, y: 0},
        {type: 'Z'},
      ];
      const rim: PathCommand[] = [
        {type: 'M', x: 100 - rx, y: 0},
        {type: 'C', x1: 100 - rx - rx * K, y1: 0, x2: 100 - 2 * rx, y2: 50 - 50 * K, x: 100 - 2 * rx, y: 50},
        {type: 'C', x1: 100 - 2 * rx, y1: 50 + 50 * K, x2: 100 - rx - rx * K, y2: 100, x: 100 - rx, y: 100},
      ];
      return [body, rim];
    }
    case 'file':
      // A page with its top right corner folded.
      return [polygon([[0, 0], [72, 0], [100, 28], [100, 100], [0, 100]]), line([[72, 0], [72, 28], [100, 28]])];
    case 'folder':
      return [polygon([[0, 6], [38, 6], [46, 18], [100, 18], [100, 100], [0, 100]])];
    case 'documents':
      // Two documents behind the front one, each showing its top and right edges.
      return [
        line([[16, 16], [16, 0], [100, 0], [100, 72]]),
        line([[8, 24], [8, 8], [92, 8], [92, 80]]),
        documentOutline(0, 16, 84, 100),
      ];
    case 'predefined-process':
      return [polygon([[0, 0], [100, 0], [100, 100], [0, 100]]), line([[12, 0], [12, 100]]), line([[88, 0], [88, 100]])];
    case 'shield':
      return [[
        {type: 'M', x: 0, y: 0},
        {type: 'L', x: 100, y: 0},
        {type: 'L', x: 100, y: 45},
        {type: 'C', x1: 100, y1: 75, x2: 75, y2: 92, x: 50, y: 100},
        {type: 'C', x1: 25, y1: 92, x2: 0, y2: 75, x: 0, y: 45},
        {type: 'Z'},
      ]];
    case 'manual-input':
      return [polygon([[0, 25], [100, 0], [100, 100], [0, 100]])];
    case 'internal-storage':
      return [polygon([[0, 0], [100, 0], [100, 100], [0, 100]]), line([[0, 16], [100, 16]]), line([[16, 0], [16, 100]])];
    case 'or':
      return [oval(50, 50, 50, 50), line([[50, 0], [50, 100]]), line([[0, 50], [100, 50]])];
    case 'summing-junction': {
      const d = 50 * Math.SQRT1_2;
      return [oval(50, 50, 50, 50), line([[50 - d, 50 - d], [50 + d, 50 + d]]), line([[50 + d, 50 - d], [50 - d, 50 + d]])];
    }
    case 'speech':
      return [[
        {type: 'M', x: 10, y: 0},
        {type: 'L', x: 90, y: 0},
        {type: 'Q', x1: 100, y1: 0, x: 100, y: 10},
        {type: 'L', x: 100, y: 70},
        {type: 'Q', x1: 100, y1: 80, x: 90, y: 80},
        {type: 'L', x: 40, y: 80},
        {type: 'L', x: 18, y: 100},
        {type: 'L', x: 22, y: 80},
        {type: 'L', x: 10, y: 80},
        {type: 'Q', x1: 0, y1: 80, x: 0, y: 70},
        {type: 'L', x: 0, y: 10},
        {type: 'Q', x1: 0, y1: 0, x: 10, y: 0},
        {type: 'Z'},
      ]];
  }
}

const scaleCommand = (command: PathCommand, sx: number, sy: number): PathCommand => {
  switch (command.type) {
    case 'M':
    case 'L':
      return {type: command.type, x: command.x * sx, y: command.y * sy};
    case 'C':
      return {type: 'C', x1: command.x1 * sx, y1: command.y1 * sy, x2: command.x2 * sx, y2: command.y2 * sy, x: command.x * sx, y: command.y * sy};
    case 'Q':
      return {type: 'Q', x1: command.x1 * sx, y1: command.y1 * sy, x: command.x * sx, y: command.y * sy};
    case 'Z':
      return command;
  }
};

/** The figure's layer for a box of `width` × `height`: its type and the fields that draw it. */
export function boardShapeGeometry(kind: BoardShapeKind, width: number, height: number): {type: NodeType; fields: Partial<SceneNode>} {
  if (kind === 'ellipse') return {type: 'ELLIPSE', fields: {}};
  if (kind === 'square') return {type: 'RECTANGLE', fields: {cornerRadius: 0}};
  if (kind === 'rounded') return {type: 'RECTANGLE', fields: {cornerRadius: Math.round(Math.min(width, height) * 0.12)}};
  const sx = width / 100, sy = height / 100;
  const vectorPaths: VectorPath[] = unitPaths(kind)!.map(commands => ({windingRule: 'NONZERO', commands: commands.map(command => scaleCommand(command, sx, sy))}));
  return {type: 'VECTOR', fields: {vectorPaths, strokeJoin: 'ROUND'}};
}

/** Where the text of a figure fits, as insets of the box in fractions (a triangle's text sits low and narrow). */
export function boardShapeTextInsets(kind: BoardShapeKind): {top: number; right: number; bottom: number; left: number} {
  switch (kind) {
    case 'diamond':
      return {top: 0.25, right: 0.2, bottom: 0.25, left: 0.2};
    case 'triangle':
      return {top: 0.45, right: 0.22, bottom: 0.08, left: 0.22};
    case 'triangle-down':
      return {top: 0.08, right: 0.22, bottom: 0.45, left: 0.22};
    case 'parallelogram':
    case 'parallelogram-left':
    case 'trapezoid':
      return {top: 0.1, right: 0.2, bottom: 0.1, left: 0.2};
    case 'star':
      return {top: 0.35, right: 0.3, bottom: 0.25, left: 0.3};
    case 'plus':
      return {top: 0.33, right: 0.1, bottom: 0.33, left: 0.1};
    case 'arrow-right':
      return {top: 0.3, right: 0.3, bottom: 0.3, left: 0.06};
    case 'arrow-left':
      return {top: 0.3, right: 0.06, bottom: 0.3, left: 0.3};
    case 'chevron':
      return {top: 0.1, right: 0.25, bottom: 0.1, left: 0.3};
    case 'cylinder':
      return {top: 0.26, right: 0.08, bottom: 0.14, left: 0.08};
    case 'document':
      return {top: 0.08, right: 0.08, bottom: 0.2, left: 0.08};
    case 'speech':
      return {top: 0.08, right: 0.08, bottom: 0.26, left: 0.08};
    case 'cylinder-horizontal':
      return {top: 0.08, right: 0.26, bottom: 0.08, left: 0.14};
    case 'file':
      return {top: 0.28, right: 0.08, bottom: 0.08, left: 0.08};
    case 'folder':
      return {top: 0.24, right: 0.08, bottom: 0.08, left: 0.08};
    case 'documents':
      return {top: 0.22, right: 0.22, bottom: 0.2, left: 0.06};
    case 'predefined-process':
      return {top: 0.08, right: 0.16, bottom: 0.08, left: 0.16};
    case 'shield':
      return {top: 0.08, right: 0.12, bottom: 0.3, left: 0.12};
    case 'manual-input':
      return {top: 0.3, right: 0.08, bottom: 0.08, left: 0.08};
    case 'internal-storage':
      return {top: 0.2, right: 0.08, bottom: 0.08, left: 0.2};
    case 'or':
    case 'summing-junction':
      return {top: 0.18, right: 0.18, bottom: 0.18, left: 0.18};
    case 'ellipse':
      return {top: 0.15, right: 0.15, bottom: 0.15, left: 0.15};
    default:
      return {top: 0.08, right: 0.08, bottom: 0.08, left: 0.08};
  }
}
