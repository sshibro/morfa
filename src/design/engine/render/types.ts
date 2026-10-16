import type {DesignDocument, Matrix, NodeId, VectorPath} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import type {FontRegistry, ImageCache, RenderOptions} from '../contracts';
import type {AnyCanvas, CanvasPool, Ctx2D} from './canvas';

/** What `paintNodeTree` needs besides the target. */
export type PaintOptions = {
  images: ImageCache;
  fonts: FontRegistry;
  /** Device-pixel rectangle of the target worth painting (default: the whole canvas). */
  clip?: Rect;
  /** Not painted, with their subtrees. */
  hidden?: ReadonlySet<NodeId>;
  /** "Outline mode": 1 device-px outlines, text as boxes, no fills or effects. */
  outlines?: boolean;
  /** Layout grids of frames over their content. */
  layoutGrids?: boolean;
  /** Paint the roots even when hidden (exporting a hidden layer). */
  paintHiddenRoots?: boolean;
  /** Result paths of a BOOLEAN_OPERATION (the boolean geometry module). Without it the renderer
   *  composites the children's silhouettes, which fills correctly but cannot stroke the result. */
  booleanGeometry?: (doc: DesignDocument, id: NodeId) => readonly VectorPath[] | null;
  /** Page-space bounds and mask facts from a spatial index synced to `doc`: culling then never
   *  measures, and large containers visit only the children inside the area. */
  index?: SceneIndex;
  /** Skip nodes whose painted box is smaller than this many device px on both axes (default 0). */
  minSize?: number;
  /** Draw text smaller than this many device px as soft bars (default 0: always glyphs). */
  greekBelow?: number;
  /** Told about every picture and font family the paint used (tile invalidation). */
  onUse?: {image(ref: string, ready: boolean): void; font(family: string): void};
  /** Multiplies the roots' opacity (a live node drawn outside its translucent group). */
  rootOpacity?: number;
};

/** The read side of the spatial index the painter uses (src/design/engine/render/spatial-index.ts). */
export interface SceneIndex {
  /** Page-space bounds of what the node and its subtree paint, or undefined if it paints nothing. */
  bounds(id: NodeId): Rect | undefined;
  /** Ids whose bounds meet `rect` (any depth). */
  query(rect: Rect): NodeId[];
  /** True when some child of the container is a mask (children must then be visited in full). */
  hasMask(id: NodeId): boolean;
}

/** One canvas the painter draws into: the target, or an offscreen layer. */
export type Surface = {
  ctx: Ctx2D;
  canvas: AnyCanvas;
  /** Page space → surface px. */
  base: Matrix;
  /** Surface px per page px. */
  scale: number;
  /** Surface-px rectangle worth painting. */
  clip: Rect;
};

/** A canvas transform in setTransform order. */
export type Affine = {a: number; b: number; c: number; d: number; e: number; f: number};

export type {AnyCanvas, CanvasPool, Ctx2D};

/** RenderOptions plus what the tile renderer adds (docs: the store passes `live` while dragging). */
export type SceneRenderOptions = RenderOptions & {
  /** Optional: `doc` differs from `changes.from` only at `changes.ids` (node ids the patches since
   *  `from` touched). The renderer then skips comparing every node of the file by identity. */
  changes?: {from: DesignDocument; ids: Iterable<NodeId>};
};
