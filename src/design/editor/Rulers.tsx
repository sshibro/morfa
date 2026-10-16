import {useContext, useEffect, useRef} from 'react';
import type {DesignDocument, Guide, NodeId} from '../../../shared/design/types';
import type {Rect} from '../../../shared/design/geometry';
import {isTypingTarget} from '../engine/keyboard';
import {measureRects, measureTarget} from '../engine/measure';
import {drawLabel, LABEL_FONT, strokeNodeOutline} from '../engine/overlay';
import {bindCanvasSize, guideOffset, guidePosition, RULER_SIZE, rulerTicks, setGuides, withGuide} from '../engine/rulers';
import {formatNumber, selectionBounds} from '../engine/selection';
import type {SpacingBand} from '../engine/spacing';
import {currentViewport, type DesignStore, type EditorState, type Gesture} from '../engine/store';
import {bindImageServices, imageServicesFor, isImageFile, placeFiles} from '../engine/tools/image';
import {screenToPage} from '../engine/viewport';
import {EditorServicesContext, type EditorServices} from './services';
import '../styles/drawing.css';

// What lies over the canvas besides the engine's own overlay (CanvasView.tsx), drawn on one canvas
// of its own so the engine's overlay and the scene are never repainted for it:
//   - the rulers (⇧R, `ui.rulers`): page coordinates along the top and left edges, the selection's
//     extent highlighted on them; dragging out of a ruler makes a guide, dragging a guide moves it,
//     dropping it back on a ruler removes it (rulers.ts, one undo step per drag); a click selects a
//     guide and Delete or Backspace removes it, as in Figma;
//   - the guides of the page across the canvas while the rulers are shown;
//   - measurements while ⌥ is held (measure.ts): from the selection to the hovered layer or to the
//     edges of its parent frame; in "Code" (`ui.devMode`, Figma's Dev Mode) to the hovered layer
//     without ⌥, and otherwise the padding and gaps of the hovered or selected auto-layout frame
//     (spacing.ts, loaded the first time the mode has the canvas);
//   - pictures and SVG files dropped on the canvas (tools/image.ts), and the upload and toast
//     services the image tool and paste use.
// Mount it once in the editor's `overlay` slot. Drawing runs on animation frames from store
// subscriptions and window keys, never through React renders.

export type RulersProps = {
  /** The editor's store; by default the open file's (EditorServices). */
  store?: DesignStore;
};

export function Rulers({store: own}: RulersProps) {
  const services = useContext(EditorServicesContext);
  const store = own ?? services?.store ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const guidesRef = useRef<HTMLDivElement>(null);
  const servicesRef = useRef(services);
  servicesRef.current = services;

  useEffect(() => {
    if (!store) return;
    const aids = new CanvasAids(rootRef.current!, paintRef.current!, topRef.current!, leftRef.current!, guidesRef.current!, store, () => servicesRef.current);
    return () => aids.dispose();
  }, [store]);

  useEffect(() => {
    if (!store || !services) return;
    return bindImageServices(store, {
      upload: (image, name) => services.uploadImage(image, name),
      toast: (message, kind) => services.toast(message, kind),
    });
  }, [store, services]);

  if (!store) return null;
  return (
    <div ref={rootRef} className="dz-canvas-aids">
      <canvas ref={paintRef} className="dz-canvas-aids__paint" aria-hidden="true" />
      <div ref={guidesRef} className="dz-guide-hits" />
      <div ref={topRef} className="dz-ruler is-top" aria-hidden="true" />
      <div ref={leftRef} className="dz-ruler is-left" aria-hidden="true" />
    </div>
  );
}

type Palette = {panel: string; border: string; text: string; accent: string; guide: string};
type GuideDrag = {pointerId: number; axis: Guide['axis']; index: number; base: readonly Guide[]; gesture: Gesture; offset: number; overRuler: boolean; element: HTMLElement; start: {x: number; y: number}; moved: boolean};
/** Screen px a press on a guide travels before it is a drag rather than a click (which selects it). */
const GUIDE_CLICK_SLOP = 3;

const TOOLS_WITH_GUIDES = new Set(['move', 'scale']);
const sameGuides = (a: readonly Guide[], b: readonly Guide[]) => a.length === b.length && a.every((guide, i) => guide.axis === b[i].axis && guide.offset === b[i].offset);
const GUIDE_REACH = 3;

/** Code's auto layout spacing (engine/spacing.ts), loaded the first time it could show; `then` redraws once it has. The
 *  import is a module-level thunk, as every lazy import of the editor (tests/design-lazy-imports.test.ts). */
const importSpacing = () => import('../engine/spacing');
let spacing: Awaited<ReturnType<typeof importSpacing>> | null = null;
let spacingLoad: Promise<void> | null = null;
function loadSpacing(then: () => void) {
  spacingLoad ??= importSpacing().then(module => {
    spacing = module;
  });
  spacingLoad.then(then, () => {
    // The chunk did not load (offline): a later redraw that wants it asks again.
    spacingLoad = null;
  });
}

class CanvasAids {
  private size = {width: 0, height: 0};
  private dpr = 1;
  private frame = 0;
  private alt = false;
  private hoverGuide: number | null = null;
  /** A guide clicked (as in Figma): Delete or Backspace removes it, Esc or a click elsewhere lets it go. */
  private selectedGuide: {pageId: NodeId; guide: Guide} | null = null;
  private drag: GuideDrag | null = null;
  private bounds: {doc: DesignDocument; selection: readonly NodeId[]; rect: Rect | null} | null = null;
  private strips: HTMLDivElement[] = [];
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly root: HTMLDivElement,
    private readonly paint: HTMLCanvasElement,
    private readonly top: HTMLDivElement,
    private readonly left: HTMLDivElement,
    private readonly guideLayer: HTMLDivElement,
    private readonly store: DesignStore,
    private readonly services: () => EditorServices | null,
  ) {
    this.cleanups.push(store.subscribe(() => this.request(), {slice: ['doc', 'page', 'viewport', 'selection', 'hover', 'live', 'ui', 'tool']}));
    // Selecting layers (Tab, ⌘A, the layers panel) lets a selected guide go.
    this.cleanups.push(store.subscribe(() => {
      if (store.getState().selection.length) this.selectGuide(null);
    }, {slice: 'selection'}));
    this.cleanups.push(bindCanvasSize(store, () => this.size));
    const observer = new ResizeObserver(() => this.measure());
    observer.observe(root);
    this.cleanups.push(() => observer.disconnect());
    // The rulers paint with the theme's tokens: a theme switch repaints them.
    const scope = root.closest('.dz');
    if (scope) {
      const themes = new MutationObserver(() => this.request());
      themes.observe(scope, {attributes: true, attributeFilter: ['data-theme']});
      this.cleanups.push(() => themes.disconnect());
    }
    this.listen();
    this.measure();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.drag?.gesture.cancel();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  // ── Events ─────────────────────────────────────────────────────────────────────────────────

  private on<K extends keyof WindowEventMap>(target: Window, type: K, handler: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions): void;
  private on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void;
  private on(target: Window | HTMLElement, type: string, handler: (event: never) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, handler as EventListener, options);
    this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
  }

  private listen() {
    const alt = (held: boolean) => {
      if (held === this.alt) return;
      this.alt = held;
      this.request();
    };
    this.on(window, 'keydown', event => {
      alt(event.altKey);
      this.guideKey(event);
    }, {capture: true});
    this.on(window, 'keyup', event => alt(event.altKey), {capture: true});
    this.on(window, 'pointermove', event => alt(event.altKey), {capture: true, passive: true});
    this.on(window, 'blur', () => alt(false));

    for (const [ruler, axis] of [[this.top, 'Y'], [this.left, 'X']] as const) {
      this.on(ruler, 'pointerdown', event => this.startNewGuide(event, axis, ruler));
      this.on(ruler, 'wheel', event => this.forwardWheel(event), {passive: false});
    }
    this.on(this.guideLayer, 'wheel', event => this.forwardWheel(event), {passive: false});

    const area = this.root.parentElement;
    if (area) {
      // A press anywhere else on the canvas lets a selected guide go (the strips stop their own presses).
      this.on(area, 'pointerdown', () => this.selectGuide(null), {capture: true});
      const hasFiles = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');
      this.on(area, 'dragover', event => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer!.dropEffect = 'copy';
      });
      this.on(area, 'drop', event => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        this.drop(event);
      });
    }
  }

  private forwardWheel(event: WheelEvent) {
    const canvas = this.root.parentElement?.querySelector('.dz-canvas__overlay');
    if (!canvas) return;
    event.preventDefault();
    canvas.dispatchEvent(new WheelEvent('wheel', event));
  }

  private drop(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const services = imageServicesFor(this.store);
    if (!services) return;
    const images = files.filter(isImageFile);
    if (!images.length) {
      if (files.length) services.toast('Only images can be dropped here: PNG, JPG, WebP, GIF, AVIF or SVG', 'error');
      return;
    }
    const rect = this.root.getBoundingClientRect();
    const state = this.store.getState();
    const at = screenToPage(currentViewport(state), {x: event.clientX - rect.left, y: event.clientY - rect.top});
    const renderer = this.services()?.renderer();
    void placeFiles(this.store, services, images, at, {index: () => (renderer ? renderer.indexFor(this.store.getState().doc, state.pageId) : null)});
  }

  // ── Guides ─────────────────────────────────────────────────────────────────────────────────

  private guides(): readonly Guide[] {
    const state = this.store.getState();
    return state.doc.nodes[state.pageId]?.guides ?? [];
  }

  private localPoint(event: PointerEvent) {
    const rect = this.root.getBoundingClientRect();
    return {x: event.clientX - rect.left, y: event.clientY - rect.top};
  }

  private startNewGuide(event: PointerEvent, axis: Guide['axis'], ruler: HTMLElement) {
    if (event.button !== 0 || this.drag) return;
    const base = this.guides();
    this.beginDrag(event, axis, base.length, base, ruler);
  }

  private beginDrag(event: PointerEvent, axis: Guide['axis'], index: number, base: readonly Guide[], element: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    element.setPointerCapture(event.pointerId);
    const existing = base[index];
    const drag: GuideDrag = {
      pointerId: event.pointerId, axis, index, base, gesture: this.store.gesture('Guide'), offset: existing?.offset ?? 0, overRuler: !existing, element,
      start: this.localPoint(event), moved: !existing,
    };
    this.drag = drag;
    this.root.dataset.dragging = axis;
    const move = (e: PointerEvent) => {
      if (e.pointerId === drag.pointerId) this.moveGuide(e);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return;
      this.moveGuide(e);
      finish(true);
      // A click on a guide (no drag) selects it, as in Figma: Delete then removes it.
      if (!drag.moved && existing) this.selectGuide(existing);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === drag.pointerId) finish(false);
    };
    const finish = (keep: boolean) => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', cancel);
      if (element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
      if (keep) drag.gesture.commit();
      else drag.gesture.cancel();
      this.drag = null;
      delete this.root.dataset.dragging;
      this.request();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', cancel);
    this.moveGuide(event);
  }

  private moveGuide(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    const state = this.store.getState();
    const viewport = currentViewport(state);
    const local = this.localPoint(event);
    const page = screenToPage(viewport, local);
    // A guide already placed moves only once the press travels (a click selects it and leaves it where it is), and
    // then by the pointer's travel, so it never jumps to where within its reach it was grabbed.
    const existing = drag.base[drag.index];
    if (existing && !drag.moved) {
      if (Math.hypot(local.x - drag.start.x, local.y - drag.start.y) < GUIDE_CLICK_SLOP) return;
      drag.moved = true;
    }
    const grabbed = existing ? existing.offset - (drag.axis === 'X' ? screenToPage(viewport, drag.start).x : screenToPage(viewport, drag.start).y) : 0;
    drag.offset = guidePosition((drag.axis === 'X' ? page.x : page.y) + grabbed, state.ui.snapToPixel);
    drag.overRuler = drag.axis === 'X' ? local.x < RULER_SIZE : local.y < RULER_SIZE;
    const next = withGuide(drag.base, drag.index, drag.overRuler ? null : {axis: drag.axis, offset: drag.offset});
    // Unchanged guides write nothing, so a guide dragged out and straight back leaves no undo step.
    drag.gesture.update(tx => (sameGuides(next, drag.base) ? undefined : setGuides(tx, state.pageId, next)));
    this.request();
  }

  /** Selects a guide (deselecting the layers, as in Figma) or lets the selected one go. */
  private selectGuide(guide: Guide | null) {
    if (!guide) {
      if (!this.selectedGuide) return;
      this.selectedGuide = null;
      this.request();
      return;
    }
    const state = this.store.getState();
    this.selectedGuide = {pageId: state.pageId, guide};
    if (state.selection.length) this.store.setSelection([]);
    this.request();
  }

  /** The selected guide's index among the page's guides now, or null (it went with an undo, a page change, rulers off). */
  private selectedIndex(): number | null {
    const selected = this.selectedGuide;
    const state = this.store.getState();
    if (!selected || selected.pageId !== state.pageId || !state.ui.rulers) return null;
    const index = this.guides().findIndex(guide => guide.axis === selected.guide.axis && guide.offset === selected.guide.offset);
    return index < 0 ? null : index;
  }

  /** Delete or Backspace removes the selected guide (one undo step), Esc lets it go; before the canvas sees the key. */
  private guideKey(event: KeyboardEvent) {
    if (!this.selectedGuide || event.defaultPrevented || isTypingTarget(event.target)) return;
    const index = this.selectedIndex();
    if (index === null) {
      this.selectedGuide = null;
      return;
    }
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (plain && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      event.stopPropagation();
      const pageId = this.store.getState().pageId;
      const next = withGuide(this.guides(), index, null);
      this.store.transact('Delete guide', tx => setGuides(tx, pageId, next));
      this.selectGuide(null);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.selectGuide(null);
    }
  }

  /** Hit strips over the guides, so a guide can be grabbed with "Move". */
  private placeStrips(guides: readonly Guide[], show: boolean) {
    const viewport = currentViewport(this.store.getState());
    const count = show ? guides.length : 0;
    while (this.strips.length < count) {
      const strip = document.createElement('div');
      const index = this.strips.length;
      strip.className = 'dz-guide-hit';
      strip.addEventListener('pointerdown', event => {
        if (event.button !== 0 || this.drag) return;
        const base = this.guides();
        const guide = base[index];
        if (guide) this.beginDrag(event, guide.axis, index, base, strip);
      });
      strip.addEventListener('pointerenter', () => {
        this.hoverGuide = index;
        this.request();
      });
      strip.addEventListener('pointerleave', () => {
        if (this.hoverGuide === index) this.hoverGuide = null;
        this.request();
      });
      this.guideLayer.appendChild(strip);
      this.strips.push(strip);
    }
    this.strips.forEach((strip, index) => {
      const guide = guides[index];
      if (index >= count || !guide || (this.drag && this.drag.index === index && this.drag.element !== strip)) {
        strip.hidden = true;
        return;
      }
      strip.hidden = false;
      const offset = Math.round(guideOffset(guide, viewport));
      strip.dataset.axis = guide.axis;
      strip.style.transform = guide.axis === 'X' ? `translateX(${offset - GUIDE_REACH}px)` : `translateY(${offset - GUIDE_REACH}px)`;
    });
  }

  // ── Drawing ────────────────────────────────────────────────────────────────────────────────

  private measure() {
    const rect = this.root.getBoundingClientRect();
    const width = Math.max(0, Math.round(rect.width)), height = Math.max(0, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (width === this.size.width && height === this.size.height && dpr === this.dpr) return;
    this.size = {width, height};
    this.dpr = dpr;
    this.paint.width = Math.round(width * dpr);
    this.paint.height = Math.round(height * dpr);
    this.paint.style.width = `${width}px`;
    this.paint.style.height = `${height}px`;
    this.draw();
  }

  private request() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private palette(): Palette {
    const style = getComputedStyle(this.root);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return {
      panel: read('--dz-panel', '#ffffff'),
      border: read('--dz-border', '#e6e6e6'),
      text: read('--dz-text-2', '#757575'),
      accent: read('--dz-accent', '#0d99ff'),
      guide: read('--dz-guide', '#f24822'),
    };
  }

  private selectionRect(doc: DesignDocument, selection: readonly NodeId[]): Rect | null {
    const cached = this.bounds;
    if (cached && cached.doc === doc && cached.selection === selection) return cached.rect;
    const rect = selectionBounds(doc, selection.filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE'));
    this.bounds = {doc, selection, rect};
    return rect;
  }

  private draw() {
    if (this.disposed || !this.size.width || !this.size.height) return;
    const ctx = this.paint.getContext('2d');
    if (!ctx) return;
    const state = this.store.getState();
    const rulers = state.ui.rulers;
    const flag = rulers ? 'true' : 'false';
    if (this.root.dataset.rulers !== flag) this.root.dataset.rulers = flag;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.paint.width, this.paint.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const guides = this.guides();
    const interactive = rulers && TOOLS_WITH_GUIDES.has(state.tool) && !state.live.size;
    this.placeStrips(guides, interactive || !!this.drag);
    const looking = TOOLS_WITH_GUIDES.has(state.tool) && !state.live.size && !state.editing;
    // "Code" measures to the hovered layer without ⌥, as Figma's Dev Mode does, and shows auto layout's spacing when it
    // measures nothing.
    const hovered = !!state.hoverId && !state.selection.includes(state.hoverId);
    const showMeasure = looking && state.selection.length > 0 && (this.alt || (state.ui.devMode && hovered));
    const bands = looking && state.ui.devMode && !showMeasure ? this.spacingBands(state) : null;
    if (!rulers && !showMeasure && !bands) return;
    const colors = this.palette();
    if (bands) spacing!.drawSpacing(ctx, bands, currentViewport(state), this.dpr);
    if (rulers) this.drawGuides(ctx, guides, colors);
    if (showMeasure) this.drawMeasurements(ctx, colors);
    if (rulers) this.drawRulers(ctx, colors);
  }

  /** The spacing "Code" shows: the hovered auto-layout frame's, else the selected one's. Null while there is none, or while
   *  spacing.ts loads (a frame is drawn once it has). */
  private spacingBands(state: EditorState): SpacingBand[] | null {
    if (!spacing) {
      loadSpacing(() => this.request());
      return null;
    }
    for (const id of [state.hoverId, state.selection.length === 1 ? state.selection[0] : null]) {
      const bands = id ? spacing.autoLayoutSpacing(state.doc, id) : [];
      if (bands.length) return bands;
    }
    return null;
  }

  private drawGuides(ctx: CanvasRenderingContext2D, guides: readonly Guide[], colors: Palette) {
    const viewport = currentViewport(this.store.getState());
    const {width, height} = this.size;
    const selected = this.drag ? null : this.selectedIndex();
    guides.forEach((guide, index) => {
      const offset = Math.round(guideOffset(guide, viewport)) + 0.5;
      // A selected guide takes the selection's colour, as layers do.
      const color = selected === index ? colors.accent : colors.guide;
      const active = this.hoverGuide === index || this.drag?.index === index || selected === index;
      ctx.beginPath();
      if (guide.axis === 'X') {
        if (offset < RULER_SIZE || offset > width) return;
        ctx.moveTo(offset, RULER_SIZE);
        ctx.lineTo(offset, height);
      } else {
        if (offset < RULER_SIZE || offset > height) return;
        ctx.moveTo(RULER_SIZE, offset);
        ctx.lineTo(width, offset);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (active) {
        const text = formatNumber(guide.offset);
        if (guide.axis === 'X') drawLabel(ctx, {x: offset, y: RULER_SIZE + 6}, text, {background: color});
        else drawLabel(ctx, {x: RULER_SIZE + 6 + this.labelWidth(ctx, text) / 2, y: offset}, text, {background: color, anchor: 'center'});
      }
    });
    // A guide being dragged out of a ruler and still over it: show where it would land.
    const drag = this.drag;
    if (drag?.overRuler) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = colors.guide;
      ctx.beginPath();
      const offset = Math.round(guideOffset({axis: drag.axis, offset: drag.offset}, viewport)) + 0.5;
      if (drag.axis === 'X') {
        ctx.moveTo(offset, 0);
        ctx.lineTo(offset, height);
      } else {
        ctx.moveTo(0, offset);
        ctx.lineTo(width, offset);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  private labelWidth(ctx: CanvasRenderingContext2D, text: string) {
    ctx.save();
    ctx.font = LABEL_FONT;
    const width = Math.ceil(ctx.measureText(text).width) + 8;
    ctx.restore();
    return width;
  }

  private drawMeasurements(ctx: CanvasRenderingContext2D, colors: Palette) {
    const state = this.store.getState();
    const target = measureTarget(state.doc, state.selection, state.hoverId);
    if (!target) return;
    const viewport = currentViewport(state);
    const sx = (x: number) => (x - viewport.x) * viewport.zoom, sy = (y: number) => (y - viewport.y) * viewport.zoom;
    const crisp = (v: number) => Math.round(v) + 0.5;
    ctx.save();
    ctx.strokeStyle = colors.guide;
    ctx.lineWidth = 1;
    // The layer measured to, outlined in red over its blue hover outline.
    strokeNodeOutline(ctx, state.doc, target.targetId, viewport, colors.guide, 1.5);
    ctx.strokeStyle = colors.guide;
    ctx.lineWidth = 1;
    const to = target.to;
    const items = measureRects(target.from, to);
    for (const m of items) {
      ctx.setLineDash([]);
      ctx.beginPath();
      const a = {x: sx(m.from.x), y: sy(m.from.y)}, b = {x: sx(m.to.x), y: sy(m.to.y)};
      if (m.axis === 'x') {
        const y = crisp(a.y);
        ctx.moveTo(a.x, y);
        ctx.lineTo(b.x, y);
      } else {
        const x = crisp(a.x);
        ctx.moveTo(x, a.y);
        ctx.lineTo(x, b.y);
      }
      ctx.stroke();
      ctx.setLineDash([3, 3]);
      for (const [from, end] of m.helpers) {
        ctx.beginPath();
        ctx.moveTo(crisp(sx(from.x)), crisp(sy(from.y)));
        ctx.lineTo(crisp(sx(end.x)), crisp(sy(end.y)));
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    for (const m of items) {
      const text = formatNumber(m.value);
      const centre = {x: (sx(m.from.x) + sx(m.to.x)) / 2, y: (sy(m.from.y) + sy(m.to.y)) / 2};
      // A line shorter than its label gets the label beside it, so the line stays visible.
      const width = this.labelWidth(ctx, text);
      const length = m.value * viewport.zoom;
      if (m.axis === 'x' && length < width + 8) centre.y += 16;
      if (m.axis === 'y' && length < 26) centre.x += width / 2 + 6;
      drawLabel(ctx, centre, text, {background: colors.guide, anchor: 'center'});
    }
    ctx.restore();
  }

  private drawRulers(ctx: CanvasRenderingContext2D, colors: Palette) {
    const state = this.store.getState();
    const viewport = currentViewport(state);
    const {width, height} = this.size;
    const selection = this.selectionRect(state.doc, state.selection);
    ctx.save();
    ctx.font = '500 10px "Inter Variable", Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // Grounds.
    ctx.fillStyle = colors.panel;
    ctx.fillRect(0, 0, width, RULER_SIZE);
    ctx.fillRect(0, 0, RULER_SIZE, height);

    // The selection's extent.
    const band = selection && {
      x0: (selection.x - viewport.x) * viewport.zoom, x1: (selection.x + selection.width - viewport.x) * viewport.zoom,
      y0: (selection.y - viewport.y) * viewport.zoom, y1: (selection.y + selection.height - viewport.y) * viewport.zoom,
    };
    if (band) {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = colors.accent;
      ctx.fillRect(Math.max(RULER_SIZE, band.x0), 0, Math.max(1, Math.min(width, band.x1) - Math.max(RULER_SIZE, band.x0)), RULER_SIZE);
      ctx.fillRect(0, Math.max(RULER_SIZE, band.y0), RULER_SIZE, Math.max(1, Math.min(height, band.y1) - Math.max(RULER_SIZE, band.y0)));
      ctx.restore();
    }

    // Where the selection's own values stand (and the band between them): tick values whose text
    // would touch them are left out, measured, so "−450" never runs into "−400".
    const SELECTION_FONT = '600 10px "Inter Variable", Inter, system-ui, sans-serif', TICK_FONT = ctx.font, GAP = 4;
    let busyX: [number, number] | null = null, busyY: [number, number] | null = null;
    if (band && selection) {
      ctx.font = SELECTION_FONT;
      const width = (value: number) => ctx.measureText(formatNumber(value)).width;
      busyX = [band.x0 - 3 - width(selection.x) - GAP, band.x1 + 3 + width(selection.x + selection.width) + GAP];
      busyY = [band.y0 - 3 - width(selection.y) - GAP, band.y1 + 3 + width(selection.y + selection.height) + GAP];
      ctx.font = TICK_FONT;
    }
    const clear = (busy: [number, number] | null, from: number, to: number) => !busy || to < busy[0] || from > busy[1];

    // Ticks along the top: a short mark with its value right of it.
    ctx.strokeStyle = colors.border;
    ctx.fillStyle = colors.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const tick of rulerTicks(viewport.x, viewport.zoom, width)) {
      const x = Math.round(tick.offset) + 0.5;
      if (x < RULER_SIZE) continue;
      ctx.moveTo(x, RULER_SIZE - 6);
      ctx.lineTo(x, RULER_SIZE);
      const text = formatNumber(tick.value);
      if (clear(busyX, x + 3, x + 3 + ctx.measureText(text).width)) {
        ctx.textAlign = 'left';
        ctx.fillText(text, x + 3, RULER_SIZE / 2 - 1);
      }
    }
    for (const tick of rulerTicks(viewport.y, viewport.zoom, height)) {
      const y = Math.round(tick.offset) + 0.5;
      if (y < RULER_SIZE) continue;
      ctx.moveTo(RULER_SIZE - 6, y);
      ctx.lineTo(RULER_SIZE, y);
      // Turned a quarter, the value reads upwards from just above its mark.
      const text = formatNumber(tick.value);
      if (clear(busyY, y - 3 - ctx.measureText(text).width, y - 3)) {
        ctx.save();
        ctx.translate(RULER_SIZE / 2 - 1, y - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'left';
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }
    ctx.stroke();

    // The selection's start and end values in the accent colour.
    if (band && selection) {
      ctx.fillStyle = colors.accent;
      ctx.font = SELECTION_FONT;
      const startX = formatNumber(selection.x), endX = formatNumber(selection.x + selection.width);
      if (band.x0 >= RULER_SIZE && band.x0 <= width) {
        ctx.textAlign = 'right';
        ctx.fillText(startX, Math.round(band.x0) - 3, RULER_SIZE / 2 - 1);
      }
      if (band.x1 >= RULER_SIZE && band.x1 <= width) {
        ctx.textAlign = 'left';
        ctx.fillText(endX, Math.round(band.x1) + 3, RULER_SIZE / 2 - 1);
      }
      const startY = formatNumber(selection.y), endY = formatNumber(selection.y + selection.height);
      for (const [value, at, before] of [[startY, band.y0, true], [endY, band.y1, false]] as const) {
        if (at < RULER_SIZE || at > height) continue;
        ctx.save();
        ctx.translate(RULER_SIZE / 2 - 1, Math.round(at) + (before ? -3 : 3));
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = before ? 'left' : 'right';
        ctx.fillText(value, 0, 0);
        ctx.restore();
      }
    }

    // Edges and the corner.
    ctx.fillStyle = colors.panel;
    ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);
    ctx.strokeStyle = colors.border;
    ctx.beginPath();
    ctx.moveTo(0, RULER_SIZE - 0.5);
    ctx.lineTo(width, RULER_SIZE - 0.5);
    ctx.moveTo(RULER_SIZE - 0.5, 0);
    ctx.lineTo(RULER_SIZE - 0.5, height);
    ctx.stroke();
    ctx.restore();
  }
}
