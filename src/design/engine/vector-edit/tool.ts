import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, applyLinear, invert, multiply, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {drawMarquee, screenMatrix} from '../overlay';
import type {DesignStore, Gesture} from '../store';
import {removeNodes} from '../commands/structure';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from '../tools/types';
import {CURSORS, drawNetwork, GRAB_RADIUS, SEGMENT_TOLERANCE} from './draw';
import {
  anchorAt, anchorsInRect, bendSegment, constrain45, deleteAnchors, hitAnchor, hitHandle, hitSegment, keyOf, moveAnchors, moveHandle, networkOfNode,
  parseKey, pullHandles, allKeys, toggleSmooth, visibleHandles, type AnchorKey, type AnchorRef, type HandleSide, type Network, type SegmentRef,
} from './model';
import {editedVectorId, exitVectorEdit, selectedKeys, sessionOf, setSelectedKeys, writeNetwork} from './session';

// The vector editor's selection tool ("Select", V inside the editor) and its bend tool ("Bend",
// or ⌘ held): pick anchors (click, Shift-click, marquee), drag anchors, handles and segments (a
// dragged segment bends), nudge with the arrows, delete, double-click an anchor to switch it
// between sharp and smooth, and pull handles out of a corner with ⌘. Every drag is one store
// gesture re-run from the document it started on, so it never drifts and undoes in one step; the
// node's box re-fits on every frame (session.ts `writeNetwork`).

const DRAG_THRESHOLD = 3;
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight']);

/** What the editor works on during one press: the node as the press found it. */
export type EditBase = {doc: DesignDocument; id: NodeId; node: SceneNode; network: Network; world: Matrix; inverse: Matrix};

export function editBase(doc: DesignDocument, id: NodeId): EditBase | null {
  const node = doc.nodes[id];
  if (!node) return null;
  const world = worldMatrix(doc, id);
  return {doc, id, node, network: networkOfNode(node), world, inverse: invert(world)};
}

type Hit =
  | {kind: 'handle'; ref: AnchorRef; side: HandleSide}
  | {kind: 'anchor'; ref: AnchorRef}
  | {kind: 'segment'; ref: SegmentRef; t: number; point: Vec}
  | null;

type Press = {down: ToolPointerEvent; last: ToolPointerEvent; base: EditBase; hit: Hit; bend: boolean; selectOnUp: AnchorKey[] | null; additive: boolean};
type Drag =
  | (Press & {kind: 'pending'})
  | (Press & {kind: 'anchors'; gesture: Gesture; refs: AnchorRef[]; grab: Vec})
  | (Press & {kind: 'handle'; gesture: Gesture; ref: AnchorRef; side: HandleSide})
  | (Press & {kind: 'pull'; gesture: Gesture; ref: AnchorRef})
  | (Press & {kind: 'bend'; gesture: Gesture; ref: SegmentRef; t: number; grab: Vec})
  | (Press & {kind: 'marquee'; before: Set<AnchorKey>});

/** Node space → screen px under the current viewport. */
export const toScreenOf = (base: Pick<EditBase, 'world'>, view: ViewHelpers): Matrix => multiply(screenMatrix(view.viewport()), base.world);

export class VectorEditTool implements Tool {
  readonly cursor = 'default';
  private drag: Drag | null = null;
  private hover: Hit = null;
  private store: DesignStore | null = null;
  private held = {mod: false, alt: false, shift: false};
  /** The network of the node as last drawn, kept while the node object is the same. */
  private cache: {doc: DesignDocument; ancestors: readonly SceneNode[]; base: EditBase} | null = null;

  constructor(readonly id: 'vector-edit' | 'vector-bend') {}

  private get bendMode() {
    return this.id === 'vector-bend';
  }

  busy() {
    return !!this.drag && this.drag.kind !== 'pending';
  }

  overlayHints(): OverlayHints {
    return {handles: false, hover: false, sizeBadge: false};
  }

  activate(ctx: ToolContext) {
    this.store = ctx.store;
    ctx.store.setHover(null);
    ctx.setCursor(this.bendMode ? CURSORS.bend : null);
  }

  deactivate(ctx: ToolContext) {
    this.cancel(ctx);
    this.hover = null;
  }

  // ── Pointer ────────────────────────────────────────────────────────────────────────────────

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    this.store = ctx.store;
    const base = this.base(ctx.store);
    if (!base) {
      exitVectorEdit(ctx.store);
      return;
    }
    const bend = this.bendMode || e.mod;
    const hit = this.hitTest(base, e, ctx, selectedKeys(ctx.store, base.network));
    const selected = selectedKeys(ctx.store, base.network);
    const press: Press = {down: e, last: e, base, hit, bend, selectOnUp: null, additive: e.shiftKey};
    if (hit?.kind === 'anchor') {
      const key = keyOf(hit.ref);
      if (e.shiftKey) {
        if (selected.has(key)) press.selectOnUp = [...selected].filter(each => each !== key);
        else setSelectedKeys(ctx.store, [...selected, key]);
      } else if (!selected.has(key) || bend) {
        setSelectedKeys(ctx.store, [key]);
      } else if (selected.size > 1) {
        press.selectOnUp = [key];
      }
    } else if (hit?.kind === 'segment' && !e.shiftKey) {
      // A click selects the segment's two anchors; a drag bends it.
      const sub = base.network[hit.ref.p].subs[hit.ref.s];
      press.selectOnUp = [keyOf(hit.ref), keyOf({...hit.ref, a: (hit.ref.a + 1) % sub.anchors.length})];
    } else if (!hit && !e.shiftKey) {
      press.selectOnUp = [];
    }
    this.drag = {...press, kind: 'pending'};
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    this.store = ctx.store;
    this.held = {mod: e.mod, alt: e.altKey, shift: e.shiftKey};
    const drag = this.drag;
    if (!drag) {
      this.updateHover(e, ctx);
      return;
    }
    drag.last = e;
    if (drag.kind === 'pending') {
      if (Math.hypot(e.screen.x - drag.down.screen.x, e.screen.y - drag.down.screen.y) < DRAG_THRESHOLD) return;
      this.begin(drag, ctx);
    }
    this.update(e, ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.kind === 'pending') {
      if (drag.selectOnUp) setSelectedKeys(ctx.store, drag.selectOnUp);
    } else if ('gesture' in drag) {
      drag.gesture.commit();
    }
    ctx.setOverlayItems([]);
    ctx.snap.end?.();
    this.updateHover(e, ctx);
    ctx.requestOverlay();
  }

  onPointerCancel(ctx: ToolContext) {
    this.cancel(ctx);
  }

  onDoubleClick(e: ToolPointerEvent, ctx: ToolContext) {
    const base = this.base(ctx.store);
    if (!base) return;
    const hit = this.hitTest(base, e, ctx, selectedKeys(ctx.store, base.network));
    if (hit?.kind === 'anchor') {
      const id = base.id;
      ctx.store.transact('Edit point', tx => {
        writeNetwork(tx, id, toggleSmooth(base.network, hit.ref));
      });
      setSelectedKeys(ctx.store, [keyOf(hit.ref)]);
      ctx.requestOverlay();
      return;
    }
    if (!hit && !this.insideNode(base, e.page)) exitVectorEdit(ctx.store);
  }

  // ── Keys ───────────────────────────────────────────────────────────────────────────────────

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    this.store = ctx.store;
    if (MODIFIER_CODES.has(e.code)) {
      this.held = {mod: e.mod, alt: e.altKey, shift: e.shiftKey};
      this.refresh(ctx);
      return false;
    }
    return vectorEditKey(e, ctx, () => this.cancel(ctx), !!this.drag);
  }

  onKeyUp(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (MODIFIER_CODES.has(e.code)) {
      this.held = {mod: e.mod, alt: e.altKey, shift: e.shiftKey};
      this.refresh(ctx);
    }
    return false;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────────────────────

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const store = this.store;
    if (!store) return;
    const base = this.base(store);
    if (!base) return;
    const selected = selectedKeys(store, base.network);
    const hover = this.drag && this.drag.kind !== 'pending' ? null : this.hover;
    drawNetwork(ctx2d, base.network, toScreenOf(base, view), {
      selected,
      handles: visibleHandles(base.network, selected),
      hoverAnchor: hover?.kind === 'anchor' ? hover.ref : null,
      hoverHandle: hover?.kind === 'handle' ? hover : null,
      hoverSegment: hover?.kind === 'segment' ? hover.ref : this.drag?.kind === 'bend' ? this.drag.ref : null,
    });
    if (this.drag?.kind === 'marquee') {
      const a = this.drag.down.screen, b = this.drag.last.screen;
      drawMarquee(ctx2d, {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)});
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  private base(store: DesignStore): EditBase | null {
    const state = store.getState();
    const id = editedVectorId(state);
    if (!id) return null;
    const cached = this.cache;
    if (cached && cached.base.id === id && cached.base.node === state.doc.nodes[id] && cached.doc === state.doc) return cached.base;
    if (cached && cached.base.id === id && cached.base.node === state.doc.nodes[id] && sameAncestry(cached.ancestors, state.doc, id)) {
      this.cache = {doc: state.doc, ancestors: cached.ancestors, base: {...cached.base, doc: state.doc}};
      return this.cache.base;
    }
    const base = editBase(state.doc, id);
    this.cache = base ? {doc: state.doc, ancestors: ancestorsOf(state.doc, id), base} : null;
    return base;
  }

  private insideNode(base: EditBase, page: Vec) {
    const local = apply(base.inverse, page);
    return local.x >= 0 && local.y >= 0 && local.x <= base.node.width && local.y <= base.node.height;
  }

  private hitTest(base: EditBase, e: ToolPointerEvent, ctx: ToolContext, selected: ReadonlySet<AnchorKey>): Hit {
    const m = toScreenOf(base, ctx.view);
    const handle = hitHandle(base.network, visibleHandles(base.network, selected), m, e.screen, GRAB_RADIUS);
    if (handle) return {kind: 'handle', ...handle};
    const anchor = hitAnchor(base.network, m, e.screen, GRAB_RADIUS);
    if (anchor) return {kind: 'anchor', ref: anchor};
    const segment = hitSegment(base.network, apply(base.inverse, e.page), SEGMENT_TOLERANCE * ctx.view.pixel());
    if (segment) return {kind: 'segment', ...segment};
    return null;
  }

  private updateHover(e: ToolPointerEvent, ctx: ToolContext) {
    const base = this.base(ctx.store);
    if (!base) return;
    const hit = this.hitTest(base, e, ctx, selectedKeys(ctx.store, base.network));
    const changed = !sameHit(hit, this.hover);
    this.hover = hit;
    ctx.setCursor(this.bendMode || e.mod ? CURSORS.bend : null);
    if (changed) ctx.requestOverlay();
  }

  private refresh(ctx: ToolContext) {
    ctx.setCursor(this.bendMode || this.held.mod ? CURSORS.bend : null);
    const drag = this.drag;
    if (drag && drag.kind !== 'pending' && drag.kind !== 'marquee') this.update({...drag.last, shiftKey: this.held.shift, altKey: this.held.alt, mod: this.held.mod}, ctx);
  }

  private cancel(ctx: ToolContext) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if ('gesture' in drag) drag.gesture.cancel();
    if (drag.kind === 'marquee') setSelectedKeys(ctx.store, drag.before);
    ctx.setOverlayItems([]);
    ctx.snap.end?.();
    ctx.requestOverlay();
  }

  private begin(drag: Press & {kind: 'pending'}, ctx: ToolContext) {
    const {hit, base} = drag;
    const store = ctx.store;
    const press: Press = {down: drag.down, last: drag.last, base, hit, bend: drag.bend, selectOnUp: null, additive: drag.additive};
    if (!hit) {
      const before = drag.additive ? new Set(selectedKeys(store, base.network)) : new Set<AnchorKey>();
      this.drag = {...press, kind: 'marquee', before};
      return;
    }
    if (hit.kind === 'handle') {
      this.drag = {...press, kind: 'handle', gesture: store.gesture('Edit curve'), ref: hit.ref, side: hit.side};
      return;
    }
    if (hit.kind === 'segment') {
      this.drag = {...press, kind: 'bend', gesture: store.gesture('Bend segment'), ref: hit.ref, t: hit.t, grab: hit.point};
      return;
    }
    if (drag.bend) {
      this.drag = {...press, kind: 'pull', gesture: store.gesture('Bend point'), ref: hit.ref};
      return;
    }
    const refs = [...selectedKeys(store, base.network)].map(parseKey);
    const grabbed = anchorAt(base.network, hit.ref)!;
    this.drag = {...press, kind: 'anchors', gesture: store.gesture('Move points'), refs: refs.length ? refs : [hit.ref], grab: {x: grabbed.x, y: grabbed.y}};
  }

  private update(e: ToolPointerEvent, ctx: ToolContext) {
    const drag = this.drag;
    if (!drag || drag.kind === 'pending') return;
    const {base} = drag;
    const local = apply(base.inverse, e.page);
    switch (drag.kind) {
      case 'marquee': {
        const a = drag.down.screen, b = e.screen;
        const rect: Rect = {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)};
        setSelectedKeys(ctx.store, [...drag.before, ...anchorsInRect(base.network, toScreenOf(base, ctx.view), rect)]);
        ctx.requestOverlay();
        return;
      }
      case 'anchors': {
        const grabPage = apply(base.world, drag.grab);
        let target = {x: grabPage.x + e.page.x - drag.down.page.x, y: grabPage.y + e.page.y - drag.down.page.y};
        if (e.shiftKey) target = constrain45(grabPage, target);
        else target = this.snap(target, base, ctx, e);
        const delta = applyLinear(base.inverse, {x: target.x - grabPage.x, y: target.y - grabPage.y});
        const network = moveAnchors(base.network, drag.refs, delta);
        drag.gesture.update(tx => void writeNetwork(tx, base.id, network));
        break;
      }
      case 'handle': {
        const anchor = anchorAt(base.network, drag.ref)!;
        let point = local;
        if (e.shiftKey) point = constrain45(anchor, point);
        const network = moveHandle(base.network, drag.ref, drag.side, point, e.altKey || drag.bend ? 'independent' : 'auto');
        drag.gesture.update(tx => void writeNetwork(tx, base.id, network));
        break;
      }
      case 'pull': {
        const anchor = anchorAt(base.network, drag.ref)!;
        const point = e.shiftKey ? constrain45(anchor, local) : local;
        const network = pullHandles(base.network, drag.ref, point);
        drag.gesture.update(tx => void writeNetwork(tx, base.id, network));
        break;
      }
      case 'bend': {
        const start = apply(base.inverse, drag.down.page);
        const target = {x: drag.grab.x + local.x - start.x, y: drag.grab.y + local.y - start.y};
        const network = bendSegment(base.network, drag.ref, drag.t, target);
        drag.gesture.update(tx => void writeNetwork(tx, base.id, network));
        break;
      }
    }
    ctx.requestOverlay();
  }

  /** Smart guides and the pixel grid for a dragged anchor (page space). */
  private snap(point: Vec, base: EditBase, ctx: ToolContext, e: ToolPointerEvent): Vec {
    let out = point;
    if (!e.mod && ctx.snap.snapPoint) {
      const state = ctx.store.getState();
      const snapped = ctx.snap.snapPoint(point, {doc: base.doc, pageId: state.pageId, zoom: ctx.view.viewport().zoom, exclude: new Set([base.id])});
      out = {x: snapped.x, y: snapped.y};
      ctx.setOverlayItems(snapped.guides);
    }
    if (ctx.store.getState().ui.snapToPixel) out = {x: Math.round(out.x), y: Math.round(out.y)};
    return out;
  }
}

const sameHit = (a: Hit, b: Hit) =>
  a === b || (!!a && !!b && a.kind === b.kind && keyOf(a.ref) === keyOf(b.ref) && (a.kind !== 'handle' || a.side === (b as {side?: HandleSide}).side));

/** The ancestors of `id`, nearest first, as objects: a document places `id` the same way as long as these are the same
 *  objects. (Kept as objects, not read from the cached document again: the store may write its table in place, so the
 *  cached document's table would show the ancestors as they are now.) */
function ancestorsOf(doc: DesignDocument, id: NodeId): SceneNode[] {
  const out: SceneNode[] = [];
  for (let node = doc.nodes[id]; node?.parentId; node = doc.nodes[node.parentId]) out.push(doc.nodes[node.parentId]);
  return out;
}

function sameAncestry(ancestors: readonly SceneNode[], doc: DesignDocument, id: NodeId): boolean {
  const now = ancestorsOf(doc, id);
  return now.length === ancestors.length && now.every((node, i) => node === ancestors[i]);
}

/** Keys the editor's tools share (the pen falls back to these between paths). Returns whether the
 *  key was used. */
export function vectorEditKey(e: ToolKeyEvent, ctx: ToolContext, cancelDrag: () => void, dragging: boolean): boolean {
  const store = ctx.store;
  const state = store.getState();
  const id = editedVectorId(state);
  if (!id) return false;
  const plain = !e.mod && !e.altKey && !e.ctrlKey && !e.metaKey;
  switch (e.code) {
    case 'Escape':
      if (dragging) cancelDrag();
      else exitVectorEdit(store);
      return true;
    case 'Enter': case 'NumpadEnter':
      if (e.shiftKey) return false;
      exitVectorEdit(store);
      return true;
    case 'Backspace': case 'Delete':
      deleteSelectedAnchors(store);
      return true;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      if (e.mod || e.altKey) return false;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
      const dy = e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0;
      nudgeAnchors(store, {x: dx, y: dy});
      return true;
    }
    case 'KeyA':
      if (!e.mod || e.shiftKey || e.altKey) return false;
      selectAllAnchors(store);
      ctx.requestOverlay();
      return true;
    case 'KeyP':
      if (!plain || e.shiftKey) return false;
      sessionOf(store).drawing = null;
      store.setTool('pen');
      return true;
    case 'KeyV':
      if (!plain || e.shiftKey) return false;
      sessionOf(store).drawing = null;
      store.setTool('vector-edit');
      return true;
  }
  return false;
}

/** Removes the selected anchors; a vector left without anchors is removed and the editor closes. */
export function deleteSelectedAnchors(store: DesignStore): boolean {
  const state = store.getState();
  const id = editedVectorId(state);
  const node = id ? state.doc.nodes[id] : undefined;
  if (!id || !node) return false;
  const network = networkOfNode(node);
  const refs = [...selectedKeys(store, network)].map(parseKey);
  if (!refs.length) return false;
  const next = deleteAnchors(network, refs);
  let removed = false;
  store.transact('Delete points', tx => {
    if (!writeNetwork(tx, id, next)) {
      removeNodes(tx, [id]);
      removed = true;
    }
  });
  setSelectedKeys(store, []);
  if (removed) exitVectorEdit(store);
  return true;
}

/** Arrow keys: the selected anchors move by `delta` page px (one undo step per burst of presses). */
export function nudgeAnchors(store: DesignStore, delta: Vec): boolean {
  const state = store.getState();
  const id = editedVectorId(state);
  const node = id ? state.doc.nodes[id] : undefined;
  if (!id || !node) return false;
  const network = networkOfNode(node);
  const refs = [...selectedKeys(store, network)].map(parseKey);
  if (!refs.length) return false;
  const local = applyLinear(invert(worldMatrix(state.doc, id)), delta);
  store.transact('Move points', tx => void writeNetwork(tx, id, moveAnchors(network, refs, local)), {coalesce: `vector-nudge:${id}`});
  return true;
}

export function selectAllAnchors(store: DesignStore) {
  const state = store.getState();
  const id = editedVectorId(state);
  const node = id ? state.doc.nodes[id] : undefined;
  if (node) setSelectedKeys(store, allKeys(networkOfNode(node)));
}

export const createVectorEditTool = () => new VectorEditTool('vector-edit');
export const createVectorBendTool = () => new VectorEditTool('vector-bend');
