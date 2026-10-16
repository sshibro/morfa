import type {Measurement, MeasurementSide, NodeId, SceneNode, Vec} from '../../../shared/design/types';
import {worldBox} from '../../../shared/design/geometry';
import {MEASUREMENT_COLOR, measurementGeometry, measurementText, nearestSide, newMeasurementId, offsetThrough, pageMeasurements, parallelSideNear, sideCoordinate, sideAxis} from '../../../shared/design/measurements';
import {HIT_TOLERANCE_PX, pickAt} from '../engine/hit-test';
import {drawLabel} from '../engine/overlay';
import type {DesignStore, Gesture} from '../engine/store';
import {registerTool} from '../engine/tools/registry';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from '../engine/tools/types';
import {ANNOTATION_TOOL, annotationsState, MEASURE_TOOL} from './state';

// "Annotation" (Y) and "Measurement" (⇧M), the Comment group's other tools (docs/design-tool.md §Dev annotations and
// measurements). Annotation: a click on a layer selects it and opens a new note beside it (the note's card is DOM, in
// ui/AnnotationsLayer); Escape closes the note, then leaves the tool. Measurement: the nearest edge of the layer under
// the pointer lights up; a drag from it to an edge of another layer (or the opposite edge of the same one) pins the
// distance between them, the line where the drag started. A click on a pinned line picks it (Delete removes it), a drag
// moves it across. Both edit the document, so a read-only file has neither.

/** Dev Mode's measurement colour, also the canvas lines'. */
export const MEASURE_COLOR = MEASUREMENT_COLOR;
/** Screen px within which a pinned line is under the pointer. */
const LINE_PICK_PX = 5;

const isPage = (node: SceneNode | undefined) => !node || node.type === 'PAGE';

// ── Annotation ───────────────────────────────────────────────────────────────────────────────────

class AnnotationTool implements Tool {
  readonly id = ANNOTATION_TOOL;
  readonly cursor = 'crosshair';

  overlayHints(): OverlayHints {
    return {handles: false, sizeBadge: false};
  }

  private target(e: ToolPointerEvent, ctx: ToolContext): NodeId | null {
    const state = ctx.store.getState();
    const id = pickAt(state.doc, state.pageId, e.page, {context: state.context, deep: e.mod, tolerance: HIT_TOLERANCE_PX * ctx.view.pixel(), index: ctx.index()});
    return id && !isPage(state.doc.nodes[id]) ? id : null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    ctx.store.setHover(this.target(e, ctx));
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const id = this.target(e, ctx);
    const ui = annotationsState(ctx.store);
    if (!id) {
      ui.set({editing: null});
      ctx.store.setSelection([]);
      return;
    }
    ctx.store.setSelection([id]);
    ui.set({editing: {nodeId: id, annotationId: null}});
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext) {
    if (e.type !== 'keydown' || e.code !== 'Escape') return false;
    const ui = annotationsState(ctx.store);
    if (!ui.get().editing) return false;
    ui.set({editing: null});
    return true;
  }

  deactivate(ctx: ToolContext) {
    ctx.store.setHover(null);
  }
}

// ── Measurement ──────────────────────────────────────────────────────────────────────────────────

type Edge = {nodeId: NodeId; side: MeasurementSide};
type Press =
  | {kind: 'new'; start: Edge; from: Vec; to: Vec; end: Edge | null}
  | {kind: 'move'; id: string; gesture: Gesture; moved: boolean};

const distanceToSegment = (p: Vec, a: Vec, b: Vec) => {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};

/** The pinned measurement whose line passes within `tolerance` (page units) of `point`. */
export function measurementAt(store: DesignStore, point: Vec, tolerance: number): string | null {
  const {doc, pageId} = store.getState();
  let best: string | null = null, distance = tolerance;
  for (const {measurement, geometry} of pageMeasurements(doc, pageId)) {
    const d = distanceToSegment(point, geometry.from, geometry.to);
    if (d <= distance) {
      best = measurement.id;
      distance = d;
    }
  }
  return best;
}

/** Writes the page's measurements (one undo step). */
export function setMeasurements(store: DesignStore, label: string, make: (list: readonly Measurement[]) => Measurement[]) {
  const pageId = store.getState().pageId;
  store.transact(label, tx => {
    const page = tx.get(pageId);
    if (!page) return;
    const next = make(page.measurements ?? []);
    tx.update(pageId, {measurements: next.length ? next : undefined});
  }, {annotation: true});
}

class MeasureTool implements Tool {
  readonly id = MEASURE_TOOL;
  readonly cursor = 'crosshair';
  private hover: Edge | null = null;
  private press: Press | null = null;
  private ctx: ToolContext | null = null;

  overlayHints(): OverlayHints {
    return {handles: false, sizeBadge: false, hover: false};
  }

  busy() {
    return !!this.press;
  }

  /** The layer under the pointer (any depth: measurements are about what a developer builds) and its nearest edge. */
  private edgeAt(page: Vec, ctx: ToolContext): Edge | null {
    const state = ctx.store.getState();
    const id = pickAt(state.doc, state.pageId, page, {deep: true, tolerance: HIT_TOLERANCE_PX * ctx.view.pixel(), index: ctx.index()});
    if (!id || isPage(state.doc.nodes[id])) return null;
    const side = nearestSide(worldBox(state.doc, id), page, Infinity);
    return side ? {nodeId: id, side} : null;
  }

  activate(ctx: ToolContext) {
    this.ctx = ctx;
    ctx.store.setHover(null);
    // Measurements are about layers, not a selection: nothing stays selected for a key to act on unseen.
    if (ctx.store.getState().selection.length) ctx.store.setSelection([]);
  }

  deactivate(ctx: ToolContext) {
    this.press?.kind === 'move' && this.press.gesture.cancel();
    this.press = null;
    this.hover = null;
    annotationsState(ctx.store).set({hoverMeasurement: null, selectedMeasurement: null});
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    const ui = annotationsState(ctx.store);
    if (press?.kind === 'move') {
      press.moved = true;
      const state = ctx.store.getState();
      const measurement = state.doc.nodes[state.pageId]?.measurements?.find(m => m.id === press.id);
      if (!measurement) return;
      press.gesture.update(tx => {
        const page = tx.get(state.pageId);
        if (!page?.measurements) return;
        tx.update(state.pageId, {measurements: page.measurements.map(m => (m.id === press.id ? {...m, offset: offsetThrough(tx.doc, m.start, e.page)} : m))});
      });
      return;
    }
    if (press?.kind === 'new') {
      press.to = e.page;
      const target = this.edgeAt(e.page, ctx);
      const doc = ctx.store.getState().doc;
      press.end = target ? {nodeId: target.nodeId, side: parallelSideNear(worldBox(doc, target.nodeId), press.start.side, e.page)} : null;
      // The edge it started from cannot end it.
      if (press.end && press.end.nodeId === press.start.nodeId && press.end.side === press.start.side) press.end = null;
      ctx.requestOverlay();
      return;
    }
    const line = measurementAt(ctx.store, e.page, LINE_PICK_PX * ctx.view.pixel());
    ui.set({hoverMeasurement: line});
    this.hover = line ? null : this.edgeAt(e.page, ctx);
    ctx.setCursor(line ? 'move' : null);
    ctx.requestOverlay();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const ui = annotationsState(ctx.store);
    const line = measurementAt(ctx.store, e.page, LINE_PICK_PX * ctx.view.pixel());
    if (line) {
      ui.set({selectedMeasurement: line});
      this.press = {kind: 'move', id: line, gesture: ctx.store.gesture('Measurement', {annotation: true}), moved: false};
      return;
    }
    ui.set({selectedMeasurement: null});
    const start = this.edgeAt(e.page, ctx);
    if (!start) return;
    this.press = {kind: 'new', start, from: e.page, to: e.page, end: null};
    this.hover = null;
    ctx.requestOverlay();
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    this.press = null;
    ctx.requestOverlay();
    if (!press) return;
    if (press.kind === 'move') {
      if (press.moved) press.gesture.commit();
      else press.gesture.cancel();
      return;
    }
    if (!press.end) return;
    const {doc, pageId} = ctx.store.getState();
    const existing = doc.nodes[pageId]?.measurements ?? [];
    const measurement: Measurement = {id: newMeasurementId(existing), start: press.start, end: press.end, offset: offsetThrough(doc, press.start, press.from)};
    if (!measurementGeometry(doc, pageId, measurement)) return;
    setMeasurements(ctx.store, 'Measurement', list => [...list, measurement]);
    annotationsState(ctx.store).set({selectedMeasurement: measurement.id});
  }

  onPointerCancel(ctx: ToolContext) {
    if (this.press?.kind === 'move') this.press.gesture.cancel();
    this.press = null;
    ctx.requestOverlay();
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext) {
    if (e.type !== 'keydown') return false;
    const ui = annotationsState(ctx.store);
    const selected = ui.get().selectedMeasurement;
    if (e.code === 'Escape') {
      if (this.press) {
        if (this.press.kind === 'move') this.press.gesture.cancel();
        this.press = null;
        ctx.requestOverlay();
        return true;
      }
      if (selected) {
        ui.set({selectedMeasurement: null});
        return true;
      }
      return false;
    }
    if ((e.code === 'Delete' || e.code === 'Backspace') && selected && !e.mod) {
      setMeasurements(ctx.store, 'Delete measurement', list => list.filter(m => m.id !== selected));
      ui.set({selectedMeasurement: null, hoverMeasurement: null});
      return true;
    }
    return false;
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const press = this.press?.kind === 'new' ? this.press : null;
    const edge = press?.start ?? this.hover;
    const ctx = this.ctx;
    if (!edge || !ctx) return;
    const boxes = (id: NodeId) => {
      const {doc} = ctx.store.getState();
      return doc.nodes[id] ? worldBox(doc, id) : null;
    };
    ctx2d.save();
    ctx2d.strokeStyle = MEASURE_COLOR;
    ctx2d.fillStyle = MEASURE_COLOR;
    const drawEdge = (box: {x: number; y: number; width: number; height: number}, side: MeasurementSide) => {
      const along = sideAxis(side) === 'x';
      const at = sideCoordinate(box, side);
      const a = view.pageToScreen(along ? {x: at, y: box.y} : {x: box.x, y: at});
      const b = view.pageToScreen(along ? {x: at, y: box.y + box.height} : {x: box.x + box.width, y: at});
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.moveTo(a.x, a.y);
      ctx2d.lineTo(b.x, b.y);
      ctx2d.stroke();
    };
    const startBox = boxes(edge.nodeId);
    if (startBox) {
      ctx2d.lineWidth = 1;
      ctx2d.strokeRect(...screenRect(view, startBox));
      drawEdge(startBox, edge.side);
    }
    if (press) {
      const endBox = press.end ? boxes(press.end.nodeId) : null;
      if (endBox && press.end) {
        ctx2d.lineWidth = 1;
        ctx2d.strokeRect(...screenRect(view, endBox));
        drawEdge(endBox, press.end.side);
      }
      if (startBox) {
        const x = sideAxis(press.start.side) === 'x';
        const from = sideCoordinate(startBox, press.start.side);
        const to = endBox && press.end ? sideCoordinate(endBox, press.end.side) : x ? press.to.x : press.to.y;
        const across = x ? press.from.y : press.from.x;
        const a = view.pageToScreen(x ? {x: from, y: across} : {x: across, y: from});
        const b = view.pageToScreen(x ? {x: to, y: across} : {x: across, y: to});
        ctx2d.lineWidth = 1;
        ctx2d.setLineDash(endBox ? [] : [4, 3]);
        ctx2d.beginPath();
        ctx2d.moveTo(a.x, a.y);
        ctx2d.lineTo(b.x, b.y);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
        if (endBox) drawLabel(ctx2d, {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, measurementText({}, Math.abs(to - from)), {background: MEASURE_COLOR, anchor: 'center'});
      }
    }
    ctx2d.restore();
  }

}

const screenRect = (view: ViewHelpers, box: {x: number; y: number; width: number; height: number}): [number, number, number, number] => {
  const a = view.pageToScreen({x: box.x, y: box.y}), b = view.pageToScreen({x: box.x + box.width, y: box.y + box.height});
  return [Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y)];
};

let registered = false;
/** Registers both tools (idempotent); the toolbar's Comment group shows them once they are there. */
export function registerAnnotationTools() {
  if (registered) return;
  registered = true;
  registerTool(ANNOTATION_TOOL, () => new AnnotationTool());
  registerTool(MEASURE_TOOL, () => new MeasureTool());
}
