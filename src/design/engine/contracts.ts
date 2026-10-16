import type {DesignDocument, ImageRef, NodeId, RGB} from '../../../shared/design/types';
import type {FontSpec, TextMeasurer} from '../../../shared/design/text-layout';
import type {Matrix} from '../../../shared/design/types';

// Interfaces between the engine's parts (docs/design-tool.md §Client engine). The store, the
// renderer, fonts and images are built separately and meet here.

/** `x`/`y`: the page point at the canvas's top-left corner; screen = (page − {x, y}) · zoom, in CSS px. */
export type Viewport = {x: number; y: number; zoom: number};
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 256;

export type RenderOptions = {
  doc: DesignDocument;
  pageId: NodeId;
  viewport: Viewport;
  /** CSS px of the canvas element. */
  size: {width: number; height: number};
  dpr: number;
  /** Not drawn (e.g. the text being edited, which its editor draws). */
  hidden?: ReadonlySet<NodeId>;
  /** Draw every shape as a 1 px outline ("Outline mode", ⌘Y). */
  outlines?: boolean;
  /** Show layout grids of frames (⌃G). */
  layoutGrids?: boolean;
  /** Pixel preview: render at 1× and scale up without smoothing. */
  pixelPreview?: boolean;
  /** A board's dot grid under everything (render/dot-grid.ts); the canvas only, never export. */
  dotGrid?: boolean;
  /** The canvas of a page without a colour of its own: the editor theme's default (`defaultPageBackground`);
   *  the light #F5F5F5 when absent. A page's own `backgroundColor` always wins. */
  background?: RGB;
  /** Frame titles above top-level frames, sections and components; selected ones in accent colour. `editing`: the
   *  title being renamed on the canvas, whose name (a section's whole chip) is left to the rename field. */
  labels?: {selected: ReadonlySet<NodeId>; editing?: NodeId | null};
  /** Nodes under a gesture (dragged, resized, edited): drawn every frame over the cached picture,
   *  which leaves them out, so moving one object never repaints the rest (docs §Performance). */
  live?: ReadonlySet<NodeId>;
  /** Live nodes drawn above everything and outside their ancestors' clips while they move (a layer
   *  lifted out of an auto-layout frame by a drag, as Figma shows it). */
  lifted?: ReadonlySet<NodeId>;
};

export interface SceneRenderer {
  /** Draws the page. Cheap to call every frame: it skips work when nothing changed. */
  render(options: RenderOptions): void;
  /** Forget cached drawings (after fonts or images arrive). */
  invalidate(): void;
  dispose(): void;
}

export type PaintTarget = {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** Page space → device pixels of the target. */
  transform: Matrix;
  /** Device-pixel scale of `transform` (for blur radii and hairlines). */
  scale: number;
};

export interface ImageCache {
  /** The decoded picture, or null while it loads (a load triggers `onChange`). */
  get(ref: ImageRef, doc: DesignDocument): CanvasImageSource | null;
  /** Natural size, if known. */
  size(ref: ImageRef, doc: DesignDocument): {width: number; height: number} | null;
  /** Resolves when every picture used under `rootId` is decoded or failed (export waits on it). */
  whenReady(doc: DesignDocument, rootId: NodeId): Promise<void>;
  onChange(listener: () => void): () => void;
}

export type FontFamilyInfo = {family: string; weights: number[]; italic: boolean; source: 'catalog' | 'local'; kind?: string};

export interface FontRegistry {
  /** Measures with what is loaded now; falls back to the family's fallback metrics while loading. */
  readonly measurer: TextMeasurer;
  /** Starts loading a face; resolves when it is usable on canvas (or failed, then the fallback stays). */
  ensure(spec: FontSpec): Promise<void>;
  isLoaded(spec: FontSpec): boolean;
  families(): FontFamilyInfo[];
  /** CSS font shorthand for canvas `ctx.font`. */
  cssFont(spec: FontSpec): string;
  /** Fires when any face finishes loading (text must be re-laid-out and redrawn). */
  onLoad(listener: (family: string) => void): () => void;
}
