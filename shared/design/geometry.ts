import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from './types';
import {engineCounted, engineCrashed, engineDeclinedCount, engineFor, engineScratch, engineTs, engineWasm, lazyInputs, shadowForChain, withEngine, type MorfaDocHandle} from './engine-switch';

// Affine maths shared by the renderer, hit testing, tools, exporters and the layout engine.
// A Matrix is [[a, c, e], [b, d, f]]; points are column vectors, so `multiply(parent, local)`
// maps local coordinates into the parent's.

export type Rect = {x: number; y: number; width: number; height: number};

export const IDENTITY: Matrix = [[1, 0, 0], [0, 1, 0]];

export function multiply(m: Matrix, n: Matrix): Matrix {
  const [[a, c, e], [b, d, f]] = m;
  const [[a2, c2, e2], [b2, d2, f2]] = n;
  return [
    [a * a2 + c * b2, a * c2 + c * d2, a * e2 + c * f2 + e],
    [b * a2 + d * b2, b * c2 + d * d2, b * e2 + d * f2 + f],
  ];
}

export function invert(m: Matrix): Matrix {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c;
  if (!det || !Number.isFinite(det)) return IDENTITY;
  return [
    [d / det, -c / det, (c * f - d * e) / det],
    [-b / det, a / det, (b * e - a * f) / det],
  ];
}

export const apply = (m: Matrix, p: Vec): Vec => ({x: m[0][0] * p.x + m[0][1] * p.y + m[0][2], y: m[1][0] * p.x + m[1][1] * p.y + m[1][2]});
/** Applies only the linear part (for directions and sizes). */
export const applyLinear = (m: Matrix, p: Vec): Vec => ({x: m[0][0] * p.x + m[0][1] * p.y, y: m[1][0] * p.x + m[1][1] * p.y});
export const translation = (x: number, y: number): Matrix => [[1, 0, x], [0, 1, y]];
export const scaling = (sx: number, sy: number): Matrix => [[sx, 0, 0], [0, sy, 0]];
/** Rotation by `radians` clockwise on screen (y points down). */
export function rotationMatrix(radians: number): Matrix {
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return [[cos, -sin, 0], [sin, cos, 0]];
}
export const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Local box → parent space: translate(x, y) · rotate(−rotation°) · flip about the box centre.
 *  `rotation` turns counter-clockwise on screen, as Figma's panel shows it. */
export function localMatrix(node: Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY'>): Matrix {
  // One node's 3×2 matrix costs less than the crossing: `wasm` keeps it in
  // TypeScript, and only `both` sends it across, to compare.
  if (engineFor('geometry') !== 'both') return localMatrixTs(node);
  return withEngine('geometry', 'localMatrix', () => localMatrixTs(node), () => {
    engineWasm().geometry_local_matrix_into(node.x, node.y, node.width, node.height, node.rotation || 0, !!node.flipX, !!node.flipY);
    const m = engineScratch();
    return [[m[0], m[1], m[2]], [m[3], m[4], m[5]]] as Matrix;
  }, {inputs: node});
}

function localMatrixTs(node: Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY'>): Matrix {
  let m = multiply(translation(node.x, node.y), rotationMatrix(-toRadians(node.rotation || 0)));
  if (node.flipX || node.flipY) {
    const flip = multiply(multiply(translation(node.width / 2, node.height / 2), scaling(node.flipX ? -1 : 1, node.flipY ? -1 : 1)), translation(-node.width / 2, -node.height / 2));
    m = multiply(m, flip);
  }
  return m;
}

/** Node local box → page space. Pages are the identity. */
export function worldMatrix(doc: DesignDocument, id: NodeId): Matrix {
  if (engineTs('geometry')) return worldMatrixTs(doc, id);
  const shadow = shadowForChain(doc, id);
  if (!shadow) {
    engineDeclinedCount('geometry', 'worldMatrix');
    return worldMatrixTs(doc, id);
  }
  if (engineFor('geometry') === 'wasm') {
    engineCounted('geometry', 'worldMatrix');
    try {
      return worldMatrixWasm(shadow, id);
    } catch (error) {
      engineCrashed('geometry', 'worldMatrix', error);
      return worldMatrixTs(doc, id);
    }
  }
  return withEngine('geometry', 'worldMatrix', () => worldMatrixTs(doc, id), () => worldMatrixWasm(shadow, id), {inputs: lazyInputs(() => ({id, chain: chainOf(doc, id)}))});
}

function worldMatrixWasm(shadow: MorfaDocHandle, id: NodeId): Matrix {
  shadow.geometry_world_matrix_into(id);
  const m = engineScratch();
  return [[m[0], m[1], m[2]], [m[3], m[4], m[5]]];
}

function worldMatrixTs(doc: DesignDocument, id: NodeId): Matrix {
  const chain: SceneNode[] = [];
  for (let node = doc.nodes[id]; node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never)) chain.push(node);
  let m = IDENTITY;
  for (let i = chain.length - 1; i >= 0; i--) m = multiply(m, localMatrix(chain[i]));
  return m;
}

/** `worldMatrix` for many nodes of one document in one pass (a 5 000-layer selection's box, a panel reading every
 *  selected layer): each ancestor's matrix is worked out once instead of once per descendant. Every answer equals
 *  `worldMatrix(doc, id)` to the bit (the same products in the same order). Only while `doc`'s table does not change. */
export function worldMatrices(doc: DesignDocument): (id: NodeId) => Matrix {
  const known = new Map<NodeId, Matrix>();
  return id => {
    const hit = known.get(id);
    if (hit) return hit;
    const chain: SceneNode[] = [];
    let m = IDENTITY;
    for (let node = doc.nodes[id]; node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never)) {
      const above = known.get(node.id);
      if (above) {
        m = above;
        break;
      }
      chain.push(node);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      m = multiply(m, localMatrix(chain[i]));
      known.set(chain[i].id, m);
    }
    return m;
  };
}

/** The page a node lives on, or undefined for a detached node. */
export function pageOf(doc: DesignDocument, id: NodeId): SceneNode | undefined {
  let node = doc.nodes[id];
  while (node && node.type !== 'PAGE') node = node.parentId ? doc.nodes[node.parentId] : (undefined as never);
  return node;
}

export const corners = (r: Rect): Vec[] => [
  {x: r.x, y: r.y}, {x: r.x + r.width, y: r.y}, {x: r.x + r.width, y: r.y + r.height}, {x: r.x, y: r.y + r.height},
];

/** Axis-aligned bounds of a rectangle after a transform. */
export function transformRect(m: Matrix, r: Rect): Rect {
  return boundsOfPoints(corners(r).map(p => apply(m, p)));
}

export function boundsOfPoints(points: readonly Vec[]): Rect {
  if (!points.length) return {x: 0, y: 0, width: 0, height: 0};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  return boundsOfPoints(rects.flatMap(r => [{x: r.x, y: r.y}, {x: r.x + r.width, y: r.y + r.height}]));
}

export const rectsIntersect = (a: Rect, b: Rect) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
export const rectContains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
export const pointInRect = (p: Vec, r: Rect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** The node's box (no stroke or effects) in page space, as an axis-aligned rectangle. */
export const worldBox = (doc: DesignDocument, id: NodeId): Rect => {
  if (engineTs('geometry')) return worldBoxTs(doc, id);
  const shadow = shadowForChain(doc, id);
  if (!shadow) {
    engineDeclinedCount('geometry', 'worldBox');
    return worldBoxTs(doc, id);
  }
  if (engineFor('geometry') === 'wasm') {
    engineCounted('geometry', 'worldBox');
    try {
      return worldBoxWasm(shadow, id);
    } catch (error) {
      engineCrashed('geometry', 'worldBox', error);
      return worldBoxTs(doc, id);
    }
  }
  return withEngine('geometry', 'worldBox', () => worldBoxTs(doc, id), () => worldBoxWasm(shadow, id), {inputs: lazyInputs(() => ({id, chain: chainOf(doc, id)}))});
};

function worldBoxWasm(shadow: MorfaDocHandle, id: NodeId): Rect {
  shadow.geometry_world_box_into(id);
  const r = engineScratch();
  return {x: r[0], y: r[1], width: r[2], height: r[3]};
}

function worldBoxTs(doc: DesignDocument, id: NodeId): Rect {
  const node = doc.nodes[id];
  return transformRect(worldMatrixTs(doc, id), {x: 0, y: 0, width: node?.width ?? 0, height: node?.height ?? 0});
}

/** The node and its ancestors up to the page (a diff's inputs). */
function chainOf(doc: DesignDocument, id: NodeId): SceneNode[] {
  const chain: SceneNode[] = [];
  for (let node = doc.nodes[id]; node && chain.length < 64; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never)) chain.push(node);
  return chain;
}

/** Splits a matrix into the panel's fields. Skew is dropped; a negative determinant becomes flipX. */
export function decompose(m: Matrix): {x: number; y: number; rotation: number; scaleX: number; scaleY: number; flipX: boolean} {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c;
  const flipX = det < 0;
  // With a flip the first column points the other way; the rotation is read from the unflipped axis.
  const rotation = normalizeDegrees((-Math.atan2(flipX ? -b : b, flipX ? -a : a) * 180) / Math.PI);
  return {x: e, y: f, rotation, scaleX: Math.hypot(a, b), scaleY: Math.hypot(c, d), flipX};
}

/** −180 < degrees ≤ 180, with tiny float noise snapped to whole hundredths. */
export function normalizeDegrees(degrees: number): number {
  let d = ((degrees % 360) + 360) % 360;
  if (d > 180) d -= 360;
  const rounded = Math.round(d * 100) / 100;
  return Object.is(rounded, -0) || rounded === -180 ? Math.abs(rounded) : rounded;
}
