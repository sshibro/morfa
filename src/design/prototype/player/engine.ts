import type {DesignDocument, FlowStartingPoint, Hyperlink, NodeId, Reaction, SceneNode, Transition, Trigger, Vec} from '../../../../shared/design/types';
import {multiply, scaling, translation, type Rect} from '../../../../shared/design/geometry';
import {booleanGeometry} from '../../../../shared/design/boolean';
import {snapshotDocument} from '../../../../shared/design/table-cache';
import {swapInstance} from '../../../../shared/design/components';
import {normalizeDocument} from '../../../../shared/design/normalize';
import {
  closeOverlays, deviceScreen, evaluateEasing, sameOwnLook, flowFrames, flowOf, flowStartingPoints, goBack, hotspotsAt, hotspotsOf, isSafeUrl, isTopLevelFrame, lerp, navigateTo,
  overlayOrigin, pageOfNode, placedMatrix, playableActions, scrollToTargets, sessionStep, smartAnimatePlan, startSession, topLevelFrameOf,
  transitionDuration, withScroll, withVariant, DEFAULT_PROTOTYPE_BACKGROUND, type ActionSource, type Hotspot, type OverlayState, type ScrollOffsets,
  type SessionEffect, type SessionSnapshot, type SessionState, type Size, type SurfaceState,
} from '../../../../shared/design/prototype';
import type {DesignFontRegistry} from '../../engine/fonts';
import type {DesignImageCache} from '../../engine/images';
import {whenExportReady} from '../../engine/export-raster';
import {context2d, createCanvas, type AnyCanvas, type Ctx2D} from '../../engine/render/canvas';
import {matchesShortcut} from '../../ui/shortcuts';
import {SmartAnimation} from './smart';
import {Surface, type PaintDeps, type SurfaceReuse} from './surface';
import {bleedEdges, drawScreenTransition, overlayMotion} from './transitions';
import {swipeStep} from './phone/swipe';
import {linkAt, linkSpotsOf} from './text-links';

// The prototype player: the session (shared/design/prototype.ts) on a canvas. It turns pointer, wheel,
// touch and key events into reactions, runs them through the session, and animates what changed with
// bitmaps (surface.ts, transitions.ts, smart.ts). Nothing here renders React: the shell (Player.tsx)
// sizes the canvas and draws the chrome around it from `PlayerInfo`.

export type PlayerDeps = {
  fonts: DesignFontRegistry;
  images: DesignImageCache;
  /** A finger tapped where there is no hotspot (the phone's hidden bar shows: player/phone/usePhoneBar.ts). */
  onMissTap?: () => void;
};

export type PlayerInfo = {
  /** The screen's frame; null before a document arrives. */
  frameId: NodeId | null;
  frameName: string;
  flowName: string | null;
  /** The page's flows (for the player's list) and the one being played. */
  flows: readonly FlowStartingPoint[];
  flowStart: NodeId | null;
  /** Position in the flow's order for ←/→ (−1 outside it) and its length. */
  flowIndex: number;
  flowLength: number;
  /** The screen in CSS px at 100 %. */
  screen: Size;
  device: ReturnType<typeof deviceScreen>;
  /** Fonts and pictures of the first screen have arrived. */
  ready: boolean;
  /** The frame asked for is not in the file (deleted, or not a top-level frame). */
  missing: boolean;
  background: string;
};

type Shown = {state: SurfaceState; surface: Surface; origin: Vec; size: Size; frame: SceneNode};
type Anim = {start: number; duration: number; transition: Transition; draw: (ctx: Ctx2D, e: number) => void; finish: () => void};
type WhileEntry = {sourceId: NodeId; surface: SurfaceState; trigger: 'ON_HOVER' | 'ON_PRESS'; undo: () => void; overlay?: OverlayState};
type Press = {pointerId: number; start: Vec; at: Vec; moved: boolean; surface: number; hotspots: Hotspot[]; scroll: NodeId[]; dragFired: boolean; last: {x: number; y: number; time: number}; velocity: Vec; pointerType: string;
  /** The press already ran an interaction ("While pressing", "Mouse down"): its release shows no hotspot hints. */
  acted?: boolean};

const ZERO: Vec = {x: 0, y: 0};
const DRAG_PX = 6;
const FLASH_MS = 500;
const HOTSPOT_FILL = 'rgba(13, 153, 255, 0.18)';
const HOTSPOT_STROKE = 'rgba(13, 153, 255, 0.9)';
const now = () => performance.now();
const css = (color: {r: number; g: number; b: number}, alpha = 1) => `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${alpha})`;

export class PlayerEngine {
  private readonly paint: PaintDeps;
  private baseDoc: DesignDocument | null = null;
  private startId: NodeId | null = null;
  private flowStart: NodeId | null = null;
  private session: SessionState | null = null;
  private readonly docs = new Map<string, DesignDocument>();
  private screen: Shown | null = null;
  private overlays: Shown[] = [];
  private fit = 1;
  private dpr = 1;
  private anim: Anim | null = null;
  private frame = 0;
  private busy = false;
  /** What to draw while `busy` waits for a destination's assets. */
  private waiting: {screen: Shown | null; overlays: Shown[]} | null = null;
  private ready = false;
  private showHotspots = false;
  private flashStart = -Infinity;
  private press: Press | null = null;
  private momentum: {surface: number; id: NodeId; velocity: Vec; last: number} | null = null;
  private hovered: {surface: number; ids: Set<NodeId>} = {surface: -2, ids: new Set()};
  private whiles: WhileEntry[] = [];
  private readonly timers = new Map<SurfaceState, ReturnType<typeof setTimeout>[]>();
  private readonly cleanups: (() => void)[] = [];
  private readonly hotspotCache = new WeakMap<Surface, {scroll: ScrollOffsets; list: Hotspot[]}>();
  /** The linked texts of each surface, per scroll position, as the hotspots (text-links.ts). */
  private readonly linkCache = new WeakMap<Surface, {scroll: ScrollOffsets; list: Hotspot[]}>();
  private disposed = false;
  private infoKey = '';
  private dirtySurfaces = false;
  private generation = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly deps: PlayerDeps, private readonly onInfo: (info: PlayerInfo) => void) {
    this.paint = {fonts: deps.fonts, images: deps.images, booleanGeometry};
    this.listen();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.clearTimers();
    this.disposeShown();
  }

  // ── Inputs from the shell ──

  /** A new or updated document. The session keeps going where it can. */
  setDocument(doc: DesignDocument, startId?: NodeId) {
    const first = !this.baseDoc;
    // Another starting frame (a flow picked in the player, a link to another screen) starts over there.
    const moved = !!startId && !!this.startId && startId !== this.startId;
    if (moved) {
      this.finishAnimation();
      this.whiles = [];
      this.session = null;
    }
    // The player's own document: its sessions span awaits (fonts and pictures of each screen) and derive screens from it,
    // and the editor's table may be written in place meanwhile.
    this.baseDoc = snapshotDocument(doc);
    this.docs.clear();
    if (startId) this.startId = startId;
    const start = this.startId;
    if (!start || !isTopLevelFrame(doc, start)) {
      this.session = null;
      this.disposeShown();
      this.emit();
      return;
    }
    this.flowStart = flowOf(doc, start)?.nodeId ?? start;
    const session = this.session;
    const alive = (state: SurfaceState) => isTopLevelFrame(doc, state.frameId);
    if (!session || !alive(session.screen)) this.session = startSession(start);
    else if (session.overlays.some(overlay => !alive(overlay))) this.session = {...session, overlays: session.overlays.filter(alive)};
    this.rebuild();
    if (first) void this.waitForAssets();
    this.emit();
  }

  /** CSS px per screen px (the shell's fit or 100 %), and the device pixel ratio. */
  setDisplay(fit: number, dpr = window.devicePixelRatio || 1) {
    if (fit === this.fit && dpr === this.dpr) return;
    this.fit = fit;
    this.dpr = dpr;
    this.rebuild();
  }

  setShowHotspots(show: boolean) {
    this.showHotspots = show;
    this.request();
  }

  restart() {
    if (!this.startId || !this.baseDoc || this.busy) return;
    this.finishAnimation();
    this.whiles = [];
    this.session = startSession(this.startId);
    this.rebuild();
    this.emit();
  }

  /** ←/→: the previous or next frame of the flow. */
  step(direction: 1 | -1) {
    const session = this.session, doc = this.baseDoc;
    if (!session || !doc || !this.flowStart || this.busy) return;
    const order = flowFrames(doc, this.flowStart);
    const index = order.indexOf(session.screen.frameId);
    const next = order[index < 0 ? 0 : index + direction];
    if (!next || next === session.screen.frameId) return;
    this.finishAnimation();
    this.whiles = [];
    const step = navigateTo(session, next, {type: 'INSTANT'});
    this.apply(step.state, step.effect);
  }

  // ── Geometry ──

  private get doc(): DesignDocument | null {
    const session = this.session, base = this.baseDoc;
    if (!session || !base) return base;
    return this.workingDoc(base, session.variants);
  }

  /** The base document with the variants the session switched ("Change to"), cached per combination. */
  private workingDoc(base: DesignDocument, variants: Readonly<Record<NodeId, NodeId>>): DesignDocument {
    const entries = Object.entries(variants).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (!entries.length) return base;
    const key = JSON.stringify(entries);
    const cached = this.docs.get(key);
    if (cached) return cached;
    let doc = base;
    const dirty = new Set<NodeId>();
    for (const [instanceId, variantId] of entries) {
      try {
        const edit = swapInstance(doc, instanceId, variantId);
        doc = edit.doc;
        for (const id of edit.changed) dirty.add(id);
      } catch {
        // The instance or variant went away in an edit: show what remains.
      }
    }
    if (dirty.size) doc = normalizeDocument(doc, dirty, {measurer: this.deps.fonts.measurer});
    if (this.docs.size > 32) this.docs.delete(this.docs.keys().next().value!);
    this.docs.set(key, doc);
    return doc;
  }

  private deviceOf(doc: DesignDocument, frameId: NodeId) {
    const pageId = pageOfNode(doc, frameId);
    return deviceScreen(pageId ? doc.nodes[pageId]?.prototypeDevice : undefined);
  }

  /** CSS px per frame px for a screen frame: a device fits the frame's width, none shows it as is. */
  private unitFor(doc: DesignDocument, frame: SceneNode): number {
    const device = this.deviceOf(doc, frame.id);
    return device && frame.width > 0 ? device.width / frame.width : 1;
  }

  private screenCss(doc: DesignDocument, frame: SceneNode): Size {
    const device = this.deviceOf(doc, frame.id);
    return device ? {width: device.width, height: device.height} : {width: Math.max(1, frame.width), height: Math.max(1, frame.height)};
  }

  /** Device px per screen unit now. */
  private get k(): number {
    const doc = this.doc, session = this.session;
    const frame = doc && session ? doc.nodes[session.screen.frameId] : undefined;
    return frame && doc ? this.unitFor(doc, frame) * this.fit * this.dpr : this.fit * this.dpr;
  }

  // ── Surfaces ──

  private buildScreen(doc: DesignDocument, state: SurfaceState, hidden?: ReadonlySet<NodeId>, reuse?: SurfaceReuse): Shown | null {
    const frame = doc.nodes[state.frameId];
    if (!frame) return null;
    const unit = this.unitFor(doc, frame);
    const css = this.screenCss(doc, frame);
    const size = {width: css.width / unit, height: css.height / unit};
    const surface = new Surface(doc, frame.id, this.paint, {view: size, scale: unit * this.fit * this.dpr, hidden}, reuse);
    return {state: {...state, scroll: surface.clamp(state.scroll)}, surface, origin: ZERO, size, frame};
  }

  private buildOverlay(doc: DesignDocument, state: OverlayState, screen: Shown, hidden?: ReadonlySet<NodeId>, reuse?: SurfaceReuse): Shown | null {
    const frame = doc.nodes[state.frameId];
    if (!frame) return null;
    const size = {width: frame.width, height: frame.height};
    const origin = overlayOrigin(frame.overlayPositionType, size, screen.size, state.anchor);
    const surface = new Surface(doc, frame.id, this.paint, {view: size, scale: screen.surface.scale, hidden, effects: true}, reuse);
    return {state, surface, origin, size, frame};
  }

  private buildAll(doc: DesignDocument, snapshot: SessionSnapshot): {screen: Shown | null; overlays: Shown[]} {
    const screen = this.buildScreen(doc, snapshot.screen);
    const overlays: Shown[] = [];
    if (screen) for (const state of snapshot.overlays) {
      const shown = this.buildOverlay(doc, state, screen);
      if (shown) overlays.push(shown);
    }
    return {screen, overlays};
  }

  /** Throws away every bitmap and paints the session again (document, size or pictures changed). */
  private rebuild() {
    this.finishAnimation();
    this.disposeShown();
    const doc = this.doc, session = this.session;
    if (doc && session) {
      const built = this.buildAll(doc, session);
      this.screen = built.screen;
      this.overlays = built.overlays;
      if (built.screen && built.screen.state.scroll !== session.screen.scroll) this.session = withScroll(session, -1, built.screen.state.scroll);
    }
    this.resizeCanvas();
    this.syncTimers();
    this.request();
  }

  private disposeShown() {
    this.screen?.surface.dispose();
    for (const overlay of this.overlays) overlay.surface.dispose();
    this.screen = null;
    this.overlays = [];
  }

  private resizeCanvas() {
    const doc = this.doc, session = this.session;
    const frame = doc && session ? doc.nodes[session.screen.frameId] : undefined;
    const css = frame && doc ? this.screenCss(doc, frame) : {width: 1, height: 1};
    const width = Math.max(1, Math.round(css.width * this.fit * this.dpr)), height = Math.max(1, Math.round(css.height * this.fit * this.dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.canvas.style.width = css.width * this.fit + 'px';
    this.canvas.style.height = css.height * this.fit + 'px';
  }

  private async waitForAssets() {
    const doc = this.doc, session = this.session;
    if (!doc || !session) return;
    const generation = ++this.generation;
    await whenExportReady(doc, [session.screen.frameId], {fonts: this.deps.fonts, images: this.deps.images, timeoutMs: 8000});
    if (this.disposed || generation !== this.generation) return;
    this.ready = true;
    this.rebuild();
    this.emit();
    this.preload();
  }

  /** Starts loading the fonts and pictures of every frame the current screen can go to. */
  private preload() {
    const doc = this.doc, session = this.session;
    if (!doc || !session) return;
    const targets = new Set<NodeId>();
    const visit = (id: NodeId, depth: number) => {
      const node = doc.nodes[id];
      if (!node || depth > 256) return;
      for (const reaction of node.reactions ?? []) for (const action of reaction.actions) {
        if (action.type === 'NODE' && isTopLevelFrame(doc, action.destinationId)) targets.add(action.destinationId);
      }
      for (const child of node.children ?? []) visit(child, depth + 1);
    };
    visit(session.screen.frameId, 0);
    for (const overlay of session.overlays) visit(overlay.frameId, 0);
    if (targets.size) void whenExportReady(doc, [...targets], {fonts: this.deps.fonts, images: this.deps.images, timeoutMs: 20_000});
  }

  // ── Info for the shell ──

  private emit() {
    const doc = this.baseDoc, session = this.session;
    const frame = doc && session ? doc.nodes[session.screen.frameId] : undefined;
    const order = doc && this.flowStart ? flowFrames(doc, this.flowStart) : [];
    const flow = doc && this.flowStart ? (doc.nodes[pageOfNode(doc, this.flowStart) ?? '']?.flowStartingPoints ?? []).find(point => point.nodeId === this.flowStart) : undefined;
    const pageId = doc && this.startId ? pageOfNode(doc, this.startId) : null;
    const background = doc && pageId ? doc.nodes[pageId]?.prototypeBackground ?? DEFAULT_PROTOTYPE_BACKGROUND : DEFAULT_PROTOTYPE_BACKGROUND;
    const working = this.doc;
    const info: PlayerInfo = {
      frameId: frame?.id ?? null,
      frameName: frame?.name ?? '',
      flowName: flow?.name ?? null,
      flows: doc && pageId ? flowStartingPoints(doc, pageId) : [],
      flowStart: this.flowStart,
      flowIndex: frame ? order.indexOf(frame.id) : -1,
      flowLength: order.length,
      screen: frame && working ? this.screenCss(working, frame) : {width: 0, height: 0},
      device: frame && doc ? this.deviceOf(doc, frame.id) : null,
      ready: this.ready,
      missing: !!doc && !session,
      background: css(background),
    };
    const key = JSON.stringify(info);
    if (key === this.infoKey) return;
    this.infoKey = key;
    this.onInfo(info);
  }

  // ── Drawing ──

  private request() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(time => {
      this.frame = 0;
      this.tick(time);
    });
  }

  private tick(time: number) {
    if (this.dirtySurfaces) {
      this.dirtySurfaces = false;
      this.rebuild();
    }
    let again = false;
    if (this.momentum) again = this.stepMomentum(time) || again;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.backdrop();
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const anim = this.anim;
    if (anim) {
      const progress = anim.duration > 0 ? Math.min(1, (time - anim.start) / anim.duration) : 1;
      const e = anim.transition.type === 'INSTANT' ? 1 : evaluateEasing(anim.transition.easing, progress);
      anim.draw(ctx, e);
      if (progress >= 1) {
        this.anim = null;
        anim.finish();
        again = true;
      } else again = true;
    } else if (this.waiting) {
      // A transition waits for the destination's fonts and pictures: keep showing where we are.
      this.drawSession(ctx, this.waiting);
    } else {
      this.drawSession(ctx);
      if (this.ready && this.screen) this.screen.surface.warm(this.screen.state.scroll, 1);
    }
    const flash = Math.max(0, 1 - (time - this.flashStart) / FLASH_MS);
    if (!anim && (this.showHotspots || flash > 0)) {
      this.drawHotspots(ctx, this.showHotspots ? 1 : flash);
      if (flash > 0) again = true;
    }
    if (again) this.request();
  }

  private backdrop() {
    const doc = this.baseDoc, pageId = doc && this.startId ? pageOfNode(doc, this.startId) : null;
    return css((doc && pageId && doc.nodes[pageId]?.prototypeBackground) || DEFAULT_PROTOTYPE_BACKGROUND);
  }

  /** The screen and its overlays as they rest. `inject` draws extra content right after one surface. */
  private drawSession(ctx: Ctx2D, shown: {screen: Shown | null; overlays: Shown[]} = {screen: this.screen, overlays: this.overlays}, inject?: (surface: number, ctx: Ctx2D) => void, upTo = Infinity) {
    const k = shown.screen?.surface.scale ?? this.k;
    if (shown.screen) shown.screen.surface.draw(ctx, scaling(k, k), shown.screen.state.scroll);
    inject?.(-1, ctx);
    shown.overlays.forEach((overlay, i) => {
      if (i >= upTo) return;
      this.drawScrim(ctx, overlay, 1);
      overlay.surface.draw(ctx, multiply(scaling(k, k), translation(overlay.origin.x, overlay.origin.y)), overlay.state.scroll);
      inject?.(i, ctx);
    });
  }

  private drawScrim(ctx: Ctx2D, overlay: Shown, alpha: number) {
    const background = overlay.frame.overlayBackground;
    if (background?.type !== 'SOLID_COLOR' || alpha <= 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css(background.color, background.color.a * Math.min(1, alpha));
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  private composite(shown: {screen: Shown | null; overlays: Shown[]}, upTo = Infinity): AnyCanvas {
    const canvas = createCanvas(this.canvas.width, this.canvas.height);
    const ctx = context2d(canvas);
    ctx.fillStyle = this.backdrop();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.drawSession(ctx, shown, undefined, upTo);
    if (shown.screen) bleedEdges(ctx, canvas, shown.screen.size.width * shown.screen.surface.scale, shown.screen.size.height * shown.screen.surface.scale);
    return canvas;
  }

  private drawHotspots(ctx: Ctx2D, alpha: number) {
    const k = this.screen?.surface.scale ?? this.k;
    const top = this.overlays.length - 1;
    const surfaces = top >= 0 ? [this.overlays[top]] : this.screen ? [this.screen] : [];
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const shown of surfaces) {
      for (const hotspot of this.hotspotsOfShown(shown)) {
        if (hotspot.id === shown.frame.id) continue;
        const m = multiply(multiply(scaling(k, k), translation(shown.origin.x, shown.origin.y)), hotspot.matrix);
        ctx.save();
        ctx.setTransform(k, 0, 0, k, shown.origin.x * k, shown.origin.y * k);
        ctx.beginPath();
        ctx.rect(hotspot.clip.x, hotspot.clip.y, hotspot.clip.width, hotspot.clip.height);
        ctx.clip();
        ctx.setTransform(m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]);
        ctx.beginPath();
        ctx.rect(0, 0, hotspot.width, hotspot.height);
        ctx.fillStyle = HOTSPOT_FILL;
        ctx.fill();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.lineWidth = 1.5 * this.dpr;
        ctx.strokeStyle = HOTSPOT_STROKE;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // ── Running reactions ──

  /** Plays a reaction's actions from `source`. Returns false when nothing could play. */
  private run(reaction: Reaction, source: ActionSource, options: {while?: 'ON_HOVER' | 'ON_PRESS'} = {}): boolean {
    let session = this.session;
    const doc = this.doc;
    if (!session || !doc) return false;
    const actions = playableActions(doc, source.id, reaction);
    if (!actions.length) return false;
    const before = session;
    let animated: SessionEffect | null = null;
    for (const action of actions) {
      const step = sessionStep(this.workingDoc(this.baseDoc!, session.variants), session, source, action);
      if (step.effect.kind === 'url') {
        this.openUrl(step.effect.url, step.effect.newTab);
        continue;
      }
      if (step.effect.kind === 'none') continue;
      session = step.state;
      animated = step.effect;
    }
    if (!animated) return true;
    if (options.while) this.recordWhile(options.while, source, before, session, animated);
    this.apply(session, animated, before);
    return true;
  }

  private openUrl(url: string, newTab: boolean) {
    if (!isSafeUrl(url)) return;
    if (newTab) window.open(url, '_blank', 'noopener,noreferrer');
    else window.location.assign(url);
  }

  /** "While hovering" and "While pressing" last while the pointer stays: remember how to undo them. */
  private recordWhile(trigger: 'ON_HOVER' | 'ON_PRESS', source: ActionSource, before: SessionState, after: SessionState, effect: SessionEffect) {
    const surface = source.surface < 0 ? before.screen : before.overlays[source.surface];
    if (!surface) return;
    if (effect.kind === 'variant') {
      const previous = before.variants[effect.instanceId] ?? null;
      this.whiles.push({sourceId: source.id, surface, trigger, undo: () => {
        const session = this.session;
        if (!session || session.variants[effect.instanceId] !== effect.to) return;
        const doc = this.doc!;
        const next = withVariant(session, effect.instanceId, previous);
        this.apply(next, {kind: 'variant', instanceId: effect.instanceId, from: effect.to, to: previous ?? (doc.nodes[effect.instanceId]?.componentId ?? effect.to), transition: effect.transition}, session);
      }});
    } else if (effect.kind === 'present') {
      const opened = after.overlays.length > before.overlays.length ? after.overlays[after.overlays.length - 1] : undefined;
      this.whiles.push({sourceId: source.id, surface, trigger, overlay: opened, undo: () => {
        const session = this.session;
        if (!session) return;
        if (opened) {
          const index = session.overlays.indexOf(opened);
          if (index >= 0) {
            const step = closeOverlays(session, index);
            this.apply(step.state, step.effect);
          }
        } else if (session.screen === after.screen) {
          const step = goBack(session);
          this.apply(step.state, step.effect);
        }
      }});
    }
  }

  /** Moves to `next`, animating `effect`. */
  private apply(next: SessionState, effect: SessionEffect, previous: SessionState | null = this.session) {
    if (!previous || this.disposed) return;
    this.finishAnimation();
    const fromShown = {screen: this.screen, overlays: this.overlays};
    const fromDoc = this.doc!;
    this.session = next;
    const toDoc = this.doc!;
    if (effect.kind === 'scroll') return this.animateScroll(effect.surface, effect.destinationId, effect.transition);
    if (effect.kind === 'variant') return this.animateVariant(fromDoc, toDoc, effect, fromShown);
    if (effect.kind !== 'present') {
      this.rebuild();
      return;
    }
    // Overlays that stay keep their bitmaps; the rest are painted for the new state.
    const built = this.buildFor(toDoc, next, fromShown, fromDoc === toDoc);
    this.screen = built.screen;
    this.overlays = built.overlays;
    this.resizeCanvas();
    this.syncTimers();
    this.emit();
    const transition = effect.transition;
    const duration = transitionDuration(transition) * 1000;
    const disposeOld = () => {
      const kept = new Set([this.screen?.surface, ...this.overlays.map(overlay => overlay.surface)]);
      for (const shown of [fromShown.screen, ...fromShown.overlays]) if (shown && !kept.has(shown.surface)) shown.surface.dispose();
    };
    const target = next.screen.frameId;
    const finish = () => {
      disposeOld();
      this.preload();
      this.request();
    };
    if (!duration || transition.type === 'INSTANT') {
      finish();
      return;
    }
    // A screen not seen yet waits briefly for its fonts and pictures, so it does not arrive half drawn.
    this.busy = true;
    this.waiting = fromShown;
    void whenExportReady(toDoc, [target, ...next.overlays.map(overlay => overlay.frameId)], {fonts: this.deps.fonts, images: this.deps.images, timeoutMs: 1200}).then(() => {
      this.busy = false;
      this.waiting = null;
      if (this.disposed || this.session !== next) return finish();
      this.dirtySurfaces = false;
      this.startPresent(effect.from, previous, fromShown, fromDoc, toDoc, transition, duration, finish);
    });
  }

  /** Bitmaps for `next`, reusing those of surfaces that did not change. */
  private buildFor(doc: DesignDocument, next: SessionSnapshot, from: {screen: Shown | null; overlays: Shown[]}, sameDoc: boolean): {screen: Shown | null; overlays: Shown[]} {
    const reuse = (state: SurfaceState, shown: Shown | null | undefined) => sameDoc && shown && shown.state.frameId === state.frameId && shown.surface.doc === doc;
    let screen: Shown | null;
    if (reuse(next.screen, from.screen)) screen = {...from.screen!, state: next.screen};
    else screen = this.buildScreen(doc, next.screen);
    const overlays: Shown[] = [];
    if (screen) next.overlays.forEach(state => {
      const old = from.overlays.find(shown => shown.state === state);
      if (old && reuse(state, old) && old.surface.scale === screen!.surface.scale) overlays.push(old);
      else {
        const built = this.buildOverlay(doc, state, screen!);
        if (built) overlays.push(built);
      }
    });
    if (screen && screen.state.scroll !== next.screen.scroll && this.session === next) {
      this.session = withScroll(this.session, -1, screen.state.scroll);
      screen = {...screen, state: this.session.screen};
    }
    return {screen, overlays};
  }

  private startPresent(from: SessionSnapshot, previous: SessionState, fromShown: {screen: Shown | null; overlays: Shown[]}, fromDoc: DesignDocument, toDoc: DesignDocument, transition: Transition, duration: number, finish: () => void) {
    const toShown = {screen: this.screen, overlays: this.overlays};
    const screenChanged = from.screen.frameId !== this.session!.screen.frameId;
    const start = now();
    if (screenChanged || !toShown.screen || !fromShown.screen) {
      if (transition.type === 'SMART_ANIMATE' && fromShown.screen && toShown.screen) {
        const smart = new SmartAnimation(
          {doc: fromDoc, rootId: from.screen.frameId, scroll: fromShown.screen.state.scroll, place: [[1, 0, 0], [0, 1, 0]]},
          {doc: toDoc, rootId: toShown.screen.frame.id, scroll: toShown.screen.state.scroll, place: [[1, 0, 0], [0, 1, 0]]},
          smartAnimatePlan(fromDoc, from.screen.frameId, toDoc, toShown.screen.frame.id), toShown.screen.surface.scale, this.paint,
        );
        smart.prepare();
        const overlaysOnly = fromShown.overlays.length ? this.overlaysBitmap(fromShown) : null;
        const k = toShown.screen.surface.scale;
        const view = toShown.screen.size;
        this.anim = {start, duration, transition, finish, draw: (ctx, e) => {
          ctx.save();
          ctx.setTransform(k, 0, 0, k, 0, 0);
          ctx.beginPath();
          ctx.rect(0, 0, view.width, view.height);
          ctx.clip();
          smart.draw(ctx, scaling(k, k), e);
          ctx.restore();
          if (overlaysOnly) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = Math.max(0, 1 - Math.min(1, e));
            ctx.drawImage(overlaysOnly, 0, 0);
            ctx.globalAlpha = 1;
          }
        }};
      } else {
        const before = this.composite(fromShown), after = this.composite(toShown);
        this.anim = {start, duration, transition, finish, draw: (ctx, e) => drawScreenTransition(ctx, before, after, transition, e)};
      }
      this.request();
      return;
    }
    // The same screen: overlays opened, closed or swapped above the first one that differs.
    let index = 0;
    while (index < fromShown.overlays.length && index < toShown.overlays.length && fromShown.overlays[index] === toShown.overlays[index]) index++;
    const leaving = fromShown.overlays.slice(index), entering = toShown.overlays.slice(index);
    const below = this.composite(toShown, index);
    const k = toShown.screen.surface.scale;
    const screen = toShown.screen.size;
    const swapSmart = transition.type === 'SMART_ANIMATE' && leaving.length === 1 && entering.length === 1;
    let smart: SmartAnimation | null = null;
    if (swapSmart) {
      const a = leaving[0], b = entering[0];
      smart = new SmartAnimation(
        {doc: fromDoc, rootId: a.frame.id, scroll: a.state.scroll, place: translation(a.origin.x, a.origin.y)},
        {doc: toDoc, rootId: b.frame.id, scroll: b.state.scroll, place: translation(b.origin.x, b.origin.y)},
        smartAnimatePlan(fromDoc, a.frame.id, toDoc, b.frame.id), k, this.paint,
      );
      smart.prepare();
    }
    const bitmaps = new Map<Shown, AnyCanvas>();
    for (const shown of [...leaving, ...entering]) bitmaps.set(shown, this.overlayBitmap(shown, k));
    this.anim = {start, duration, transition, finish, draw: (ctx, e) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(below, 0, 0);
      if (smart) {
        const a = leaving[0], b = entering[0];
        const fade = Math.min(1, Math.max(0, e));
        this.drawScrim(ctx, a, 1 - fade);
        this.drawScrim(ctx, b, fade);
        smart.draw(ctx, scaling(k, k), e);
        return;
      }
      for (const shown of leaving) this.drawMovingOverlay(ctx, shown, bitmaps.get(shown)!, transition, e, false, k, screen, entering.length > 0);
      for (const shown of entering) this.drawMovingOverlay(ctx, shown, bitmaps.get(shown)!, transition, e, true, k, screen, false);
    }};
    this.request();
  }

  private overlaysBitmap(shown: {screen: Shown | null; overlays: Shown[]}): AnyCanvas {
    const canvas = createCanvas(this.canvas.width, this.canvas.height);
    const ctx = context2d(canvas);
    const k = shown.screen?.surface.scale ?? this.k;
    for (const overlay of shown.overlays) {
      this.drawScrim(ctx, overlay, 1);
      overlay.surface.draw(ctx, multiply(scaling(k, k), translation(overlay.origin.x, overlay.origin.y)), overlay.state.scroll);
    }
    return canvas;
  }

  /** An overlay's picture with its shadows (a margin around its box). */
  private overlayBitmap(shown: Shown, k: number): AnyCanvas {
    const margin = 64;
    const canvas = createCanvas(Math.ceil((shown.size.width + 2 * margin) * k), Math.ceil((shown.size.height + 2 * margin) * k));
    const ctx = context2d(canvas);
    shown.surface.draw(ctx, multiply(scaling(k, k), translation(margin, margin)), shown.state.scroll);
    return canvas;
  }

  private drawMovingOverlay(ctx: Ctx2D, shown: Shown, bitmap: AnyCanvas, transition: Transition, e: number, entering: boolean, k: number, screen: Size, replaced: boolean) {
    const rect = {x: shown.origin.x, y: shown.origin.y, width: shown.size.width, height: shown.size.height};
    // Swapped out under a moving replacement, the old overlay just stays until it is covered.
    const motion = replaced && 'direction' in transition ? {offset: ZERO, alpha: 1} : overlayMotion(transition, e, rect, screen, entering);
    const fade = Math.min(1, Math.max(0, e));
    this.drawScrim(ctx, shown, replaced ? 1 - fade : entering ? fade : 1 - fade);
    if (motion.alpha <= 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.min(1, motion.alpha);
    ctx.drawImage(bitmap, Math.round((rect.x + motion.offset.x - 64) * k), Math.round((rect.y + motion.offset.y - 64) * k));
    ctx.restore();
  }

  private animateScroll(surfaceIndex: number, destinationId: NodeId, transition: Transition) {
    const session = this.session!;
    const shown = surfaceIndex < 0 ? this.screen : this.overlays[surfaceIndex];
    if (!shown) return;
    const doc = shown.surface.doc;
    const current = shown.state.scroll;
    const target = shown.surface.clamp(scrollToTargets(doc, shown.frame.id, destinationId, shown.size, current));
    const finalState = withScroll(session, surfaceIndex, target);
    const duration = transitionDuration(transition) * 1000;
    const setScroll = (scroll: ScrollOffsets) => {
      const state = surfaceIndex < 0 ? this.session!.screen : this.session!.overlays[surfaceIndex];
      if (!state) return;
      const next: SurfaceState = {...state, scroll};
      if (surfaceIndex < 0 && this.screen) this.screen = {...this.screen, state: next};
      else if (this.overlays[surfaceIndex]) this.overlays[surfaceIndex] = {...this.overlays[surfaceIndex], state: next as OverlayState};
    };
    if (!duration) {
      this.session = finalState;
      setScroll(target);
      this.request();
      return;
    }
    const keys = new Set([...Object.keys(current), ...Object.keys(target)]);
    this.anim = {start: now(), duration, transition, finish: () => {
      this.session = finalState;
      setScroll(target);
      this.syncShownStates();
    }, draw: (ctx, e) => {
      const scroll: Record<NodeId, Vec> = {};
      for (const key of keys) {
        const from = current[key] ?? ZERO, to = target[key] ?? ZERO;
        scroll[key] = {x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e)};
      }
      setScroll(shown.surface.clamp(scroll));
      this.drawSession(ctx);
    }};
    this.request();
  }

  /** "Change to": only the instance animates, over its frame drawn without it. When nothing outside the
   *  instance moved, the frame keeps every tile except those under the instance (hover states stay smooth). */
  private animateVariant(fromDoc: DesignDocument, toDoc: DesignDocument, effect: Extract<SessionEffect, {kind: 'variant'}>, fromShown: {screen: Shown | null; overlays: Shown[]}) {
    const session = this.session!;
    const instanceId = effect.instanceId;
    const host = topLevelFrameOf(toDoc, instanceId);
    const index = host === session.screen.frameId ? -1 : session.overlays.findIndex(overlay => overlay.frameId === host);
    const shownHost = index < 0 ? fromShown.screen : fromShown.overlays[index];
    this.screen = fromShown.screen;
    this.overlays = fromShown.overlays;
    if (!shownHost || !fromShown.screen) {
      this.rebuild();
      return;
    }
    const local = onlyInside(fromDoc, toDoc, shownHost.frame.id, instanceId);
    const build = (hidden: ReadonlySet<NodeId> | undefined, from: Surface) => {
      const reuse = local ? {from, changed: [instanceId]} : undefined;
      return index < 0 ? this.buildScreen(toDoc, this.session!.screen, hidden, reuse) : this.buildOverlay(toDoc, this.session!.overlays[index], this.screen!, hidden, reuse);
    };
    const place = (shown: Shown) => {
      if (index < 0) this.screen = shown;
      else this.overlays = this.overlays.map((overlay, i) => (i === index ? shown : overlay));
      this.syncShownStates();
      this.request();
    };
    const duration = transitionDuration(effect.transition) * 1000;
    if (!duration) {
      const next = build(undefined, shownHost.surface);
      shownHost.surface.dispose();
      if (next) place(next);
      else this.rebuild();
      return;
    }
    const temp = build(new Set([instanceId]), shownHost.surface);
    shownHost.surface.dispose();
    if (!temp) return this.rebuild();
    const scroll = temp.state.scroll;
    const placeA = placedMatrix(fromDoc, shownHost.frame.id, instanceId, scroll), placeB = placedMatrix(toDoc, shownHost.frame.id, instanceId, scroll);
    if (!placeA || !placeB) {
      temp.surface.dispose();
      return this.rebuild();
    }
    const plan = effect.transition.type === 'SMART_ANIMATE' ? smartAnimatePlan(fromDoc, instanceId, toDoc, instanceId) : {a: instanceId, b: instanceId, mode: 'crossfade' as const, children: []};
    const k = temp.surface.scale;
    const smart = new SmartAnimation({doc: fromDoc, rootId: instanceId, scroll, place: placeA}, {doc: toDoc, rootId: instanceId, scroll, place: placeB}, plan, k, this.paint);
    smart.prepare();
    const clip = temp.surface.clipOf(instanceId, scroll);
    place(temp);
    this.anim = {start: now(), duration, transition: effect.transition, finish: () => {
      const current = index < 0 ? this.screen : this.overlays[index];
      const next = current ? build(undefined, current.surface) : null;
      current?.surface.dispose();
      if (next) place(next);
      else this.rebuild();
    }, draw: (ctx, e) => this.drawSession(ctx, undefined, (surface, c) => {
      if (surface !== index) return;
      const origin = index < 0 ? ZERO : temp.origin;
      const base = multiply(scaling(k, k), translation(origin.x, origin.y));
      c.save();
      if (clip) {
        c.setTransform(base[0][0], base[1][0], base[0][1], base[1][1], base[0][2], base[1][2]);
        c.beginPath();
        c.rect(clip.x, clip.y, clip.width, clip.height);
        c.clip();
      }
      smart.draw(c, base, e);
      c.restore();
    })};
    this.request();
  }

  /** Keeps the shown surfaces' states the session's own objects (timers and hit tests key on them). */
  private syncShownStates() {
    const session = this.session;
    if (!session) return;
    if (this.screen) this.screen = {...this.screen, state: session.screen};
    this.overlays = this.overlays.map((overlay, i) => (session.overlays[i] ? {...overlay, state: session.overlays[i]} : overlay));
    this.syncTimers();
  }

  private finishAnimation() {
    const anim = this.anim;
    if (!anim) return;
    this.anim = null;
    anim.finish();
  }

  // ── Timers ("After delay") ──

  private clearTimers() {
    for (const handles of this.timers.values()) for (const handle of handles) clearTimeout(handle);
    this.timers.clear();
  }

  private syncTimers() {
    const session = this.session, doc = this.doc;
    const shown = session ? [session.screen, ...session.overlays] : [];
    for (const [state, handles] of this.timers) {
      if (shown.includes(state)) continue;
      for (const handle of handles) clearTimeout(handle);
      this.timers.delete(state);
    }
    if (!doc) return;
    for (const state of shown) {
      if (this.timers.has(state)) continue;
      const handles: ReturnType<typeof setTimeout>[] = [];
      this.forEachReaction(doc, state.frameId, (node, reaction) => {
        if (reaction.trigger.type !== 'AFTER_TIMEOUT') return;
        const delay = Math.max(0, reaction.trigger.timeout * 1000);
        handles.push(setTimeout(() => this.fireTimer(state, node.id, reaction), delay));
      });
      this.timers.set(state, handles);
    }
  }

  private fireTimer(state: SurfaceState, nodeId: NodeId, reaction: Reaction) {
    const session = this.session;
    if (!session || this.disposed) return;
    const surface = session.screen === state ? -1 : session.overlays.indexOf(state as OverlayState);
    if (surface < -1 || (surface === -1 && session.screen !== state)) return;
    if (this.anim || this.busy) {
      // Let the running transition end first.
      setTimeout(() => this.fireTimer(state, nodeId, reaction), 50);
      return;
    }
    this.run(reaction, {id: nodeId, surface, rect: this.sourceRect(surface, nodeId)});
  }

  private forEachReaction(doc: DesignDocument, rootId: NodeId, visit: (node: SceneNode, reaction: Reaction) => void) {
    const stack = [rootId];
    while (stack.length) {
      const node = doc.nodes[stack.pop()!];
      if (!node || node.visible === false) continue;
      for (const reaction of node.reactions ?? []) visit(node, reaction);
      if (node.children) stack.push(...node.children);
    }
  }

  private sourceRect(surface: number, id: NodeId): Rect | undefined {
    const shown = surface < 0 ? this.screen : this.overlays[surface];
    if (!shown) return undefined;
    const m = placedMatrix(shown.surface.doc, shown.frame.id, id, shown.state.scroll);
    const node = shown.surface.doc.nodes[id];
    if (!m || !node) return undefined;
    const x = m[0][2] + shown.origin.x, y = m[1][2] + shown.origin.y;
    return {x, y, width: node.width, height: node.height};
  }

  // ── Pointer, wheel and keys ──

  private listen() {
    const canvas = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      target.addEventListener(type, handler as EventListener, options);
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
    };
    on(canvas, 'pointerdown', event => this.pointerDown(event));
    on(canvas, 'pointermove', event => this.pointerMove(event));
    on(canvas, 'pointerup', event => this.pointerUp(event, false));
    on(canvas, 'pointercancel', event => this.pointerUp(event, true));
    on(canvas, 'pointerleave', event => {
      if (event.pointerType === 'mouse' && !this.press) this.updateHover(null);
    });
    on(canvas, 'wheel', event => this.wheel(event), {passive: false});
    on(canvas, 'contextmenu', event => event.preventDefault());
    const key = (event: KeyboardEvent) => this.keyDown(event);
    window.addEventListener('keydown', key);
    this.cleanups.push(() => window.removeEventListener('keydown', key));
    const offFonts = this.deps.fonts.onLoad(() => this.invalidate());
    const offImages = this.deps.images.onChange(() => this.invalidate());
    this.cleanups.push(offFonts, offImages);
  }

  private invalidate() {
    this.dirtySurfaces = true;
    this.request();
  }

  /** Screen units under a client point. */
  private toScreen(event: {clientX: number; clientY: number}): Vec {
    const rect = this.canvas.getBoundingClientRect();
    const k = (this.screen?.surface.scale ?? this.k) / this.dpr;
    return {x: (event.clientX - rect.left) / k, y: (event.clientY - rect.top) / k};
  }

  /** Which surface a screen point is on: the topmost overlay containing it, the screen, or −2 when an
   *  overlay blocks the screen (a click there may close it). */
  private surfaceAt(point: Vec): number {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const overlay = this.overlays[i];
      const {x, y} = overlay.origin;
      if (point.x >= x && point.y >= y && point.x <= x + overlay.size.width && point.y <= y + overlay.size.height) return i;
      return -2;
    }
    return -1;
  }

  private hotspotsOn(surface: number, point: Vec): Hotspot[] {
    const shown = surface < 0 ? this.screen : this.overlays[surface];
    if (!shown || surface < -1) return [];
    const local = {x: point.x - shown.origin.x, y: point.y - shown.origin.y};
    return hotspotsAt(this.hotspotsOfShown(shown), local);
  }

  /** A surface's hotspots where they are now, worked out once per scroll position (not per pointer move). */
  private hotspotsOfShown(shown: Shown): Hotspot[] {
    const cached = this.hotspotCache.get(shown.surface);
    if (cached && cached.scroll === shown.state.scroll) return cached.list;
    const list = hotspotsOf(shown.surface.doc, shown.frame.id, shown.state.scroll, shown.size);
    this.hotspotCache.set(shown.surface, {scroll: shown.state.scroll, list});
    return list;
  }

  /** The first hotspot (topmost first) with a reaction for `trigger`, and that reaction. */
  private find(hotspots: Hotspot[], surface: number, trigger: Trigger['type']): {hotspot: Hotspot; reaction: Reaction} | null {
    const shown = surface < 0 ? this.screen : this.overlays[surface];
    if (!shown) return null;
    const doc = shown.surface.doc;
    for (const hotspot of hotspots) {
      const reaction = doc.nodes[hotspot.id]?.reactions.find(each => each.trigger.type === trigger && playableActions(doc, hotspot.id, each).length);
      if (reaction) return {hotspot, reaction};
    }
    return null;
  }

  private source(surface: number, hotspot: Hotspot): ActionSource {
    const shown = surface < 0 ? this.screen : this.overlays[surface];
    const origin = shown?.origin ?? ZERO;
    return {id: hotspot.id, surface, rect: {x: hotspot.rect.x + origin.x, y: hotspot.rect.y + origin.y, width: hotspot.rect.width, height: hotspot.rect.height}};
  }

  private pointerDown(event: PointerEvent) {
    if (event.button !== 0 || this.press || !this.session) return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.momentum = null;
    const point = this.toScreen(event);
    const surface = this.surfaceAt(point);
    const hotspots = this.hotspotsOn(surface, point);
    const shown = surface >= -1 ? (surface < 0 ? this.screen : this.overlays[surface]) : null;
    const scroll = shown ? shown.surface.containersAt({x: point.x - shown.origin.x, y: point.y - shown.origin.y}, shown.state.scroll) : [];
    this.press = {pointerId: event.pointerId, start: point, at: point, moved: false, surface, hotspots, scroll, dragFired: false, last: {x: point.x, y: point.y, time: event.timeStamp}, velocity: ZERO, pointerType: event.pointerType};
    if (this.anim || this.busy) return;
    const pressed = this.find(hotspots, surface, 'ON_PRESS');
    if (pressed) this.press.acted = this.run(pressed.reaction, this.source(surface, pressed.hotspot), {while: 'ON_PRESS'});
    // "Mouse down" acts at once, without waiting for the release.
    else {
      const down = this.find(hotspots, surface, 'MOUSE_DOWN');
      if (down) this.press.acted = this.run(down.reaction, this.source(surface, down.hotspot));
    }
  }

  private pointerMove(event: PointerEvent) {
    const point = this.toScreen(event);
    const press = this.press;
    if (press && event.pointerId === press.pointerId) {
      const dx = point.x - press.at.x, dy = point.y - press.at.y;
      const dt = Math.max(1, event.timeStamp - press.last.time);
      press.velocity = {x: (point.x - press.last.x) / dt, y: (point.y - press.last.y) / dt};
      press.last = {x: point.x, y: point.y, time: event.timeStamp};
      press.at = point;
      if (!press.moved && Math.hypot(point.x - press.start.x, point.y - press.start.y) * this.fit >= DRAG_PX) {
        press.moved = true;
        const dragged = !this.anim && !this.busy ? this.find(press.hotspots, press.surface, 'ON_DRAG') : null;
        if (dragged) {
          press.dragFired = true;
          this.run(dragged.reaction, this.source(press.surface, dragged.hotspot));
        }
      }
      if (press.moved && !press.dragFired) this.scrollBy(press.surface, press.scroll, {x: -dx, y: -dy});
      return;
    }
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') this.updateHover(point);
  }

  private pointerUp(event: PointerEvent, cancelled: boolean) {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    this.press = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.endWhile('ON_PRESS');
    if (cancelled) return;
    if (press.moved) {
      // On a phone a sideways flick that dragged and scrolled nothing steps through the flow (phone/swipe.ts).
      if (press.pointerType === 'touch' && !press.dragFired && !press.scroll.length && !this.busy) {
        const step = swipeStep(press.start, this.toScreen(event), this.fit);
        if (step) {
          this.step(step);
          return;
        }
      }
      // A flick keeps scrolling and slows down.
      if (!press.dragFired && press.scroll.length && Math.hypot(press.velocity.x, press.velocity.y) > 0.2) {
        this.momentum = {surface: press.surface, id: press.scroll[0], velocity: {x: -press.velocity.x * 16, y: -press.velocity.y * 16}, last: now()};
        this.request();
      }
      return;
    }
    // A press that already did its part ("Mouse down", "While pressing") ends here: its release starts
    // nothing on the screen it led to.
    if (press.acted) {
      if (event.pointerType === 'mouse') this.updateHover(this.toScreen(event));
      return;
    }
    if (this.busy) return;
    // A click during a transition is not swallowed: the transition jumps to its end and the click lands there, so
    // clicking through a deck or a flow quickly keeps up (only a destination still loading its pictures waits).
    const interrupted = !!this.anim;
    this.finishAnimation();
    const point = this.toScreen(event);
    const surface = interrupted ? this.surfaceAt(point) : press.surface;
    if (surface === -2) {
      const top = this.overlays[this.overlays.length - 1];
      if (top?.frame.overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE' && this.session) {
        const step = closeOverlays(this.session, this.overlays.length - 1);
        this.apply(step.state, step.effect);
      } else this.flash();
      return;
    }
    const under = this.hotspotsOn(surface, point);
    // "Mouse up" takes the release; a click on the same press is left for layers without one.
    const released = this.find(under, surface, 'MOUSE_UP');
    const clicked = released ? null : this.find(under, surface, 'ON_CLICK');
    if (released) this.run(released.reaction, this.source(surface, released.hotspot));
    else if (clicked) this.run(clicked.reaction, this.source(surface, clicked.hotspot));
    else if (this.openTextLink(surface, point)) return;
    else if (event.pointerType === 'touch' && this.tapOnStill(surface)) return;
    else this.flash();
    if (event.pointerType === 'mouse') this.updateHover(point);
  }

  /** A finger's tap on nothing (Figma's app): on a screen with no hotspots at all it goes to the next screen of the flow;
   *  anywhere else the phone's bar shows and the hotspots flash. True when the tap was used. */
  private tapOnStill(surface: number): boolean {
    this.deps.onMissTap?.();
    const shown = surface === -1 ? this.screen : null;
    if (!shown || this.overlays.length || this.hotspotsOfShown(shown).length) return false;
    this.step(1);
    return true;
  }

  /** The link on the words under `point` on a surface, with the text it is in, or null (text-links.ts). */
  private textLinkAt(surface: number, point: Vec): {hyperlink: Hyperlink; spot: Hotspot} | null {
    const shown = surface < 0 ? this.screen : this.overlays[surface];
    if (!shown || surface < -1) return null;
    const doc = shown.surface.doc;
    let cached = this.linkCache.get(shown.surface);
    if (!cached || cached.scroll !== shown.state.scroll) this.linkCache.set(shown.surface, (cached = {scroll: shown.state.scroll, list: linkSpotsOf(doc, shown.frame.id, shown.state.scroll, shown.size)}));
    if (!cached.list.length) return null;
    return linkAt(doc, cached.list, {x: point.x - shown.origin.x, y: point.y - shown.origin.y}, this.deps.fonts.measurer);
  }

  /** A click on linked words, as Figma's prototypes: a web address opens in a new tab, a frame of the file is navigated to.
   *  True when it did. */
  private openTextLink(surface: number, point: Vec): boolean {
    const found = this.textLinkAt(surface, point);
    if (!found) return false;
    const {hyperlink, spot} = found;
    if (hyperlink.type === 'URL') {
      this.openUrl(hyperlink.url, true);
      return true;
    }
    const reaction: Reaction = {trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: hyperlink.nodeId, transition: {type: 'INSTANT'}}]};
    return this.run(reaction, this.source(surface, spot));
  }

  /** A click on nothing shows where the hotspots are. */
  private flash() {
    this.flashStart = now();
    this.request();
  }

  private updateHover(point: Vec | null) {
    if (!this.session) return;
    const surface = point ? this.surfaceAt(point) : -2;
    const hotspots = point ? this.hotspotsOn(surface, point) : [];
    const ids = new Set(hotspots.map(hotspot => hotspot.id));
    const before = this.hovered;
    const clickable = hotspots.some(hotspot => (this.surfaceDoc(surface)?.nodes[hotspot.id]?.reactions ?? []).some(reaction => reaction.trigger.type === 'ON_CLICK' || reaction.trigger.type === 'ON_PRESS' || reaction.trigger.type === 'ON_DRAG'));
    this.canvas.style.cursor = clickable || (point && this.textLinkAt(surface, point)) ? 'pointer' : 'default';
    this.hovered = {surface, ids};
    // While-hover effects end when the pointer leaves both the layer and what it opened.
    this.whiles = this.whiles.filter(entry => {
      if (entry.trigger !== 'ON_HOVER') return true;
      if (ids.has(entry.sourceId) && surface === this.surfaceIndexOf(entry.surface)) return true;
      if (entry.overlay && point) {
        const index = this.session!.overlays.indexOf(entry.overlay);
        if (index >= 0 && surface === index) return true;
      }
      if (this.anim || this.busy) return true;
      entry.undo();
      return false;
    });
    if (this.anim || this.busy) return;
    const left = before.surface === surface ? [...before.ids].filter(id => !ids.has(id)) : [...before.ids];
    const entered = before.surface === surface ? hotspots.filter(hotspot => !before.ids.has(hotspot.id)) : hotspots;
    for (const id of left) {
      const doc = this.surfaceDoc(before.surface);
      const reaction = doc?.nodes[id]?.reactions.find(each => each.trigger.type === 'MOUSE_LEAVE');
      if (reaction && this.run(reaction, {id, surface: before.surface, rect: this.sourceRect(before.surface, id)})) return;
    }
    for (const hotspot of entered) {
      const doc = this.surfaceDoc(surface);
      const node = doc?.nodes[hotspot.id];
      const enter = node?.reactions.find(each => each.trigger.type === 'MOUSE_ENTER');
      if (enter && this.run(enter, this.source(surface, hotspot))) return;
      const hover = node?.reactions.find(each => each.trigger.type === 'ON_HOVER');
      if (hover && this.run(hover, this.source(surface, hotspot), {while: 'ON_HOVER'})) return;
    }
  }

  private surfaceDoc(surface: number): DesignDocument | null {
    const shown = surface < 0 ? (surface === -1 ? this.screen : null) : this.overlays[surface];
    return shown?.surface.doc ?? null;
  }

  /** Where a surface state is shown now (scrolling replaces the state object, so frames decide too). */
  private surfaceIndexOf(state: SurfaceState): number {
    const session = this.session;
    if (!session) return -3;
    if (session.screen === state || session.screen.frameId === state.frameId) return -1;
    const index = session.overlays.findIndex(overlay => overlay === state || overlay.frameId === state.frameId);
    return index >= 0 ? index : -3;
  }

  private endWhile(trigger: 'ON_PRESS' | 'ON_HOVER') {
    const ending = this.whiles.filter(entry => entry.trigger === trigger);
    this.whiles = this.whiles.filter(entry => entry.trigger !== trigger);
    for (const entry of ending) entry.undo();
  }

  private wheel(event: WheelEvent) {
    event.preventDefault();
    if (!this.session || this.anim) return;
    const point = this.toScreen(event);
    const surface = this.surfaceAt(point);
    const shown = surface >= -1 ? (surface < 0 ? this.screen : this.overlays[surface]) : null;
    if (!shown) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? shown.size.height : 1;
    const k = (shown.surface.scale / this.dpr);
    const delta = {x: (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * scale / k, y: (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * scale / k};
    const containers = shown.surface.containersAt({x: point.x - shown.origin.x, y: point.y - shown.origin.y}, shown.state.scroll);
    this.scrollBy(surface, containers, delta);
  }

  /** Scrolls the innermost container that can still move that way (screen units). */
  private scrollBy(surface: number, containers: readonly NodeId[], delta: Vec): boolean {
    const shown = surface < 0 ? this.screen : this.overlays[surface];
    const session = this.session;
    if (!shown || !session || surface < -1) return false;
    let remaining = {...delta};
    let scroll = shown.state.scroll;
    for (const id of containers) {
      if (!remaining.x && !remaining.y) break;
      const max = shown.surface.maxScroll(id);
      const current = scroll[id] ?? ZERO;
      const next = {x: Math.min(max.x, Math.max(0, current.x + remaining.x)), y: Math.min(max.y, Math.max(0, current.y + remaining.y))};
      if (next.x === current.x && next.y === current.y) continue;
      remaining = {x: remaining.x - (next.x - current.x), y: remaining.y - (next.y - current.y)};
      scroll = {...scroll, [id]: next};
    }
    if (scroll === shown.state.scroll) return false;
    this.session = withScroll(session, surface, scroll);
    this.syncShownStates();
    this.request();
    return true;
  }

  private stepMomentum(time: number): boolean {
    const momentum = this.momentum;
    if (!momentum) return false;
    const dt = Math.min(48, time - momentum.last);
    momentum.last = time;
    const decay = Math.pow(0.94, dt / 16);
    momentum.velocity = {x: momentum.velocity.x * decay, y: momentum.velocity.y * decay};
    const moved = this.scrollBy(momentum.surface, [momentum.id], {x: momentum.velocity.x * (dt / 16), y: momentum.velocity.y * (dt / 16)});
    if (!moved || Math.hypot(momentum.velocity.x, momentum.velocity.y) < 0.1) {
      this.momentum = null;
      return false;
    }
    return true;
  }

  private keyDown(event: KeyboardEvent) {
    if (!this.session || event.defaultPrevented || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    // The prototype's own keys first, topmost overlay first; a key that has an interaction finishes a running
    // transition first, as a click does.
    if (!event.repeat && !this.busy) {
      const surfaces = [...this.overlays.map((_, i) => i).reverse(), -1];
      for (const surface of surfaces) {
        const shown = surface < 0 ? this.screen : this.overlays[surface];
        if (!shown) continue;
        let found: {node: SceneNode; reaction: Reaction} | null = null;
        this.forEachReaction(shown.surface.doc, shown.frame.id, (node, reaction) => {
          if (!found && reaction.trigger.type === 'ON_KEY_DOWN' && matchesShortcut(event, reaction.trigger.keyCode)) found = {node, reaction};
        });
        if (found) {
          const {node, reaction} = found as {node: SceneNode; reaction: Reaction};
          event.preventDefault();
          this.finishAnimation();
          this.run(reaction, {id: node.id, surface, rect: this.sourceRect(surface, node.id)});
          return;
        }
        if (surface >= 0) break;
      }
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === 'KeyR') {
      event.preventDefault();
      this.restart();
    } else if (event.code === 'ArrowRight') {
      event.preventDefault();
      this.step(1);
    } else if (event.code === 'ArrowLeft') {
      event.preventDefault();
      this.step(-1);
    }
  }
}

/** Whether two documents show the same frame except inside one instance (a variant switch that moved
 *  nothing else): the frame's other tiles can then be kept. */
function onlyInside(a: DesignDocument, b: DesignDocument, rootId: NodeId, instanceId: NodeId): boolean {
  if (a === b) return true;
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === instanceId) continue;
    const na = a.nodes[id], nb = b.nodes[id];
    if (na !== nb && (!na || !nb || !sameOwnLook(na, nb, true) || (na.children ?? []).join() !== (nb.children ?? []).join())) return false;
    if (nb?.children) stack.push(...nb.children);
  }
  return true;
}
