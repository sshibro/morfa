import type {Vec} from '../../../../shared/design/types';
import type {Viewport} from '../contracts';
import {panBy} from '../viewport';
import type {Tool, ToolContext, ToolPointerEvent} from './types';

// "Hand" (H): drags the canvas. The canvas also pans this way while Space is held and with the
// middle mouse button in any tool (CanvasView.tsx); this module is the shared drag.

export class PanDrag {
  private start: {screen: Vec; viewport: Viewport} | null = null;

  get active() {
    return !!this.start;
  }

  begin(e: ToolPointerEvent, ctx: ToolContext) {
    this.start = {screen: e.screen, viewport: ctx.view.viewport()};
  }

  move(e: ToolPointerEvent, ctx: ToolContext) {
    if (!this.start) return;
    ctx.view.setViewport(panBy(this.start.viewport, e.screen.x - this.start.screen.x, e.screen.y - this.start.screen.y));
  }

  end() {
    this.start = null;
  }
}

export class HandTool implements Tool {
  readonly id = 'hand';
  readonly cursor = 'grab';
  private readonly pan = new PanDrag();

  busy() {
    return this.pan.active;
  }

  overlayHints() {
    return {hover: false};
  }

  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    this.pan.begin(e, ctx);
    ctx.setCursor('grabbing');
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    this.pan.move(e, ctx);
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext) {
    this.pan.end();
    ctx.setCursor(null);
  }

  onPointerCancel(ctx: ToolContext) {
    this.pan.end();
    ctx.setCursor(null);
  }
}

export const createHandTool = () => new HandTool();
