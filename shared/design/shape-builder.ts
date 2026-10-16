import polygonClipping from 'polygon-clipping';
import type {MultiPolygon, Polygon} from 'polygon-clipping';
import type {DesignDocument, NodeId, SceneNode, Vec, VectorPath} from './types';
import {IDENTITY, localMatrix} from './geometry';
import {transformPaths} from './paths';
import {nodeGeometry} from './shapes';
import {booleanGeometry, booleanTolerance, curvedArrangement, vectorFromPaths} from './boolean';

// Figma's Shape builder (help.figma.com "Create custom shapes with the shape builder tool"): the
// selected shapes cut one another into regions — every piece of the plane that the same shapes cover. A click on a region
// moves it into a layer of its own, a drag across regions merges them into one, and ⌥-click takes a region away from
// every shape. It is destructive, as Figma's: a shape that loses a region becomes a vector of what is left (one step of
// ⌘Z brings it back), a shape left with nothing goes. Curves stay curves: the regions are cut from the shapes' own
// outlines and turned back into their arcs (shared/design/boolean.ts `curvedArrangement`).

export const SHAPE_BUILDER_TYPES: ReadonlySet<SceneNode['type']> = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'BOOLEAN_OPERATION']);

export const SHAPE_BUILDER_MESSAGES = {
  none: 'Select shapes: rectangles, ellipses, polygons, stars, vectors or boolean groups',
  parents: 'Shapes must be in the same frame or group',
  locked: 'Locked and hidden layers are not changed',
  many: 'Too many shapes for the shape builder: select up to 24',
  failed: 'These shapes could not be split into regions',
} as const;

/** Regions past this are not offered (a hostile pile of shapes would cut the plane into thousands). */
const MAX_REGIONS = 600;
const MAX_SHAPES = 24;

export type BuilderRegion = {
  /** Indexes into `operands` of the shapes covering it. */
  owners: number[];
  /** In the parent's space. */
  polygon: Polygon;
  bounds: {x0: number; y0: number; x1: number; y1: number};
};

export type BuilderPlan = {
  /** Shapes that keep a part: the vector of that part takes their place. */
  replace: {id: NodeId; node: SceneNode}[];
  /** Shapes left with nothing. */
  remove: NodeId[];
  /** The merged or extracted layer, above `above` (a shape of the operation, the topmost it took from). */
  create: {node: SceneNode; above: NodeId} | null;
};

export type ShapeBuilder = {
  parentId: NodeId;
  /** Bottom to top. */
  operands: NodeId[];
  regions: BuilderRegion[];
  /** The region under a point of the parent's space, or -1. */
  hit(point: Vec): number;
  /** Merge (a click or a drag) or take away (⌥) these regions. Null when nothing would change. */
  plan(regions: readonly number[], mode: 'merge' | 'subtract'): BuilderPlan | null;
};

/** Paths of a shape in its parent's space. */
function shapePaths(doc: DesignDocument, node: SceneNode): VectorPath[] {
  const local = node.type === 'BOOLEAN_OPERATION' ? booleanGeometry(doc, node.id) : nodeGeometry(node);
  return transformPaths(local, localMatrix(node));
}

const snapTo = (step: number) => (area: MultiPolygon): MultiPolygon =>
  area.map(polygon => polygon.map(ring => ring.map(([x, y]) => [Math.round(x / step) * step, Math.round(y / step) * step] as [number, number])));

/** polygon-clipping, retried on coordinates snapped to a grid when nearly coincident edges (two pieces of one arc
 *  flattened apart) trip it, as shared/design/boolean.ts does; throws only when every grid fails. */
function clip(operation: 'union' | 'intersection' | 'difference', a: MultiPolygon, ...rest: MultiPolygon[]): MultiPolygon {
  const run = (first: MultiPolygon, others: MultiPolygon[]): MultiPolygon => {
    const parts = [first, ...others].filter(each => each.length);
    if (operation === 'union') return parts.length ? polygonClipping.union(parts[0], ...parts.slice(1)) : [];
    if (!first.length) return [];
    if (operation === 'difference') return others.some(each => each.length) ? polygonClipping.difference(first, ...others.filter(each => each.length)) : first;
    return others.every(each => each.length) ? polygonClipping.intersection(first, ...others) : [];
  };
  let failure: unknown;
  for (const step of [0, 1e-6, 1e-4, 1e-2]) {
    try {
      if (!step) return run(a, rest);
      const snap = snapTo(step);
      return run(snap(a), rest.map(snap));
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

function ringPerimeter(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  return sum;
}

function ringArea(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(sum / 2);
}

function insideRing(ring: readonly (readonly number[])[], p: Vec): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > p.y) !== (by > p.y) && p.x < ((bx - ax) * (p.y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

const insidePolygon = (polygon: Polygon, p: Vec) => insideRing(polygon[0], p) && !polygon.slice(1).some(hole => insideRing(hole, p));

function boundsOf(polygon: Polygon): BuilderRegion['bounds'] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of polygon[0]) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return {x0, y0, x1, y1};
}

/** The shape builder for these layers, or a message saying why it cannot start. */
export function shapeBuilder(doc: DesignDocument, ids: readonly NodeId[]): ShapeBuilder | {error: string} {
  const nodes = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && SHAPE_BUILDER_TYPES.has(node.type));
  if (!nodes.length) return {error: SHAPE_BUILDER_MESSAGES.none};
  if (nodes.length > MAX_SHAPES) return {error: SHAPE_BUILDER_MESSAGES.many};
  const parentId = nodes[0].parentId;
  if (!parentId || nodes.some(node => node.parentId !== parentId)) return {error: SHAPE_BUILDER_MESSAGES.parents};
  if (nodes.some(node => node.locked || !node.visible)) return {error: SHAPE_BUILDER_MESSAGES.locked};
  const order = doc.nodes[parentId]?.children ?? [];
  const sorted = [...nodes].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const operands = sorted.map(node => node.id);
  const paths = sorted.map(node => shapePaths(doc, node));
  let extent = 1;
  for (const node of sorted) extent = Math.max(extent, node.width, node.height);
  const tolerance = booleanTolerance(extent, extent);
  const {areas, toPaths} = curvedArrangement(paths, tolerance);

  try {
    return arrange(doc, parentId, operands, areas, toPaths, tolerance);
  } catch {
    return {error: SHAPE_BUILDER_MESSAGES.failed};
  }
}

function arrange(
  doc: DesignDocument, parentId: NodeId, operands: NodeId[], areas: MultiPolygon[], toPaths: (area: MultiPolygon) => VectorPath[], tolerance: number,
): ShapeBuilder {
  // The plane cut by every shape: each piece remembers the shapes over it.
  let atoms: {owners: number[]; area: MultiPolygon}[] = [];
  areas.forEach((area, k) => {
    if (!area.length) return;
    const next: typeof atoms = [];
    for (const atom of atoms) {
      const inside = clip('intersection', atom.area, area);
      const outside = clip('difference', atom.area, area);
      if (inside.length) next.push({owners: [...atom.owners, k], area: inside});
      if (outside.length) next.push({owners: atom.owners, area: outside});
    }
    const fresh = atoms.length ? clip('difference', area, ...atoms.map(atom => atom.area)) : area;
    if (fresh.length) next.push({owners: [k], area: fresh});
    atoms = next;
  });
  const minArea = tolerance * tolerance * 4;
  const regions: BuilderRegion[] = [];
  for (const atom of atoms) {
    for (const polygon of atom.area) {
      const area = ringArea(polygon[0]) - polygon.slice(1).reduce((sum, hole) => sum + ringArea(hole), 0);
      // Specks, and the hairline slivers two pieces of one curve flattened apart leave between them.
      if (area <= minArea || area / ringPerimeter(polygon[0]) < tolerance * 4) continue;
      regions.push({owners: atom.owners, polygon, bounds: boundsOf(polygon)});
      if (regions.length >= MAX_REGIONS) break;
    }
  }

  const hit = (p: Vec) => {
    for (let k = 0; k < regions.length; k++) {
      const {bounds} = regions[k];
      if (p.x < bounds.x0 || p.x > bounds.x1 || p.y < bounds.y0 || p.y > bounds.y1) continue;
      if (insidePolygon(regions[k].polygon, p)) return k;
    }
    return -1;
  };

  const plan = (chosen: readonly number[], mode: 'merge' | 'subtract'): BuilderPlan | null => {
    const picked = [...new Set(chosen)].filter(k => regions[k]);
    if (!picked.length) return null;
    const pieces = picked.map(k => [regions[k].polygon] as MultiPolygon);
    const cut: MultiPolygon = clip('union', pieces[0], ...pieces.slice(1));
    const touched = [...new Set(picked.flatMap(k => regions[k].owners))].sort((a, b) => a - b);
    // A merge of exactly what one shape already is (a lone shape, or every region of a shape and nothing else) changes nothing.
    if (mode === 'merge' && touched.length === 1) {
      const whole = regions.every((region, k) => !region.owners.includes(touched[0]) || picked.includes(k));
      const others = regions.some(region => region.owners.length > 1 && region.owners.includes(touched[0]));
      if (whole && !others) return null;
    }
    const out: BuilderPlan = {replace: [], remove: [], create: null};
    for (const k of touched) {
      const node = doc.nodes[operands[k]];
      const rest = clip('difference', areas[k], cut);
      if (!rest.length) {
        out.remove.push(node.id);
        continue;
      }
      out.replace.push({id: node.id, node: vectorFromPaths(node, toPaths(rest), IDENTITY, parentId, {sourceMatrix: localMatrix(node)})});
    }
    if (mode === 'merge') {
      // The new layer looks like the topmost shape it took from, as Figma's merge does, and stands just above it.
      const top = doc.nodes[operands[touched[touched.length - 1]]];
      out.create = {node: vectorFromPaths(top, toPaths(cut), IDENTITY, parentId, {sourceMatrix: localMatrix(top)}), above: top.id};
    }
    return out;
  };

  return {parentId, operands, regions, hit, plan};
}
