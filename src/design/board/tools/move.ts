import type {NodeId, PathCommand, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, worldMatrix} from '../../../../shared/design/geometry';
import {newId} from '../../../../shared/design/defaults';
import {boardObjectOf, childPart, isConnector, isShapeWithText, isSticky, isTable, partOf} from '../../../../shared/design/board/model';
import {rgbToHex} from '../../../../shared/design/board/palette';
import {connectorLabelPieces, createConnector, insertPieces} from '../../../../shared/design/board/create';
import {shownCell} from '../../../../shared/design/board/table';
import type {ConnectorEnd} from '../../../../shared/design/board/types';
import {hitsNode, hitTolerancePx, pickAt} from '../../engine/hit-test';
import type {Gesture} from '../../engine/store';
import {MoveTool} from '../../engine/tools/move';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from '../../engine/tools/types';
import type {TouchClaim} from '../../engine/touch/gestures';
import {BOARD_ACCENT, endAt, sideMiddles} from './common';
import {ConnectorDrag, drawMagnets} from './connector';
import {blankCopy} from './copies';
import {labelFractionAt, parentSpace, pathHandles} from './connector-path';
import {connectorLook} from '../state';
import {growMindChild, inMindMap, isMindNode, joinMindMap, mindTargetAt} from '../mind-map';

// The board's "Move" (V): Figma's move tool (moving, resizing, marquee) with FigJam's board habits on top
// (docs/board.md §Tools):
//   - a double click on a sticky, a shape or a table cell types into it; on a connector it types its label;
//   - around a hovered sticky or shape, four dots: drag one to draw a connector from that side, click one to add a copy in that
//     direction, already connected;
//   - a selected connector shows its two ends: drag one onto another object (or anywhere) to move it there.

const DOT_OFFSET_PX = 18;
const DOT_RADIUS_PX = 6;
const END_RADIUS_PX = 7;
/** On touch a dot or a connector's end answers within a 44 px target (what is drawn is the same). */
const TOUCH_REACH_PX = 22;
const DRAG_PX = 4;
/** Gap between an object and the copy a dot click adds. */
const QUICK_GAP = 120;

type DotPress = {down: ToolPointerEvent; objectId: NodeId; magnet: 'top' | 'right' | 'bottom' | 'left'; drag: ConnectorDrag};
type EndPress = {down: ToolPointerEvent; connectorId: NodeId; which: 'start' | 'end'; gesture: Gesture | null; target: SceneNode | null};
/** A press on a selected connector's path: a waypoint, a stretch's middle (adds one) or its label (slides along the path). */
type PathPress = {down: ToolPointerEvent; connectorId: NodeId; kind: 'point' | 'mid' | 'label'; index: number; gesture: Gesture | null};
const PATH_HANDLE_PX = 5;

export class BoardMoveTool implements Tool {
  readonly id = 'move';
  readonly cursor = 'default';
  private readonly inner = new MoveTool();
  private dotPress: DotPress | null = null;
  private endPress: EndPress | null = null;
  private pathPress: PathPress | null = null;
  /** The sticky or shape whose dots show, and the dot under the pointer. */
  private dotsFor: NodeId | null = null;
  /** An object pressed for a drag, and the mind map text it is over (dropped there, it joins the map). */
  private joining: {objectId: NodeId; target: NodeId | null} | null = null;
  private ctx: ToolContext | null = null;

  busy() {
    return !!this.dotPress?.drag.active || !!this.endPress?.gesture || !!this.pathPress?.gesture || !!this.inner.busy();
  }

  lifted() {
    return this.inner.lifted();
  }

  overlayHints(): OverlayHints {
    if (this.dotPress?.drag.active || this.endPress?.gesture || this.pathPress?.gesture) return {handles: false, hover: false, sizeBadge: false};
    const state = this.ctx?.store.getState();
    // A connector shows its two ends, never a resize box. A board shows no size badge (FigJam: notes are not measured).
    if (state && state.selection.length === 1 && isConnector(state.doc.nodes[state.selection[0]])) return {...this.inner.overlayHints(), handles: false, sizeBadge: false};
    return {...this.inner.overlayHints(), sizeBadge: false};
  }

  activate(ctx: ToolContext) {
    this.ctx = ctx;
  }

  deactivate(ctx: ToolContext) {
    this.dotPress?.drag.cancel();
    this.dotPress = null;
    this.endPress?.gesture?.cancel();
    this.endPress = null;
    this.pathPress?.gesture?.cancel();
    this.pathPress = null;
    this.dotsFor = null;
    this.inner.deactivate(ctx);
  }

  // ── Pointer ──────────────────────────────────────────────────────────────────────────────────

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    this.ctx = ctx;
    if (e.button !== 0) return this.inner.onPointerDown(e, ctx);
    const state = ctx.store.getState();
    if (!ctx.store.readOnly) {
      const end = this.endUnder(e, ctx);
      if (end) {
        this.endPress = {down: e, connectorId: end.connectorId, which: end.which, gesture: null, target: null};
        return;
      }
      const path = this.pathUnder(e, ctx);
      if (path) {
        // ⌥-click on a waypoint takes it away; anything else drags.
        if (path.kind === 'point' && e.altKey) {
          this.removeWaypoint(path.connectorId, path.index, ctx);
          return;
        }
        this.pathPress = {down: e, ...path, gesture: null};
        return;
      }
      const dot = this.dotUnder(e, ctx);
      if (dot) {
        const start: ConnectorEnd = {node: dot.objectId, magnet: dot.magnet};
        this.dotPress = {down: e, objectId: dot.objectId, magnet: dot.magnet, drag: new ConnectorDrag(ctx, start, e.page)};
        return;
      }
    }
    // A selected connector's invisible box takes no press: what is under the pointer is picked afresh.
    if (state.selection.length === 1 && isConnector(state.doc.nodes[state.selection[0]])) {
      const picked = pickAt(state.doc, state.pageId, e.page, {tolerance: hitTolerancePx(e.pointerType) * ctx.view.pixel(), index: ctx.index()});
      if (picked !== state.selection[0]) ctx.store.setSelection([]);
    }
    const pressed = pickAt(state.doc, state.pageId, e.page, {tolerance: hitTolerancePx(e.pointerType) * ctx.view.pixel(), index: ctx.index()});
    const object = pressed ? (isMindNode(state.doc.nodes[pressed]) ? state.doc.nodes[pressed] : boardObjectOf(id => (id ? state.doc.nodes[id] : undefined), pressed)) : null;
    this.joining = object && !object.locked && !ctx.store.readOnly && (isSticky(object) || isShapeWithText(object) || isMindNode(object)) ? {objectId: object.id, target: null} : null;
    this.inner.onPointerDown(e, ctx);
  }

  /** On touch (engine/touch/gestures.ts): a connector's end and the dots of the selected sticky or shape are dragged (a tap on a
   *  dot adds the next object); the rest is the shared move tool's (the selection drags, elsewhere a drag pans). */
  touchClaim(e: ToolPointerEvent, ctx: ToolContext): TouchClaim {
    this.ctx = ctx;
    if (!ctx.store.readOnly) {
      this.showDotsForSelection(ctx);
      if (this.endUnder(e, ctx) || this.dotUnder(e, ctx)) return 'grab';
    }
    return this.inner.touchClaim(e, ctx);
  }

  /** No hover on touch: the dots show on the selected sticky or shape instead. */
  private showDotsForSelection(ctx: ToolContext) {
    const state = ctx.store.getState();
    const only = state.selection.length === 1 ? state.doc.nodes[state.selection[0]] : undefined;
    const next = only && (isSticky(only) || isShapeWithText(only) || inMindMap(state.doc, only.id)) && !only.locked ? only.id : null;
    if (next === this.dotsFor) return;
    this.dotsFor = next;
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    this.ctx = ctx;
    if (this.endPress) return this.moveEnd(e, ctx);
    if (this.pathPress) return this.movePath(e, ctx);
    if (this.dotPress) {
      if (!this.dotPress.drag.active && Math.hypot(e.screen.x - this.dotPress.down.screen.x, e.screen.y - this.dotPress.down.screen.y) < DRAG_PX) return;
      this.dotPress.drag.update(e.page, e.shiftKey, e.mod);
      return;
    }
    this.inner.onPointerMove(e, ctx);
    if (!e.buttons) this.trackDots(e, ctx);
    else if (this.joining && this.inner.busy()) {
      const target = mindTargetAt(ctx.store.getState().doc, e.page, this.joining.objectId)?.id ?? null;
      if (target !== this.joining.target) {
        this.joining.target = target;
        ctx.requestOverlay();
      }
    }
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    if (this.pathPress) {
      const press = this.pathPress;
      this.pathPress = null;
      press.gesture?.commit();
      ctx.requestOverlay();
      return;
    }
    if (this.endPress) {
      const press = this.endPress;
      this.endPress = null;
      if (press.gesture) press.gesture.commit();
      ctx.requestOverlay();
      return;
    }
    if (this.dotPress) {
      const press = this.dotPress;
      this.dotPress = null;
      if (press.drag.active) {
        press.drag.update(e.page, e.shiftKey, e.mod);
        press.drag.commit();
      } else this.quickAdd(press.objectId, press.magnet, ctx);
      ctx.requestOverlay();
      return;
    }
    const joining = this.joining;
    this.joining = null;
    this.inner.onPointerUp(e, ctx);
    // Dropped on a mind map's text: joined to it as a child (FigJam).
    if (joining?.target) {
      joinMindMap(ctx.store, joining.target, joining.objectId);
      ctx.requestOverlay();
    }
    if (e.pointerType === 'touch') this.showDotsForSelection(ctx);
  }

  onPointerCancel(ctx: ToolContext) {
    this.joining = null;
    this.pathPress?.gesture?.cancel();
    this.pathPress = null;
    this.dotPress?.drag.cancel();
    this.dotPress = null;
    this.endPress?.gesture?.cancel();
    this.endPress = null;
    this.inner.onPointerCancel(ctx);
  }

  onDoubleClick(e: ToolPointerEvent, ctx: ToolContext) {
    const state = ctx.store.getState();
    const tolerance = hitTolerancePx(e.pointerType) * ctx.view.pixel();
    const leaf = pickAt(state.doc, state.pageId, e.page, {deep: true, tolerance, index: ctx.index()});
    const object = leaf ? boardObjectOf(id => (id ? state.doc.nodes[id] : undefined), leaf) : null;
    if (!object || object.locked || ctx.store.readOnly) return this.inner.onDoubleClick(e, ctx);
    const target = editTarget(ctx, object, leaf!);
    if (target) {
      ctx.store.setSelection([object.id]);
      ctx.enterEdit(target, 'text');
      return;
    }
    if (isConnector(object)) {
      editConnectorLabel(ctx, object.id);
      return;
    }
    this.inner.onDoubleClick(e, ctx);
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext) {
    if (e.code === 'Escape' && (this.dotPress || this.endPress)) {
      this.onPointerCancel(ctx);
      return true;
    }
    if (this.dotPress?.drag.active && e.code.startsWith('Shift')) {
      this.dotPress.drag.refresh(true);
      return true;
    }
    return this.inner.onKeyDown(e, ctx);
  }

  onKeyUp(e: ToolKeyEvent, ctx: ToolContext) {
    if (this.dotPress?.drag.active && e.code.startsWith('Shift')) {
      this.dotPress.drag.refresh(false);
      return true;
    }
    return this.inner.onKeyUp(e, ctx);
  }

  // ── Connector ends ───────────────────────────────────────────────────────────────────────────

  private endUnder(e: ToolPointerEvent, ctx: ToolContext): {connectorId: NodeId; which: 'start' | 'end'} | null {
    const state = ctx.store.getState();
    if (state.selection.length !== 1) return null;
    const connector = state.doc.nodes[state.selection[0]];
    if (!isConnector(connector)) return null;
    const ends = connectorEnds(state.doc, connector.id);
    if (!ends) return null;
    for (const which of ['end', 'start'] as const) {
      const at = ctx.view.pageToScreen(ends[which]);
      if (Math.hypot(at.x - e.screen.x, at.y - e.screen.y) <= (e.pointerType === 'touch' ? TOUCH_REACH_PX : END_RADIUS_PX + 4)) return {connectorId: connector.id, which};
    }
    return null;
  }

  private moveEnd(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.endPress!;
    if (!press.gesture && Math.hypot(e.screen.x - press.down.screen.x, e.screen.y - press.down.screen.y) < DRAG_PX) return;
    const state = ctx.store.getState();
    const connector = state.doc.nodes[press.connectorId];
    if (connector?.board?.kind !== 'connector') return;
    const exclude = new Set<NodeId>([press.connectorId]);
    const {end, object} = endAt(state, e.page, ctx, exclude, e.mod);
    press.target = object;
    press.gesture ??= ctx.store.gesture('Connector');
    const id = press.connectorId, which = press.which;
    press.gesture.update(tx => {
      const node = tx.get(id);
      if (node?.board?.kind !== 'connector') return;
      tx.update(id, {board: {...node.board, [which]: end}});
    });
    ctx.requestOverlay();
  }

  /** A waypoint, a stretch's middle or the label of the selected connector under the pointer. */
  private pathUnder(e: ToolPointerEvent, ctx: ToolContext): {connectorId: NodeId; kind: 'point' | 'mid' | 'label'; index: number} | null {
    const state = ctx.store.getState();
    if (state.selection.length !== 1) return null;
    const connector = state.doc.nodes[state.selection[0]];
    if (!isConnector(connector) || connector.locked) return null;
    const reach = e.pointerType === 'touch' ? TOUCH_REACH_PX : PATH_HANDLE_PX + 4;
    // Waypoints first (one sits where two stretches meet), then the label, then the middles (a middle under the label is the label's).
    const handles = pathHandles(state.doc, connector.id);
    const near = (at: Vec) => {
      const screen = ctx.view.pageToScreen(at);
      return Math.hypot(screen.x - e.screen.x, screen.y - e.screen.y) <= reach;
    };
    const point = handles.find(handle => handle.kind === 'point' && near(handle.at));
    if (point) return {connectorId: connector.id, kind: 'point', index: point.index};
    const label = childPart(id => (id ? state.doc.nodes[id] : undefined), connector, 'label');
    if (label && hitsNode(state.doc, label.id, e.page, 0)) return {connectorId: connector.id, kind: 'label', index: 0};
    const middle = handles.find(handle => handle.kind === 'mid' && near(handle.at));
    return middle ? {connectorId: connector.id, kind: 'mid', index: middle.index} : null;
  }

  private movePath(e: ToolPointerEvent, ctx: ToolContext) {
    const press = this.pathPress!;
    if (!press.gesture && Math.hypot(e.screen.x - press.down.screen.x, e.screen.y - press.down.screen.y) < DRAG_PX) return;
    const doc = ctx.store.getState().doc;
    const id = press.connectorId;
    if (press.kind === 'label') {
      const labelAt = labelFractionAt(doc, id, e.page);
      press.gesture ??= ctx.store.gesture('Connector label');
      press.gesture.update(tx => {
        const node = tx.get(id);
        if (node?.board?.kind === 'connector') tx.update(id, {board: {...node.board, labelAt}});
      });
    } else {
      const at = parentSpace(doc, id).fromPage(e.page);
      const point = {x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100};
      // A middle becomes a waypoint at the first move; from then on it is that waypoint.
      if (press.kind === 'mid') {
        press.kind = 'point';
        press.gesture ??= ctx.store.gesture('Connector bend');
        const index = press.index;
        press.gesture.update(tx => {
          const node = tx.get(id);
          if (node?.board?.kind !== 'connector') return;
          const points = [...(node.board.points ?? [])];
          points.splice(index, 0, point);
          tx.update(id, {board: {...node.board, points}});
        });
      } else {
        press.gesture ??= ctx.store.gesture('Connector bend');
        const index = press.index;
        press.gesture.update(tx => {
          const node = tx.get(id);
          if (node?.board?.kind !== 'connector') return;
          const points = [...(node.board.points ?? [])];
          points[index] = point;
          tx.update(id, {board: {...node.board, points}});
        });
      }
    }
    ctx.requestOverlay();
  }

  private removeWaypoint(connectorId: NodeId, index: number, ctx: ToolContext) {
    ctx.store.transact('Remove bend', tx => {
      const node = tx.get(connectorId);
      if (node?.board?.kind !== 'connector' || !node.board.points) return;
      const points = node.board.points.filter((_, k) => k !== index);
      const {points: _drop, ...rest} = node.board;
      tx.update(connectorId, {board: points.length ? {...rest, points} : rest});
    });
    ctx.requestOverlay();
  }

  // ── Connection dots ──────────────────────────────────────────────────────────────────────────

  private trackDots(e: ToolPointerEvent, ctx: ToolContext) {
    if (ctx.store.readOnly) return;
    const state = ctx.store.getState();
    if (this.dotsFor && this.dotUnder(e, ctx)) return;
    const hoverNode = state.hoverId ? state.doc.nodes[state.hoverId] : undefined;
    const hovered = hoverNode && inMindMap(state.doc, hoverNode.id) ? hoverNode : state.hoverId ? boardObjectOf(id => (id ? state.doc.nodes[id] : undefined), state.hoverId) : null;
    const next = hovered && (isSticky(hovered) || isShapeWithText(hovered) || inMindMap(state.doc, hovered.id)) && !hovered.locked ? hovered.id : null;
    // The dots stand outside the object: they stay while the pointer crosses the margin out to them (over no other object).
    if (!next && this.dotsFor && this.withinDots(e, ctx)) return;
    if (next !== this.dotsFor) {
      this.dotsFor = next;
      ctx.requestOverlay();
    }
  }

  private withinDots(e: ToolPointerEvent, ctx: ToolContext): boolean {
    const doc = ctx.store.getState().doc;
    if (!this.dotsFor || !doc.nodes[this.dotsFor]) return false;
    // The dots and the object's own edges: a single dot (a mind map's +) still keeps the gap out to it.
    const all = [...dots(doc, this.dotsFor, ctx.view).map(dot => dot.screen), ...sideMiddles(doc, this.dotsFor).map(side => ctx.view.pageToScreen(side.at))];
    const reach = DOT_RADIUS_PX + 3;
    const xs = all.map(at => at.x), ys = all.map(at => at.y);
    return e.screen.x >= Math.min(...xs) - reach && e.screen.x <= Math.max(...xs) + reach && e.screen.y >= Math.min(...ys) - reach && e.screen.y <= Math.max(...ys) + reach;
  }

  private dotUnder(e: ToolPointerEvent, ctx: ToolContext): {objectId: NodeId; magnet: 'top' | 'right' | 'bottom' | 'left'} | null {
    if (!this.dotsFor) return null;
    const doc = ctx.store.getState().doc;
    if (!doc.nodes[this.dotsFor]) return null;
    for (const dot of dots(doc, this.dotsFor, ctx.view)) {
      if (Math.hypot(dot.screen.x - e.screen.x, dot.screen.y - e.screen.y) <= (e.pointerType === 'touch' ? TOUCH_REACH_PX : DOT_RADIUS_PX + 3)) return {objectId: this.dotsFor, magnet: dot.magnet};
    }
    return null;
  }

  /** A click on a dot: a copy of the object in that direction (an empty sticky of the same colour, an empty shape of the same kind
   *  and fill), connected to it, selected and open for typing. */
  private quickAdd(objectId: NodeId, magnet: 'top' | 'right' | 'bottom' | 'left', ctx: ToolContext) {
    const state = ctx.store.getState();
    const object = state.doc.nodes[objectId];
    if (!object?.parentId) return;
    // A mind map's text grows a child to its right (FigJam's + beside a node).
    if (isMindNode(object)) {
      growMindChild({store: ctx.store, enterEdit: ctx.enterEdit}, object);
      return;
    }
    const dx = magnet === 'right' ? object.width + QUICK_GAP : magnet === 'left' ? -(object.width + QUICK_GAP) : 0;
    const dy = magnet === 'bottom' ? object.height + QUICK_GAP : magnet === 'top' ? -(object.height + QUICK_GAP) : 0;
    const x = object.x + dx, y = object.y + dy;
    const build = blankCopy(state.doc, object, x, y);
    if (!build) return;
    const opposite = {top: 'bottom', bottom: 'top', left: 'right', right: 'left'} as const;
    const made = build;
    const link = createConnector(newId, {...connectorLook(), start: {node: objectId, magnet}, end: {node: made.id, magnet: opposite[magnet]}});
    ctx.store.transact('Add nearby', tx => {
      insertPieces(tx, made, object.parentId!);
      insertPieces(tx, link, state.pageId);
      return {select: [made.id]};
    });
    const text = childPart(id => (id ? ctx.store.getState().doc.nodes[id] : undefined), ctx.store.getState().doc.nodes[made.id], 'text');
    if (text) ctx.enterEdit(text.id, 'text');
  }

  // ── Drawing ──────────────────────────────────────────────────────────────────────────────────

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    this.inner.drawOverlay(ctx2d, view);
    const ctx = this.ctx;
    if (!ctx) return;
    const state = ctx.store.getState();
    if (this.dotPress?.drag.active) {
      this.dotPress.drag.drawOverlay(ctx2d, view);
      return;
    }
    if (this.endPress?.target) drawMagnets(ctx2d, view, ctx, this.endPress.target.id);
    // The mind map text a dragged object would join: a + on its right.
    const target = this.joining?.target ? state.doc.nodes[this.joining.target] : undefined;
    if (target) {
      const right = sideMiddles(state.doc, target.id).find(side => side.magnet === 'right');
      if (right) drawPlus(ctx2d, view.pageToScreen(right.at));
    }
    // A selected connector: its two ends.
    if (state.selection.length === 1 && isConnector(state.doc.nodes[state.selection[0]])) {
      const ends = connectorEnds(state.doc, state.selection[0]);
      if (ends) for (const point of [ends.start, ends.end]) drawEnd(ctx2d, view.pageToScreen(point));
      if (!this.endPress?.gesture) {
        const label = childPart(id => (id ? state.doc.nodes[id] : undefined), state.doc.nodes[state.selection[0]], 'label');
        for (const handle of pathHandles(state.doc, state.selection[0])) {
          if (handle.kind === 'mid' && label && hitsNode(state.doc, label.id, handle.at, 0)) continue;
          drawPathHandle(ctx2d, view.pageToScreen(handle.at), handle.kind);
        }
      }
    }
    if (this.dotsFor && state.doc.nodes[this.dotsFor] && !this.inner.busy() && !state.editing) {
      ctx2d.save();
      for (const dot of dots(state.doc, this.dotsFor, view)) {
        ctx2d.beginPath();
        ctx2d.arc(dot.screen.x, dot.screen.y, DOT_RADIUS_PX, 0, Math.PI * 2);
        ctx2d.fillStyle = '#FFFFFF';
        ctx2d.strokeStyle = BOARD_ACCENT;
        ctx2d.lineWidth = 1.5;
        ctx2d.fill();
        ctx2d.stroke();
        ctx2d.beginPath();
        ctx2d.arc(dot.screen.x, dot.screen.y, 2, 0, Math.PI * 2);
        ctx2d.fillStyle = BOARD_ACCENT;
        ctx2d.fill();
      }
      ctx2d.restore();
    }
  }
}

/** A waypoint (filled) or a stretch's middle (hollow, to add one). */
function drawPathHandle(ctx2d: CanvasRenderingContext2D, at: Vec, kind: 'point' | 'mid') {
  ctx2d.save();
  ctx2d.beginPath();
  ctx2d.arc(at.x, at.y, kind === 'point' ? PATH_HANDLE_PX : PATH_HANDLE_PX - 1, 0, Math.PI * 2);
  ctx2d.fillStyle = kind === 'point' ? BOARD_ACCENT : '#FFFFFF';
  ctx2d.strokeStyle = kind === 'point' ? '#FFFFFF' : BOARD_ACCENT;
  ctx2d.lineWidth = 1.5;
  ctx2d.fill();
  ctx2d.stroke();
  ctx2d.restore();
}

function drawPlus(ctx2d: CanvasRenderingContext2D, at: Vec) {
  const x = at.x + DOT_OFFSET_PX, y = at.y;
  ctx2d.save();
  ctx2d.beginPath();
  ctx2d.arc(x, y, 9, 0, Math.PI * 2);
  ctx2d.fillStyle = BOARD_ACCENT;
  ctx2d.fill();
  ctx2d.strokeStyle = '#FFFFFF';
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  ctx2d.moveTo(x - 4, y);
  ctx2d.lineTo(x + 4, y);
  ctx2d.moveTo(x, y - 4);
  ctx2d.lineTo(x, y + 4);
  ctx2d.stroke();
  ctx2d.restore();
}

function drawEnd(ctx2d: CanvasRenderingContext2D, at: Vec) {
  ctx2d.save();
  ctx2d.beginPath();
  ctx2d.arc(at.x, at.y, END_RADIUS_PX, 0, Math.PI * 2);
  ctx2d.fillStyle = '#FFFFFF';
  ctx2d.strokeStyle = '#0D99FF';
  ctx2d.lineWidth = 2;
  ctx2d.fill();
  ctx2d.stroke();
  ctx2d.restore();
}

function dots(doc: Parameters<typeof sideMiddles>[0], id: NodeId, view: ViewHelpers) {
  // A mind map's text has one, on its right: its children grow that way.
  const sides = isMindNode(doc.nodes[id]) ? sideMiddles(doc, id).filter(side => side.magnet === 'right') : sideMiddles(doc, id);
  return sides.map(side => {
    const at = view.pageToScreen(side.at);
    return {magnet: side.magnet, screen: {x: at.x + side.out.x * DOT_OFFSET_PX, y: at.y + side.out.y * DOT_OFFSET_PX}};
  });
}

/** A connector's two ends in page space (its line's first and last points). */
export function connectorEnds(doc: Parameters<typeof worldMatrix>[0], connectorId: NodeId): {start: Vec; end: Vec} | null {
  const line = childPart(id => (id ? doc.nodes[id] : undefined), doc.nodes[connectorId], 'line');
  const commands = line?.vectorPaths?.[0]?.commands;
  if (!line || !commands?.length) return null;
  const points = commands.filter((c): c is Extract<PathCommand, {x: number}> => c.type !== 'Z');
  if (!points.length) return null;
  const m = worldMatrix(doc, line.id);
  return {start: apply(m, points[0]), end: apply(m, points[points.length - 1])};
}

/** The text a double click on `object` types into (the cell under the pointer for a table), or null. */
function editTarget(ctx: ToolContext, object: SceneNode, leaf: NodeId): NodeId | null {
  const doc = ctx.store.getState().doc;
  const get = (id: NodeId | null | undefined) => (id ? doc.nodes[id] : undefined);
  if (isTable(object)) {
    let node = get(leaf);
    while (node && partOf(node) !== 'cell' && node.id !== object.id) node = get(node.parentId);
    // A covered cell of a merge types into the merged cell over it.
    return node && partOf(node) === 'cell' ? childPart(get, get(shownCell(get, node.id)), 'text')?.id ?? null : null;
  }
  if (isSticky(object) || isShapeWithText(object)) return childPart(get, object, 'text')?.id ?? null;
  return null;
}

/** Opens a connector's label for typing, adding an empty one first when it has none. */
export function editConnectorLabel(ctx: Pick<ToolContext, 'store' | 'enterEdit'>, connectorId: NodeId) {
  const doc = ctx.store.getState().doc;
  const get = (id: NodeId | null | undefined) => (id ? ctx.store.getState().doc.nodes[id] : undefined);
  let label = childPart(get, doc.nodes[connectorId], 'label');
  if (!label) {
    // The text takes the line's colour (FigJam: a label without a background is written in the connector's colour).
    const stroke = childPart(get, doc.nodes[connectorId], 'line')?.strokes.find(paint => paint.type === 'SOLID');
    const pieces = connectorLabelPieces(newId, connectorId, '', stroke?.type === 'SOLID' ? rgbToHex(stroke.color) : undefined);
    ctx.store.transact('Label', tx => {
      for (const piece of pieces) tx.create(piece.node, piece.parent);
    }, {select: [connectorId]});
    label = childPart(get, get(connectorId), 'label');
  }
  const text = label && childPart(get, label, 'text');
  if (text) ctx.enterEdit(text.id, 'text');
}

export const createBoardMoveTool = () => new BoardMoveTool();
