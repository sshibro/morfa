import type {Vec} from '../../../../shared/design/types';
import {HIT_TOLERANCE_PX, nodesInRect, pickAt} from '../hit-test';
import type {Command} from '../commands/registry';
import {isMacPlatform} from '../keyboard';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ViewHelpers} from './types';

// "Keyboard selection" (Figma's Keyboard box selection, help.figma.com "Use Figma products with a keyboard"): ⌥Space
// (Ctrl+Space elsewhere) puts a pink cursor in the middle of the view. The arrows move it (⇧ further), Enter selects the
// layer under it; ⌘ (Ctrl) with the arrows stretches a box from it, and Enter then selects what the box takes, as the
// marquee does. Tab and ⇧Tab still step through the layers; Escape goes back to "Move".

export const KEYBOARD_SELECT_TOOL = 'keyboard-select';

/** Screen px an arrow moves the cursor (or stretches the box), and with ⇧. */
const STEP = 8;
const STEP_LARGE = 40;
const PINK = '#F24E9F';

const ARROWS: Record<string, Vec> = {ArrowLeft: {x: -1, y: 0}, ArrowRight: {x: 1, y: 0}, ArrowUp: {x: 0, y: -1}, ArrowDown: {x: 0, y: 1}};

export class KeyboardSelectTool implements Tool {
  readonly id = KEYBOARD_SELECT_TOOL;
  readonly cursor = 'default';
  /** Page space. */
  private at: Vec | null = null;
  /** The far corner of the box, page space; null: no box. */
  private corner: Vec | null = null;

  overlayHints(): OverlayHints {
    return {hover: false};
  }

  activate(ctx: ToolContext) {
    const size = ctx.view.size();
    this.at = ctx.view.screenToPage({x: size.width / 2, y: size.height / 2});
    this.corner = null;
    ctx.store.setHover(null);
    ctx.requestOverlay();
  }

  deactivate(ctx: ToolContext) {
    this.at = null;
    this.corner = null;
    ctx.requestOverlay();
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (e.type !== 'keydown' || !this.at) return false;
    if (e.code === 'Escape') {
      if (this.corner) this.corner = null;
      else ctx.setTool('move');
      ctx.requestOverlay();
      return true;
    }
    const arrow = ARROWS[e.code];
    if (arrow) {
      const step = (e.shiftKey ? STEP_LARGE : STEP) * ctx.view.pixel();
      if (e.mod) {
        const from = this.corner ?? this.at;
        this.corner = {x: from.x + arrow.x * step, y: from.y + arrow.y * step};
      } else {
        this.corner = null;
        this.at = {x: this.at.x + arrow.x * step, y: this.at.y + arrow.y * step};
      }
      const state = ctx.store.getState();
      ctx.store.setHover(this.corner ? null : pickAt(state.doc, state.pageId, this.at, {context: state.context, tolerance: HIT_TOLERANCE_PX * ctx.view.pixel(), index: ctx.index()}));
      ctx.requestOverlay();
      return true;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      const state = ctx.store.getState();
      if (this.corner) {
        const rect = {x: Math.min(this.at.x, this.corner.x), y: Math.min(this.at.y, this.corner.y), width: Math.abs(this.corner.x - this.at.x), height: Math.abs(this.corner.y - this.at.y)};
        ctx.store.setSelection(nodesInRect(state.doc, state.pageId, rect, {context: state.context, index: ctx.index()}));
        this.corner = null;
      } else {
        const hit = pickAt(state.doc, state.pageId, this.at, {context: state.context, tolerance: HIT_TOLERANCE_PX * ctx.view.pixel(), index: ctx.index()});
        ctx.store.setSelection(hit ? [hit] : []);
      }
      ctx.store.setHover(null);
      ctx.requestOverlay();
      return true;
    }
    return false;
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    if (!this.at) return;
    const p = view.pageToScreen(this.at);
    ctx2d.save();
    ctx2d.strokeStyle = PINK;
    ctx2d.fillStyle = PINK;
    ctx2d.lineWidth = 2;
    if (this.corner) {
      const q = view.pageToScreen(this.corner);
      ctx2d.globalAlpha = 0.12;
      ctx2d.fillRect(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.abs(q.x - p.x), Math.abs(q.y - p.y));
      ctx2d.globalAlpha = 1;
      ctx2d.lineWidth = 1;
      ctx2d.strokeRect(Math.round(Math.min(p.x, q.x)) + 0.5, Math.round(Math.min(p.y, q.y)) + 0.5, Math.round(Math.abs(q.x - p.x)), Math.round(Math.abs(q.y - p.y)));
      ctx2d.lineWidth = 2;
    }
    // A crosshair with a ring: where Enter selects.
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx2d.moveTo(p.x - 12, p.y);
    ctx2d.lineTo(p.x - 4, p.y);
    ctx2d.moveTo(p.x + 4, p.y);
    ctx2d.lineTo(p.x + 12, p.y);
    ctx2d.moveTo(p.x, p.y - 12);
    ctx2d.lineTo(p.x, p.y - 4);
    ctx2d.moveTo(p.x, p.y + 4);
    ctx2d.lineTo(p.x, p.y + 12);
    ctx2d.stroke();
    ctx2d.restore();
  }
}

export const createKeyboardSelectTool = () => new KeyboardSelectTool();

/** ⌥Space on a Mac, Ctrl+Space elsewhere: the keyboard selection, as Figma binds it. */
export const KEYBOARD_SELECT_COMMAND: Command = {
  id: 'tool-keyboard-select',
  label: 'Keyboard selection',
  group: 'tools',
  shortcut: isMacPlatform() ? {code: 'Space', alt: true} : {code: 'Space', ctrl: true},
  run: ctx => ctx.store.setTool(KEYBOARD_SELECT_TOOL),
};
