import type {ColorStop, GradientPaint, ImageRef, Matrix, NodeId, Paint, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, multiply, worldMatrix} from '../../../../shared/design/geometry';
import {gradientFrame, normalizedStops} from '../render/gradient-math';
import {screenMatrix} from '../overlay';
import type {DesignStore, Gesture} from '../store';
import {userUpdate} from '../user-edit';
import {createTool} from './registry';
import type {Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';

// Editing a gradient on the canvas, as in Figma: while the colour picker shows a gradient paint, the
// node carries its handles. The start (H0) and end (H1) points sit on the main axis with the stops
// along it; radial, angular and diamond gradients also show the width handle (H2). Handles live in
// the node's unit box with the renderer's convention (render/gradient-math.ts): H0 is the origin, a
// linear gradient runs along H1 − H0 with bands parallel to H2 − H0, the other kinds take H1 − H0
// and H2 − H0 as their axes. A drag is one store gesture; the stops never change while handles move.
//
// The picker and the canvas share one "paint edit session" (below): which paint of which node is
// being edited, and its selected stop.

// ── The session ──────────────────────────────────────────────────────────────────────────────────

export type PaintEditKind = 'gradient' | 'crop';
export type PaintEditTarget = {
  nodeId: NodeId;
  field: 'fills' | 'strokes';
  /** Index in the model list (bottom-first). */
  index: number;
  kind: PaintEditKind;
  /** The selected stop of a gradient (index into `gradientStops`). */
  stop: number;
  /** The decoded picture of an image paint, for the crop view's ghost (images.ts `get`). */
  image?: (ref: ImageRef) => CanvasImageSource | null;
};

export const GRADIENT_TOOL = 'gradient-edit';
export const CROP_TOOL = 'image-crop';
const OWN_TOOLS = new Set([GRADIENT_TOOL, CROP_TOOL]);

type Listener = () => void;

/** One session per page of the app: only one picker edits a paint on the canvas at a time. */
class PaintEditSession {
  private target: PaintEditTarget | null = null;
  private store: DesignStore | null = null;
  private previousTool = 'move';
  private readonly listeners = new Set<Listener>();

  get(): PaintEditTarget | null {
    return this.target;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  /** Puts the paint on the canvas: the editing state, and the tool that drags its handles. */
  start(store: DesignStore, target: PaintEditTarget): void {
    const same = this.target && this.store === store && this.target.nodeId === target.nodeId && this.target.field === target.field && this.target.index === target.index && this.target.kind === target.kind;
    if (!same && this.target) this.end();
    this.store = store;
    this.target = {...target};
    const state = store.getState();
    if (!OWN_TOOLS.has(state.tool)) this.previousTool = state.tool;
    if (target.kind === 'gradient') store.setEditing({kind: 'gradient', id: target.nodeId});
    else if (state.editing?.kind === 'gradient') store.setEditing(null);
    store.setTool(target.kind === 'gradient' ? GRADIENT_TOOL : CROP_TOOL);
    this.emit();
  }

  /** The selected stop or the paint index moved (a reorder, a stop added in the picker). */
  update(partial: Partial<Pick<PaintEditTarget, 'stop' | 'index' | 'image'>>): void {
    if (!this.target) return;
    const next = {...this.target, ...partial};
    if (next.stop === this.target.stop && next.index === this.target.index && next.image === this.target.image) return;
    this.target = next;
    this.emit();
  }

  /** Ends canvas editing: the tool and the editing state go back. `keepTool` when the user already
   *  switched tools (the old tool is being deactivated). */
  end(options: {keepTool?: boolean} = {}): void {
    const target = this.target, store = this.store;
    if (!target) return;
    this.target = null;
    this.store = null;
    if (store) {
      const state = store.getState();
      if (state.editing?.kind === 'gradient' && state.editing.id === target.nodeId) store.setEditing(null);
      if (!options.keepTool && OWN_TOOLS.has(state.tool)) store.setTool(this.previousTool && !OWN_TOOLS.has(this.previousTool) ? this.previousTool : 'move');
    }
    this.emit();
  }
}

export const paintEditSession = new PaintEditSession();

/** The paint the session edits, read from a document. */
export function sessionPaint(node: SceneNode | undefined, target: PaintEditTarget | null): Paint | null {
  if (!node || !target) return null;
  return node[target.field][target.index] ?? null;
}

// ── Handle maths (pure, tested in tests/design-paint-gradient.test.ts) ──────────────────────────

const EPS = 1e-9;
/** Perpendicular turning +90° on screen (y down): right → down. */
const perp = (v: Vec): Vec => ({x: -v.y, y: v.x});
const sub = (a: Vec, b: Vec): Vec => ({x: a.x - b.x, y: a.y - b.y});
const add = (a: Vec, b: Vec): Vec => ({x: a.x + b.x, y: a.y + b.y});
const scale = (v: Vec, k: number): Vec => ({x: v.x * k, y: v.y * k});
const length = (v: Vec) => Math.hypot(v.x, v.y);
const extent = (value: number) => (value > 0 && Number.isFinite(value) ? value : 1);

/** Handles in the node's pixels (local space). */
export function handlesToLocal(handles: readonly [Vec, Vec, Vec], width: number, height: number): [Vec, Vec, Vec] {
  const w = extent(width), h = extent(height);
  return handles.map(p => ({x: p.x * w, y: p.y * h})) as [Vec, Vec, Vec];
}

export function handlesFromLocal(points: readonly [Vec, Vec, Vec], width: number, height: number): [Vec, Vec, Vec] {
  const w = extent(width), h = extent(height);
  return points.map(p => ({x: p.x / w, y: p.y / h})) as [Vec, Vec, Vec];
}

/** The width handle a linear gradient keeps: perpendicular to its axis on screen, half as long. */
function linearWidth(p0: Vec, p1: Vec): Vec {
  return add(p0, scale(perp(sub(p1, p0)), 0.5));
}

/** The width handle of the other kinds: perpendicular to the axis, `size` px from the origin. */
function perpendicularWidth(p0: Vec, p1: Vec, size: number): Vec {
  const axis = sub(p1, p0);
  const l = length(axis);
  if (l < EPS) return add(p0, {x: 0, y: size});
  return add(p0, scale(perp(axis), size / l));
}

export type GradientHandle = 0 | 1 | 2;

/** Snaps the direction of `v` to multiples of 45° (Shift), keeping its length. */
function snap45(v: Vec): Vec {
  const l = length(v);
  if (l < EPS) return v;
  const angle = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4)) * (Math.PI / 4);
  return {x: Math.cos(angle) * l, y: Math.sin(angle) * l};
}

/**
 * The handles after dragging one of them, in the node's unit box.
 *  - H0 of a linear gradient moves alone (the end stays); of the other kinds it moves the whole
 *    gradient (the centre carries the ellipse).
 *  - H1 sets the main axis; the width handle stays perpendicular (linear: half the axis; others:
 *    keeping its distance from the centre).
 *  - H2 (not linear) only changes the second axis's length, staying perpendicular.
 * `start` are the handles when the drag began and `delta` the pointer's travel in local px, so a
 * gesture re-run from its start never drifts. Shift snaps the axis to 45°.
 */
export function dragGradientHandle(paint: Pick<GradientPaint, 'type' | 'gradientHandlePositions'>, which: GradientHandle, delta: Vec, width: number, height: number, options: {shift?: boolean} = {}): [Vec, Vec, Vec] {
  const [p0, p1, p2] = handlesToLocal(paint.gradientHandlePositions, width, height);
  const linear = paint.type === 'GRADIENT_LINEAR';
  let next: [Vec, Vec, Vec];
  if (which === 0) {
    if (linear) {
      let q0 = add(p0, delta);
      if (options.shift) q0 = sub(p1, snap45(sub(p1, q0)));
      next = [q0, p1, linearWidth(q0, p1)];
    } else {
      next = [add(p0, delta), add(p1, delta), add(p2, delta)];
    }
  } else if (which === 1) {
    let q1 = add(p1, delta);
    if (options.shift) q1 = add(p0, snap45(sub(q1, p0)));
    next = [p0, q1, linear ? linearWidth(p0, q1) : perpendicularWidth(p0, q1, length(sub(p2, p0)))];
  } else {
    if (linear) return [...paint.gradientHandlePositions] as [Vec, Vec, Vec];
    const axis = sub(p1, p0);
    const l = length(axis);
    const normal = l < EPS ? {x: 0, y: 1} : scale(perp(axis), 1 / l);
    const moved = add(p2, delta);
    const size = Math.max(1, Math.abs((moved.x - p0.x) * normal.x + (moved.y - p0.y) * normal.y));
    next = [p0, p1, add(p0, scale(normal, size))];
  }
  return handlesFromLocal(next, width, height);
}

/** Where stop position `t` sits between H0 and H1, in local px. */
export function stopPoint(handles: readonly [Vec, Vec, Vec], width: number, height: number, t: number): Vec {
  const [p0, p1] = handlesToLocal(handles, width, height);
  return add(p0, scale(sub(p1, p0), t));
}

/** The position (0..1) on the main axis nearest to a local point. */
export function positionOnAxis(handles: readonly [Vec, Vec, Vec], width: number, height: number, point: Vec): number {
  const [p0, p1] = handlesToLocal(handles, width, height);
  const axis = sub(p1, p0);
  const ll = axis.x * axis.x + axis.y * axis.y;
  if (ll < EPS) return 0;
  return Math.min(1, Math.max(0, ((point.x - p0.x) * axis.x + (point.y - p0.y) * axis.y) / ll));
}

// ── The tool ─────────────────────────────────────────────────────────────────────────────────────

/** Screen px: handle radius, stop marker size and how near a press must land. */
const HANDLE_R = 5;
const STOP_SIZE = 14;
const REACH = 8;
const LINE_REACH = 5;

type Hit = {kind: 'handle'; which: GradientHandle} | {kind: 'stop'; index: number} | {kind: 'line'; t: number};
type Drag =
  | {kind: 'handle'; which: GradientHandle; handles: [Vec, Vec, Vec]; gesture: Gesture | null; startLocal: Vec}
  /** `added`: the stop a press on the line made (the gesture re-runs from its start, so it re-adds it). */
  | {kind: 'stop'; index: number; gesture: Gesture | null; down: Vec; added: ColorStop | null}
  | {kind: 'delegate'; tool: Tool};

/** Local px → screen px matrix of a node, and its inverse. */
function nodeScreen(store: DesignStore, view: ViewHelpers, id: NodeId): {m: Matrix; inverse: Matrix} | null {
  const {doc} = store.getState();
  if (!doc.nodes[id]) return null;
  const m = multiply(screenMatrix(view.viewport()), worldMatrix(doc, id));
  return {m, inverse: invert(m)};
}

function editedGradient(store: DesignStore): {node: SceneNode; paint: GradientPaint; target: PaintEditTarget} | null {
  const target = paintEditSession.get();
  if (!target || target.kind !== 'gradient') return null;
  const node = store.getState().doc.nodes[target.nodeId];
  const paint = sessionPaint(node, target);
  if (!node || !paint || paint.type === 'SOLID' || paint.type === 'IMAGE') return null;
  return {node, paint, target};
}

/** Writes a new version of the edited paint inside a gesture (or as one step). */
function writePaint(store: DesignStore, label: string, gesture: Gesture | null, target: PaintEditTarget, make: (paint: GradientPaint) => GradientPaint): void {
  const recipe = (tx: Parameters<Parameters<DesignStore['transact']>[1]>[0]) => {
    const node = tx.get(target.nodeId);
    const paint = sessionPaint(node, target);
    if (!node || !paint || paint.type === 'SOLID' || paint.type === 'IMAGE') return;
    const list = [...node[target.field]];
    list[target.index] = make(paint);
    userUpdate(tx, target.nodeId, {[target.field]: list});
  };
  if (gesture) gesture.update(recipe);
  else store.transact(label, recipe);
}

export class GradientEditTool implements Tool {
  readonly id = GRADIENT_TOOL;
  readonly cursor = 'default';
  private drag: Drag | null = null;
  private ctx: ToolContext | null = null;
  private unsubscribe: (() => void) | null = null;

  busy() {
    return !!this.drag && this.drag.kind !== 'delegate';
  }

  overlayHints() {
    return {handles: false, hover: false, sizeBadge: false};
  }

  activate(ctx: ToolContext) {
    this.ctx = ctx;
    ctx.store.setHover(null);
    this.unsubscribe = paintEditSession.subscribe(() => ctx.requestOverlay());
  }

  deactivate() {
    this.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
    // The user picked another tool: the picker stays, the canvas handles go.
    if (paintEditSession.get()?.kind === 'gradient') paintEditSession.end({keepTool: true});
    this.ctx = null;
  }

  private hit(e: ToolPointerEvent, ctx: ToolContext): Hit | null {
    const edited = editedGradient(ctx.store);
    if (!edited) return null;
    const screen = nodeScreen(ctx.store, ctx.view, edited.node.id);
    if (!screen) return null;
    const {paint, node, target} = edited;
    const handles = paint.gradientHandlePositions;
    const local = handlesToLocal(handles, node.width, node.height);
    const points = local.map(p => apply(screen.m, p));
    const near = (p: Vec, reach: number) => Math.hypot(p.x - e.screen.x, p.y - e.screen.y) <= reach;
    // Stops strictly between the ends first (they sit on the line), the selected one on top.
    const order = paint.gradientStops.map((_, i) => i).sort((a, b) => (a === target.stop ? -1 : b === target.stop ? 1 : 0));
    for (const index of order) {
      const t = paint.gradientStops[index].position;
      if (t <= 0.001 || t >= 0.999) continue;
      if (near(apply(screen.m, stopPoint(handles, node.width, node.height, t)), STOP_SIZE / 2 + 2)) return {kind: 'stop', index};
    }
    if (near(points[1], REACH)) return {kind: 'handle', which: 1};
    if (near(points[0], REACH)) return {kind: 'handle', which: 0};
    if (paint.type !== 'GRADIENT_LINEAR' && near(points[2], REACH)) return {kind: 'handle', which: 2};
    // On the line between the ends: a new stop.
    const a = points[0], b = points[1];
    const ab = sub(b, a), ll = ab.x * ab.x + ab.y * ab.y;
    if (ll > 1) {
      const t = ((e.screen.x - a.x) * ab.x + (e.screen.y - a.y) * ab.y) / ll;
      const foot = add(a, scale(ab, t));
      if (t > 0 && t < 1 && Math.hypot(foot.x - e.screen.x, foot.y - e.screen.y) <= LINE_REACH) return {kind: 'line', t};
    }
    return null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    if (!drag) {
      const hit = this.hit(e, ctx);
      ctx.setCursor(hit ? (hit.kind === 'line' ? 'copy' : 'pointer') : null);
      return;
    }
    if (drag.kind === 'delegate') return drag.tool.onPointerMove?.(e, ctx);
    const edited = editedGradient(ctx.store);
    const screen = edited && nodeScreen(ctx.store, ctx.view, edited.node.id);
    if (!edited || !screen) return;
    const {node, target} = edited;
    if (drag.kind === 'handle') {
      const delta = sub(apply(screen.inverse, e.screen), drag.startLocal);
      drag.gesture ??= ctx.store.gesture('Gradient');
      const {which, handles} = drag;
      writePaint(ctx.store, 'Gradient', drag.gesture, target, paint => ({...paint, gradientHandlePositions: dragGradientHandle({type: paint.type, gradientHandlePositions: handles}, which, delta, node.width, node.height, {shift: e.shiftKey})}));
    } else {
      if (!drag.gesture && Math.hypot(e.screen.x - drag.down.x, e.screen.y - drag.down.y) < 2) return;
      drag.gesture ??= ctx.store.gesture('Gradient');
      const t = positionOnAxis(edited.paint.gradientHandlePositions, node.width, node.height, apply(screen.inverse, e.screen));
      const {index, added} = drag;
      writePaint(ctx.store, 'Gradient', drag.gesture, target, paint => {
        const stops = added ? [...paint.gradientStops, added] : paint.gradientStops;
        return {...paint, gradientStops: stops.map((stop, i) => (i === index ? {...stop, position: t} : stop))};
      });
    }
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const edited = editedGradient(ctx.store);
    const hit = edited ? this.hit(e, ctx) : null;
    if (!edited || !hit) {
      // A press elsewhere ends gradient editing and does what the move tool would; the tool switches
      // back once the press is over, so the move tool sees the whole click or drag.
      const tool = createTool('move');
      if (!tool) {
        paintEditSession.end();
        return;
      }
      this.drag = {kind: 'delegate', tool};
      tool.onPointerDown?.(e, ctx);
      return;
    }
    const screen = nodeScreen(ctx.store, ctx.view, edited.node.id)!;
    const {paint, target, node} = edited;
    if (hit.kind === 'handle') {
      // A press on an end selects the stop that sits nearest to it.
      if (hit.which !== 2) {
        const order = stopOrder(paint);
        const index = hit.which === 0 ? order[0] : order[order.length - 1];
        if (index !== undefined) paintEditSession.update({stop: index});
      }
      this.drag = {kind: 'handle', which: hit.which, handles: [...paint.gradientHandlePositions] as [Vec, Vec, Vec], gesture: null, startLocal: apply(screen.inverse, e.screen)};
      return;
    }
    if (hit.kind === 'stop') {
      paintEditSession.update({stop: hit.index});
      this.drag = {kind: 'stop', index: hit.index, gesture: null, down: e.screen, added: null};
      return;
    }
    // A press on the line adds a stop there with the colour the gradient has at that point.
    const t = positionOnAxis(paint.gradientHandlePositions, node.width, node.height, apply(screen.inverse, e.screen));
    const added: ColorStop = {position: t, color: interpolate(paint, t)};
    const index = paint.gradientStops.length;
    const gesture = ctx.store.gesture('Gradient stop');
    writePaint(ctx.store, 'Gradient stop', gesture, target, current => ({...current, gradientStops: [...current.gradientStops, added]}));
    paintEditSession.update({stop: index});
    this.drag = {kind: 'stop', index, gesture, down: e.screen, added};
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.kind === 'delegate') {
      drag.tool.onPointerUp?.(e, ctx);
      drag.tool.deactivate?.(ctx);
      paintEditSession.end();
      return;
    }
    drag.gesture?.commit();
  }

  onPointerCancel(ctx: ToolContext) {
    if (this.drag?.kind === 'delegate') this.drag.tool.onPointerCancel?.(ctx);
    this.cancel();
  }

  private cancel() {
    const drag = this.drag;
    this.drag = null;
    if (drag && drag.kind !== 'delegate') drag.gesture?.cancel();
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      this.cancel();
      paintEditSession.end();
      return true;
    }
    if (e.code === 'Backspace' || e.code === 'Delete') {
      const edited = editedGradient(ctx.store);
      if (!edited) return false;
      const {paint, target} = edited;
      if (paint.gradientStops.length > 2 && paint.gradientStops[target.stop]) {
        const removed = target.stop;
        writePaint(ctx.store, 'Delete gradient stop', null, target, current => ({...current, gradientStops: current.gradientStops.filter((_, i) => i !== removed)}));
        paintEditSession.update({stop: Math.max(0, removed - 1)});
      }
      // A stop is selected: Backspace never deletes the layer while its gradient is open.
      return true;
    }
    return false;
  }

  drawOverlay(c: CanvasRenderingContext2D, view: ViewHelpers) {
    const store = this.ctx?.store;
    if (!store) return;
    if (this.drag?.kind === 'delegate') this.drag.tool.drawOverlay?.(c, view);
    const edited = editedGradient(store);
    const screen = edited && nodeScreen(store, view, edited.node.id);
    if (!edited || !screen) return;
    drawGradientHandles(c, screen.m, edited.node, edited.paint, edited.target.stop);
  }
}

/** Stop indexes by position. */
function stopOrder(paint: GradientPaint): number[] {
  return paint.gradientStops.map((stop, index) => ({stop, index})).sort((p, q) => p.stop.position - q.stop.position || p.index - q.index).map(entry => entry.index);
}

function interpolate(paint: GradientPaint, t: number) {
  const stops = normalizedStops(paint.gradientStops);
  if (!stops.length) return {r: 0, g: 0, b: 0, a: 1};
  if (t <= stops[0].position) return {...stops[0].color};
  for (let i = 1; i < stops.length; i++) {
    const p = stops[i - 1], q = stops[i];
    if (t <= q.position) {
      const f = q.position - p.position > EPS ? (t - p.position) / (q.position - p.position) : 1;
      return {r: p.color.r + (q.color.r - p.color.r) * f, g: p.color.g + (q.color.g - p.color.g) * f, b: p.color.b + (q.color.b - p.color.b) * f, a: p.color.a + (q.color.a - p.color.a) * f};
    }
  }
  return {...stops[stops.length - 1].color};
}

const SHADOW = 'rgba(0, 0, 0, 0.32)';
const ACCENT = '#0D99FF';

function checker(c: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const cell = size / 4;
  c.fillStyle = '#FFFFFF';
  c.fillRect(x, y, size, size);
  c.fillStyle = '#D9D9D9';
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2) c.fillRect(x + i * cell, y + j * cell, cell, cell);
}

/** Draws the gradient's handles and stops in screen px (`m`: the node's local px → screen). */
export function drawGradientHandles(c: CanvasRenderingContext2D, m: Matrix, node: SceneNode, paint: GradientPaint, selectedStop: number) {
  const handles = paint.gradientHandlePositions;
  const local = handlesToLocal(handles, node.width, node.height);
  const [s0, s1, s2] = local.map(p => apply(m, p));
  c.save();
  c.lineCap = 'round';
  const line = (from: Vec, to: Vec, dash: number[] = []) => {
    c.setLineDash(dash);
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.lineTo(to.x, to.y);
    c.strokeStyle = SHADOW;
    c.lineWidth = 3;
    c.stroke();
    c.strokeStyle = '#FFFFFF';
    c.lineWidth = 1.5;
    c.stroke();
  };
  if (paint.type !== 'GRADIENT_LINEAR') {
    // The shape's extent: an ellipse (radial, angular) or a rhombus (diamond) through H1 and H2.
    const frame = gradientFrame(handles, node.width, node.height);
    const toScreen = multiply(m, frame.matrix);
    c.setLineDash([4, 4]);
    c.beginPath();
    for (let k = 0; k <= 64; k++) {
      const angle = (k / 64) * Math.PI * 2;
      const u = paint.type === 'GRADIENT_DIAMOND' ? diamondPoint(angle) : {x: Math.cos(angle), y: Math.sin(angle)};
      const p = apply(toScreen, u);
      if (k) c.lineTo(p.x, p.y);
      else c.moveTo(p.x, p.y);
    }
    c.strokeStyle = SHADOW;
    c.lineWidth = 2;
    c.stroke();
    c.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    c.lineWidth = 1;
    c.stroke();
    line(s0, s2, [3, 3]);
  }
  line(s0, s1);
  c.setLineDash([]);
  const ring = (at: Vec, radius: number, fill = '#FFFFFF') => {
    c.beginPath();
    c.arc(at.x, at.y, radius, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.shadowColor = 'rgba(0, 0, 0, 0.35)';
    c.shadowBlur = 3;
    c.fill();
    c.shadowColor = 'transparent';
    c.shadowBlur = 0;
  };
  ring(s0, HANDLE_R + 1);
  ring(s1, HANDLE_R + 1);
  if (paint.type !== 'GRADIENT_LINEAR') ring(s2, HANDLE_R - 1);
  // Stops: swatches on the axis, the selected one ringed in the accent colour.
  const order = paint.gradientStops.map((_, i) => i).sort((a, b) => (a === selectedStop ? 1 : b === selectedStop ? -1 : 0));
  for (const index of order) {
    const stop = paint.gradientStops[index];
    const at = apply(m, stopPoint(handles, node.width, node.height, Math.min(1, Math.max(0, stop.position))));
    const size = STOP_SIZE;
    const x = Math.round(at.x - size / 2), y = Math.round(at.y - size / 2);
    c.save();
    c.shadowColor = 'rgba(0, 0, 0, 0.35)';
    c.shadowBlur = 4;
    c.shadowOffsetY = 1;
    c.beginPath();
    c.roundRect(x - 2, y - 2, size + 4, size + 4, 4);
    c.fillStyle = index === selectedStop ? ACCENT : '#FFFFFF';
    c.fill();
    c.restore();
    c.save();
    c.beginPath();
    c.roundRect(x, y, size, size, 2);
    c.clip();
    checker(c, x, y, size);
    c.fillStyle = `rgba(${Math.round(stop.color.r * 255)}, ${Math.round(stop.color.g * 255)}, ${Math.round(stop.color.b * 255)}, ${stop.color.a})`;
    c.fillRect(x, y, size, size);
    c.restore();
  }
  c.restore();
}

/** A point on the unit rhombus |u| + |v| = 1 at `angle`. */
function diamondPoint(angle: number): Vec {
  const x = Math.cos(angle), y = Math.sin(angle);
  const k = 1 / (Math.abs(x) + Math.abs(y));
  return {x: x * k, y: y * k};
}

export const createGradientEditTool = () => new GradientEditTool();
