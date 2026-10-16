import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, applyLinear, invert, normalizeDegrees, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {placementChanges, type Transaction} from '../../../../shared/design/transaction';
import {frameAtPoint, isAncestor, isFrameLikeNode} from '../../../../shared/design/tree';
import {projectOnPath, textPathSampler} from '../../../../shared/design/text-path';
import {insertClones} from '../clipboard';
import {frameTitleAt} from '../frame-titles';
import {altDragClones, dropAllowed} from '../commands/components';
import {hitTolerancePx, nodesInRect, pickAt} from '../hit-test';
import type {TouchClaim} from '../touch/gestures';
import {cornerRadii, drawLabel, drawMarquee, OVERLAY_COLORS, RADIUS_CORNERS, type OverlayItem} from '../overlay';
import {formatNumber, movableSelection, parentSelection, selectionBounds, selectionBox, sizeLabel, toggleInSelection, type SelectionBox} from '../selection';
import type {Gesture} from '../store';
import {userUpdate} from '../user-edit';
import {applySpacing, hitSpacingHandle, spacingBar, spacingGapAt, spacingHandles, type SpacingHandles} from '../spacing-handles';
import {barOf, gapDrag, hitLayoutHandle, layoutHandleAt, layoutHandles, paddingDrag, travelAlong, type LayoutHandle, type LayoutHandles} from '../layout-handles';
import {angleFrom, applyFit, applyFitAlone, canResizeAlone, handleCursor, hitHandle, moveLineEnd, resizeEdges, resizeMany, resizeSingle, rotateMany, rotateSingle, textResizeMode, type HandleHit} from './transform';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent} from './types';

// "Move" (V): selecting, moving, resizing and rotating, with Figma's rules for what a click
// picks (hit-test.ts `pickAt`). A drag is one store gesture: every pointer move re-runs it from the
// document the drag started on, so nothing drifts and the whole drag is one undo step. In "Code"
// (`ui.devMode`, Figma's Dev Mode) it only selects: a click and the hover reach the deepest layer,
// a drag draws a marquee, and nothing is moved, resized or opened for editing.

/** Screen px a press must travel before it becomes a drag. */
const DRAG_THRESHOLD = 3;
/** Shapes a double click opens in the vector editor. */
const VECTOR_EDIT_TYPES = new Set<SceneNode['type']>(['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'BOOLEAN_OPERATION']);
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight']);

type Base = {down: ToolPointerEvent; last: ToolPointerEvent};
type Pending = Base & {kind: 'pending'; then: 'move' | 'marquee'; additive: boolean; scope: NodeId | null; selectOnUp: NodeId[] | null};
type HandlePress = Base & {kind: 'handle'; hit: HandleHit};
type Clones = {nodes: SceneNode[]; ids: Map<NodeId, NodeId>; original: Map<NodeId, NodeId>};
type Moving = Base & {kind: 'move'; gesture: Gesture; doc: DesignDocument; ids: NodeId[]; bounds: Rect | null; parentInverse: Map<NodeId, Matrix>; clones: Clones | null};
type Marquee = Base & {kind: 'marquee'; base: readonly NodeId[]; additive: boolean; scope: NodeId | null};
type Resizing = Base & {kind: 'resize'; gesture: Gesture; doc: DesignDocument; ids: NodeId[]; handle: {hx: -1 | 0 | 1; hy: -1 | 0 | 1}; box: SelectionBox; start: Vec};
type Rotating = Base & {kind: 'rotate'; gesture: Gesture; doc: DesignDocument; ids: NodeId[]; pivot: Vec; startAngle: number};
type Endpoint = Base & {kind: 'endpoint'; gesture: Gesture; doc: DesignDocument; id: NodeId; end: 0 | 1};
type Radius = Base & {kind: 'radius'; gesture: Gesture; doc: DesignDocument; id: NodeId; corner: 0 | 1 | 2 | 3};
/** A text on a path's start handle (overlay.ts `textPathHandle`). */
type PathStart = Base & {kind: 'path-start'; gesture: Gesture; doc: DesignDocument; id: NodeId};
/** Auto layout's padding or gap bar (layout-handles.ts) dragged. */
type LayoutDrag = Base & {kind: 'layout'; gesture: Gesture; doc: DesignDocument; handles: LayoutHandles; handle: LayoutHandle};
/** A gap bar of layers selected with equal spacing (spacing-handles.ts) dragged. */
type SpacingDrag = Base & {kind: 'spacing'; gesture: Gesture; doc: DesignDocument; spacing: SpacingHandles; index: number};
type Drag = Pending | HandlePress | Moving | Marquee | Resizing | Rotating | Endpoint | Radius | PathStart | LayoutDrag | SpacingDrag;

const rectBetween = (a: Vec, b: Vec): Rect => ({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)});

function insideBox(box: SelectionBox, page: Vec): boolean {
  const local = apply(invert(box.matrix), page);
  return local.x >= 0 && local.y >= 0 && local.x <= box.width && local.y <= box.height;
}

/** Containers a dragged node may leave for another (nodes in groups and instances stay where they are, and so do the layers of a
 *  board's objects: docs/board.md). A board object is moved whole, never marqueed into. */
const isOpenContainer = (node: SceneNode | undefined) => !!node && !node.board && (node.type === 'PAGE' || node.type === 'SECTION' || (isFrameLikeNode(node) && node.type !== 'INSTANCE'));

/** A frame whose auto layout places what is dropped into it. */
const isFlowTarget = (doc: DesignDocument, id: NodeId) => {
  const layout = doc.nodes[id]?.autoLayout;
  return !!layout && layout.layoutMode !== 'NONE';
};

/** Index among the children of an auto-layout frame (without `exclude`) where a drop at `page` goes. */
function flowIndex(doc: DesignDocument, parentId: NodeId, page: Vec, exclude: ReadonlySet<NodeId>): {index: number; marker: [Vec, Vec] | null} {
  const parent = doc.nodes[parentId];
  const layout = parent.autoLayout!;
  const horizontal = layout.layoutMode === 'HORIZONTAL';
  const world = worldMatrix(doc, parentId);
  const local = apply(invert(world), page);
  const kids = (parent.children ?? []).filter(id => !exclude.has(id));
  const flow = kids.filter(id => doc.nodes[id]?.visible && doc.nodes[id].layoutPositioning !== 'ABSOLUTE');
  let index = kids.length, at: number | null = null;
  for (const id of flow) {
    const child = doc.nodes[id];
    const centre = horizontal ? child.x + child.width / 2 : child.y + child.height / 2;
    if ((horizontal ? local.x : local.y) < centre) {
      index = kids.indexOf(id);
      at = (horizontal ? child.x : child.y) - layout.itemSpacing / 2;
      break;
    }
  }
  if (at === null && flow.length) {
    const last = doc.nodes[flow[flow.length - 1]];
    at = horizontal ? last.x + last.width + layout.itemSpacing / 2 : last.y + last.height + layout.itemSpacing / 2;
  }
  if (at === null) at = horizontal ? layout.paddingLeft : layout.paddingTop;
  const marker: [Vec, Vec] = horizontal
    ? [apply(world, {x: at, y: layout.paddingTop}), apply(world, {x: at, y: parent.height - layout.paddingBottom})]
    : [apply(world, {x: layout.paddingLeft, y: at}), apply(world, {x: parent.width - layout.paddingRight, y: at})];
  return {index, marker};
}

/** Puts `ids` (already children of `parentId`) into its flow from index `index` of the other children on. */
function placeInFlow(tx: Transaction, ids: readonly NodeId[], index: number) {
  for (const id of ids) tx.reorder(id, Number.MAX_SAFE_INTEGER);
  ids.forEach((id, j) => tx.reorder(id, index + j));
}

/** "Code" (Dev Mode): the file is inspected, not edited. */
const inspecting = (ctx: ToolContext) => ctx.store.getState().ui.devMode;

function boxOutline(doc: DesignDocument, id: NodeId): Vec[] {
  const node = doc.nodes[id];
  const m = worldMatrix(doc, id);
  return [{x: 0, y: 0}, {x: node.width, y: 0}, {x: node.width, y: node.height}, {x: 0, y: node.height}].map(p => apply(m, p));
}

export class MoveTool implements Tool {
  readonly id = 'move';
  readonly cursor = 'default';
  private drag: Drag | null = null;
  /** Space held during a move: the layers stay in their parents (Figma's "don't nest"). */
  private keepParents = false;
  /** Layers lifted out of an auto-layout flow by the drag: drawn on top and unclipped while they move. */
  private liftedIds: ReadonlySet<NodeId> | null = null;
  /** Live size or angle near the cursor (screen px). */
  private label: {at: Vec; text: string} | null = null;

  busy() {
    return !!this.drag && this.drag.kind !== 'pending' && this.drag.kind !== 'handle';
  }

  lifted() {
    return this.drag?.kind === 'move' ? this.liftedIds : null;
  }

  overlayHints(): OverlayHints {
    switch (this.drag?.kind) {
      case 'move': return {handles: false, hover: false};
      case 'resize': case 'endpoint': case 'radius': case 'path-start': case 'layout': case 'spacing': return {hover: false, sizeBadge: false};
      case 'rotate': return {handles: false, hover: false, sizeBadge: false};
      case 'marquee': return {hover: false};
      default: return {};
    }
  }

  /** The session's store (the overlay's drawing reads the selection's spacing; it gets no context). */
  private store: ToolContext['store'] | null = null;

  activate(ctx: ToolContext) {
    this.store = ctx.store;
  }

  deactivate(ctx: ToolContext) {
    this.cancel(ctx);
    ctx.store.setHover(null);
  }

  /** On touch (engine/touch/gestures.ts): a finger on a handle or on what is selected drags it; anywhere else a drag pans
   *  the canvas and a tap selects. In "Code" nothing is dragged. */
  touchClaim(e: ToolPointerEvent, ctx: ToolContext): TouchClaim {
    if (inspecting(ctx)) return 'pan';
    const state = ctx.store.getState();
    const {doc, selection} = state;
    if (!selection.length) return 'pan';
    const {ids: movable, box} = this.selectionFrame(doc, selection);
    if (box && (hitHandle(doc, box, e.screen, ctx.view.viewport(), {rotate: true, touch: true}) || this.layoutHit(doc, box, e, ctx))) return 'grab';
    const title = frameTitleAt(doc, state.pageId, e.screen, ctx.view.viewport());
    if (title) return selection.includes(title) ? 'grab' : 'pan';
    if (box && movable.length > 1 && insideBox(box, e.page)) return 'grab';
    const pick = pickAt(doc, state.pageId, e.page, {context: state.context, tolerance: hitTolerancePx('touch') * ctx.view.pixel(), index: ctx.index()});
    return pick && selection.includes(pick) ? 'grab' : 'pan';
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    this.store = ctx.store;
    if (e.button !== 0) return;
    const {store} = ctx;
    if (store.getState().editing) store.setEditing(null);
    if (inspecting(ctx)) {
      this.inspectDown(e, ctx);
      return;
    }
    let state = store.getState();
    const {doc} = state;
    const {ids: movable, box} = this.selectionFrame(doc, state.selection);
    if (box) {
      const hit = hitHandle(doc, box, e.screen, ctx.view.viewport(), {rotate: true, touch: e.pointerType === 'touch'}) ?? this.layoutHit(doc, box, e, ctx);
      if (hit) {
        this.drag = {kind: 'handle', hit, down: e, last: e};
        return;
      }
    }
    // A frame's title selects the frame (and drags it), whatever lies under it, as in Figma.
    const title = frameTitleAt(doc, state.pageId, e.screen, ctx.view.viewport());
    if (title) {
      store.setContext(null);
      const selected = state.selection.includes(title);
      if (e.shiftKey) {
        if (!selected) store.setSelection(toggleInSelection(state.selection, title));
        this.drag = {kind: 'pending', then: 'move', additive: false, scope: null, selectOnUp: selected ? toggleInSelection(state.selection, title) : null, down: e, last: e};
        return;
      }
      if (!selected) store.setSelection([title]);
      this.drag = {kind: 'pending', then: 'move', additive: false, scope: null, selectOnUp: selected && state.selection.length > 1 ? [title] : null, down: e, last: e};
      return;
    }
    const pick = pickAt(doc, state.pageId, e.page, {context: state.context, deep: e.mod, tolerance: hitTolerancePx(e.pointerType) * ctx.view.pixel(), index: ctx.index()});
    if (pick && e.mod) {
      // A deep pick makes its parent the context, so the next click picks among its siblings.
      const parent = doc.nodes[pick].parentId;
      store.setContext(parent && doc.nodes[parent]?.type !== 'PAGE' && doc.nodes[parent]?.type !== 'SECTION' ? parent : null);
    } else if (state.context && (!pick || !isAncestor(doc, state.context, pick))) {
      store.setContext(null);
    }
    state = store.getState();
    const {selection} = state;
    if (e.shiftKey) {
      if (!pick) {
        this.drag = {kind: 'pending', then: 'marquee', additive: true, scope: null, selectOnUp: null, down: e, last: e};
        return;
      }
      // A Shift-click on a selected layer deselects it when released without a drag; a Shift-drag
      // moves the selection along one axis.
      const selected = selection.includes(pick);
      if (!selected && this.marqueeFrame(doc, state.context, pick, e)) {
        // Shift-dragging the empty area of a frame on the canvas adds the layers the marquee touches;
        // a Shift-click adds the frame itself.
        this.drag = {kind: 'pending', then: 'marquee', additive: true, scope: pick, selectOnUp: toggleInSelection(selection, pick), down: e, last: e};
        return;
      }
      if (!selected) store.setSelection(toggleInSelection(selection, pick));
      this.drag = {kind: 'pending', then: 'move', additive: false, scope: null, selectOnUp: selected ? toggleInSelection(selection, pick) : null, down: e, last: e};
      return;
    }
    if (pick && selection.includes(pick)) {
      // Pressing one of several selected layers drags them all; a click without a drag keeps just it.
      this.drag = {kind: 'pending', then: 'move', additive: false, scope: null, selectOnUp: selection.length > 1 ? [pick] : null, down: e, last: e};
      return;
    }
    if (box && movable.length > 1 && insideBox(box, e.page) && (!pick || movable.some(id => isAncestor(doc, pick, id)))) {
      this.drag = {kind: 'pending', then: 'move', additive: false, scope: null, selectOnUp: pick ? [pick] : [], down: e, last: e};
      return;
    }
    if (!pick) {
      store.setSelection([]);
      this.drag = {kind: 'pending', then: 'marquee', additive: false, scope: null, selectOnUp: null, down: e, last: e};
      return;
    }
    if (this.marqueeFrame(doc, state.context, pick, e)) {
      // Dragging the empty area of a frame on the canvas draws a marquee over its layers; a click selects it.
      this.drag = {kind: 'pending', then: 'marquee', additive: false, scope: pick, selectOnUp: [pick], down: e, last: e};
      return;
    }
    store.setSelection([pick]);
    this.drag = {kind: 'pending', then: 'move', additive: false, scope: null, selectOnUp: null, down: e, last: e};
  }

  /** A press in "Code": a click selects the layer under the pointer however deep it lies (a frame's title, its frame), Shift
   *  adds or removes it; a drag draws a marquee, over the layers of the frame whose empty area it starts on. */
  private inspectDown(e: ToolPointerEvent, ctx: ToolContext) {
    const {store} = ctx;
    const state = store.getState();
    const {doc} = state;
    const title = frameTitleAt(doc, state.pageId, e.screen, ctx.view.viewport());
    const pick = title ?? pickAt(doc, state.pageId, e.page, {deep: true, tolerance: hitTolerancePx(e.pointerType) * ctx.view.pixel(), index: ctx.index()});
    // Every click reaches the deepest layer, so there is no frame to be inside of (its dashed outline would only be noise).
    if (state.context) store.setContext(null);
    const node = pick ? doc.nodes[pick] : undefined;
    const scope = !title && node && isOpenContainer(node) && node.children?.length ? node.id : null;
    const selectOnUp = e.shiftKey ? (pick ? toggleInSelection(state.selection, pick) : null) : pick ? [pick] : [];
    this.drag = {kind: 'pending', then: 'marquee', additive: e.shiftKey, scope, selectOnUp, down: e, last: e};
  }

  /** The press picked a frame standing on the canvas (or in the entered context) that has layers: a drag from
   *  its empty area draws a marquee over them rather than moving it, as in Figma. */
  private marqueeFrame(doc: DesignDocument, context: NodeId | null, pick: NodeId, e: ToolPointerEvent): boolean {
    const node = doc.nodes[pick];
    const parent = doc.nodes[node.parentId ?? ''];
    const onCanvas = parent && (parent.type === 'PAGE' || parent.type === 'SECTION' || parent.id === context);
    return !!onCanvas && isOpenContainer(node) && node.type !== 'PAGE' && !!node.children?.length && !e.mod;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    if (!drag) {
      this.hover(e, ctx);
      return;
    }
    drag.last = e;
    if (drag.kind === 'pending' || drag.kind === 'handle') {
      if (Math.hypot(e.screen.x - drag.down.screen.x, e.screen.y - drag.down.screen.y) < DRAG_THRESHOLD) return;
      this.begin(drag, ctx);
      if (!this.drag || this.drag === drag) return;
    }
    this.update(e, ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    this.drag = null;
    this.label = null;
    if (!drag) return;
    if (drag.kind === 'pending') {
      if (drag.selectOnUp) ctx.store.setSelection(drag.selectOnUp);
    } else if ('gesture' in drag) {
      // A drop into an auto-layout flow takes its slot only now (during the drag it follows the pointer).
      if (drag.kind === 'move') this.updateMove(drag, drag.last, ctx, true);
      drag.gesture.commit();
    }
    this.keepParents = false;
    this.liftedIds = null;
    ctx.setOverlayItems([]);
    ctx.snap.end?.();
    ctx.requestOverlay();
    this.hover(e, ctx);
  }

  onPointerCancel(ctx: ToolContext) {
    this.cancel(ctx);
  }

  onDoubleClick(e: ToolPointerEvent, ctx: ToolContext) {
    // "Code" opens no text or vector editor and renames no frame: its clicks already reach the deepest layer.
    if (inspecting(ctx)) return;
    const {store} = ctx;
    const state = store.getState();
    const {doc} = state;
    const title = frameTitleAt(doc, state.pageId, e.screen, ctx.view.viewport());
    if (title) {
      ctx.editTitle?.(title);
      return;
    }
    const tolerance = hitTolerancePx(e.pointerType) * ctx.view.pixel();
    const picked = pickAt(doc, state.pageId, e.page, {context: state.context, tolerance, index: ctx.index()});
    if (!picked) return;
    const node = doc.nodes[picked];
    if (node.children?.length) {
      const inner = pickAt(doc, state.pageId, e.page, {context: picked, tolerance, index: ctx.index()});
      if (inner && inner !== picked && isAncestor(doc, picked, inner)) {
        store.setContext(picked);
        store.setSelection([inner]);
        return;
      }
      if (node.type !== 'BOOLEAN_OPERATION') return;
    }
    if (node.locked) return;
    if (node.type === 'TEXT') ctx.enterEdit(picked, 'text');
    else if (VECTOR_EDIT_TYPES.has(node.type)) ctx.enterEdit(picked, 'vector');
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (e.code === 'Escape') {
      if (this.drag) {
        this.cancel(ctx);
        return true;
      }
      const state = ctx.store.getState();
      if (!state.selection.length && !state.context) return false;
      const next = parentSelection(state.doc, state.selection, state.pageId);
      ctx.store.setSelection(next.selection);
      ctx.store.setContext(next.context);
      return true;
    }
    if (e.code === 'Space' && this.drag?.kind === 'move') {
      if (!this.keepParents) {
        this.keepParents = true;
        this.refresh(ctx);
      }
      return true;
    }
    if (MODIFIER_CODES.has(e.code)) this.refresh(ctx);
    return false;
  }

  onKeyUp(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (e.code === 'Space' && this.keepParents) {
      this.keepParents = false;
      this.refresh(ctx);
      return true;
    }
    if (MODIFIER_CODES.has(e.code)) this.refresh(ctx);
    return false;
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ToolContext['view']) {
    const drag = this.drag;
    // Layers selected with equal spacing: a pink bar in each gap (Figma's smart selection), unless something else is dragged.
    if (!drag || drag.kind === 'spacing' || drag.kind === 'pending' || drag.kind === 'handle') {
      const state = this.store?.getState();
      const spacing = state && !state.ui.devMode ? this.spacing(state.doc, state.selection) : null;
      if (spacing) {
        const viewport = view.viewport();
        ctx2d.save();
        ctx2d.strokeStyle = OVERLAY_COLORS.spacing;
        ctx2d.lineWidth = 2;
        ctx2d.lineCap = 'round';
        for (const gap of spacing.gaps) {
          const [a, b] = spacingBar(spacing, gap.index, viewport);
          ctx2d.beginPath();
          ctx2d.moveTo(a.x, a.y);
          ctx2d.lineTo(b.x, b.y);
          ctx2d.stroke();
        }
        ctx2d.restore();
      }
    }
    if (drag?.kind === 'marquee') {
      const a = view.pageToScreen(drag.down.page), b = view.pageToScreen(drag.last.page);
      drawMarquee(ctx2d, rectBetween(a, b));
    }
    if (this.label) drawLabel(ctx2d, {x: this.label.at.x + 16, y: this.label.at.y + 16}, this.label.text, {background: OVERLAY_COLORS.accent});
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  /** The movable part of the selection and its handle box, kept while neither changes (the pointer
   *  moves far more often than the selection, and a big selection is not cheap to measure). */
  private frameCache: {doc: DesignDocument; selection: readonly NodeId[]; ids: NodeId[]; box: SelectionBox | null} | null = null;

  private selectionFrame(doc: DesignDocument, selection: readonly NodeId[]) {
    const cached = this.frameCache;
    if (cached && cached.doc === doc && cached.selection === selection) return cached;
    const ids = movableSelection(doc, selection);
    this.frameCache = {doc, selection, ids, box: ids.length ? selectionBox(doc, ids) : null};
    return this.frameCache;
  }

  /** Auto layout's padding or gap bar under the pointer, when one auto-layout frame is selected (layout-handles.ts). */
  private layoutHit(doc: DesignDocument, box: SelectionBox, e: ToolPointerEvent, ctx: ToolContext): HandleHit | null {
    if (!box.nodeId) {
      const spacing = this.spacing(doc, ctx.store.getState().selection);
      const index = spacing ? hitSpacingHandle(spacing, e.screen, ctx.view.viewport()) : null;
      return spacing && index !== null ? {kind: 'spacing', spacing, index} : null;
    }
    const handles = layoutHandles(doc, box.nodeId, ctx.view.viewport());
    const handle = handles && hitLayoutHandle(handles, e.screen, ctx.view.viewport());
    return handles && handle ? {kind: 'layout', handles, handle} : null;
  }

  /** The band or gap the pointer is over, shaded with its bar (and its value while it is dragged). */
  private showLayoutHandle(ctx: ToolContext, handles: LayoutHandles | null, handle: LayoutHandle | null, value?: number) {
    if (!handles || !handle) {
      if (this.layoutShown) ctx.setOverlayItems([]);
      this.layoutShown = false;
      return;
    }
    const viewport = ctx.view.viewport();
    const m = handles.matrix;
    const {x, y, width, height} = handle.area;
    const corners = [{x, y}, {x: x + width, y}, {x: x + width, y: y + height}, {x, y: y + height}].map(p => apply(m, p));
    const [a, b] = barOf(handles, handle, viewport).map(p => ctx.view.screenToPage(p));
    const items: OverlayItem[] = [
      {kind: 'polyline', points: corners, closed: true, fill: OVERLAY_COLORS.spacingFill, stroke: OVERLAY_COLORS.spacing, dash: [3, 3]},
      {kind: 'line', from: a, to: b, color: OVERLAY_COLORS.spacing, width: 2},
    ];
    if (value !== undefined) items.push({kind: 'label', at: apply(m, handle.at), text: formatNumber(value), background: OVERLAY_COLORS.spacing, offset: {x: 0, y: -16}});
    ctx.setOverlayItems(items);
    this.layoutShown = true;
  }
  private layoutShown = false;

  /** The selection's equal-spacing handles, kept while the document and the selection stay (drawn every overlay frame). */
  private spacingCache: {doc: DesignDocument; selection: readonly NodeId[]; handles: SpacingHandles | null} | null = null;
  private spacing(doc: DesignDocument, selection: readonly NodeId[]): SpacingHandles | null {
    const cached = this.spacingCache;
    if (cached && cached.doc === doc && cached.selection === selection) return cached.handles;
    const {ids} = this.selectionFrame(doc, selection);
    const handles = ids.length > 1 ? spacingHandles(doc, ids) : null;
    this.spacingCache = {doc, selection, handles};
    return handles;
  }

  /** A gap of equally spaced layers shaded (hovered or dragged), with the gap while it is dragged. */
  private showSpacingGap(ctx: ToolContext, spacing: SpacingHandles | null, index: number | null, value?: number) {
    if (!spacing || index === null) return false;
    const {x, y, width, height} = spacing.gaps[index].area;
    const items: OverlayItem[] = [{kind: 'rect', rect: {x, y, width, height}, fill: OVERLAY_COLORS.spacingFill}];
    if (value !== undefined) items.push({kind: 'label', at: spacing.gaps[index].at, text: formatNumber(value), background: OVERLAY_COLORS.spacing, offset: {x: 0, y: -16}});
    ctx.setOverlayItems(items);
    this.layoutShown = true;
    return true;
  }

  private hover(e: ToolPointerEvent, ctx: ToolContext) {
    this.store = ctx.store;
    const state = ctx.store.getState();
    const {doc} = state;
    // "Code" has no handles, and lights up what its click would select: the deepest layer.
    const inspect = state.ui.devMode;
    const {box} = this.selectionFrame(doc, state.selection);
    const hit = box && !inspect ? hitHandle(doc, box, e.screen, ctx.view.viewport(), {rotate: true}) : null;
    if (hit && box) {
      this.showLayoutHandle(ctx, null, null);
      ctx.setCursor(handleCursor(hit, box, ctx.view.viewport()));
      ctx.store.setHover(null);
      return;
    }
    // Layers selected with equal spacing: the gap under the pointer, and a drag cursor on its bar.
    const spacing = box && !box.nodeId && !inspect ? this.spacing(doc, state.selection) : null;
    if (spacing) {
      const bar = hitSpacingHandle(spacing, e.screen, ctx.view.viewport());
      if (!this.showSpacingGap(ctx, spacing, bar ?? spacingGapAt(spacing, e.page))) this.showLayoutHandle(ctx, null, null);
      if (bar !== null) {
        ctx.setCursor(spacing.axis === 'x' ? 'ew-resize' : 'ns-resize');
        ctx.store.setHover(null);
        return;
      }
    }
    // Over a selected auto-layout frame: its padding band or gap under the pointer, and a drag cursor on its bar.
    const handles = box?.nodeId && !inspect ? layoutHandles(doc, box.nodeId, ctx.view.viewport()) : null;
    const over = handles ? layoutHandleAt(handles, e.screen, ctx.view.viewport()) : null;
    if (!spacing) this.showLayoutHandle(ctx, handles, over);
    const bar = handles && hitLayoutHandle(handles, e.screen, ctx.view.viewport());
    if (bar && box) {
      ctx.setCursor(handleCursor({kind: 'layout', handles: handles!, handle: bar}, box, ctx.view.viewport()));
      ctx.store.setHover(null);
      return;
    }
    ctx.setCursor(null);
    const title = frameTitleAt(doc, state.pageId, e.screen, ctx.view.viewport());
    ctx.store.setHover(title ?? pickAt(doc, state.pageId, e.page, {context: state.context, deep: e.mod || inspect, tolerance: hitTolerancePx(e.pointerType) * ctx.view.pixel(), index: ctx.index()}));
  }

  /** Re-runs the drag with the modifiers held now (Shift, Alt, ⌘, Control and Space change a drag while it runs). */
  private refresh(ctx: ToolContext) {
    const drag = this.drag;
    if (!drag || drag.kind === 'pending' || drag.kind === 'handle') return;
    const held = ctx.modifiers();
    this.update({...drag.last, shiftKey: held.shift, altKey: held.alt, mod: held.mod, ctrlKey: held.ctrl ?? drag.last.ctrlKey}, ctx);
  }

  private cancel(ctx: ToolContext) {
    const drag = this.drag;
    this.drag = null;
    this.keepParents = false;
    this.liftedIds = null;
    this.label = null;
    if (!drag) return;
    if ('gesture' in drag) drag.gesture.cancel();
    if (drag.kind === 'marquee') ctx.store.setSelection(drag.base);
    ctx.setOverlayItems([]);
    ctx.snap.end?.();
    ctx.requestOverlay();
  }

  private begin(drag: Pending | HandlePress, ctx: ToolContext) {
    const state = ctx.store.getState();
    const {doc} = state;
    const base = {down: drag.down, last: drag.last};
    if (drag.kind === 'pending' && drag.then === 'marquee') {
      this.drag = {...base, kind: 'marquee', base: drag.additive ? state.selection : [], additive: drag.additive, scope: drag.scope};
      if (drag.scope) ctx.store.setSelection(drag.additive ? state.selection : []);
      return;
    }
    const ids = movableSelection(doc, state.selection);
    if (!ids.length) {
      this.drag = null;
      return;
    }
    if (drag.kind === 'pending') {
      const parentInverse = new Map(ids.map(id => [id, invert(worldMatrix(doc, doc.nodes[id].parentId!))]));
      this.drag = {...base, kind: 'move', gesture: ctx.store.gesture('Move'), doc, ids, bounds: selectionBounds(doc, ids), parentInverse, clones: null};
      return;
    }
    const box = selectionBox(doc, ids)!;
    const {hit} = drag;
    if (hit.kind === 'endpoint') {
      this.drag = {...base, kind: 'endpoint', gesture: ctx.store.gesture('Edit line'), doc, id: ids[0], end: hit.end};
    } else if (hit.kind === 'radius') {
      this.drag = {...base, kind: 'radius', gesture: ctx.store.gesture('Corner radius'), doc, id: box.nodeId ?? ids[0], corner: hit.corner};
    } else if (hit.kind === 'path-start') {
      this.drag = {...base, kind: 'path-start', gesture: ctx.store.gesture('Text start'), doc, id: box.nodeId ?? ids[0]};
    } else if (hit.kind === 'spacing') {
      this.drag = {...base, kind: 'spacing', gesture: ctx.store.gesture('Gap'), doc, spacing: hit.spacing, index: hit.index};
    } else if (hit.kind === 'layout') {
      this.drag = {...base, kind: 'layout', gesture: ctx.store.gesture(hit.handle.kind === 'gap' ? 'Gap' : 'Padding'), doc, handles: hit.handles, handle: hit.handle};
    } else if (hit.kind === 'rotate') {
      const pivot = apply(box.matrix, {x: box.width / 2, y: box.height / 2});
      this.drag = {...base, kind: 'rotate', gesture: ctx.store.gesture('Rotate'), doc, ids, pivot, startAngle: angleFrom(pivot, drag.down.page)};
    } else {
      this.drag = {...base, kind: 'resize', gesture: ctx.store.gesture('Resize'), doc, ids, handle: {hx: hit.hx, hy: hit.hy}, box, start: apply(invert(box.matrix), drag.down.page)};
    }
  }

  private update(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    if (!drag) return;
    drag.last = e;
    switch (drag.kind) {
      case 'move': return this.updateMove(drag, e, ctx);
      case 'marquee': return this.updateMarquee(drag, e, ctx);
      case 'resize': return this.updateResize(drag, e, ctx);
      case 'rotate': return this.updateRotate(drag, e, ctx);
      case 'endpoint': return this.updateEndpoint(drag, e, ctx);
      case 'radius': return this.updateRadius(drag, e, ctx);
      case 'path-start': return this.updatePathStart(drag, e, ctx);
      case 'layout': return this.updateLayout(drag, e, ctx);
      case 'spacing': return this.updateSpacing(drag, e, ctx);
    }
  }

  /** A gap bar of equally spaced layers dragged along their axis: every gap follows the pointer's travel from the press. */
  private updateSpacing(drag: SpacingDrag, e: ToolPointerEvent, ctx: ToolContext) {
    const axis = drag.spacing.axis;
    const travel = e.page[axis] - drag.down.page[axis];
    let gap = drag.spacing.gap;
    drag.gesture.update(tx => {
      gap = applySpacing(tx, drag.doc, drag.spacing, travel);
    });
    const now = this.spacing(ctx.store.getState().doc, ctx.store.getState().selection);
    this.showSpacingGap(ctx, now, now && now.gaps[drag.index] ? drag.index : null, gap);
    ctx.requestOverlay();
  }

  /** A padding bar dragged inward or out (Alt: the opposite side too; Alt and Shift: all four), or a gap bar along the flow:
   *  the value follows the pointer's travel from the press, so it never jumps. */
  private updateLayout(drag: LayoutDrag, e: ToolPointerEvent, ctx: ToolContext) {
    const start = drag.doc.nodes[drag.handles.id];
    if (!start?.autoLayout) return;
    const {handle} = drag;
    const travel = travelAlong(drag.handles, drag.down.page, e.page, handle.kind === 'padding' ? handle.inward : handle.along);
    const partial = handle.kind === 'padding' ? paddingDrag(start, handle.side, travel, {alt: e.altKey, shift: e.shiftKey}) : gapDrag(start, handle.value, travel);
    drag.gesture.update(tx => userUpdate(tx, drag.handles.id, partial));
    const layout = partial.autoLayout!;
    const value = handle.kind === 'gap' ? layout.itemSpacing : layout[({top: 'paddingTop', right: 'paddingRight', bottom: 'paddingBottom', left: 'paddingLeft'} as const)[handle.side]];
    // The band or gap as it is now, with the value.
    const now = layoutHandles(ctx.store.getState().doc, drag.handles.id, ctx.view.viewport());
    const shown = now?.handles.find(h => h.kind === handle.kind && (h.kind === 'gap' ? handle.kind === 'gap' && h.index === handle.index : handle.kind === 'padding' && h.side === handle.side)) ?? null;
    this.showLayoutHandle(ctx, now, shown, value);
    ctx.requestOverlay();
  }

  /** A text on a path's start handle dragged along its path: the text starts at the point of the path nearest the pointer
   *  (`startOffset`, the share of the path's length, read the way the text runs). */
  private updatePathStart(drag: PathStart, e: ToolPointerEvent, ctx: ToolContext) {
    const node = drag.doc.nodes[drag.id];
    const sampler = node?.textPath ? textPathSampler(node.textPath) : null;
    if (!node?.textPath || !sampler) return;
    const local = apply(invert(worldMatrix(drag.doc, drag.id)), e.page);
    const offset = Math.round((projectOnPath(sampler, local).s / sampler.length) * 1000) / 1000;
    const startOffset = Math.max(0, Math.min(1, offset));
    drag.gesture.update(tx => userUpdate(tx, drag.id, {textPath: {...node.textPath!, startOffset}}));
    this.label = {at: e.screen, text: `Start ${formatNumber(startOffset * 100)}%`};
    ctx.requestOverlay();
  }

  /** A radius handle dragged along its corner's diagonal: every corner takes the radius, with Alt only this one (Figma).
   *  The radius follows the pointer's travel from where the handle was grabbed, so it never jumps at the press. */
  private updateRadius(drag: Radius, e: ToolPointerEvent, ctx: ToolContext) {
    const node = drag.doc.nodes[drag.id];
    if (!node) return;
    const toLocal = invert(worldMatrix(drag.doc, drag.id));
    const corner = RADIUS_CORNERS[drag.corner];
    const along = (page: Vec) => {
      const local = apply(toLocal, page);
      return ((local.x - corner.x * node.width) * corner.dx + (local.y - corner.y * node.height) * corner.dy) / 2;
    };
    const radii = cornerRadii(node);
    const limit = Math.min(node.width, node.height) / 2;
    const radius = Math.round(Math.max(0, Math.min(limit, Math.min(radii[drag.corner], limit) + along(e.page) - along(drag.down.page))));
    drag.gesture.update(tx => {
      if (!e.altKey) {
        userUpdate(tx, drag.id, {cornerRadius: radius, rectangleCornerRadii: null});
        return;
      }
      const next = [...radii] as typeof radii;
      next[drag.corner] = radius;
      userUpdate(tx, drag.id, next.every(value => value === next[0]) ? {cornerRadius: next[0], rectangleCornerRadii: null} : {rectangleCornerRadii: next});
    });
    this.label = {at: e.screen, text: `Corner radius ${formatNumber(radius)}`};
    ctx.requestOverlay();
  }

  private snapContext(ctx: ToolContext, doc: DesignDocument, exclude: Iterable<NodeId>) {
    const state = ctx.store.getState();
    return {doc, pageId: state.pageId, zoom: ctx.view.viewport().zoom, exclude: new Set(exclude)};
  }

  private updateMove(drag: Moving, e: ToolPointerEvent, ctx: ToolContext, final = false) {
    const state = ctx.store.getState();
    let dx = e.page.x - drag.down.page.x, dy = e.page.y - drag.down.page.y;
    const lockX = e.shiftKey && Math.abs(dy) > Math.abs(dx), lockY = e.shiftKey && !lockX;
    if (lockX) dx = 0;
    if (lockY) dy = 0;
    const items: OverlayItem[] = [];
    // As in Figma: a layer goes into the frame under the pointer (⌘ only makes that explicit), Space held
    // keeps every layer in its parent, and Control (⌃ on a Mac, Ctrl elsewhere) suspends snapping.
    const target = this.keepParents ? null : frameAtPoint(drag.doc, state.pageId, e.page, new Set(drag.ids), ctx.index()) ?? state.pageId;
    // Over an auto-layout frame the flow decides where layers land: no smart guides there, as in Figma.
    const intoFlow = !!target && isFlowTarget(drag.doc, target) && drag.ids.some(id => drag.doc.nodes[id].layoutPositioning !== 'ABSOLUTE');
    if (!e.ctrlKey && drag.bounds && !intoFlow) {
      const snapped = ctx.snap.snapMove({...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy}, this.snapContext(ctx, drag.doc, drag.ids));
      if (!lockX) dx += snapped.dx;
      if (!lockY) dy += snapped.dy;
      items.push(...snapped.guides);
    }
    const duplicate = e.altKey;
    if (duplicate && !drag.clones) {
      // A main component's Alt-drag copy is an instance of it (commands/components.ts).
      const {nodes, ids} = altDragClones(drag.doc, drag.ids);
      drag.clones = {nodes, ids, original: new Map([...ids].map(([old, fresh]) => [fresh, old]))};
    }
    const snapToPixel = state.ui.snapToPixel;
    let marker: [Vec, Vec] | null = null;
    // The flow is read from what is on screen (the dragged layers lifted out of it), so the insertion
    // line stands between the siblings the user sees. Read it now: the gesture's update rewrites the
    // node table the shown document shares with it.
    const shown = target && state.doc.nodes[target] && isFlowTarget(state.doc, target) ? state.doc : drag.doc;
    // An Alt-drag copy leaves its original in the flow; a move lifts the dragged layers out of it.
    const lifted = new Set(duplicate && drag.clones ? drag.ids.map(id => drag.clones!.ids.get(id)!) : drag.ids);
    const slot = target && isFlowTarget(drag.doc, target) ? flowIndex(shown, target, e.page, lifted) : null;
    let raised: NodeId[] = [];
    drag.gesture.update(tx => {
      raised = [];
      const moving = duplicate ? this.placeClones(tx, drag) : drag.ids;
      drag.ids.forEach((id, i) => {
        const node = drag.doc.nodes[id];
        const local = applyLinear(drag.parentInverse.get(id)!, {x: dx, y: dy});
        let x = node.x + local.x, y = node.y + local.y;
        if (snapToPixel) {
          x = Math.round(x);
          y = Math.round(y);
        }
        tx.update(moving[i], {x, y});
      });
      if (target) marker = this.reparent(tx, drag, moving, target, duplicate, slot, final, raised);
      return duplicate ? {select: moving} : undefined;
    });
    // The same set while the same layers stay lifted, so the renderer sees no change between frames.
    const before = this.liftedIds;
    this.liftedIds = !raised.length ? null : before && before.size === raised.length && raised.every(id => before.has(id)) ? before : new Set(raised);
    if (final) return;
    if (target && target !== state.pageId && (intoFlow || drag.ids.some(id => drag.doc.nodes[id].parentId !== target))) {
      const live = ctx.store.getState().doc;
      items.push({kind: 'polyline', points: boxOutline(live.nodes[target] ? live : drag.doc, target), closed: true, stroke: OVERLAY_COLORS.accent});
    }
    if (marker) items.push({kind: 'line', from: marker[0], to: marker[1], color: OVERLAY_COLORS.accent, width: 2});
    ctx.setOverlayItems(items);
  }

  private placeClones(tx: Transaction, drag: Moving): NodeId[] {
    const clones = drag.clones!;
    insertClones(tx, clones.nodes, root => {
      const original = clones.original.get(root.id)!;
      const parentId = drag.doc.nodes[original].parentId!;
      return {parentId, index: (tx.get(parentId)!.children ?? []).indexOf(original) + 1};
    });
    return drag.ids.map(id => clones.ids.get(id)!);
  }

  /** Moves dragged layers into the frame under the pointer (or out onto the canvas) and, over an
   *  auto-layout frame, shows where they will enter its flow. While the drag runs they follow the
   *  pointer (lifted out of the flow, on top of their siblings) and the marker shows the slot; the
   *  `final` update puts them into the flow there. Returns the flow's insertion marker. */
  private reparent(tx: Transaction, drag: Moving, moving: readonly NodeId[], target: NodeId, duplicate: boolean, slot: {index: number; marker: [Vec, Vec] | null} | null, final: boolean, lifted: NodeId[]): [Vec, Vec] | null {
    const targetNode = tx.get(target);
    if (!targetNode) return null;
    for (const id of moving) {
      const node = tx.get(id)!;
      const parentId = node.parentId!;
      if (parentId === target || !isOpenContainer(tx.get(parentId))) continue;
      let to: NodeId | null = target;
      if (node.type === 'SECTION') {
        // Sections live on the canvas or in other sections only.
        while (to && tx.get(to)?.type !== 'PAGE' && tx.get(to)?.type !== 'SECTION') to = tx.get(to)?.parentId ?? null;
      }
      if (!to || to === parentId || to === id || isAncestor(tx.doc, id, to)) continue;
      // Nothing enters or leaves an instance, no main nests in a component, a set holds only variants.
      if (!dropAllowed(drag.doc, drag.ids[moving.indexOf(id)] ?? id, to, duplicate)) continue;
      tx.move(id, to);
    }
    if (!slot || !isFlowTarget(tx.doc, target)) return null;
    const inFlow = moving.filter(id => tx.get(id)?.parentId === target && tx.get(id)!.layoutPositioning !== 'ABSOLUTE');
    if (!inFlow.length) return null;
    const {index, marker} = slot;
    if (final) {
      placeInFlow(tx, inFlow, index);
      return null;
    }
    for (const id of inFlow) {
      tx.update(id, {layoutPositioning: 'ABSOLUTE'});
      tx.reorder(id, Number.MAX_SAFE_INTEGER);
      lifted.push(id);
    }
    // A hugging frame keeps its size while its own layers are rearranged in it: lifting one must not
    // shrink it under the pointer (the drop restores its sizing with the rest of the base document).
    const frame = drag.doc.nodes[target];
    if (inFlow.some(id => drag.doc.nodes[drag.ids[moving.indexOf(id)] ?? id]?.parentId === target)) {
      const fixed: Partial<SceneNode> = {};
      if (frame.layoutSizingHorizontal === 'HUG') fixed.layoutSizingHorizontal = 'FIXED';
      if (frame.layoutSizingVertical === 'HUG') fixed.layoutSizingVertical = 'FIXED';
      if (fixed.layoutSizingHorizontal || fixed.layoutSizingVertical) tx.update(target, fixed);
    }
    return marker;
  }

  private updateMarquee(drag: Marquee, e: ToolPointerEvent, ctx: ToolContext) {
    const state = ctx.store.getState();
    const rect = rectBetween(drag.down.page, e.page);
    const hits = nodesInRect(state.doc, state.pageId, rect, {context: state.context, scope: drag.scope, index: ctx.index()});
    if (!drag.additive) ctx.store.setSelection(hits);
    else ctx.store.setSelection([...drag.base, ...hits.filter(id => !drag.base.includes(id))]);
    ctx.requestOverlay();
  }

  private updateResize(drag: Resizing, e: ToolPointerEvent, ctx: ToolContext) {
    const state = ctx.store.getState();
    let point = e.page;
    const items: OverlayItem[] = [];
    if (!e.ctrlKey && ctx.snap.snapPoint) {
      // Snap the handle itself (the pointer grabbed it a few px away), along the axes it moves.
      const {hx, hy} = drag.handle;
      const anchor = apply(drag.box.matrix, {x: ((hx + 1) / 2) * drag.box.width, y: ((hy + 1) / 2) * drag.box.height});
      const grabbed = {x: anchor.x + e.page.x - drag.down.page.x, y: anchor.y + e.page.y - drag.down.page.y};
      const axisAligned = Math.abs(drag.box.matrix[0][1]) < 1e-9 && Math.abs(drag.box.matrix[1][0]) < 1e-9;
      const context = {...this.snapContext(ctx, drag.doc, drag.ids), ...(axisAligned ? {axes: {x: hx !== 0, y: hy !== 0}} : {})};
      const snapped = ctx.snap.snapPoint(grabbed, context);
      point = {x: e.page.x + snapped.x - grabbed.x, y: e.page.y + snapped.y - grabbed.y};
      items.push(...snapped.guides);
    }
    const local = apply(invert(drag.box.matrix), point);
    // "Constrain proportions" on the layer (every layer of a selection) keeps the ratio as Shift does.
    const locked = drag.ids.length > 0 && drag.ids.every(id => drag.doc.nodes[id]?.constrainProportions === true);
    const edges = resizeEdges(drag.box.width, drag.box.height, drag.handle, {x: local.x - drag.start.x, y: local.y - drag.start.y}, {keepRatio: e.shiftKey || locked, fromCenter: e.altKey});
    const snapToPixel = state.ui.snapToPixel;
    let text = '';
    drag.gesture.update(tx => {
      if (drag.box.nodeId) {
        const id = drag.box.nodeId;
        const fit = resizeSingle(drag.doc, id, edges, {snapToPixel});
        // ⌘/Ctrl: the frame alone, its layers stay where they are (Figma's "ignore constraints").
        if (e.mod && canResizeAlone(drag.doc.nodes[id])) applyFitAlone(tx, id, fit);
        else applyFit(tx, id, fit);
        const mode = textResizeMode(drag.doc.nodes[id], drag.handle);
        if (mode) tx.update(id, mode);
        text = sizeLabel(fit.box.width, fit.box.height);
        return;
      }
      const from = {x: drag.box.matrix[0][2], y: drag.box.matrix[1][2], width: drag.box.width, height: drag.box.height};
      for (const [id, fit] of resizeMany(drag.doc, drag.ids, from, edges, {snapToPixel})) {
        applyFit(tx, id, fit);
        const mode = textResizeMode(drag.doc.nodes[id], {hx: drag.handle.hx, hy: drag.handle.hy || (fit.box.height !== drag.doc.nodes[id].height ? 1 : 0)});
        if (mode) tx.update(id, mode);
      }
      text = sizeLabel(Math.abs(edges.right - edges.left), Math.abs(edges.bottom - edges.top));
    });
    this.label = {at: e.screen, text};
    ctx.setOverlayItems(items);
  }

  private updateRotate(drag: Rotating, e: ToolPointerEvent, ctx: ToolContext) {
    let radians = angleFrom(drag.pivot, e.page) - drag.startAngle;
    let text: string;
    if (drag.ids.length === 1) {
      const id = drag.ids[0];
      const placement = rotateSingle(drag.doc, id, radians, e.shiftKey ? 15 : 0);
      drag.gesture.update(tx => tx.update(id, placementChanges(drag.doc.nodes[id], placement)));
      text = `${formatNumber(placement.rotation)}°`;
    } else {
      const step = Math.PI / 12;
      if (e.shiftKey) radians = Math.round(radians / step) * step;
      const placements = rotateMany(drag.doc, drag.ids, drag.pivot, radians);
      drag.gesture.update(tx => {
        for (const [id, placement] of placements) tx.update(id, placementChanges(drag.doc.nodes[id], placement));
      });
      text = `${formatNumber(normalizeDegrees((-radians * 180) / Math.PI))}°`;
    }
    this.label = {at: e.screen, text};
    ctx.requestOverlay();
  }

  private updateEndpoint(drag: Endpoint, e: ToolPointerEvent, ctx: ToolContext) {
    let point = e.page;
    const items: OverlayItem[] = [];
    if (!e.ctrlKey && ctx.snap.snapPoint) {
      const snapped = ctx.snap.snapPoint(point, this.snapContext(ctx, drag.doc, [drag.id]));
      point = {x: snapped.x, y: snapped.y};
      items.push(...snapped.guides);
    }
    const fields = moveLineEnd(drag.doc, drag.id, drag.end, point, {snapAngle: e.shiftKey});
    drag.gesture.update(tx => tx.update(drag.id, fields));
    const rotation = fields.rotation ?? 0;
    this.label = {at: e.screen, text: rotation ? `${formatNumber(fields.width ?? 0)} · ${formatNumber(rotation)}°` : formatNumber(fields.width ?? 0)};
    ctx.setOverlayItems(items);
  }
}

export const createMoveTool = () => new MoveTool();
