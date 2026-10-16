import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {localMatrix, multiply, scaling, translation} from '../../../../shared/design/geometry';
import {cornerRadiiOf} from '../../../../shared/design/shapes';
import {interpolateNode, lerp, lerpAngle, sameOwnLook, scrollShift, type MorphNode, type ScrollOffsets} from '../../../../shared/design/prototype';
import type {Ctx2D} from '../../engine/render/canvas';
import {paintNodeTree} from '../../engine/render/painter';
import {drawSprite, nodeSprite, setMatrix, type PaintDeps, type Sprite} from './surface';

// "Smart animate" on the player's canvas. The plan (shared/design/prototype.ts) pairs the layers of
// two frames by name; here every layer that only moves is a bitmap painted once and moved by its
// transform, a layer whose own look changes (size, radius, colour) is repainted alone from the
// interpolated node each frame, and unmatched layers fade. Children follow their parent, so a card
// that grows carries its contents along.

export type SmartSide = {
  doc: DesignDocument;
  rootId: NodeId;
  scroll: ScrollOffsets;
  /** The root's space → the surface's root space (identity for a screen; an instance's placement). */
  place: Matrix;
};

const FRAME_LIKE = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
const ZERO: Vec = {x: 0, y: 0};
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const opacityOf = (node: SceneNode) => (node.visible === false ? 0 : node.opacity);

// Sprites outlive one animation (hovering back and forth reuses them), within a pixel budget.
const SPRITE_BUDGET = 96 * 1024 * 1024;
const spriteCache = new Map<string, {sprite: Sprite | null; pixels: number}>();
const docIds = new WeakMap<DesignDocument, number>();
let nextDocId = 1;
let cachedPixels = 0;
const docKey = (doc: DesignDocument) => {
  let id = docIds.get(doc);
  if (!id) docIds.set(doc, (id = nextDocId++));
  return id;
};

/** A node's subtree painted opaque and visible (its opacity is applied when drawn), cached. */
function opaqueSprite(doc: DesignDocument, id: NodeId, scale: number, deps: PaintDeps, own = false): Sprite | null {
  const key = `${docKey(doc)}|${id}|${scale}|${own ? 1 : 0}`;
  const cached = spriteCache.get(key);
  if (cached) {
    spriteCache.delete(key);
    spriteCache.set(key, cached);
    return cached.sprite;
  }
  const node = doc.nodes[id];
  if (!node) return null;
  const nodes = Object.create(doc.nodes) as Record<NodeId, SceneNode>;
  nodes[id] = {...node, opacity: 1, visible: true};
  const sprite = nodeSprite({...doc, nodes}, id, scale, deps, own ? new Set(node.children ?? []) : undefined);
  const pixels = sprite ? sprite.canvas.width * sprite.canvas.height : 0;
  spriteCache.set(key, {sprite, pixels});
  cachedPixels += pixels;
  for (const [oldKey, entry] of spriteCache) {
    if (cachedPixels <= SPRITE_BUDGET) break;
    spriteCache.delete(oldKey);
    cachedPixels -= entry.pixels;
  }
  return sprite;
}

export class SmartAnimation {
  /** Nodes painted per frame (their interpolated copy) go into this table over the destination's. */
  private readonly scratch: Record<NodeId, SceneNode>;
  private readonly scratchDoc: DesignDocument;

  constructor(
    private readonly a: SmartSide,
    private readonly b: SmartSide,
    private readonly plan: MorphNode,
    private readonly scale: number,
    private readonly deps: PaintDeps,
  ) {
    this.scratch = Object.create(b.doc.nodes) as Record<NodeId, SceneNode>;
    this.scratchDoc = {...b.doc, nodes: this.scratch};
  }

  /** Paints every bitmap the animation needs now, so its frames only composite. */
  prepare(): void {
    const visit = (item: MorphNode, root: boolean) => {
      const na = item.a ? this.a.doc.nodes[item.a] : undefined, nb = item.b ? this.b.doc.nodes[item.b] : undefined;
      if (item.mode === 'same' && nb) opaqueSprite(this.b.doc, nb.id, this.scale, this.deps);
      else if (item.mode === 'in' && nb) opaqueSprite(this.b.doc, nb.id, this.scale, this.deps);
      else if (item.mode === 'out' && na) opaqueSprite(this.a.doc, na.id, this.scale, this.deps);
      else if (item.mode === 'crossfade') {
        if (na) opaqueSprite(this.a.doc, na.id, this.scale, this.deps);
        if (nb) opaqueSprite(this.b.doc, nb.id, this.scale, this.deps);
      } else if (item.mode === 'morph' && na && nb && this.ownStill(na, nb, root)) opaqueSprite(this.b.doc, nb.id, this.scale, this.deps, true);
      for (const child of item.children) visit(child, false);
    };
    visit(this.plan, true);
  }

  private ownStill(a: SceneNode, b: SceneNode, root: boolean) {
    return !root && a.width === b.width && a.height === b.height && sameOwnLook(a, b, false);
  }

  /** Draws the state `t` of the way (eased; may overshoot). `base` maps the surface's root space to device px. */
  draw(ctx: Ctx2D, base: Matrix, t: number): void {
    const root = this.plan;
    const na = root.a ? this.a.doc.nodes[root.a] : undefined, nb = root.b ? this.b.doc.nodes[root.b] : undefined;
    if (!na || !nb) return;
    const m = lerpPlacement(this.a.place, this.b.place, t);
    ctx.save();
    if (root.mode === 'morph') this.morph(ctx, base, root, na, nb, m, 1, t, true);
    else this.pictures(ctx, base, root.mode, na, nb, m, 1, t);
    ctx.restore();
  }

  private morph(ctx: Ctx2D, base: Matrix, item: MorphNode, a: SceneNode, b: SceneNode, m: Matrix, parentAlpha: number, t: number, root: boolean) {
    const alpha = parentAlpha * clamp01(lerp(opacityOf(a), opacityOf(b), t));
    if (alpha <= 0.001 && !item.children.length) return;
    const node = interpolateNode({...a, visible: true}, {...b, visible: true}, t);
    if (this.ownStill(a, b, root)) {
      const sprite = opaqueSprite(this.b.doc, b.id, this.scale, this.deps, true);
      if (sprite) drawSprite(ctx, sprite, multiply(base, m), alpha);
    } else {
      // The node alone, at the origin of its own space: `m` places it.
      const own: SceneNode = {...node, x: 0, y: 0, rotation: 0, opacity: 1, visible: true, parentId: null};
      this.scratch[b.id] = own;
      paintNodeTree({ctx, transform: multiply(base, m), scale: this.scale}, this.scratchDoc, [b.id], {
        images: this.deps.images, fonts: this.deps.fonts, booleanGeometry: this.deps.booleanGeometry, hidden: new Set(b.children ?? []), rootOpacity: alpha,
      });
      delete this.scratch[b.id];
    }
    if (!item.children.length) return;
    ctx.save();
    if (FRAME_LIKE.has(b.type) && b.clipsContent !== false) {
      setMatrix(ctx, multiply(base, m));
      ctx.beginPath();
      const radii = cornerRadiiOf(node);
      if (radii.some(r => r > 0) && 'roundRect' in ctx) ctx.roundRect(0, 0, node.width, node.height, radii);
      else ctx.rect(0, 0, node.width, node.height);
      ctx.clip();
    }
    const scrollA = this.a.scroll[a.id] ?? ZERO, scrollB = this.b.scroll[b.id] ?? ZERO;
    for (const child of item.children) this.child(ctx, base, child, m, scrollA, scrollB, alpha, t);
    ctx.restore();
  }

  private child(ctx: Ctx2D, base: Matrix, item: MorphNode, parent: Matrix, scrollA: Vec, scrollB: Vec, parentAlpha: number, t: number) {
    const a = item.a ? this.a.doc.nodes[item.a] : undefined, b = item.b ? this.b.doc.nodes[item.b] : undefined;
    const fade = clamp01(t);
    if (item.mode === 'in' || item.mode === 'out') {
      const node = item.mode === 'in' ? b : a;
      if (!node) return;
      const shift = scrollShift(node, item.mode === 'in' ? scrollB : scrollA);
      const sprite = opaqueSprite(item.mode === 'in' ? this.b.doc : this.a.doc, node.id, this.scale, this.deps);
      if (sprite) drawSprite(ctx, sprite, multiply(base, multiply(parent, multiply(translation(shift.x, shift.y), localMatrix(node)))), parentAlpha * opacityOf(node) * (item.mode === 'in' ? fade : 1 - fade));
      return;
    }
    if (!a || !b) return;
    const shiftA = scrollShift(a, scrollA), shiftB = scrollShift(b, scrollB);
    const local = multiply(translation(lerp(shiftA.x, shiftB.x, t), lerp(shiftA.y, shiftB.y, t)), localMatrix({
      x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), rotation: lerpAngle(a.rotation || 0, b.rotation || 0, t),
      width: Math.max(0, lerp(a.width, b.width, t)), height: Math.max(0, lerp(a.height, b.height, t)), flipX: b.flipX, flipY: b.flipY,
    }));
    const m = multiply(parent, local);
    if (item.mode === 'morph') {
      this.morph(ctx, base, item, a, b, m, parentAlpha, t, false);
      return;
    }
    this.pictures(ctx, base, item.mode, a, b, m, parentAlpha, t);
  }

  /** A layer that moves as one picture (`same`), or two pictures fading into each other (`crossfade`). */
  private pictures(ctx: Ctx2D, base: Matrix, mode: MorphNode['mode'], a: SceneNode, b: SceneNode, m: Matrix, parentAlpha: number, t: number) {
    const alpha = parentAlpha * clamp01(lerp(opacityOf(a), opacityOf(b), t));
    if (mode === 'same') {
      const sprite = opaqueSprite(this.b.doc, b.id, this.scale, this.deps);
      if (sprite) drawSprite(ctx, sprite, multiply(base, m), alpha);
      return;
    }
    // Both pictures stretched to the box in between.
    const fade = clamp01(t);
    const width = Math.max(0, lerp(a.width, b.width, t)), height = Math.max(0, lerp(a.height, b.height, t));
    const spriteA = opaqueSprite(this.a.doc, a.id, this.scale, this.deps), spriteB = opaqueSprite(this.b.doc, b.id, this.scale, this.deps);
    const stretch = (node: SceneNode) => scaling(node.width ? width / node.width : 1, node.height ? height / node.height : 1);
    if (spriteA) drawSprite(ctx, spriteA, multiply(base, multiply(m, stretch(a))), alpha * (1 - fade));
    if (spriteB) drawSprite(ctx, spriteB, multiply(base, multiply(m, stretch(b))), alpha * fade);
  }
}

/** Between two placements: the position moves, the turn and scale are the destination's. */
function lerpPlacement(a: Matrix, b: Matrix, t: number): Matrix {
  if (a === b) return a;
  return [[b[0][0], b[0][1], lerp(a[0][2], b[0][2], t)], [b[1][0], b[1][1], lerp(a[1][2], b[1][2], t)]];
}
