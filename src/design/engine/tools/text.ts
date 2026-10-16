import type {NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {BLACK, createNode, defaultTextProps, defaultTextStyle, newId, solid} from '../../../../shared/design/defaults';
import {layoutText} from '../../../../shared/design/text-layout';
import {frameAtPoint} from '../../../../shared/design/tree';
import {HIT_TOLERANCE_PX, pickAt} from '../hit-test';
import {OVERLAY_COLORS} from '../overlay';
import {lastTextStyle, textEditorDeps} from '../text-editor/registry';
import {TextEditSession, type Creation, type EndReason} from '../text-editor/session';
import {registerTool} from './registry';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';

// "Text" (T): a click places an auto-width text and opens it for typing, a drag draws a
// fixed-width box that grows downwards, a click on a text opens it at that spot. The same tool is
// the text editor's home: while `state.editing` is a text (a double click with "Move", Enter
// on a selected text), this tool is active and its session takes the pointer and the keys. Esc or
// a click outside ends editing and hands the canvas back to "Move", as Figma does.

/** Screen px a press travels before it becomes a drag. */
const DRAG_THRESHOLD = 3;
/** Presses closer than this in time and space count as one multi-click (double, triple). */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 4;

type Press =
  | {kind: 'create'; down: ToolPointerEvent; last: ToolPointerEvent; dragging: boolean}
  | {kind: 'select'};

export class TextTool implements Tool {
  readonly id: string = 'text';
  readonly cursor: string = 'text';
  protected session: TextEditSession | null = null;
  protected press: Press | null = null;
  protected ctx: ToolContext | null = null;
  private unsubscribe: (() => void) | null = null;
  private clicks = {count: 0, time: -Infinity, at: {x: 0, y: 0}};
  /** Set while one text's session closes because another opens: the tool stays. */
  private replacing = false;
  /** Set while this tool itself names the text being edited (no second session for it). */
  private opening = false;

  busy() {
    return !!this.press && (this.press.kind === 'select' || this.press.dragging);
  }

  overlayHints(): OverlayHints {
    return this.session ? {handles: false, sizeBadge: false} : {handles: false};
  }

  activate(ctx: ToolContext) {
    this.ctx = ctx;
    this.unsubscribe?.();
    this.unsubscribe = ctx.store.subscribe(() => this.followEditing(ctx), {slice: 'editing'});
    this.followEditing(ctx);
  }

  deactivate(ctx: ToolContext) {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.press = null;
    const session = this.session;
    this.session = null;
    session?.end('tool');
    ctx.store.setHover(null);
  }

  /** The editing state names a text this tool is not editing yet (Enter, a double click with
   *  "Move"): open it with everything selected. */
  private followEditing(ctx: ToolContext) {
    if (this.opening) return;
    const editing = ctx.store.getState().editing;
    if (editing?.kind !== 'text' || this.session?.id === editing.id) return;
    this.open(ctx, editing.id, 'all');
  }

  protected open(ctx: ToolContext, id: NodeId, select: 'all' | {offset: number; affinity?: 'upstream' | 'downstream'}, creation?: Creation): TextEditSession | null {
    const deps = textEditorDeps(ctx.store);
    if (!deps) return null;
    const previous = this.session;
    if (previous && !previous.isEnded) {
      this.session = null;
      this.replacing = true;
      try {
        previous.end('commit');
      } finally {
        this.replacing = false;
      }
    }
    const store = ctx.store;
    this.opening = true;
    try {
      if (store.getState().editing?.id !== id) store.setEditing({kind: 'text', id});
    } finally {
      this.opening = false;
    }
    const session = new TextEditSession(store, id, deps, {select, creation, onEnd: (reason, ended) => this.ended(reason, ended)});
    this.session = session;
    session.attach(ctx);
    return session;
  }

  private ended(reason: EndReason, session: TextEditSession) {
    if (this.session === session) this.session = null;
    this.press = null;
    if (this.replacing) return;
    // Leaving the text by Esc, a click outside or an undo that took it away ends the tool too.
    if (reason !== 'tool' && this.ctx?.store.getState().tool === this.id) this.ctx.setTool('move');
  }

  // ── Pointer ──────────────────────────────────────────────────────────────────────────────────

  protected clickCount(e: ToolPointerEvent): number {
    const last = this.clicks;
    const near = Math.hypot(e.screen.x - last.at.x, e.screen.y - last.at.y) <= MULTI_CLICK_PX;
    const count = e.timeStamp - last.time <= MULTI_CLICK_MS && near ? last.count + 1 : 1;
    this.clicks = {count, time: e.timeStamp, at: {...e.screen}};
    return Math.max(count, e.detail || 1);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    const clicks = this.clickCount(e);
    const {store} = ctx;
    const tolerance = HIT_TOLERANCE_PX * ctx.view.pixel();
    const session = this.session;
    if (session) {
      const hit = session.hit(e.page, tolerance);
      if (hit?.inside) {
        session.pointerDown({...e, detail: clicks}, hit.local);
        this.press = {kind: 'select'};
        return;
      }
      // A press outside the text ends editing and selects what it lands on.
      const state = store.getState();
      const picked = pickAt(state.doc, state.pageId, e.page, {context: state.context, tolerance, index: ctx.index()});
      this.session = null;
      session.end('commit');
      store.setSelection(picked ? [picked] : []);
      return;
    }
    const state = store.getState();
    const deep = pickAt(state.doc, state.pageId, e.page, {deep: true, tolerance, index: ctx.index()});
    const node = deep ? state.doc.nodes[deep] : undefined;
    if (node?.type === 'TEXT' && !node.locked && !lockedAbove(state.doc.nodes, node)) {
      const opened = this.open(ctx, node.id, {offset: 0});
      const hit = opened?.hit(e.page, tolerance);
      if (opened && hit) {
        opened.pointerDown({...e, detail: clicks}, hit.local);
        this.press = {kind: 'select'};
      }
      return;
    }
    this.press = {kind: 'create', down: e, last: e, dragging: false};
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    if (press?.kind === 'select') {
      const hit = this.session?.hit(e.page, 0);
      if (hit) this.session!.pointerMove(hit.local);
      return;
    }
    if (press?.kind === 'create') {
      press.last = e;
      if (!press.dragging && Math.hypot(e.screen.x - press.down.screen.x, e.screen.y - press.down.screen.y) >= DRAG_THRESHOLD) press.dragging = true;
      ctx.requestOverlay();
      return;
    }
    this.hover(e, ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (press.kind === 'select') {
      this.session?.pointerUp();
      return;
    }
    press.last = e;
    this.create(press.down.page, press.dragging ? e.page : null, ctx);
    ctx.requestOverlay();
  }

  onPointerCancel(ctx: ToolContext) {
    if (this.press?.kind === 'select') this.session?.pointerUp();
    this.press = null;
    ctx.requestOverlay();
  }

  onDoubleClick() {
    // Multi-clicks are counted on press (word, then paragraph); the browser's dblclick adds nothing.
  }

  private hover(e: ToolPointerEvent, ctx: ToolContext) {
    const state = ctx.store.getState();
    const tolerance = HIT_TOLERANCE_PX * ctx.view.pixel();
    if (this.session) {
      const hit = this.session.hit(e.page, tolerance);
      ctx.setCursor(hit?.inside ? 'text' : 'default');
      ctx.store.setHover(null);
      return;
    }
    ctx.setCursor(null);
    const deep = pickAt(state.doc, state.pageId, e.page, {deep: true, tolerance, index: ctx.index()});
    ctx.store.setHover(deep && state.doc.nodes[deep]?.type === 'TEXT' ? deep : null);
  }

  // ── Keys ─────────────────────────────────────────────────────────────────────────────────────

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (this.session) return this.session.keyFromCanvas(e);
    if (e.code === 'Escape' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (this.press) {
        this.press = null;
        ctx.requestOverlay();
      } else ctx.setTool('move');
      return true;
    }
    // Enter starts a text in the middle of the view, typing right away: no pointer needed, as Figma's keyboard controls.
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && e.type === 'keydown' && !this.press && !e.mod && !e.shiftKey && !e.altKey && !e.repeat) {
      const size = ctx.view.size();
      this.create(ctx.view.screenToPage({x: size.width / 2, y: size.height / 2}), null, ctx);
      return true;
    }
    return false;
  }

  // ── Creating ─────────────────────────────────────────────────────────────────────────────────

  /** A new text at `from` (a click) or in the box from `from` to `to` (a drag): auto width for a
   *  click, a fixed width that grows downwards for a box. It takes the last used text style. */
  private create(from: Vec, to: Vec | null, ctx: ToolContext) {
    const {store} = ctx;
    // Without the editor's services (installTextEditing) nothing could type into it.
    if (!textEditorDeps(store)) return;
    const state = store.getState();
    const {doc, pageId} = state;
    const box = to ? {x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y)} : null;
    const anchor = box ? {x: box.x, y: box.y} : from;
    const parentId = frameAtPoint(doc, pageId, anchor, new Set(), ctx.index()) ?? pageId;
    const remembered = lastTextStyle(store);
    const style = remembered ? {...defaultTextStyle(), ...remembered.style} : defaultTextStyle();
    const fills = remembered?.fills.length ? remembered.fills.map(paint => ({...paint})) : [solid(BLACK)];
    const id = newId();
    const text = {...defaultTextProps(''), style, textAutoResize: box ? ('HEIGHT' as const) : ('WIDTH_AND_HEIGHT' as const)};
    const probe: SceneNode = createNode('TEXT', {id, parentId, fills, text, width: box ? Math.max(1, box.width) : 0});
    const lineHeight = layoutText(probe, store.measurer).height || style.fontSize * 1.2;
    const local = apply(invert(worldMatrix(doc, parentId)), anchor);
    const snap = state.ui.snapToPixel;
    let x = local.x, y = box ? local.y : local.y - lineHeight / 2;
    if (snap) {
      x = Math.round(x);
      y = Math.round(y);
    }
    const node: SceneNode = {
      ...probe,
      x, y,
      width: box ? Math.max(1, snap ? Math.round(box.width) : box.width) : 0,
      height: lineHeight,
      layoutSizingHorizontal: box ? 'FIXED' : 'HUG',
      layoutSizingVertical: 'HUG',
    };
    const gesture = store.gesture('Text');
    gesture.update(tx => {
      tx.create(node, parentId);
      return {select: [id]};
    });
    if (!store.getState().doc.nodes[id]) {
      gesture.cancel();
      return;
    }
    this.open(ctx, id, {offset: 0}, {gesture, parentId, index: undefined, node});
  }

  // ── Overlay ──────────────────────────────────────────────────────────────────────────────────

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    this.session?.draw(ctx2d, view);
    const press = this.press;
    if (press?.kind === 'create' && press.dragging) {
      const a = view.pageToScreen(press.down.page), b = view.pageToScreen(press.last.page);
      ctx2d.save();
      ctx2d.strokeStyle = OVERLAY_COLORS.accent;
      ctx2d.lineWidth = 1;
      ctx2d.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
      ctx2d.restore();
    }
  }
}

/** A text inside a locked frame or group cannot be opened, as it cannot be selected. */
function lockedAbove(nodes: Record<NodeId, SceneNode>, node: SceneNode): boolean {
  for (let p = node.parentId ? nodes[node.parentId] : undefined; p && p.type !== 'PAGE'; p = p.parentId ? nodes[p.parentId] : undefined) if (p.locked) return true;
  return false;
}

export const createTextTool = () => new TextTool();

let registered = false;

/** Registers "Text" with the canvas's tool registry (idempotent). */
export function registerTextTool() {
  if (registered) return;
  registered = true;
  registerTool('text', createTextTool);
}

