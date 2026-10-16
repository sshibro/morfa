import type {DesignDocument, Matrix, NodeId, Paint, SceneNode, Vec, VectorPath, WindingRule} from '../../../../shared/design/types';
import {apply, boundsOfPoints, localMatrix, translation, unionRects, type Rect} from '../../../../shared/design/geometry';
import {anchorKind, anchorsToPath, cubicPoint, pathsBounds, pathToAnchors, splitCubicAt, transformPath, type Anchor, type AnchorPath, type Cubic} from '../../../../shared/design/paths';
import {nodeGeometry} from '../../../../shared/design/shapes';
import {remapPaints, unitBoxMatrix} from '../../../../shared/design/boolean';
import {isInsideInstance} from '../../../../shared/design/tree';

// The editable form of a vector ("path editing mode"): a node's paths as anchors with
// handles (shared/design/paths.ts `pathToAnchors`), the edits the pen and the vector editor make to
// them, and the way back into a node. Everything here is pure and works in the node's local space;
// the tools map the pointer in and out. An anchor is addressed by (path, subpath, anchor) indexes,
// and a segment by the anchor it leaves from (the closing segment of a closed subpath leaves from
// its last anchor).
//
// Writing back re-fits the box: the paths are re-based so the box bounds them tightly (as Figma
// fits a vector's box to its network) and x/y move the other way, so nothing moves on screen. A
// shape (rectangle, ellipse, polygon, star, line) is edited through its outline and becomes a
// VECTOR with the same id on the first edit, as in Figma.

export type EditPath = {windingRule: WindingRule; subs: AnchorPath[]};
export type Network = EditPath[];
export type AnchorRef = {p: number; s: number; a: number};
/** A segment leaves anchor `a` of subpath `s` of path `p` for the next one (wrapping when closed). */
export type SegmentRef = AnchorRef;
export type HandleSide = 'in' | 'out';
/** `p.s.a`: a stable string for sets of selected anchors. */
export type AnchorKey = string;

export const keyOf = (ref: AnchorRef): AnchorKey => `${ref.p}.${ref.s}.${ref.a}`;
export function parseKey(key: AnchorKey): AnchorRef {
  const [p, s, a] = key.split('.').map(Number);
  return {p, s, a};
}

/** Node types the vector editor opens: vectors and the shapes it converts on the first edit. */
export const VECTOR_EDITABLE = new Set<SceneNode['type']>(['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE']);

/** Why a node cannot be opened in the vector editor, or null when it can. */
export function vectorEditBlocker(doc: DesignDocument, id: NodeId): string | null {
  const node = doc.nodes[id];
  if (!node) return 'Layer not found';
  if (node.type === 'BOOLEAN_OPERATION') return 'To edit the points of a boolean operation, flatten it first (⌘E)';
  if (node.type === 'TEXT') return 'Text points cannot be edited: the letter outlines are unavailable';
  if (!VECTOR_EDITABLE.has(node.type)) return 'This layer cannot be edited as a path';
  if (isInsideInstance(doc, id)) return 'Paths inside an instance cannot be changed. Detach the instance to change them';
  return null;
}

/** The outline the editor works on: a vector's own paths, a shape's geometry. */
export const editableGeometry = (node: SceneNode): VectorPath[] => (node.type === 'VECTOR' ? node.vectorPaths ?? [] : nodeGeometry(node));

export const networkOf = (paths: readonly VectorPath[]): Network =>
  paths.map(path => ({windingRule: path.windingRule, subs: pathToAnchors(path.commands)}));

export const networkOfNode = (node: SceneNode): Network => networkOf(editableGeometry(node));

export function networkPaths(network: Network): VectorPath[] {
  const out: VectorPath[] = [];
  for (const path of network) {
    const subs = path.subs.filter(sub => sub.anchors.length);
    if (subs.length) out.push({windingRule: path.windingRule, commands: anchorsToPath(subs)});
  }
  return out;
}

const copyVec = (v: Vec | null): Vec | null => (v ? {x: v.x, y: v.y} : null);
export const copyAnchor = (a: Anchor): Anchor => ({x: a.x, y: a.y, in: copyVec(a.in), out: copyVec(a.out), kind: a.kind});

export function cloneNetwork(network: Network): Network {
  return network.map(path => ({windingRule: path.windingRule, subs: path.subs.map(sub => ({closed: sub.closed, anchors: sub.anchors.map(copyAnchor)}))}));
}

export const anchorAt = (network: Network, ref: AnchorRef): Anchor | undefined => network[ref.p]?.subs[ref.s]?.anchors[ref.a];
export const subAt = (network: Network, ref: Pick<AnchorRef, 'p' | 's'>): AnchorPath | undefined => network[ref.p]?.subs[ref.s];

export function* anchorRefs(network: Network): Generator<AnchorRef> {
  for (let p = 0; p < network.length; p++) {
    const subs = network[p].subs;
    for (let s = 0; s < subs.length; s++) for (let a = 0; a < subs[s].anchors.length; a++) yield {p, s, a};
  }
}

export const allKeys = (network: Network): AnchorKey[] => [...anchorRefs(network)].map(keyOf);
export const anchorCount = (network: Network) => network.reduce((sum, path) => sum + path.subs.reduce((n, sub) => n + sub.anchors.length, 0), 0);

/** The keys that still name an anchor (after an undo or another edit changed the network). */
export function validKeys(network: Network, keys: Iterable<AnchorKey>): Set<AnchorKey> {
  const out = new Set<AnchorKey>();
  for (const key of keys) if (anchorAt(network, parseKey(key))) out.add(key);
  return out;
}

/** Segments in a subpath: n − 1 open, n closed (none for a lone point). */
export const segmentCount = (sub: AnchorPath) => (sub.anchors.length < 2 ? 0 : sub.closed ? sub.anchors.length : sub.anchors.length - 1);

/** The anchors a segment joins. */
export function segmentEnds(network: Network, ref: SegmentRef): [Anchor, Anchor] | null {
  const sub = subAt(network, ref);
  if (!sub || ref.a < 0 || ref.a >= segmentCount(sub)) return null;
  return [sub.anchors[ref.a], sub.anchors[(ref.a + 1) % sub.anchors.length]];
}

const lerp = (a: Vec, b: Vec, t: number): Vec => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});
const same = (a: Vec, b: Vec) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

/** The segment as a cubic, with the parameterisation `anchorsToPath` draws (a straight segment is
 *  cut in thirds, so its parameter is the linear one). */
export function segmentCubic(a: Anchor, b: Anchor): Cubic {
  if (!a.out && !b.in) return [{x: a.x, y: a.y}, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), {x: b.x, y: b.y}];
  return [{x: a.x, y: a.y}, a.out ? {...a.out} : {x: a.x, y: a.y}, b.in ? {...b.in} : {x: b.x, y: b.y}, {x: b.x, y: b.y}];
}

export const isStraight = (a: Anchor, b: Anchor) => !a.out && !b.in;

// ── Bounds and writing back ──────────────────────────────────────────────────────────────────────

/** Tight bounds of what the network draws, lone points included. Null when it has no anchors. */
export function networkBounds(paths: readonly VectorPath[], network: Network): Rect | null {
  const points: Vec[] = [];
  for (const ref of anchorRefs(network)) points.push(anchorAt(network, ref)!);
  if (!points.length) return null;
  const drawn = pathsBounds(paths);
  const own = boundsOfPoints(points);
  return drawn ? unionRects([drawn, own]) : own;
}

/** Rounds away float noise (99.99999999997) so panels show what a designer expects. */
function clean(value: number): number {
  const rounded = Math.round(value);
  const out = Math.abs(value - rounded) < 1e-7 ? rounded : value;
  return Object.is(out, -0) ? 0 : out;
}

const needsRemap = (paints: readonly Paint[]) => paints.some(paint => paint.type !== 'SOLID' && (paint.type !== 'IMAGE' || paint.scaleMode === 'CROP'));

/** Fields of shapes that a VECTOR does not carry. */
const SHAPE_ONLY: (keyof SceneNode)[] = ['cornerRadius', 'rectangleCornerRadii', 'cornerSmoothing', 'individualStrokeWeights', 'arcData', 'pointCount', 'innerRadius'];

/**
 * The node fields that store `network` (given in the node's current local space): paths re-based
 * to a tight box, the box placed so nothing moves on screen, gradients re-expressed in the new
 * box, and a shape turned into a VECTOR. Null when the network has no anchors left.
 */
export function vectorFields(node: SceneNode, network: Network): Partial<SceneNode> | null {
  const paths = networkPaths(network);
  const bounds = networkBounds(paths, network);
  if (!bounds) return null;
  // The shift is on the same 1/10000 grid as the coordinates, so anchors nobody touched keep
  // their exact place however often the box re-fits.
  const sx = cleanCoordinate(bounds.x), sy = cleanCoordinate(bounds.y);
  const shift = translation(-sx, -sy);
  const vectorPaths = paths.map(path => ({windingRule: path.windingRule, commands: transformPath(path.commands, shift).map(cleanCommand)}));
  const width = clean(bounds.width), height = clean(bounds.height);
  // The new box's origin goes where the old box mapped the bounds' corner; rotation and flips stay
  // (flips turn about the new centre, so only the translation is solved for).
  const target = apply(localMatrix(node), {x: sx, y: sy});
  const zero = localMatrix({...node, x: 0, y: 0, width, height});
  const out: Partial<SceneNode> = {x: clean(target.x - zero[0][2]), y: clean(target.y - zero[1][2]), width, height, vectorPaths};
  if (node.type !== 'VECTOR') {
    out.type = 'VECTOR';
    for (const key of SHAPE_ONLY) if (key in node) (out as Record<string, unknown>)[key] = undefined;
    if (!node.strokeStartMarker) out.strokeStartMarker = 'NONE';
    if (!node.strokeEndMarker) out.strokeEndMarker = 'NONE';
  }
  return out;
}

/** Paints re-expressed in the new box (gradients keep their colours where they were), or null when
 *  nothing needs it. Styled paints are left alone: they follow their style. */
export function remappedPaints(node: SceneNode, fields: Partial<SceneNode>): Partial<Pick<SceneNode, 'fills' | 'strokes'>> | null {
  const fills = !node.fillStyleId && needsRemap(node.fills);
  const strokes = !node.strokeStyleId && needsRemap(node.strokes);
  if (!fills && !strokes) return null;
  const from = unitBoxMatrix(node, localMatrix(node));
  const placed = {...node, ...fields} as SceneNode;
  const to = unitBoxMatrix(placed, localMatrix(placed));
  const out: Partial<Pick<SceneNode, 'fills' | 'strokes'>> = {};
  if (fills) out.fills = remapPaints(node.fills, from, to);
  if (strokes) out.strokes = remapPaints(node.strokes, from, to);
  return out;
}

function cleanCommand<T extends {type: string}>(command: T): T {
  const out = {...command} as Record<string, unknown>;
  for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) if (typeof out[key] === 'number') out[key] = cleanCoordinate(out[key] as number);
  return out as T;
}

/** Coordinates keep 1/10000 px: plenty for drawing, and repeated re-basing never piles up noise. */
const cleanCoordinate = (value: number) => {
  const out = Math.round(value * 1e4) / 1e4;
  return Object.is(out, -0) ? 0 : out;
};

// ── Edits (each returns a changed copy) ──────────────────────────────────────────────────────────

/** Moves anchors (with their handles) by `delta`. */
export function moveAnchors(network: Network, refs: readonly AnchorRef[], delta: Vec): Network {
  const out = cloneNetwork(network);
  for (const ref of refs) {
    const a = anchorAt(out, ref);
    if (!a) continue;
    a.x += delta.x;
    a.y += delta.y;
    if (a.in) a.in = {x: a.in.x + delta.x, y: a.in.y + delta.y};
    if (a.out) a.out = {x: a.out.x + delta.x, y: a.out.y + delta.y};
  }
  return out;
}

/** How dragging one handle treats the other: `auto` keeps the anchor's kind (mirrored handles
 *  mirror, smooth ones stay on one line), `independent` moves only this one (Alt in Figma). */
export type HandleMode = 'auto' | 'independent';

/** Puts an anchor's handle at `point` (in place). */
export function placeHandle(anchor: Anchor, side: HandleSide, point: Vec | null, mode: HandleMode): void {
  const other: HandleSide = side === 'in' ? 'out' : 'in';
  const kind = anchor.kind;
  anchor[side] = point && !same(point, anchor) ? {x: point.x, y: point.y} : null;
  if (mode === 'auto' && point && anchor[side]) {
    const dx = anchor.x - point.x, dy = anchor.y - point.y;
    if (kind === 'mirrored') anchor[other] = {x: anchor.x + dx, y: anchor.y + dy};
    else if (kind === 'smooth' && anchor[other]) {
      const keep = Math.hypot(anchor[other]!.x - anchor.x, anchor[other]!.y - anchor.y);
      const length = Math.hypot(dx, dy);
      if (length > 1e-9) anchor[other] = {x: anchor.x + (dx / length) * keep, y: anchor.y + (dy / length) * keep};
    }
  }
  anchor.kind = mode === 'auto' && (kind === 'mirrored' || kind === 'smooth') && anchor.in && anchor.out ? kind : anchorKind(anchor);
}

export function moveHandle(network: Network, ref: AnchorRef, side: HandleSide, point: Vec, mode: HandleMode): Network {
  const out = cloneNetwork(network);
  const anchor = anchorAt(out, ref);
  if (anchor) placeHandle(anchor, side, point, mode);
  return out;
}

/** ⌘-drag on an anchor (the bend tool): pulls out mirrored handles towards `point`. */
export function pullHandles(network: Network, ref: AnchorRef, point: Vec): Network {
  const out = cloneNetwork(network);
  const anchor = anchorAt(out, ref);
  if (!anchor) return out;
  if (same(point, anchor)) {
    anchor.in = anchor.out = null;
    anchor.kind = 'corner';
    return out;
  }
  anchor.out = {x: point.x, y: point.y};
  anchor.in = {x: 2 * anchor.x - point.x, y: 2 * anchor.y - point.y};
  anchor.kind = 'mirrored';
  return out;
}

/** Parameters closer than this to an end move the far handle too much to be useful. */
const BEND_LIMIT = 0.08;

/**
 * Drags the point at parameter `t` of a segment to `target`, bending the curve (a straight segment
 * becomes a curve): the two handles move by the least amount that puts the curve through the
 * target there. Smooth and mirrored ends stay smooth, so neighbouring segments follow.
 */
export function bendSegment(network: Network, ref: SegmentRef, t: number, target: Vec): Network {
  const out = cloneNetwork(network);
  const ends = segmentEnds(out, ref);
  if (!ends) return out;
  const [a, b] = ends;
  const cubic = segmentCubic(a, b);
  const u = Math.min(1 - BEND_LIMIT, Math.max(BEND_LIMIT, t));
  const at = cubicPoint(cubic, u);
  const d = {x: target.x - at.x, y: target.y - at.y};
  const b1 = 3 * (1 - u) * (1 - u) * u, b2 = 3 * (1 - u) * u * u;
  const norm = b1 * b1 + b2 * b2;
  const c1 = {x: cubic[1].x + (d.x * b1) / norm, y: cubic[1].y + (d.y * b1) / norm};
  const c2 = {x: cubic[2].x + (d.x * b2) / norm, y: cubic[2].y + (d.y * b2) / norm};
  placeHandle(a, 'out', c1, 'auto');
  placeHandle(b, 'in', c2, 'auto');
  return out;
}

/** Splits a segment at `t` without changing the shape (insertAnchorAt in anchor form). Returns the
 *  new anchor's ref. */
export function insertAnchor(network: Network, ref: SegmentRef, t: number): {network: Network; ref: AnchorRef} | null {
  const out = cloneNetwork(network);
  const sub = subAt(out, ref);
  const ends = segmentEnds(out, ref);
  if (!sub || !ends) return null;
  const [a, b] = ends;
  t = Math.min(1, Math.max(0, t));
  let anchor: Anchor;
  if (isStraight(a, b)) {
    anchor = {...lerp(a, b, t), in: null, out: null, kind: 'corner'};
  } else {
    const [left, right] = splitCubicAt(segmentCubic(a, b), t);
    a.out = same(left[1], a) ? null : left[1];
    b.in = same(right[2], b) ? null : right[2];
    anchor = {x: left[3].x, y: left[3].y, in: same(left[2], left[3]) ? null : left[2], out: same(right[1], right[3]) ? null : right[1], kind: 'corner'};
    anchor.kind = anchorKind(anchor);
  }
  const index = ref.a + 1;
  sub.anchors.splice(index, 0, anchor);
  return {network: out, ref: {p: ref.p, s: ref.s, a: index}};
}

/**
 * Removes anchors; the neighbours join, so a closed path stays closed. Subpaths left with fewer
 * than two anchors go, and so do paths left without subpaths.
 */
export function deleteAnchors(network: Network, refs: readonly AnchorRef[]): Network {
  const doomed = new Set(refs.map(keyOf));
  const out: Network = [];
  network.forEach((path, p) => {
    const subs: AnchorPath[] = [];
    path.subs.forEach((sub, s) => {
      const anchors = sub.anchors.filter((_, a) => !doomed.has(keyOf({p, s, a}))).map(copyAnchor);
      if (anchors.length >= 2) subs.push({closed: sub.closed, anchors});
    });
    if (subs.length) out.push({windingRule: path.windingRule, subs});
  });
  return out;
}

/** Double click on an anchor: a corner gets mirrored handles along its neighbours' direction; an
 *  anchor with handles becomes a sharp corner. */
export function toggleSmooth(network: Network, ref: AnchorRef): Network {
  const out = cloneNetwork(network);
  const sub = subAt(out, ref);
  const anchor = anchorAt(out, ref);
  if (!sub || !anchor) return out;
  if (anchor.in || anchor.out) {
    anchor.in = anchor.out = null;
    anchor.kind = 'corner';
    return out;
  }
  const n = sub.anchors.length;
  const prev = ref.a > 0 ? sub.anchors[ref.a - 1] : sub.closed && n > 1 ? sub.anchors[n - 1] : null;
  const next = ref.a < n - 1 ? sub.anchors[ref.a + 1] : sub.closed && n > 1 ? sub.anchors[0] : null;
  if (!prev && !next) return out;
  const from = prev ?? anchor, to = next ?? anchor;
  let dx = to.x - from.x, dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return out;
  dx /= l;
  dy /= l;
  const lengths = [prev, next].filter((v): v is Anchor => !!v).map(v => Math.hypot(v.x - anchor.x, v.y - anchor.y) / 3);
  const length = lengths.reduce((sum, v) => sum + v, 0) / lengths.length;
  anchor.in = {x: anchor.x - dx * length, y: anchor.y - dy * length};
  anchor.out = {x: anchor.x + dx * length, y: anchor.y + dy * length};
  anchor.kind = 'mirrored';
  return out;
}

/** A new open subpath with one anchor: in path `p` (the last path by default, a new one when
 *  there is none). */
export function startSubpath(network: Network, point: Vec, p = network.length - 1): {network: Network; ref: AnchorRef} {
  const out = cloneNetwork(network);
  if (p < 0 || !out[p]) {
    out.push({windingRule: 'NONZERO', subs: []});
    p = out.length - 1;
  }
  out[p].subs.push({closed: false, anchors: [{x: point.x, y: point.y, in: null, out: null, kind: 'corner'}]});
  return {network: out, ref: {p, s: out[p].subs.length - 1, a: 0}};
}

/** Which end of an open subpath the pen extends. `lead` is the handle a drag gave the last anchor
 *  in the drawing direction (an offset from it): the document has no segment to keep it in yet, so
 *  the pen carries it until the next anchor uses it. */
export type PenEnd = {p: number; s: number; end: 'start' | 'end'; lead?: Vec | null};

/** The network with the pen's pending lead handle put back on the open end it belongs to. */
export function withLead(network: Network, end: PenEnd | null): Network {
  if (!end?.lead) return network;
  const ref = endRef(network, end);
  const anchor = ref && anchorAt(network, ref);
  if (!ref || !anchor) return network;
  const out = cloneNetwork(network);
  const target = anchorAt(out, ref)!;
  const handle = {x: target.x + end.lead.x, y: target.y + end.lead.y};
  // The lead leaves the end along the drawing direction: `out` at the end, `in` at the start.
  if (end.end === 'end') target.out = handle;
  else target.in = handle;
  target.kind = anchorKind(target);
  return out;
}

/** The lead handle of `anchor` as a PenEnd keeps it (an offset), or null. */
export function leadOf(anchor: Anchor | undefined, end: Pick<PenEnd, 'end'>): Vec | null {
  const handle = anchor ? (end.end === 'end' ? anchor.out : anchor.in) : null;
  return anchor && handle ? {x: handle.x - anchor.x, y: handle.y - anchor.y} : null;
}

export function endRef(network: Network, end: PenEnd): AnchorRef | null {
  const sub = subAt(network, end);
  if (!sub || !sub.anchors.length || sub.closed) return null;
  return {p: end.p, s: end.s, a: end.end === 'start' ? 0 : sub.anchors.length - 1};
}

/** Adds an anchor at an end of an open subpath; with `out`, the anchor gets that handle in the
 *  drawing direction and `in` (mirrored unless given). */
export function extendSubpath(network: Network, end: PenEnd, point: Vec, handles?: {out: Vec; in: Vec | null}): {network: Network; ref: AnchorRef} | null {
  const out = cloneNetwork(network);
  const sub = subAt(out, end);
  if (!sub || sub.closed) return null;
  const anchor = drawnAnchor(point, handles);
  if (end.end === 'start') {
    // Drawing backwards from the start: the anchor's travel direction runs against the path's.
    sub.anchors.unshift({...anchor, in: anchor.out, out: anchor.in});
    return {network: out, ref: {p: end.p, s: end.s, a: 0}};
  }
  sub.anchors.push(anchor);
  return {network: out, ref: {p: end.p, s: end.s, a: sub.anchors.length - 1}};
}

/** An anchor placed by the pen: a corner for a click, mirrored handles for a drag (the dragged one
 *  leads on), and the other one free when Alt broke the mirror. */
export function drawnAnchor(point: Vec, handles?: {out: Vec; in: Vec | null}): Anchor {
  const anchor: Anchor = {x: point.x, y: point.y, in: null, out: null, kind: 'corner'};
  if (!handles || same(handles.out, point)) return anchor;
  anchor.out = {x: handles.out.x, y: handles.out.y};
  anchor.in = handles.in ? {x: handles.in.x, y: handles.in.y} : {x: 2 * point.x - handles.out.x, y: 2 * point.y - handles.out.y};
  anchor.kind = anchorKind(anchor);
  return anchor;
}

/** Sets the handles of an existing anchor as the pen does while dragging: `out` along the drawing
 *  direction (which is reversed when drawing from the start of a subpath). */
export function dragPenHandles(network: Network, ref: AnchorRef, handles: {out: Vec; in: Vec | null}, reversed = false): Network {
  const out = cloneNetwork(network);
  const anchor = anchorAt(out, ref);
  if (!anchor) return out;
  const drawn = drawnAnchor(anchor, handles);
  anchor.in = reversed ? drawn.out : drawn.in;
  anchor.out = reversed ? drawn.in : drawn.out;
  anchor.kind = drawn.kind;
  return out;
}

/** Closes an open subpath (the pen clicked its first anchor). */
export function closeSubpath(network: Network, ref: Pick<AnchorRef, 'p' | 's'>): Network {
  const out = cloneNetwork(network);
  const sub = subAt(out, ref);
  if (sub && sub.anchors.length >= 2) sub.closed = true;
  return out;
}

/** Joins the end of one open subpath to an end of another of the same path (the pen clicked
 *  another path's endpoint). Returns the joined subpath's ref (`s` may shift when `other` was
 *  listed before it). */
export function joinSubpaths(network: Network, from: PenEnd, other: PenEnd): {network: Network; ref: Pick<AnchorRef, 'p' | 's'>} | null {
  if (from.p !== other.p || from.s === other.s) return null;
  const out = cloneNetwork(network);
  const subs = out[from.p]?.subs;
  const a = subs?.[from.s], b = subs?.[other.s];
  if (!subs || !a || !b || a.closed || b.closed) return null;
  // Orient both so the joint is a's end and b's start.
  const ours = from.end === 'end' ? a.anchors : reverseAnchors(a.anchors);
  const theirs = other.end === 'start' ? b.anchors : reverseAnchors(b.anchors);
  a.anchors = [...ours, ...theirs];
  subs.splice(other.s, 1);
  return {network: out, ref: {p: from.p, s: other.s < from.s ? from.s - 1 : from.s}};
}

/** The anchors in the other order, handles swapped, so the drawn shape stays the same. */
export function reverseAnchors(anchors: readonly Anchor[]): Anchor[] {
  return [...anchors].reverse().map(a => ({x: a.x, y: a.y, in: copyVec(a.out), out: copyVec(a.in), kind: a.kind}));
}

/** Drops subpaths with a single anchor (a pen click nobody continued). */
export function pruneLonePoints(network: Network): Network {
  const out: Network = [];
  for (const path of network) {
    const subs = path.subs.filter(sub => sub.anchors.length > 1).map(sub => ({closed: sub.closed, anchors: sub.anchors.map(copyAnchor)}));
    if (subs.length) out.push({windingRule: path.windingRule, subs});
  }
  return out;
}

export const hasLonePoints = (network: Network) => network.some(path => path.subs.some(sub => sub.anchors.length < 2));

// ── Hit testing (screen px) ──────────────────────────────────────────────────────────────────────

/** Handles worth showing: those of the selected anchors and the neighbours' handles on the segments
 *  next to them, as Figma does (an unselected path shows none). Only handles on a drawn segment. */
export function visibleHandles(network: Network, selected: ReadonlySet<AnchorKey>): {ref: AnchorRef; side: HandleSide}[] {
  const out: {ref: AnchorRef; side: HandleSide}[] = [];
  const seen = new Set<string>();
  const add = (ref: AnchorRef, side: HandleSide) => {
    const id = `${keyOf(ref)}:${side}`;
    if (seen.has(id)) return;
    const anchor = anchorAt(network, ref);
    if (!anchor || !anchor[side]) return;
    const sub = subAt(network, ref)!;
    const n = sub.anchors.length;
    // A handle that shapes no segment (the start's `in`, the end's `out` of an open path) stays hidden.
    if (!sub.closed && ((side === 'in' && ref.a === 0) || (side === 'out' && ref.a === n - 1))) return;
    seen.add(id);
    out.push({ref, side});
  };
  for (const key of selected) {
    const ref = parseKey(key);
    const sub = subAt(network, ref);
    if (!sub || !sub.anchors[ref.a]) continue;
    const n = sub.anchors.length;
    add(ref, 'in');
    add(ref, 'out');
    const prev = ref.a > 0 ? ref.a - 1 : sub.closed ? n - 1 : -1;
    const next = ref.a < n - 1 ? ref.a + 1 : sub.closed ? 0 : -1;
    if (prev >= 0 && prev !== ref.a) add({...ref, a: prev}, 'out');
    if (next >= 0 && next !== ref.a) add({...ref, a: next}, 'in');
  }
  return out;
}

const dist2 = (a: Vec, b: Vec) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** The anchor nearest to `screen` within `radius` px (`toScreen` maps the node's space to the
 *  canvas). Runs on every pointer move: plain loops, no allocation until a hit. */
export function hitAnchor(network: Network, toScreen: Matrix, screen: Vec, radius: number, filter?: (ref: AnchorRef) => boolean): AnchorRef | null {
  const [[a, c, e], [b, d, f]] = toScreen;
  let best: AnchorRef | null = null, bestD = radius * radius;
  for (let p = 0; p < network.length; p++) {
    const subs = network[p].subs;
    for (let s = 0; s < subs.length; s++) {
      const anchors = subs[s].anchors;
      for (let i = 0; i < anchors.length; i++) {
        const x = a * anchors[i].x + c * anchors[i].y + e - screen.x, y = b * anchors[i].x + d * anchors[i].y + f - screen.y;
        const dd = x * x + y * y;
        if (dd > bestD) continue;
        const ref = {p, s, a: i};
        if (filter && !filter(ref)) continue;
        bestD = dd;
        best = ref;
      }
    }
  }
  return best;
}

export function hitHandle(network: Network, handles: readonly {ref: AnchorRef; side: HandleSide}[], toScreen: Matrix, screen: Vec, radius: number): {ref: AnchorRef; side: HandleSide} | null {
  let best: {ref: AnchorRef; side: HandleSide} | null = null, bestD = radius * radius;
  for (const handle of handles) {
    const point = anchorAt(network, handle.ref)?.[handle.side];
    if (!point) continue;
    const d = dist2(apply(toScreen, point), screen);
    if (d <= bestD) {
      bestD = d;
      best = handle;
    }
  }
  return best;
}

/** The segment nearest to `local` (the pointer in the node's space) within `tolerance` (same
 *  space), with the curve parameter and the point there. */
export function hitSegment(network: Network, local: Vec, tolerance: number): {ref: SegmentRef; t: number; point: Vec} | null {
  let best: {ref: SegmentRef; t: number; point: Vec} | null = null;
  let bestD = tolerance;
  network.forEach((path, p) => path.subs.forEach((sub, s) => {
    const count = segmentCount(sub);
    for (let a = 0; a < count; a++) {
      const [from, to] = [sub.anchors[a], sub.anchors[(a + 1) % sub.anchors.length]];
      const cubic = segmentCubic(from, to);
      // A cheap reject: the control polygon's box grown by the tolerance holds the whole curve.
      const minX = Math.min(cubic[0].x, cubic[1].x, cubic[2].x, cubic[3].x) - bestD, maxX = Math.max(cubic[0].x, cubic[1].x, cubic[2].x, cubic[3].x) + bestD;
      const minY = Math.min(cubic[0].y, cubic[1].y, cubic[2].y, cubic[3].y) - bestD, maxY = Math.max(cubic[0].y, cubic[1].y, cubic[2].y, cubic[3].y) + bestD;
      if (local.x < minX || local.x > maxX || local.y < minY || local.y > maxY) continue;
      const near = isStraight(from, to) ? nearestOnLine(from, to, local) : nearestOnCubic(cubic, local);
      const d = Math.sqrt(dist2(near.point, local));
      if (d <= bestD) {
        bestD = d;
        best = {ref: {p, s, a}, t: near.t, point: near.point};
      }
    }
  }));
  return best;
}

function nearestOnLine(a: Vec, b: Vec, p: Vec): {t: number; point: Vec} {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return {t, point: lerp(a, b, t)};
}

function nearestOnCubic(c: Cubic, p: Vec): {t: number; point: Vec} {
  const samples = 24;
  let bestT = 0, bestD = Infinity;
  for (let k = 0; k <= samples; k++) {
    const t = k / samples;
    const d = dist2(cubicPoint(c, t), p);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  // Ternary refinement around the best sample.
  let lo = Math.max(0, bestT - 1 / samples), hi = Math.min(1, bestT + 1 / samples);
  for (let i = 0; i < 24; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (dist2(cubicPoint(c, m1), p) < dist2(cubicPoint(c, m2), p)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  return {t, point: cubicPoint(c, t)};
}

/** Anchors whose screen position lies in `rect` (the marquee). */
export function anchorsInRect(network: Network, toScreen: Matrix, rect: Rect): AnchorKey[] {
  const out: AnchorKey[] = [];
  for (const ref of anchorRefs(network)) {
    const p = apply(toScreen, anchorAt(network, ref)!);
    if (p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height) out.push(keyOf(ref));
  }
  return out;
}

/** Endpoints of open subpaths (where the pen can continue). */
export function openEnds(network: Network): PenEnd[] {
  const out: PenEnd[] = [];
  network.forEach((path, p) => path.subs.forEach((sub, s) => {
    if (sub.closed || !sub.anchors.length) return;
    out.push({p, s, end: 'end'});
    if (sub.anchors.length > 1) out.push({p, s, end: 'start'});
  }));
  return out;
}

/** Snaps `point` so the direction from `origin` is a multiple of 45° (Shift). */
export function constrain45(origin: Vec, point: Vec): Vec {
  const dx = point.x - origin.x, dy = point.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (!length) return {x: point.x, y: point.y};
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  // Project onto the snapped direction, so the point stays under the pointer along it.
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const along = dx * ux + dy * uy;
  return {x: origin.x + ux * along, y: origin.y + uy * along};
}
