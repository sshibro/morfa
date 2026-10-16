import type {DesignDocument, NodeId, Vec} from '../../../shared/design/types';
import {worldBox, type Rect} from '../../../shared/design/geometry';
import {commonParent} from '../../../shared/design/tree';
import {formatNumber, selectionBounds} from './selection';

// Measurements (⌥ held, as in Figma): the distances from the selection to the layer under the
// pointer, or to the edges of its parent frame when the pointer is over nothing else. Red lines with
// the distance in a label; when the two boxes do not face each other, a dashed line extends the far
// box's edge to the measurement. Pure functions over rectangles; the canvas overlay draws them.

export type Measurement = {
  axis: 'x' | 'y';
  from: Vec;
  to: Vec;
  value: number;
  /** Dashed extensions of the target's edge up to the measurement line. */
  helpers: [Vec, Vec][];
};

type Axis = 0 | 1;
const lo = (r: Rect, axis: Axis) => (axis ? r.y : r.x);
const hi = (r: Rect, axis: Axis) => (axis ? r.y + r.height : r.x + r.width);
const mid = (r: Rect, axis: Axis) => (axis ? r.y + r.height / 2 : r.x + r.width / 2);
const overlapsOn = (a: Rect, b: Rect, axis: Axis) => lo(a, axis) < hi(b, axis) && lo(b, axis) < hi(a, axis);
const at = (axis: Axis, along: number, across: number): Vec => (axis ? {x: across, y: along} : {x: along, y: across});

/** Where across the boxes a measurement along `axis` runs: the middle of what both cover, or the
 *  middle of `a` when they do not overlap. */
function lineAcross(a: Rect, b: Rect, across: Axis): number {
  const top = Math.max(lo(a, across), lo(b, across)), bottom = Math.min(hi(a, across), hi(b, across));
  return top <= bottom ? (top + bottom) / 2 : mid(a, across);
}

/** A dashed line from where the measurement meets the edge `edge` of `r` to `r` itself, if it misses it. */
function helperFor(r: Rect, axis: Axis, edge: number, across: number): [Vec, Vec] | null {
  const other: Axis = axis ? 0 : 1;
  if (across >= lo(r, other) && across <= hi(r, other)) return null;
  const nearest = across < lo(r, other) ? lo(r, other) : hi(r, other);
  return [at(axis, edge, across), at(axis, edge, nearest)];
}

function measureAxis(a: Rect, b: Rect, axis: Axis, out: Measurement[]) {
  const other: Axis = axis ? 0 : 1;
  const name = axis ? 'y' : 'x';
  const across = lineAcross(a, b, other);
  const push = (from: number, to: number, edgeOfB: number[]) => {
    if (to - from <= 1e-6) return;
    const helpers: [Vec, Vec][] = [];
    for (const edge of edgeOfB) {
      const helper = helperFor(b, axis, edge, across);
      if (helper) helpers.push(helper);
    }
    out.push({axis: name, from: at(axis, from, across), to: at(axis, to, across), value: to - from, helpers});
  };
  if (hi(a, axis) <= lo(b, axis)) {
    push(hi(a, axis), lo(b, axis), [lo(b, axis)]);
  } else if (hi(b, axis) <= lo(a, axis)) {
    push(hi(b, axis), lo(a, axis), [hi(b, axis)]);
  } else if (overlapsOn(a, b, other)) {
    // Boxes that overlap (one inside the other, or crossing): the distances between the starts and
    // between the ends. Boxes apart on the other axis only measure that gap, as in Figma.
    push(Math.min(lo(a, axis), lo(b, axis)), Math.max(lo(a, axis), lo(b, axis)), [lo(b, axis)]);
    push(Math.min(hi(a, axis), hi(b, axis)), Math.max(hi(a, axis), hi(b, axis)), [hi(b, axis)]);
  }
}

/** Distances between box `a` (the selection) and box `b` (what is measured to), horizontal first. */
export function measureRects(a: Rect, b: Rect): Measurement[] {
  const out: Measurement[] = [];
  measureAxis(a, b, 0, out);
  measureAxis(a, b, 1, out);
  return out;
}

/** What ⌥ measures to: the hovered layer (unless it is selected), otherwise the selection's parent
 *  frame. Null with nothing selected or nothing to measure to. */
export function measureTarget(doc: DesignDocument, selection: readonly NodeId[], hoverId: NodeId | null): {from: Rect; to: Rect; targetId: NodeId} | null {
  const ids = selection.filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
  const from = selectionBounds(doc, ids);
  if (!from) return null;
  let targetId: NodeId | null = null;
  if (hoverId && doc.nodes[hoverId] && doc.nodes[hoverId].type !== 'PAGE' && !ids.includes(hoverId)) {
    targetId = hoverId;
  } else {
    const parent = commonParent(doc, ids);
    if (parent && doc.nodes[parent]?.type !== 'PAGE') targetId = parent;
  }
  if (!targetId) return null;
  return {from, to: worldBox(doc, targetId), targetId};
}

export const measurementLabel = (m: Measurement) => formatNumber(m.value);
