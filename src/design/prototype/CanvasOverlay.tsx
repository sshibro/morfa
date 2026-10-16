import '../styles/prototype.css';
import {useEffect, useRef} from 'react';
import type {DesignDocument, NodeId, SceneNode, Vec} from '../../../shared/design/types';
import {apply, rectsIntersect, worldBox, worldMatrix, type Rect} from '../../../shared/design/geometry';
import {pageIdOf} from '../../../shared/design/tree';
import {connectionsOf, defaultReaction, flowStartingPoints, isTopLevelFrame, topLevelFrames, type Connection} from '../../../shared/design/prototype';
import {currentViewport, type DesignStore, type DocumentChange} from '../engine/store';
import {pageRectToScreen, pageToScreen, screenToPage} from '../engine/viewport';
import {userUpdate} from '../engine/user-edit';
import {useEditorServices} from '../editor/services';
import {IconPlus} from '../ui/icons';
import {arrivalDirection, distanceToPolyline, flattenNoodle, noodleBetween, noodleBounds, type Noodle} from './noodle';
import {openPlayer} from './open-player';
import {prototypeUi, type InteractionRef, type PrototypeUi} from './state';

// The prototype's connections on the canvas, while the "Prototype" tab is open: blue curves with
// arrowheads from each layer with an interaction to the frame it goes to, blue flags over the frames
// that start a flow, and the "+" handle on the selected layer to drag a new connection onto a frame.
//
// It is its own canvas over the editor's (the EditorLayout `overlay` slot), drawn in screen px and
// transparent to the pointer except over a curve, a flag or the handle, so every tool keeps working.
// Connections are indexed per page and updated from the store's change feed (only the ids an edit
// touched), never by a walk of the document per pointer move or per frame.

export type PrototypeCanvasOverlayProps = {
  /** True while the "Prototype" tab is open; nothing is drawn or listened to otherwise. */
  active: boolean;
};

export function PrototypeCanvasOverlay({active}: PrototypeCanvasOverlayProps) {
  const services = useEditorServices();
  if (!active) return null;
  return <ConnectionsLayer store={services.store} fileId={services.fileId} />;
}

/** The connections layer itself; the "Prototype" tab mounts it into the canvas's host while it is open. */
export function ConnectionsLayer({store, fileId}: {store: DesignStore; fileId: string}) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const engine = new ConnectionsEngine(root.current!, canvas.current!, handle.current!, store, prototypeUi(store), fileId);
    return () => engine.dispose();
  }, [store, fileId]);
  return (
    <div ref={root} className="dz-proto-overlay">
      {/* The curves repeat what the "Prototype" tab lists, where the keyboard edits them. */}
      <canvas ref={canvas} className="dz-proto-overlay__canvas" aria-hidden="true" />
      <button ref={handle} type="button" className="dz-proto-handle" aria-label="Drag to a frame to add a navigation" title="Drag to a frame to add a navigation" hidden>
        <IconPlus size={12} />
      </button>
    </div>
  );
}

const ACCENT = '#0D99FF';
const ACCENT_SOFT = 'rgba(13, 153, 255, 0.35)';
const HIT_PX = 6;
const END_GRAB_PX = 12;
const FLAG_HEIGHT = 18;

type Drawn = {ref: InteractionRef; connection: Connection; noodle: Noodle; points: Vec[]};
type Flag = {nodeId: NodeId; rect: Rect};
type Drag =
  | {kind: 'new'; sourceId: NodeId; pointerId: number; from: Vec; at: Vec; target: NodeId | null}
  | {kind: 'retarget'; connection: Connection; pointerId: number; from: Vec; at: Vec; target: NodeId | null};

class ConnectionsEngine {
  private readonly area: HTMLElement;
  private size = {width: 0, height: 0};
  private dpr = 1;
  private frame = 0;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];
  /** Page id → (source id → its connections). */
  private index: {pageId: NodeId; doc: DesignDocument; bySource: Map<NodeId, Connection[]>} | null = null;
  private drawn: Drawn[] = [];
  private flags: Flag[] = [];
  private pointer: Vec | null = null;
  private drag: Drag | null = null;
  private handlePoint: Vec | null = null;

  constructor(
    private readonly root: HTMLDivElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly handle: HTMLButtonElement,
    private readonly store: DesignStore,
    private readonly ui: PrototypeUi,
    private readonly fileId: string,
  ) {
    this.area = root.parentElement ?? root;
    this.listen();
    this.measure();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.ui.set({hover: null});
  }

  // ── Listening ──

  private listen() {
    const {store} = this;
    this.cleanups.push(store.subscribe(() => this.schedule(), {slice: ['doc', 'page', 'viewport', 'selection', 'live']}));
    this.cleanups.push(store.onDocument(change => this.documentChanged(change)));
    this.cleanups.push(this.ui.subscribe(() => this.schedule()));
    const observer = new ResizeObserver(() => this.measure());
    observer.observe(this.root);
    this.cleanups.push(() => observer.disconnect());

    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      target.addEventListener(type, handler as EventListener, options);
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
    };
    on(this.area, 'pointermove', event => this.areaMove(event), {passive: true});
    on(this.area, 'pointerleave', () => {
      this.pointer = null;
      this.setHover(null, false);
      this.placeHandle();
    });
    on(this.canvas, 'pointerdown', event => this.canvasDown(event));
    on(this.canvas, 'wheel', event => this.forwardWheel(event), {passive: false});
    on(this.canvas, 'contextmenu', event => event.preventDefault());
    on(this.handle, 'pointerdown', event => this.handleDown(event));
    for (const target of [this.handle, this.canvas]) {
      on(target, 'pointermove', event => this.dragMove(event));
      on(target, 'pointerup', event => this.dragEnd(event, false));
      on(target, 'pointercancel', event => this.dragEnd(event, true));
    }
    on(window, 'keydown', event => {
      if (this.drag && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.cancelDrag();
      }
    }, {capture: true});
  }

  private measure() {
    const rect = this.root.getBoundingClientRect();
    const width = Math.round(rect.width), height = Math.round(rect.height), dpr = window.devicePixelRatio || 1;
    if (width === this.size.width && height === this.size.height && dpr === this.dpr) return;
    this.size = {width, height};
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.draw();
  }

  private schedule() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private local(event: {clientX: number; clientY: number}): Vec {
    const rect = this.root.getBoundingClientRect();
    return {x: event.clientX - rect.left, y: event.clientY - rect.top};
  }

  // ── The index of connections on the current page ──

  private connections(doc: DesignDocument, pageId: NodeId): Map<NodeId, Connection[]> {
    if (this.index && this.index.pageId === pageId) {
      this.index.doc = doc;
      return this.index.bySource;
    }
    const bySource = new Map<NodeId, Connection[]>();
    const stack = [...(doc.nodes[pageId]?.children ?? [])];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node) continue;
      if (node.reactions?.length) {
        const list = shownConnections(node);
        if (list.length) bySource.set(node.id, list);
      }
      if (node.children) stack.push(...node.children);
    }
    this.index = {pageId, doc, bySource};
    return bySource;
  }

  private documentChanged(change: DocumentChange) {
    const index = this.index;
    if (!index || change.source === 'gesture') return;
    if (change.source === 'replace' || change.pagesChanged) {
      this.index = null;
      return;
    }
    for (const id of change.changed) {
      const node = change.doc.nodes[id];
      const list = node && node.reactions?.length && pageIdOf(change.doc, id) === index.pageId ? shownConnections(node) : [];
      if (list.length) index.bySource.set(id, list);
      else index.bySource.delete(id);
    }
  }

  // ── Drawing ──

  private draw() {
    if (this.disposed || !this.size.width || !this.size.height) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const state = this.store.getState();
    const {doc, pageId} = state;
    const viewport = currentViewport(state);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const screen: Rect = {x: -64, y: -64, width: this.size.width + 128, height: this.size.height + 128};
    const {open, hover} = this.ui.get();
    const selected = new Set(state.selection);
    const focusOf = (sourceId: NodeId) => {
      if (!selected.size) return true;
      for (let node = doc.nodes[sourceId], guard = 0; node && guard < 256; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) {
        if (selected.has(node.id)) return true;
      }
      return false;
    };

    // Flags over the frames that start a flow.
    this.flags = [];
    ctx.font = '550 11px "Inter Variable", Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const flow of flowStartingPoints(doc, pageId)) {
      const box = pageRectToScreen(viewport, worldBox(doc, flow.nodeId));
      if (box.width < 24 || !rectsIntersect(box, screen)) continue;
      const text = fitText(ctx, flow.name, Math.min(box.width, 240) - 26);
      const width = Math.ceil(ctx.measureText(text).width) + 26;
      const rect = {x: Math.round(box.x), y: Math.round(box.y) - 22 - FLAG_HEIGHT, width, height: FLAG_HEIGHT};
      this.flags.push({nodeId: flow.nodeId, rect});
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, 4);
      ctx.fillStyle = ACCENT;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(rect.x + 7, rect.y + 5);
      ctx.lineTo(rect.x + 7, rect.y + 13);
      ctx.lineTo(rect.x + 13.5, rect.y + 9);
      ctx.closePath();
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.fillText(text, rect.x + 18, rect.y + FLAG_HEIGHT / 2 + 0.5);
    }

    // Connections, faint when they belong to layers outside the selection.
    this.drawn = [];
    const drag = this.drag;
    const bySource = this.connections(doc, pageId);
    const strong: Drawn[] = [];
    for (const [sourceId, list] of bySource) {
      if (!doc.nodes[sourceId]) continue;
      const sourceBox = pageRectToScreen(viewport, worldBox(doc, sourceId));
      for (const connection of list) {
        if (drag?.kind === 'retarget' && sameConnection(drag.connection, connection)) continue;
        const destination = doc.nodes[connection.destinationId];
        if (!destination || pageIdOf(doc, destination.id) !== pageId) continue;
        const noodle = noodleBetween(sourceBox, pageRectToScreen(viewport, worldBox(doc, destination.id)));
        if (!rectsIntersect(noodleBounds(noodle), screen)) continue;
        const ref = {nodeId: sourceId, reactionIndex: connection.reactionIndex};
        const item = {ref, connection, noodle, points: flattenNoodle(noodle)};
        this.drawn.push(item);
        const emphasis = sameRef(open, ref) || sameRef(hover, ref);
        if (emphasis || focusOf(sourceId)) strong.push(item);
        else drawNoodle(ctx, noodle, ACCENT_SOFT, 1.5);
      }
    }
    for (const item of strong) {
      const emphasis = sameRef(open, item.ref) || sameRef(hover, item.ref);
      drawNoodle(ctx, item.noodle, ACCENT, emphasis ? 3 : 2);
    }

    // A connection being dragged: to the frame under the pointer, or loose at the pointer.
    if (drag) {
      if (drag.target && doc.nodes[drag.target]) {
        const target = pageRectToScreen(viewport, worldBox(doc, drag.target));
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(target.x) + 0.5, Math.round(target.y) + 0.5, Math.round(target.width), Math.round(target.height));
      }
      const from = drag.kind === 'new' ? this.handlePoint ?? drag.from : drag.from;
      const sourceBox = {x: from.x - 1, y: from.y - 1, width: 2, height: 2};
      const noodle = drag.target && doc.nodes[drag.target]
        ? noodleBetween(drag.kind === 'retarget' ? pageRectToScreen(viewport, worldBox(doc, drag.connection.sourceId)) : sourceBox, pageRectToScreen(viewport, worldBox(doc, drag.target)))
        : looseNoodle(from, drag.at);
      drawNoodle(ctx, noodle, ACCENT, 2);
    }
    this.placeHandle();
  }

  // ── The "+" handle ──

  private placeHandle() {
    const state = this.store.getState();
    const id = state.selection.length === 1 ? state.selection[0] : null;
    const node = id ? state.doc.nodes[id] : undefined;
    let show = false;
    if (node && node.type !== 'PAGE' && !state.live.size && !state.editing) {
      const viewport = currentViewport(state);
      const m = worldMatrix(state.doc, node.id);
      const point = pageToScreen(viewport, apply(m, {x: node.width, y: node.height / 2}));
      this.handlePoint = point;
      const box = pageRectToScreen(viewport, worldBox(state.doc, node.id));
      const p = this.pointer;
      const near = !!p && p.x >= box.x - 20 && p.y >= box.y - 20 && p.x <= box.x + box.width + 24 && p.y <= box.y + box.height + 20;
      show = !!this.drag || near;
      // `translate`, not `transform`: the hover and press `scale` must not scale the position too.
      if (show) this.handle.style.translate = `${Math.round(point.x)}px ${Math.round(point.y)}px`;
    } else this.handlePoint = null;
    if (this.drag?.kind === 'retarget') show = false;
    if (this.handle.hidden === show) this.handle.hidden = !show;
  }

  // ── Pointer ──

  private hitAt(point: Vec): {kind: 'noodle'; item: Drawn; end: boolean} | {kind: 'flag'; flag: Flag} | null {
    for (const flag of this.flags) {
      const r = flag.rect;
      if (point.x >= r.x && point.y >= r.y && point.x <= r.x + r.width && point.y <= r.y + r.height) return {kind: 'flag', flag};
    }
    let best: Drawn | null = null, bestDistance = HIT_PX;
    for (const item of this.drawn) {
      const distance = distanceToPolyline(item.points, point);
      if (distance <= bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    if (!best) return null;
    return {kind: 'noodle', item: best, end: Math.hypot(point.x - best.noodle.end.x, point.y - best.noodle.end.y) <= END_GRAB_PX};
  }

  private areaMove(event: PointerEvent) {
    this.pointer = this.local(event);
    if (this.drag) return;
    // While a tool drags on the canvas the curves stay out of the way.
    const busy = event.buttons !== 0 && event.target !== this.canvas;
    const hit = busy ? null : this.hitAt(this.pointer);
    this.setHover(hit?.kind === 'noodle' ? hit.item.ref : null, !!hit);
    this.canvas.style.cursor = hit?.kind === 'noodle' && hit.end ? 'grab' : 'pointer';
    this.placeHandle();
  }

  private setHover(ref: InteractionRef | null, capture: boolean) {
    this.canvas.style.pointerEvents = capture ? 'auto' : 'none';
    this.ui.set({hover: ref});
  }

  private canvasDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const point = this.local(event);
    const hit = this.hitAt(point);
    if (!hit) {
      this.setHover(null, false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (hit.kind === 'flag') {
      this.store.setSelection([hit.flag.nodeId]);
      if (event.detail >= 2) openPlayer(this.fileId, hit.flag.nodeId);
      return;
    }
    this.store.setSelection([hit.item.ref.nodeId]);
    this.ui.set({open: hit.item.ref});
    if (hit.end) {
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = {kind: 'retarget', connection: hit.item.connection, pointerId: event.pointerId, from: hit.item.noodle.start, at: point, target: hit.item.connection.destinationId};
      this.schedule();
    }
  }

  private handleDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const state = this.store.getState();
    const sourceId = state.selection.length === 1 ? state.selection[0] : null;
    if (!sourceId || !this.handlePoint) return;
    event.preventDefault();
    event.stopPropagation();
    this.handle.setPointerCapture(event.pointerId);
    this.drag = {kind: 'new', sourceId, pointerId: event.pointerId, from: this.handlePoint, at: this.local(event), target: null};
    this.root.classList.add('is-dragging');
    this.schedule();
  }

  private dragMove(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const at = this.local(event);
    const state = this.store.getState();
    const page = screenToPage(currentViewport(state), at);
    this.drag = {...drag, at, target: frameAt(state.doc, state.pageId, page)};
    this.schedule();
  }

  private dragEnd(event: PointerEvent, cancelled: boolean) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    this.root.classList.remove('is-dragging');
    const target = cancelled ? null : drag.target;
    if (target && drag.kind === 'new') {
      const node = this.store.getState().doc.nodes[drag.sourceId];
      if (node) {
        const reactionIndex = node.reactions.length;
        this.store.transact('New navigation', tx => {
          const current = tx.get(drag.sourceId);
          if (current) userUpdate(tx, drag.sourceId, {reactions: [...current.reactions, defaultReaction(target)]});
        });
        this.ui.set({open: {nodeId: drag.sourceId, reactionIndex}});
      }
    } else if (target && drag.kind === 'retarget' && target !== drag.connection.destinationId) {
      const {sourceId, reactionIndex, actionIndex} = drag.connection;
      this.store.transact('Change navigation', tx => {
        const current = tx.get(sourceId);
        const reaction = current?.reactions[reactionIndex];
        const action = reaction?.actions[actionIndex];
        if (!current || !reaction || action?.type !== 'NODE') return;
        const actions = reaction.actions.map((each, i) => (i === actionIndex ? {...action, destinationId: target} : each));
        userUpdate(tx, sourceId, {reactions: current.reactions.map((each, i) => (i === reactionIndex ? {...reaction, actions} : each))});
      });
    }
    this.schedule();
  }

  private cancelDrag() {
    this.drag = null;
    this.root.classList.remove('is-dragging');
    this.schedule();
  }

  /** The curves take the pointer only while it is over one; the wheel still pans and zooms the canvas. */
  private forwardWheel(event: WheelEvent) {
    event.preventDefault();
    this.setHover(null, false);
    const target = this.area.querySelector('.dz-canvas__overlay');
    target?.dispatchEvent(new WheelEvent('wheel', event));
  }
}

/** The connections a layer shows. "Change to" belongs to the variant set it switches between: an
 *  instance (or a layer inside one) repeats its main's and would draw a curve per copy, so only the
 *  main shows it. */
function shownConnections(node: SceneNode): Connection[] {
  const list = connectionsOf(node);
  return node.type === 'INSTANCE' || node.mainId !== undefined ? list.filter(connection => connection.kind !== 'CHANGE_TO') : list;
}

/** The top-level frame under a page point, topmost first. */
function frameAt(doc: DesignDocument, pageId: NodeId, point: Vec): NodeId | null {
  for (const id of topLevelFrames(doc, pageId)) {
    const node = doc.nodes[id];
    if (!node || node.visible === false || !isTopLevelFrame(doc, id)) continue;
    const box = worldBox(doc, id);
    if (point.x >= box.x && point.y >= box.y && point.x <= box.x + box.width && point.y <= box.y + box.height) return id;
  }
  return null;
}

function looseNoodle(from: Vec, to: Vec): Noodle {
  const k = Math.max(30, Math.abs(to.x - from.x) * 0.5);
  const direction = to.x >= from.x ? 1 : -1;
  return {start: from, c1: {x: from.x + k * direction, y: from.y}, c2: {x: to.x - k * direction * 0.3, y: to.y}, end: to};
}

function drawNoodle(ctx: CanvasRenderingContext2D, noodle: Noodle, color: string, width: number) {
  const {start, c1, c2, end} = noodle;
  const direction = arrivalDirection(noodle);
  const head = 5 + width;
  // The line stops at the arrowhead's base so its round cap does not poke through the tip.
  const base = {x: end.x - direction.x * head * 0.8, y: end.y - direction.y * head * 0.8};
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, base.x, base.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();
  const normal = {x: -direction.y, y: direction.x};
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - direction.x * head + normal.x * head * 0.62, end.y - direction.y * head + normal.y * head * 0.62);
  ctx.lineTo(end.x - direction.x * head - normal.x * head * 0.62, end.y - direction.y * head - normal.y * head * 0.62);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(start.x, start.y, 2 + width / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, width * 0.75);
  ctx.stroke();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + '…';
}

const sameRef = (a: InteractionRef | null, b: InteractionRef | null) => !!a && !!b && a.nodeId === b.nodeId && a.reactionIndex === b.reactionIndex;
const sameConnection = (a: Connection, b: Connection) => a.sourceId === b.sourceId && a.reactionIndex === b.reactionIndex && a.actionIndex === b.actionIndex;
