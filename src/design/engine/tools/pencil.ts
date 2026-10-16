import type {NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {BLACK, createNode, newId, solid} from '../../../../shared/design/defaults';
import {anchorKind, fitCubics, type Anchor} from '../../../../shared/design/paths';
import {frameAtPoint} from '../../../../shared/design/tree';
import type {DesignStore} from '../store';
import {CURSORS} from '../vector-edit/draw';
import type {Network} from '../vector-edit/model';
import {writeNetwork} from '../vector-edit/session';
import type {OverlayHints, Tool, ToolContext, ToolPointerEvent, ViewHelpers} from './types';

// "Pencil" (⇧P): a freehand stroke, shown live on the overlay as it is drawn, becomes a smooth
// VECTOR of a few cubics when the button goes up (shared/design/paths.ts `fitCubics`, Schneider's
// fit). The fit's tolerance is a couple of screen pixels, so a stroke drawn zoomed out is as clean
// as one drawn zoomed in. The stroke is 2 px black with round ends and joins, no fill; the pencil
// stays active for the next stroke, the new one selected.

/** Screen px between kept samples: finer adds noise, not detail. */
const SAMPLE_PX = 1.5;
/** Screen px the fitted curve may stray from the samples. */
const FIT_TOLERANCE_PX = 2;
export const PENCIL_WEIGHT = 2;

/** The drawn samples in the parent's space → the network of a smooth open path. */
export function pencilNetwork(points: readonly Vec[], tolerance: number): Network | null {
  if (points.length < 2) return null;
  const cubics = fitCubics(points, tolerance);
  if (!cubics.length) return null;
  const anchors: Anchor[] = [{x: cubics[0][0].x, y: cubics[0][0].y, in: null, out: null, kind: 'corner'}];
  for (const [, c1, c2, p] of cubics) {
    anchors[anchors.length - 1].out = {x: c1.x, y: c1.y};
    anchors.push({x: p.x, y: p.y, in: {x: c2.x, y: c2.y}, out: null, kind: 'corner'});
  }
  for (const anchor of anchors) anchor.kind = anchorKind(anchor);
  return [{windingRule: 'NONZERO', subs: [{closed: false, anchors}]}];
}

/** The pencil's stroke as a new node in `parentId` (points in that parent's space). `extra`: fields of the new layer
 *  (the brush's weight and width profile), `label` its undo step. */
export function pencilStroke(store: DesignStore, parentId: NodeId, points: readonly Vec[], tolerance: number, extra: Partial<SceneNode> = {}, label = 'Pencil'): NodeId | null {
  const network = pencilNetwork(points, tolerance);
  if (!network) return null;
  const parent = store.getState().doc.nodes[parentId];
  if (!parent) return null;
  const id = newId();
  const absolute = !!parent.autoLayout && parent.autoLayout.layoutMode !== 'NONE';
  const props: Partial<SceneNode> & {id: NodeId} = {
    id, parentId, x: 0, y: 0, width: 0, height: 0, vectorPaths: [], fills: [], strokes: [solid(BLACK)], strokeWeight: PENCIL_WEIGHT,
    strokeCap: 'ROUND', strokeJoin: 'ROUND', ...(absolute ? {layoutPositioning: 'ABSOLUTE' as const} : {}), ...extra,
  };
  store.transact(label, tx => {
    tx.create(createNode('VECTOR', props), parentId);
    writeNetwork(tx, id, network);
  }, {select: [id]});
  return store.getState().doc.nodes[id] ? id : null;
}

export class PencilTool implements Tool {
  readonly id = 'pencil';
  readonly cursor = CURSORS.pencil;
  /** The stroke being drawn, in page space. */
  private points: Vec[] | null = null;
  private lastScreen: Vec | null = null;

  busy() {
    return !!this.points;
  }

  overlayHints(): OverlayHints {
    return {hover: false, sizeBadge: !this.points};
  }

  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
  }

  deactivate(ctx: ToolContext) {
    this.points = null;
    ctx.requestOverlay();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    this.points = [e.page];
    this.lastScreen = e.screen;
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    if (!this.points || !this.lastScreen) return;
    if (Math.hypot(e.screen.x - this.lastScreen.x, e.screen.y - this.lastScreen.y) < SAMPLE_PX) return;
    this.points.push(e.page);
    this.lastScreen = e.screen;
    ctx.requestOverlay();
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const points = this.points;
    this.points = null;
    this.lastScreen = null;
    if (!points) return;
    if (points.length > 1 && (points[points.length - 1].x !== e.page.x || points[points.length - 1].y !== e.page.y)) points.push(e.page);
    ctx.requestOverlay();
    if (points.length < 2) return;
    const state = ctx.store.getState();
    const parentId = frameAtPoint(state.doc, state.pageId, points[0], new Set(), ctx.index()) ?? state.pageId;
    const toParent = invert(worldMatrix(state.doc, parentId));
    pencilStroke(ctx.store, parentId, points.map(p => apply(toParent, p)), FIT_TOLERANCE_PX * ctx.view.pixel());
  }

  onPointerCancel(ctx: ToolContext) {
    this.points = null;
    ctx.requestOverlay();
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const points = this.points;
    if (!points || points.length < 2) return;
    const zoom = view.viewport().zoom;
    ctx2d.save();
    ctx2d.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = view.pageToScreen(points[i]);
      if (i) ctx2d.lineTo(p.x, p.y);
      else ctx2d.moveTo(p.x, p.y);
    }
    // The stroke as it will be: 2 px of black at this zoom, round ends.
    ctx2d.strokeStyle = '#000000';
    ctx2d.lineWidth = Math.max(1, PENCIL_WEIGHT * zoom);
    ctx2d.lineCap = 'round';
    ctx2d.lineJoin = 'round';
    ctx2d.stroke();
    ctx2d.restore();
  }
}

export const createPencilTool = () => new PencilTool();
