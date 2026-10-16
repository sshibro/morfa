import type {DesignDocument, NodeId, Vec} from '../../../shared/design/types';
import {rectsIntersect, worldBox, type Rect} from '../../../shared/design/geometry';
import {childrenOf, frameAtPoint, type SpatialIndex} from '../../../shared/design/tree';
import {OVERLAY_COLORS, type OverlayItem} from './overlay';
import {formatNumber} from './selection';
import {currentViewport, type DesignStore} from './store';
import type {SnapContext, SnapHook, SnapResult} from './tools/types';
import {visiblePageRect} from './viewport';

// Smart guides (docs/design-tool.md §Client engine): where a moved, resized or drawn layer lands.
// Edges and centre lines snap to the layers around it (siblings in the same parent, and the
// parent frame's own edges), to the ruler guides, and to equal spacing in a row or a column; what
// it snapped to is shown as red guides with the distance to the layer they line up with, and equal
// gaps as pink badges, as in Figma. Snapping reaches 5 screen px, ⌘ held turns it off (the tools
// check that), and positions land on whole pixels when "Snap to pixel grid" is on.
//
// Only layers visible on screen take part: the candidates are read once per drag from the spatial
// index (never by walking the page), and a pointer move compares against that short list.

export const SNAP_THRESHOLD_PX = 5;
/** Equal-spacing guides and their gap badges. */
export const SPACING_COLOR = '#F849C1';
/** Two values closer than this (page px) count as lined up when guides are drawn. */
const SAME = 0.01;
/** A row longer than this is not searched for equal gaps (the guides would be noise anyway). */
const MAX_ROW = 200;

/** What a snap can land on, in page space. */
export type SnapTargets = {
  /** Boxes of the layers around: their edges, centres and gaps. */
  rects: Rect[];
  /** Containers the layer sits in: their edges and centre lines, never a spacing neighbour. */
  frames: Rect[];
  /** Ruler guides: x of the vertical ones, y of the horizontal ones. */
  guidesX: number[];
  guidesY: number[];
};

export const NO_TARGETS: SnapTargets = {rects: [], frames: [], guidesX: [], guidesY: []};

/** What tools may add to the engine's snap context: the parent a new layer is drawn into, and which
 *  axes a dragged handle moves along (a side handle moves one). */
export type SmartSnapContext = SnapContext & {parentId?: NodeId | null; axes?: {x: boolean; y: boolean}};

export type SnapOptions = {
  /** Page px (the screen threshold divided by the zoom). */
  threshold: number;
  /** For sizes of guide decorations (crosses, ticks) in screen px. Default 1. */
  zoom?: number;
  /** Snap to equal gaps between neighbours. Default true. */
  spacing?: boolean;
  /** Land on whole pixels on the axes nothing else snapped. */
  pixel?: boolean;
};

type Axis = 0 | 1;
const lo = (r: Rect, axis: Axis) => (axis ? r.y : r.x);
const len = (r: Rect, axis: Axis) => (axis ? r.height : r.width);
const hi = (r: Rect, axis: Axis) => (axis ? r.y + r.height : r.x + r.width);
const overlaps = (a: Rect, b: Rect, axis: Axis) => lo(a, axis) < hi(b, axis) && lo(b, axis) < hi(a, axis);
const point = (axis: Axis, along: number, across: number): Vec => (axis ? {x: across, y: along} : {x: along, y: across});

/** The correction (page px) that puts an edge or the centre of `rect` on the nearest edge, centre or
 *  guide within `threshold` along `axis`, or NaN. */
export function alignDelta(rect: Rect, targets: SnapTargets, axis: Axis, threshold: number): number {
  const m0 = lo(rect, axis), m1 = m0 + len(rect, axis) / 2, m2 = m0 + len(rect, axis);
  let best = Infinity;
  const consider = (value: number) => {
    let d = value - m0;
    if (Math.abs(d) < Math.abs(best)) best = d;
    d = value - m1;
    if (Math.abs(d) < Math.abs(best)) best = d;
    d = value - m2;
    if (Math.abs(d) < Math.abs(best)) best = d;
  };
  for (const r of targets.rects) {
    consider(lo(r, axis));
    consider(lo(r, axis) + len(r, axis) / 2);
    consider(hi(r, axis));
  }
  for (const r of targets.frames) {
    consider(lo(r, axis));
    consider(lo(r, axis) + len(r, axis) / 2);
    consider(hi(r, axis));
  }
  for (const value of axis ? targets.guidesY : targets.guidesX) consider(value);
  return Math.abs(best) <= threshold ? best : NaN;
}

/** The correction that makes the gaps around `rect` equal: centred between its two neighbours, or
 *  the same gap as two other layers of its row already have. NaN when none is within `threshold`. */
export function spacingDelta(rect: Rect, rects: readonly Rect[], axis: Axis, threshold: number): {delta: number; gap: number} {
  const across: Axis = axis ? 0 : 1;
  const mid = lo(rect, axis) + len(rect, axis) / 2;
  let before: Rect | null = null, after: Rect | null = null;
  const row: Rect[] = [];
  for (const r of rects) {
    if (!overlaps(r, rect, across)) continue;
    if (row.length < MAX_ROW) row.push(r);
    if (hi(r, axis) <= mid) {
      if (!before || hi(r, axis) > hi(before, axis)) before = r;
    } else if (lo(r, axis) >= mid && (!after || lo(r, axis) < lo(after, axis))) {
      after = r;
    }
  }
  let best = {delta: NaN, gap: NaN};
  const take = (target: number, gap: number) => {
    const delta = target - lo(rect, axis);
    if (gap >= 0 && Math.abs(delta) <= threshold && !(Math.abs(delta) >= Math.abs(best.delta))) best = {delta, gap};
  };
  if (before && after) take((hi(before, axis) + lo(after, axis) - len(rect, axis)) / 2, (lo(after, axis) - hi(before, axis) - len(rect, axis)) / 2);
  if ((before || after) && row.length > 1) {
    row.sort((a, b) => lo(a, axis) - lo(b, axis));
    for (let i = 0; i + 1 < row.length; i++) {
      const a = row[i], b = row[i + 1];
      if (a === before && b === after) continue;
      const gap = lo(b, axis) - hi(a, axis);
      if (gap < 0 || !overlaps(a, b, across)) continue;
      if (before) take(hi(before, axis) + gap, gap);
      if (after) take(lo(after, axis) - gap - len(rect, axis), gap);
    }
  }
  return best;
}

// ── Guides ───────────────────────────────────────────────────────────────────────────────────────

type GuideLine = {value: number; min: number; max: number; points: Vec[]; gap: {from: number; to: number} | null};

/** Red guides for every target edge, centre or guide `rect` now lines up with along `axis`, each with
 *  the distance to the nearest layer it lines up with. */
function alignmentGuides(rect: Rect, targets: SnapTargets, axis: Axis, zoom: number, out: OverlayItem[], distances = true) {
  const across: Axis = axis ? 0 : 1;
  const lines: GuideLine[] = [];
  const features = [lo(rect, axis), lo(rect, axis) + len(rect, axis) / 2, hi(rect, axis)];
  const lineAt = (value: number) => {
    let line = lines.find(each => Math.abs(each.value - value) < SAME);
    if (!line) {
      line = {value, min: lo(rect, across), max: hi(rect, across), points: [], gap: null};
      lines.push(line);
    }
    return line;
  };
  const mark = (line: GuideLine, r: Rect, centre: boolean) => {
    if (centre) line.points.push(point(axis, line.value, lo(r, across) + len(r, across) / 2));
    else line.points.push(point(axis, line.value, lo(r, across)), point(axis, line.value, hi(r, across)));
  };
  const match = (r: Rect, frame: boolean) => {
    for (let k = 0; k < 3; k++) {
      const value = k === 0 ? lo(r, axis) : k === 1 ? lo(r, axis) + len(r, axis) / 2 : hi(r, axis);
      for (let j = 0; j < 3; j++) {
        if (Math.abs(value - features[j]) >= SAME) continue;
        const line = lineAt(features[j]);
        line.min = Math.min(line.min, lo(r, across));
        line.max = Math.max(line.max, hi(r, across));
        if (!frame) {
          mark(line, r, k === 1);
          const gap = lo(rect, across) >= hi(r, across) ? {from: hi(r, across), to: lo(rect, across)}
            : lo(r, across) >= hi(rect, across) ? {from: hi(rect, across), to: lo(r, across)} : null;
          if (gap && (!line.gap || gap.to - gap.from < line.gap.to - line.gap.from)) line.gap = gap;
        }
      }
    }
  };
  for (const r of targets.rects) match(r, false);
  for (const r of targets.frames) match(r, true);
  for (const value of axis ? targets.guidesY : targets.guidesX) {
    for (const feature of features) if (Math.abs(value - feature) < SAME) lineAt(feature);
  }
  // One distance per axis is enough: on the line whose neighbour is nearest.
  let labelled: GuideLine | null = null;
  for (const line of lines) {
    if (distances && line.gap && line.gap.to - line.gap.from >= 1 / zoom && (!labelled || line.gap.to - line.gap.from < labelled.gap!.to - labelled.gap!.from)) labelled = line;
  }
  for (const line of lines) {
    const centre = Math.abs(line.value - features[1]) < SAME;
    mark(line, rect, centre);
    out.push({kind: 'line', from: point(axis, line.value, line.min), to: point(axis, line.value, line.max), color: OVERLAY_COLORS.guide});
    for (const at of line.points) out.push({kind: 'point', at, color: OVERLAY_COLORS.guide, shape: 'cross'});
    if (line === labelled && line.gap) {
      out.push({kind: 'label', at: point(axis, line.value, (line.gap.from + line.gap.to) / 2), text: formatNumber(line.gap.to - line.gap.from), background: OVERLAY_COLORS.guide});
    }
  }
}

/** Pink markers on every gap of `rect`'s row (or column) that equals `gap`, its own included. */
function spacingGuides(rect: Rect, rects: readonly Rect[], axis: Axis, gap: number, zoom: number, out: OverlayItem[]) {
  const across: Axis = axis ? 0 : 1;
  const row = rects.filter(r => overlaps(r, rect, across)).slice(0, MAX_ROW);
  row.push(rect);
  row.sort((a, b) => lo(a, axis) - lo(b, axis));
  const tick = 3 / zoom;
  const tolerance = Math.max(SAME, 0.5 / zoom);
  for (let i = 0; i + 1 < row.length; i++) {
    const a = row[i], b = row[i + 1];
    const value = lo(b, axis) - hi(a, axis);
    if (Math.abs(value - gap) > tolerance || !overlaps(a, b, across)) continue;
    const top = Math.max(lo(a, across), lo(b, across)), bottom = Math.min(hi(a, across), hi(b, across));
    const at = (top + bottom) / 2;
    const from = hi(a, axis), to = lo(b, axis);
    out.push({kind: 'line', from: point(axis, from, at), to: point(axis, to, at), color: SPACING_COLOR});
    out.push({kind: 'line', from: point(axis, from, at - tick), to: point(axis, from, at + tick), color: SPACING_COLOR});
    out.push({kind: 'line', from: point(axis, to, at - tick), to: point(axis, to, at + tick), color: SPACING_COLOR});
    out.push({kind: 'label', at: point(axis, (from + to) / 2, at), text: formatNumber(value), background: SPACING_COLOR});
  }
}

// ── Snapping ─────────────────────────────────────────────────────────────────────────────────────

/** Where a moved box lands: alignment first, then equal spacing, then whole pixels. */
export function snapRect(rect: Rect, targets: SnapTargets, options: SnapOptions): SnapResult {
  const zoom = options.zoom ?? 1;
  const deltas: [number, number] = [0, 0];
  const spacing: [number, number] = [NaN, NaN];
  for (const axis of [0, 1] as const) {
    const align = alignDelta(rect, targets, axis, options.threshold);
    const space = options.spacing === false ? {delta: NaN, gap: NaN} : spacingDelta(rect, targets.rects, axis, options.threshold);
    if (!Number.isNaN(align) && !(Math.abs(space.delta) < Math.abs(align) - SAME)) {
      deltas[axis] = align;
    } else if (!Number.isNaN(space.delta)) {
      deltas[axis] = space.delta;
      spacing[axis] = space.gap;
    } else if (options.pixel) {
      deltas[axis] = Math.round(lo(rect, axis)) - lo(rect, axis);
    }
  }
  const final = {x: rect.x + deltas[0], y: rect.y + deltas[1], width: rect.width, height: rect.height};
  const guides: OverlayItem[] = [];
  for (const axis of [0, 1] as const) {
    // Lines along one axis measure their distances across it: where the pink equal-spacing badges
    // already give those gaps, a red distance would only repeat one of them.
    const across: Axis = axis ? 0 : 1;
    alignmentGuides(final, targets, axis, zoom, guides, Number.isNaN(spacing[across]));
    if (!Number.isNaN(spacing[axis])) spacingGuides(final, targets.rects, axis, spacing[axis], zoom, guides);
  }
  return {dx: deltas[0], dy: deltas[1], guides};
}

/** Where a dragged handle or a drawn corner lands. `axes` limits snapping to the axes the point moves. */
export function snapPointTo(p: Vec, targets: SnapTargets, options: SnapOptions & {axes?: {x: boolean; y: boolean}}): {x: number; y: number; guides: OverlayItem[]} {
  const zoom = options.zoom ?? 1;
  const out = {x: p.x, y: p.y};
  const flat = {x: p.x, y: p.y, width: 0, height: 0};
  const snapped: [boolean, boolean] = [false, false];
  for (const axis of [0, 1] as const) {
    if (options.axes && !(axis ? options.axes.y : options.axes.x)) continue;
    const delta = alignDelta(flat, targets, axis, options.threshold);
    if (!Number.isNaN(delta)) {
      snapped[axis] = true;
      if (axis) out.y += delta;
      else out.x += delta;
    } else if (options.pixel) {
      if (axis) out.y = Math.round(out.y);
      else out.x = Math.round(out.x);
    }
  }
  const guides: OverlayItem[] = [];
  for (const axis of [0, 1] as const) {
    // A point has no gap to a layer worth a number: only the lines and crosses.
    if (snapped[axis]) alignmentGuides({x: out.x, y: out.y, width: 0, height: 0}, targets, axis, zoom, guides, false);
  }
  return {...out, guides};
}

// ── The hook ─────────────────────────────────────────────────────────────────────────────────────

export type SmartGuidesOptions = {
  store: DesignStore;
  /** The renderer's spatial index of the page (`renderer.indexFor`); without one the parent's children are walked. */
  index?: (doc: DesignDocument, pageId: NodeId) => SpatialIndex | null;
  /** CSS px of the canvas, for what is on screen. Default: the window. */
  canvasSize?: () => {width: number; height: number};
};

/** Boxes of the visible children of `parents` that are on screen, without `exclude`. */
export function collectTargets(doc: DesignDocument, pageId: NodeId, parents: ReadonlySet<NodeId>, exclude: ReadonlySet<NodeId>, visible: Rect, index: SpatialIndex | null, guides = true): SnapTargets {
  const rects: Rect[] = [];
  const take = (id: NodeId) => {
    const node = doc.nodes[id];
    if (!node || !node.visible || exclude.has(id) || !node.parentId || !parents.has(node.parentId) || node.type === 'SLICE') return;
    const box = worldBox(doc, id);
    if (rectsIntersect(box, visible)) rects.push(box);
  };
  if (index) for (const id of index.query(visible)) take(id);
  else for (const parent of parents) for (const id of childrenOf(doc, parent)) take(id);
  const frames: Rect[] = [];
  for (const parent of parents) {
    const node = doc.nodes[parent];
    if (node && node.type !== 'PAGE' && node.type !== 'GROUP' && node.type !== 'BOOLEAN_OPERATION') frames.push(worldBox(doc, parent));
  }
  const page = doc.nodes[pageId];
  const guidesX: number[] = [], guidesY: number[] = [];
  if (guides) for (const guide of page?.guides ?? []) (guide.axis === 'X' ? guidesX : guidesY).push(guide.offset);
  return {rects, frames, guidesX, guidesY};
}

/** The smart guides for one editor: give it to CanvasView as `snap`. */
export function createSmartGuides(options: SmartGuidesOptions): SnapHook {
  const {store} = options;
  let cache: {key: string; doc: DesignDocument; exclude: ReadonlySet<NodeId>; targets: SnapTargets} | null = null;

  const visible = () => {
    const state = store.getState();
    const size = options.canvasSize?.() ?? {width: globalThis.innerWidth || 1440, height: globalThis.innerHeight || 900};
    return visiblePageRect(currentViewport(state), size);
  };

  const sameSet = (a: ReadonlySet<NodeId>, b: ReadonlySet<NodeId>) => {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const id of a) if (!b.has(id)) return false;
    return true;
  };

  const targetsFor = (context: SmartSnapContext, focus: Vec | null): SnapTargets => {
    const {doc, pageId, exclude} = context;
    // The index of the document on screen: a drag passes the document it started from, and syncing
    // the renderer's index back to that one on every move would make it repaint what the drag moved.
    const index = options.index?.(store.getState().doc, pageId) ?? null;
    const parents = new Set<NodeId>();
    for (const id of exclude) {
      const parentId = doc.nodes[id]?.parentId;
      if (parentId) parents.add(parentId);
    }
    if (context.parentId) parents.add(context.parentId);
    // A layer dragged over a frame lines up with that frame's layers too.
    if (focus && exclude.size) {
      const over = frameAtPoint(doc, pageId, focus, exclude, index);
      if (over) parents.add(over);
    }
    if (!parents.size) parents.add(pageId);
    const area = visible();
    const ui = store.getState().ui;
    const key = `${pageId}|${[...parents].sort().join(',')}|${Math.round(area.x)},${Math.round(area.y)},${Math.round(area.width)},${Math.round(area.height)}|${ui.rulers ? 1 : 0}`;
    if (cache && cache.doc === doc && cache.key === key && sameSet(cache.exclude, exclude)) return cache.targets;
    const targets = collectTargets(doc, pageId, parents, exclude, area, index, ui.rulers);
    cache = {key, doc, exclude: new Set(exclude), targets};
    return targets;
  };

  return {
    snapMove(rect, context) {
      const targets = targetsFor(context, {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2});
      return snapRect(rect, targets, {threshold: SNAP_THRESHOLD_PX / context.zoom, zoom: context.zoom, pixel: store.getState().ui.snapToPixel});
    },
    snapPoint(p, context) {
      const smart = context as SmartSnapContext;
      const targets = targetsFor(smart, null);
      return snapPointTo(p, targets, {threshold: SNAP_THRESHOLD_PX / context.zoom, zoom: context.zoom, pixel: store.getState().ui.snapToPixel, axes: smart.axes});
    },
    end() {
      cache = null;
    },
  };
}
