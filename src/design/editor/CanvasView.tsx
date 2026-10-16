import '../styles/canvas.css';
import {useEffect, useRef, type CSSProperties} from 'react';
import type {DesignDocument, Matrix, NodeId, Paint, PathCommand, RGB, SceneNode, Vec} from '../../../shared/design/types';
import {IDENTITY, localMatrix, multiply, rectsIntersect, scaling, transformRect, worldBox, type Rect} from '../../../shared/design/geometry';
import {pageBackground} from '../../../shared/design/defaults';
import {nodeGeometry} from '../../../shared/design/shapes';
import {layoutText, type TextMeasurer} from '../../../shared/design/text-layout';
import {isComponentLike, isFrameLikeNode, paintChildren, type SpatialIndex} from '../../../shared/design/tree';
import {copySelection, cutSelection, pasteData, registerCoreCommands, type CommandContext} from '../engine/commands';
import {frameTitleAt, titleBoxes, titleFieldPlacement, titleGround, titleTextWidth} from '../engine/frame-titles';
import type {RenderOptions, SceneRenderer} from '../engine/contracts';
import {hitTolerancePx, pickAt} from '../engine/hit-test';
import {backingRatio} from '../engine/touch/backing';
import {TouchGestures} from '../engine/touch/gestures';
import {handedToDocument, handleKeyDown, isMacPlatform, isTypingTarget} from '../engine/keyboard';
import {drawOverlay, OVERLAY_COLORS, screenMatrix, type OverlayItem} from '../engine/overlay';
import {drawMarketplaceOverlay, onMarketplaceOverlayChange} from '../marketplace/overlay';
import {currentViewport, type DesignStore, type EditorState} from '../engine/store';
import {userUpdate} from '../engine/user-edit';
import {installVectorEditing} from '../engine/vector-edit/session';
import {PanDrag} from '../engine/tools/hand';
import {hiddenSectionChildren} from '../../../shared/design/board/model';
import {createTool, registerCoreTools, NO_SNAP, type EditKind, type SnapHook, type Tool, type ToolContext, type ToolKeyEvent, type ToolPointerEvent, type ViewHelpers} from '../engine/tools';
import {initialViewport, pageToScreen, screenToPage, visiblePageRect, wheelToViewport, zoomAround} from '../engine/viewport';
import {benchDrawn} from './bench-hook';

// The canvas of "Morfa": two stacked canvases (the scene and, above it, the overlay with
// selection and tool feedback), sized to the container at the device pixel ratio. Pointer events
// go to the active tool with pointer capture, the wheel and pinch move the viewport, keys reach the
// tool and then the command registry while the editor is active. Drawing happens on animation
// frames and only for what changed: a drag repaints the scene (the renderer redraws only the
// `live` nodes), a hover repaints only the overlay.
//
// Everything runs in `CanvasEngine`, outside React, so a drag never renders a component.

export type CanvasViewProps = {
  store: DesignStore;
  /** The scene renderer (render/). Read once per store; without one a plain fallback draws boxes and text. */
  createRenderer?: (canvas: HTMLCanvasElement) => SceneRenderer;
  /** The renderer's spatial index of a page, when it keeps one: hit tests and the marquee then skip the walk. */
  spatialIndex?: (doc: DesignDocument, pageId: NodeId) => SpatialIndex | null;
  /** Smart guides. */
  snap?: SnapHook;
  /** Opens the text or vector editor of a node; by default it only sets `editing` in the store. */
  onEnterEdit?: (id: NodeId, kind: EditKind) => void;
  /** Right click; the canvas has already selected what is under the pointer. */
  onContextMenu?: (event: {clientX: number; clientY: number; nodeId: NodeId | null}) => void;
  /** Keys and clipboard events reach the canvas only while active (false under a dialog). Default true. */
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Called with the controller once the canvas is mounted (menus run commands through it). */
  onReady?: (controller: CanvasController) => void;
  /** The canvas of a page without a colour of its own (the theme's default, `defaultPageBackground`). */
  background?: RGB;
  /** A board's dot grid on the canvas (render/dot-grid.ts). */
  dotGrid?: boolean;
  /** A board: what its hidden sections hold is not drawn (shared/design/board/model.ts `hiddenSectionChildren`). */
  hiddenSections?: boolean;
};

export type CanvasController = {
  readonly view: ViewHelpers;
  commandContext(): CommandContext;
  /** Redraw everything (after fonts or pictures arrive). */
  invalidate(): void;
};

const STATIC_STYLE: CSSProperties = {position: 'absolute', left: 0, top: 0, display: 'block'};

/** The selection as a set, one per selection list: a pan redraws the scene every frame, and a set of thousands of
 *  selected ids built afresh each time cost a millisecond a frame (and told the renderer the labels changed). */
const selectionSets = new WeakMap<readonly NodeId[], ReadonlySet<NodeId>>();
function selectionSet(selection: readonly NodeId[]): ReadonlySet<NodeId> {
  let set = selectionSets.get(selection);
  if (!set) selectionSets.set(selection, (set = new Set(selection)));
  return set;
}

export function CanvasView(props: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });
  const {store} = props;
  const engineRef = useRef<CanvasEngine | null>(null);
  useEffect(() => {
    registerCoreTools();
    registerCoreCommands();
    const engine = new CanvasEngine(containerRef.current!, sceneRef.current!, overlayRef.current!, store, () => propsRef.current);
    engineRef.current = engine;
    propsRef.current.onReady?.(engine.controller);
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, [store]);
  // A theme switch changes the default canvas colour: the scene repaints with it.
  const background = props.background ? `${props.background.r},${props.background.g},${props.background.b}` : '';
  useEffect(() => {
    engineRef.current?.controller.invalidate();
  }, [background]);
  return (
    <div
      ref={containerRef}
      className={['dz-canvas', props.className].filter(Boolean).join(' ')}
      style={{position: 'relative', overflow: 'hidden', width: '100%', height: '100%', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', ...props.style}}
    >
      <canvas ref={sceneRef} className="dz-canvas__scene" style={STATIC_STYLE} aria-hidden="true" />
      <canvas ref={overlayRef} className="dz-canvas__overlay" style={STATIC_STYLE} role="application" aria-label="Canvas" aria-roledescription="canvas" />
    </div>
  );
}

// ── The engine ───────────────────────────────────────────────────────────────────────────────────

type SafariGestureEvent = UIEvent & {scale: number; clientX: number; clientY: number};
/** The browser follows a finger's release with a click at the same spot; when that release opened the context menu, the
 *  click would land on the menu that is now under the finger. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener('click', swallow, true);
  };
  const timer = setTimeout(stop, TOUCH_ECHO_MS);
  window.addEventListener('click', swallow, true);
}

/** A touch screen (a phone, a tablet): its canvas backing store is capped (engine/touch/backing.ts). */
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
/** ms after a finger lifts during which the browser's own dblclick and contextmenu are echoes of the touch. */
const TOUCH_ECHO_MS = 800;

class CanvasEngine {
  readonly controller: CanvasController;
  private readonly renderer: SceneRenderer;
  private readonly tools = new Map<string, Tool>();
  private tool: Tool;
  private readonly ctx: ToolContext;
  private readonly view: ViewHelpers;
  private readonly mac = isMacPlatform();
  private size = {width: 0, height: 0};
  private dpr = 1;
  private frame = 0;
  private sceneDirty = true;
  private overlayDirty = true;
  private overlayItems: readonly OverlayItem[] = [];
  private toolCursor: string | null = null;
  private modifiers = {shift: false, alt: false, mod: false, ctrl: false};
  private space = false;
  private readonly pan = new PanDrag();
  private panPointer: number | null = null;
  private gestureZoom: {zoom: number} | null = null;
  /** Fingers (pointerType `touch`) go here; mouse and pen keep the path below (engine/touch/gestures.ts). */
  private readonly touch: TouchGestures<PointerEvent>;
  /** When the last finger lifted: the browser's own dblclick and contextmenu that follow a touch are not ours to act on. */
  private lastTouchAt = -Infinity;
  /** Two fingers are pinching: the scene is drawn coarser until they lift (engine/touch/backing.ts). */
  private pinching = false;
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly container: HTMLDivElement,
    private readonly scene: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
    private readonly store: DesignStore,
    private readonly props: () => CanvasViewProps,
  ) {
    const viewport = () => currentViewport(store.getState());
    const snapOf = () => this.props().snap ?? NO_SNAP;
    this.view = {
      viewport,
      size: () => this.size,
      screenToPage: point => screenToPage(viewport(), point),
      pageToScreen: point => pageToScreen(viewport(), point),
      setViewport: next => store.setViewport(next),
      pixel: () => 1 / viewport().zoom,
    };
    this.ctx = {
      store,
      measurer: store.measurer,
      view: this.view,
      get snap() {
        return snapOf();
      },
      index: () => this.index(),
      setCursor: cursor => {
        this.toolCursor = cursor;
        this.applyCursor();
      },
      requestOverlay: () => this.requestOverlay(),
      setOverlayItems: items => {
        this.overlayItems = items;
        this.requestOverlay();
      },
      enterEdit: (id, kind) => this.enterEdit(id, kind),
      editTitle: id => this.editTitle(id),
      setTool: id => store.setTool(id),
      modifiers: () => ({...this.modifiers}),
    };
    this.touch = this.createTouch();
    this.controller = {view: this.view, commandContext: () => this.commandContext(), invalidate: () => this.invalidate()};
    const create = props().createRenderer;
    this.renderer = create ? create(scene) : new FallbackRenderer(scene, store.measurer);
    this.tool = this.toolFor(store.getState().tool);
    this.tool.activate?.(this.ctx);
    this.listen();
    // Keeps `editing = {kind: 'vector'}` and the vector editor's tools in step (a double click opens it).
    this.cleanups.push(installVectorEditing(store));
    this.measure();
  }

  dispose() {
    this.closeTitle(false);
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.tool.deactivate?.(this.ctx);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.renderer.dispose();
  }

  private invalidate() {
    this.renderer.invalidate();
    this.sceneDirty = true;
    this.requestOverlay();
  }

  private index(): SpatialIndex | null {
    const state = this.store.getState();
    return this.props().spatialIndex?.(state.doc, state.pageId) ?? null;
  }

  private commandContext(): CommandContext {
    return {store: this.store, canvasSize: () => this.size, enterEdit: (id, kind) => this.enterEdit(id, kind), index: () => this.index()};
  }

  private enterEdit(id: NodeId, kind?: EditKind) {
    const node = this.store.getState().doc.nodes[id];
    if (!node) return;
    const resolved: EditKind = kind ?? (node.type === 'TEXT' ? 'text' : 'vector');
    const handler = this.props().onEnterEdit;
    if (handler) handler(id, resolved);
    else this.store.setEditing({kind: resolved, id});
  }

  private toolFor(id: string): Tool {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = createTool(id, this.store) ?? this.tools.get('move') ?? createTool('move', this.store)!;
      this.tools.set(tool.id, tool);
    }
    return tool;
  }

  // ── Renaming a frame on its title ──────────────────────────────────────────────────────────

  private titleField: {field: HTMLElement; input: HTMLInputElement; id: NodeId; off: () => void} | null = null;

  /** A field over the frame's title (or section chip), as in Figma: Enter or a click elsewhere keeps
   *  the name, Esc leaves it. One undo step, through the hand-edit door (userUpdate). The field stands
   *  exactly on the name it replaces (same x and baseline, 11 px Inter, the name's colour), and the
   *  scene leaves that name out while it is open. Its look follows the canvas under it, not the
   *  editor's theme: a light field on a light page, a dark one on a dark page. The visible field is a
   *  wrapper around a bare input, as every field of the design language (styles/base.css), so the
   *  app's own field styles never reach it. */
  private editTitle(id: NodeId) {
    this.closeTitle(true);
    // A read-only file (a team's viewer or developer) is looked at, not renamed.
    if (this.store.readOnly) return;
    const state = this.store.getState();
    const box = titleBoxes(state.doc, state.pageId, currentViewport(state)).find(each => each.id === id);
    const node = state.doc.nodes[id];
    if (!box || !node) return;
    this.store.setSelection([id]);
    const field = document.createElement('div');
    field.className = 'dz-canvas-title';
    field.dataset.tone = box.tone;
    field.dataset.ground = titleGround(node, pageBackground(state.doc.nodes[state.pageId], this.props().background));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = node.name;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Layer name');
    field.appendChild(input);
    const angle = Math.atan2(box.along.y, box.along.x);
    const place = titleFieldPlacement(box);
    field.style.padding = `0 ${place.padding}px`;
    field.style.height = field.style.lineHeight = `${place.height}px`;
    field.style.transform = `translate(${box.origin.x}px, ${box.origin.y}px) rotate(${angle}rad) translate(${place.x}px, ${place.y}px)`;
    const fit = () => {
      // The text, the padding on both sides and room for the caret.
      field.style.width = `${Math.ceil(titleTextWidth(input.value || ' ')) + 2 * place.padding + 2}px`;
    };
    fit();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const current = this.store.getState().doc.nodes[id];
      if (keep && current && name && name !== current.name) this.store.transact('Rename', tx => userUpdate(tx, id, {name}));
      this.closeTitle(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
      event.stopPropagation();
    };
    input.addEventListener('input', fit);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', () => finish(true));
    // The canvas moves under the field: the name is kept and the field goes, as when clicking away.
    const off = this.store.subscribe(() => finish(true), {slice: ['viewport', 'page']});
    this.titleField = {field, input, id, off};
    this.container.appendChild(field);
    // The scene drops the old name now that the field covers its place.
    this.requestScene();
    // The canvas container clips but can still scroll: focusing must not move it.
    input.focus({preventScroll: true});
    input.select();
  }

  private closeTitle(keep: boolean) {
    const field = this.titleField;
    if (!field) return;
    this.titleField = null;
    field.off();
    if (keep) field.input.blur();
    field.field.remove();
    this.container.scrollLeft = this.container.scrollTop = 0;
    // The name comes back (renamed or not).
    if (!this.disposed) this.requestScene();
  }

  private switchTool(id: string) {
    if (this.tool.id === id) return;
    this.tool.deactivate?.(this.ctx);
    this.overlayItems = [];
    this.toolCursor = null;
    this.tool = this.toolFor(id);
    this.tool.activate?.(this.ctx);
    this.applyCursor();
    this.requestOverlay();
  }

  // ── Listeners ──────────────────────────────────────────────────────────────────────────────

  private on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, handler as EventListener, options);
    this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
  }

  private onWindow<K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions) {
    window.addEventListener(type, handler as EventListener, options);
    this.cleanups.push(() => window.removeEventListener(type, handler as EventListener, options));
  }

  private listen() {
    const {store, overlay} = this;
    this.cleanups.push(store.subscribe(() => this.requestScene(), {slice: ['doc', 'page', 'viewport', 'ui', 'live', 'selection', 'editing']}));
    this.cleanups.push(store.subscribe(() => this.requestOverlay(), {slice: ['doc', 'page', 'viewport', 'selection', 'hover', 'context', 'editing', 'live', 'ui']}));
    this.cleanups.push(onMarketplaceOverlayChange(() => this.requestOverlay()));
    this.cleanups.push(store.subscribe(() => this.switchTool(store.getState().tool), {slice: 'tool'}));
    this.cleanups.push(store.subscribe(() => this.ensureViewport(), {slice: 'page'}));

    const observer = new ResizeObserver(() => this.measure());
    observer.observe(this.container);
    this.cleanups.push(() => observer.disconnect());
    this.watchPixelRatio();

    this.on(overlay, 'pointerdown', event => this.pointerDown(event));
    this.on(overlay, 'pointermove', event => this.pointerMove(event));
    this.on(overlay, 'pointerup', event => this.pointerUp(event));
    this.on(overlay, 'pointercancel', event => this.pointerCancel(event));
    this.on(overlay, 'lostpointercapture', event => this.pointerCancel(event));
    this.on(overlay, 'pointerleave', event => {
      if (!event.buttons) store.setHover(null);
    });
    this.on(overlay, 'dblclick', event => {
      if (!this.afterTouch(event)) this.tool.onDoubleClick?.(this.toolEvent(event), this.ctx);
    });
    this.on(overlay, 'contextmenu', event => {
      event.preventDefault();
      if (this.afterTouch(event)) return;
      const state = store.getState();
      this.props().onContextMenu?.({clientX: event.clientX, clientY: event.clientY, nodeId: state.selection.at(-1) ?? null});
    });
    this.on(overlay, 'wheel', event => this.wheel(event), {passive: false});
    // Safari reports trackpad pinch as gesture events rather than ctrl + wheel.
    this.on(overlay, 'gesturestart' as keyof HTMLElementEventMap, (event: Event) => {
      event.preventDefault();
      this.gestureZoom = {zoom: this.view.viewport().zoom};
    });
    this.on(overlay, 'gesturechange' as keyof HTMLElementEventMap, (event: Event) => {
      event.preventDefault();
      const gesture = event as SafariGestureEvent;
      // On a phone Safari reports a pinch both as touches and as gesture events: the touches zoom (engine/touch).
      if (!this.gestureZoom || this.touch.active) return;
      store.setViewport(zoomAround(this.view.viewport(), this.localPoint(gesture.clientX, gesture.clientY), this.gestureZoom.zoom * gesture.scale));
    });
    this.on(overlay, 'gestureend' as keyof HTMLElementEventMap, (event: Event) => {
      event.preventDefault();
      this.gestureZoom = null;
    });

    this.onWindow('keydown', event => this.keyDown(event));
    this.onWindow('keyup', event => this.keyUp(event));
    this.onWindow('blur', () => {
      this.modifiers = {shift: false, alt: false, mod: false, ctrl: false};
      this.space = false;
      this.applyCursor();
    });
    const clipboard = (handler: (event: ClipboardEvent) => void) => (event: ClipboardEvent) => {
      if (!this.active() || isTypingTarget(event.target) || (globalThis.getSelection?.()?.toString() ?? '')) return;
      handler(event);
    };
    const onCopy = clipboard(event => this.copy(event, false));
    const onCut = clipboard(event => this.copy(event, true));
    const onPaste = clipboard(event => this.paste(event));
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    this.cleanups.push(() => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    });
  }

  private watchPixelRatio() {
    let query: MediaQueryList | null = null;
    const listen = () => {
      query?.removeEventListener('change', changed);
      query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', changed);
    };
    const changed = () => {
      listen();
      this.measure();
    };
    listen();
    this.cleanups.push(() => query?.removeEventListener('change', changed));
  }

  private active() {
    return this.props().active !== false && !this.disposed;
  }

  // ── Size, viewport, frames ─────────────────────────────────────────────────────────────────

  private measure() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(0, Math.round(rect.width)), height = Math.max(0, Math.round(rect.height));
    const dpr = backingRatio(window.devicePixelRatio || 1, coarsePointer(), this.pinching);
    if (width === this.size.width && height === this.size.height && dpr === this.dpr) return;
    this.size = {width, height};
    this.dpr = dpr;
    for (const canvas of [this.scene, this.overlay]) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    this.ensureViewport();
    this.sceneDirty = true;
    this.overlayDirty = true;
    // Draw now rather than on the next frame, so a resized canvas never shows blank for a frame.
    this.draw();
  }

  /** A page seen for the first time opens fitted to its content, never magnified past 100 %. */
  private ensureViewport() {
    const state = this.store.getState();
    if (state.viewports[state.pageId] || !this.size.width || !this.size.height) return;
    this.store.setViewport(initialViewport(state.doc, state.pageId, this.size));
  }

  private requestScene() {
    this.sceneDirty = true;
    this.schedule();
  }

  private requestOverlay() {
    this.overlayDirty = true;
    this.schedule();
  }

  private schedule() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    if (this.disposed || !this.size.width || !this.size.height) return;
    const state = this.store.getState();
    const scene = this.sceneDirty;
    if (this.sceneDirty) {
      this.sceneDirty = false;
      this.renderer.render(this.renderOptions(state));
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      this.drawOverlayCanvas(state);
    }
    benchDrawn(scene);
  }

  private hidden(state: EditorState): ReadonlySet<NodeId> | undefined {
    const sections = this.props().hiddenSections ? hiddenSectionChildren(state.doc) : null;
    if (state.editing?.kind !== 'text') return sections ?? undefined;
    return sections ? new Set([...sections, state.editing.id]) : new Set([state.editing.id]);
  }

  private renderOptions(state: EditorState): RenderOptions & {live: ReadonlySet<NodeId>} {
    return {
      doc: state.doc,
      pageId: state.pageId,
      viewport: currentViewport(state),
      size: this.size,
      dpr: this.dpr,
      hidden: this.hidden(state),
      outlines: state.ui.outlines,
      layoutGrids: state.ui.layoutGrids,
      pixelPreview: state.ui.pixelPreview,
      background: this.props().background,
      dotGrid: this.props().dotGrid,
      labels: {selected: selectionSet(state.selection), editing: this.titleField?.id ?? null},
      live: state.live,
      lifted: state.live.size ? this.tool.lifted?.() ?? undefined : undefined,
    };
  }

  private drawOverlayCanvas(state: EditorState) {
    const ctx2d = this.overlay.getContext('2d');
    if (!ctx2d) return;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const hints = this.tool.overlayHints?.() ?? {};
    const moveTool = this.tool.id === 'move';
    // Marketplace cards' zones and sales numbers, under the selection (src/design/marketplace/overlay.ts).
    drawMarketplaceOverlay(ctx2d, {state, viewport: currentViewport(state), size: this.size});
    drawOverlay(ctx2d, {
      doc: state.doc,
      pageId: state.pageId,
      viewport: currentViewport(state),
      size: this.size,
      dpr: this.dpr,
      selection: state.selection,
      hoverId: hints.hover === false || this.space || this.pan.active ? null : state.hoverId,
      context: state.context,
      // "Code" (Dev Mode) offers no handles: nothing is resized or rotated there.
      handles: (hints.handles ?? moveTool) && !state.editing && !state.ui.devMode,
      sizeBadge: hints.sizeBadge !== false,
      pixelGrid: state.ui.pixelGrid,
      items: this.overlayItems,
      // The vector editor draws the edited path itself, with no selection box around it.
      hidden: state.editing?.kind === 'vector' ? new Set([state.editing.id]) : this.hidden(state),
    });
    this.tool.drawOverlay?.(ctx2d, this.view);
  }

  private applyCursor() {
    const cursor = this.pan.active ? 'grabbing' : this.space ? 'grab' : this.toolCursor ?? this.tool.cursor;
    if (this.overlay.style.cursor !== cursor) this.overlay.style.cursor = cursor;
  }

  // ── Pointer ────────────────────────────────────────────────────────────────────────────────

  private localPoint(clientX: number, clientY: number): Vec {
    const rect = this.overlay.getBoundingClientRect();
    return {x: clientX - rect.left, y: clientY - rect.top};
  }

  private toolEvent(event: PointerEvent | MouseEvent): ToolPointerEvent {
    const screen = this.localPoint(event.clientX, event.clientY);
    const pointer = event as PointerEvent;
    return {
      screen,
      page: this.view.screenToPage(screen),
      button: event.button,
      buttons: event.buttons,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      mod: this.mac ? event.metaKey : event.ctrlKey,
      pointerId: pointer.pointerId ?? 1,
      pointerType: pointer.pointerType ?? 'mouse',
      pressure: pointer.pressure ?? 0.5,
      detail: event.detail,
      timeStamp: event.timeStamp,
    };
  }

  private trackModifiers(event: {shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean}) {
    this.modifiers = {shift: event.shiftKey, alt: event.altKey, mod: this.mac ? event.metaKey : event.ctrlKey, ctrl: event.ctrlKey};
  }

  private pointerDown(event: PointerEvent) {
    this.trackModifiers(event);
    // A press on the canvas leaves any panel field (so shortcuts reach the canvas again) and drops a
    // text selection left on the page (so ⌘C copies layers, not that text).
    const focused = document.activeElement as HTMLElement | null;
    if (focused && focused !== document.body && isTypingTarget(focused)) focused.blur();
    globalThis.getSelection?.()?.removeAllRanges();
    if (event.pointerType === 'touch') {
      event.preventDefault();
      this.touch.down(this.touchPoint(event), event);
      return;
    }
    const e = this.toolEvent(event);
    const busy = this.tool.busy?.() ?? false;
    if (event.button === 1 || (event.button === 0 && this.space && !busy)) {
      event.preventDefault();
      this.overlay.setPointerCapture(event.pointerId);
      this.panPointer = event.pointerId;
      this.pan.begin(e, this.ctx);
      this.store.setHover(null);
      this.applyCursor();
      return;
    }
    if (event.button === 2) {
      this.selectUnderPointer(e);
      return;
    }
    if (event.button !== 0) return;
    this.overlay.setPointerCapture(event.pointerId);
    this.tool.onPointerDown?.(e, this.ctx);
    this.requestOverlay();
  }

  /** Right click selects what is under the pointer first, as the context menu acts on the selection (in "Code", as its click
   *  does, the deepest layer). */
  private selectUnderPointer(e: ToolPointerEvent) {
    const state = this.store.getState();
    const deep = e.mod || state.ui.devMode;
    const picked = frameTitleAt(state.doc, state.pageId, e.screen, currentViewport(state)) ?? pickAt(state.doc, state.pageId, e.page, {context: state.context, deep, tolerance: hitTolerancePx(e.pointerType) * this.view.pixel(), index: this.index()});
    if (picked && state.selection.includes(picked)) return;
    this.store.setSelection(picked ? [picked] : []);
  }

  private pointerMove(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      this.touch.move(this.touchPoint(event), event);
      return;
    }
    const e = this.toolEvent(event);
    if (this.panPointer === event.pointerId) {
      this.pan.move(e, this.ctx);
      return;
    }
    if (this.space && !event.buttons) return;
    this.tool.onPointerMove?.(e, this.ctx);
  }

  private pointerUp(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      this.lastTouchAt = event.timeStamp;
      this.touch.up(this.touchPoint(event), event);
      return;
    }
    if (this.overlay.hasPointerCapture(event.pointerId)) this.overlay.releasePointerCapture(event.pointerId);
    if (this.panPointer === event.pointerId) {
      this.pan.end();
      this.panPointer = null;
      this.applyCursor();
      return;
    }
    if (event.button !== 0) return;
    this.tool.onPointerUp?.(this.toolEvent(event), this.ctx);
    this.requestOverlay();
  }

  private pointerCancel(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      this.lastTouchAt = event.timeStamp;
      this.touch.cancel(this.touchPoint(event));
      return;
    }
    if (this.panPointer === event.pointerId) {
      this.pan.end();
      this.panPointer = null;
      this.applyCursor();
      return;
    }
    if (this.tool.busy?.()) this.tool.onPointerCancel?.(this.ctx);
  }

  private touchPoint(event: PointerEvent) {
    return {id: event.pointerId, at: this.localPoint(event.clientX, event.clientY), time: event.timeStamp};
  }

  /** The browser's dblclick or contextmenu from a finger, which the touch path already answered. */
  private afterTouch(event: MouseEvent) {
    return this.touch.active || event.timeStamp - this.lastTouchAt < TOUCH_ECHO_MS;
  }

  /** What fingers do to the canvas: the active tool's press, the viewport, the context menu, the double click. */
  private createTouch() {
    return new TouchGestures<PointerEvent>({
      claim: event => this.tool.touchClaim?.(this.toolEvent(event), this.ctx) ?? 'draw',
      toolDown: event => {
        this.tool.onPointerDown?.(this.toolEvent(event), this.ctx);
        this.requestOverlay();
      },
      toolMove: event => this.tool.onPointerMove?.(this.toolEvent(event), this.ctx),
      toolUp: event => {
        this.tool.onPointerUp?.({...this.toolEvent(event), button: 0, buttons: 0}, this.ctx);
        this.requestOverlay();
      },
      toolCancel: () => {
        // A tool that claims touches takes a cancel at any point of its press; the others only mid-drag, as on a desktop.
        if (this.tool.busy?.() || this.tool.touchClaim) this.tool.onPointerCancel?.(this.ctx);
        this.requestOverlay();
      },
      viewport: () => this.view.viewport(),
      setViewport: viewport => this.store.setViewport(viewport),
      contextMenu: event => {
        swallowNextClick();
        this.selectUnderPointer(this.toolEvent(event));
        this.props().onContextMenu?.({clientX: event.clientX, clientY: event.clientY, nodeId: this.store.getState().selection.at(-1) ?? null});
      },
      doubleTap: event => this.tool.onDoubleClick?.({...this.toolEvent(event), detail: 2}, this.ctx),
      pinching: on => {
        this.pinching = on;
        this.measure();
      },
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    });
  }

  private wheel(event: WheelEvent) {
    event.preventDefault();
    if (this.gestureZoom) return;
    const point = this.localPoint(event.clientX, event.clientY);
    this.store.setViewport(wheelToViewport(this.view.viewport(), event, point));
    // The page moved under a still pointer: what it hovers changed too.
    if (!event.buttons && !this.tool.busy?.()) {
      this.tool.onPointerMove?.({...this.toolEvent(event), buttons: 0}, this.ctx);
    }
  }

  // ── Keys and clipboard ─────────────────────────────────────────────────────────────────────

  private keyEvent(event: KeyboardEvent): ToolKeyEvent {
    return {
      type: event.type === 'keyup' ? 'keyup' : 'keydown',
      code: event.code,
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      mod: this.mac ? event.metaKey : event.ctrlKey,
      repeat: event.repeat,
    };
  }

  private keyDown(event: KeyboardEvent) {
    this.trackModifiers(event);
    if (!this.active() || (isTypingTarget(event.target) && !handedToDocument(event)) || event.isComposing) return;
    // ⌥Space is "Keyboard selection" on a Mac (⌃Space elsewhere, which the ⌃ test above already leaves to the commands).
    const keyboardSelection = this.mac && event.altKey && !this.tool.busy?.();
    if (event.code === 'Space' && !this.modifiers.mod && !keyboardSelection) {
      event.preventDefault();
      // Space pressed during a drag is the tool's (the move tool keeps layers out of frames, as in Figma).
      if (this.tool.busy?.()) this.tool.onKeyDown?.(this.keyEvent(event), this.ctx);
      if (!this.space && !this.tool.busy?.()) {
        this.space = true;
        this.store.setHover(null);
        this.applyCursor();
        this.requestOverlay();
      }
      return;
    }
    handleKeyDown(event, {
      mac: this.mac,
      before: e => this.tool.onKeyDown?.(this.keyEvent(e), this.ctx) === true,
      context: () => this.commandContext(),
    });
  }

  private keyUp(event: KeyboardEvent) {
    this.trackModifiers(event);
    if (event.code === 'Space' && this.space) {
      this.space = false;
      this.applyCursor();
      this.requestOverlay();
      // Space was the canvas's (panning): a focused panel button (a swatch focus came back to) is not
      // pressed by it on release either, which is when Firefox and Safari would press it.
      if (!isTypingTarget(event.target)) event.preventDefault();
    }
    if (!this.active() || isTypingTarget(event.target)) return;
    if (this.tool.onKeyUp?.(this.keyEvent(event), this.ctx)) event.preventDefault();
  }

  private copy(event: ClipboardEvent, cut: boolean) {
    const ctx = this.commandContext();
    const text = cut ? cutSelection(ctx) : copySelection(ctx);
    if (text === null) return;
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
  }

  private paste(event: ClipboardEvent) {
    const data = event.clipboardData;
    const files = data ? Array.from(data.files ?? []) : [];
    const created = pasteData(this.commandContext(), {text: data ? data.getData('text/plain') : null, html: data?.getData('text/html') || null, files}, this.modifiers.shift);
    if (created) event.preventDefault();
  }
}

// ── Fallback renderer ────────────────────────────────────────────────────────────────────────────

const css = (color: RGB, alpha = 1) => `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${alpha})`;
const PLACEHOLDER = '#D9D9D9';

function tracePath(path: Path2D, commands: readonly PathCommand[]) {
  for (const command of commands) {
    if (command.type === 'M') path.moveTo(command.x, command.y);
    else if (command.type === 'L') path.lineTo(command.x, command.y);
    else if (command.type === 'C') path.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
    else if (command.type === 'Q') path.quadraticCurveTo(command.x1, command.y1, command.x, command.y);
    else path.closePath();
  }
}

function paintStyle(ctx: CanvasRenderingContext2D, paint: Paint, node: SceneNode): string | CanvasGradient {
  if (paint.type === 'SOLID') return css(paint.color, paint.opacity);
  if (paint.type === 'IMAGE') return PLACEHOLDER;
  const stops = paint.gradientStops;
  if (paint.type === 'GRADIENT_LINEAR' && stops.length) {
    const [a, b] = paint.gradientHandlePositions;
    const gradient = ctx.createLinearGradient(a.x * node.width, a.y * node.height, b.x * node.width, b.y * node.height);
    for (const stop of stops) gradient.addColorStop(Math.min(1, Math.max(0, stop.position)), css(stop.color, stop.color.a * paint.opacity));
    return gradient;
  }
  return stops.length ? css(stops[0].color, stops[0].color.a * paint.opacity) : PLACEHOLDER;
}

/** Draws what the document holds plainly (fills, strokes, text, clipping, frame names) so the canvas
 *  works before the real renderer is plugged in. No effects, blend modes or masks. */
class FallbackRenderer implements SceneRenderer {
  private last: RenderOptions | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly measurer: TextMeasurer) {}

  render(options: RenderOptions) {
    const last = this.last;
    if (last && last.doc === options.doc && last.pageId === options.pageId && last.viewport === options.viewport && last.size.width === options.size.width && last.size.height === options.size.height && last.dpr === options.dpr && last.outlines === options.outlines && last.hidden === options.hidden && last.background === options.background && sameSet(last.labels?.selected, options.labels?.selected) && last.labels?.editing === options.labels?.editing) return;
    this.last = options;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const {doc, pageId, viewport, dpr} = options;
    const page = doc.nodes[pageId];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css(pageBackground(page, options.background));
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!page) return;
    const base = multiply(scaling(dpr, dpr), screenMatrix(viewport));
    const visible = visiblePageRect(viewport, options.size);
    for (const id of paintChildren(page)) this.drawNode(ctx, options, id, base, IDENTITY, visible);
    this.drawLabels(ctx, options);
  }

  invalidate() {
    this.last = null;
  }

  dispose() {
    this.last = null;
  }

  private drawNode(ctx: CanvasRenderingContext2D, options: RenderOptions, id: NodeId, parentDevice: Matrix, parentWorld: Matrix, visible: Rect) {
    const node = options.doc.nodes[id];
    if (!node || !node.visible || options.hidden?.has(id)) return;
    const world = multiply(parentWorld, localMatrix(node));
    const device = multiply(parentDevice, localMatrix(node));
    const leaf = !node.children;
    const clips = isFrameLikeNode(node) && node.clipsContent !== false;
    if ((leaf || clips) && !rectsIntersect(transformRect(world, {x: -node.strokeWeight, y: -node.strokeWeight, width: node.width + node.strokeWeight * 2, height: node.height + node.strokeWeight * 2}), visible)) return;
    ctx.save();
    ctx.globalAlpha *= node.opacity;
    ctx.setTransform(device[0][0], device[1][0], device[0][1], device[1][1], device[0][2], device[1][2]);
    const hairline = 1 / Math.max(1e-6, Math.hypot(device[0][0], device[1][0]));
    if (node.type === 'TEXT') {
      this.drawText(ctx, node, options.outlines ? hairline : 0);
    } else if (node.type !== 'GROUP' && node.type !== 'BOOLEAN_OPERATION') {
      const path = new Path2D();
      for (const vector of nodeGeometry(node)) tracePath(path, vector.commands);
      if (options.outlines) {
        ctx.lineWidth = hairline;
        ctx.strokeStyle = '#000000';
        ctx.stroke(path);
      } else {
        for (const paint of node.fills) {
          if (!paint.visible) continue;
          ctx.fillStyle = paintStyle(ctx, paint, node);
          ctx.fill(path);
        }
        const stroke = node.strokes.find(paint => paint.visible);
        if (stroke && node.strokeWeight > 0) {
          ctx.lineWidth = node.strokeWeight;
          ctx.strokeStyle = paintStyle(ctx, stroke, node);
          ctx.setLineDash(node.dashPattern);
          ctx.stroke(path);
          ctx.setLineDash([]);
        }
      }
      if (clips) ctx.clip(path);
    }
    if (node.type === 'BOOLEAN_OPERATION' && !options.outlines) {
      // Without boolean geometry the operands are drawn in the operation's paint.
      ctx.fillStyle = node.fills.find(paint => paint.visible) ? paintStyle(ctx, node.fills.find(paint => paint.visible)!, node) : PLACEHOLDER;
      for (const childId of node.children ?? []) {
        const child = options.doc.nodes[childId];
        if (!child?.visible) continue;
        const m = multiply(device, localMatrix(child));
        ctx.setTransform(m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]);
        const path = new Path2D();
        for (const vector of nodeGeometry(child)) tracePath(path, vector.commands);
        ctx.fill(path);
      }
    } else if (node.children) {
      for (const childId of paintChildren(node)) this.drawNode(ctx, options, childId, device, world, visible);
    }
    ctx.restore();
  }

  private drawText(ctx: CanvasRenderingContext2D, node: SceneNode, outline: number) {
    const layout = layoutText(node, this.measurer);
    const fill = node.fills.find(paint => paint.visible);
    ctx.fillStyle = fill ? paintStyle(ctx, fill, node) : '#000000';
    ctx.textBaseline = 'alphabetic';
    for (const line of layout.lines) {
      for (const run of line.runs) {
        const style = run.style;
        ctx.font = `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px "${style.fontFamily}", "Inter Variable", system-ui, sans-serif`;
        ctx.fillText(run.text, line.x + run.x, line.baseline);
      }
    }
    if (outline) {
      ctx.lineWidth = outline;
      ctx.strokeStyle = '#000000';
      ctx.strokeRect(0, 0, node.width, node.height);
    }
  }

  /** Names above frames, sections and components standing on the canvas. */
  private drawLabels(ctx: CanvasRenderingContext2D, options: RenderOptions) {
    const {doc, pageId, viewport, dpr} = options;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '500 11px "Inter Variable", Inter, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const id of doc.nodes[pageId]?.children ?? []) {
      const node = doc.nodes[id];
      if (!node?.visible || !(isFrameLikeNode(node) || node.type === 'SECTION') || node.type === 'INSTANCE' || id === options.labels?.editing) continue;
      const box = worldBox(doc, id);
      const at = pageToScreen(viewport, {x: box.x, y: box.y});
      const selected = options.labels?.selected.has(id);
      ctx.fillStyle = selected ? (isComponentLike(node) ? OVERLAY_COLORS.component : OVERLAY_COLORS.accent) : isComponentLike(node) ? OVERLAY_COLORS.component : '#757575';
      ctx.fillText(node.name, Math.round(at.x), Math.round(at.y - 4), Math.max(0, box.width * viewport.zoom));
    }
  }
}

function sameSet(a: ReadonlySet<NodeId> | undefined, b: ReadonlySet<NodeId> | undefined) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
