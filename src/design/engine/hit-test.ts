import type {DesignDocument, Matrix, NodeId, Paint, PathCommand, SceneNode, Vec} from '../../../shared/design/types';
import {apply, applyLinear, IDENTITY, invert, localMatrix, multiply, rectContains, transformRect, worldMatrix, type Rect} from '../../../shared/design/geometry';
import {nodeGeometry} from '../../../shared/design/shapes';
import {textPathCommands} from '../../../shared/design/text-path';
import {comparePaintPaths, isFrameLikeNode, paintChildren, paintPath, sortByPaintOrder, type SpatialIndex} from '../../../shared/design/tree';
import {isBoardObject} from '../../../shared/design/board/model';

export type {SpatialIndex};

// Geometric hit testing in page space. No canvas: the same code runs in node tests, the tools and
// the layers panel. A click is tested against what the user sees: the node's outline (flattened
// curves with its winding rule), its stroke band, the box of texts and frames; hidden and locked
// nodes let clicks through, a clipping frame or a mask hides what lies outside it, and rotation and
// flips are undone by the node's world matrix.
//
// With a spatial index (built by the renderer per page) only the nodes near the point are tested;
// without one the page is walked front to back. Both give the same answer.

/** Screen pixels within which a thin line or an edge still counts as hit (divide by zoom for page units). */
export const HIT_TOLERANCE_PX = 4;
/** A finger covers more than a cursor's tip: thin layers are picked from this far (CSS px) on touch. */
export const TOUCH_HIT_TOLERANCE_PX = 12;
/** The pick tolerance in CSS px for a pointer of this type (ToolPointerEvent.pointerType). */
export const hitTolerancePx = (pointerType: string) => (pointerType === 'touch' ? TOUCH_HIT_TOLERANCE_PX : HIT_TOLERANCE_PX);

export type HitOptions = {
  /** Page units; a few screen px divided by the zoom. Default 0. */
  tolerance?: number;
  index?: SpatialIndex | null;
};

export type PickOptions = HitOptions & {
  /** The group or frame the user entered: its children are picked directly. */
  context?: NodeId | null;
  /** ⌘/Ctrl-click: the deepest layer under the pointer. */
  deep?: boolean;
};

// ── Flattened outlines ───────────────────────────────────────────────────────────────────────────

/** A subpath as x0, y0, x1, y1… in the node's local box. */
export type Polyline = {points: number[]; closed: boolean};
type Outline = {fillRule: 'NONZERO' | 'EVENODD'; subpaths: Polyline[]}[];
type Flat = {outline: Outline; bounds: Rect; open: boolean};

const FLAT = new WeakMap<SceneNode, Flat>();

function segmentsFor(length: number) {
  return Math.max(4, Math.min(64, Math.ceil(length / 8)));
}

/** Curves become polylines with chords at most ~0.2 px from the curve at any size. */
export function flattenCommands(commands: readonly PathCommand[]): Polyline[] {
  const out: Polyline[] = [];
  let points: number[] | null = null;
  let x = 0, y = 0, startX = 0, startY = 0;
  const finish = (closed: boolean) => {
    if (points && points.length > 2) out.push({points, closed});
    points = null;
  };
  for (const command of commands) {
    if (command.type === 'Z') {
      finish(true);
      x = startX;
      y = startY;
      continue;
    }
    if (command.type === 'M') {
      finish(false);
      points = [command.x, command.y];
      x = startX = command.x;
      y = startY = command.y;
      continue;
    }
    if (!points) {
      points = [x, y];
      startX = x;
      startY = y;
    }
    if (command.type === 'L') {
      points.push(command.x, command.y);
    } else if (command.type === 'C') {
      const length = Math.hypot(command.x1 - x, command.y1 - y) + Math.hypot(command.x2 - command.x1, command.y2 - command.y1) + Math.hypot(command.x - command.x2, command.y - command.y2);
      const n = segmentsFor(length);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        points.push(a * x + b * command.x1 + c * command.x2 + d * command.x, a * y + b * command.y1 + c * command.y2 + d * command.y);
      }
    } else {
      const length = Math.hypot(command.x1 - x, command.y1 - y) + Math.hypot(command.x - command.x1, command.y - command.y1);
      const n = segmentsFor(length);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        points.push(u * u * x + 2 * u * t * command.x1 + t * t * command.x, u * u * y + 2 * u * t * command.y1 + t * t * command.y);
      }
    }
    x = command.x;
    y = command.y;
  }
  finish(false);
  return out;
}

function flat(node: SceneNode): Flat {
  let cached = FLAT.get(node);
  if (cached) return cached;
  // A text on a path is outlined by its path (the hover outline shows it, as in Figma).
  const geometry = node.textPath ? [{windingRule: 'NONZERO' as const, commands: textPathCommands(node.textPath)}] : nodeGeometry(node);
  const outline: Outline = geometry.map(path => ({fillRule: path.windingRule, subpaths: flattenCommands(path.commands)}));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, open = false;
  for (const path of outline) for (const sub of path.subpaths) {
    if (!sub.closed) open = true;
    for (let i = 0; i < sub.points.length; i += 2) {
      const px = sub.points[i], py = sub.points[i + 1];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  const bounds = Number.isFinite(minX) ? {x: minX, y: minY, width: maxX - minX, height: maxY - minY} : {x: 0, y: 0, width: node.width, height: node.height};
  cached = {outline, bounds, open: open || node.type === 'LINE'};
  FLAT.set(node, cached);
  return cached;
}

/** The node's outline in its local box, flattened (cached per node object). Boxes for nodes without
 *  geometry of their own (text, groups). */
export function nodeOutline(node: SceneNode): Polyline[] {
  const own = flat(node).outline.flatMap(path => path.subpaths);
  if (own.length) return own;
  return [{points: [0, 0, node.width, 0, node.width, node.height, 0, node.height], closed: true}];
}

function insideFill(outline: Outline, p: Vec): boolean {
  for (const path of outline) {
    let winding = 0;
    for (const {points} of path.subpaths) {
      const n = points.length / 2;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const x0 = points[2 * i], y0 = points[2 * i + 1], x1 = points[2 * j], y1 = points[2 * j + 1];
        const cross = (x1 - x0) * (p.y - y0) - (p.x - x0) * (y1 - y0);
        if (y0 <= p.y) {
          if (y1 > p.y && cross > 0) winding++;
        } else if (y1 <= p.y && cross < 0) {
          winding--;
        }
      }
    }
    if (path.fillRule === 'EVENODD' ? winding % 2 !== 0 : winding !== 0) return true;
  }
  return false;
}

function segmentDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / length)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function outlineDistance(outline: Outline, p: Vec): number {
  let best = Infinity;
  for (const path of outline) for (const {points, closed} of path.subpaths) {
    const n = points.length / 2;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const d = segmentDistance(p.x, p.y, points[2 * i], points[2 * i + 1], points[2 * j], points[2 * j + 1]);
      if (d < best) best = d;
    }
  }
  return best;
}

// ── One node ─────────────────────────────────────────────────────────────────────────────────────

const visiblePaint = (paint: Paint) => paint.visible !== false && paint.opacity > 0;
const hasFill = (node: SceneNode) => node.fills.some(visiblePaint);

function strokeWeightOf(node: SceneNode): number {
  const sides = node.individualStrokeWeights;
  return sides ? Math.max(sides.top, sides.right, sides.bottom, sides.left) : node.strokeWeight;
}
const hasStroke = (node: SceneNode) => strokeWeightOf(node) > 0 && node.strokes.some(visiblePaint);

const inBox = (node: SceneNode, p: Vec, margin = 0) => p.x >= -margin && p.y >= -margin && p.x <= node.width + margin && p.y <= node.height + margin;

const isBoxLike = (node: SceneNode) => isFrameLikeNode(node) || node.type === 'SECTION' || node.type === 'TEXT';
/** A box with no width or height (an empty text, a collapsed frame) still takes clicks within the tolerance. */
const boxMargin = (node: SceneNode, tolerance: number) => (node.width > 0 && node.height > 0 ? 0 : tolerance);

/** Fill and stroke of a shape at a local point. A shape with no visible fill is hollow (only its
 *  stroke takes clicks, as designers expect of an outline), unless it has no stroke either: then its
 *  area does, so it can still be picked. */
function shapeHit(node: SceneNode, local: Vec, tolerance: number): boolean {
  const {outline, bounds, open} = flat(node);
  const stroke = hasStroke(node);
  const weight = stroke ? strokeWeightOf(node) : 0;
  const markers = (node.strokeStartMarker && node.strokeStartMarker !== 'NONE') || (node.strokeEndMarker && node.strokeEndMarker !== 'NONE');
  const reach = Math.max(tolerance, weight * (markers ? 3 : 1));
  if (local.x < bounds.x - reach || local.y < bounds.y - reach || local.x > bounds.x + bounds.width + reach || local.y > bounds.y + bounds.height + reach) return false;
  const inside = node.type !== 'LINE' && insideFill(outline, local);
  if (inside && (hasFill(node) || !stroke)) return true;
  const distance = outlineDistance(outline, local);
  if (distance <= tolerance) return true;
  if (!stroke) return false;
  if (open || node.strokeAlign === 'CENTER') return distance <= (markers ? weight * 1.5 : weight / 2);
  return node.strokeAlign === 'INSIDE' ? inside && distance <= weight : !inside && distance <= weight;
}

/** Whether the point is inside the node's area, paints aside: what a mask or a boolean operation reads. */
function shapeContains(doc: DesignDocument, node: SceneNode, m: Matrix, point: Vec): boolean {
  if (node.type === 'BOOLEAN_OPERATION' || node.type === 'GROUP') {
    const results: boolean[] = [];
    for (const id of node.children ?? []) {
      const child = doc.nodes[id];
      if (child?.visible) results.push(shapeContains(doc, child, multiply(m, localMatrix(child)), point));
    }
    if (!results.length) return false;
    if (node.type === 'GROUP') return results.some(Boolean);
    switch (node.booleanOperation ?? 'UNION') {
      case 'INTERSECT': return results.every(Boolean);
      case 'SUBTRACT': return results[0] && !results.slice(1).some(Boolean);
      case 'EXCLUDE': return results.filter(Boolean).length % 2 === 1;
      default: return results.some(Boolean);
    }
  }
  const local = apply(invert(m), point);
  if (isBoxLike(node)) return inBox(node, local);
  if (node.type === 'LINE' || node.type === 'SLICE' || node.type === 'PAGE') return false;
  return insideFill(flat(node).outline, local);
}

function outlineDistanceDeep(doc: DesignDocument, node: SceneNode, m: Matrix, point: Vec): number {
  if (node.children) {
    let best = Infinity;
    for (const id of node.children) {
      const child = doc.nodes[id];
      if (child?.visible) best = Math.min(best, outlineDistanceDeep(doc, child, multiply(m, localMatrix(child)), point));
    }
    return best;
  }
  return outlineDistance(flat(node).outline, apply(invert(m), point));
}

function booleanHit(doc: DesignDocument, node: SceneNode, m: Matrix, point: Vec, tolerance: number): boolean {
  const stroke = hasStroke(node);
  if (shapeContains(doc, node, m, point) && (hasFill(node) || !stroke)) return true;
  return outlineDistanceDeep(doc, node, m, point) <= Math.max(tolerance, stroke ? strokeWeightOf(node) / 2 : 0);
}

/** The front-most operand under the point (what ⌘-click selects inside a boolean), or the operation itself. */
function booleanLeaf(doc: DesignDocument, node: SceneNode, m: Matrix, point: Vec): NodeId {
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const child = doc.nodes[children[i]];
    if (!child?.visible || child.locked) continue;
    const cm = multiply(m, localMatrix(child));
    if (!shapeContains(doc, child, cm, point)) continue;
    return child.type === 'BOOLEAN_OPERATION' || child.type === 'GROUP' ? booleanLeaf(doc, child, cm, point) : child.id;
  }
  return node.id;
}

/** A text on a path takes clicks in a band along its path as wide as its lines reach on either side (the glyphs stand on
 *  one side or the other, by its alignment), not in the whole box of the path. */
function textOnPathHit(node: SceneNode, local: Vec, tolerance: number): boolean {
  const text = node.text;
  if (!text) return false;
  let size = text.style.fontSize;
  for (const run of text.runs) if (run.style.fontSize !== undefined && run.style.fontSize > size) size = run.style.fontSize;
  let lines = 1;
  for (let i = text.characters.indexOf('\n'); i >= 0 && lines < 1000; i = text.characters.indexOf('\n', i + 1)) lines++;
  return outlineDistance(flat(node).outline, local) <= tolerance + size * 1.25 * lines;
}

/** Whether the node's own geometry (not its children) is hit; `m` is its local → page matrix. */
function ownHit(doc: DesignDocument, node: SceneNode, m: Matrix, point: Vec, tolerance: number): boolean {
  if (node.type === 'BOOLEAN_OPERATION') return booleanHit(doc, node, m, point, tolerance);
  if (node.type === 'PAGE' || node.type === 'GROUP') return false;
  const local = apply(invert(m), point);
  if (node.textPath) return textOnPathHit(node, local, tolerance);
  if (isBoxLike(node)) return inBox(node, local, boxMargin(node, tolerance));
  if (node.type === 'SLICE') {
    // An export area drawn over the design: only its border takes clicks, the design under it stays clickable.
    if (!inBox(node, local, tolerance)) return false;
    const edge = Math.min(Math.abs(local.x), Math.abs(local.y), Math.abs(node.width - local.x), Math.abs(node.height - local.y));
    return edge <= Math.max(tolerance, 1);
  }
  return shapeHit(node, local, tolerance);
}

/** Whether `point` (page space) hits the node itself at its place on the page, ignoring ancestors. */
export function hitsNode(doc: DesignDocument, id: NodeId, point: Vec, tolerance = 0): boolean {
  const node = doc.nodes[id];
  if (!node) return false;
  const m = worldMatrix(doc, id);
  if (node.type === 'GROUP') return shapeContains(doc, node, m, point) || outlineDistanceDeep(doc, node, m, point) <= tolerance;
  return ownHit(doc, node, m, point, tolerance);
}

/** For each child (paint order), the index of the mask that clips it, or −1. A mask clips the
 *  siblings above it up to the next mask; a hidden mask clips nothing. */
function maskRuns(doc: DesignDocument, children: readonly NodeId[]): Int32Array | null {
  let runs: Int32Array | null = null;
  let current = -1;
  for (let i = 0; i < children.length; i++) {
    const child = doc.nodes[children[i]];
    if (child?.isMask) {
      current = child.visible ? i : -1;
      runs ??= new Int32Array(children.length).fill(-1);
      continue;
    }
    if (runs) runs[i] = current;
  }
  return runs;
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────

function scanChildren(doc: DesignDocument, parentId: NodeId, world: Matrix, point: Vec, tolerance: number): NodeId | null {
  const children = paintChildren(doc.nodes[parentId]);
  const masks = maskRuns(doc, children);
  for (let i = children.length - 1; i >= 0; i--) {
    const child = doc.nodes[children[i]];
    if (!child || !child.visible || child.locked || child.isMask) continue;
    if (masks && masks[i] >= 0) {
      const mask = doc.nodes[children[masks[i]]];
      if (!shapeContains(doc, mask, multiply(world, localMatrix(mask)), point)) continue;
    }
    const hit = scanNode(doc, child, multiply(world, localMatrix(child)), point, tolerance);
    if (hit) return hit;
  }
  return null;
}

function scanNode(doc: DesignDocument, node: SceneNode, m: Matrix, point: Vec, tolerance: number): NodeId | null {
  if (node.type === 'GROUP') return scanChildren(doc, node.id, m, point, tolerance);
  if (node.type === 'BOOLEAN_OPERATION') return booleanHit(doc, node, m, point, tolerance) ? booleanLeaf(doc, node, m, point) : null;
  if (isFrameLikeNode(node) || node.type === 'SECTION') {
    const local = apply(invert(m), point);
    const clips = isFrameLikeNode(node) && node.clipsContent !== false;
    if (!clips || inBox(node, local)) {
      const inner = scanChildren(doc, node.id, m, point, tolerance);
      if (inner) return inner;
    }
    return inBox(node, local, boxMargin(node, tolerance)) && !backgroundLocked(node) ? node.id : null;
  }
  return ownHit(doc, node, m, point, tolerance) ? node.id : null;
}

/** Answers per call for the index path: world matrices and whether a node's ancestors let a click at
 *  this point through (visible, unlocked, inside clipping frames and masks, on the page). */
class ChainCache {
  private readonly worlds = new Map<NodeId, Matrix>();
  private readonly open = new Map<NodeId, boolean>();
  private readonly runs = new Map<NodeId, Int32Array | null>();

  constructor(private readonly doc: DesignDocument, private readonly pageId: NodeId, private readonly point: Vec) {}

  world(id: NodeId): Matrix {
    let m = this.worlds.get(id);
    if (m) return m;
    const node = this.doc.nodes[id];
    m = !node || node.type === 'PAGE' || !node.parentId ? IDENTITY : multiply(this.world(node.parentId), localMatrix(node));
    this.worlds.set(id, m);
    return m;
  }

  /** The node itself is visible, unlocked and not clipped away at the point, and so is every ancestor. */
  allows(id: NodeId): boolean {
    const cached = this.open.get(id);
    if (cached !== undefined) return cached;
    const node = this.doc.nodes[id];
    let ok: boolean;
    if (!node) ok = false;
    else if (node.type === 'PAGE') ok = id === this.pageId;
    // A mask's own content never takes clicks (the scan skips the whole mask subtree too).
    else if (!node.visible || node.locked || node.isMask || !node.parentId) ok = false;
    // Nothing in a board section whose contents are hidden takes a click.
    else if (hiddenSection(this.doc.nodes[node.parentId])) ok = false;
    else ok = this.allows(node.parentId) && this.parentLets(node);
    this.open.set(id, ok);
    return ok;
  }

  private parentLets(node: SceneNode): boolean {
    const parent = this.doc.nodes[node.parentId!];
    if (isFrameLikeNode(parent) && parent.clipsContent !== false && !inBox(parent, apply(invert(this.world(parent.id)), this.point))) return false;
    let runs = this.runs.get(parent.id);
    if (runs === undefined) {
      runs = maskRuns(this.doc, paintChildren(parent));
      this.runs.set(parent.id, runs);
    }
    if (!runs) return true;
    const children = paintChildren(parent);
    const at = children.indexOf(node.id);
    if (at < 0 || runs[at] < 0) return true;
    const mask = this.doc.nodes[children[runs[at]]];
    return shapeContains(this.doc, mask, this.world(mask.id), this.point);
  }
}

/** A board section's switches (FigJam): "lock background only" keeps the section itself from clicks while what it holds takes
 *  them; "hide contents" hides what it holds. */
const backgroundLocked = (node: SceneNode) => node.type === 'SECTION' && node.board?.kind === 'section' && !!node.board.backgroundLocked;
const hiddenSection = (node: SceneNode | undefined) => node?.type === 'SECTION' && node.board?.kind === 'section' && !!node.board.hidden;

function outermostBoolean(doc: DesignDocument, id: NodeId): NodeId | null {
  let found: NodeId | null = null;
  for (let node: SceneNode | undefined = doc.nodes[id]; node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : undefined) {
    if (node.type === 'BOOLEAN_OPERATION') found = node.id;
  }
  return found;
}

function indexedHit(doc: DesignDocument, pageId: NodeId, point: Vec, tolerance: number, index: SpatialIndex): NodeId | null {
  const cache = new ChainCache(doc, pageId, point);
  const seen = new Set<NodeId>();
  let best: {leaf: NodeId; path: number[]} | null = null;
  const reach = Math.max(tolerance, 0);
  for (const candidate of index.query({x: point.x - reach, y: point.y - reach, width: reach * 2, height: reach * 2})) {
    const unit = outermostBoolean(doc, candidate) ?? candidate;
    if (seen.has(unit)) continue;
    seen.add(unit);
    const node = doc.nodes[unit];
    if (!node || node.type === 'PAGE' || node.type === 'GROUP' || node.isMask || backgroundLocked(node) || !cache.allows(unit)) continue;
    const m = cache.world(unit);
    if (!ownHit(doc, node, m, point, tolerance)) continue;
    const path = paintPath(doc, unit);
    if (best && comparePaintPaths(path, best.path) <= 0) continue;
    best = {leaf: node.type === 'BOOLEAN_OPERATION' ? booleanLeaf(doc, node, m, point) : unit, path};
  }
  return best?.leaf ?? null;
}

/** The front-most node under `point` on the page, as deep as it goes (no selection rules applied):
 *  a shape, a text, an operand of a boolean, or a frame when its empty area is hit. */
export function hitTest(doc: DesignDocument, pageId: NodeId, point: Vec, options: HitOptions = {}): NodeId | null {
  const tolerance = options.tolerance ?? 0;
  if (options.index) return indexedHit(doc, pageId, point, tolerance, options.index);
  return scanChildren(doc, pageId, IDENTITY, point, tolerance);
}

/** Lifts the hit layer to what a click selects, like Figma: the outermost ancestor below the
 *  context, except that sections and the frames standing directly on the canvas (or in the
 *  context) never swallow a click on their children — those are picked themselves. Groups, boolean
 *  operations, instances and nested frames are picked as a whole. A leaf outside the context is
 *  lifted as if there were no context. */
export function liftToSelectable(doc: DesignDocument, leaf: NodeId, context: NodeId | null = null): NodeId {
  const chain: NodeId[] = [];
  let reachedContext = false;
  for (let node: SceneNode | undefined = doc.nodes[leaf]; node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : undefined) {
    if (node.id === context) {
      reachedContext = true;
      break;
    }
    chain.push(node.id);
  }
  if (context && !reachedContext && doc.nodes[context]) return liftToSelectable(doc, leaf, null);
  chain.reverse();
  for (let i = 0; i < chain.length - 1; i++) {
    const node = doc.nodes[chain[i]];
    if (node.type === 'SECTION') continue;
    // A board object (docs/board.md: a sticky, a shape with text, a table...) is picked whole, never the text inside it; a board
    // object on it (a stamp attached to a sticky) is picked itself.
    if (isBoardObject(node)) {
      if (isBoardObject(doc.nodes[chain[i + 1]])) continue;
      return chain[i];
    }
    if (isFrameLikeNode(node) && node.type !== 'INSTANCE') return chain[i + 1];
    return chain[i];
  }
  return chain[chain.length - 1] ?? leaf;
}

/** What a click at `point` selects (null: empty canvas). */
export function pickAt(doc: DesignDocument, pageId: NodeId, point: Vec, options: PickOptions = {}): NodeId | null {
  const leaf = hitTest(doc, pageId, point, options);
  if (!leaf) return null;
  return options.deep ? leaf : liftToSelectable(doc, leaf, options.context ?? null);
}

// ── Marquee ──────────────────────────────────────────────────────────────────────────────────────

/** Separating-axis test between a node's rotated box and an axis-aligned rectangle (page space). */
export function boxIntersectsRect(m: Matrix, width: number, height: number, rect: Rect): boolean {
  const points = [apply(m, {x: 0, y: 0}), apply(m, {x: width, y: 0}), apply(m, {x: width, y: height}), apply(m, {x: 0, y: height})];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (maxX < rect.x || minX > rect.x + rect.width || maxY < rect.y || minY > rect.y + rect.height) return false;
  const corners = [{x: rect.x, y: rect.y}, {x: rect.x + rect.width, y: rect.y}, {x: rect.x + rect.width, y: rect.y + rect.height}, {x: rect.x, y: rect.y + rect.height}];
  for (const axis of [applyLinear(m, {x: 1, y: 0}), applyLinear(m, {x: 0, y: 1})]) {
    if (!axis.x && !axis.y) continue;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of points) {
      const d = p.x * axis.x + p.y * axis.y;
      a0 = Math.min(a0, d);
      a1 = Math.max(a1, d);
    }
    for (const p of corners) {
      const d = p.x * axis.x + p.y * axis.y;
      b0 = Math.min(b0, d);
      b1 = Math.max(b1, d);
    }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right < x || bottom < y ? null : {x, y, width: right - x, height: bottom - y};
}

export type MarqueeOptions = {
  context?: NodeId | null;
  /** The frame the marquee started in: its children are taken instead of the canvas's. */
  scope?: NodeId | null;
  index?: SpatialIndex | null;
};

const opensOnCanvas = (node: SceneNode) => node.type === 'SECTION' || (isFrameLikeNode(node) && node.type !== 'INSTANCE');

/** What a marquee selects, in paint order: the children of the scope (the frame it started in, the
 *  context, or the page) that it touches. On the canvas a section or a frame is taken only when the
 *  marquee covers it whole; otherwise its children are considered (sections stay canvas-like inside). */
export function nodesInRect(doc: DesignDocument, pageId: NodeId, rect: Rect, options: MarqueeOptions = {}): NodeId[] {
  const scope = options.scope ?? options.context ?? pageId;
  if (!doc.nodes[scope]) return [];
  const canvas = scope === pageId || doc.nodes[scope].type === 'SECTION';
  if (options.index) return indexedMarquee(doc, scope, canvas, rect, options.index);
  const out: NodeId[] = [];
  const collect = (parentId: NodeId, world: Matrix, onCanvas: boolean, clip: Rect | null) => {
    const area = clip ? intersection(rect, clip) : rect;
    if (!area) return;
    for (const id of paintChildren(doc.nodes[parentId])) {
      const child = doc.nodes[id];
      if (!child || !child.visible || child.locked) continue;
      const m = multiply(world, localMatrix(child));
      if (!boxIntersectsRect(m, child.width, child.height, area)) continue;
      if (onCanvas && opensOnCanvas(child)) {
        const box = transformRect(m, {x: 0, y: 0, width: child.width, height: child.height});
        if (rectContains(rect, box)) out.push(id);
        else collect(id, m, child.type === 'SECTION', isFrameLikeNode(child) && child.clipsContent !== false ? (clip ? intersection(clip, box) : box) : clip);
        continue;
      }
      out.push(id);
    }
  };
  const scopeNode = doc.nodes[scope];
  const scopeWorld = worldMatrix(doc, scope);
  const scopeClip = scope !== pageId && isFrameLikeNode(scopeNode) && scopeNode.clipsContent !== false ? transformRect(scopeWorld, {x: 0, y: 0, width: scopeNode.width, height: scopeNode.height}) : null;
  collect(scope, scopeWorld, canvas, scopeClip);
  return out;
}

function indexedMarquee(doc: DesignDocument, scope: NodeId, canvas: boolean, rect: Rect, index: SpatialIndex): NodeId[] {
  const worlds = new Map<NodeId, Matrix>();
  const world = (id: NodeId): Matrix => {
    let m = worlds.get(id);
    if (!m) {
      m = worldMatrix(doc, id);
      worlds.set(id, m);
    }
    return m;
  };
  const boxOf = (id: NodeId) => transformRect(world(id), {x: 0, y: 0, width: doc.nodes[id].width, height: doc.nodes[id].height});
  const covered = new Map<NodeId, boolean>();
  const isCovered = (id: NodeId) => {
    let value = covered.get(id);
    if (value === undefined) covered.set(id, (value = rectContains(rect, boxOf(id))));
    return value;
  };
  const units = new Set<NodeId>();
  for (const candidate of index.query(rect)) {
    // The chain from the scope's child down to the candidate.
    const chain: NodeId[] = [];
    let node = doc.nodes[candidate];
    while (node && node.id !== scope && node.type !== 'PAGE') {
      chain.push(node.id);
      node = node.parentId ? doc.nodes[node.parentId] : (undefined as never);
    }
    if (!node || node.id !== scope || !chain.length) continue;
    chain.reverse();
    let unit: NodeId | null = null;
    let onCanvas = canvas;
    for (let i = 0; i < chain.length; i++) {
      const each = doc.nodes[chain[i]];
      if (!onCanvas || !opensOnCanvas(each) || isCovered(each.id)) {
        unit = each.id;
        break;
      }
      // A frame the marquee does not touch hides its children from it, even ones sticking out.
      if (!boxIntersectsRect(world(each.id), each.width, each.height, rect)) break;
      onCanvas = each.type === 'SECTION';
    }
    if (unit) units.add(unit);
  }
  const out: NodeId[] = [];
  for (const id of units) {
    let usable = true;
    let area: Rect | null = rect;
    for (let node = doc.nodes[id]; node && node.id !== scope; node = doc.nodes[node.parentId!]) {
      if (!node.visible || node.locked) {
        usable = false;
        break;
      }
      const parent = doc.nodes[node.parentId!];
      if (parent && isFrameLikeNode(parent) && parent.clipsContent !== false) area = area && intersection(area, boxOf(parent.id));
    }
    if (!usable || !area) continue;
    const node = doc.nodes[id];
    if (boxIntersectsRect(world(id), node.width, node.height, area)) out.push(id);
  }
  return sortByPaintOrder(doc, out);
}
