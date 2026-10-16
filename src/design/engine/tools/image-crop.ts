import type {ImagePaint, Matrix, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, multiply, worldMatrix} from '../../../../shared/design/geometry';
import {imagePlacement} from '../render/image-math';
import {OVERLAY_COLORS, screenMatrix} from '../overlay';
import type {DesignStore, Gesture} from '../store';
import {userUpdate} from '../user-edit';
import {CROP_TOOL, paintEditSession, sessionPaint, type PaintEditTarget} from './gradient-edit';
import {createTool} from './registry';
import type {Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';

// "Crop": an image paint in CROP mode is placed by `imageTransform`, which maps the node's unit
// box into the image's unit box (Figma's convention, render/image-math.ts). On the canvas the whole
// picture shows, ghosted outside the layer; dragging inside moves it, its corner and edge handles
// resize it (corners keep the proportions, Shift frees them). Each drag is one store gesture.

// ── Maths (pure, tested in tests/design-paint-gradient.test.ts) ─────────────────────────────────

export type Rect = {x: number; y: number; width: number; height: number};

const EPS = 1e-9;
const extent = (value: number) => (value > 0 && Number.isFinite(value) ? value : 1);
const boxScale = (width: number, height: number): Matrix => [[extent(width), 0, 0], [0, extent(height), 0]];

/** The `imageTransform` that keeps the picture where FILL, FIT, TILE (one tile) or CROP shows it now. */
export function cropTransformFor(paint: Pick<ImagePaint, 'scaleMode' | 'imageTransform' | 'scalingFactor' | 'rotation'>, width: number, height: number, imageWidth: number, imageHeight: number): Matrix {
  if (paint.scaleMode === 'CROP' && paint.imageTransform) return paint.imageTransform;
  const iw = extent(imageWidth), ih = extent(imageHeight);
  const placement = imagePlacement({...paint, scaleMode: paint.scaleMode === 'CROP' ? 'FILL' : paint.scaleMode}, extent(width), extent(height), iw, ih);
  // node unit → local px → image px → image unit.
  return multiply([[1 / iw, 0, 0], [0, 1 / ih, 0]], multiply(invert(placement.matrix), boxScale(width, height)));
}

/** Image unit box → the node's local px. */
export const imageToLocal = (transform: Matrix, width: number, height: number): Matrix => multiply(boxScale(width, height), invert(transform));

/** The transform back from an image-unit → local-px matrix. */
const fromImageToLocal = (m: Matrix, width: number, height: number): Matrix => multiply(invert(m), boxScale(width, height));

/** Where the picture's box lies in the node's local px (axis-aligned bounds of its corners). */
export function imageRect(transform: Matrix, width: number, height: number): Rect {
  const m = imageToLocal(transform, width, height);
  const points = [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}].map(p => apply(m, p));
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y};
}

/** The transform after moving the picture by `delta` local px. */
export function moveImage(transform: Matrix, delta: Vec, width: number, height: number): Matrix {
  const m = imageToLocal(transform, width, height);
  return fromImageToLocal(multiply([[1, 0, delta.x], [0, 1, delta.y]], m), width, height);
}

/**
 * The transform after dragging the picture's handle (hx, hy: −1, 0 or 1 per axis) to `point`
 * (local px). The opposite side stays put; corners keep the proportions unless `free`; the picture
 * never shrinks under a pixel or turns inside out.
 */
export function resizeImage(transform: Matrix, handle: {hx: -1 | 0 | 1; hy: -1 | 0 | 1}, point: Vec, width: number, height: number, options: {free?: boolean} = {}): Matrix {
  const r = imageRect(transform, width, height);
  if (r.width < EPS || r.height < EPS) return transform;
  let left = r.x, right = r.x + r.width, top = r.y, bottom = r.y + r.height;
  if (handle.hx === 1) right = Math.max(left + 1, point.x);
  if (handle.hx === -1) left = Math.min(right - 1, point.x);
  if (handle.hy === 1) bottom = Math.max(top + 1, point.y);
  if (handle.hy === -1) top = Math.min(bottom - 1, point.y);
  if (handle.hx && handle.hy && !options.free) {
    // Keep the aspect ratio: the larger change wins, the anchored corner stays.
    const k = Math.max((right - left) / r.width, (bottom - top) / r.height);
    const w = r.width * k, h = r.height * k;
    if (handle.hx === 1) right = left + w;
    else left = right - w;
    if (handle.hy === 1) bottom = top + h;
    else top = bottom - h;
  }
  const sx = (right - left) / r.width, sy = (bottom - top) / r.height;
  const map: Matrix = [[sx, 0, left - r.x * sx], [0, sy, top - r.y * sy]];
  return fromImageToLocal(multiply(map, imageToLocal(transform, width, height)), width, height);
}

/** Turns a CROP transform a quarter turn clockwise about the picture's centre (the picker's ↻). */
export function rotateCrop(transform: Matrix, width: number, height: number): Matrix {
  const m = imageToLocal(transform, width, height);
  const r = imageRect(transform, width, height);
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const turn: Matrix = [[0, -1, cx + cy], [1, 0, cy - cx]];
  return fromImageToLocal(multiply(turn, m), width, height);
}

// ── The tool ─────────────────────────────────────────────────────────────────────────────────────

const HANDLE = 8;
const REACH = 7;

type Drag =
  | {kind: 'move'; start: Vec; transform: Matrix; gesture: Gesture | null}
  | {kind: 'resize'; hx: -1 | 0 | 1; hy: -1 | 0 | 1; transform: Matrix; gesture: Gesture | null}
  | {kind: 'delegate'; tool: Tool};

function editedImage(store: DesignStore): {node: SceneNode; paint: ImagePaint; target: PaintEditTarget; transform: Matrix} | null {
  const target = paintEditSession.get();
  if (!target || target.kind !== 'crop') return null;
  const {doc} = store.getState();
  const node = doc.nodes[target.nodeId];
  const paint = sessionPaint(node, target);
  if (!node || paint?.type !== 'IMAGE') return null;
  const asset = doc.images[paint.imageRef];
  const transform = cropTransformFor(paint, node.width, node.height, asset?.width ?? node.width, asset?.height ?? node.height);
  return {node, paint, target, transform};
}

function localToScreen(store: DesignStore, view: ViewHelpers, id: NodeId): Matrix {
  return multiply(screenMatrix(view.viewport()), worldMatrix(store.getState().doc, id));
}

const HANDLES: {hx: -1 | 0 | 1; hy: -1 | 0 | 1}[] = [
  {hx: -1, hy: -1}, {hx: 0, hy: -1}, {hx: 1, hy: -1}, {hx: 1, hy: 0}, {hx: 1, hy: 1}, {hx: 0, hy: 1}, {hx: -1, hy: 1}, {hx: -1, hy: 0},
];
const CURSORS: Record<string, string> = {'-1,-1': 'nwse-resize', '1,1': 'nwse-resize', '1,-1': 'nesw-resize', '-1,1': 'nesw-resize', '0,-1': 'ns-resize', '0,1': 'ns-resize', '-1,0': 'ew-resize', '1,0': 'ew-resize'};

const handleLocal = (r: Rect, h: {hx: number; hy: number}): Vec => ({x: r.x + ((h.hx + 1) / 2) * r.width, y: r.y + ((h.hy + 1) / 2) * r.height});

export class ImageCropTool implements Tool {
  readonly id = CROP_TOOL;
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
    if (paintEditSession.get()?.kind === 'crop') paintEditSession.end({keepTool: true});
    this.ctx = null;
  }

  private hit(e: ToolPointerEvent, ctx: ToolContext): {kind: 'handle'; hx: -1 | 0 | 1; hy: -1 | 0 | 1} | {kind: 'inside'} | null {
    const edited = editedImage(ctx.store);
    if (!edited) return null;
    const m = localToScreen(ctx.store, ctx.view, edited.node.id);
    const r = imageRect(edited.transform, edited.node.width, edited.node.height);
    for (const handle of HANDLES) {
      const p = apply(m, handleLocal(r, handle));
      if (Math.hypot(p.x - e.screen.x, p.y - e.screen.y) <= REACH) return {kind: 'handle', ...handle};
    }
    const local = apply(invert(m), e.screen);
    if (local.x >= r.x && local.x <= r.x + r.width && local.y >= r.y && local.y <= r.y + r.height) return {kind: 'inside'};
    return null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    if (!drag) {
      const hit = this.hit(e, ctx);
      ctx.setCursor(!hit ? null : hit.kind === 'inside' ? 'move' : CURSORS[`${hit.hx},${hit.hy}`]);
      return;
    }
    if (drag.kind === 'delegate') return drag.tool.onPointerMove?.(e, ctx);
    const edited = editedImage(ctx.store);
    if (!edited) return;
    const {node, target} = edited;
    const toLocal = invert(localToScreen(ctx.store, ctx.view, node.id));
    const point = apply(toLocal, e.screen);
    let next: Matrix;
    if (drag.kind === 'move') {
      const start = apply(toLocal, drag.start);
      next = moveImage(drag.transform, {x: point.x - start.x, y: point.y - start.y}, node.width, node.height);
    } else {
      next = resizeImage(drag.transform, drag, point, node.width, node.height, {free: e.shiftKey});
    }
    drag.gesture ??= ctx.store.gesture('Crop image');
    drag.gesture.update(tx => {
      const current = tx.get(target.nodeId);
      const paint = sessionPaint(current, target);
      if (!current || paint?.type !== 'IMAGE') return;
      const list = [...current[target.field]];
      list[target.index] = {...paint, scaleMode: 'CROP', imageTransform: next};
      userUpdate(tx, target.nodeId, {[target.field]: list});
    });
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const edited = editedImage(ctx.store);
    const hit = edited ? this.hit(e, ctx) : null;
    if (!edited || !hit) {
      const tool = createTool('move');
      if (!tool) {
        paintEditSession.end();
        return;
      }
      this.drag = {kind: 'delegate', tool};
      tool.onPointerDown?.(e, ctx);
      return;
    }
    this.drag = hit.kind === 'inside'
      ? {kind: 'move', start: e.screen, transform: edited.transform, gesture: null}
      : {kind: 'resize', hx: hit.hx, hy: hit.hy, transform: edited.transform, gesture: null};
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

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      this.cancel();
      paintEditSession.end();
      return true;
    }
    // Backspace never deletes the layer under the crop.
    return e.code === 'Backspace' || e.code === 'Delete';
  }

  drawOverlay(c: CanvasRenderingContext2D, view: ViewHelpers) {
    const store = this.ctx?.store;
    if (!store) return;
    if (this.drag?.kind === 'delegate') this.drag.tool.drawOverlay?.(c, view);
    const edited = editedImage(store);
    if (!edited) return;
    const {node, paint, target, transform} = edited;
    const m = localToScreen(store, view, node.id);
    const r = imageRect(transform, node.width, node.height);
    c.save();
    // The picture outside the layer, ghosted: clip to the picture's box minus the layer's box.
    const source = target.image?.(paint.imageRef) ?? null;
    if (source) {
      c.save();
      c.setTransform(c.getTransform().multiply(new DOMMatrix([m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]])));
      c.beginPath();
      c.rect(r.x, r.y, r.width, r.height);
      c.rect(0, 0, node.width, node.height);
      c.clip('evenodd');
      const toLocal = imageToLocal(transform, node.width, node.height);
      c.transform(toLocal[0][0], toLocal[1][0], toLocal[0][1], toLocal[1][1], toLocal[0][2], toLocal[1][2]);
      c.globalAlpha = 0.4;
      c.drawImage(source, 0, 0, 1, 1);
      c.restore();
    }
    const outline = (rect: Rect, dash: number[]) => {
      const points = [{x: rect.x, y: rect.y}, {x: rect.x + rect.width, y: rect.y}, {x: rect.x + rect.width, y: rect.y + rect.height}, {x: rect.x, y: rect.y + rect.height}].map(p => apply(m, p));
      c.beginPath();
      points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.setLineDash(dash);
      c.strokeStyle = OVERLAY_COLORS.accent;
      c.lineWidth = 1;
      c.stroke();
    };
    outline({x: 0, y: 0, width: node.width, height: node.height}, []);
    outline(r, [4, 3]);
    c.setLineDash([]);
    for (const handle of HANDLES) {
      const p = apply(m, handleLocal(r, handle));
      c.beginPath();
      c.rect(Math.round(p.x - HANDLE / 2) + 0.5, Math.round(p.y - HANDLE / 2) + 0.5, HANDLE - 1, HANDLE - 1);
      c.fillStyle = OVERLAY_COLORS.handleFill;
      c.fill();
      c.strokeStyle = OVERLAY_COLORS.accent;
      c.stroke();
    }
    c.restore();
  }
}

export const createImageCropTool = () => new ImageCropTool();
