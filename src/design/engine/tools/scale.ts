import type {DesignDocument, NodeId, Vec} from '../../../../shared/design/types';
import {apply, invert} from '../../../../shared/design/geometry';
import {scaleUpdates} from '../../../../shared/design/constraints';
import {drawLabel, OVERLAY_COLORS} from '../overlay';
import {formatNumber, movableSelection, selectionBox, type SelectionBox} from '../selection';
import type {Gesture} from '../store';
import {MoveTool} from './move';
import {hitHandle, resizeEdges} from './transform';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';

// "Scale" (K): the handles scale the selection proportionally with everything in it, stroke weights,
// corner radii, effects, type and spacing included (shared/design/constraints.ts `scaleUpdates`), about
// the opposite side, or about the centre with Alt. Everything else (picking, moving, the marquee)
// works as in "Move", which this tool keeps inside and hands those presses to.

const DRAG_THRESHOLD = 3;
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight']);

type Handle = {hx: -1 | 0 | 1; hy: -1 | 0 | 1};
type Pending = {kind: 'pending'; down: ToolPointerEvent; last: ToolPointerEvent; handle: Handle};
type Scaling = {kind: 'scale'; down: ToolPointerEvent; last: ToolPointerEvent; handle: Handle; gesture: Gesture; doc: DesignDocument; ids: NodeId[]; box: SelectionBox; start: Vec};

/** The uniform factor a handle dragged to `local` (the box's space, from `start`) gives, and the
 *  page point the selection scales about. */
export function scaleFromHandle(box: SelectionBox, handle: Handle, start: Vec, local: Vec, fromCenter: boolean): {factor: number; origin: Vec} {
  const edges = resizeEdges(box.width, box.height, handle, {x: local.x - start.x, y: local.y - start.y}, {keepRatio: true, fromCenter});
  const horizontal = handle.hx !== 0 && box.width > 0;
  const span = horizontal ? Math.abs(edges.right - edges.left) : Math.abs(edges.bottom - edges.top);
  const base = horizontal ? box.width : box.height;
  const factor = Math.max(0.01, base > 0 ? span / base : 1);
  const fixed = (dir: -1 | 0 | 1, size: number) => (fromCenter || dir === 0 ? size / 2 : dir === 1 ? 0 : size);
  const origin = apply(box.matrix, {x: fixed(handle.hx, box.width), y: fixed(handle.hy, box.height)});
  return {factor, origin};
}

export class ScaleTool implements Tool {
  readonly id = 'scale';
  readonly cursor = 'default';
  private readonly move = new MoveTool();
  private drag: Pending | Scaling | null = null;
  private label: {at: Vec; text: string} | null = null;

  busy() {
    return this.drag?.kind === 'scale' || this.move.busy();
  }

  overlayHints(): OverlayHints {
    if (this.drag?.kind === 'scale') return {hover: false, handles: true};
    const inner = this.move.overlayHints();
    return {...inner, handles: inner.handles ?? true};
  }

  deactivate(ctx: ToolContext) {
    this.cancel(ctx);
    this.move.deactivate(ctx);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const state = ctx.store.getState();
    const ids = movableSelection(state.doc, state.selection);
    const box = ids.length ? selectionBox(state.doc, ids) : null;
    const hit = box ? hitHandle(state.doc, box, e.screen, ctx.view.viewport(), {rotate: false}) : null;
    if (hit?.kind === 'resize') {
      this.drag = {kind: 'pending', down: e, last: e, handle: {hx: hit.hx, hy: hit.hy}};
      return;
    }
    if (hit?.kind === 'endpoint') {
      this.drag = {kind: 'pending', down: e, last: e, handle: {hx: hit.end ? 1 : -1, hy: 0}};
      return;
    }
    this.move.onPointerDown(e, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    if (!drag) {
      this.move.onPointerMove(e, ctx);
      return;
    }
    drag.last = e;
    if (drag.kind === 'pending') {
      if (Math.hypot(e.screen.x - drag.down.screen.x, e.screen.y - drag.down.screen.y) < DRAG_THRESHOLD) return;
      const state = ctx.store.getState();
      const ids = movableSelection(state.doc, state.selection);
      const box = selectionBox(state.doc, ids);
      if (!box) {
        this.drag = null;
        return;
      }
      this.drag = {...drag, kind: 'scale', gesture: ctx.store.gesture('Scale'), doc: state.doc, ids, box, start: apply(invert(box.matrix), drag.down.page)};
    }
    this.update(ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    if (!drag) {
      this.move.onPointerUp(e, ctx);
      return;
    }
    this.drag = null;
    this.label = null;
    if (drag.kind === 'scale') drag.gesture.commit();
    ctx.requestOverlay();
  }

  onPointerCancel(ctx: ToolContext) {
    if (this.drag) this.cancel(ctx);
    else this.move.onPointerCancel(ctx);
  }

  onDoubleClick(e: ToolPointerEvent, ctx: ToolContext) {
    this.move.onDoubleClick(e, ctx);
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (this.drag) {
      if (e.code === 'Escape') {
        this.cancel(ctx);
        return true;
      }
      if (MODIFIER_CODES.has(e.code)) this.refresh(ctx);
      return false;
    }
    return this.move.onKeyDown(e, ctx);
  }

  onKeyUp(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (this.drag) {
      if (MODIFIER_CODES.has(e.code)) this.refresh(ctx);
      return false;
    }
    return this.move.onKeyUp(e, ctx);
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    if (!this.drag) this.move.drawOverlay(ctx2d, view);
    if (this.label) drawLabel(ctx2d, {x: this.label.at.x + 16, y: this.label.at.y + 16}, this.label.text, {background: OVERLAY_COLORS.accent});
  }

  private refresh(ctx: ToolContext) {
    if (this.drag?.kind !== 'scale') return;
    const held = ctx.modifiers();
    this.drag.last = {...this.drag.last, shiftKey: held.shift, altKey: held.alt};
    this.update(ctx);
  }

  private update(ctx: ToolContext) {
    const drag = this.drag;
    if (drag?.kind !== 'scale') return;
    const e = drag.last;
    const local = apply(invert(drag.box.matrix), e.page);
    const {factor, origin} = scaleFromHandle(drag.box, drag.handle, drag.start, local, e.altKey);
    const updates = scaleUpdates(drag.doc, drag.ids, origin, factor, factor);
    drag.gesture.update(tx => {
      for (const [id, partial] of updates) tx.update(id, partial);
    });
    this.label = {at: e.screen, text: `${formatNumber(factor * 100)}%`};
    ctx.requestOverlay();
  }

  private cancel(ctx: ToolContext) {
    const drag = this.drag;
    this.drag = null;
    this.label = null;
    if (drag?.kind === 'scale') drag.gesture.cancel();
    ctx.requestOverlay();
  }
}

export const createScaleTool = () => new ScaleTool();
