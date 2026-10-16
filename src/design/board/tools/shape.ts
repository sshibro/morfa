import type {NodeId, Vec} from '../../../../shared/design/types';
import {createShape, insertPieces} from '../../../../shared/design/board/create';
import {childPart} from '../../../../shared/design/board/model';
import {boardShapeGeometry} from '../../../../shared/design/board/shapes';
import type {BoardShapeKind} from '../../../../shared/design/board/types';
import {dragRect} from '../../engine/tools/draw-common';
import type {Gesture} from '../../engine/store';
import type {Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from '../../engine/tools/types';
import {boardChoices} from '../state';
import {placement, replayIds} from './common';

// "Shapes" (R square, O ellipse, or the shape chosen in the tray): a drag draws the shape (Shift keeps it square, Alt from its
// centre), a click makes a 200 × 200 one centred on the pointer. The new shape is selected, the tool hands back to "Move"
// and the shape's text is open for typing (docs/board.md §Shapes).

const DRAG_PX = 3;
const CLICK_SIZE = 200;
const MIN_SIZE = 16;

type Press = {down: ToolPointerEvent; last: ToolPointerEvent; parentId: NodeId; origin: Vec; gesture: Gesture | null};

export class ShapeTool implements Tool {
  readonly id = 'board-shape';
  readonly cursor = 'crosshair';
  private press: Press | null = null;
  private hover: Vec | null = null;
  private ids = replayIds();

  constructor(private readonly fixed?: BoardShapeKind) {}

  private kind(): BoardShapeKind {
    return this.fixed ?? boardChoices().shape;
  }

  busy() {
    return !!this.press?.gesture;
  }

  overlayHints() {
    return {hover: false, handles: false};
  }

  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
  }

  deactivate(ctx: ToolContext) {
    this.press?.gesture?.cancel();
    this.press = null;
    this.hover = null;
    ctx.requestOverlay();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const state = ctx.store.getState();
    const {parentId, local} = placement(state, e.page, ctx.index());
    this.press = {down: e, last: e, parentId, origin: local, gesture: null};
    this.hover = null;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    if (!press) {
      this.hover = e.page;
      ctx.requestOverlay();
      return;
    }
    press.last = e;
    if (!press.gesture && Math.hypot(e.screen.x - press.down.screen.x, e.screen.y - press.down.screen.y) < DRAG_PX) return;
    this.draw(ctx);
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext) {
    if (this.press?.gesture && (e.code.startsWith('Shift') || e.code.startsWith('Alt'))) {
      this.draw(ctx);
      return true;
    }
    if (e.code === 'Escape' && this.press?.gesture) {
      this.press.gesture.cancel();
      this.press = null;
      return true;
    }
    return false;
  }

  onKeyUp(e: ToolKeyEvent, ctx: ToolContext) {
    if (this.press?.gesture && (e.code.startsWith('Shift') || e.code.startsWith('Alt'))) {
      this.draw(ctx);
      return true;
    }
    return false;
  }

  private draw(ctx: ToolContext) {
    const press = this.press!;
    const state = ctx.store.getState();
    const end = placement(state, press.last.page, null);
    const mods = ctx.modifiers();
    const local = press.parentId === end.parentId ? end.local : press.last.page;
    const rect = dragRect(press.origin, local, {square: mods.shift, fromCenter: mods.alt});
    const width = Math.max(MIN_SIZE, Math.round(rect.width)), height = Math.max(MIN_SIZE, Math.round(rect.height));
    press.gesture ??= ctx.store.gesture('Shape');
    const kind = this.kind();
    press.gesture.update(tx => {
      this.ids.reset();
      const build = createShape(this.ids.next, {x: Math.round(rect.x), y: Math.round(rect.y), width, height, shape: kind, fill: boardChoices().shapeFill});
      insertPieces(tx, build, press.parentId);
      return {select: [build.id]};
    });
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    this.press = null;
    if (!press || e.button !== 0) return;
    if (press.gesture) {
      press.last = e;
      press.gesture.commit();
    } else {
      const kind = this.kind();
      const height = kind === 'arrow-right' || kind === 'arrow-left' ? 120 : CLICK_SIZE;
      ctx.store.transact('Shape', tx => {
        const build = createShape(this.ids.next, {x: Math.round(press.origin.x - CLICK_SIZE / 2), y: Math.round(press.origin.y - height / 2), width: CLICK_SIZE, height, shape: kind, fill: boardChoices().shapeFill});
        insertPieces(tx, build, press.parentId);
        return {select: [build.id]};
      });
    }
    // Fresh ids for the next shape.
    this.ids = replayIds();
    ctx.setTool('move');
    // The new shape is open for typing at once (FigJam): what is typed next is its text, never a tool's key.
    const state = ctx.store.getState();
    const made = state.selection.length === 1 ? state.doc.nodes[state.selection[0]] : undefined;
    const text = made?.board?.kind === 'shape' ? childPart(id => (id ? ctx.store.getState().doc.nodes[id] : undefined), made, 'text') : undefined;
    if (text) ctx.enterEdit(text.id, 'text');
  }

  onPointerCancel(ctx: ToolContext) {
    this.press?.gesture?.cancel();
    this.press = null;
    ctx.requestOverlay();
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    if (!this.hover || this.press) return;
    const zoom = view.viewport().zoom;
    const kind = this.kind();
    const height = kind === 'arrow-right' || kind === 'arrow-left' ? 120 : CLICK_SIZE;
    const centre = view.pageToScreen(this.hover);
    const w = CLICK_SIZE * zoom, h = height * zoom;
    const x = centre.x - w / 2, y = centre.y - h / 2;
    const geometry = boardShapeGeometry(kind, w, h);
    ctx2d.save();
    ctx2d.globalAlpha = 0.45;
    ctx2d.fillStyle = boardChoices().shapeFill;
    ctx2d.beginPath();
    if (geometry.type === 'ELLIPSE') ctx2d.ellipse(centre.x, centre.y, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (geometry.type === 'RECTANGLE') {
      const r = (geometry.fields.cornerRadius ?? 0);
      if ('roundRect' in ctx2d) ctx2d.roundRect(x, y, w, h, r);
      else (ctx2d as CanvasRenderingContext2D).rect(x, y, w, h);
    } else {
      for (const path of geometry.fields.vectorPaths ?? []) {
        for (const c of path.commands) {
          if (c.type === 'M') ctx2d.moveTo(x + c.x, y + c.y);
          else if (c.type === 'L') ctx2d.lineTo(x + c.x, y + c.y);
          else if (c.type === 'C') ctx2d.bezierCurveTo(x + c.x1, y + c.y1, x + c.x2, y + c.y2, x + c.x, y + c.y);
          else if (c.type === 'Q') ctx2d.quadraticCurveTo(x + c.x1, y + c.y1, x + c.x, y + c.y);
          else ctx2d.closePath();
        }
      }
    }
    ctx2d.fill();
    ctx2d.restore();
  }
}

export const createShapeTool = () => new ShapeTool();
