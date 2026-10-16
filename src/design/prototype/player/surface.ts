import type {DesignDocument, Matrix, NodeId, SceneNode, Vec, VectorPath} from '../../../../shared/design/types';
import {invert, multiply, scaling, transformRect, translation, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {renderBounds} from '../../../../shared/design/bounds';
import {cornerRadiiOf} from '../../../../shared/design/shapes';
import {paintChildren} from '../../../../shared/design/tree';
import {clampScroll, contentBounds, intersectRect, isScrollContainer, maxScroll, placedMatrix, scrollShift, type ScrollOffsets, type Size} from '../../../../shared/design/prototype';
import type {FontRegistry, ImageCache} from '../../engine/contracts';
import {context2d, createCanvas, type AnyCanvas, type Ctx2D} from '../../engine/render/canvas';
import {paintNodeTree} from '../../engine/render/painter';

// One frame as the player shows it (a screen or an overlay), drawn from bitmaps so that scrolling and
// transitions only composite: each scroll container's content is cached in 512 px tiles painted once
// by `paintNodeTree` (the canvas's own painter), "Fixed" and "Sticky" children are bitmaps of
// their own, and a frame is redrawn only when its document, its scale or its pictures change.

export type PaintDeps = {
  fonts: FontRegistry;
  images: ImageCache;
  booleanGeometry?: (doc: DesignDocument, id: NodeId) => readonly VectorPath[] | null;
};

const TILE = 512;
/** A sprite larger than this many pixels is painted at a lower resolution and drawn scaled. */
const MAX_SPRITE_PIXELS = 4096 * 4096;
const ZERO: Vec = {x: 0, y: 0};
const NO_IDS: ReadonlySet<NodeId> = new Set();
const FRAME_LIKE = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

export const setMatrix = (ctx: Ctx2D, m: Matrix) => ctx.setTransform(m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]);

/** Whole device pixels for an unrotated, unscaled-by-fraction placement (no soft bitmaps). */
function snapped(m: Matrix): Matrix {
  if (Math.abs(m[0][1]) > 1e-9 || Math.abs(m[1][0]) > 1e-9) return m;
  return [[m[0][0], 0, Math.round(m[0][2])], [0, m[1][1], Math.round(m[1][2])]];
}

// ── Sprites ──────────────────────────────────────────────────────────────────────────────────────

/** A painted bitmap of some layers in a local space: `bounds` is the local area it covers. */
export type Sprite = {canvas: AnyCanvas; bounds: Rect; scale: number};

/** Paints `rootIds` into a bitmap of the local `bounds` (`toLocal` maps page space to that local space). */
export function renderSprite(doc: DesignDocument, rootIds: readonly NodeId[], toLocal: Matrix, bounds: Rect, scale: number, deps: PaintDeps, hidden: ReadonlySet<NodeId> = NO_IDS): Sprite | null {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return null;
  let k = scale;
  const pixels = bounds.width * k * bounds.height * k;
  if (pixels > MAX_SPRITE_PIXELS) k *= Math.sqrt(MAX_SPRITE_PIXELS / pixels);
  const width = Math.ceil(bounds.width * k), height = Math.ceil(bounds.height * k);
  if (width < 1 || height < 1) return null;
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  const transform = multiply(multiply(scaling(k, k), translation(-bounds.x, -bounds.y)), toLocal);
  paintNodeTree({ctx, transform, scale: k}, doc, rootIds, {images: deps.images, fonts: deps.fonts, booleanGeometry: deps.booleanGeometry, hidden, paintHiddenRoots: false});
  return {canvas, bounds, scale: k};
}

/** A node's subtree as a sprite in the node's own space (smart animate, fixed children). */
export function nodeSprite(doc: DesignDocument, id: NodeId, scale: number, deps: PaintDeps, hidden: ReadonlySet<NodeId> = NO_IDS): Sprite | null {
  const node = doc.nodes[id];
  if (!node || node.visible === false) return null;
  const world = worldMatrix(doc, id);
  const toLocal = invert(world);
  const page = renderBounds(doc, id, {measurer: deps.fonts.measurer});
  if (!page) return null;
  return renderSprite(doc, [id], toLocal, padded(transformRect(toLocal, page)), scale, deps, hidden);
}

const padded = (r: Rect): Rect => ({x: Math.floor(r.x) - 1, y: Math.floor(r.y) - 1, width: Math.ceil(r.width) + 3, height: Math.ceil(r.height) + 3});

/** Draws a sprite whose local space maps to device px by `m`. */
export function drawSprite(ctx: Ctx2D, sprite: Sprite, m: Matrix, alpha = 1): void {
  if (alpha <= 0) return;
  setMatrix(ctx, snapped(multiply(multiply(m, translation(sprite.bounds.x, sprite.bounds.y)), scaling(1 / sprite.scale, 1 / sprite.scale))));
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = previous * Math.min(1, alpha);
  ctx.drawImage(sprite.canvas, 0, 0);
  ctx.globalAlpha = previous;
}

// ── Tiles ────────────────────────────────────────────────────────────────────────────────────────

class TiledLayer {
  private readonly tiles = new Map<string, AnyCanvas | null>();

  constructor(
    /** Paints the layer with `transform` mapping its local space to the tile's pixels. */
    private readonly paint: (ctx: Ctx2D, transform: Matrix) => void,
    private readonly origin: Vec,
    private readonly scale: number,
  ) {}

  /** Draws the tiles covering the local rectangle `visible`; `m` maps local space to device px. */
  draw(ctx: Ctx2D, m: Matrix, visible: Rect) {
    const {origin, scale} = this;
    const i0 = Math.floor(((visible.x - origin.x) * scale) / TILE), i1 = Math.floor(((visible.x + visible.width - origin.x) * scale - 0.01) / TILE);
    const j0 = Math.floor(((visible.y - origin.y) * scale) / TILE), j1 = Math.floor(((visible.y + visible.height - origin.y) * scale - 0.01) / TILE);
    setMatrix(ctx, snapped(multiply(multiply(m, translation(origin.x, origin.y)), scaling(1 / scale, 1 / scale))));
    for (let j = Math.max(0, j0); j <= j1; j++) {
      for (let i = Math.max(0, i0); i <= i1; i++) {
        const tile = this.tile(i, j);
        if (tile) ctx.drawImage(tile, i * TILE, j * TILE);
      }
    }
  }

  private tile(i: number, j: number): AnyCanvas | null {
    const key = i + ':' + j;
    if (this.tiles.has(key)) return this.tiles.get(key)!;
    const canvas = createCanvas(TILE, TILE);
    const ctx = context2d(canvas);
    this.paint(ctx, multiply(multiply(translation(-i * TILE, -j * TILE), scaling(this.scale, this.scale)), translation(-this.origin.x, -this.origin.y)));
    this.tiles.set(key, canvas);
    return canvas;
  }

  /** Takes over another layer's tiles (same origin and scale) except those meeting a `dirty` local
   *  rectangle: an edit inside one instance repaints only the tiles under it. */
  adopt(other: TiledLayer, dirty: readonly Rect[]): boolean {
    if (other.scale !== this.scale || other.origin.x !== this.origin.x || other.origin.y !== this.origin.y) return false;
    const size = TILE / this.scale;
    for (const [key, tile] of other.tiles) {
      const [i, j] = key.split(':').map(Number);
      const rect = {x: this.origin.x + i * size, y: this.origin.y + j * size, width: size, height: size};
      if (dirty.some(area => intersectRect(rect, area))) continue;
      this.tiles.set(key, tile);
      other.tiles.delete(key);
    }
    return true;
  }

  /** Paints the tiles of a local rectangle now (before they scroll into view). */
  warm(visible: Rect, budget: number): number {
    const {origin, scale} = this;
    let painted = 0;
    const i0 = Math.max(0, Math.floor(((visible.x - origin.x) * scale) / TILE)), i1 = Math.floor(((visible.x + visible.width - origin.x) * scale - 0.01) / TILE);
    const j0 = Math.max(0, Math.floor(((visible.y - origin.y) * scale) / TILE)), j1 = Math.floor(((visible.y + visible.height - origin.y) * scale - 0.01) / TILE);
    for (let j = j0; j <= j1 && painted < budget; j++) for (let i = i0; i <= i1 && painted < budget; i++) {
      if (this.tiles.has(i + ':' + j)) continue;
      this.tile(i, j);
      painted++;
    }
    return painted;
  }

  dispose() {
    for (const tile of this.tiles.values()) if (tile) tile.width = tile.height = 1;
    this.tiles.clear();
  }
}

// ── Scroll containers ────────────────────────────────────────────────────────────────────────────

type Container = {
  id: NodeId;
  node: SceneNode;
  isRoot: boolean;
  /** The visible part, local units. */
  view: Size;
  max: Vec;
  layer: TiledLayer;
  content: Rect;
  /** Fixed and sticky children: bitmaps in the container's space, drawn over the scrolling content. */
  separate: {node: SceneNode; sprite: Sprite | null}[];
  /** Scroll containers inside, with their placement in this container's content at no scroll. */
  nested: {container: Container; chain: Matrix}[];
};

/** What a new surface may take over from the one it replaces: `changed` lists the layers whose
 *  pictures differ (with their subtrees) between the old document and the new one. */
export type SurfaceReuse = {from: Surface; changed: readonly NodeId[]};

export type SurfaceOptions = {
  /** The visible part of the root, root units (the screen for a screen, its own box for an overlay). */
  view: Size;
  /** Device px per root unit. */
  scale: number;
  /** Not drawn (an instance smart animate draws itself). */
  hidden?: ReadonlySet<NodeId>;
  /** Draw the root's shadows and blurs outside its box too (an overlay over a screen). */
  effects?: boolean;
};

export class Surface {
  readonly root: Container | null;
  readonly view: Size;
  readonly scale: number;
  private readonly hidden: ReadonlySet<NodeId>;
  /** A root whose content scrolls past its own box keeps its background still. */
  private background: Sprite | null = null;
  /** The root's own painting with its effects, unclipped (overlays). */
  private outside: Sprite | null = null;
  private disposed = false;

  private readonly reuse: SurfaceReuse | null;

  constructor(readonly doc: DesignDocument, readonly rootId: NodeId, private readonly deps: PaintDeps, options: SurfaceOptions, reuse?: SurfaceReuse) {
    this.view = options.view;
    this.scale = options.scale;
    this.hidden = options.hidden ?? NO_IDS;
    const from = reuse?.from;
    this.reuse = from && from.rootId === rootId && from.scale === this.scale && from.view.width === this.view.width && from.view.height === this.view.height ? reuse : null;
    this.root = doc.nodes[rootId] ? this.container(rootId, true) : null;
    const node = doc.nodes[rootId];
    if (options.effects && node?.effects.some(effect => effect.visible !== false)) {
      this.outside = this.reuse && !this.reuse.changed.includes(rootId) ? this.reuse.from.take('outside') : null;
      this.outside ??= nodeSprite(doc, rootId, this.scale, deps, new Set([...this.hidden, ...(node.children ?? [])]));
    }
    this.reuse = null;
  }

  /** Hands a still sprite to the surface that replaces this one. */
  private take(which: 'outside' | 'background'): Sprite | null {
    const sprite = this[which];
    this[which] = null;
    return sprite;
  }

  /** Local rectangles of a container that the changed layers covered before or cover now. */
  private dirtyIn(containerId: NodeId): Rect[] {
    const reuse = this.reuse;
    if (!reuse) return [];
    const out: Rect[] = [];
    for (const doc of [reuse.from.doc, this.doc]) {
      if (!doc.nodes[containerId]) continue;
      const toLocal = invert(worldMatrix(doc, containerId));
      for (const id of reuse.changed) {
        const page = doc.nodes[id] && renderBounds(doc, id, {measurer: this.deps.fonts.measurer});
        if (page) out.push(padded(transformRect(toLocal, page)));
      }
    }
    return out;
  }

  /** Whether a changed layer is `id` or inside it (in either document). */
  private touches(id: NodeId): boolean {
    const reuse = this.reuse;
    if (!reuse) return true;
    return reuse.changed.some(changed => [reuse.from.doc, this.doc].some(doc => {
      for (let node = doc.nodes[changed], guard = 0; node && guard < 10_000; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) if (node.id === id) return true;
      return false;
    }));
  }

  private container(id: NodeId, isRoot: boolean): Container {
    const {doc} = this;
    const node = doc.nodes[id]!;
    const view = isRoot ? this.view : {width: node.width, height: node.height};
    const max = maxScroll(doc, id, view, isRoot);
    const scrolls = max.x > 0 || max.y > 0;
    const separate = scrolls ? (node.children ?? []).map(child => doc.nodes[child]).filter((child): child is SceneNode => !!child && child.visible !== false && (child.scrollBehavior === 'FIXED' || child.scrollBehavior === 'STICKY_SCROLLS')) : [];
    const hidden = new Set<NodeId>([...this.hidden, ...separate.map(child => child.id)]);
    const nested: Container['nested'] = [];
    // Scroll containers further down scroll on their own: their children leave this layer.
    const stack = (node.children ?? []).filter(child => !hidden.has(child));
    while (stack.length) {
      const child = doc.nodes[stack.pop()!];
      if (!child || child.visible === false || this.hidden.has(child.id)) continue;
      if (child.children && child.type !== 'BOOLEAN_OPERATION' && isScrollContainer(doc, child.id, {width: child.width, height: child.height})) {
        nested.push({container: this.container(child.id, false), chain: placedMatrix(doc, id, child.id, {})!});
        for (const grandchild of child.children) hidden.add(grandchild);
        continue;
      }
      if (child.children && child.type !== 'BOOLEAN_OPERATION') stack.push(...child.children);
    }
    const toLocal = invert(worldMatrix(doc, id));
    // A root that only scrolls because it is taller than the screen scrolls its background along;
    // one whose children reach past its box keeps the box still and scrolls the children.
    const backgroundStill = isRoot && scrolls && node.height <= this.view.height + 0.5 && node.width <= this.view.width + 0.5;
    const ownPainted = isRoot && !backgroundStill;
    const roots = ownPainted ? [id] : [...paintChildren(node)].filter(child => !hidden.has(child));
    const previous = this.reuse?.from.find(id) ?? null;
    if (backgroundStill) {
      const all = new Set<NodeId>([...this.hidden, ...(node.children ?? [])]);
      if (this.reuse && !this.reuse.changed.includes(id)) this.background = this.reuse.from.take('background');
      this.background ??= renderSprite(doc, [id], toLocal, {x: 0, y: 0, width: node.width, height: node.height}, this.scale, this.deps, all);
    }
    const content = contentBounds(doc, id);
    const deps = this.deps;
    const layer = new TiledLayer(
      (ctx, transform) => paintNodeTree({ctx, transform: multiply(transform, toLocal), scale: this.scale}, doc, roots, {images: deps.images, fonts: deps.fonts, booleanGeometry: deps.booleanGeometry, hidden}),
      {x: Math.min(0, content.x), y: Math.min(0, content.y)},
      this.scale,
    );
    // Same structure as the surface this one replaces: keep every tile and bitmap the change did not touch.
    const sameShape = !!previous && previous.max.x === max.x && previous.max.y === max.y && previous.view.width === view.width && previous.view.height === view.height
      && previous.nested.map(each => each.container.id).join() === nested.map(each => each.container.id).join()
      && previous.separate.map(each => each.node.id).join() === separate.map(each => each.id).join();
    if (previous && sameShape) layer.adopt(previous.layer, this.dirtyIn(id));
    return {
      id, node, isRoot, view, max, layer, content,
      separate: separate.map(child => {
        const old = sameShape ? previous!.separate.find(each => each.node.id === child.id) : undefined;
        if (old?.sprite && !this.touches(child.id) && old.node === child) {
          const sprite = old.sprite;
          old.sprite = null;
          return {node: child, sprite};
        }
        return {node: child, sprite: renderSprite(doc, [child.id], toLocal, padded(childBounds(doc, child, toLocal, deps)), this.scale, deps, this.hidden)};
      }),
      nested,
    };
  }

  /** How far a container of this surface scrolls. */
  maxScroll(id: NodeId): Vec {
    const found = this.find(id);
    return found ? found.max : ZERO;
  }

  find(id: NodeId, from: Container | null = this.root): Container | null {
    if (!from) return null;
    if (from.id === id) return from;
    for (const {container} of from.nested) {
      const found = this.find(id, container);
      if (found) return found;
    }
    return null;
  }

  /** Scroll containers under a root-space point, innermost first. */
  containersAt(point: Vec, scroll: ScrollOffsets): NodeId[] {
    const out: NodeId[] = [];
    const visit = (container: Container, m: Matrix) => {
      const inverse = invert(m);
      const local = {x: inverse[0][0] * point.x + inverse[0][1] * point.y + inverse[0][2], y: inverse[1][0] * point.x + inverse[1][1] * point.y + inverse[1][2]};
      if (local.x < 0 || local.y < 0 || local.x > container.view.width || local.y > container.view.height) return;
      if (container.max.x > 0 || container.max.y > 0) out.unshift(container.id);
      const offset = scroll[container.id] ?? ZERO;
      for (const {container: inner, chain} of container.nested) visit(inner, multiply(multiply(m, translation(-offset.x, -offset.y)), chain));
    };
    if (this.root) visit(this.root, [[1, 0, 0], [0, 1, 0]]);
    return out;
  }

  /** Clamps every offset to its container's range. */
  clamp(scroll: ScrollOffsets): ScrollOffsets {
    let out: Record<NodeId, Vec> | null = null;
    for (const [id, offset] of Object.entries(scroll)) {
      const clamped = clampScroll(offset, this.maxScroll(id));
      if (clamped !== offset) (out ??= {...scroll})[id] = clamped;
    }
    return out ?? scroll;
  }

  /** Draws the surface; `base` maps root units to the context's device px. */
  draw(ctx: Ctx2D, base: Matrix, scroll: ScrollOffsets): void {
    if (!this.root || this.disposed) return;
    ctx.save();
    if (this.outside) drawSprite(ctx, this.outside, base);
    if (this.background) drawSprite(ctx, this.background, base);
    this.drawContainer(ctx, this.root, base, scroll);
    ctx.restore();
  }

  private drawContainer(ctx: Ctx2D, container: Container, m: Matrix, scroll: ScrollOffsets) {
    const offset = clampScroll(scroll[container.id] ?? ZERO, container.max);
    ctx.save();
    setMatrix(ctx, m);
    ctx.beginPath();
    const radii = container.isRoot ? null : cornerRadiiOf(container.node);
    if (radii && radii.some(r => r > 0) && 'roundRect' in ctx) ctx.roundRect(0, 0, container.view.width, container.view.height, radii);
    else ctx.rect(0, 0, container.view.width, container.view.height);
    ctx.clip();
    const scrolled = multiply(m, translation(-offset.x, -offset.y));
    container.layer.draw(ctx, scrolled, {x: offset.x, y: offset.y, width: container.view.width, height: container.view.height});
    for (const {container: inner, chain} of container.nested) this.drawContainer(ctx, inner, multiply(scrolled, chain), scroll);
    for (const {node, sprite} of container.separate) {
      if (!sprite) continue;
      const shift = scrollShift(node, offset);
      drawSprite(ctx, sprite, multiply(m, translation(shift.x, shift.y)));
    }
    ctx.restore();
  }

  /** Paints the tiles a scroll could reveal next, a few at a time (call when idle). */
  warm(scroll: ScrollOffsets, budget = 2): number {
    let painted = 0;
    const visit = (container: Container) => {
      if (painted >= budget) return;
      const offset = clampScroll(scroll[container.id] ?? ZERO, container.max);
      const margin = {x: offset.x - container.view.width / 2, y: offset.y - container.view.height / 2, width: container.view.width * 2, height: container.view.height * 2};
      painted += container.layer.warm(margin, budget - painted);
      for (const {container: inner} of container.nested) visit(inner);
    };
    if (this.root) visit(this.root);
    return painted;
  }

  /** The surface as one bitmap at its scale (transitions animate these). */
  snapshot(scroll: ScrollOffsets): AnyCanvas {
    const canvas = createCanvas(Math.max(1, Math.round(this.view.width * this.scale)), Math.max(1, Math.round(this.view.height * this.scale)));
    const ctx = context2d(canvas);
    this.draw(ctx, scaling(this.scale, this.scale), scroll);
    return canvas;
  }

  /** Root-space rectangle a node is seen through: its clipping ancestors and the surface's view. */
  clipOf(id: NodeId, scroll: ScrollOffsets): Rect | null {
    const {doc} = this;
    let clip: Rect | null = {x: 0, y: 0, width: this.view.width, height: this.view.height};
    for (let node = doc.nodes[doc.nodes[id]?.parentId ?? ''], guard = 0; node && node.id !== this.rootId && clip && guard < 10_000; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) {
      if (!FRAME_LIKE.has(node.type) || node.clipsContent === false) continue;
      const m = placedMatrix(doc, this.rootId, node.id, scroll);
      if (m) clip = intersectRect(clip, transformRect(m, {x: 0, y: 0, width: node.width, height: node.height}));
    }
    return clip;
  }

  dispose() {
    this.disposed = true;
    const visit = (container: Container | null) => {
      if (!container) return;
      container.layer.dispose();
      for (const {sprite} of container.separate) if (sprite) sprite.canvas.width = sprite.canvas.height = 1;
      for (const {container: inner} of container.nested) visit(inner);
    };
    visit(this.root);
    for (const sprite of [this.background, this.outside]) if (sprite) sprite.canvas.width = sprite.canvas.height = 1;
  }
}

function childBounds(doc: DesignDocument, child: SceneNode, toLocal: Matrix, deps: PaintDeps): Rect {
  const page = renderBounds(doc, child.id, {measurer: deps.fonts.measurer});
  return page ? transformRect(toLocal, page) : {x: child.x, y: child.y, width: child.width, height: child.height};
}
