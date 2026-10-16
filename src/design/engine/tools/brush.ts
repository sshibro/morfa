import type {SceneNode, VariableWidthStrokeProperties, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {BLACK, createNode, solid} from '../../../../shared/design/defaults';
import {polylineToCommands} from '../../../../shared/design/paths';
import {variableWidthOutline} from '../../../../shared/design/stroke-profile';
import {frameAtPoint} from '../../../../shared/design/tree';
import {CURSORS} from '../vector-edit/draw';
import {pencilStroke} from './pencil';
import type {OverlayHints, Tool, ToolContext, ToolPointerEvent, ViewHelpers} from './types';

// "Brush" (B; Figma Draw's brush, as far as the renderer draws it exactly): a freehand stroke like "Pencil", smoothed
// before it is fitted, whose width follows a profile (shared/design/stroke-profile.ts). It ignores a pen's pressure, as
// Figma's brush does: the profile is the last preset chosen in Stroke → Width profile (at first "Taper both ends"), and the panel changes it afterwards like any line's. The live stroke on the overlay is the same outline the
// layer will have.

/** Screen px between kept samples. */
const SAMPLE_PX = 1.5;
/** Screen px the fitted curve may stray from the smoothed samples (a little looser than the pencil's 2). */
const FIT_TOLERANCE_PX = 2.5;
/** Smoothing passes over the samples before the fit. */
const SMOOTHING_PASSES = 3;
export const BRUSH_WEIGHT = 6;

const DEFAULT_PROFILE: VariableWidthStrokeProperties = {widthProfile: 'MIRRORED_TAPER'};
let remembered: VariableWidthStrokeProperties = DEFAULT_PROFILE;
/** The preset the brush draws with ("Stroke" calls this when a preset other than "Uniform" is picked). */
export function rememberBrushProfile(profile: VariableWidthStrokeProperties) {
  if (profile.widthProfile !== 'CUSTOM' && profile.widthProfile !== 'UNIFORM') remembered = {widthProfile: profile.widthProfile};
}
export const brushProfile = (): VariableWidthStrokeProperties => ({...remembered});

/** The hand's jitter taken out of a drawn stroke: passes of a [1, 2, 1] average over the samples, the two ends kept
 *  where they were drawn. A stroke of fewer than three samples is returned as it is. */
export function smoothStroke(points: readonly Vec[], passes = SMOOTHING_PASSES): Vec[] {
  let out = points.map(p => ({x: p.x, y: p.y}));
  if (out.length < 3) return out;
  for (let pass = 0; pass < passes; pass++) {
    const next = out.map(p => ({...p}));
    for (let i = 1; i < out.length - 1; i++) {
      next[i] = {x: (out[i - 1].x + 2 * out[i].x + out[i + 1].x) / 4, y: (out[i - 1].y + 2 * out[i].y + out[i + 1].y) / 4};
    }
    out = next;
  }
  return out;
}

export class BrushTool implements Tool {
  readonly id = 'brush';
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
    ctx.requestOverlay();
    if (!points) return;
    const last = points[points.length - 1];
    if (points.length > 1 && (last.x !== e.page.x || last.y !== e.page.y)) points.push(e.page);
    if (points.length < 2) return;
    const state = ctx.store.getState();
    const parentId = frameAtPoint(state.doc, state.pageId, points[0], new Set(), ctx.index()) ?? state.pageId;
    const toParent = invert(worldMatrix(state.doc, parentId));
    pencilStroke(ctx.store, parentId, smoothStroke(points).map(p => apply(toParent, p)), FIT_TOLERANCE_PX * ctx.view.pixel(),
      {name: 'Brush', strokeWeight: BRUSH_WEIGHT, strokeAlign: 'CENTER', variableWidthStrokeProperties: brushProfile()}, 'Brush');
  }

  onPointerCancel(ctx: ToolContext) {
    this.points = null;
    ctx.requestOverlay();
  }

  /** The stroke as it will be: its width profile's outline, in the layer's black, at this zoom. */
  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const points = this.points;
    if (!points || points.length < 2) return;
    const screen = smoothStroke(points).map(p => view.pageToScreen(p));
    const zoom = view.viewport().zoom;
    const preview: SceneNode = createNode('VECTOR', {
      id: 'brush-preview', parentId: null, strokes: [solid(BLACK)], strokeWeight: BRUSH_WEIGHT * zoom, strokeCap: 'ROUND', strokeJoin: 'ROUND',
      vectorPaths: [{windingRule: 'NONZERO', commands: polylineToCommands(screen, false)}],
      variableWidthStrokeProperties: brushProfile(),
    });
    const outline = variableWidthOutline(preview);
    if (!outline.length) return;
    ctx2d.save();
    ctx2d.fillStyle = '#000000';
    ctx2d.beginPath();
    for (const c of outline[0].commands) {
      if (c.type === 'M') ctx2d.moveTo(c.x, c.y);
      else if (c.type === 'L') ctx2d.lineTo(c.x, c.y);
      else if (c.type === 'Z') ctx2d.closePath();
    }
    ctx2d.fill('nonzero');
    ctx2d.restore();
  }
}

export const createBrushTool = () => new BrushTool();
