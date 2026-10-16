import type {DesignDocument, Matrix, NodeId, Paint, SceneNode, ShadowEffect} from '../../../../shared/design/types';
import {CONTAINER_TYPES} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import {IDENTITY, invert, localMatrix, multiply, transformRect} from '../../../../shared/design/geometry';
import {blurReach, clipsChildren, expandWorldByEffects, localRenderBounds, strokeOutsets, unionRect} from '../../../../shared/design/bounds';
import type {PaintTarget} from '../contracts';
import {blendOperation, cssColor, isNormalBlend} from './blend';
import type {PooledCanvas} from './canvas';
import {blurCanvas, CanvasPool, context2d, createCanvas, resetContext} from './canvas';
import type {NodeShape} from './geometry-cache';
import {pathOf, shapeOf, shapeOfPaths, spreadPath, variableStrokeOf} from './geometry-cache';
import {gridBands, gridLines} from './grid-math';
import {luminanceToAlpha} from './image-math';
import type {PaintContext} from './paints';
import {checkerStyle, paintStyle, paintVisible} from './paints';
import {CANVAS_CAPS, CANVAS_JOINS, individualStrokeBand, markerShape, pathEnds, roundedRectCommands, shortenPath, strokePlan} from './stroke-math';
import {drawText, textLayoutOf, textRegion} from './text-draw';
import type {TextPaintCallbacks} from './text-draw';
import type {Affine, Ctx2D, PaintOptions as BasePaintOptions, Surface as BaseSurface} from './types';

export type PaintOptions = BasePaintOptions & {
  /** Device-pixel rectangle of the target the caller keeps (a tile's stale part and a margin): nodes that paint nothing
   *  inside it are skipped. Unlike `clip` it changes no layer and no clip of what is painted, so every pixel inside it
   *  comes out as a paint with `clip` alone gives it; a layer's content (opacity, blur, masks) is painted whole. */
  cull?: Rect;
};
/** `cull` in surface px; a layer's own surface has none. */
type Surface = BaseSurface & {cull?: Rect};

// The one painting path (docs/design-tool.md §Renderer): the canvas tiles, live layer, exports,
// thumbnails and the prototype player all call `paintNodeTree`. It walks the tree in paint order
// (children bottom-to-top), sets each node's world transform on the context and draws, per node:
//   drop shadows → background blur → fills → inner shadows → children (clipped) → strokes → grids
// Opacity, blend modes and layer blur that apply to a composite go through an offscreen layer;
// a single fill or stroke takes them directly. Masks composite their siblings through layers.

// ── Transforms ────────────────────────────────────────────────────────────────────────────────

const locals = new WeakMap<SceneNode, Matrix>();
const worlds = new WeakMap<SceneNode, {parent: Matrix; world: Matrix}>();

export function localOf(node: SceneNode): Matrix {
  let m = locals.get(node);
  if (!m) locals.set(node, (m = localMatrix(node)));
  return m;
}

/** World matrix of `node` under its parent's world matrix. Cached by node identity and the parent
 *  matrix's identity, so an unchanged subtree under an unchanged parent costs a lookup. */
/** A board section with "Hide contents" on (lane G's `board: {kind: 'section', hidden: true}`): it draws its own fill,
 *  stroke and name chip, never what it holds, and what it holds does not count toward its bounds. Export is another call. */
export const hidesContents = (node: SceneNode): boolean => node.type === 'SECTION' && node.board?.kind === 'section' && node.board.hidden === true;

export function worldOf(node: SceneNode, parent: Matrix): Matrix {
  const entry = worlds.get(node);
  if (entry && entry.parent === parent) return entry.world;
  const world = parent === IDENTITY ? localOf(node) : multiply(parent, localOf(node));
  worlds.set(node, {parent, world});
  return world;
}

/** World matrix of any node, through the cached chain of its ancestors. Pages are the identity. */
export function worldOfNode(doc: DesignDocument, node: SceneNode): Matrix {
  if (node.type === 'PAGE') return IDENTITY;
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  return worldOf(node, parent ? worldOfNode(doc, parent) : IDENTITY);
}

export const affineOf = (base: Matrix, world: Matrix): Affine => ({
  a: base[0][0] * world[0][0] + base[0][1] * world[1][0],
  b: base[1][0] * world[0][0] + base[1][1] * world[1][0],
  c: base[0][0] * world[0][1] + base[0][1] * world[1][1],
  d: base[1][0] * world[0][1] + base[1][1] * world[1][1],
  e: base[0][0] * world[0][2] + base[0][1] * world[1][2] + base[0][2],
  f: base[1][0] * world[0][2] + base[1][1] * world[1][2] + base[1][2],
});
const matrixOf = (t: Affine): Matrix => [[t.a, t.c, t.e], [t.b, t.d, t.f]];
const setTransform = (ctx: Ctx2D, t: Affine) => ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);

/** Axis-aligned image of a rectangle under an affine map. */
function mapRect(t: Affine, r: Rect): Rect {
  const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  const ax = t.a * x0, bx = t.a * x1, cy = t.c * y0, dy = t.c * y1;
  const ex = t.b * x0, fx = t.b * x1, gy = t.d * y0, hy = t.d * y1;
  const minX = Math.min(ax, bx) + Math.min(cy, dy) + t.e, maxX = Math.max(ax, bx) + Math.max(cy, dy) + t.e;
  const minY = Math.min(ex, fx) + Math.min(gy, hy) + t.f, maxY = Math.max(ex, fx) + Math.max(gy, hy) + t.f;
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}
const baseAffine = (m: Matrix): Affine => ({a: m[0][0], b: m[1][0], c: m[0][1], d: m[1][1], e: m[0][2], f: m[1][2]});

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bottom > y ? {x, y, width: r - x, height: bottom - y} : null;
}
const grow = (r: Rect, by: number): Rect => ({x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by});
/** Snaps outwards to whole pixels, so layers composite without resampling. */
function pixelRect(r: Rect): Rect {
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return {x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y};
}

// ── Per-node plans ────────────────────────────────────────────────────────────────────────────

type Caster = 'none' | 'geometry' | 'silhouette' | 'content';
type Plan = {
  fills: Paint[];
  strokes: Paint[];
  drops: ShadowEffect[];
  inners: ShadowEffect[];
  layerBlur: number;
  backgroundBlur: number;
  container: boolean;
  clips: boolean;
  caster: Caster;
  /** An opaque normal solid fill hides whatever is under the shape (no shadow knock-out needed). */
  opaqueCover: boolean;
  normalBlend: boolean;
  /** Opacity and blend mode can be applied to its only paint operation instead of a layer. */
  singleOp: boolean;
  markers: boolean;
};

const plans = new WeakMap<SceneNode, Plan>();
const isContainer = (node: SceneNode) => CONTAINER_TYPES.includes(node.type) && node.type !== 'BOOLEAN_OPERATION';

function makePlan(node: SceneNode, shape: NodeShape | null): Plan {
  const fills = node.fills.filter(paintVisible);
  const strokes = node.strokeWeight > 0 ? node.strokes.filter(paintVisible) : [];
  const effects = node.effects.filter(effect => effect.visible !== false);
  const drops = effects.filter((e): e is ShadowEffect => e.type === 'DROP_SHADOW');
  const inners = effects.filter((e): e is ShadowEffect => e.type === 'INNER_SHADOW');
  const layerBlur = Math.max(0, ...effects.filter(e => e.type === 'LAYER_BLUR').map(e => e.radius));
  const backgroundBlur = Math.max(0, ...effects.filter(e => e.type === 'BACKGROUND_BLUR').map(e => e.radius));
  const container = isContainer(node);
  const markers = !!shape?.open && [node.strokeStartMarker, node.strokeEndMarker].some(m => m && m !== 'NONE');
  let caster: Caster = 'none';
  if (drops.length || inners.length) {
    if (node.type === 'TEXT' || !shape || shape.open || fills.some(p => p.type === 'IMAGE')) caster = 'content';
    else if (container && !fills.length) caster = 'content';
    else if (!fills.length || (strokes.length && node.strokeAlign !== 'INSIDE')) caster = 'silhouette';
    else caster = 'geometry';
  }
  const ops = fills.length + strokes.length * (markers ? 2 : 1) + drops.length + inners.length + (backgroundBlur ? 1 : 0);
  const normalBlend = isNormalBlend(node.blendMode);
  return {
    fills, strokes, drops, inners, layerBlur, backgroundBlur, container,
    clips: clipsChildren(node),
    caster,
    opaqueCover: fills.some(p => p.type === 'SOLID' && p.opacity >= 1 && isNormalBlend(p.blendMode)),
    normalBlend,
    singleOp: !container && ops <= 1 && (normalBlend || [...fills, ...strokes].every(p => isNormalBlend(p.blendMode))),
    markers,
  };
}

function planOf(node: SceneNode, shape: NodeShape | null, resolvedShape: boolean): Plan {
  if (resolvedShape) return makePlan(node, shape);
  let plan = plans.get(node);
  if (!plan) plans.set(node, (plan = makePlan(node, shape)));
  return plan;
}

// ── Markers ───────────────────────────────────────────────────────────────────────────────────

type Markers = {line: Path2D | null; fills: Path2D | null; strokes: Path2D | null};
const markerCache = new WeakMap<SceneNode, Markers>();

function markersOf(node: SceneNode, shape: NodeShape): Markers {
  let cached = markerCache.get(node);
  if (cached) return cached;
  const ends = pathEnds(shape.commands);
  const start = ends && node.strokeStartMarker ? markerShape(node.strokeStartMarker, ends.start, node.strokeWeight) : null;
  const end = ends && node.strokeEndMarker ? markerShape(node.strokeEndMarker, ends.end, node.strokeWeight) : null;
  const fills = [start?.fill, end?.fill].filter((c): c is NonNullable<typeof c> => !!c);
  const strokes = [start?.stroke, end?.stroke].filter((c): c is NonNullable<typeof c> => !!c);
  const inset = (start?.inset ?? 0) + (end?.inset ?? 0);
  cached = {
    line: inset > 0 ? pathOf(shortenPath(shape.commands, start?.inset ?? 0, end?.inset ?? 0)) : null,
    fills: fills.length ? pathOf(fills.flat()) : null,
    strokes: strokes.length ? pathOf(strokes.flat()) : null,
  };
  markerCache.set(node, cached);
  return cached;
}

// ── Effect bitmaps ────────────────────────────────────────────────────────────────────────────

/** Blurred shadows are the most expensive thing a node draws. Their composite is kept as a bitmap
 *  per node look (everything but its position), scale and rotation, so a card with a shadow spanning
 *  four tiles blurs once, and dragging it re-blurs never. Keyed by the effects array, which an edit
 *  that does not touch effects keeps. */
type EffectEntry = {node: SceneNode; scale: number; a: number; b: number; c: number; d: number; x: number; y: number; canvas: ReturnType<typeof createCanvas>; bytes: number};
const effectEntries = new Map<object, EffectEntry>();
let effectBytes = 0;
const EFFECT_BUDGET = 96 * 1024 * 1024;
const EFFECT_MAX_PIXELS = 4 * 1024 * 1024;

/** Fields that do not change how a node looks wherever it is. */
const POSITION_FIELDS = new Set(['x', 'y', 'name', 'locked', 'parentId', 'children', 'constraints', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'exportSettings', 'reactions', 'pluginData', 'overrides', 'description', 'componentPropertyDefinitions', 'componentProperties', 'componentPropertyReferences']);

/** True when two versions of a node look the same apart from where they are (shallow, by identity). */
export function sameLook(a: SceneNode, b: SceneNode): boolean {
  if (a === b) return true;
  // A group paints nothing of its own: its box is where its children happen to be.
  const ignored = a.type === 'GROUP' && b.type === 'GROUP' ? GROUP_POSITION_FIELDS : POSITION_FIELDS;
  const record = (n: SceneNode) => n as unknown as Record<string, unknown>;
  for (const key in a) if (!ignored.has(key) && record(a)[key] !== record(b)[key]) return false;
  for (const key in b) if (!ignored.has(key) && !(key in a)) return false;
  return true;
}
const GROUP_POSITION_FIELDS = new Set([...POSITION_FIELDS, 'width', 'height']);

function effectLookup(key: object, node: SceneNode, scale: number, t: Affine): EffectEntry | null {
  const entry = effectEntries.get(key);
  if (!entry) return null;
  const close = (p: number, q: number) => Math.abs(p - q) < 1e-9;
  if (entry.scale !== scale || !close(entry.a, t.a) || !close(entry.b, t.b) || !close(entry.c, t.c) || !close(entry.d, t.d) || !sameLook(entry.node, node)) return null;
  effectEntries.delete(key);
  effectEntries.set(key, entry);
  return entry;
}

function effectStore(key: object, entry: EffectEntry): void {
  const old = effectEntries.get(key);
  if (old) {
    effectBytes -= old.bytes;
    effectEntries.delete(key);
  }
  effectEntries.set(key, entry);
  effectBytes += entry.bytes;
  for (const [k, e] of effectEntries) {
    if (effectBytes <= EFFECT_BUDGET) break;
    if (k === key) continue;
    effectEntries.delete(k);
    effectBytes -= e.bytes;
  }
}

/** A second stable key per effects array, for the blurred layer next to the shadows. */
const blurKeys = new WeakMap<readonly unknown[], object>();
function blurKeyOf(effects: readonly unknown[]): object {
  let key = blurKeys.get(effects);
  if (!key) blurKeys.set(effects, (key = {}));
  return key;
}

/** Forgets every cached effect bitmap (fonts or pictures changed what they show). */
export function clearEffectCache(): void {
  effectEntries.clear();
  effectBytes = 0;
}

// ── The painter ───────────────────────────────────────────────────────────────────────────────

const pool = new CanvasPool();
/** The shared pool of offscreen canvases (the scene renderer trims it when it is disposed). */
export const canvasPool = pool;

type Layer = PooledCanvas & {x: number; y: number};

const BOOLEAN_OPS: Record<string, GlobalCompositeOperation> = {UNION: 'source-over', SUBTRACT: 'destination-out', INTERSECT: 'destination-in', EXCLUDE: 'xor'};

class Painter implements TextPaintCallbacks {
  private readonly memo = new Map<NodeId, Rect | null>();
  /** Index hits under the clip (and under the cull area), by parent: what a large container's children are visited. */
  private byParent: Map<NodeId, NodeId[]> | null = null;
  private byParentCulled: Map<NodeId, NodeId[]> | null = null;
  private clipArea: Rect | null = null;
  private readonly indexOrder = new WeakMap<readonly NodeId[], Map<NodeId, number>>();
  // Current text paint context (TextPaintCallbacks without a closure per node).
  private textPC: PaintContext | null = null;
  private textAlpha = 1;
  private textOp: GlobalCompositeOperation = 'source-over';

  constructor(private readonly doc: DesignDocument, private readonly o: PaintOptions) {}

  paintRoots(target: Surface, rootIds: readonly NodeId[]): void {
    if (this.o.index) {
      const inv = baseAffine(invert(target.base));
      if (target.cull) {
        this.byParentCulled = this.childrenUnder(mapRect(inv, target.cull));
        // A layer's content is painted whole (no cull): its containers visit what the clip holds, made when first asked.
        this.clipArea = mapRect(inv, target.clip);
      } else this.byParent = this.childrenUnder(mapRect(inv, target.clip));
    }
    for (const id of rootIds) {
      const node = this.doc.nodes[id];
      if (!node) continue;
      if (node.type === 'PAGE') {
        this.children(target, node, IDENTITY);
        continue;
      }
      const parent = node.parentId ? this.doc.nodes[node.parentId] : undefined;
      this.node(target, node, parent ? worldOfNode(this.doc, parent) : IDENTITY, true);
    }
  }

  // ── Bounds ──

  private localBounds(node: SceneNode): Rect {
    return node.type === 'TEXT' ? localRenderBounds(node, textLayoutOf(node, this.o.fonts)) : localRenderBounds(node);
  }

  /** Page-space bounds of what the node and its subtree paint. */
  private bounds(node: SceneNode, world: Matrix): Rect | null {
    if (this.o.index) return this.o.index.bounds(node.id) ?? null;
    if (this.memo.has(node.id)) return this.memo.get(node.id)!;
    let rect: Rect | null;
    if (!isContainer(node) || clipsChildren(node)) rect = transformRect(world, this.localBounds(node));
    else {
      rect = node.type === 'GROUP' || node.type === 'PAGE' ? null : transformRect(world, ownBox(node));
      for (const childId of node.children ?? []) {
        const child = this.doc.nodes[childId];
        if (!child || child.visible === false || child.type === 'SLICE') continue;
        const childRect = this.bounds(child, worldOf(child, world));
        if (childRect) rect = rect ? unionRect(rect, childRect) : childRect;
      }
      rect = rect && expandWorldByEffects(rect, node, world);
    }
    this.memo.set(node.id, rect);
    return rect;
  }

  private deviceBounds(s: Surface, node: SceneNode, world: Matrix): Rect | null {
    const page = this.bounds(node, world);
    return page && mapRect(baseAffine(s.base), page);
  }

  // ── Traversal ──

  private shapeFor(node: SceneNode): {shape: NodeShape | null; resolved: boolean} {
    if (node.type === 'BOOLEAN_OPERATION' && this.o.booleanGeometry) {
      const paths = this.o.booleanGeometry(this.doc, node.id);
      return {shape: paths && paths.length ? shapeOfPaths(paths, node) : null, resolved: true};
    }
    return {shape: shapeOf(node), resolved: false};
  }

  node(s: Surface, node: SceneNode, parentWorld: Matrix, root = false): void {
    if (node.visible === false && !(root && this.o.paintHiddenRoots)) return;
    if (this.o.hidden?.has(node.id) || node.type === 'SLICE') return;
    const world = worldOf(node, parentWorld);
    const device = this.deviceBounds(s, node, world);
    if (!device || !intersect(device, s.clip) || (s.cull && !intersect(device, s.cull))) return;
    const min = this.o.minSize ?? 0;
    if (min > 0 && device.width < min && device.height < min) return;
    if (this.o.outlines) return this.outline(s, node, world);
    const {shape, resolved} = this.shapeFor(node);
    const plan = planOf(node, shape, resolved);
    const opacity = Math.max(0, Math.min(1, node.opacity)) * (root ? this.o.rootOpacity ?? 1 : 1);
    if (opacity <= 0) return;
    const layered = plan.layerBlur > 0 || ((opacity < 1 || !plan.normalBlend) && !plan.singleOp);
    if (!layered) {
      const direct = !plan.container;
      this.content(s, node, world, shape, plan, direct ? opacity : 1, direct ? blendOperation(node.blendMode) : 'source-over');
      return;
    }
    if (plan.layerBlur && !plan.container && this.cachedBlur(s, node, world, shape, plan, opacity)) return;
    const margin = plan.layerBlur ? blurReach(plan.layerBlur) * s.scale : 0;
    const area = intersect(device, grow(s.clip, margin));
    if (!area) return;
    const layer = this.layer(pixelRect(area));
    this.content(this.surfaceOf(layer, s), node, world, shape, plan, 1, 'source-over');
    if (plan.layerBlur) blurCanvas(layer.canvas, layer.width, layer.height, (plan.layerBlur / 2) * s.scale, pool);
    this.composite(s, layer, opacity, blendOperation(node.blendMode));
    pool.release(layer);
  }

  /** A blurred leaf, whole, from the effect cache (blurred once per look and scale; a drag reuses
   *  it). False when it is too large to keep, so the caller blurs only the visible part. */
  private cachedBlur(s: Surface, node: SceneNode, world: Matrix, shape: NodeShape | null, plan: Plan, opacity: number): boolean {
    const t = affineOf(s.base, world);
    const rel = pixelRect(mapRect({...t, e: 0, f: 0}, this.localBounds(node)));
    if (!(rel.width > 0 && rel.height > 0) || rel.width * rel.height > EFFECT_MAX_PIXELS) return false;
    const key = blurKeyOf(node.effects);
    let entry = effectLookup(key, node, s.scale, t);
    if (!entry) {
      const canvas = createCanvas(rel.width, rel.height);
      const ctx = context2d(canvas);
      resetContext(ctx);
      const tc: Affine = {a: t.a, b: t.b, c: t.c, d: t.d, e: -rel.x, f: -rel.y};
      const surface: Surface = {ctx, canvas, base: multiply(matrixOf(tc), invert(world)), scale: s.scale, clip: {x: 0, y: 0, width: rel.width, height: rel.height}};
      this.content(surface, node, world, shape, plan, 1, 'source-over');
      blurCanvas(canvas, rel.width, rel.height, (plan.layerBlur / 2) * s.scale, pool);
      entry = {node, scale: s.scale, a: t.a, b: t.b, c: t.c, d: t.d, x: rel.x, y: rel.y, canvas, bytes: rel.width * rel.height * 4};
      effectStore(key, entry);
    }
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.globalAlpha = opacity;
    s.ctx.globalCompositeOperation = blendOperation(node.blendMode);
    s.ctx.drawImage(entry.canvas, t.e + entry.x, t.f + entry.y);
    s.ctx.globalAlpha = 1;
    s.ctx.globalCompositeOperation = 'source-over';
    return true;
  }

  private childrenUnder(area: Rect): Map<NodeId, NodeId[]> {
    const byParent = new Map<NodeId, NodeId[]>();
    for (const id of this.o.index!.query(area)) {
      const parentId = this.doc.nodes[id]?.parentId;
      if (!parentId) continue;
      let list = byParent.get(parentId);
      if (!list) byParent.set(parentId, (list = []));
      list.push(id);
    }
    return byParent;
  }

  private childOrder(container: SceneNode, culled: boolean): readonly NodeId[] {
    const ids = container.children ?? [];
    if (!culled && !this.byParent && this.clipArea) this.byParent = this.childrenUnder(this.clipArea);
    const lists = culled ? this.byParentCulled : this.byParent;
    const subset = lists && !this.o.index!.hasMask(container.id) && ids.length > 32 ? lists.get(container.id) ?? [] : null;
    let order: readonly NodeId[] = ids;
    if (subset) {
      let index = this.indexOrder.get(ids);
      if (!index) {
        index = new Map(ids.map((id, i) => [id, i]));
        this.indexOrder.set(ids, index);
      }
      const positions = index;
      order = subset.filter(id => positions.has(id)).sort((p, q) => positions.get(p)! - positions.get(q)!);
    }
    const auto = container.autoLayout;
    return auto && auto.layoutMode !== 'NONE' && auto.itemReverseZIndex ? [...order].reverse() : order;
  }

  children(s: Surface, container: SceneNode, world: Matrix): void {
    if (hidesContents(container)) return;
    const ids = this.childOrder(container, !!s.cull);
    const nodes = this.doc.nodes;
    for (let i = 0; i < ids.length; i++) {
      const child = nodes[ids[i]];
      if (!child) continue;
      if (!child.isMask || this.o.outlines) {
        this.node(s, child, world);
        continue;
      }
      let end = i + 1;
      while (end < ids.length && !nodes[ids[end]]?.isMask) end++;
      const masked = ids.slice(i + 1, end);
      if (child.visible === false || this.o.hidden?.has(child.id)) {
        // A hidden mask masks nothing: its siblings show in full.
        for (const id of masked) if (nodes[id]) this.node(s, nodes[id], world);
      } else this.maskGroup(s, child, masked, world);
      i = end - 1;
    }
  }

  private maskGroup(s: Surface, mask: SceneNode, ids: readonly NodeId[], parentWorld: Matrix): void {
    if (!ids.length) return;
    const maskWorld = worldOf(mask, parentWorld);
    const device = this.deviceBounds(s, mask, maskWorld);
    const area = device && intersect(device, s.clip);
    if (!area) return;
    const region = pixelRect(area);
    const type = mask.maskType ?? 'ALPHA';
    const shape = type === 'VECTOR' ? shapeOf(mask) : null;
    if (shape && shape.parts.length === 1) {
      s.ctx.save();
      setTransform(s.ctx, affineOf(s.base, maskWorld));
      s.ctx.clip(shape.parts[0].path, shape.parts[0].rule);
      const clipped: Surface = {...s, clip: region};
      for (const id of ids) if (this.doc.nodes[id]) this.node(clipped, this.doc.nodes[id], parentWorld);
      s.ctx.restore();
      return;
    }
    const content = this.layer(region);
    const contentSurface = this.surfaceOf(content, s);
    for (const id of ids) if (this.doc.nodes[id]) this.node(contentSurface, this.doc.nodes[id], parentWorld);
    const alpha = this.layer(region);
    this.node(this.surfaceOf(alpha, s), mask, parentWorld);
    if (type === 'LUMINANCE') {
      const pixels = alpha.ctx.getImageData(0, 0, alpha.width, alpha.height);
      luminanceToAlpha(pixels.data);
      alpha.ctx.putImageData(pixels, 0, 0);
    }
    content.ctx.setTransform(1, 0, 0, 1, 0, 0);
    content.ctx.globalAlpha = 1;
    content.ctx.globalCompositeOperation = 'destination-in';
    content.ctx.drawImage(alpha.canvas, 0, 0, alpha.width, alpha.height, 0, 0, alpha.width, alpha.height);
    pool.release(alpha);
    this.composite(s, content, 1, 'source-over');
    pool.release(content);
  }

  // ── Layers ──

  private layer(region: Rect): Layer {
    const item = pool.acquire(region.width, region.height) as Layer;
    item.x = region.x;
    item.y = region.y;
    return item;
  }

  private surfaceOf(layer: Layer, parent: Surface): Surface {
    const base: Matrix = [[parent.base[0][0], parent.base[0][1], parent.base[0][2] - layer.x], [parent.base[1][0], parent.base[1][1], parent.base[1][2] - layer.y]];
    return {ctx: layer.ctx, canvas: layer.canvas, base, scale: parent.scale, clip: {x: 0, y: 0, width: layer.width, height: layer.height}};
  }

  private composite(s: Surface, layer: Layer, alpha: number, op: GlobalCompositeOperation): void {
    const ctx = s.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(layer.canvas, 0, 0, layer.width, layer.height, layer.x, layer.y, layer.width, layer.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── A node's own drawing ──

  private content(s: Surface, node: SceneNode, world: Matrix, shape: NodeShape | null, plan: Plan, alpha: number, op: GlobalCompositeOperation): void {
    if (plan.drops.length) this.dropShadows(s, node, world, shape, plan, alpha);
    if (plan.backgroundBlur && shape) this.backgroundBlur(s, node, world, shape, plan.backgroundBlur);
    if (plan.inners.length && plan.caster === 'content') {
      const body = this.bodyLayer(s, node, world, shape, plan, 0);
      if (!body) return;
      this.composite(s, body, alpha, op);
      for (const effect of plan.inners) this.innerFromImage(s, body, body, effect, affineOf(s.base, world), alpha);
      pool.release(body);
      return;
    }
    this.body(s, node, world, shape, plan, alpha, op, true);
  }

  /** Fills, inner shadows, children, strokes and grids: everything but drop shadows and blur. */
  private body(s: Surface, node: SceneNode, world: Matrix, shape: NodeShape | null, plan: Plan, alpha: number, op: GlobalCompositeOperation, inners: boolean): void {
    const t = affineOf(s.base, world);
    if (node.type === 'TEXT') return this.text(s, node, plan, t, alpha, op);
    if (node.type === 'BOOLEAN_OPERATION' && !shape) return this.booleanFallback(s, node, world, plan, t, alpha, op);
    const pc = this.paintContext(node, s.scale);
    if (shape && plan.fills.length) this.fillShape(s.ctx, shape, plan.fills, pc, t, alpha, op);
    if (inners && shape && plan.inners.length) for (const effect of plan.inners) this.innerShadow(s, node, shape, plan, effect, t, alpha);
    if (plan.container) {
      if (plan.clips && shape) {
        s.ctx.save();
        setTransform(s.ctx, t);
        s.ctx.clip(shape.parts[0].path, shape.parts[0].rule);
        const box = intersect(mapRect(t, {x: 0, y: 0, width: node.width, height: node.height}), s.clip);
        if (box) this.children({...s, clip: box}, node, world);
        s.ctx.restore();
      } else this.children(s, node, world);
    }
    if (shape && plan.strokes.length) this.strokeShape(s, node, shape, plan, pc, t, alpha, op);
    if (this.o.layoutGrids && plan.container && node.layoutGrids?.length) this.grids(s.ctx, node, t, s.scale);
  }

  private paintContext(node: SceneNode, scale: number, region?: Rect): PaintContext {
    const out = strokeOutsets(node);
    return {
      doc: this.doc,
      images: this.o.images,
      scale,
      width: node.width,
      height: node.height,
      region: region ?? {x: -out.left, y: -out.top, width: node.width + out.left + out.right, height: node.height + out.top + out.bottom},
      onImage: this.o.onUse?.image,
    };
  }

  /** Sets the context up for one paint; the TextPaintCallbacks entry point too. */
  style(ctx: Ctx2D, paint: Paint, stroke: boolean): boolean {
    return this.applyPaint(ctx, paint, this.textPC!, this.textAlpha, this.textOp, stroke);
  }

  private applyPaint(ctx: Ctx2D, paint: Paint, pc: PaintContext, alpha: number, op: GlobalCompositeOperation, stroke: boolean): boolean {
    const style = paintStyle(ctx, paint, pc) ?? (paint.type === 'IMAGE' ? checkerStyle(ctx, pc.scale) : null);
    if (!style) return false;
    if (stroke) ctx.strokeStyle = style;
    else ctx.fillStyle = style;
    ctx.globalAlpha = alpha * paint.opacity;
    ctx.globalCompositeOperation = isNormalBlend(paint.blendMode) ? op : blendOperation(paint.blendMode);
    return true;
  }

  private fillShape(ctx: Ctx2D, shape: NodeShape, fills: readonly Paint[], pc: PaintContext, t: Affine, alpha: number, op: GlobalCompositeOperation): void {
    setTransform(ctx, t);
    for (const paint of fills) {
      if (!this.applyPaint(ctx, paint, pc, alpha, op, false)) continue;
      for (const part of shape.parts) ctx.fill(part.path, part.rule);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private setStrokeStyle(ctx: Ctx2D, node: SceneNode, lineWidth: number, dashed: boolean): void {
    ctx.lineWidth = lineWidth;
    ctx.lineCap = CANVAS_CAPS[node.strokeCap] ?? 'butt';
    ctx.lineJoin = CANVAS_JOINS[node.strokeJoin] ?? 'miter';
    ctx.miterLimit = node.strokeMiterLimit > 0 ? node.strokeMiterLimit : 4;
    ctx.setLineDash(dashed && node.dashPattern.length ? node.dashPattern : []);
  }

  private strokeShape(s: Surface, node: SceneNode, shape: NodeShape, plan: Plan, pc: PaintContext, t: Affine, alpha: number, op: GlobalCompositeOperation): void {
    const ctx = s.ctx;
    // "Width profile": the stroke is a filled outline (no dashes, no markers), the same pieces every export draws.
    const variable = variableStrokeOf(node);
    if (variable) {
      setTransform(ctx, t);
      for (const paint of plan.strokes) if (this.applyPaint(ctx, paint, pc, alpha, op, false)) ctx.fill(variable, 'nonzero');
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    const weight = node.strokeWeight;
    const individual = node.individualStrokeWeights;
    if (individual && shape.rect && !(individual.top === individual.left && individual.top === individual.right && individual.top === individual.bottom && individual.top === weight)) {
      // Per-side weights: the band between two rounded rectangles, filled even-odd.
      const band = individualStrokeBand(node.width, node.height, individual, node.strokeAlign, shape.rect);
      const path = pathOf(roundedRectCommands(band.outer.rect, band.outer.radii));
      if (band.inner) path.addPath(pathOf(roundedRectCommands(band.inner.rect, band.inner.radii)));
      setTransform(ctx, t);
      for (const paint of plan.strokes) if (this.applyPaint(ctx, paint, pc, alpha, op, false)) ctx.fill(path, 'evenodd');
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    const strokePlanned = strokePlan(node.strokeAlign, weight, shape.open);
    const markers = plan.markers ? markersOf(node, shape) : null;
    const line = markers?.line;
    const strokeAll = (target: Ctx2D, a: number, o: GlobalCompositeOperation) => {
      for (const paint of plan.strokes) {
        if (!this.applyPaint(target, paint, pc, a, o, true)) continue;
        if (line) target.stroke(line);
        else for (const part of shape.parts) target.stroke(part.path);
      }
    };
    if (!strokePlanned.clip) {
      setTransform(ctx, t);
      this.setStrokeStyle(ctx, node, strokePlanned.lineWidth, true);
      strokeAll(ctx, alpha, op);
    } else if (strokePlanned.clip === 'inside' && shape.parts.length === 1) {
      ctx.save();
      setTransform(ctx, t);
      ctx.clip(shape.parts[0].path, shape.parts[0].rule);
      this.setStrokeStyle(ctx, node, strokePlanned.lineWidth, true);
      strokeAll(ctx, alpha, op);
      ctx.restore();
    } else if (strokePlanned.clip === 'outside' && shape.invertible && shape.parts.length === 1) {
      ctx.save();
      setTransform(ctx, t);
      ctx.clip(this.inverse(shape, t, s.clip, weight * 2), 'evenodd');
      this.setStrokeStyle(ctx, node, strokePlanned.lineWidth, true);
      strokeAll(ctx, alpha, op);
      ctx.restore();
    } else {
      // A path that cannot be inverted exactly: stroke into a layer, keep the half we want.
      const device = intersect(mapRect(t, grow({x: 0, y: 0, width: node.width, height: node.height}, weight * 2)), s.clip);
      if (device) {
        const layer = this.layer(pixelRect(device));
        const lt: Affine = {...t, e: t.e - layer.x, f: t.f - layer.y};
        setTransform(layer.ctx, lt);
        this.setStrokeStyle(layer.ctx, node, strokePlanned.lineWidth, true);
        strokeAll(layer.ctx, 1, 'source-over');
        layer.ctx.globalAlpha = 1;
        layer.ctx.globalCompositeOperation = strokePlanned.clip === 'inside' ? 'destination-in' : 'destination-out';
        layer.ctx.fillStyle = '#000';
        for (const part of shape.parts) layer.ctx.fill(part.path, part.rule);
        this.composite(s, layer, alpha, op);
        pool.release(layer);
      }
    }
    if (markers && (markers.fills || markers.strokes)) {
      setTransform(ctx, t);
      this.setStrokeStyle(ctx, node, weight, false);
      for (const paint of plan.strokes) {
        if (markers.fills && this.applyPaint(ctx, paint, pc, alpha, op, false)) ctx.fill(markers.fills);
        if (markers.strokes && this.applyPaint(ctx, paint, pc, alpha, op, true)) ctx.stroke(markers.strokes);
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Everything except the shape: a frame around the visible area (in local space) plus the shape,
   *  for even-odd clipping. */
  private inverse(shape: NodeShape, t: Affine, clip: Rect, extra: number): Path2D {
    const inv = baseAffine(invert(matrixOf(t)));
    const area = grow(mapRect(inv, clip), extra + 1);
    const path = new Path2D();
    path.rect(area.x, area.y, area.width, area.height);
    path.addPath(shape.parts[0].path);
    return path;
  }

  private text(s: Surface, node: SceneNode, plan: Plan, t: Affine, alpha: number, op: GlobalCompositeOperation): void {
    const layout = textLayoutOf(node, this.o.fonts);
    if (!layout.lines.length) return;
    const region = textRegion(node, layout);
    this.textPC = this.paintContext(node, s.scale, region);
    this.textAlpha = alpha;
    this.textOp = op;
    const ctx = s.ctx;
    setTransform(ctx, t);
    const options = {fonts: this.o.fonts, scale: s.scale, greekBelow: this.o.greekBelow ?? 0, mode: 'fill' as const, onFont: this.o.onUse?.font};
    drawText(ctx, node, layout, options, this);
    const weight = node.strokeWeight;
    if (plan.strokes.length && weight > 0) {
      const align = node.strokeAlign;
      if (align === 'CENTER') {
        this.setStrokeStyle(ctx, node, weight, true);
        drawText(ctx, node, layout, {...options, mode: 'stroke', strokes: plan.strokes}, this);
      } else {
        const device = intersect(mapRect(t, grow(region, weight * 2)), s.clip);
        if (device) {
          const layer = this.layer(pixelRect(device));
          const lt: Affine = {...t, e: t.e - layer.x, f: t.f - layer.y};
          setTransform(layer.ctx, lt);
          this.setStrokeStyle(layer.ctx, node, weight * 2, true);
          this.textAlpha = 1;
          this.textOp = 'source-over';
          drawText(layer.ctx, node, layout, {...options, mode: 'stroke', strokes: plan.strokes}, this);
          layer.ctx.globalAlpha = 1;
          layer.ctx.globalCompositeOperation = align === 'INSIDE' ? 'destination-in' : 'destination-out';
          layer.ctx.fillStyle = '#000';
          drawText(layer.ctx, node, layout, {...options, mode: 'mask'}, this);
          this.composite(s, layer, alpha, op);
          pool.release(layer);
        }
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.textPC = null;
  }

  /** A boolean operation without result paths: its children's silhouettes combined with the
   *  operation's composite mode, then the boolean's fills through that mask. */
  private booleanFallback(s: Surface, node: SceneNode, world: Matrix, plan: Plan, t: Affine, alpha: number, op: GlobalCompositeOperation): void {
    if (!plan.fills.length) return;
    const device = this.deviceBounds(s, node, world);
    const area = device && intersect(device, s.clip);
    if (!area) return;
    const region = pixelRect(area);
    const mask = this.layer(region);
    const maskSurface = this.surfaceOf(mask, s);
    let first = true;
    for (const childId of node.children ?? []) {
      const child = this.doc.nodes[childId];
      if (!child || child.visible === false) continue;
      const childShape = shapeOf(child);
      const composite = first ? 'source-over' : BOOLEAN_OPS[node.booleanOperation ?? 'UNION'] ?? 'source-over';
      first = false;
      if (childShape && !isContainer(child)) {
        setTransform(mask.ctx, affineOf(maskSurface.base, worldOf(child, world)));
        mask.ctx.globalCompositeOperation = composite;
        mask.ctx.fillStyle = '#000';
        for (const part of childShape.parts) mask.ctx.fill(part.path, part.rule);
      } else {
        const sub = this.layer(region);
        this.node(this.surfaceOf(sub, s), child, world);
        mask.ctx.setTransform(1, 0, 0, 1, 0, 0);
        mask.ctx.globalCompositeOperation = composite;
        mask.ctx.drawImage(sub.canvas, 0, 0, sub.width, sub.height, 0, 0, sub.width, sub.height);
        pool.release(sub);
      }
    }
    const fill = this.layer(region);
    const ft: Affine = {...t, e: t.e - fill.x, f: t.f - fill.y};
    setTransform(fill.ctx, ft);
    const pc = this.paintContext(node, s.scale);
    for (const paint of plan.fills) if (this.applyPaint(fill.ctx, paint, pc, 1, 'source-over', false)) fill.ctx.fillRect(pc.region.x, pc.region.y, pc.region.width, pc.region.height);
    fill.ctx.setTransform(1, 0, 0, 1, 0, 0);
    fill.ctx.globalAlpha = 1;
    fill.ctx.globalCompositeOperation = 'destination-in';
    fill.ctx.drawImage(mask.canvas, 0, 0, mask.width, mask.height, 0, 0, mask.width, mask.height);
    pool.release(mask);
    this.composite(s, fill, alpha, op);
    pool.release(fill);
  }

  // ── Effects ──

  /** Draws the shadow of whatever `draw` paints, without painting it: the shape goes far to the
   *  right of the canvas and the shadow offset brings only its shadow back. */
  private cast(ctx: Ctx2D, t: Affine, canvasWidth: number, deviceLeft: number, effect: ShadowEffect, scale: number, alpha: number, draw: () => void): void {
    const dx = t.a * effect.offset.x + t.c * effect.offset.y;
    const dy = t.b * effect.offset.x + t.d * effect.offset.y;
    const big = Math.ceil(Math.max(0, canvasWidth - deviceLeft)) + 256;
    ctx.save();
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e + big, t.f);
    ctx.shadowColor = cssColor(effect.color);
    ctx.shadowBlur = Math.max(0, effect.radius) * scale;
    ctx.shadowOffsetX = dx - big;
    ctx.shadowOffsetY = dy;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blendOperation(effect.blendMode);
    ctx.fillStyle = '#000';
    draw();
    ctx.restore();
  }

  private dropShadows(s: Surface, node: SceneNode, world: Matrix, shape: NodeShape | null, plan: Plan, alpha: number): void {
    const t = affineOf(s.base, world);
    const maxBlur = Math.max(...plan.drops.map(e => e.radius)) * s.scale;
    const cacheable = maxBlur >= 2 && plan.drops.every(e => isNormalBlend(e.blendMode)) && (!plan.container || plan.caster !== 'content');
    if (cacheable) {
      const local = localRenderBounds({...node, effects: plan.drops});
      const rel = pixelRect(mapRect({...t, e: 0, f: 0}, local));
      if (rel.width * rel.height <= EFFECT_MAX_PIXELS && rel.width > 0 && rel.height > 0) {
        let entry = effectLookup(node.effects, node, s.scale, t);
        if (!entry) {
          const canvas = createCanvas(rel.width, rel.height);
          const ctx = context2d(canvas);
          resetContext(ctx);
          const tc: Affine = {a: t.a, b: t.b, c: t.c, d: t.d, e: -rel.x, f: -rel.y};
          const surface: Surface = {ctx, canvas, base: multiply(matrixOf(tc), invert(world)), scale: s.scale, clip: {x: 0, y: 0, width: rel.width, height: rel.height}};
          this.dropShadowsDirect(surface, node, world, shape, plan, 1);
          entry = {node, scale: s.scale, a: t.a, b: t.b, c: t.c, d: t.d, x: rel.x, y: rel.y, canvas, bytes: rel.width * rel.height * 4};
          effectStore(node.effects, entry);
        }
        s.ctx.setTransform(1, 0, 0, 1, 0, 0);
        s.ctx.globalAlpha = alpha;
        s.ctx.globalCompositeOperation = 'source-over';
        s.ctx.drawImage(entry.canvas, t.e + entry.x, t.f + entry.y);
        s.ctx.globalAlpha = 1;
        return;
      }
    }
    this.dropShadowsDirect(s, node, world, shape, plan, alpha);
  }

  private dropShadowsDirect(s: Surface, node: SceneNode, world: Matrix, shape: NodeShape | null, plan: Plan, alpha: number): void {
    const t = affineOf(s.base, world);
    const device = mapRect(t, {x: 0, y: 0, width: node.width, height: node.height});
    if (plan.caster === 'content' || !shape) {
      const reach = Math.max(...plan.drops.map(e => (Math.abs(e.offset.x) + Math.abs(e.offset.y) + blurReach(e.radius)) * s.scale));
      const body = this.bodyLayer(s, node, world, shape, plan, reach);
      if (!body) return;
      for (const effect of plan.drops) this.dropFromImage(s, body, effect, t, alpha, effect.showShadowBehindNode ? null : body);
      pool.release(body);
      return;
    }
    for (const effect of plan.drops) {
      const knock = !effect.showShadowBehindNode && !plan.opaqueCover;
      const path = plan.caster === 'geometry' ? spreadPath(node, shape, effect.spread) : null;
      if (path && (!knock || (shape.invertible && shape.parts.length === 1))) {
        s.ctx.save();
        if (knock) {
          setTransform(s.ctx, t);
          s.ctx.clip(this.inverse(shape, t, s.clip, 0), 'evenodd');
        }
        const rule = shape.parts[0].rule;
        this.cast(s.ctx, t, s.canvas.width, device.x - Math.abs(effect.spread) * s.scale, effect, s.scale, alpha, () => s.ctx.fill(path, rule));
        s.ctx.restore();
        continue;
      }
      // A silhouette canvas: the outline with its stroke band, grown or shrunk by the spread.
      const reach = (Math.abs(effect.offset.x) + Math.abs(effect.offset.y) + blurReach(effect.radius)) * s.scale;
      const out = strokeOutsets(node);
      const extra = Math.max(out.left, out.top, out.right, out.bottom) + Math.max(0, effect.spread);
      const area = intersect(mapRect(t, grow({x: 0, y: 0, width: node.width, height: node.height}, extra + 1)), grow(s.clip, reach));
      if (!area) continue;
      const caster = this.layer(pixelRect(area));
      this.silhouette(caster, node, shape, plan, t, effect.spread);
      let knockout: Layer | null = null;
      if (knock) {
        if (effect.spread) {
          knockout = this.layer(pixelRect(area));
          this.silhouette(knockout, node, shape, plan, t, 0);
        } else knockout = caster;
      }
      this.dropFromImage(s, caster, effect, t, alpha, knockout);
      if (knockout && knockout !== caster) pool.release(knockout);
      pool.release(caster);
    }
  }

  /** The opaque outline of a shape with its stroke band, grown (> 0) or shrunk by `spread`. */
  private silhouette(layer: Layer, node: SceneNode, shape: NodeShape, plan: Plan, t: Affine, spread: number): void {
    const ctx = layer.ctx;
    setTransform(ctx, {...t, e: t.e - layer.x, f: t.f - layer.y});
    ctx.fillStyle = ctx.strokeStyle = '#000';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (plan.fills.length) for (const part of shape.parts) ctx.fill(part.path, part.rule);
    let band = 0;
    if (plan.strokes.length) {
      band = shape.open || node.strokeAlign === 'CENTER' ? node.strokeWeight : node.strokeAlign === 'OUTSIDE' ? node.strokeWeight * 2 : 0;
      if (node.strokeAlign === 'INSIDE' && !plan.fills.length && !shape.open) {
        ctx.save();
        for (const part of shape.parts) ctx.clip(part.path, part.rule);
        this.setStrokeStyle(ctx, node, node.strokeWeight * 2, false);
        for (const part of shape.parts) ctx.stroke(part.path);
        ctx.restore();
      }
    }
    if (band > 0 || spread > 0) {
      this.setStrokeStyle(ctx, node, band + Math.max(0, spread) * 2, false);
      if (spread > 0) ctx.lineJoin = 'round';
      for (const part of shape.parts) ctx.stroke(part.path);
    }
    if (spread < 0) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineJoin = 'round';
      ctx.lineWidth = -spread * 2;
      ctx.setLineDash([]);
      for (const part of shape.parts) ctx.stroke(part.path);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /** The shadow of an image's alpha, optionally knocked out where `knockout` is opaque. */
  private dropFromImage(s: Surface, image: Layer, effect: ShadowEffect, t: Affine, alpha: number, knockout: Layer | null): void {
    const identity: Affine = {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0};
    const offset = {...effect, offset: {x: t.a * effect.offset.x + t.c * effect.offset.y, y: t.b * effect.offset.x + t.d * effect.offset.y}};
    if (!knockout) {
      this.cast(s.ctx, identity, s.canvas.width, image.x, offset, s.scale, alpha, () => s.ctx.drawImage(image.canvas, 0, 0, image.width, image.height, image.x, image.y, image.width, image.height));
      return;
    }
    const reach = Math.abs(offset.offset.x) + Math.abs(offset.offset.y) + blurReach(effect.radius) * s.scale;
    const area = intersect(grow({x: image.x, y: image.y, width: image.width, height: image.height}, reach), s.clip);
    if (!area) return;
    const shadow = this.layer(pixelRect(area));
    this.cast(shadow.ctx, identity, shadow.canvas.width, image.x - shadow.x, {...offset, blendMode: 'NORMAL'}, s.scale, 1, () =>
      shadow.ctx.drawImage(image.canvas, 0, 0, image.width, image.height, image.x - shadow.x, image.y - shadow.y, image.width, image.height));
    shadow.ctx.setTransform(1, 0, 0, 1, 0, 0);
    shadow.ctx.globalCompositeOperation = 'destination-out';
    shadow.ctx.drawImage(knockout.canvas, 0, 0, knockout.width, knockout.height, knockout.x - shadow.x, knockout.y - shadow.y, knockout.width, knockout.height);
    this.composite(s, shadow, alpha, blendOperation(effect.blendMode));
    pool.release(shadow);
  }

  private innerShadow(s: Surface, node: SceneNode, shape: NodeShape, plan: Plan, effect: ShadowEffect, t: Affine, alpha: number): void {
    const hole = spreadPath(node, shape, -effect.spread);
    if (hole && shape.parts.length === 1 && (effect.spread !== 0 || shape.invertible)) {
      const reach = Math.abs(effect.offset.x) + Math.abs(effect.offset.y) + blurReach(effect.radius) + Math.abs(effect.spread) + 2;
      const caster = new Path2D();
      caster.rect(-reach, -reach, node.width + 2 * reach, node.height + 2 * reach);
      caster.addPath(hole);
      const ctx = s.ctx;
      ctx.save();
      setTransform(ctx, t);
      ctx.clip(shape.parts[0].path, shape.parts[0].rule);
      const device = mapRect(t, grow({x: 0, y: 0, width: node.width, height: node.height}, reach));
      this.cast(ctx, t, s.canvas.width, device.x, effect, s.scale, alpha, () => ctx.fill(caster, 'evenodd'));
      ctx.restore();
      return;
    }
    const device = intersect(mapRect(t, {x: 0, y: 0, width: node.width, height: node.height}), s.clip);
    if (!device) return;
    const inside = this.layer(pixelRect(device));
    this.silhouette(inside, node, shape, {...plan, strokes: []}, t, -effect.spread);
    const outline = effect.spread ? this.layer(pixelRect(device)) : inside;
    if (outline !== inside) this.silhouette(outline, node, shape, {...plan, strokes: []}, t, 0);
    this.innerFromImage(s, inside, outline, effect, t, alpha);
    if (outline !== inside) pool.release(outline);
    pool.release(inside);
  }

  /** Inner shadow of an image's alpha: the shadow of everything outside `caster`, kept inside `clip`. */
  private innerFromImage(s: Surface, caster: Layer, clip: Layer, effect: ShadowEffect, t: Affine, alpha: number): void {
    const dx = t.a * effect.offset.x + t.c * effect.offset.y, dy = t.b * effect.offset.x + t.d * effect.offset.y;
    const reach = Math.ceil(Math.abs(dx) + Math.abs(dy) + blurReach(effect.radius) * s.scale + 2);
    // The complement of the caster, wide enough that its blurred, offset shadow covers the clip.
    const outside = this.layer({x: caster.x - reach, y: caster.y - reach, width: caster.width + 2 * reach, height: caster.height + 2 * reach});
    outside.ctx.fillStyle = '#000';
    outside.ctx.fillRect(0, 0, outside.width, outside.height);
    outside.ctx.globalCompositeOperation = 'destination-out';
    outside.ctx.drawImage(caster.canvas, 0, 0, caster.width, caster.height, reach, reach, caster.width, caster.height);
    outside.ctx.globalCompositeOperation = 'source-over';
    const shadow = this.layer({x: clip.x, y: clip.y, width: clip.width, height: clip.height});
    const identity: Affine = {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0};
    this.cast(shadow.ctx, identity, shadow.canvas.width, outside.x - shadow.x, {...effect, offset: {x: dx, y: dy}, blendMode: 'NORMAL'}, s.scale, 1, () =>
      shadow.ctx.drawImage(outside.canvas, 0, 0, outside.width, outside.height, outside.x - shadow.x, outside.y - shadow.y, outside.width, outside.height));
    pool.release(outside);
    shadow.ctx.setTransform(1, 0, 0, 1, 0, 0);
    shadow.ctx.globalCompositeOperation = 'destination-in';
    shadow.ctx.drawImage(clip.canvas, 0, 0, clip.width, clip.height, 0, 0, clip.width, clip.height);
    this.composite(s, shadow, alpha, blendOperation(effect.blendMode));
    pool.release(shadow);
  }

  /** The node's body (fills, children, strokes) in a layer, for shadows cast by what it shows. */
  private bodyLayer(s: Surface, node: SceneNode, world: Matrix, shape: NodeShape | null, plan: Plan, margin: number): Layer | null {
    const device = this.deviceBounds(s, node, world);
    const area = device && intersect(device, grow(s.clip, margin));
    if (!area) return null;
    const layer = this.layer(pixelRect(area));
    this.body(this.surfaceOf(layer, s), node, world, shape, plan, 1, 'source-over', false);
    return layer;
  }

  /** Blurs what is already painted under the shape (Figma's background blur), before the fills. */
  private backgroundBlur(s: Surface, node: SceneNode, world: Matrix, shape: NodeShape, radius: number): void {
    const t = affineOf(s.base, world);
    const area = intersect(mapRect(t, {x: 0, y: 0, width: node.width, height: node.height}), s.clip);
    if (!area) return;
    const sigma = (radius / 2) * s.scale;
    const region = pixelRect(area);
    const sample = intersect(grow(region, Math.ceil(3 * sigma)), {x: 0, y: 0, width: s.canvas.width, height: s.canvas.height});
    if (!sample) return;
    const copy = this.layer(pixelRect(sample));
    copy.ctx.drawImage(s.canvas, copy.x, copy.y, copy.width, copy.height, 0, 0, copy.width, copy.height);
    blurCanvas(copy.canvas, copy.width, copy.height, sigma, pool);
    const ctx = s.ctx;
    ctx.save();
    setTransform(ctx, t);
    ctx.clip(shape.parts[0].path, shape.parts[0].rule);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(copy.canvas, 0, 0, copy.width, copy.height, copy.x, copy.y, copy.width, copy.height);
    ctx.restore();
    pool.release(copy);
  }

  // ── Outlines and grids ──

  private outline(s: Surface, node: SceneNode, world: Matrix): void {
    const t = affineOf(s.base, world);
    const ctx = s.ctx;
    setTransform(ctx, t);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = '#1E1E1E';
    ctx.lineWidth = 1 / Math.max(s.scale, 1e-6);
    ctx.lineJoin = 'miter';
    ctx.setLineDash([]);
    if (node.type === 'TEXT') ctx.strokeRect(0, 0, node.width, node.height);
    else if (node.type !== 'GROUP' && node.type !== 'BOOLEAN_OPERATION') {
      const shape = shapeOf(node);
      if (shape) for (const part of shape.parts) ctx.stroke(part.path);
    }
    if (isContainer(node) || node.type === 'BOOLEAN_OPERATION') this.children(s, node, world);
  }

  private grids(ctx: Ctx2D, node: SceneNode, t: Affine, scale: number): void {
    ctx.save();
    setTransform(ctx, t);
    ctx.beginPath();
    ctx.rect(0, 0, node.width, node.height);
    ctx.clip();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const grid of node.layoutGrids ?? []) {
      if (grid.visible === false) continue;
      if (grid.pattern === 'GRID') {
        const {xs, ys} = gridLines(grid.sectionSize, node.width, node.height);
        ctx.strokeStyle = cssColor(grid.color);
        ctx.lineWidth = 1 / Math.max(scale, 1e-6);
        ctx.beginPath();
        for (const x of xs) { ctx.moveTo(x, 0); ctx.lineTo(x, node.height); }
        for (const y of ys) { ctx.moveTo(0, y); ctx.lineTo(node.width, y); }
        ctx.stroke();
      } else {
        ctx.fillStyle = cssColor(grid.color);
        for (const band of gridBands(grid, node.width, node.height)) ctx.fillRect(band.x, band.y, band.width, band.height);
      }
    }
    ctx.restore();
  }
}

/** The node's box with its stroke, without effects (a container's own part of its bounds). */
function ownBox(node: SceneNode): Rect {
  const out = strokeOutsets(node);
  return {x: -out.left, y: -out.top, width: Math.max(0, node.width) + out.left + out.right, height: Math.max(0, node.height) + out.top + out.bottom};
}

/** Paints `rootIds` (with their subtrees, in the given order) into `target`. Roots keep their world
 *  transform but none of their ancestors' opacity, clips or masks; pass a page id to paint a page. */
export function paintNodeTree(target: PaintTarget, doc: DesignDocument, rootIds: readonly NodeId[], options: PaintOptions): void {
  const canvas = target.ctx.canvas as Surface['canvas'];
  const surface: Surface = {
    ctx: target.ctx,
    canvas,
    base: target.transform,
    scale: target.scale,
    clip: options.clip ?? {x: 0, y: 0, width: canvas.width, height: canvas.height},
    ...(options.cull ? {cull: options.cull} : {}),
  };
  const ctx = target.ctx;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if ('textRendering' in ctx) (ctx as CanvasRenderingContext2D).textRendering = 'geometricPrecision';
  new Painter(doc, options).paintRoots(surface, rootIds);
  ctx.restore();
}
