import type {DesignDocument, NodeId, Vec} from '../../../../shared/design/types';
import {apply, boundsOfPoints, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {HIT_TOLERANCE_PX, nodesInRect, pickAt, type SpatialIndex} from '../hit-test';
import {OVERLAY_COLORS} from '../overlay';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';

// "Lasso" (Q; Figma Draw's lasso): a freehand loop selects the layers it touches, as the marquee does with a box
// (`nodesInRect` decides which layers are candidates: the scope's children, a frame on the canvas only when it lies
// wholly inside). Shift adds to the selection; a click without a drag picks the layer under it, or clears. Escape
// drops a loop in progress. Points of a vector being edited are not lasso-selected yet (docs/design-tool.md says so).

/** Screen px between kept points of the loop. */
const SAMPLE_PX = 3;

type Quad = [Vec, Vec, Vec, Vec];

function insidePolygon(polygon: readonly Vec[], p: Vec): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const cross = (o: Vec, p: Vec, q: Vec) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Whether a closed loop and a layer's box (its four corners on the page) touch: one inside the other, or edges cross. */
export function loopTouchesQuad(loop: readonly Vec[], quad: Quad): boolean {
  if (loop.length < 3) return false;
  if (quad.some(corner => insidePolygon(loop, corner))) return true;
  if (insidePolygon(quad, loop[0])) return true;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    for (let k = 0; k < 4; k++) if (segmentsCross(a, b, quad[k], quad[(k + 1) % 4])) return true;
  }
  return false;
}

/** Whether a layer's box lies wholly inside the loop. */
export const loopContainsQuad = (loop: readonly Vec[], quad: Quad) => quad.every(corner => insidePolygon(loop, corner));

/** What a loop drawn on the page selects: the marquee's candidates for its bounds that the loop touches (frames on the
 *  canvas only when it holds them whole, as the marquee takes them). */
export function nodesInLoop(doc: DesignDocument, pageId: NodeId, loop: readonly Vec[], options: {context?: NodeId | null; index?: SpatialIndex | null} = {}): NodeId[] {
  if (loop.length < 3) return [];
  const bounds: Rect = boundsOfPoints(loop);
  const candidates = nodesInRect(doc, pageId, bounds, {context: options.context ?? null, index: options.index ?? null});
  return candidates.filter(id => {
    const node = doc.nodes[id];
    if (!node) return false;
    const m = worldMatrix(doc, id);
    const quad: Quad = [apply(m, {x: 0, y: 0}), apply(m, {x: node.width, y: 0}), apply(m, {x: node.width, y: node.height}), apply(m, {x: 0, y: node.height})];
    const frameOnCanvas = (node.type === 'FRAME' || node.type === 'SECTION' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.parentId === pageId;
    return frameOnCanvas ? loopContainsQuad(loop, quad) : loopTouchesQuad(loop, quad);
  });
}

export class LassoTool implements Tool {
  readonly id = 'lasso';
  readonly cursor = 'crosshair';
  private loop: Vec[] | null = null;
  private lastScreen: Vec | null = null;
  private additive = false;
  private moved = false;

  busy() {
    return !!this.loop;
  }

  overlayHints(): OverlayHints {
    return this.loop ? {hover: false, handles: false, sizeBadge: false} : {};
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    this.loop = [e.page];
    this.lastScreen = e.screen;
    this.additive = e.shiftKey;
    this.moved = false;
    ctx.store.setHover(null);
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    if (!this.loop || !this.lastScreen) return;
    if (Math.hypot(e.screen.x - this.lastScreen.x, e.screen.y - this.lastScreen.y) < SAMPLE_PX) return;
    this.loop.push(e.page);
    this.lastScreen = e.screen;
    this.moved = true;
    ctx.requestOverlay();
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const loop = this.loop;
    this.loop = null;
    this.lastScreen = null;
    ctx.requestOverlay();
    if (!loop) return;
    const {store} = ctx;
    const state = store.getState();
    let hits: NodeId[];
    if (!this.moved || loop.length < 3) {
      const picked = pickAt(state.doc, state.pageId, e.page, {context: state.context, tolerance: HIT_TOLERANCE_PX * ctx.view.pixel(), index: ctx.index()});
      hits = picked ? [picked] : [];
    } else hits = nodesInLoop(state.doc, state.pageId, loop, {context: state.context, index: ctx.index()});
    if (this.additive) {
      const seen = new Set(state.selection);
      store.setSelection([...state.selection, ...hits.filter(id => !seen.has(id))]);
    } else store.setSelection(hits);
  }

  onPointerCancel(ctx: ToolContext) {
    this.loop = null;
    ctx.requestOverlay();
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext) {
    if (e.code !== 'Escape' || !this.loop) return false;
    this.loop = null;
    ctx.requestOverlay();
    return true;
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const loop = this.loop;
    if (!loop || loop.length < 2) return;
    ctx2d.save();
    ctx2d.beginPath();
    loop.forEach((p, i) => {
      const q = view.pageToScreen(p);
      if (i) ctx2d.lineTo(q.x, q.y);
      else ctx2d.moveTo(q.x, q.y);
    });
    ctx2d.closePath();
    ctx2d.fillStyle = OVERLAY_COLORS.marqueeFill;
    ctx2d.fill();
    ctx2d.strokeStyle = OVERLAY_COLORS.accent;
    ctx2d.lineWidth = 1;
    ctx2d.setLineDash([4, 3]);
    ctx2d.stroke();
    ctx2d.restore();
  }
}

export const createLassoTool = () => new LassoTool();
