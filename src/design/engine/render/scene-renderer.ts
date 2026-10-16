import type {DesignDocument, Matrix, NodeId, SceneNode, VectorPath} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import {clipsChildren} from '../../../../shared/design/bounds';
import {pageBackground} from '../../../../shared/design/defaults';
import type {FontRegistry, ImageCache, SceneRenderer} from '../contracts';
import {isDesignImageCache} from '../images';
import {cssColor} from './blend';
import type {AnyCanvas} from './canvas';
import {context2d, createCanvas} from './canvas';
import {shapeOf} from './geometry-cache';
import {drawLabels} from './overlays';
import {affineOf, canvasPool, clearEffectCache, paintNodeTree, worldOfNode, type PaintOptions} from './painter';
import type {ChangeHint} from './spatial-index';
import {SpatialIndex} from './spatial-index';
import {GREEK_BELOW_PX} from './text-math';
import type {TilePlace} from './tile-math';
import {levelKey, levelScale, placeRects, planFallback, TILE, tileBudgetBytes, tileKey, tileRange, tileScreenRect, tilesByDistance} from './tile-math';
import type {Ctx2D, SceneRenderOptions} from './types';
import {EngineUnsupported, engineFor, withEngine} from '../../../../shared/design/engine-switch';
import {renderWasm, renderWasmLoaded} from '../../../../shared/design/render-engine';
import {paintDotGrid} from './dot-grid';

// The GPU renderer's chunk, loaded when the render module runs on the GPU (a module-level thunk: tests/design-lazy-imports).
const loadGpuSceneRenderer = () => import('./gpu/gpu-scene-renderer');

// The canvas renderer (docs/design-tool.md §Performance): the page is rasterized into 512 px tiles
// per raster scale and cached. A steady pan or zoom only composites cached tiles; nothing is
// painted. While a zoom gesture runs, the tiles of the nearest cached scale are drawn stretched
// (briefly soft) and the visible tiles of the new scale are rasterized a few per frame, within a
// time budget, nearest the centre first, until the picture is sharp again; where one tile alone
// takes longer than that budget, they wait until the zoom settles. An edit re-rasterizes
// only the tiles under the bounds (old and new) of the nodes whose objects changed, found by the
// spatial index. Nodes under a gesture (`live`) are left out of the tiles and painted every frame
// on top, so dragging one object never re-rasterizes the rest. Rasterizing a tile is a pure
// function of (document, page, tile, scale) through `paintNodeTree`, ready to move to a worker.

export type SceneRendererDeps = {
  images: ImageCache;
  fonts: FontRegistry;
  booleanGeometry?: (doc: DesignDocument, id: NodeId) => readonly VectorPath[] | null;
};

export type RenderStats = {
  /** Time the last `render` call took, ms. */
  frameMs: number;
  /** Tiles rasterized by the last call and still missing or stale in view. */
  rastered: number;
  pending: number;
  /** Cached tiles and their memory. */
  tiles: number;
  tileBytes: number;
  /** The raster scale of the last frame and whether the picture is final (sharp and complete). */
  level: number;
  complete: boolean;
  /** Where the last frame's time went, ms (`RenderPhases`). */
  phases?: RenderPhases;
  /** The renderer wasm's memory (its document, pictures and sprites), for the memory budget; absent on Canvas2D. */
  wasmBytes?: number;
};

/** A frame's time by phase, ms: `sync` (the index and the renderer's own document brought to the new one), `raster`
 *  (tiles painted, `sprites` of it: text painted by Canvas2D for the GPU renderer), `frame` (composited and presented:
 *  Canvas2D's tile copies, or the GPU frame encoded and submitted), `titles` (frame titles). */
export type RenderPhases = {sync: number; raster: number; sprites: number; frame: number; titles: number};

/** Bench only (scripts/bench/canvas.ts sets it before a pan): each drawn frame's phases are appended. */
export function notePhases(engine: 'canvas2d' | 'gpu', phases: RenderPhases): void {
  const sink = (globalThis as {__morfaRenderPhases?: (RenderPhases & {engine: string})[]}).__morfaRenderPhases;
  if (sink) sink.push({engine, ...phases});
}

export interface DesignSceneRenderer extends SceneRenderer {
  render(options: SceneRenderOptions): void;
  /** The page's spatial index as of the last sync (`render` or `indexFor`). */
  readonly index: SpatialIndex;
  /** The spatial index synced to `doc` now (hit testing between frames; CanvasView's `spatialIndex`).
   *  Syncing goes through the renderer so the tiles under what changed are marked as well. */
  indexFor(doc: DesignDocument, pageId: NodeId): SpatialIndex;
  /** Feed of the store's document changes (`store.onDocument`): the next sync then compares only
   *  the reported ids instead of every node. Missing a change is safe (a full comparison runs). */
  documentChanged(change: {doc: DesignDocument; changed: ReadonlySet<NodeId>}): void;
  stats(): RenderStats;
}

/** `dirty` with `rects`: only those parts are stale (tile px, whole pixels); with `rects` null the whole tile is. */
type Tile = {i: number; j: number; canvas: AnyCanvas; ctx: Ctx2D; dirty: boolean; rects: Rect[] | null; used: number; pendingImages: Set<string> | null};
type Level = {scale: number; tiles: Map<string, Tile>};

const SETTLE_MS = 140;
const BUDGET_MS = 8;
/** Nothing is on screen yet: fewer, longer frames finish the first picture sooner. */
const FIRST_PAINT_BUDGET_MS = 120;
const TILE_BYTES = TILE * TILE * 4;
/** A tile whose stale parts add up to more than this share of it (or are this many) is repainted whole. */
const PARTIAL_MAX_SHARE = 0.5;
const PARTIAL_MAX_RECTS = 8;
/** What a part repaints is chosen from what lies within this many px of it (inside the tile, as a whole repaint
 *  chooses from the tile): at small zooms a hairline or an edge's anti-aliasing reaches a pixel past a node's bounds,
 *  and the node must still paint that pixel when it falls inside the part. */
const PARTIAL_CULL_MARGIN = 4;
/** The finest other level that may stand in for a missing tile: 16× this one's scale. */
const MAX_FALLBACK_RATIO = 16;
const EMPTY: ReadonlySet<NodeId> = new Set();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const raf = (callback: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : (setTimeout(callback, 16) as unknown as number);
const cancelRaf = (handle: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle));

/** The scene renderer behind the engine switch's `render` module (shared/design/engine-switch.ts): Canvas2D (`ts`,
 *  the default and the engine for browsers without WebGPU) or the GPU renderer of crates/render on WebGPU (`wasm`,
 *  when `loadRenderWasm` of src/design/engine/render-wasm.ts installed it and a renderer could be made on the
 *  canvas: `withEngine('render', 'createSceneRenderer')`, else a counted fallback to Canvas2D). The renderer is made
 *  asynchronously by the GPU path (a WebGPU device is awaited), so the switch hands out a Canvas2D renderer at once
 *  and the caller swaps once `createSceneRendererAsync` resolves; `both` keeps Canvas2D drawing and compares tiles by
 *  SSIM through the oracle of gpu/tile-oracle.ts. */
export function createSceneRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, deps: SceneRendererDeps): DesignSceneRenderer {
  return withEngine('render', 'createSceneRenderer', () => createCanvasSceneRenderer(canvas, deps), () => {
    // The GPU renderer is made asynchronously (createSceneRendererAsync); a synchronous ask gets Canvas2D, counted.
    if (!renderWasmLoaded()) throw new EngineUnsupported('the renderer wasm is not loaded');
    throw new EngineUnsupported('the GPU renderer is made with createSceneRendererAsync');
  }, {equal: () => null});
}

/** The GPU renderer on `canvas`, or why there is none (the render module is not `wasm`, the module is not loaded, no
 *  WebGPU). `canvas` must never have given a 2d context: a canvas that did never gives a webgpu one. */
async function createGpuRendererOn(canvas: HTMLCanvasElement, deps: SceneRendererDeps): Promise<{renderer: DesignSceneRenderer} | {reason: string}> {
  if (engineFor('render') !== 'wasm') return {reason: `render module is ${engineFor('render')}`};
  if (!renderWasmLoaded()) return {reason: 'the renderer wasm is not loaded (no WebGPU, or the chunk failed to load)'};
  try {
    const wasm = renderWasm();
    if (!wasm.GpuRenderer) throw new Error('this build of the renderer has no GPU path');
    const {atlasCapacity, createGpuSceneRenderer} = await loadGpuSceneRenderer();
    const deviceMemory = typeof navigator !== 'undefined' ? (navigator as {deviceMemory?: number}).deviceMemory : undefined;
    const capacity = atlasCapacity(deviceMemory);
    const gpu = await wasm.GpuRenderer.create(canvas, capacity);
    return {renderer: withEngine('render', 'createSceneRenderer', () => createCanvasSceneRenderer(canvas, deps), () => createGpuSceneRenderer(canvas, {...deps, wasm, gpu, capacity}), {equal: () => null})};
  } catch (error) {
    return {reason: error instanceof Error ? error.message : String(error)};
  }
}

/** The GPU renderer when the render module is `wasm` and the browser has WebGPU and the module is loaded; Canvas2D
 *  otherwise (and the reason, for the editor's status). `canvas` must not have a 2d context yet. */
export async function createSceneRendererAsync(canvas: HTMLCanvasElement, deps: SceneRendererDeps): Promise<{renderer: DesignSceneRenderer; engine: 'canvas2d' | 'gpu'; reason?: string}> {
  const made = await createGpuRendererOn(canvas, deps);
  return 'renderer' in made ? {renderer: made.renderer, engine: 'gpu'} : {renderer: createCanvasSceneRenderer(canvas, deps), engine: 'canvas2d', reason: made.reason};
}

/** A canvas like `canvas` (its inline style and aria-hidden; its classes once it shows), not in the document yet. */
function siblingCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const made = canvas.ownerDocument?.createElement('canvas');
  if (!made) return null;
  made.style.cssText = canvas.style.cssText;
  const hidden = canvas.getAttribute('aria-hidden');
  if (hidden !== null) made.setAttribute('aria-hidden', hidden);
  return made;
}

/** A renderer that starts as Canvas2D at once and swaps to the GPU renderer when one can be made (the render module
 *  `wasm` on a WebGPU browser); every call delegates to the current one. `engine()` says which is drawing, `whenReady`
 *  resolves once the choice is made. Canvas2D takes the scene canvas's 2d context on its first line, and a canvas with
 *  a 2d context never gives a webgpu one, so the GPU renderer is made on a canvas of its own, put just before the scene
 *  canvas and hidden while the GPU renderer is made (it puts its titles canvas next to its own, so its own must be in
 *  the document by then). When the GPU renderer takes over, its canvas shows and the scene canvas hides; it follows the
 *  scene's CSS size on every frame and leaves the document on dispose, or at once when the GPU path is declined. The
 *  scene canvas stays Canvas2D's, for the fallback. */
export function createSwitchingSceneRenderer(canvas: HTMLCanvasElement, deps: SceneRendererDeps): DesignSceneRenderer & {engine(): 'canvas2d' | 'gpu'; reason(): string | undefined; whenReady: Promise<void>} {
  let current: DesignSceneRenderer = createCanvasSceneRenderer(canvas, deps);
  let engine: 'canvas2d' | 'gpu' = 'canvas2d';
  let reason: string | undefined;
  let disposed = false;
  let lastOptions: SceneRenderOptions | null = null;
  const gpuCanvas = engineFor('render') === 'wasm' ? siblingCanvas(canvas) : null;
  let sceneDisplay: string | null = null;
  if (gpuCanvas) {
    gpuCanvas.style.display = 'none';
    canvas.before(gpuCanvas);
  }
  const sizeGpuCanvas = (options: SceneRenderOptions) => {
    if (!gpuCanvas || engine !== 'gpu') return;
    const width = `${options.size.width}px`, height = `${options.size.height}px`;
    if (gpuCanvas.style.width !== width) gpuCanvas.style.width = width;
    if (gpuCanvas.style.height !== height) gpuCanvas.style.height = height;
  };
  const made = gpuCanvas ? createGpuRendererOn(gpuCanvas, deps) : Promise.resolve({reason: `render module is ${engineFor('render')}`});
  const whenReady = made.then(result => {
    if (disposed || !('renderer' in result)) {
      if ('renderer' in result) result.renderer.dispose();
      else reason = result.reason;
      gpuCanvas?.remove();
      return;
    }
    const previous = current;
    current = result.renderer;
    engine = 'gpu';
    previous.dispose();
    sceneDisplay = canvas.style.display;
    // Its classes too, now: whoever looks the scene canvas up by its class (the eyedropper) finds the one that draws.
    gpuCanvas!.className = canvas.className;
    gpuCanvas!.style.display = sceneDisplay;
    canvas.style.display = 'none';
    if (lastOptions) {
      sizeGpuCanvas(lastOptions);
      current.render(lastOptions);
    }
  }).catch(error => {
    reason = error instanceof Error ? error.message : String(error);
    if (engine !== 'gpu') gpuCanvas?.remove();
  });
  return {
    get index() {
      return current.index;
    },
    render(options) {
      lastOptions = options;
      sizeGpuCanvas(options);
      current.render(options);
    },
    indexFor: (doc, pageId) => current.indexFor(doc, pageId),
    documentChanged: change => current.documentChanged(change),
    invalidate: () => current.invalidate(),
    dispose() {
      disposed = true;
      current.dispose();
      gpuCanvas?.remove();
      if (sceneDisplay !== null) canvas.style.display = sceneDisplay;
      sceneDisplay = null;
    },
    stats: () => current.stats(),
    engine: () => engine,
    reason: () => reason,
    whenReady,
  };
}

/** The Canvas2D scene renderer: tiles on 2D canvases, today's engine. */
export function createCanvasSceneRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, deps: SceneRendererDeps): DesignSceneRenderer {
  const maybe = (canvas as HTMLCanvasElement).getContext('2d', {alpha: false}) as Ctx2D | null;
  if (!maybe) throw new Error('The browser could not draw the canvas: not enough memory for the image.');
  const ctx: Ctx2D = maybe;
  const index = new SpatialIndex();
  const levels = new Map<string, Level>();
  const freeTiles: Tile[] = [];
  const deviceMemory = typeof navigator !== 'undefined' ? (navigator as {deviceMemory?: number}).deviceMemory : undefined;
  const maxTiles = Math.max(24, Math.floor(tileBudgetBytes(deviceMemory) / TILE_BYTES));
  let tileCount = 0;
  let frame = 0;
  let last: SceneRenderOptions | null = null;
  let lastKey: unknown[] = [];
  let needsFrame = true;
  let handle: number | null = null;
  let disposed = false;
  let lastScale = 0;
  let scaleChangedAt = -Infinity;
  let excluded: ReadonlySet<NodeId> = EMPTY;
  let modeKey = '';
  let syncedPage: NodeId | null = null;
  /** The live nodes of the last sync: their tiles leave them out. */
  let syncedLive: ReadonlySet<NodeId> = EMPTY;
  let stats: RenderStats = {frameMs: 0, rastered: 0, pending: 0, tiles: 0, tileBytes: 0, level: 1, complete: false};
  /** How long a tile of the visible ones took to rasterize lately (ms, a running mean). */
  let tileMs = 0;

  const schedule = () => {
    if (handle !== null || disposed) return;
    handle = raf(() => {
      handle = null;
      if (last) render(last, true);
    });
  };

  // ── Tiles ──

  const levelOf = (scale: number): Level => {
    const key = levelKey(scale);
    let level = levels.get(key);
    if (!level) levels.set(key, (level = {scale, tiles: new Map()}));
    return level;
  };

  /** Marks the part of a tile under `px` (level px, whole pixels) stale; the tile keeps showing until re-rasterized. */
  const markTile = (tile: Tile, px: Rect) => {
    const x0 = Math.max(0, px.x - tile.i * TILE), y0 = Math.max(0, px.y - tile.j * TILE);
    const x1 = Math.min(TILE, px.x + px.width - tile.i * TILE), y1 = Math.min(TILE, px.y + px.height - tile.j * TILE);
    if (!(x1 > x0 && y1 > y0)) return;
    if (tile.dirty && !tile.rects) return;
    const part = {x: x0, y: y0, width: x1 - x0, height: y1 - y0};
    if (!tile.dirty) {
      tile.dirty = true;
      tile.rects = [part];
      return;
    }
    const rects = tile.rects!;
    rects.push(part);
    let area = 0;
    for (const r of rects) area += r.width * r.height;
    if (rects.length > PARTIAL_MAX_RECTS || area > PARTIAL_MAX_SHARE * TILE * TILE) tile.rects = null;
  };

  /** Marks every cached tile under a page rectangle stale where it lies under it. */
  const invalidateRect = (rect: Rect) => {
    for (const level of levels.values()) {
      // One device px of slack: anti-aliasing reaches into the neighbouring pixel.
      const grown = {x: rect.x - 1 / level.scale, y: rect.y - 1 / level.scale, width: rect.width + 2 / level.scale, height: rect.height + 2 / level.scale};
      const px0 = Math.floor(grown.x * level.scale), py0 = Math.floor(grown.y * level.scale);
      const px: Rect = {x: px0, y: py0, width: Math.ceil((grown.x + grown.width) * level.scale) - px0, height: Math.ceil((grown.y + grown.height) * level.scale) - py0};
      const {i0, j0, i1, j1} = tileRange(grown, level.scale);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > level.tiles.size) {
        for (const tile of level.tiles.values()) if (tile.i >= i0 && tile.i <= i1 && tile.j >= j0 && tile.j <= j1) markTile(tile, px);
      } else {
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const tile = level.tiles.get(tileKey(i, j));
          if (tile) markTile(tile, px);
        }
      }
    }
  };

  const dirtyWhole = (tile: Tile) => {
    tile.dirty = true;
    tile.rects = null;
  };

  const invalidateAll = () => {
    for (const level of levels.values()) for (const tile of level.tiles.values()) dirtyWhole(tile);
  };

  const dropTiles = () => {
    for (const level of levels.values()) for (const tile of level.tiles.values()) releaseTile(tile);
    levels.clear();
  };

  function releaseTile(tile: Tile): void {
    tileCount--;
    if (freeTiles.length < 16) freeTiles.push(tile);
    else tile.canvas.width = tile.canvas.height = 1;
  }

  function newTile(i: number, j: number): Tile {
    const reused = freeTiles.pop();
    tileCount++;
    if (reused && reused.canvas.width === TILE) return {...reused, i, j, dirty: true, rects: null, used: frame, pendingImages: null};
    const tileCanvas = createCanvas(TILE, TILE);
    return {i, j, canvas: tileCanvas, ctx: context2d(tileCanvas), dirty: true, rects: null, used: frame, pendingImages: null};
  }

  function evict(): void {
    if (tileCount <= maxTiles) return;
    const candidates: {level: Level; key: string; tile: Tile}[] = [];
    for (const level of levels.values()) for (const [key, tile] of level.tiles) if (tile.used < frame) candidates.push({level, key, tile});
    candidates.sort((a, b) => a.tile.used - b.tile.used);
    for (const {level, key, tile} of candidates) {
      if (tileCount <= maxTiles) break;
      level.tiles.delete(key);
      releaseTile(tile);
    }
    for (const [key, level] of levels) if (!level.tiles.size) levels.delete(key);
  }

  /** Rasterizes one tile: a pure function of the document, page, tile and scale (worker-ready). A tile stale only in
   *  parts repaints just those (`rasterPart`): inside a part every pixel comes out as a whole repaint paints it, and
   *  outside the parts the tile already shows the document as it is. */
  function raster(o: SceneRenderOptions, level: Level, i: number, j: number): Tile {
    const key = tileKey(i, j);
    let tile = level.tiles.get(key);
    if (!tile) level.tiles.set(key, (tile = newTile(i, j)));
    const page = o.doc.nodes[o.pageId];
    const background = cssColor(pageBackground(page, o.background));
    const pending = new Set<string>();
    const scale = level.scale;
    // Background blur reads what is around it: rasterize with that margin so a tile edge never cuts it.
    const margin = Math.min(256, Math.ceil(index.blurMargin * scale));
    if (tile.dirty && tile.rects && !margin) {
      for (const part of tile.rects) rasterPart(o, tile, scale, part, background, pending);
      tile.dirty = false;
      tile.rects = null;
      if (pending.size) for (const ref of tile.pendingImages ?? []) pending.add(ref);
      tile.pendingImages = pending.size ? pending : tile.pendingImages;
      return tile;
    }
    const target = margin ? canvasPool.acquire(TILE + 2 * margin, TILE + 2 * margin) : null;
    const tctx = target ? target.ctx : tile.ctx;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalAlpha = 1;
    tctx.globalCompositeOperation = 'source-over';
    tctx.fillStyle = background;
    tctx.fillRect(0, 0, TILE + 2 * margin, TILE + 2 * margin);
    if (o.dotGrid) paintDotGrid(tctx, {x: (i * TILE - margin) / scale, y: (j * TILE - margin) / scale}, scale, o.dpr > 0 ? o.dpr : 1, TILE + 2 * margin, TILE + 2 * margin);
    const options: PaintOptions = {
      images: deps.images,
      fonts: deps.fonts,
      clip: {x: 0, y: 0, width: TILE + 2 * margin, height: TILE + 2 * margin},
      hidden: excluded,
      outlines: o.outlines,
      layoutGrids: o.layoutGrids,
      booleanGeometry: deps.booleanGeometry,
      index,
      minSize: 0.5,
      greekBelow: GREEK_BELOW_PX,
      onUse: {image: (ref, ready) => { if (!ready) pending.add(ref); }, font: () => {}},
    };
    const base: Matrix = [[scale, 0, -i * TILE + margin], [0, scale, -j * TILE + margin]];
    paintNodeTree({ctx: tctx, transform: base, scale}, o.doc, [o.pageId], options);
    if (target) {
      tile.ctx.setTransform(1, 0, 0, 1, 0, 0);
      tile.ctx.globalCompositeOperation = 'copy';
      tile.ctx.drawImage(target.canvas, margin, margin, TILE, TILE, 0, 0, TILE, TILE);
      tile.ctx.globalCompositeOperation = 'source-over';
      canvasPool.release(target);
    }
    tile.dirty = false;
    tile.rects = null;
    tile.pendingImages = pending.size ? pending : null;
    return tile;
  }

  const cullArea = (part: Rect): Rect => {
    const x = Math.max(0, part.x - PARTIAL_CULL_MARGIN), y = Math.max(0, part.y - PARTIAL_CULL_MARGIN);
    return {x, y, width: Math.min(TILE, part.x + part.width + PARTIAL_CULL_MARGIN) - x, height: Math.min(TILE, part.y + part.height + PARTIAL_CULL_MARGIN) - y};
  };

  // A part is painted on a canvas like the tile's own (its size, its transform, no clip: anti-aliasing depends on
  // all three), with only the nodes that reach it, then copied into the tile.
  let scratch: {canvas: AnyCanvas; ctx: Ctx2D} | null = null;

  function rasterPart(o: SceneRenderOptions, tile: Tile, scale: number, part: Rect, background: string, pending: Set<string>): void {
    if (!scratch) {
      const canvas = createCanvas(TILE, TILE);
      scratch = {canvas, ctx: context2d(canvas)};
    }
    const sctx = scratch.ctx;
    const area = cullArea(part);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over';
    sctx.fillStyle = background;
    sctx.fillRect(area.x, area.y, area.width, area.height);
    // A board's dots under everything, as a whole repaint puts them (whole device px: the same rectangles).
    if (o.dotGrid) paintDotGrid(sctx, {x: (tile.i * TILE) / scale, y: (tile.j * TILE) / scale}, scale, o.dpr > 0 ? o.dpr : 1, TILE, TILE);
    const options: PaintOptions = {
      images: deps.images,
      fonts: deps.fonts,
      clip: {x: 0, y: 0, width: TILE, height: TILE},
      cull: area,
      hidden: excluded,
      outlines: o.outlines,
      layoutGrids: o.layoutGrids,
      booleanGeometry: deps.booleanGeometry,
      index,
      minSize: 0.5,
      greekBelow: GREEK_BELOW_PX,
      onUse: {image: (ref, ready) => { if (!ready) pending.add(ref); }, font: () => {}},
    };
    const base: Matrix = [[scale, 0, -tile.i * TILE], [0, scale, -tile.j * TILE]];
    paintNodeTree({ctx: sctx, transform: base, scale}, o.doc, [o.pageId], options);
    const tctx = tile.ctx;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalAlpha = 1;
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(part.x, part.y, part.width, part.height);
    tctx.drawImage(scratch.canvas, part.x, part.y, part.width, part.height, part.x, part.y, part.width, part.height);
  }

  // ── Documents ──

  // Ids the store reported changed since the index's document (store.onDocument), so a sync costs
  // what changed instead of an identity check of every node.
  let pendingFrom: DesignDocument | null = null;
  let pendingTo: DesignDocument | null = null;
  const pendingIds = new Set<NodeId>();

  /** Brings the index to `doc` and marks the tiles under what changed (old and new bounds) stale. */
  function syncDocument(doc: DesignDocument, pageId: NodeId, live: ReadonlySet<NodeId>, explicit?: ChangeHint): void {
    const hint = explicit ?? (pendingFrom && pendingFrom === index.document && pendingTo === doc ? {from: pendingFrom, ids: pendingIds} : undefined);
    const from = index.document;
    const sync = index.sync(doc, pageId, deps.fonts.measurer, hint);
    // A rebuild leaves the subtrees of clipping roots out of the grid: background slices put them in.
    if (sync.rebuilt) index.completeLater();
    // A sync that left the index where it was keeps the ids gathered since: the loop's frame of the last options (tiles
    // still painting) runs while a newer document waits, and the frame that brings it must not compare every node.
    if (index.document !== from || sync.rebuilt) {
      pendingFrom = pendingTo = null;
      pendingIds.clear();
    }
    if (sync.rebuilt) {
      if (pageId !== syncedPage) dropTiles();
      else invalidateAll();
      needsFrame = true;
    }
    for (const area of sync.dirty) {
      // A node live since the last sync is not in the tiles, old bounds or new. One that turns live with this change
      // (a drag's first move lands in the same commit that makes it live) still is at its old bounds: mark them.
      if (isLive(doc, area.id, live) && isLive(doc, area.id, syncedLive)) continue;
      invalidateRect(area.rect);
      needsFrame = true;
    }
    syncedPage = pageId;
    syncedLive = live;
  }

  // ── Frames ──

  function render(o: SceneRenderOptions, fromLoop = false): void {
    if (disposed) return;
    if (!fromLoop && handle !== null) {
      cancelRaf(handle);
      handle = null;
    }
    const started = now();
    last = o;
    const dpr = o.dpr > 0 ? o.dpr : 1;
    const width = Math.max(1, Math.round(o.size.width * dpr)), height = Math.max(1, Math.round(o.size.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      needsFrame = true;
    }

    const live = o.live ?? EMPTY;
    syncDocument(o.doc, o.pageId, live, o.changes);
    const syncMs = now() - started;
    // Tiles are rasterized on the page's canvas colour: a new colour (the page's own, or the theme's default
    // for a page without one) repaints them like a display mode does.
    const mode = `${!!o.outlines}|${!!o.layoutGrids}|${!!o.dotGrid}|${cssColor(pageBackground(o.doc.nodes[o.pageId], o.background))}`;
    if (mode !== modeKey) {
      if (modeKey) invalidateAll();
      modeKey = mode;
      needsFrame = true;
    }
    const nextExcluded = union(o.hidden, live);
    if (!sameSet(nextExcluded, excluded)) {
      for (const id of symmetricDifference(nextExcluded, excluded)) {
        const rect = index.bounds(id);
        if (rect) invalidateRect(rect);
      }
      excluded = nextExcluded;
      needsFrame = true;
    }

    const zoom = o.viewport.zoom;
    const screen = dpr * zoom;
    const t = now();
    if (screen !== lastScale) {
      lastScale = screen;
      scaleChangedAt = t;
    }
    const settled = t - scaleChangedAt >= SETTLE_MS;
    const pixel = !!o.pixelPreview && zoom > 1;
    const scale = pixel ? 1 : levelScale(screen, settled);

    const key = [o.doc, o.pageId, o.viewport.x, o.viewport.y, zoom, width, height, o.hidden, o.live, o.lifted, o.outlines, o.layoutGrids, o.pixelPreview, o.labels?.selected, o.labels?.editing, scale];
    if (!needsFrame && key.length === lastKey.length && key.every((value, k) => value === lastKey[k])) return;
    lastKey = key;
    needsFrame = false;
    frame++;

    const view: Rect = {x: o.viewport.x, y: o.viewport.y, width: width / screen, height: height / screen};
    const page = o.doc.nodes[o.pageId];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = cssColor(pageBackground(page, o.background));
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = !pixel;
    // Stretched tiles only show between two sharp frames (a zoom in progress, a scale still being
    // rasterized): bilinear is enough there, and 'high' resampling of a full screen of tiles costs
    // hundreds of ms a frame where the canvas is not GPU-backed. Same-scale tiles are not resampled.
    ctx.imageSmoothingQuality = 'low';

    const draw = (tile: Tile, tileScale: number) => {
      const r = tileScreenRect(tile.i, tile.j, tileScale, o.viewport.x, o.viewport.y, screen);
      if (r.width === TILE && r.height === TILE) ctx.drawImage(tile.canvas, r.x, r.y);
      else if (r.width > 0 && r.height > 0) ctx.drawImage(tile.canvas, r.x, r.y, r.width, r.height);
      tile.used = frame;
    };

    const current = levelOf(scale);
    const wanted = tilesByDistance(view, scale);
    // Where this scale has no picture yet: other scales fill in there, and only there. A stale tile of
    // this scale is no hole: it is drawn over whatever lies under it (tiles are opaque).
    const holes: TilePlace[] = [];
    for (const place of wanted) if (!current.tiles.has(tileKey(place.i, place.j))) holes.push(place);
    // Blank: parts of the view have no picture at any scale yet (opening a file, jumping far). Covered: other
    // scales' tiles fill every hole of this one.
    let fallback = false, blank = false, covered = false;
    if (holes.length) {
      // The nearest scales first; further ones only where the nearer ones leave gaps. They are drawn
      // the furthest at the bottom, so the nearest (sharpest) picture ends up on top, and each only
      // inside the holes it was asked to fill.
      // A level far finer than this one (zoomed in close, then out) is left out: its tiles are a few
      // pixels each on screen, too many to draw and too small to help.
      const others = [...levels.values()].filter(level => level !== current && level.tiles.size && level.scale / scale <= MAX_FALLBACK_RATIO)
        .sort((a, b) => Math.abs(Math.log2(a.scale / scale)) - Math.abs(Math.log2(b.scale / scale)));
      const plan = planFallback<Tile, Level>(holes, scale, others);
      covered = plan.covered;
      for (let k = plan.picks.length - 1; k >= 0; k--) {
        const pick = plan.picks[k];
        ctx.save();
        ctx.beginPath();
        for (const r of placeRects(pick.open)) {
          const from = tileScreenRect(r.i0, r.j0, scale, o.viewport.x, o.viewport.y, screen);
          const to = tileScreenRect(r.i1, r.j1, scale, o.viewport.x, o.viewport.y, screen);
          ctx.rect(from.x, from.y, to.x + to.width - from.x, to.y + to.height - from.y);
        }
        ctx.clip();
        for (const tile of pick.tiles) draw(tile, pick.level.scale);
        ctx.restore();
        fallback = true;
      }
    }
    const todo: {i: number; j: number}[] = [];
    for (const {i, j} of wanted) {
      const tile = current.tiles.get(tileKey(i, j));
      if (tile) {
        draw(tile, scale);
        if (tile.dirty) todo.push({i, j});
      } else {
        todo.push({i, j});
        blank = true;
      }
    }
    const deadline = started + (blank && !fallback ? FIRST_PAINT_BUDGET_MS : BUDGET_MS);
    // A tile that takes longer than a frame's budget (thousands of layers at a low zoom, a canvas without a GPU) is not
    // rasterized while a zoom runs and another scale's stretched picture covers the view: the zoom keeps its frame rate
    // and the picture sharpens once it settles, instead of every frame of the gesture waiting for a tile.
    const defer = !settled && covered && tileMs > BUDGET_MS;
    let rastered = 0, rasterMs = 0;
    for (const {i, j} of todo) {
      if (defer || (rastered > 0 && now() > deadline)) break;
      const tileStarted = now();
      draw(raster(o, current, i, j), scale);
      const took = now() - tileStarted;
      rasterMs += took;
      tileMs = tileMs * 0.6 + took * 0.4;
      rastered++;
    }
    const pending = todo.length - rastered;
    let prefetching = false;
    // Idle: rasterize a ring around the view, so the next pan finds its tiles ready.
    if (!pending && settled && !pixel) {
      const ring = tilesByDistance({x: view.x - TILE / scale, y: view.y - TILE / scale, width: view.width + (2 * TILE) / scale, height: view.height + (2 * TILE) / scale}, scale);
      for (const {i, j} of ring) {
        const tile = current.tiles.get(tileKey(i, j));
        if (tile && !tile.dirty) continue;
        // Never evict what is on screen to make room for what might be.
        if (tileCount >= maxTiles) break;
        if (now() > deadline) {
          prefetching = true;
          break;
        }
        const tileStarted = now();
        raster(o, current, i, j).used = frame;
        rasterMs += now() - tileStarted;
        rastered++;
      }
    }

    // Live nodes, over the tiles and in the same pixel grid.
    const snapped = scale === screen;
    const offsetX = snapped ? Math.round(-o.viewport.x * screen) : -o.viewport.x * screen;
    const offsetY = snapped ? Math.round(-o.viewport.y * screen) : -o.viewport.y * screen;
    if (live.size) {
      if (pixel) {
        // "Pixel preview": what is being dragged or resized is the same 1× picture as the tiles around it, magnified
        // onto their pixel grid without smoothing. Painted at the screen's scale, the layer you touched turned sharp while
        // the rest of the page stayed pixelated, which read as "the page is blurry until you touch it".
        const ox = -o.viewport.x * screen, oy = -o.viewport.y * screen;
        const k = screen / scale;
        const clip = {x0: Math.floor(view.x * scale), y0: Math.floor(view.y * scale), x1: Math.ceil((view.x + view.width) * scale), y1: Math.ceil((view.y + view.height) * scale)};
        drawLive(o, live, scale, 0, 0, clip, (x0, y0, x1, y1) => {
          const x = Math.round(x0 * k + ox), y = Math.round(y0 * k + oy);
          return {x, y, width: Math.round(x1 * k + ox) - x, height: Math.round(y1 * k + oy) - y};
        });
      } else drawLive(o, live, screen, offsetX, offsetY, {x0: 0, y0: 0, x1: canvas.width, y1: canvas.height}, null);
    }
    const titlesStarted = now();
    if (o.labels) {
      drawLabels(ctx, {doc: o.doc, pageId: o.pageId, scale: screen, offsetX, offsetY, dpr, selected: o.labels.selected, editing: o.labels.editing, fonts: deps.fonts, width, height});
    }
    const titlesMs = now() - titlesStarted;
    evict();

    const frameMs = now() - started;
    const phases: RenderPhases = {sync: syncMs, raster: rasterMs, sprites: 0, frame: Math.max(0, frameMs - syncMs - rasterMs - titlesMs), titles: titlesMs};
    stats = {frameMs, rastered, pending, tiles: tileCount, tileBytes: tileCount * TILE_BYTES, level: scale, complete: !pending && scale === (pixel ? 1 : screen), phases};
    notePhases('canvas2d', phases);
    if (pending || prefetching || !settled) {
      needsFrame = true;
      schedule();
    }
  }

  /** Paints the live nodes at `screen` px per page px, `offsetX`/`offsetY` being where the page origin falls, within `clip`
   *  (those px), and draws the result on the canvas: as is, or through `place` (the pixel preview's magnified 1×). */
  function drawLive(o: SceneRenderOptions, live: ReadonlySet<NodeId>, screen: number, offsetX: number, offsetY: number, clip: {x0: number; y0: number; x1: number; y1: number}, place: ((x0: number, y0: number, x1: number, y1: number) => Rect) | null): void {
    const doc = o.doc;
    // Lifted nodes are painted on their own, on top: their live ancestors (the auto-layout frame a drag
    // reorders) paint without them.
    const liftedSet = o.lifted?.size ? o.lifted : null;
    const shows = (id: NodeId, stopAtLive: boolean) => {
      const node = doc.nodes[id];
      if (!node || o.hidden?.has(id) || node.visible === false) return false;
      for (let p = node.parentId ? doc.nodes[node.parentId] : undefined; p; p = p.parentId ? doc.nodes[p.parentId] : undefined) {
        if ((stopAtLive && live.has(p.id)) || o.hidden?.has(p.id) || p.visible === false) return false;
        if (p.type === 'PAGE') return p.id === o.pageId;
      }
      return false;
    };
    const ids = [...live].filter(id => !liftedSet?.has(id) && shows(id, true)).sort((a, b) => compareTreeOrder(doc, a, b));
    const lifted = liftedSet ? [...liftedSet].filter(id => live.has(id) && shows(id, false)).sort((a, b) => compareTreeOrder(doc, a, b)) : [];
    if (!ids.length && !lifted.length) return;
    // Where the live nodes paint, in canvas px.
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const id of [...ids, ...lifted]) {
      const b = index.bounds(id);
      if (!b) continue;
      left = Math.min(left, b.x * screen + offsetX);
      top = Math.min(top, b.y * screen + offsetY);
      right = Math.max(right, (b.x + b.width) * screen + offsetX);
      bottom = Math.max(bottom, (b.y + b.height) * screen + offsetY);
    }
    const x0 = Math.max(clip.x0, Math.floor(left)), y0 = Math.max(clip.y0, Math.floor(top));
    const x1 = Math.min(clip.x1, Math.ceil(right)), y1 = Math.min(clip.y1, Math.ceil(bottom));
    if (!(x1 > x0 && y1 > y0)) return;
    const width = x1 - x0, height = y1 - y0;
    const base: Matrix = [[screen, 0, offsetX - x0], [0, screen, offsetY - y0]];
    const options: PaintOptions = {
      images: deps.images,
      fonts: deps.fonts,
      clip: {x: 0, y: 0, width, height},
      outlines: o.outlines,
      layoutGrids: o.layoutGrids,
      booleanGeometry: deps.booleanGeometry,
      minSize: 0.5,
      greekBelow: GREEK_BELOW_PX,
    };
    const layer = canvasPool.acquire(width, height);
    const stacked = ids;
    if (stacked.length) paintDetached(layer.ctx, doc, stacked, base, screen, {...options, hidden: lifted.length ? union(o.hidden, liftedSet!) : o.hidden});
    // The live nodes keep their place in the stack: what lies above them is painted again on top,
    // only where they are (masked by their alpha), so it still covers them while they move.
    const area: Rect = {x: (x0 - offsetX) / screen, y: (y0 - offsetY) / screen, width: width / screen, height: height / screen};
    const lowest = stacked[0];
    const candidates = new Set(!stacked.length ? [] : index.query(area).filter(id => {
      const node = doc.nodes[id];
      if (!node || node.type === 'PAGE' || excluded.has(id) || node.visible === false) return false;
      for (let p = node.parentId ? doc.nodes[node.parentId] : undefined; p && p.type !== 'PAGE'; p = p.parentId ? doc.nodes[p.parentId] : undefined) {
        // Masked content cannot be repainted on its own; hidden or live ancestors paint nothing here.
        if (p.visible === false || live.has(p.id) || excluded.has(p.id) || index.hasMask(p.id)) return false;
      }
      if (node.parentId && index.hasMask(node.parentId)) return false;
      return compareTreeOrder(doc, id, lowest) > 0 && !stacked.some(liveId => isAncestorOf(doc, id, liveId));
    }));
    const above = [...candidates].filter(id => {
      for (let p = doc.nodes[id]?.parentId; p; p = doc.nodes[p]?.parentId ?? null) if (candidates.has(p)) return false;
      return true;
    }).sort((a, b) => compareTreeOrder(doc, a, b));
    if (above.length) {
      const cover = canvasPool.acquire(width, height);
      paintDetached(cover.ctx, doc, above, base, screen, {...options, hidden: excluded, index});
      cover.ctx.setTransform(1, 0, 0, 1, 0, 0);
      cover.ctx.globalAlpha = 1;
      cover.ctx.globalCompositeOperation = 'destination-in';
      cover.ctx.drawImage(layer.canvas, 0, 0, width, height, 0, 0, width, height);
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.drawImage(cover.canvas, 0, 0, width, height, 0, 0, width, height);
      canvasPool.release(cover);
    }
    if (lifted.length) {
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.globalAlpha = 1;
      layer.ctx.globalCompositeOperation = 'source-over';
      paintDetached(layer.ctx, doc, lifted, base, screen, {...options, hidden: o.hidden}, false);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const to = place ? place(x0, y0, x1, y1) : {x: x0, y: y0, width, height};
    ctx.drawImage(layer.canvas, 0, 0, width, height, to.x, to.y, to.width, to.height);
    canvasPool.release(layer);
  }

  /** Paints nodes outside the tree walk, each with its ancestors' opacity and (unless `clipped` is
   *  false) their clips. */
  function paintDetached(target: Ctx2D, doc: DesignDocument, roots: readonly NodeId[], base: Matrix, scale: number, options: PaintOptions, clipped = true): void {
    for (const id of roots) {
      const node = doc.nodes[id];
      let opacity = 1;
      const clips: SceneNode[] = [];
      for (let p = node.parentId ? doc.nodes[node.parentId] : undefined; p && p.type !== 'PAGE'; p = p.parentId ? doc.nodes[p.parentId] : undefined) {
        opacity *= p.opacity;
        if (clipped && clipsChildren(p)) clips.push(p);
      }
      target.save();
      for (const clip of clips) {
        const shape = shapeOf(clip);
        if (!shape) continue;
        const t = affineOf(base, worldOfNode(doc, clip));
        target.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
        target.clip(shape.parts[0].path, shape.parts[0].rule);
      }
      paintNodeTree({ctx: target, transform: base, scale}, doc, [id], {...options, rootOpacity: opacity});
      target.restore();
    }
  }

  // ── Loads ──

  const offImages = deps.images.onChange(() => {
    const doc = last?.doc;
    if (!doc) return;
    let changed = false;
    for (const level of levels.values()) {
      for (const tile of level.tiles.values()) {
        if (!tile.pendingImages) continue;
        for (const ref of tile.pendingImages) {
          const ready = isDesignImageCache(deps.images) ? deps.images.status(ref, doc) !== 'loading' : !!deps.images.get(ref, doc);
          if (ready) {
            dirtyWhole(tile);
            changed = true;
            break;
          }
        }
      }
    }
    if (changed || hasLive()) {
      needsFrame = true;
      schedule();
    }
  });
  const hasLive = () => !!last?.live?.size;
  const offFonts = deps.fonts.onLoad(() => {
    // The measurer's revision moved: the next sync re-measures text and marks its tiles.
    clearEffectCache();
    needsFrame = true;
    schedule();
  });

  return {
    index,
    render: options => render(options),
    indexFor(doc, pageId) {
      // Hit testing may ask before the next frame: sync now, through the same path that marks tiles.
      syncDocument(doc, pageId, last?.live ?? EMPTY);
      return index;
    },
    documentChanged(change) {
      if (!pendingFrom) pendingFrom = index.document;
      for (const id of change.changed) pendingIds.add(id);
      pendingTo = change.doc;
    },
    invalidate() {
      clearEffectCache();
      invalidateAll();
      needsFrame = true;
      schedule();
    },
    dispose() {
      disposed = true;
      if (handle !== null) cancelRaf(handle);
      index.stopLater();
      offImages();
      offFonts();
      dropTiles();
      for (const tile of freeTiles) tile.canvas.width = tile.canvas.height = 1;
      if (scratch) scratch.canvas.width = scratch.canvas.height = 1;
      scratch = null;
      freeTiles.length = 0;
      canvasPool.clear();
    },
    stats: () => stats,
  };
}

/** True when the node or one of its ancestors is under a gesture (painted by the live layer). */
function isLive(doc: DesignDocument, id: NodeId, live: ReadonlySet<NodeId>): boolean {
  if (!live.size) return false;
  for (let node: SceneNode | undefined = doc.nodes[id]; node; node = node.parentId ? doc.nodes[node.parentId] : undefined) if (live.has(node.id)) return true;
  return false;
}

function union(a: ReadonlySet<NodeId> | undefined, b: ReadonlySet<NodeId>): ReadonlySet<NodeId> {
  if (!a?.size) return b;
  if (!b.size) return a;
  return new Set([...a, ...b]);
}

function sameSet(a: ReadonlySet<NodeId>, b: ReadonlySet<NodeId>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function symmetricDifference(a: ReadonlySet<NodeId>, b: ReadonlySet<NodeId>): NodeId[] {
  const out: NodeId[] = [];
  for (const id of a) if (!b.has(id)) out.push(id);
  for (const id of b) if (!a.has(id)) out.push(id);
  return out;
}

/** Paint order of two nodes on one page: compares their index paths from the page down. */
const childIndexes = new WeakMap<readonly NodeId[], Map<NodeId, number>>();
function childIndex(children: readonly NodeId[], id: NodeId): number {
  let map = childIndexes.get(children);
  if (!map) childIndexes.set(children, (map = new Map(children.map((child, i) => [child, i]))));
  return map.get(id) ?? 0;
}

function isAncestorOf(doc: DesignDocument, ancestor: NodeId, id: NodeId): boolean {
  for (let p = doc.nodes[id]?.parentId; p; p = doc.nodes[p]?.parentId ?? null) if (p === ancestor) return true;
  return false;
}

function compareTreeOrder(doc: DesignDocument, a: NodeId, b: NodeId): number {
  const path = (id: NodeId) => {
    const out: number[] = [];
    for (let node = doc.nodes[id]; node?.parentId; node = doc.nodes[node.parentId]) out.unshift(childIndex(doc.nodes[node.parentId]?.children ?? [], node.id));
    return out;
  };
  const pa = path(a), pb = path(b);
  for (let k = 0; k < Math.min(pa.length, pb.length); k++) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  return pa.length - pb.length;
}

