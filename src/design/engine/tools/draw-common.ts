import type {DesignDocument, Matrix, NodeId, NodeType, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, normalizeDegrees, rectContains, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {createNode, newId, TYPE_NAMES} from '../../../../shared/design/defaults';
import {boundsOf, isAutoLayout} from '../../../../shared/design/constraints';
import type {Transaction} from '../../../../shared/design/transaction';
import {frameAtPoint, nextLayerName, pageIdOf, type SpatialIndex} from '../../../../shared/design/tree';
import type {OverlayItem} from '../overlay';
import type {SmartSnapContext} from '../snapping';
import type {Gesture} from '../store';
import type {OverlayHints, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent} from './types';

// What the drawing tools share (Rectangle R, Ellipse O, Line L, Arrow ⇧L, Polygon,
// Star, Frame F/A, Section ⇧S, Slice S, Image): a press starts the shape where the pointer
// is, a drag draws it from that corner (Shift: a square, a circle or a 45° line; Alt: from the centre;
// Space held: moves the shape being drawn), a plain click makes the default 100 × 100. The new layer
// goes into the frame under the pointer (or the page), takes the next numbered name ("Rectangle
// 2"), becomes the selection, and the tool hands back to "Move", as in Figma. Frames and
// sections drawn around layers adopt the ones they enclose. The drag is one store gesture: one undo
// step, and every pointer move re-runs it from the document the press saw.

/** Screen px a press must travel before it draws instead of clicking. */
export const DRAW_THRESHOLD = 2;
/** What a click makes. */
export const DEFAULT_SIZE = 100;
const NO_IDS: ReadonlySet<NodeId> = new Set();
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight']);

export type DrawModifiers = {
  /** Shift: equal sides (or the given ratio), lines on 45° steps. */
  square?: boolean;
  /** Alt: the press is the centre. */
  fromCenter?: boolean;
  /** Width ÷ height kept whatever the modifiers (placing a picture). */
  ratio?: number | null;
};

const sign = (value: number) => (value < 0 ? -1 : 1);

/** The box a drag from `start` to `end` draws. */
export function dragRect(start: Vec, end: Vec, mods: DrawModifiers = {}): Rect {
  let dx = end.x - start.x, dy = end.y - start.y;
  const ratio = mods.ratio ?? (mods.square ? 1 : null);
  if (ratio && ratio > 0) {
    // The side that went further leads; the other follows the ratio.
    const width = Math.max(Math.abs(dx), Math.abs(dy) * ratio);
    dx = sign(dx) * width;
    dy = sign(dy) * (width / ratio);
  }
  if (mods.fromCenter) return {x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2};
  return {x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), width: Math.abs(dx), height: Math.abs(dy)};
}

/** The ends of a line drawn from `start` to `end`: Shift keeps 45° steps, Alt grows it both ways. */
export function dragLine(start: Vec, end: Vec, mods: DrawModifiers = {}): {from: Vec; to: Vec} {
  let dx = end.x - start.x, dy = end.y - start.y;
  if (mods.square) {
    // The pointer projected onto the nearest 45° direction, so a flat line ends under the pointer.
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const length = dx * Math.cos(angle) + dy * Math.sin(angle);
    dx = Math.cos(angle) * length;
    dy = Math.sin(angle) * length;
    if (Math.abs(dx) < 1e-9) dx = 0;
    if (Math.abs(dy) < 1e-9) dy = 0;
  }
  if (mods.fromCenter) return {from: {x: start.x - dx, y: start.y - dy}, to: {x: start.x + dx, y: start.y + dy}};
  return {from: start, to: {x: start.x + dx, y: start.y + dy}};
}

/** A LINE's fields for ends `from` → `to` in its parent's space. */
export function lineFields(from: Vec, to: Vec): Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation'> {
  const dx = to.x - from.x, dy = to.y - from.y;
  const width = Math.hypot(dx, dy);
  return {x: from.x, y: from.y, width, height: 0, rotation: width ? normalizeDegrees((-Math.atan2(dy, dx) * 180) / Math.PI) : 0};
}

/** The box a click makes: `width` × `height` with its corner (or with Alt its centre) at `at`. */
export const clickRect = (at: Vec, width: number, height: number, fromCenter = false): Rect =>
  fromCenter ? {x: at.x - width / 2, y: at.y - height / 2, width, height} : {x: at.x, y: at.y, width, height};

/** The container a new layer of `type` drawn at page point `point` goes into: the frame under the
 *  pointer or the page. Sections live on the canvas or in other sections only. */
export function drawParent(doc: DesignDocument, pageId: NodeId, point: Vec, type: NodeType, index: SpatialIndex | null = null): NodeId {
  let parent = frameAtPoint(doc, pageId, point, NO_IDS, index) ?? pageId;
  if (type === 'SECTION') {
    while (parent !== pageId && doc.nodes[parent]?.type !== 'SECTION') parent = doc.nodes[parent]?.parentId ?? pageId;
  }
  return parent;
}

/** Where in an auto-layout parent's flow a layer drawn at `local` (the parent's space) goes. */
export function flowIndexAt(doc: DesignDocument, parentId: NodeId, local: Vec): number | undefined {
  const parent = doc.nodes[parentId];
  if (!isAutoLayout(parent)) return undefined;
  const horizontal = parent.autoLayout!.layoutMode === 'HORIZONTAL';
  const children = parent.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = doc.nodes[children[i]];
    if (!child?.visible || child.layoutPositioning === 'ABSOLUTE') continue;
    const centre = horizontal ? child.x + child.width / 2 : child.y + child.height / 2;
    if ((horizontal ? local.x : local.y) < centre) return i;
  }
  return children.length;
}

/** Layers of `parentId` a new frame or section with box `rect` (the parent's space) takes in: the
 *  visible, unlocked ones it encloses entirely, in their order. Never in an auto-layout parent; frames
 *  never take sections. `candidates` narrows the search (the spatial index's hits under the box). */
export function adoptable(doc: DesignDocument, parentId: NodeId, rect: Rect, type: NodeType, candidates?: Iterable<NodeId>): NodeId[] {
  const parent = doc.nodes[parentId];
  if (!parent || isAutoLayout(parent) || rect.width <= 0 || rect.height <= 0) return [];
  const usable = (id: NodeId) => {
    const node = doc.nodes[id];
    if (!node || node.parentId !== parentId || !node.visible || node.locked) return false;
    if (type !== 'SECTION' && node.type === 'SECTION') return false;
    return rectContains(rect, boundsOf(node));
  };
  if (!candidates) return (parent.children ?? []).filter(usable);
  const hits = new Set<NodeId>();
  for (const id of candidates) if (usable(id)) hits.add(id);
  return hits.size ? (parent.children ?? []).filter(id => hits.has(id)) : [];
}

/** "Rectangle 3" after "Rectangle 1" and "Rectangle 2" anywhere on the page (Figma numbers by
 *  type across the page, not per frame). */
export const newLayerName = (doc: DesignDocument, parentId: NodeId, base: string) => nextLayerName(doc, pageIdOf(doc, parentId), base);

export type DrawSpec = {
  /** Tool id (src/design/editor/chrome/tools.ts). */
  id: string;
  type: NodeType;
  /** Undo label and the base of the layer's name. Default: the type's name. */
  label?: string;
  /** Extra fields of the new layer (an arrow's end marker). */
  props?: Partial<SceneNode>;
  /** Draws two ends instead of a box. */
  line?: boolean;
  /** Takes in the layers it is drawn around. */
  adopt?: boolean;
  cursor?: string;
};

export type Drawing = {
  down: ToolPointerEvent;
  last: ToolPointerEvent;
  /** Page point the shape starts from (snapped). */
  start: Vec;
  /** Where the pointer was at the last update (Space moves the start along with it). */
  previous: Vec;
  doc: DesignDocument;
  parentId: NodeId;
  toLocal: Matrix;
  index: number | undefined;
  id: NodeId;
  name: string;
  gesture: Gesture | null;
  space: boolean;
  release: () => void;
};

/** The drawing tool for one kind of layer. Subclasses (the image tool) change what a box becomes. */
export class DrawTool implements Tool {
  readonly id: string;
  readonly cursor: string;
  protected drawing: Drawing | null = null;

  constructor(protected readonly spec: DrawSpec) {
    this.id = spec.id;
    this.cursor = spec.cursor ?? 'crosshair';
  }

  get label() {
    return this.spec.label ?? TYPE_NAMES[this.spec.type];
  }

  busy() {
    return !!this.drawing;
  }

  overlayHints(): OverlayHints {
    return {hover: false, handles: false};
  }

  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
  }

  deactivate(ctx: ToolContext) {
    this.cancel(ctx);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0 || this.drawing) return;
    const {store} = ctx;
    if (store.getState().editing) store.setEditing(null);
    const state = store.getState();
    const doc = state.doc;
    const parentId = drawParent(doc, state.pageId, e.page, this.spec.type, ctx.index());
    const start = this.snap(e.page, e, ctx, doc, parentId).point;
    const toLocal = invert(worldMatrix(doc, parentId));
    this.drawing = {
      down: e, last: e, start, previous: e.page, doc, parentId, toLocal,
      index: flowIndexAt(doc, parentId, apply(toLocal, start)),
      id: newId(), name: newLayerName(doc, parentId, this.label), gesture: null, space: false,
      release: this.listenForSpace(),
    };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const drawing = this.drawing;
    if (!drawing) return;
    if (!drawing.gesture && Math.hypot(e.screen.x - drawing.down.screen.x, e.screen.y - drawing.down.screen.y) < DRAW_THRESHOLD) return;
    drawing.last = e;
    if (!drawing.gesture) drawing.gesture = ctx.store.gesture(this.label);
    this.update(ctx, false);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    const drawing = this.drawing;
    if (!drawing) return;
    if (drawing.gesture) {
      drawing.last = e;
      this.update(ctx, true);
      drawing.gesture.commit();
    } else {
      this.clickCreate(drawing, ctx);
    }
    this.finish(ctx);
    const created = ctx.store.getState().doc.nodes[drawing.id];
    if (created) this.created(drawing.id, ctx);
    else ctx.setTool('move');
  }

  onPointerCancel(ctx: ToolContext) {
    this.cancel(ctx);
  }

  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (e.code === 'Escape') {
      if (this.drawing) this.cancel(ctx);
      else ctx.setTool('move');
      return true;
    }
    // Enter places what a click would, centred in the view: drawing without a pointer, as Figma's keyboard controls.
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && e.type === 'keydown' && !this.drawing && !e.mod && !e.repeat) {
      this.placeAtCentre(ctx);
      return true;
    }
    if (MODIFIER_CODES.has(e.code)) this.refresh(ctx);
    return false;
  }

  onKeyUp(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (MODIFIER_CODES.has(e.code)) this.refresh(ctx);
    return false;
  }

  // ── What a box becomes (the image tool overrides these) ────────────────────────────────────

  /** Width ÷ height the drawn box keeps, or null. */
  protected ratio(): number | null {
    return null;
  }

  /** The size a click makes. */
  protected clickSize(): {width: number; height: number} {
    return {width: DEFAULT_SIZE, height: DEFAULT_SIZE};
  }

  /** The new layer for a box in its parent's space. */
  protected makeNode(drawing: Drawing, box: Rect): SceneNode {
    return createNode(this.spec.type, {
      ...this.spec.props,
      id: drawing.id, name: drawing.name,
      x: box.x, y: box.y, width: Math.max(1, box.width), height: Math.max(1, box.height),
    });
  }

  /** Whether a click makes the layer around the pointer (Alt) or from its corner. */
  protected clickFromCenter(e: ToolPointerEvent): boolean {
    return e.altKey;
  }

  /** After the layer exists (committed). Default: back to "Move". */
  protected created(_id: NodeId, ctx: ToolContext) {
    ctx.setTool('move');
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  private makeLine(drawing: Drawing, from: Vec, to: Vec): SceneNode {
    return createNode('LINE', {...this.spec.props, id: drawing.id, name: drawing.name, ...lineFields(apply(drawing.toLocal, from), apply(drawing.toLocal, to))});
  }

  private build(tx: Transaction, drawing: Drawing, node: SceneNode, adopted: readonly NodeId[] = []) {
    tx.create(node, drawing.parentId, drawing.index);
    for (const id of adopted) tx.move(id, node.id);
    return {select: [node.id]};
  }

  /** What a frame or section drawn to `pageBox` takes in right now (it changes as the drag grows). */
  private adopted(ctx: ToolContext, drawing: Drawing, node: SceneNode, pageBox: Rect): NodeId[] {
    if (!this.spec.adopt) return [];
    const index = ctx.index();
    return adoptable(drawing.doc, drawing.parentId, {x: node.x, y: node.y, width: node.width, height: node.height}, this.spec.type, index ? index.query(pageBox) : undefined);
  }

  private update(ctx: ToolContext, final: boolean) {
    const drawing = this.drawing;
    if (!drawing?.gesture) return;
    const e = drawing.last;
    if (drawing.space) {
      drawing.start = {x: drawing.start.x + e.page.x - drawing.previous.x, y: drawing.start.y + e.page.y - drawing.previous.y};
    }
    drawing.previous = e.page;
    const {point: end, guides} = drawing.space ? {point: e.page, guides: [] as OverlayItem[]} : this.snap(e.page, e, ctx, drawing.doc, drawing.parentId);
    const mods = {square: e.shiftKey, fromCenter: e.altKey, ratio: this.ratio()};
    let node: SceneNode;
    let adopted: NodeId[] = [];
    if (this.spec.line) {
      const {from, to} = dragLine(drawing.start, end, mods);
      node = this.makeLine(drawing, from, to);
    } else {
      const pageBox = dragRect(drawing.start, end, mods);
      node = this.makeNode(drawing, this.localBox(drawing, pageBox));
      // Frames and sections take in what they enclose while they are drawn, as in Figma.
      adopted = this.adopted(ctx, drawing, node, pageBox);
    }
    drawing.gesture.update(tx => this.build(tx, drawing, node, adopted));
    ctx.setOverlayItems(final ? [] : guides);
  }

  /** A page-space box in the parent's space (its axis-aligned bounds when the parent is turned). */
  private localBox(drawing: Drawing, box: Rect): Rect {
    const a = apply(drawing.toLocal, {x: box.x, y: box.y}), b = apply(drawing.toLocal, {x: box.x + box.width, y: box.y + box.height});
    const c = apply(drawing.toLocal, {x: box.x + box.width, y: box.y}), d = apply(drawing.toLocal, {x: box.x, y: box.y + box.height});
    const left = Math.min(a.x, b.x, c.x, d.x), top = Math.min(a.y, b.y, c.y, d.y);
    // Keep the drawn size (a turned parent would otherwise inflate it).
    return {x: left, y: top, width: box.width, height: box.height};
  }

  /** A click at the middle of the canvas, made from its centre (⌥), so the new layer stands in the middle of the view. */
  private placeAtCentre(ctx: ToolContext) {
    const size = ctx.view.size();
    const screen = {x: size.width / 2, y: size.height / 2};
    const click: ToolPointerEvent = {
      screen, page: ctx.view.screenToPage(screen), button: 0, buttons: 1, shiftKey: false, altKey: true, metaKey: false, ctrlKey: false, mod: false,
      pointerId: -1, pointerType: 'keyboard', pressure: 0, detail: 1, timeStamp: Date.now(),
    };
    this.onPointerDown(click, ctx);
    this.onPointerUp({...click, buttons: 0}, ctx);
  }

  private clickCreate(drawing: Drawing, ctx: ToolContext) {
    const e = drawing.last;
    const size = this.clickSize();
    let node: SceneNode;
    if (this.spec.line) {
      const from = e.altKey ? {x: drawing.start.x - size.width / 2, y: drawing.start.y} : drawing.start;
      node = this.makeLine(drawing, from, {x: from.x + size.width, y: from.y});
    } else {
      const box = clickRect(drawing.start, size.width, size.height, this.clickFromCenter(e));
      if (ctx.store.getState().ui.snapToPixel) {
        box.x = Math.round(box.x);
        box.y = Math.round(box.y);
      }
      node = this.makeNode(drawing, this.localBox(drawing, box));
    }
    ctx.store.transact(this.label, tx => this.build(tx, drawing, node));
  }

  /** The pointer snapped to the layers around (Control held: not, as in Figma) and to whole pixels. */
  protected snap(page: Vec, e: Pick<ToolPointerEvent, 'ctrlKey'>, ctx: ToolContext, doc: DesignDocument, parentId: NodeId): {point: Vec; guides: OverlayItem[]} {
    const state = ctx.store.getState();
    let point = page;
    let guides: OverlayItem[] = [];
    if (!e.ctrlKey && ctx.snap.snapPoint) {
      const context: SmartSnapContext = {doc, pageId: state.pageId, zoom: ctx.view.viewport().zoom, exclude: NO_IDS, parentId};
      const snapped = ctx.snap.snapPoint(page, context);
      point = {x: snapped.x, y: snapped.y};
      guides = snapped.guides;
    }
    if (state.ui.snapToPixel) {
      // Whole pixels where nothing else pulled the point.
      point = {x: point.x === page.x ? Math.round(point.x) : point.x, y: point.y === page.y ? Math.round(point.y) : point.y};
    }
    return {point, guides};
  }

  private refresh(ctx: ToolContext) {
    const drawing = this.drawing;
    if (!drawing?.gesture) return;
    const held = ctx.modifiers();
    drawing.last = {...drawing.last, shiftKey: held.shift, altKey: held.alt, mod: held.mod};
    this.update(ctx, false);
  }

  /** Space held during a drag moves the shape; the canvas keeps Space to itself, so listen here. */
  private listenForSpace(): () => void {
    const target = globalThis as unknown as {addEventListener?: Window['addEventListener']; removeEventListener?: Window['removeEventListener']};
    if (!target.addEventListener || !target.removeEventListener) return () => {};
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !this.drawing) return;
      event.preventDefault();
      this.drawing.space = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space' && this.drawing) this.drawing.space = false;
    };
    target.addEventListener('keydown', down, true);
    target.addEventListener('keyup', up, true);
    return () => {
      target.removeEventListener?.('keydown', down, true);
      target.removeEventListener?.('keyup', up, true);
    };
  }

  /** Space held from a test or another input. */
  setSpace(held: boolean) {
    if (this.drawing) this.drawing.space = held;
  }

  private finish(ctx: ToolContext) {
    this.drawing?.release();
    this.drawing = null;
    ctx.setOverlayItems([]);
    ctx.snap.end?.();
    ctx.requestOverlay();
  }

  private cancel(ctx: ToolContext) {
    const drawing = this.drawing;
    if (!drawing) return;
    drawing.gesture?.cancel();
    this.finish(ctx);
  }
}
