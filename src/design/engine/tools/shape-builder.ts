import type {DesignDocument, Matrix, NodeId} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {SHAPE_BUILDER_TYPES, shapeBuilder, type ShapeBuilder} from '../../../../shared/design/shape-builder';
import {applyShapeBuilder} from '../commands/shape-builder';
import {OVERLAY_COLORS} from '../overlay';
import {editableStructure} from '../selection';
import {notify} from '../vector-edit/session';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';
import {touchTakesAway} from '../touch/shape-builder-mode';

// "Shape builder" on the canvas (Figma's Shape builder; the regions and the edits are shared/design/shape-builder.ts).
// The selected shapes show their regions; the one under the pointer is tinted. A click moves a region into a layer of its
// own, a drag across regions merges them into one, ⌥ (Alt) with a click or a drag takes them away. The tool stays on for
// the next cut, on the shapes that are left and the new layer; Escape goes back to "Move".

const DANGER = '#F24822';

type Built = {doc: DesignDocument; operands: readonly NodeId[]; builder: ShapeBuilder; toParent: Matrix; toPage: Matrix};

export class ShapeBuilderTool implements Tool {
  readonly id = 'shape-builder';
  readonly cursor = 'crosshair';
  private operands: NodeId[] = [];
  private built: Built | null = null;
  /** The document the builder last failed on: its message is shown once, not on every move. */
  private failed: DesignDocument | null = null;
  private hover = -1;
  private picked: number[] | null = null;
  private subtract = false;

  activate(ctx: ToolContext) {
    const {doc, selection} = ctx.store.getState();
    this.operands = editableStructure(doc, selection).filter(id => SHAPE_BUILDER_TYPES.has(doc.nodes[id]?.type));
    this.built = null;
    if (!this.current(ctx)) ctx.setTool('move');
    ctx.store.setHover(null);
  }

  deactivate(ctx: ToolContext) {
    this.built = null;
    this.picked = null;
    this.hover = -1;
    ctx.requestOverlay();
  }

  busy() {
    return !!this.picked;
  }

  overlayHints(): OverlayHints {
    return {hover: false, handles: false, sizeBadge: false};
  }

  /** The builder for the document as it is now (an undo or another person's edit rebuilds it), or null with a message. */
  private current(ctx: ToolContext): Built | null {
    const doc = ctx.store.getState().doc;
    if (this.built?.doc === doc) return this.built;
    if (this.failed === doc) return null;
    this.operands = this.operands.filter(id => doc.nodes[id]);
    const builder = shapeBuilder(doc, this.operands);
    if ('error' in builder) {
      notify(ctx.store, builder.error);
      this.built = null;
      this.failed = doc;
      return null;
    }
    const toPage = worldMatrix(doc, builder.parentId);
    this.built = {doc, operands: this.operands, builder, toPage, toParent: invert(toPage)};
    return this.built;
  }

  private regionAt(e: ToolPointerEvent, built: Built): number {
    return built.builder.hit(apply(built.toParent, e.page));
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const built = this.current(ctx);
    if (!built) {
      ctx.setTool('move');
      return;
    }
    const region = this.regionAt(e, built);
    // A finger has no ⌥: the phone's bar says whether it takes away (engine/touch/shape-builder-mode.ts).
    this.subtract = e.altKey || (e.pointerType === 'touch' && touchTakesAway(ctx.store));
    this.picked = region >= 0 ? [region] : [];
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const built = this.current(ctx);
    if (!built) return;
    const region = this.regionAt(e, built);
    if (this.picked && region >= 0 && !this.picked.includes(region)) this.picked.push(region);
    if (region !== this.hover || this.picked) {
      this.hover = region;
      ctx.requestOverlay();
    }
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext) {
    const picked = this.picked;
    this.picked = null;
    ctx.requestOverlay();
    const built = this.built;
    if (!picked?.length || !built || built.doc !== ctx.store.getState().doc) return;
    const mode = this.subtract ? 'subtract' : 'merge';
    const plan = built.builder.plan(picked, mode);
    if (!plan) return;
    this.operands = applyShapeBuilder(ctx.store, built.builder.parentId, built.operands, plan, mode);
    this.built = null;
    this.hover = -1;
    if (!this.operands.length) {
      ctx.setTool('move');
      return;
    }
    // The pieces left are cut again at once, so the next region shows before the pointer moves.
    this.current(ctx);
    ctx.requestOverlay();
  }

  onPointerCancel(ctx: ToolContext) {
    this.picked = null;
    ctx.requestOverlay();
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext) {
    if (e.code !== 'Escape') return false;
    if (this.picked) this.picked = null;
    else ctx.setTool('move');
    ctx.requestOverlay();
    return true;
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const built = this.built;
    if (!built) return;
    const {regions} = built.builder;
    const trace = (k: number) => {
      ctx2d.beginPath();
      for (const ring of regions[k].polygon) {
        ring.forEach(([x, y], i) => {
          const q = view.pageToScreen(apply(built.toPage, {x, y}));
          if (i) ctx2d.lineTo(q.x, q.y);
          else ctx2d.moveTo(q.x, q.y);
        });
        ctx2d.closePath();
      }
    };
    ctx2d.save();
    // Every region's outline, so the pieces read before the pointer finds them.
    ctx2d.strokeStyle = OVERLAY_COLORS.accent;
    ctx2d.lineWidth = 1;
    ctx2d.setLineDash([3, 3]);
    for (let k = 0; k < regions.length; k++) {
      trace(k);
      ctx2d.stroke();
    }
    ctx2d.setLineDash([]);
    const tinted = new Set(this.picked ?? []);
    if (this.hover >= 0) tinted.add(this.hover);
    const color = this.subtract && this.picked ? DANGER : OVERLAY_COLORS.accent;
    for (const k of tinted) {
      if (!regions[k]) continue;
      trace(k);
      ctx2d.fillStyle = color === DANGER ? 'rgba(242, 72, 34, 0.25)' : 'rgba(13, 153, 255, 0.25)';
      ctx2d.fill('evenodd');
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = 2;
      ctx2d.stroke();
    }
    ctx2d.restore();
  }
}

export const createShapeBuilderTool = () => new ShapeBuilderTool();

