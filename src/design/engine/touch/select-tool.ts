import type {NodeId, Vec} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import {hitTolerancePx, nodesInRect, pickAt} from '../hit-test';
import {drawMarquee} from '../overlay';
import {toggleInSelection} from '../selection';
import type {DesignStore} from '../store';
import type {TouchClaim} from './gestures';
import type {Tool, ToolContext, ToolPointerEvent, ViewHelpers} from '../tools/types';

// "Select" on a phone (editor/phone/PhoneEditorLayout.tsx turns it on): a finger
// has no Shift, so while this tool is in hand a tap adds the layer under it to the selection or takes it out, and a
// one-finger drag draws a marquee that adds what it touches, wherever it starts. A tap on empty canvas clears the
// selection, and then the tool hands the canvas back to "Move". Two fingers still pan and zoom (engine/touch).

export const TOUCH_SELECT_TOOL = 'touch-select';

/** Screen px a finger travels before a press becomes a marquee. */
const MARQUEE_SLOP = 8;

const rectBetween = (a: Vec, b: Vec): Rect => ({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)});

type Press = {down: ToolPointerEvent; at: ToolPointerEvent; base: readonly NodeId[]; marquee: boolean};

export class TouchSelectTool implements Tool {
  readonly id = TOUCH_SELECT_TOOL;
  readonly cursor = 'default';
  private press: Press | null = null;

  busy() {
    return !!this.press?.marquee;
  }

  overlayHints() {
    return {hover: false};
  }

  touchClaim(): TouchClaim {
    return 'draw';
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    this.press = {down: e, at: e, base: ctx.store.getState().selection, marquee: false};
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    if (!press) return;
    press.at = e;
    if (!press.marquee && Math.hypot(e.screen.x - press.down.screen.x, e.screen.y - press.down.screen.y) < MARQUEE_SLOP) return;
    press.marquee = true;
    const state = ctx.store.getState();
    const hits = nodesInRect(state.doc, state.pageId, rectBetween(press.down.page, e.page), {context: state.context, index: ctx.index()});
    ctx.store.setSelection([...press.base, ...hits.filter(id => !press.base.includes(id))]);
    ctx.requestOverlay();
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    this.press = null;
    ctx.requestOverlay();
    if (!press || press.marquee) return;
    const state = ctx.store.getState();
    const picked = pickAt(state.doc, state.pageId, e.page, {context: state.context, tolerance: hitTolerancePx(e.pointerType) * ctx.view.pixel(), index: ctx.index()});
    ctx.store.setSelection(picked ? toggleInSelection(state.selection, picked) : []);
  }

  onPointerCancel(ctx: ToolContext) {
    const press = this.press;
    this.press = null;
    if (press?.marquee) ctx.store.setSelection(press.base);
    ctx.requestOverlay();
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const press = this.press;
    if (!press?.marquee) return;
    drawMarquee(ctx2d, rectBetween(view.pageToScreen(press.down.page), view.pageToScreen(press.at.page)));
  }
}

/** Hands the canvas back to "Move" when the selection is cleared while "Select" is in hand. Returns the undo. */
export function followSelectionOff(store: DesignStore): () => void {
  let had = store.getState().selection.length > 0;
  return store.subscribe(() => {
    const {selection, tool} = store.getState();
    if (tool === TOUCH_SELECT_TOOL && had && !selection.length) store.setTool('move');
    had = selection.length > 0;
  }, {slice: ['selection', 'tool']});
}
