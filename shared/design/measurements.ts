import type {DesignDocument, Measurement, MeasurementSide, NodeId, Vec} from './types';
import {worldBox, type Rect} from './geometry';
import {pageIdOf} from './tree';
import {newId} from './defaults';

// "Measurement" (⇧M; Figma Dev Mode measurements, docs/design-tool.md §Dev annotations and measurements): a distance pinned
// between two parallel edges of layers, or across one layer. The page keeps them (`page.measurements`); the line, its
// number and the dashed extensions are worked out from the layers' boxes as they are now, so a measurement follows the
// layers when they move or resize. A rotated layer measures by its bounding box, as Figma's measurements do.

/** Dev Mode's measurement pink (shared/design/annotations.ts `ANNOTATION_COLORS.pink`), the same in both themes. Kept here
 *  so the measure tool, in the editor's first load, does not pull in the notes' property tables. */
export const MEASUREMENT_COLOR = '#E83D9A';

export type MeasurementAxis = 'x' | 'y';
export const sideAxis = (side: MeasurementSide): MeasurementAxis => (side === 'LEFT' || side === 'RIGHT' ? 'x' : 'y');
/** Two edges can be measured between when they run the same way. */
export const parallelSides = (a: MeasurementSide, b: MeasurementSide) => sideAxis(a) === sideAxis(b);
/** Where an edge of a box is on its axis. */
export const sideCoordinate = (box: Rect, side: MeasurementSide) =>
  side === 'LEFT' ? box.x : side === 'RIGHT' ? box.x + box.width : side === 'TOP' ? box.y : box.y + box.height;

export type MeasurementGeometry = {
  /** The measuring line, page space. */
  from: Vec;
  to: Vec;
  axis: MeasurementAxis;
  /** The distance, ≥ 0. */
  value: number;
  /** Dashed lines from an edge to the measuring line where the line runs past the layer. */
  extensions: {from: Vec; to: Vec}[];
};

/** Default placement of a new measurement: inside the start layer, across its middle. */
export const DEFAULT_MEASUREMENT_OFFSET: Measurement['offset'] = {type: 'INNER', relative: 0.5};

/** The line of a measurement on the page, or null when it cannot be drawn (a layer was removed or lives on another page,
 *  or the sides do not run the same way). */
export function measurementGeometry(doc: DesignDocument, pageId: NodeId, m: Measurement): MeasurementGeometry | null {
  const a = doc.nodes[m.start.nodeId], b = doc.nodes[m.end.nodeId];
  if (!a || !b || a.type === 'PAGE' || b.type === 'PAGE' || !parallelSides(m.start.side, m.end.side)) return null;
  if (pageIdOf(doc, a.id) !== pageId || pageIdOf(doc, b.id) !== pageId) return null;
  const start = worldBox(doc, a.id), end = worldBox(doc, b.id);
  const axis = sideAxis(m.start.side);
  const p = sideCoordinate(start, m.start.side), q = sideCoordinate(end, m.end.side);
  // Across the measured axis: inside the start layer at a fraction of its side, or outside it by a fixed distance.
  const lo = axis === 'x' ? start.y : start.x, span = axis === 'x' ? start.height : start.width;
  const across = m.offset.type === 'INNER'
    ? lo + Math.max(0, Math.min(1, m.offset.relative)) * span
    : m.offset.fixed >= 0 ? lo - m.offset.fixed : lo + span - m.offset.fixed;
  const point = (along: number): Vec => (axis === 'x' ? {x: along, y: across} : {x: across, y: along});
  const extensions: {from: Vec; to: Vec}[] = [];
  for (const [box, at] of [[start, p], [end, q]] as const) {
    const near = axis === 'x' ? box.y : box.x, far = near + (axis === 'x' ? box.height : box.width);
    if (across < near || across > far) {
      const edge = across < near ? near : far;
      extensions.push(axis === 'x' ? {from: {x: at, y: edge}, to: {x: at, y: across}} : {from: {x: edge, y: at}, to: {x: across, y: at}});
    }
  }
  return {from: point(p), to: point(q), axis, value: Math.abs(q - p), extensions};
}

/** What the measurement shows: its own text, or the distance (whole pixels unless the distance is fractional). */
export function measurementText(m: Pick<Measurement, 'freeText'>, value: number): string {
  if (m.freeText && m.freeText.trim()) return m.freeText.trim();
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace('.', ',');
}

/** The page's measurements that can be drawn, with their lines. */
export function pageMeasurements(doc: DesignDocument, pageId: NodeId): {measurement: Measurement; geometry: MeasurementGeometry}[] {
  const out: {measurement: Measurement; geometry: MeasurementGeometry}[] = [];
  for (const measurement of doc.nodes[pageId]?.measurements ?? []) {
    const geometry = measurementGeometry(doc, pageId, measurement);
    if (geometry) out.push({measurement, geometry});
  }
  return out;
}

/** The edge of `box` nearest `point` within `tolerance` (page units), or null. */
export function nearestSide(box: Rect, point: Vec, tolerance: number): MeasurementSide | null {
  const inX = point.x >= box.x - tolerance && point.x <= box.x + box.width + tolerance;
  const inY = point.y >= box.y - tolerance && point.y <= box.y + box.height + tolerance;
  const candidates: [MeasurementSide, number, boolean][] = [
    ['LEFT', Math.abs(point.x - box.x), inY],
    ['RIGHT', Math.abs(point.x - (box.x + box.width)), inY],
    ['TOP', Math.abs(point.y - box.y), inX],
    ['BOTTOM', Math.abs(point.y - (box.y + box.height)), inX],
  ];
  let best: MeasurementSide | null = null, distance = tolerance;
  for (const [side, d, within] of candidates) if (within && d <= distance) {
    best = side;
    distance = d;
  }
  return best;
}

/** The side of `box` parallel to `side` nearest `point` (where a measurement dragged from `side` ends). */
export function parallelSideNear(box: Rect, side: MeasurementSide, point: Vec): MeasurementSide {
  if (sideAxis(side) === 'x') return Math.abs(point.x - box.x) <= Math.abs(point.x - (box.x + box.width)) ? 'LEFT' : 'RIGHT';
  return Math.abs(point.y - box.y) <= Math.abs(point.y - (box.y + box.height)) ? 'TOP' : 'BOTTOM';
}

/** A new measurement's id: random (two people pinning at once keep both, shared/design/merge.ts) and unique on its page. */
export function newMeasurementId(existing: readonly Measurement[] = []): string {
  const taken = new Set(existing.map(m => m.id));
  for (;;) {
    const id = `m${newId()}`;
    if (!taken.has(id)) return id;
  }
}

/** The offset that puts the line of a measurement from `start` through `point` (page space). */
export function offsetThrough(doc: DesignDocument, start: Measurement['start'], point: Vec): Measurement['offset'] {
  const box = worldBox(doc, start.nodeId);
  const axis = sideAxis(start.side);
  const lo = axis === 'x' ? box.y : box.x, span = axis === 'x' ? box.height : box.width;
  const at = axis === 'x' ? point.y : point.x;
  if (at >= lo && at <= lo + span) return {type: 'INNER', relative: span > 0 ? Math.round(((at - lo) / span) * 1000) / 1000 : 0.5};
  return {type: 'OUTER', fixed: Math.round((at < lo ? lo - at : -(at - lo - span)) * 100) / 100};
}
