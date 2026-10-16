import type {DesignDocument, Matrix, NodeId, SceneNode} from '../../../../../shared/design/types';
import type {Rect} from '../../../../../shared/design/geometry';
import {pageBackground} from '../../../../../shared/design/defaults';
import {parseCounters, type RenderCounters, type RenderWasm, type RenderWasmGpu, type RenderWasmOptions} from '../../../../../shared/design/render-engine';
import {notePhases, type RenderPhases, type RenderStats, type SceneRendererDeps} from '../scene-renderer';
import type {DesignSceneRenderer} from '../scene-renderer';
import {drawLabels} from '../overlays';
import {clearEffectCache} from '../painter';
import {DOT_RGBA, dotSquares} from '../dot-grid';
import type {ChangeHint} from '../spatial-index';
import {SpatialIndex} from '../spatial-index';
import type {TilePlace} from '../tile-math';
import {levelKey, levelScale, placeRects, planFallback, TILE, tileBudgetBytes, tileKey, tileRange, tileScreenRect, tilesByDistance} from '../tile-math';
import type {SceneRenderOptions} from '../types';
import {RenderShadow} from './render-shadow';
import {paintSprites} from './text-sprites';

// The GPU scene renderer (lane L4, docs/decisions/renderer.md §8): the tile architecture of scene-renderer.ts kept
// — 512 px tiles per raster scale on whole device pixels, the exact scale once a zoom settles and the power of two
// above it while it runs, other scales' tiles only inside the holes they fill, hole filling bounded per frame, a
// ring prefetched when idle, tile memory from `navigator.deviceMemory` — with the tiles as layers of a texture atlas
// painted by vello (crates/render) from the renderer's own shadow of the document, and composited to the canvas by
// one quad pass per frame; the live nodes drawn by the same painter straight into the frame. Text is painted into
// sprites by Canvas2D (text-sprites.ts) and frame titles (overlays.ts) onto a 2D canvas laid over the scene canvas,
// which WebGPU owns.

type Tile = {i: number; j: number; slot: number; dirty: boolean; used: number; missingPictures: boolean};
type Level = {scale: number; tiles: Map<string, Tile>};

const SETTLE_MS = 140;
const BUDGET_MS = 8;
const FIRST_PAINT_BUDGET_MS = 120;
const TILE_BYTES = TILE * TILE * 4;
const MAX_FALLBACK_RATIO = 16;
/** Tiles rasterized per frame at most: `raster_tile` returns once the work is queued, not drawn, so the time budget
 *  alone bounds the encoding and not the GPU's work (and the memory of the renders in flight — a software adapter
 *  loses the device under dozens of queued vello renders). The first paint takes more; a pan a few. */
const MAX_RASTER_PER_FRAME = 6;
/** Text sprites painted between two looks at the clock while a tile is rasterized out of a frame. */
const SPRITE_CHUNK = 2;
/** Visible tiles rasterized in a frame while it has used less than this (after the first picture): encoding a tile
 *  takes several ms, so the rest — visible tiles still missing or stale, then the ring around the view — is rasterized
 *  in background slices between frames (`pump`), and each slice asks for a frame to show what it made. While a tile is
 *  missing the view shows what the Canvas2D renderer shows there: the tile as it was, or another scale's, or the page. */
const FRAME_RASTER_MS = 2;
/** One background slice of tile rasters (at least one tile). */
const SLICE_MS = 4;

/** Background work: a `scheduler.postTask` task of background priority (after input and frames), a timer elsewhere. */
function whenFree(work: () => void): () => void {
  const scheduler = (globalThis as {scheduler?: {postTask?: (task: () => void, options: {priority: 'background'; signal: AbortSignal}) => Promise<unknown>}}).scheduler;
  if (typeof scheduler?.postTask === 'function') {
    const controller = new AbortController();
    scheduler.postTask(work, {priority: 'background', signal: controller.signal}).catch(() => {});
    return () => controller.abort();
  }
  const timer = setTimeout(work, 0);
  return () => clearTimeout(timer);
}
const MAX_RASTER_FIRST_PAINT = 16;
const EMPTY: ReadonlySet<NodeId> = new Set();
const STATIC_STYLE = 'position:absolute;inset:0;pointer-events:none;display:block';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const raf = (callback: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : (setTimeout(callback, 16) as unknown as number));
const cancelRaf = (handle: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle));

export type GpuSceneRendererDeps = SceneRendererDeps & {
  wasm: RenderWasm;
  gpu: RenderWasmGpu;
  capacity: number;
  /** Tiles rasterized per frame at most (default MAX_RASTER_PER_FRAME, more on the first paint): a software WebGPU
   *  adapter (SwiftShader in the cloud harness) takes seconds a tile and the browser's GPU watchdog tears the
   *  instance down under a burst of queued renders; the harness sets 1 there. */
  maxRasterPerFrame?: number;
  /** Frames go here as pixels (the off-screen frame read back) instead of to the canvas: the cloud harness on a
   *  software WebGPU adapter, where a presented frame loses the device; tests. Never set in the editor. */
  frameSink?: (pixels: Promise<Uint8Array>, width: number, height: number) => void;
};

/** Atlas slots for the tile budget: 1 MiB a tile, at least 24, at most what the renderer allocated. */
export function atlasCapacity(deviceMemory: number | undefined): number {
  return Math.max(24, Math.floor(tileBudgetBytes(deviceMemory) / TILE_BYTES));
}

export function createGpuSceneRenderer(canvas: HTMLCanvasElement, deps: GpuSceneRendererDeps): DesignSceneRenderer {
  const {gpu} = deps;
  const index = new SpatialIndex();
  const shadow = new RenderShadow(deps.wasm, deps.images);
  const levels = new Map<string, Level>();
  const capacity = Math.min(deps.capacity, gpu.capacity());
  const freeSlots: number[] = [];
  for (let slot = capacity - 1; slot >= 0; slot--) freeSlots.push(slot);
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
  let tileMs = 0;
  let counters: RenderCounters = {nodes: 0, fills: 0, strokes: 0, layers: 0, effectBitmaps: 0, backdrops: 0, sprites: 0, missingSprites: 0, missingPictures: 0};
  let size = {width: 0, height: 0};
  /** What the background slices rasterize for: the last frame's options, scale and view (`pump`). */
  let pumpFor: {o: SceneRenderOptions; scale: number; view: Rect; ring: boolean} | null = null;
  let cancelPump: (() => void) | null = null;
  const schedulePump = () => {
    if (!cancelPump && !disposed) cancelPump = whenFree(pump);
  };
  /** One background slice: visible tiles still missing or stale (nearest the centre first), then the ring around the
   *  view (never evicting what is on screen for it); a frame follows to show what it made, and another slice when
   *  there is more. A newer frame that has not been drawn yet, or a frame still being read back, waits for it. */
  function pump(): void {
    cancelPump = null;
    if (disposed || framePending || !pumpFor || pumpFor.o !== last) return;
    const {o, scale, view, ring} = pumpFor;
    const level = levelOf(scale);
    const until = now() + SLICE_MS;
    const places = tilesByDistance(view, scale);
    const around = ring ? tilesByDistance({x: view.x - TILE / scale, y: view.y - TILE / scale, width: view.width + (2 * TILE) / scale, height: view.height + (2 * TILE) / scale}, scale) : [];
    let made = 0, more = false;
    const visible = places.length;
    const all = [...places, ...around];
    for (let k = 0; k < all.length; k++) {
      const {i, j} = all[k];
      const tile = level.tiles.get(tileKey(i, j));
      if (tile && !tile.dirty) continue;
      if (k >= visible && !tile && tileCount >= capacity) break;
      if (made > 0 && now() > until) {
        more = true;
        break;
      }
      const done = raster(o, level, i, j, until);
      if (!done) {
        more = true;
        break;
      }
      done.used = frame;
      made++;
    }
    if (made) {
      needsFrame = true;
      schedule();
    }
    if (more) schedulePump();
  }
  /** Time this frame spent painting text sprites (part of the raster phase). */
  let spritesMs = 0;

  // Frame titles: a 2D canvas over the scene canvas (WebGPU owns the scene canvas's context).
  const labels = canvas.ownerDocument.createElement('canvas');
  labels.className = 'dz-canvas__labels';
  labels.setAttribute('aria-hidden', 'true');
  labels.style.cssText = STATIC_STYLE + ';width:' + canvas.style.width + ';height:' + canvas.style.height;
  canvas.insertAdjacentElement('afterend', labels);
  const labelsCtx = labels.getContext('2d');
  let labelsDrawn = false;

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

  const invalidateRect = (rect: Rect) => {
    for (const level of levels.values()) {
      const grown = {x: rect.x - 1 / level.scale, y: rect.y - 1 / level.scale, width: rect.width + 2 / level.scale, height: rect.height + 2 / level.scale};
      const {i0, j0, i1, j1} = tileRange(grown, level.scale);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > level.tiles.size) {
        for (const tile of level.tiles.values()) if (tile.i >= i0 && tile.i <= i1 && tile.j >= j0 && tile.j <= j1) tile.dirty = true;
      } else {
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const tile = level.tiles.get(tileKey(i, j));
          if (tile) tile.dirty = true;
        }
      }
    }
  };

  const invalidateAll = () => {
    for (const level of levels.values()) for (const tile of level.tiles.values()) tile.dirty = true;
  };

  function releaseTile(tile: Tile): void {
    tileCount--;
    freeSlots.push(tile.slot);
    tile.slot = -1;
  }

  const dropTiles = () => {
    for (const level of levels.values()) for (const tile of level.tiles.values()) releaseTile(tile);
    levels.clear();
  };

  /** Frees atlas slots down to `capacity - keep`: tiles not shown this frame first (least recently shown), then —
   *  the atlas being a hard cap, unlike the Canvas2D renderer's soft tile budget — fallback tiles shown this frame
   *  from the level farthest from `current`, whose quads this frame drops (a hole shows the next fallback or the
   *  background for one frame and gets its own tile instead of waiting forever). Never a tile of the current level. */
  function evict(keep: number, current: Level | null = null): void {
    if (tileCount + keep <= capacity) return;
    const candidates: {level: Level; key: string; tile: Tile; rank: number}[] = [];
    for (const level of levels.values()) {
      const distance = current ? Math.abs(Math.log2(level.scale / current.scale)) : 0;
      for (const [key, tile] of level.tiles) {
        if (tile.used < frame) candidates.push({level, key, tile, rank: tile.used});
        else if (current && level !== current) candidates.push({level, key, tile, rank: Number.MAX_SAFE_INTEGER - distance});
      }
    }
    candidates.sort((a, b) => a.rank - b.rank);
    for (const {level, key, tile} of candidates) {
      if (tileCount + keep <= capacity) break;
      level.tiles.delete(key);
      releaseTile(tile);
    }
    // Never the current level: `raster` evicts for its first tile while it is still empty.
    for (const [key, level] of levels) if (!level.tiles.size && level !== current) levels.delete(key);
  }

  const optionsJson = (o: SceneRenderOptions, scale: number, extra: Partial<RenderWasmOptions> = {}): string =>
    JSON.stringify({hidden: [...excluded], outlines: !!o.outlines, layoutGrids: !!o.layoutGrids, minSize: 0.5, spriteScale: scale, ...extra} satisfies RenderWasmOptions);

  const revision = () => deps.fonts.measurer.revision ?? 0;

  /** Rasterizes one tile into a free atlas slot (evicting the least recently shown tile when none is free). */
  /** Rasterizes one tile; null when no slot is free, or (with `until`) when its text sprites did not all fit before
   *  `until`: those painted stay with the renderer, the tile waits for a later frame, and nothing of it is shown. */
  function raster(o: SceneRenderOptions, level: Level, i: number, j: number, until?: number): Tile | null {
    const key = tileKey(i, j);
    const scale = level.scale;
    // Text under the tile that has no sprite at this scale: painted by Canvas2D first, before the tile takes a slot.
    const area = {x: (i * TILE) / scale, y: (j * TILE) / scale, width: TILE / scale, height: TILE / scale};
    const spritesStarted = now();
    const needed = shadow.doc.sprites_needed(o.pageId, area.x, area.y, area.width, area.height, scale, revision());
    for (let k = 0; k < needed.length; k += SPRITE_CHUNK) {
      if (until !== undefined && k > 0 && now() > until) {
        spritesMs += now() - spritesStarted;
        return null;
      }
      paintSprites(shadow.doc, o.doc, needed.slice(k, k + SPRITE_CHUNK), scale, revision(), deps.fonts, deps.images);
    }
    spritesMs += now() - spritesStarted;
    let tile = level.tiles.get(key);
    if (!tile) {
      if (!freeSlots.length) evict(1, level);
      const slot = freeSlots.pop();
      if (slot === undefined) return null;
      tileCount++;
      level.tiles.set(key, (tile = {i, j, slot, dirty: true, used: frame, missingPictures: false}));
    }
    const page = o.doc.nodes[o.pageId];
    const bg = pageBackground(page, o.background);
    const margin = Math.min(256, Math.ceil(index.blurMargin * scale));
    // A board's dots as the Canvas2D tile paints them (its raster target is the same: the tile and `margin` around it).
    const dotGrid = o.dotGrid ? {...dotSquares({x: (i * TILE - margin) / scale, y: (j * TILE - margin) / scale}, scale, o.dpr > 0 ? o.dpr : 1, TILE + 2 * margin, TILE + 2 * margin), color: DOT_RGBA} : undefined;
    const result = parseCounters(gpu.raster_tile(shadow.doc, o.pageId, scale, i, j, tile.slot, bg.r, bg.g, bg.b, margin, optionsJson(o, scale, dotGrid ? {dotGrid} : {})));
    counters = result;
    tile.dirty = false;
    tile.missingPictures = result.missingPictures > 0;
    return tile;
  }

  // ── Documents ──

  let pendingFrom: DesignDocument | null = null;
  let pendingTo: DesignDocument | null = null;
  const pendingIds = new Set<NodeId>();

  function syncDocument(doc: DesignDocument, pageId: NodeId, live: ReadonlySet<NodeId>, explicit?: ChangeHint): void {
    const hint = explicit ?? (pendingFrom && pendingFrom === index.document && pendingTo === doc ? {from: pendingFrom, ids: pendingIds} : undefined);
    const from = index.document;
    const sync = index.sync(doc, pageId, deps.fonts.measurer, hint);
    // A rebuild leaves the subtrees of clipping roots out of the grid: background slices put them in.
    if (sync.rebuilt) index.completeLater();
    const reloaded = shadow.sync(doc, hint);
    shadow.syncPictures(doc);
    // As the Canvas2D renderer: a sync that left the index (and the shadow) where they were keeps the ids gathered since, so the
    // frame that brings the newer document compares those, not every node of the file (index and shadow alike).
    if (index.document !== from || sync.rebuilt || reloaded) {
      pendingFrom = pendingTo = null;
      pendingIds.clear();
    }
    if (sync.rebuilt || reloaded) {
      if (pageId !== syncedPage) dropTiles();
      else invalidateAll();
      needsFrame = true;
    }
    for (const dirty of sync.dirty) {
      // As the Canvas2D renderer: a node that turns live with this change is still in the tiles at its old bounds.
      if (isLive(doc, dirty.id, live) && isLive(doc, dirty.id, syncedLive)) continue;
      invalidateRect(dirty.rect);
      needsFrame = true;
    }
    syncedPage = pageId;
    syncedLive = live;
  }

  // ── Frames ──

  /** The off-screen frame still being read back (`frameSink`): the renderer is idle until it settles, since the
   *  wasm renderer is one object and a call during its await would be a re-entry. */
  let framePending: Promise<unknown> | null = null;
  /** Sprites to drop once the pending off-screen frame settles (the document is borrowed by it until then). */
  let spritesStale = false;
  const clearSprites = () => {
    if (framePending) spritesStale = true;
    else {
      spritesStale = false;
      shadow.doc.clear_text_sprites();
    }
  };

  function render(o: SceneRenderOptions, fromLoop = false): void {
    if (disposed) return;
    if (framePending) {
      needsFrame = true;
      last = o;
      return;
    }
    if (!fromLoop && handle !== null) {
      cancelRaf(handle);
      handle = null;
    }
    const started = now();
    last = o;
    const dpr = o.dpr > 0 ? o.dpr : 1;
    const width = Math.max(1, Math.round(o.size.width * dpr)), height = Math.max(1, Math.round(o.size.height * dpr));
    if (canvas.width !== width || canvas.height !== height || size.width !== width || size.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gpu.resize(width, height);
      labels.width = width;
      labels.height = height;
      labels.style.width = canvas.style.width;
      labels.style.height = canvas.style.height;
      size = {width, height};
      needsFrame = true;
    }
    const live = o.live ?? EMPTY;
    syncDocument(o.doc, o.pageId, live, o.changes);
    const syncMs = now() - started;
    const page = o.doc.nodes[o.pageId];
    const bg = pageBackground(page, o.background);
    const mode = `${!!o.outlines}|${!!o.layoutGrids}|${!!o.dotGrid}|${o.dotGrid ? o.dpr : 0}|${bg.r},${bg.g},${bg.b}`;
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
    // The quads in paint order (fallback levels under the current one); serialized after the rasters, so a fallback
    // tile evicted for a raster this frame drops out instead of showing the new tile's pixels.
    const drawn: {tile: Tile; rect: Rect; scissor: [number, number, number, number] | null; smooth: boolean}[] = [];
    const pushQuad = (tile: Tile, tileScale: number, scissor: [number, number, number, number] | null) => {
      const r = tileScreenRect(tile.i, tile.j, tileScale, o.viewport.x, o.viewport.y, screen);
      if (!(r.width > 0 && r.height > 0)) return;
      drawn.push({tile, rect: r, scissor, smooth: !(tileScale === scale && !pixel)});
      tile.used = frame;
    };

    const current = levelOf(scale);
    const wanted = tilesByDistance(view, scale);
    const holes: TilePlace[] = [];
    for (const place of wanted) if (!current.tiles.has(tileKey(place.i, place.j))) holes.push(place);
    let fallback = false, blank = false, covered = false;
    if (holes.length) {
      const others = [...levels.values()].filter(level => level !== current && level.tiles.size && level.scale / scale <= MAX_FALLBACK_RATIO)
        .sort((a, b) => Math.abs(Math.log2(a.scale / scale)) - Math.abs(Math.log2(b.scale / scale)));
      const plan = planFallback<Tile, Level>(holes, scale, others);
      covered = plan.covered;
      for (let k = plan.picks.length - 1; k >= 0; k--) {
        const pick = plan.picks[k];
        for (const r of placeRects(pick.open)) {
          const from = tileScreenRect(r.i0, r.j0, scale, o.viewport.x, o.viewport.y, screen);
          const to = tileScreenRect(r.i1, r.j1, scale, o.viewport.x, o.viewport.y, screen);
          const x0 = Math.max(0, from.x), y0 = Math.max(0, from.y);
          const x1 = Math.min(width, to.x + to.width), y1 = Math.min(height, to.y + to.height);
          if (!(x1 > x0 && y1 > y0)) continue;
          for (const tile of pick.tiles) pushQuad(tile, pick.level.scale, [x0, y0, x1 - x0, y1 - y0]);
        }
        fallback = true;
      }
    }
    const todo: {i: number; j: number}[] = [];
    for (const {i, j} of wanted) {
      const tile = current.tiles.get(tileKey(i, j));
      if (tile) {
        pushQuad(tile, scale, null);
        if (tile.dirty) todo.push({i, j});
      } else {
        todo.push({i, j});
        blank = true;
      }
    }
    // Nothing on screen yet: the first picture is rasterized in its frames, as before; after it, a frame rasterizes
    // visible tiles only while it is short, and `pump` does the rest between frames.
    const firstPaint = blank && !fallback;
    const deadline = started + (firstPaint ? FIRST_PAINT_BUDGET_MS : FRAME_RASTER_MS);
    const defer = !settled && covered && tileMs > BUDGET_MS;
    let rastered = 0;
    spritesMs = 0;
    const rasterStarted = now();
    const maxRaster = deps.maxRasterPerFrame ?? (firstPaint ? MAX_RASTER_FIRST_PAINT : MAX_RASTER_PER_FRAME);
    for (const {i, j} of todo) {
      if (defer || rastered >= maxRaster || now() > deadline) break;
      const tileStarted = now();
      const tile = raster(o, current, i, j, firstPaint ? undefined : deadline);
      if (!tile) break;
      pushQuad(tile, scale, null);
      tileMs = tileMs * 0.6 + (now() - tileStarted) * 0.4;
      rastered++;
    }
    const pending = todo.length - rastered;
    pumpFor = {o, scale, view, ring: settled && !pixel && !defer};
    if (pending || pumpFor.ring) schedulePump();

    const rasterMs = now() - rasterStarted;
    const frameStarted = now();
    const quads: number[] = [];
    for (const {tile, rect: r, scissor, smooth} of drawn) {
      if (tile.slot < 0) continue;
      quads.push(tile.slot, r.x, r.y, r.x + r.width, r.y + r.height, scissor ? scissor[0] : 0, scissor ? scissor[1] : 0, scissor ? scissor[2] : -1, scissor ? scissor[3] : -1, smooth ? 1 : 0);
    }
    // The frame: tiles, then the live nodes in the same pixel grid, presented by the renderer.
    const snapped = scale === screen;
    const offsetX = snapped ? Math.round(-o.viewport.x * screen) : -o.viewport.x * screen;
    const offsetY = snapped ? Math.round(-o.viewport.y * screen) : -o.viewport.y * screen;
    const liveGroups = liveRoots(o, live);
    const base = new Float64Array([screen, 0, 0, screen, offsetX, offsetY]);
    const liveJson = liveGroups ? JSON.stringify(liveGroups) : '';
    const options = optionsJson(o, scale, {hidden: [...(o.hidden ?? [])], minSize: 0.5});
    if (deps.frameSink) {
      const pixels = gpu.frame_pixels(shadow.doc, bg.r, bg.g, bg.b, new Float32Array(quads), liveJson, base, screen, options, 0);
      framePending = pixels.then(() => undefined, () => undefined).then(() => {
        framePending = null;
        if (disposed) return;
        if (spritesStale) clearSprites();
        if (needsFrame) schedule();
      });
      deps.frameSink(pixels, width, height);
    } else gpu.frame(shadow.doc, bg.r, bg.g, bg.b, new Float32Array(quads), liveJson, base, screen, options, 0);
    const submitMs = now() - frameStarted;
    const titlesStarted = now();
    // The labels canvas is touched only when there are labels to draw or to clear: a frame without labels never
    // commits a 2D canvas (an accelerated 2D canvas beside the WebGPU canvas costs a GPU-process raster per frame).
    if (labelsCtx && (o.labels || labelsDrawn)) {
      labelsCtx.setTransform(1, 0, 0, 1, 0, 0);
      labelsCtx.clearRect(0, 0, width, height);
      if (o.labels) drawLabels(labelsCtx, {doc: o.doc, pageId: o.pageId, scale: screen, offsetX, offsetY, dpr, selected: o.labels.selected, editing: o.labels.editing, fonts: deps.fonts, width, height});
      labelsDrawn = !!o.labels;
    }
    const titlesMs = now() - titlesStarted;
    evict(0);

    const phases: RenderPhases = {sync: syncMs, raster: rasterMs, sprites: spritesMs, frame: submitMs, titles: titlesMs};
    notePhases('gpu', phases);
    stats = {phases, frameMs: now() - started, rastered, pending, tiles: tileCount, tileBytes: tileCount * TILE_BYTES, level: scale, complete: !pending && scale === (pixel ? 1 : screen), wasmBytes: gpu.memory_bytes()};
    if (pending || !settled) {
      needsFrame = true;
      schedule();
    }
  }

  /** The live roots in paint order: those drawn with their ancestors' clips, then the lifted ones without. */
  function liveRoots(o: SceneRenderOptions, live: ReadonlySet<NodeId>): {ids: NodeId[]; clip: boolean}[] | null {
    if (!live.size) return null;
    const doc = o.doc;
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
    const groups: {ids: NodeId[]; clip: boolean}[] = [];
    if (ids.length) groups.push({ids, clip: true});
    if (lifted.length) groups.push({ids: lifted, clip: false});
    return groups.length ? groups : null;
  }

  // ── Loads ──

  const offImages = deps.images.onChange(() => {
    const doc = last?.doc;
    if (!doc) return;
    shadow.syncPictures(doc);
    let changed = false;
    for (const level of levels.values()) for (const tile of level.tiles.values()) {
      if (tile.missingPictures) {
        tile.dirty = true;
        changed = true;
      }
    }
    if (changed || last?.live?.size) {
      needsFrame = true;
      schedule();
    }
  });
  const offFonts = deps.fonts.onLoad(() => {
    // A loaded face changes the text: sprites are stale (the revision moved), the next sync re-measures.
    clearEffectCache();
    clearSprites();
    invalidateAll();
    needsFrame = true;
    schedule();
  });

  return {
    index,
    render: options => render(options),
    indexFor(doc, pageId) {
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
      clearSprites();
      invalidateAll();
      needsFrame = true;
      schedule();
    },
    dispose() {
      disposed = true;
      if (handle !== null) cancelRaf(handle);
      cancelPump?.();
      index.stopLater();
      offImages();
      offFonts();
      dropTiles();
      labels.remove();
      // The wasm objects are borrowed by a pending off-screen frame until its readback resolves: free them after it.
      const free = () => {
        shadow.dispose();
        gpu.free();
      };
      if (framePending) void framePending.then(free);
      else free();
    },
    stats: () => stats,
  };
}

/** The renderer's last tile counters (tests, the bench). */
export type {RenderCounters};

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

const childIndexes = new WeakMap<readonly NodeId[], Map<NodeId, number>>();
function childIndex(children: readonly NodeId[], id: NodeId): number {
  let map = childIndexes.get(children);
  if (!map) childIndexes.set(children, (map = new Map(children.map((child, i) => [child, i]))));
  return map.get(id) ?? 0;
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

export type {Matrix};
