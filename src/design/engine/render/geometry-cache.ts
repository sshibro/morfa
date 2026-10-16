import type {PathCommand, SceneNode, VectorPath} from '../../../../shared/design/types';
import {nodeGeometry} from '../../../../shared/design/shapes';
import {hasOpenPath} from '../../../../shared/design/bounds';
import {hasVariableWidth, variableWidthOutline} from '../../../../shared/design/stroke-profile';
import {roundedRectCommands} from './stroke-math';

// Path2D objects for node outlines. Documents are immutable, so a node object is its own cache key:
// an edited node is a new object and misses, an untouched one hits every frame.

export type NodeShape = {
  /** One path per winding rule (almost always exactly one). */
  parts: {path: Path2D; rule: CanvasFillRule}[];
  /** All commands, for markers and silhouettes. */
  commands: PathCommand[];
  /** Has a free end: strokes are centred and markers apply. */
  open: boolean;
  /** "Everything but the shape" can be clipped with an even-odd frame around it. True for one
   *  simple outline, or even-odd paths, where that inversion is exact. */
  invertible: boolean;
  /** Rectangle-like outline with these radii [tl, tr, br, bl], or an ellipse, for exact spread. */
  rect: [number, number, number, number] | null;
  ellipse: boolean;
};

export function appendCommands(path: Path2D, commands: readonly PathCommand[]): void {
  for (const c of commands) {
    switch (c.type) {
      case 'M': path.moveTo(c.x, c.y); break;
      case 'L': path.lineTo(c.x, c.y); break;
      case 'C': path.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y); break;
      case 'Q': path.quadraticCurveTo(c.x1, c.y1, c.x, c.y); break;
      case 'Z': path.closePath(); break;
    }
  }
}

export function pathOf(commands: readonly PathCommand[]): Path2D {
  const path = new Path2D();
  appendCommands(path, commands);
  return path;
}

const RECT_TYPES = new Set(['RECTANGLE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

/** Corner radii [tl, tr, br, bl] of a rectangle-like node. */
export function cornerRadii(node: SceneNode): [number, number, number, number] {
  const radii = node.rectangleCornerRadii;
  if (radii && radii.length === 4) return [radii[0], radii[1], radii[2], radii[3]];
  const r = node.cornerRadius ?? 0;
  return [r, r, r, r];
}

const isFullEllipse = (node: SceneNode) => {
  const arc = node.arcData;
  return !arc || (!arc.innerRadius && Math.abs(Math.abs(arc.endingAngle - arc.startingAngle) - 2 * Math.PI) < 1e-6);
};

function build(paths: readonly VectorPath[], node: SceneNode | null): NodeShape {
  const groups = new Map<CanvasFillRule, Path2D>();
  const commands: PathCommand[] = [];
  let subpaths = 0;
  for (const vectorPath of paths) {
    const rule: CanvasFillRule = vectorPath.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero';
    let path = groups.get(rule);
    if (!path) groups.set(rule, (path = new Path2D()));
    appendCommands(path, vectorPath.commands);
    for (const c of vectorPath.commands) {
      commands.push(c);
      if (c.type === 'M') subpaths++;
    }
  }
  const parts = [...groups].map(([rule, path]) => ({rule, path}));
  const simpleType = !!node && (RECT_TYPES.has(node.type) || node.type === 'ELLIPSE' || node.type === 'POLYGON' || node.type === 'STAR');
  return {
    parts,
    commands,
    open: node ? hasOpenPath(node) : false,
    invertible: (parts.length === 1 && parts[0].rule === 'evenodd') || (simpleType && subpaths <= 1),
    rect: node && RECT_TYPES.has(node.type) && !node.cornerSmoothing ? cornerRadii(node) : null,
    ellipse: !!node && node.type === 'ELLIPSE' && isFullEllipse(node),
  };
}

const shapes = new WeakMap<SceneNode, NodeShape | null>();
const resolved = new WeakMap<readonly VectorPath[], NodeShape>();

/** Rectangle-like outlines by what they are made of. A moved or recoloured node is a new object, but its
 *  outline is the same: nudging 800 rectangles reuses their paths instead of building 800 new ones.
 *  Shapes are never changed after `build`, so nodes of the same size and corners share one. */
const rectShapes = new Map<string, NodeShape>();
const RECT_SHAPES_MAX = 4096;

function rectKey(node: SceneNode): string {
  const radii = node.rectangleCornerRadii;
  return `${node.width}|${node.height}|${node.cornerRadius ?? ''}|${radii ? radii.join(',') : ''}|${node.cornerSmoothing ?? ''}`;
}

/** The node's outline, or null for nodes without one (groups, text, slices, pages). */
export function shapeOf(node: SceneNode): NodeShape | null {
  let shape = shapes.get(node);
  if (shape === undefined) {
    if (RECT_TYPES.has(node.type)) {
      const key = rectKey(node);
      shape = rectShapes.get(key) ?? null;
      if (!shape) {
        shape = build(nodeGeometry(node), node);
        if (rectShapes.size >= RECT_SHAPES_MAX) rectShapes.delete(rectShapes.keys().next().value!);
        rectShapes.set(key, shape);
      }
    } else {
      const paths = nodeGeometry(node);
      shape = paths.length ? build(paths, node) : null;
    }
    shapes.set(node, shape);
  }
  return shape;
}

/** Paths computed elsewhere (boolean operation results), cached by the array's identity. */
export function shapeOfPaths(paths: readonly VectorPath[], node: SceneNode): NodeShape {
  let shape = resolved.get(paths);
  if (!shape) resolved.set(paths, (shape = build(paths, node)));
  return shape;
}

/** The outline grown (spread > 0) or shrunk (< 0) by `spread` px, for rectangles and ellipses
 *  where that is exact. Null when the shape has no exact offset (use a silhouette instead). */
export function spreadPath(node: SceneNode, shape: NodeShape, spread: number): Path2D | null {
  if (!spread) return shape.parts.length === 1 ? shape.parts[0].path : null;
  const w = node.width + 2 * spread, h = node.height + 2 * spread;
  if (w <= 0 || h <= 0) return new Path2D();
  if (shape.rect) {
    const radii = shape.rect.map(r => (r > 0 ? Math.max(0, r + spread) : 0)) as [number, number, number, number];
    return pathOf(roundedRectCommands({x: -spread, y: -spread, width: w, height: h}, radii));
  }
  if (shape.ellipse) {
    const path = new Path2D();
    path.ellipse(node.width / 2, node.height / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
    return path;
  }
  return null;
}

const variableStrokes = new WeakMap<SceneNode, Path2D | null>();

/** The filled pieces of a variable width stroke ("Width profile", shared/design/stroke-profile.ts), or null when the
 *  node strokes plainly. Cached per node object. */
export function variableStrokeOf(node: SceneNode): Path2D | null {
  let path = variableStrokes.get(node);
  if (path === undefined) {
    const outline = hasVariableWidth(node) ? variableWidthOutline(node) : [];
    path = outline.length ? pathOf(outline.flatMap(each => each.commands)) : null;
    variableStrokes.set(node, path);
  }
  return path;
}
