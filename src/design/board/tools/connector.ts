import type {NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {createConnector, insertPieces} from '../../../../shared/design/board/create';
import type {ConnectorEnd, ConnectorLine} from '../../../../shared/design/board/types';
import type {Gesture} from '../../engine/store';
import type {Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from '../../engine/tools/types';
import {boardChoices, connectorLook} from '../state';
import {BOARD_ACCENT, endAt, replayIds, sideMiddles} from './common';

// "Connector" (X; L draws a plain line): a drag from an object (or anywhere) to an object (or anywhere) makes a connector whose
// ends stay on those objects when they move (docs/board.md §Connectors). Near a side's middle an end snaps to that side; elsewhere
// on an object it takes the side facing the other end. Shift draws a straight one. The new connector is selected and the tool hands
// back to "Move". The board's "Move" starts the same drag from the dots around a hovered sticky or shape.

const DRAG_PX = 4;

export type ConnectorStyle = {line?: ConnectorLine; endArrow?: boolean};

/** One connector being drawn: from its start to the pointer, live, one undo step. */
export class ConnectorDrag {
  private gesture: Gesture | null = null;
  private readonly ids = replayIds();
  /** The object the free end is over (drawn highlighted). */
  target: SceneNode | null = null;
  private last: Vec;

  constructor(private readonly ctx: ToolContext, readonly start: ConnectorEnd, readonly from: Vec, private readonly style: ConnectorStyle = {}) {
    this.last = from;
  }

  get active() {
    return !!this.gesture;
  }

  update(page: Vec, straight: boolean, anywhere = false) {
    this.last = page;
    const state = this.ctx.store.getState();
    const exclude = new Set<NodeId>('node' in this.start ? [this.start.node] : []);
    const {end, object} = endAt(state, page, this.ctx, exclude, anywhere);
    this.target = object;
    const line: ConnectorLine = straight ? 'straight' : this.style.line ?? boardChoices().line;
    this.gesture ??= this.ctx.store.gesture('Connector');
    const pageId = state.pageId;
    this.gesture.update(tx => {
      this.ids.reset();
      const build = createConnector(this.ids.next, {...connectorLook(), start: this.start, end, line, ...(this.style.endArrow === false ? {endMarker: 'NONE' as const} : {})});
      insertPieces(tx, build, pageId);
      return {select: [build.id]};
    });
    this.ctx.requestOverlay();
  }

  refresh(straight: boolean) {
    if (this.gesture) this.update(this.last, straight);
  }

  commit(): boolean {
    const done = !!this.gesture?.commit();
    this.gesture = null;
    this.target = null;
    return done;
  }

  cancel() {
    this.gesture?.cancel();
    this.gesture = null;
    this.target = null;
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    if (this.target) drawMagnets(ctx2d, view, this.ctx, this.target.id);
  }
}

/** The four magnets of an object (where an end may sit), small rings in the board's accent. */
export function drawMagnets(ctx2d: CanvasRenderingContext2D, view: ViewHelpers, ctx: Pick<ToolContext, 'store'>, id: NodeId, filled = false) {
  const doc = ctx.store.getState().doc;
  ctx2d.save();
  ctx2d.lineWidth = 1.5;
  for (const side of sideMiddles(doc, id)) {
    const at = view.pageToScreen(side.at);
    ctx2d.beginPath();
    ctx2d.arc(at.x, at.y, 4.5, 0, Math.PI * 2);
    ctx2d.fillStyle = filled ? BOARD_ACCENT : '#FFFFFF';
    ctx2d.strokeStyle = BOARD_ACCENT;
    ctx2d.fill();
    ctx2d.stroke();
  }
  ctx2d.restore();
}

export class ConnectorTool implements Tool {
  readonly cursor = 'crosshair';
  private press: {down: ToolPointerEvent; drag: ConnectorDrag} | null = null;
  private hovered: SceneNode | null = null;

  constructor(readonly id: string, private readonly style: ConnectorStyle = {}) {}

  busy() {
    return !!this.press?.drag.active;
  }

  overlayHints() {
    return {hover: false, handles: false};
  }

  deactivate(ctx: ToolContext) {
    this.press?.drag.cancel();
    this.press = null;
    this.hovered = null;
    ctx.requestOverlay();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const {end} = endAt(ctx.store.getState(), e.page, ctx);
    this.press = {down: e, drag: new ConnectorDrag(ctx, end, e.page, this.style)};
    this.hovered = null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    if (!press) {
      const {object} = endAt(ctx.store.getState(), e.page, ctx);
      if (object?.id !== this.hovered?.id) {
        this.hovered = object;
        ctx.requestOverlay();
      }
      return;
    }
    if (!press.drag.active && Math.hypot(e.screen.x - press.down.screen.x, e.screen.y - press.down.screen.y) < DRAG_PX) return;
    press.drag.update(e.page, e.shiftKey, e.mod);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    this.press = null;
    if (!press || e.button !== 0) return;
    if (press.drag.active) {
      press.drag.update(e.page, e.shiftKey, e.mod);
      press.drag.commit();
      ctx.setTool('move');
    }
    ctx.requestOverlay();
  }

  onPointerCancel(ctx: ToolContext) {
    this.press?.drag.cancel();
    this.press = null;
    ctx.requestOverlay();
  }

  onKeyDown(e: ToolKeyEvent) {
    if (this.press?.drag.active && e.code.startsWith('Shift')) {
      this.press.drag.refresh(true);
      return true;
    }
    if (e.code === 'Escape' && this.press?.drag.active) {
      this.press.drag.cancel();
      this.press = null;
      return true;
    }
    return false;
  }

  onKeyUp(e: ToolKeyEvent) {
    if (this.press?.drag.active && e.code.startsWith('Shift')) {
      this.press.drag.refresh(false);
      return true;
    }
    return false;
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    if (this.press?.drag.active) this.press.drag.drawOverlay(ctx2d, view);
    else if (this.hovered && this.press === null) drawHoverTarget(ctx2d, view, this.hovered, this.lastCtx);
  }

  private lastCtx: Pick<ToolContext, 'store'> | null = null;
  activate(ctx: ToolContext) {
    this.lastCtx = ctx;
    ctx.store.setHover(null);
  }
}

function drawHoverTarget(ctx2d: CanvasRenderingContext2D, view: ViewHelpers, node: SceneNode, ctx: Pick<ToolContext, 'store'> | null) {
  if (!ctx) return;
  drawMagnets(ctx2d, view, ctx, node.id);
}

export const createConnectorTool = () => new ConnectorTool('board-connector');
/** "Line" (L): a straight connector without an arrowhead. */
export const createLineTool = () => new ConnectorTool('board-line', {line: 'straight', endArrow: false});
