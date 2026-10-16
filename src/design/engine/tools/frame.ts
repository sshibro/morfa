import type {NodeId, Vec} from '../../../../shared/design/types';
import {worldBox} from '../../../../shared/design/geometry';
import {isFrameLikeNode} from '../../../../shared/design/tree';
import {quickAddFrame} from '../commands/edit';
import {OVERLAY_COLORS} from '../overlay';
import type {DesignStore} from '../store';
import {DrawTool} from './draw-common';
import type {ToolContext, ToolPointerEvent, ViewHelpers} from './types';

// "Frame" (F, A): draws a frame like a shape; a frame drawn around layers takes them in, and while the
// tool is on, the right panel lists device sizes to insert (src/design/panels/FramePresets.tsx). A click on the canvas
// makes a frame the size of the last top-level frame made in this session (100 × 100 the first time), as Figma's;
// a click inside a frame still makes 100 × 100. Hovering beside the middle of a top-level frame's left or right side shows
// a "+": a click on it puts a copy of the frame there and moves the frames beyond it over (Figma's quick-add).

/** Screen px of the "+": its radius, and how far out of the frame's side its centre stands. */
const PLUS_RADIUS = 10;
const PLUS_OUT = 18;
type Plus = {frameId: NodeId; side: 'left' | 'right'; at: Vec};

/** The size of the last top-level frame each open file made, for the next click on the canvas. */
const lastTopLevel = new WeakMap<DesignStore, {width: number; height: number}>();

class FrameTool extends DrawTool {
  private store: DesignStore | null = null;
  private plus: Plus | null = null;

  constructor() {
    super({id: 'frame', type: 'FRAME', adopt: true});
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    this.store = ctx.store;
    const plus = this.drawing ? null : this.plusAt(e, ctx);
    if (plus && e.button === 0) {
      this.plus = null;
      ctx.requestOverlay();
      quickAddFrame(ctx.store, plus.frameId, plus.side);
      ctx.setTool('move');
      return;
    }
    super.onPointerDown(e, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    if (!this.drawing) {
      const plus = this.plusAt(e, ctx);
      if (plus?.frameId !== this.plus?.frameId || plus?.side !== this.plus?.side) {
        this.plus = plus;
        ctx.setCursor(plus ? 'pointer' : null);
        ctx.requestOverlay();
      }
    }
    super.onPointerMove(e, ctx);
  }

  deactivate(ctx: ToolContext) {
    this.plus = null;
    super.deactivate(ctx);
  }

  /** The "+" under the pointer: beside the middle of a left or right side of a frame standing on the canvas. */
  private plusAt(e: ToolPointerEvent, ctx: ToolContext): Plus | null {
    const {doc, pageId} = ctx.store.getState();
    const pixel = ctx.view.pixel();
    for (const id of [...(doc.nodes[pageId]?.children ?? [])].reverse()) {
      const node = doc.nodes[id];
      if (!node?.visible || node.locked || !isFrameLikeNode(node)) continue;
      const box = worldBox(doc, id);
      for (const side of ['left', 'right'] as const) {
        const at = {x: side === 'left' ? box.x - PLUS_OUT * pixel : box.x + box.width + PLUS_OUT * pixel, y: box.y + box.height / 2};
        if (Math.hypot(e.page.x - at.x, e.page.y - at.y) <= PLUS_RADIUS * pixel) return {frameId: id, side, at};
      }
    }
    return null;
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const plus = this.plus;
    if (!plus) return;
    const p = view.pageToScreen(plus.at);
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, PLUS_RADIUS, 0, Math.PI * 2);
    ctx2d.fillStyle = OVERLAY_COLORS.accent;
    ctx2d.fill();
    ctx2d.strokeStyle = OVERLAY_COLORS.handleFill;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(p.x - 4.5, p.y);
    ctx2d.lineTo(p.x + 4.5, p.y);
    ctx2d.moveTo(p.x, p.y - 4.5);
    ctx2d.lineTo(p.x, p.y + 4.5);
    ctx2d.stroke();
    ctx2d.restore();
  }

  protected clickSize() {
    const store = this.store;
    const remembered = store && lastTopLevel.get(store);
    if (remembered && this.drawing?.parentId === store.getState().pageId) return {...remembered};
    return super.clickSize();
  }

  protected created(id: NodeId, ctx: ToolContext) {
    const {doc, pageId} = ctx.store.getState();
    const node = doc.nodes[id];
    if (node?.type === 'FRAME' && node.parentId === pageId) lastTopLevel.set(ctx.store, {width: node.width, height: node.height});
    super.created(id, ctx);
  }
}

export const createFrameTool = () => new FrameTool();
