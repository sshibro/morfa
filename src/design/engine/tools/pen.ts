import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, multiply, worldMatrix} from '../../../../shared/design/geometry';
import {BLACK, createNode, newId, SHAPE_GREY, solid} from '../../../../shared/design/defaults';
import {frameAtPoint, isInsideInstance, isLockedInTree, isVisibleInTree} from '../../../../shared/design/tree';
import {OVERLAY_COLORS, screenMatrix} from '../overlay';
import type {DesignStore, Gesture} from '../store';
import {removeNodes} from '../commands/structure';
import {CURSORS, drawAnchor, drawHandle, drawNetwork, GRAB_RADIUS, SEGMENT_TOLERANCE} from '../vector-edit/draw';
import {
  anchorAt, cloneNetwork, closeSubpath, constrain45, deleteAnchors, dragPenHandles, endRef, extendSubpath, hitAnchor, hitSegment, insertAnchor, joinSubpaths,
  keyOf, leadOf, moveAnchors, networkOfNode, openEnds, startSubpath, subAt, visibleHandles, withLead, type AnchorKey, type AnchorRef, type Network, type PenEnd,
  type SegmentRef,
} from '../vector-edit/model';
import {editedVectorId, enterVectorEdit, exitVectorEdit, penEnd, selectedKeys, sessionOf, setPenEnd, setSelectedKeys, writeNetwork} from '../vector-edit/session';
import {editBase, toScreenOf, vectorEditKey, type EditBase} from '../vector-edit/tool';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';

// "Pen" (P). A click adds a sharp anchor, a click-drag a smooth one whose handles mirror (Alt
// while dragging lets the leading handle go alone, Shift keeps directions at 45°). Clicking the
// first anchor closes the path, Enter or Esc finishes, Backspace takes the last anchor back, and a
// click on an open end of a vector continues it. The first click makes a VECTOR and opens the
// vector editor on it (the toolbar turns into the editor's bar), so the anchors drawn so far can
// be edited at once; inside the editor a click on a segment adds an anchor and a click on an anchor
// removes it. Each click is its own store gesture: one undo step per anchor, as in Figma.

const DRAG_THRESHOLD = 2;
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight']);

/** What a click under the pointer will do. */
type Target =
  | {kind: 'add'}
  | {kind: 'close'; end: PenEnd; at: AnchorRef}
  | {kind: 'join'; end: PenEnd; other: PenEnd; at: AnchorRef}
  | {kind: 'continue'; id: NodeId; end: PenEnd; at: AnchorRef}
  | {kind: 'insert'; ref: SegmentRef; t: number}
  | {kind: 'remove'; ref: AnchorRef};

type Drag = {
  gesture: Gesture;
  down: ToolPointerEvent;
  last: ToolPointerEvent;
  /** The node space the anchor lives in (the parent's for a new vector). */
  space: {world: Matrix; inverse: Matrix};
  /** The network the press started from and the anchor it made or grabbed. */
  network: Network;
  ref: AnchorRef;
  /** The network last written (in `space`). */
  current: Network;
  /** How the press changes the network before the drag shapes it. */
  apply: (handles: {out: Vec; in: Vec | null} | null, point: Vec) => Network;
  write: (network: Network) => void;
  dragged: boolean;
  /** Alt froze the trailing handle here (node space). */
  frozenIn: Vec | null;
  /** The node the gesture creates. */
  created: NodeId | null;
  /** After commit: what the pen extends next. */
  next: PenEnd | null;
  /** Inserting moves the new anchor; drawing pulls handles. */
  mode: 'handles' | 'move';
  reversed: boolean;
};

/** Continue targets found on other vectors (outside the editor), cached per node object. */
const networks = new WeakMap<SceneNode, Network>();
const networkFor = (node: SceneNode) => {
  let network = networks.get(node);
  if (!network) networks.set(node, network = networkOfNode(node));
  return network;
};

export class PenTool implements Tool {
  readonly id = 'pen';
  readonly cursor = CURSORS.pen;
  private store: DesignStore | null = null;
  private drag: Drag | null = null;
  private pointer: ToolPointerEvent | null = null;
  private target: Target = {kind: 'add'};
  /** A vector outside the editor whose open end the pointer is over. */
  private foreign: {id: NodeId; network: Network; world: Matrix; at: AnchorRef} | null = null;

  busy() {
    return !!this.drag;
  }

  overlayHints(): OverlayHints {
    return {handles: false, hover: false, sizeBadge: false};
  }

  activate(ctx: ToolContext) {
    this.store = ctx.store;
    ctx.store.setHover(null);
    ctx.setCursor(null);
  }

  deactivate(ctx: ToolContext) {
    if (this.drag) {
      this.drag.gesture.commit();
      this.drag = null;
    }
    this.pointer = null;
    this.foreign = null;
    sessionOf(ctx.store).drawing = null;
    ctx.requestOverlay();
  }

  // ── Pointer ────────────────────────────────────────────────────────────────────────────────

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    this.store = ctx.store;
    this.pointer = e;
    const store = ctx.store;
    const target = this.classify(e, ctx);
    const editing = editedVectorId(store.getState());
    const session = sessionOf(store);
    const base = editing ? this.base(store.getState().doc, editing) : null;
    // The pen's pending lead handle goes back on the end being drawn.
    const pending = penEnd(store);
    const drawn = base && pending ? {...base, network: withLead(base.network, pending)} : base;

    if (target.kind === 'continue') {
      if (!editing || editing !== target.id) {
        if (!enterVectorEdit(store, target.id, {tool: 'pen'})) return;
      }
      setPenEnd(store, {p: target.end.p, s: target.end.s, end: target.end.end});
      setSelectedKeys(store, [keyOf(target.at)]);
      ctx.requestOverlay();
      return;
    }
    if (target.kind === 'remove' && base) {
      const network = deleteAnchors(base.network, [target.ref]);
      let removed = false;
      store.transact('Delete point', tx => {
        if (!writeNetwork(tx, base.id, network)) {
          removeNodes(tx, [base.id]);
          removed = true;
        }
      });
      setSelectedKeys(store, []);
      if (removed) exitVectorEdit(store, {tool: 'pen'});
      this.refreshTarget(ctx);
      return;
    }

    const write = (id: NodeId) => (network: Network) => void this.drag!.gesture.update(tx => void writeNetwork(tx, id, network));
    const point = (space: {world: Matrix; inverse: Matrix}, from: Vec | null) => apply(space.inverse, this.placed(e, ctx, from && apply(space.world, from)));

    if (target.kind === 'insert' && base) {
      const inserted = insertAnchor(base.network, target.ref, target.t);
      if (!inserted) return;
      const start = anchorAt(inserted.network, inserted.ref)!;
      this.begin(ctx, {
        gesture: store.gesture('Add point'), space: base, network: inserted.network, ref: inserted.ref, mode: 'move', reversed: false,
        apply: (_handles, at) => moveAnchors(inserted.network, [inserted.ref], {x: at.x - start.x, y: at.y - start.y}),
        write: write(base.id), created: null, next: null,
      }, e);
      setSelectedKeys(store, [keyOf(inserted.ref)]);
      return;
    }
    if (target.kind === 'close' && base && drawn) {
      const closed = closeSubpath(drawn.network, target.end);
      const fill = session.created.has(base.id) && !base.node.fills.length;
      const reversed = target.end.end === 'start';
      this.begin(ctx, {
        gesture: store.gesture('Pen'), space: base, network: closed, ref: target.at, mode: 'handles', reversed,
        apply: handles => (handles ? dragPenHandles(closed, target.at, handles, reversed) : closed),
        write: network => void this.drag!.gesture.update(tx => {
          writeNetwork(tx, base.id, network);
          // A path the pen closes gets Figma's default shape fill.
          if (fill) tx.update(base.id, {fills: [solid(SHAPE_GREY)]});
        }),
        created: null, next: null,
      }, e);
      setSelectedKeys(store, [keyOf(target.at)]);
      return;
    }
    if (target.kind === 'join' && base && drawn) {
      const joined = joinSubpaths(drawn.network, target.end, target.other);
      if (!joined) return;
      store.transact('Pen', tx => void writeNetwork(tx, base.id, joined.network));
      setPenEnd(store, null);
      setSelectedKeys(store, []);
      this.refreshTarget(ctx);
      return;
    }

    // Adding an anchor: to the open end being drawn, as a new path in the edited vector, or as
    // the first anchor of a new vector.
    const drawing = drawn && session.drawing ? endRef(drawn.network, session.drawing) : null;
    if (base && drawn && session.drawing && drawing) {
      const end = session.drawing;
      const from = anchorAt(drawn.network, drawing)!;
      const at = point(base, from);
      const placed = extendSubpath(drawn.network, end, at)!;
      this.begin(ctx, {
        gesture: store.gesture('Pen'), space: base, network: placed.network, ref: placed.ref, mode: 'handles', reversed: end.end === 'start',
        apply: handles => extendSubpath(drawn.network, end, at, handles ?? undefined)!.network,
        write: write(base.id), created: null, next: {p: end.p, s: end.s, end: end.end},
      }, e);
      setSelectedKeys(store, [keyOf(placed.ref)]);
      return;
    }
    if (base) {
      const at = point(base, null);
      const started = startSubpath(base.network, at);
      const end: PenEnd = {p: started.ref.p, s: started.ref.s, end: 'end'};
      this.begin(ctx, {
        gesture: store.gesture('Pen'), space: base, network: started.network, ref: started.ref, mode: 'handles', reversed: false,
        apply: handles => (handles ? dragPenHandles(started.network, started.ref, handles) : started.network),
        write: write(base.id), created: null, next: end,
      }, e);
      setSelectedKeys(store, [keyOf(started.ref)]);
      return;
    }
    this.startVector(e, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    this.store = ctx.store;
    this.pointer = e;
    const drag = this.drag;
    if (!drag) {
      this.refreshTarget(ctx);
      ctx.requestOverlay();
      return;
    }
    drag.last = e;
    this.shape(drag, e, ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    this.drag = null;
    this.pointer = e;
    if (!drag) return;
    drag.gesture.commit();
    const store = ctx.store;
    const session = sessionOf(store);
    if (drag.created) {
      if (store.getState().doc.nodes[drag.created]) {
        session.created.add(drag.created);
        enterVectorEdit(store, drag.created, {tool: 'pen'});
        setSelectedKeys(store, [keyOf(drag.ref)]);
      }
    }
    // The drag's leading handle waits for the next anchor (the document keeps no handle past an end).
    setPenEnd(store, drag.next ? {...drag.next, lead: drag.mode === 'handles' ? leadOf(anchorAt(drag.current, drag.ref), drag.next) : null} : null);
    ctx.setOverlayItems([]);
    ctx.snap.end?.();
    this.refreshTarget(ctx);
    ctx.requestOverlay();
  }

  onPointerCancel(ctx: ToolContext) {
    if (this.drag) {
      this.drag.gesture.cancel();
      this.drag = null;
    }
    ctx.setOverlayItems([]);
    ctx.requestOverlay();
  }

  // ── Keys ───────────────────────────────────────────────────────────────────────────────────

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    this.store = ctx.store;
    if (MODIFIER_CODES.has(e.code)) {
      if (this.pointer) this.pointer = {...this.pointer, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.mod};
      if (this.drag) this.shape(this.drag, {...this.drag.last, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.mod}, ctx);
      else this.refreshTarget(ctx);
      ctx.requestOverlay();
      return false;
    }
    const store = ctx.store;
    const editing = editedVectorId(store.getState());
    const session = sessionOf(store);
    if ((e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') && this.drag) {
      this.drag.gesture.cancel();
      this.drag = null;
      ctx.requestOverlay();
      return true;
    }
    if (!editing) return false;
    if ((e.code === 'Backspace' || e.code === 'Delete') && session.drawing && !this.drag) {
      this.removeLast(ctx);
      return true;
    }
    if (this.drag) return e.code === 'Backspace' || e.code === 'Delete';
    return vectorEditKey(e, ctx, () => {}, false);
  }

  onKeyUp(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (MODIFIER_CODES.has(e.code)) {
      if (this.pointer) this.pointer = {...this.pointer, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.mod};
      if (this.drag) this.shape(this.drag, {...this.drag.last, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.mod}, ctx);
      ctx.requestOverlay();
    }
    return false;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────────────────────

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const store = this.store;
    if (!store) return;
    const state = store.getState();
    const editing = editedVectorId(state);
    const base = editing ? this.base(state.doc, editing) : null;
    const screen = screenMatrix(view.viewport());
    ctx2d.save();
    if (this.foreign && !base) {
      const m = multiply(screen, this.foreign.world);
      drawNetwork(ctx2d, this.foreign.network, m, {selected: new Set(), handles: [], hoverAnchor: this.foreign.at, ends: new Set([keyOf(this.foreign.at)])});
    }
    if (base) {
      const session = sessionOf(store);
      const network = withLead(base.network, penEnd(store));
      const selected = selectedKeys(store, base.network);
      const m = toScreenOf(base, view);
      const drawing = session.drawing ? endRef(network, session.drawing) : null;
      const target = this.drag ? null : this.target;
      const ends = new Set<AnchorKey>();
      if (!session.drawing) for (const end of openEnds(network)) {
        const ref = endRef(network, end);
        if (ref) ends.add(keyOf(ref));
      }
      drawNetwork(ctx2d, network, m, {
        selected,
        handles: visibleHandles(network, selected),
        hoverAnchor: target && (target.kind === 'close' || target.kind === 'join' || target.kind === 'continue' || target.kind === 'remove') ? ('at' in target ? target.at : target.ref) : null,
        hoverSegment: target?.kind === 'insert' ? target.ref : null,
        ends,
      });
      // The anchor being drawn with both its handles: the leading one shapes the next segment.
      const live = this.drag && this.drag.mode === 'handles'
        ? {anchor: anchorAt(this.drag.current, this.drag.ref), m: multiply(screen, this.drag.space.world)}
        : drawing ? {anchor: anchorAt(network, drawing), m} : null;
      if (live?.anchor) {
        const at = apply(live.m, live.anchor);
        if (live.anchor.in) drawHandle(ctx2d, at, apply(live.m, live.anchor.in), {});
        if (live.anchor.out) drawHandle(ctx2d, at, apply(live.m, live.anchor.out), {});
        drawAnchor(ctx2d, at, {selected: true});
      }
      // The rubber band from the open end to where the next click lands.
      if (drawing && !this.drag && this.pointer && (target?.kind === 'add' || target?.kind === 'close' || target?.kind === 'join')) {
        const from = anchorAt(network, drawing)!;
        const lead = session.drawing!.end === 'start' ? from.in : from.out;
        const toPage = target.kind === 'add' ? this.placed(this.pointer, null, apply(base.world, from), true) : apply(base.world, anchorAt(network, target.at)!);
        const p0 = apply(m, from), p1 = view.pageToScreen(toPage);
        ctx2d.beginPath();
        ctx2d.moveTo(p0.x, p0.y);
        if (lead) {
          const c = apply(m, lead);
          ctx2d.bezierCurveTo(c.x, c.y, p1.x, p1.y, p1.x, p1.y);
        } else ctx2d.lineTo(p1.x, p1.y);
        ctx2d.strokeStyle = OVERLAY_COLORS.accent;
        ctx2d.lineWidth = 1;
        ctx2d.stroke();
      }
    } else if (this.drag?.created) {
      // The first anchor of a new vector, before the editor opens on it.
      const anchor = anchorAt(this.drag.current, this.drag.ref);
      if (anchor) {
        const m = multiply(screen, this.drag.space.world);
        const at = apply(m, anchor);
        if (anchor.in) drawHandle(ctx2d, at, apply(m, anchor.in), {});
        if (anchor.out) drawHandle(ctx2d, at, apply(m, anchor.out), {});
        drawAnchor(ctx2d, at, {selected: true});
      }
    }
    ctx2d.restore();
  }

  /** The edited node as the pen reads it, kept while the node object stays the same. */
  private baseCache: {doc: DesignDocument; base: EditBase} | null = null;

  private base(doc: DesignDocument, id: NodeId): EditBase | null {
    const cached = this.baseCache;
    if (cached && cached.doc === doc && cached.base.id === id) return cached.base;
    if (cached && cached.base.id === id && cached.base.node === doc.nodes[id] && worldMatrix(doc, id).every((row, i) => row.every((v, j) => v === cached.base.world[i][j]))) {
      this.baseCache = {doc, base: {...cached.base, doc}};
      return this.baseCache.base;
    }
    const base = editBase(doc, id);
    this.baseCache = base ? {doc, base} : null;
    return base;
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  private begin(ctx: ToolContext, drag: Omit<Drag, 'down' | 'last' | 'dragged' | 'frozenIn' | 'current'>, e: ToolPointerEvent) {
    this.drag = {...drag, down: e, last: e, dragged: false, frozenIn: null, current: drag.network};
    this.put(this.drag, drag.apply(null, anchorAt(drag.network, drag.ref)!));
    ctx.requestOverlay();
  }

  private put(drag: Drag, network: Network) {
    drag.current = network;
    drag.write(network);
  }

  /** Re-runs the press with the pointer at `e`: handles for a drawn anchor, a move for an inserted one. */
  private shape(drag: Drag, e: ToolPointerEvent, ctx: ToolContext) {
    if (!drag.dragged && Math.hypot(e.screen.x - drag.down.screen.x, e.screen.y - drag.down.screen.y) < DRAG_THRESHOLD) return;
    drag.dragged = true;
    const anchor = anchorAt(drag.network, drag.ref)!;
    if (drag.mode === 'move') {
      const at = apply(drag.space.inverse, this.placed(e, ctx, null));
      this.put(drag, drag.apply(null, at));
      ctx.requestOverlay();
      return;
    }
    let lead = apply(drag.space.inverse, e.page);
    if (e.shiftKey) lead = constrain45(anchor, lead);
    // Alt lets the leading handle go alone: the trailing one stays where it was when Alt went down.
    if (e.altKey && !drag.frozenIn) {
      const current = anchorAt(drag.apply({out: lead, in: null}, anchor), drag.ref);
      drag.frozenIn = current ? (drag.reversed ? current.out : current.in) : null;
    }
    this.put(drag, drag.apply({out: lead, in: e.altKey || drag.frozenIn ? drag.frozenIn : null}, anchor));
    ctx.requestOverlay();
  }

  /** Where a click lands (page space): Shift keeps 45° from the previous anchor, otherwise smart
   *  guides and the pixel grid apply. */
  private placed(e: ToolPointerEvent, ctx: ToolContext | null, from: Vec | null, preview = false): Vec {
    if (e.shiftKey && from) return constrain45(from, e.page);
    let point = e.page;
    const store = ctx?.store ?? this.store;
    if (!store) return point;
    // Control suspends snapping, as everywhere in the editor (Figma's behaviour).
    if (ctx && !e.ctrlKey && ctx.snap.snapPoint && !preview) {
      const state = store.getState();
      const editing = editedVectorId(state);
      const snapped = ctx.snap.snapPoint(point, {doc: state.doc, pageId: state.pageId, zoom: ctx.view.viewport().zoom, exclude: new Set(editing ? [editing] : [])});
      point = {x: snapped.x, y: snapped.y};
      ctx.setOverlayItems(snapped.guides);
    }
    if (store.getState().ui.snapToPixel) point = {x: Math.round(point.x), y: Math.round(point.y)};
    return point;
  }

  /** The first click of a new vector: it goes into the frame under the pointer (or the page). */
  private startVector(e: ToolPointerEvent, ctx: ToolContext) {
    const store = ctx.store;
    const state = store.getState();
    const {doc, pageId} = state;
    const parentId = frameAtPoint(doc, pageId, e.page, new Set(), ctx.index()) ?? pageId;
    const parent = doc.nodes[parentId];
    const world = worldMatrix(doc, parentId);
    const space = {world, inverse: invert(world)};
    const at = apply(space.inverse, this.placed(e, ctx, null));
    const id = newId();
    const absolute = !!parent.autoLayout && parent.autoLayout.layoutMode !== 'NONE';
    const started = startSubpath([], at);
    const make = (network: Network) => this.drag!.gesture.update(tx => {
      tx.create(createNode('VECTOR', {
        id, parentId, x: 0, y: 0, width: 0, height: 0, vectorPaths: [], fills: [], strokes: [solid(BLACK)], strokeWeight: 1,
        ...(absolute ? {layoutPositioning: 'ABSOLUTE' as const} : {}),
      }), parentId);
      writeNetwork(tx, id, network);
      return {select: [id]};
    });
    this.begin(ctx, {
      gesture: store.gesture('Pen'), space, network: started.network, ref: started.ref, mode: 'handles', reversed: false,
      apply: handles => (handles ? dragPenHandles(started.network, started.ref, handles) : started.network),
      write: make, created: id, next: {p: 0, s: 0, end: 'end'},
    }, e);
  }

  /** Backspace while drawing: the last anchor goes (the vector too when it was the only one). */
  private removeLast(ctx: ToolContext) {
    const store = ctx.store;
    const session = sessionOf(store);
    const id = editedVectorId(store.getState());
    const end = session.drawing;
    if (!id || !end) return;
    const base = editBase(store.getState().doc, id);
    const ref = base && endRef(base.network, end);
    if (!base || !ref) return;
    const network = cloneNetwork(base.network);
    const sub = subAt(network, ref)!;
    // The anchor that becomes the end keeps the handle it had towards the removed one.
    const lead = leadOf(sub.anchors[end.end === 'end' ? ref.a - 1 : ref.a + 1], end);
    sub.anchors.splice(ref.a, 1);
    if (!sub.anchors.length) {
      network[ref.p].subs.splice(ref.s, 1);
      if (!network[ref.p].subs.length) network.splice(ref.p, 1);
    }
    let removed = false;
    store.transact('Delete point', tx => {
      if (!writeNetwork(tx, id, network)) {
        removeNodes(tx, [id]);
        removed = true;
      }
    });
    if (removed) {
      exitVectorEdit(store, {tool: 'pen'});
      return;
    }
    const remaining = subAt(network, ref);
    if (!remaining || !remaining.anchors.length) {
      session.drawing = null;
      setSelectedKeys(store, []);
    } else {
      setPenEnd(store, {p: end.p, s: end.s, end: end.end, lead});
      setSelectedKeys(store, [keyOf(endRef(network, end)!)]);
    }
    ctx.requestOverlay();
  }

  private refreshTarget(ctx: ToolContext) {
    if (!this.pointer) return;
    this.target = this.classify(this.pointer, ctx);
    const cursor = this.target.kind === 'close' || this.target.kind === 'join' ? CURSORS.penClose
      : this.target.kind === 'continue' ? CURSORS.penContinue
      : this.target.kind === 'insert' ? CURSORS.penAdd
      : this.target.kind === 'remove' ? CURSORS.penRemove
      : null;
    ctx.setCursor(cursor);
  }

  /** What a click at `e` does, from the editor's state and what is under the pointer. */
  private classify(e: ToolPointerEvent, ctx: ToolContext): Target {
    this.foreign = null;
    const store = ctx.store;
    const state = store.getState();
    const editing = editedVectorId(state);
    if (!editing) {
      const found = this.findOpenEnd(e, ctx);
      if (found) {
        this.foreign = found;
        return {kind: 'continue', id: found.id, end: found.end, at: found.at};
      }
      return {kind: 'add'};
    }
    const base = this.base(state.doc, editing);
    if (!base) return {kind: 'add'};
    const session = sessionOf(store);
    const m = toScreenOf(base, ctx.view);
    const drawing = session.drawing ? endRef(base.network, session.drawing) : null;
    if (session.drawing && drawing) {
      const end = session.drawing;
      const sub = subAt(base.network, end)!;
      const other = end.end === 'end' ? {...drawing, a: 0} : {...drawing, a: sub.anchors.length - 1};
      // Closing: the other end of the same path, once it has two anchors.
      if (sub.anchors.length >= 2) {
        const hit = hitAnchor(base.network, m, e.screen, GRAB_RADIUS, ref => ref.p === other.p && ref.s === other.s && ref.a === other.a);
        if (hit) return {kind: 'close', end, at: other};
      }
      // Joining: an open end of another path of the same vector.
      for (const candidate of openEnds(base.network)) {
        if (candidate.p !== end.p || candidate.s === end.s) continue;
        const ref = endRef(base.network, candidate)!;
        const hit = hitAnchor(base.network, m, e.screen, GRAB_RADIUS, r => r.p === ref.p && r.s === ref.s && r.a === ref.a);
        if (hit) return {kind: 'join', end, other: candidate, at: ref};
      }
      return {kind: 'add'};
    }
    for (const candidate of openEnds(base.network)) {
      const ref = endRef(base.network, candidate)!;
      if (hitAnchor(base.network, m, e.screen, GRAB_RADIUS, r => r.p === ref.p && r.s === ref.s && r.a === ref.a)) return {kind: 'continue', id: editing, end: candidate, at: ref};
    }
    const anchor = hitAnchor(base.network, m, e.screen, GRAB_RADIUS);
    if (anchor) return {kind: 'remove', ref: anchor};
    const segment = hitSegment(base.network, apply(base.inverse, e.page), SEGMENT_TOLERANCE * ctx.view.pixel());
    if (segment) return {kind: 'insert', ref: segment.ref, t: segment.t};
    return {kind: 'add'};
  }

  /** An open end of a visible, editable vector under the pointer (outside the editor). Looks only
   *  near the pointer through the spatial index, or at the selection without one. */
  private findOpenEnd(e: ToolPointerEvent, ctx: ToolContext): {id: NodeId; end: PenEnd; at: AnchorRef; network: Network; world: Matrix} | null {
    const state = ctx.store.getState();
    const {doc} = state;
    const reach = GRAB_RADIUS * ctx.view.pixel();
    const index = ctx.index();
    const candidates = index ? index.query({x: e.page.x - reach, y: e.page.y - reach, width: reach * 2, height: reach * 2}) : state.selection;
    const screen = screenMatrix(ctx.view.viewport());
    for (const id of candidates) {
      const node = doc.nodes[id];
      if (node?.type !== 'VECTOR' || !openable(doc, id)) continue;
      const network = networkFor(node);
      const world = worldMatrix(doc, id);
      const m = multiply(screen, world);
      for (const end of openEnds(network)) {
        const ref = endRef(network, end)!;
        if (hitAnchor(network, m, e.screen, GRAB_RADIUS, r => r.p === ref.p && r.s === ref.s && r.a === ref.a)) return {id, end, at: ref, network, world};
      }
    }
    return null;
  }
}

const openable = (doc: DesignDocument, id: NodeId) => isVisibleInTree(doc, id) && !isLockedInTree(doc, id) && !isInsideInstance(doc, id);

export const createPenTool = () => new PenTool();
export type {EditBase};
