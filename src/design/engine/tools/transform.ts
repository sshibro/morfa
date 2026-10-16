import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, applyLinear, invert, localMatrix, multiply, normalizeDegrees, rotationMatrix, scaling, translation, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {resizeUpdates, type Box} from '../../../../shared/design/constraints';
import {boxOrigin, placementChanges, placementFor, type Placement, type Transaction} from '../../../../shared/design/transaction';
import type {Viewport} from '../contracts';
import {handleAnchors, isLineBox, radiusHandles, screenExtent, screenMatrix, textPathHandle, TINY_BOX} from '../overlay';
import type {SelectionBox} from '../selection';
import type {LayoutHandle, LayoutHandles} from '../layout-handles';
import type {SpacingHandles} from '../spacing-handles';

// The maths of the selection handles: which handle is under the pointer, and what a drag of it
// does to the selected nodes. Pure functions over documents, so they are tested without a canvas.
//
// A single node is resized in its own (rotated, flipped) frame: the drag is read in the node's
// local space and the opposite side stays put. Several nodes are scaled as one box. Dragging a side
// past the opposite one flips the node, as in Figma.

export type HandleHit =
  | {kind: 'resize'; hx: -1 | 0 | 1; hy: -1 | 0 | 1}
  | {kind: 'rotate'; hx: -1 | 1; hy: -1 | 1}
  | {kind: 'endpoint'; end: 0 | 1}
  /** A radius handle inside a corner (overlay.ts `radiusHandles`), the corner in `rectangleCornerRadii` order. */
  | {kind: 'radius'; corner: 0 | 1 | 2 | 3}
  /** The start handle of a text on a path (overlay.ts `textPathHandle`). */
  | {kind: 'path-start'}
  /** Auto layout's padding or gap bar (layout-handles.ts), found by the move tool after the box's own handles. */
  | {kind: 'layout'; handles: LayoutHandles; handle: LayoutHandle}
  /** A gap bar of layers selected with equal spacing (spacing-handles.ts). */
  | {kind: 'spacing'; spacing: SpacingHandles; index: number};

/** Screen px around a radius handle's dot that grab it. */
const RADIUS_REACH = 5;

/** Screen px around a corner handle that grab it, around an edge that grab the edge, and the ring
 *  outside a corner that rotates. */
const CORNER_REACH = 6;
const EDGE_REACH = 4;
const ROTATE_INNER = 5;
const ROTATE_OUTER = 22;
/** On touch every handle answers within a 44 px target (Apple's minimum), and the rotation ring sits outside it;
 *  what is drawn stays the same. */
const TOUCH_REACH = {corner: 22, edge: 11, radius: 16, rotateInner: 22, rotateOuter: 44} as const;
const POINTER_REACH = {corner: CORNER_REACH, edge: EDGE_REACH, radius: RADIUS_REACH, rotateInner: ROTATE_INNER, rotateOuter: ROTATE_OUTER} as const;

export function hitHandle(doc: DesignDocument, box: SelectionBox, screenPoint: Vec, viewport: Viewport, options: {rotate?: boolean; touch?: boolean} = {}): HandleHit | null {
  const reach = options.touch ? TOUCH_REACH : POINTER_REACH;
  const m = multiply(screenMatrix(viewport), box.matrix);
  const zoom = viewport.zoom;
  const distance = (local: Vec) => {
    const p = apply(m, local);
    return Math.hypot(p.x - screenPoint.x, p.y - screenPoint.y);
  };
  if (isLineBox(doc, box)) {
    const start = distance({x: 0, y: 0}), end = distance({x: box.width, y: 0});
    if (Math.min(start, end) > reach.corner + 2) return null;
    return {kind: 'endpoint', end: end < start ? 1 : 0};
  }
  // A text's start handle is drawn over the corners (a rectangle's outline starts at one), so it is grabbed first.
  const textPath = textPathHandle(doc, box, viewport);
  if (textPath && Math.hypot(textPath.at.x - screenPoint.x, textPath.at.y - screenPoint.y) <= reach.corner) return {kind: 'path-start'};
  const local = apply(invert(box.matrix), {x: viewport.x + screenPoint.x / zoom, y: viewport.y + screenPoint.y / zoom});
  const extent = screenExtent(box, viewport);
  const edge = reach.edge / zoom;
  const inX = local.x >= 0 && local.x <= box.width, inY = local.y >= 0 && local.y <= box.height;
  // Inside a small box a finger's handles would cover it all: there they reach a quarter of the box at most, so the
  // middle still moves it.
  const innerCap = options.touch && inX && inY ? Math.min(extent.width, extent.height) / 4 : Infinity;
  const cornerReach = Math.min(reach.corner, innerCap);
  const edgeIn = Math.min(edge, innerCap / zoom);
  let best: {hit: HandleHit; d: number} | null = null;
  for (const anchor of handleAnchors(box.width, box.height, false)) {
    const d = distance(anchor.local);
    if (d <= cornerReach && (!best || d < best.d)) best = {hit: {kind: 'resize', hx: anchor.hx, hy: anchor.hy}, d};
  }
  if (best) return best.hit;
  for (const handle of radiusHandles(doc, box, viewport)) {
    if (Math.hypot(handle.at.x - screenPoint.x, handle.at.y - screenPoint.y) <= Math.min(reach.radius, innerCap)) return {kind: 'radius', corner: handle.corner};
  }
  /** Within reach of a side at `offset` (page units, positive inside the box). */
  const nearSide = (offset: number) => (offset < 0 ? -offset <= edge : offset <= edgeIn);
  if (extent.height >= TINY_BOX / 2 && inY) {
    if (nearSide(local.x)) return {kind: 'resize', hx: -1, hy: 0};
    if (nearSide(box.width - local.x)) return {kind: 'resize', hx: 1, hy: 0};
  }
  if (extent.width >= TINY_BOX / 2 && inX) {
    if (nearSide(local.y)) return {kind: 'resize', hx: 0, hy: -1};
    if (nearSide(box.height - local.y)) return {kind: 'resize', hx: 0, hy: 1};
  }
  if (!options.rotate || (inX && inY)) return null;
  for (const anchor of handleAnchors(box.width, box.height, false)) {
    const d = distance(anchor.local);
    if (d < reach.rotateInner || d > reach.rotateOuter) continue;
    // Only the quarter facing away from the box, so the ring never covers a neighbouring edge.
    const outwardX = (local.x - anchor.local.x) * anchor.hx, outwardY = (local.y - anchor.local.y) * anchor.hy;
    if (outwardX >= -edge && outwardY >= -edge) return {kind: 'rotate', hx: anchor.hx as -1 | 1, hy: anchor.hy as -1 | 1};
  }
  return null;
}

const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const;
const rotateCursors = new Map<number, string>();

/** A curved two-headed arrow turned towards the corner, as a CSS cursor (there is no standard one). */
export function rotateCursor(degrees: number): string {
  const angle = Math.round(degrees / 15) * 15;
  let cursor = rotateCursors.get(angle);
  if (!cursor) {
    // A quarter arc bulging towards the lower right (the 45° corner), an arrowhead at each end.
    const path = 'M4.5 13.5 A9 9 0 0 0 13.5 4.5 M10.5 7.5 L13.5 4.5 L16.5 7.5 M7.5 10.5 L4.5 13.5 L7.5 16.5';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-3 -3 24 24"><g transform="rotate(${angle - 45} 9 9)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${path}" stroke="#fff" stroke-width="3.5"/><path d="${path}" stroke="#000" stroke-width="1.5"/></g></svg>`;
    cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
    rotateCursors.set(angle, cursor);
  }
  return cursor;
}

/** The cursor over a handle, turned with the box. */
export function handleCursor(hit: HandleHit, box: SelectionBox, viewport: Viewport): string {
  if (hit.kind === 'endpoint') return 'crosshair';
  if (hit.kind === 'radius' || hit.kind === 'path-start') return 'default';
  if (hit.kind === 'spacing') return hit.spacing.axis === 'x' ? 'ew-resize' : 'ns-resize';
  if (hit.kind === 'layout') {
    const way = hit.handle.kind === 'padding' ? hit.handle.inward : hit.handle.along;
    const direction = applyLinear(multiply(screenMatrix(viewport), hit.handles.matrix), way);
    return RESIZE_CURSORS[((Math.round((Math.atan2(direction.y, direction.x) * 180) / Math.PI / 45) % 4) + 4) % 4];
  }
  const direction = applyLinear(multiply(screenMatrix(viewport), box.matrix), {x: hit.hx, y: hit.hy});
  const degrees = (Math.atan2(direction.y, direction.x) * 180) / Math.PI;
  if (hit.kind === 'rotate') return rotateCursor(degrees);
  const octant = ((Math.round(degrees / 45) % 4) + 4) % 4;
  return RESIZE_CURSORS[octant];
}

// ── Resizing ─────────────────────────────────────────────────────────────────────────────────────

/** The box's four sides after a drag, in the box's local space (unsorted: right < left means it flipped). */
export type Edges = {left: number; top: number; right: number; bottom: number};

/** Moves the sides a handle drags by `delta` (local space). Shift keeps the proportions (an edge
 *  handle then grows the other side around the centre); Alt resizes from the centre. */
export function resizeEdges(width: number, height: number, handle: {hx: -1 | 0 | 1; hy: -1 | 0 | 1}, delta: Vec, options: {keepRatio?: boolean; fromCenter?: boolean} = {}): Edges {
  const {hx, hy} = handle;
  let left = 0, top = 0, right = width, bottom = height;
  if (hx === 1) right += delta.x;
  if (hx === -1) left += delta.x;
  if (hy === 1) bottom += delta.y;
  if (hy === -1) top += delta.y;
  if (options.fromCenter) {
    if (hx === 1) left -= delta.x;
    if (hx === -1) right -= delta.x;
    if (hy === 1) top -= delta.y;
    if (hy === -1) bottom -= delta.y;
  }
  if (!options.keepRatio || width <= 0 || height <= 0) return {left, top, right, bottom};
  let sx = (right - left) / width, sy = (bottom - top) / height;
  if (hx && hy) {
    const scale = Math.max(Math.abs(sx), Math.abs(sy));
    sx = (sx < 0 ? -1 : 1) * scale;
    sy = (sy < 0 ? -1 : 1) * scale;
  } else if (hx) {
    sy = Math.abs(sx);
  } else {
    sx = Math.abs(sy);
  }
  const place = (dir: -1 | 0 | 1, size: number, extent: number): [number, number] => {
    if (!dir || options.fromCenter) return [extent / 2 - size / 2, extent / 2 + size / 2];
    return dir === 1 ? [0, size] : [extent - size, extent];
  };
  [left, right] = place(hx, sx * width, width);
  [top, bottom] = place(hy, sy * height, height);
  return {left, top, right, bottom};
}

/** Flip about the centre of a box `width` × `height`. */
const flipAbout = (width: number, height: number, x: boolean, y: boolean): Matrix =>
  multiply(multiply(translation(width / 2, height / 2), scaling(x ? -1 : 1, y ? -1 : 1)), translation(-width / 2, -height / 2));

export type NodeFit = {box: Box; placement: Placement};

/** Snaps a box with no rotation to whole pixels by its sides, so the side that did not move stays put. */
function snapBox(fit: NodeFit): NodeFit {
  if (fit.placement.rotation !== 0) return fit;
  const left = Math.round(fit.box.x), top = Math.round(fit.box.y);
  const right = Math.round(fit.box.x + fit.box.width), bottom = Math.round(fit.box.y + fit.box.height);
  const box = {x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top)};
  return {box, placement: {...fit.placement, x: left, y: top}};
}

/** One node resized to `edges` of its own local box. */
export function resizeSingle(doc: DesignDocument, id: NodeId, edges: Edges, options: {snapToPixel?: boolean} = {}): NodeFit {
  const node = doc.nodes[id];
  const parentWorld = worldMatrix(doc, node.parentId!);
  const crossedX = edges.right < edges.left, crossedY = edges.bottom < edges.top;
  const left = Math.min(edges.left, edges.right), top = Math.min(edges.top, edges.bottom);
  const width = Math.abs(edges.right - edges.left), height = Math.abs(edges.bottom - edges.top);
  let world = multiply(worldMatrix(doc, id), translation(left, top));
  if (crossedX || crossedY) world = multiply(world, flipAbout(width, height, crossedX, crossedY));
  const placement = placementFor({width, height}, multiply(invert(parentWorld), world), {flipX: !!node.flipX !== crossedX, flipY: !!node.flipY !== crossedY});
  const fit = {box: {x: placement.x, y: placement.y, width, height}, placement};
  return options.snapToPixel ? snapBox(fit) : fit;
}

/** Several nodes scaled from the page-space box `from` to `edges` of it. Each keeps its rotation and
 *  is resized along its own axes; positions follow the scale. */
export function resizeMany(doc: DesignDocument, ids: readonly NodeId[], from: Rect, edges: Edges, options: {snapToPixel?: boolean} = {}): Map<NodeId, NodeFit> {
  const sx = from.width ? (edges.right - edges.left) / from.width : 1;
  const sy = from.height ? (edges.bottom - edges.top) / from.height : 1;
  const scale: Matrix = [[sx, 0, from.x + edges.left - from.x * sx], [0, sy, from.y + edges.top - from.y * sy]];
  const out = new Map<NodeId, NodeFit>();
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    const world = worldMatrix(doc, id);
    const scaled = multiply(scale, world);
    const u = applyLinear(scaled, {x: 1, y: 0}), v = applyLinear(scaled, {x: 0, y: 1});
    const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
    const width = node.width * lu, height = node.height * lv;
    const centre = apply(scaled, {x: node.width / 2, y: node.height / 2});
    const fallbackU = applyLinear(world, {x: 1, y: 0}), fallbackV = applyLinear(world, {x: 0, y: 1});
    const cu = lu ? {x: u.x / lu, y: u.y / lu} : fallbackU, cv = lv ? {x: v.x / lv, y: v.y / lv} : fallbackV;
    const linear: Matrix = [[cu.x, cv.x, 0], [cu.y, cv.y, 0]];
    const offset = applyLinear(linear, {x: width / 2, y: height / 2});
    linear[0][2] = centre.x - offset.x;
    linear[1][2] = centre.y - offset.y;
    const mirrored = sx * sy < 0;
    const prefer = mirrored ? (sx < 0 ? {flipX: !node.flipX, flipY: !!node.flipY} : {flipX: !!node.flipX, flipY: !node.flipY}) : {flipX: !!node.flipX, flipY: !!node.flipY};
    const placement = placementFor({width, height}, multiply(invert(worldMatrix(doc, node.parentId!)), linear), prefer);
    const fit = {box: {x: placement.x, y: placement.y, width, height}, placement};
    out.set(id, options.snapToPixel ? snapBox(fit) : fit);
  }
  return out;
}

/** Writes a fit through the constraints engine (children follow, vectors scale) plus rotation and flips. */
export function applyFit(tx: Transaction, id: NodeId, fit: NodeFit) {
  for (const [target, partial] of resizeUpdates(tx.doc, id, fit.box)) tx.update(target, partial);
  const node = tx.get(id);
  if (!node) return;
  const rest = placementChanges(node, fit.placement);
  delete rest.x;
  delete rest.y;
  if (Object.keys(rest).length) tx.update(id, rest);
}

/** Frames ⌘/Ctrl-resizing leaves their layers in place for (Figma's "ignore constraints"): plain frames
 *  with layers; auto layout places its layers itself and instances keep their main's structure. */
export function canResizeAlone(node: SceneNode | undefined): boolean {
  return !!node?.children?.length && (node.type === 'FRAME' || node.type === 'COMPONENT') && (!node.autoLayout || node.autoLayout.layoutMode === 'NONE');
}

/** A fit applied to the frame alone: its layers keep their place on the page instead of following
 *  their constraints (⌘/Ctrl held while dragging a handle, as in Figma). */
export function applyFitAlone(tx: Transaction, id: NodeId, fit: NodeFit) {
  const before = tx.get(id);
  if (!before) return;
  tx.update(id, {width: fit.box.width, height: fit.box.height, ...placementChanges(before, fit.placement)});
  const after = tx.get(id)!;
  // Child → frame (before) → parent → frame (after): the child's place in the parent stays.
  const shift = multiply(invert(localMatrix(after)), localMatrix(before));
  for (const childId of before.children ?? []) {
    const child = tx.get(childId);
    if (child) tx.update(childId, placementChanges(child, placementFor(child, multiply(shift, localMatrix(child)))));
  }
}

/** What a resize by hand does to a text's auto-resize mode: a side handle on an auto-width text
 *  makes it auto-height; any change of height fixes its size. */
export function textResizeMode(node: SceneNode, handle: {hx: -1 | 0 | 1; hy: -1 | 0 | 1}): Partial<SceneNode> | null {
  const mode = node.text?.textAutoResize;
  if (!node.text || !mode || mode === 'NONE' || mode === 'TRUNCATE') return null;
  const next = handle.hy ? 'NONE' : mode === 'WIDTH_AND_HEIGHT' ? 'HEIGHT' : mode;
  return next === mode ? null : {text: {...node.text, textAutoResize: next}};
}

// ── Rotation ─────────────────────────────────────────────────────────────────────────────────────

export const rotationAbout = (pivot: Vec, radians: number): Matrix =>
  multiply(multiply(translation(pivot.x, pivot.y), rotationMatrix(radians)), translation(-pivot.x, -pivot.y));

/** One node turned about its centre by `radians` (clockwise on screen). `snapDegrees` rounds the
 *  resulting rotation (Shift: 15°). */
export function rotateSingle(doc: DesignDocument, id: NodeId, radians: number, snapDegrees = 0): Placement {
  const node = doc.nodes[id];
  const world = worldMatrix(doc, id);
  const parentInverse = invert(worldMatrix(doc, node.parentId!));
  const centre = apply(world, {x: node.width / 2, y: node.height / 2});
  const placement = placementFor(node, multiply(parentInverse, multiply(rotationAbout(centre, radians), world)));
  if (!snapDegrees) return placement;
  const rotation = normalizeDegrees(Math.round(placement.rotation / snapDegrees) * snapDegrees);
  return {...placement, ...boxOrigin(apply(parentInverse, centre), node.width, node.height, rotation), rotation};
}

/** Several nodes turned together about `pivot` (page space). */
export function rotateMany(doc: DesignDocument, ids: readonly NodeId[], pivot: Vec, radians: number): Map<NodeId, Placement> {
  const turn = rotationAbout(pivot, radians);
  const out = new Map<NodeId, Placement>();
  for (const id of ids) {
    const node = doc.nodes[id];
    if (node) out.set(id, placementFor(node, multiply(invert(worldMatrix(doc, node.parentId!)), multiply(turn, worldMatrix(doc, id)))));
  }
  return out;
}

// ── Lines ────────────────────────────────────────────────────────────────────────────────────────

/** A line with one end dragged to `target` (page space); the other end stays. Shift keeps the
 *  angle on 45° steps. Returns the line's new fields. */
export function moveLineEnd(doc: DesignDocument, id: NodeId, end: 0 | 1, target: Vec, options: {snapAngle?: boolean} = {}): Partial<SceneNode> {
  const node = doc.nodes[id];
  const world = worldMatrix(doc, id);
  const fixed = apply(world, end === 1 ? {x: 0, y: 0} : {x: node.width, y: 0});
  let moving = target;
  if (options.snapAngle) {
    const dx = target.x - fixed.x, dy = target.y - fixed.y;
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const length = Math.hypot(dx, dy);
    moving = {x: fixed.x + Math.cos(angle) * length, y: fixed.y + Math.sin(angle) * length};
  }
  const parentInverse = invert(worldMatrix(doc, node.parentId!));
  const start = apply(parentInverse, end === 1 ? fixed : moving), finish = apply(parentInverse, end === 1 ? moving : fixed);
  const dx = finish.x - start.x, dy = finish.y - start.y;
  const width = Math.hypot(dx, dy);
  const rotation = width ? normalizeDegrees((-Math.atan2(dy, dx) * 180) / Math.PI) : node.rotation;
  const out: Partial<SceneNode> = {x: start.x, y: start.y, width, rotation};
  if (node.flipX) out.flipX = false;
  if (node.flipY) out.flipY = false;
  return out;
}

/** The angle (radians, clockwise on screen) from `pivot` to `point`. */
export const angleFrom = (pivot: Vec, point: Vec) => Math.atan2(point.y - pivot.y, point.x - pivot.x);
