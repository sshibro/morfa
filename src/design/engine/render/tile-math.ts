import type {Rect} from '../../../../shared/design/geometry';

// Tile grid arithmetic of the cached canvas renderer. Pure, tested in node
// (tests/design-render-tiles.test.ts).
//
// A level is one raster scale (device px per page px). Its tiles are TILE × TILE device px on a
// grid anchored at the page origin: tile (i, j) covers level px [i·TILE, (i+1)·TILE) on x, so its
// page area is that divided by the scale. While the zoom is steady the level is the exact screen
// scale, pixel for pixel; during a zoom gesture it is the power of two at or above the scale,
// which stays valid across a whole octave of zoom instead of changing every frame.
//
// Tiles always land on whole device pixels, edge to edge: a tile drawn at a fractional position
// leaves its edge pixels half covered, and the background showed through every seam as a grid of
// thin lines (at any zoom whose scale was not a multiple of 1/4096, and through every zoom gesture).

export const TILE = 512;

/** The raster scale for a screen scale: exactly it when the zoom has settled (so its tiles are drawn
 *  unscaled), else its power-of-two bucket. */
export function levelScale(screenScale: number, settled: boolean): number {
  if (!(screenScale > 0) || !Number.isFinite(screenScale)) return 1;
  if (settled) return screenScale;
  return Math.pow(2, Math.ceil(Math.log2(screenScale) - 1e-9));
}

/** A level per exact scale: two scales that share a key would draw one's tiles resampled for the other. */
export const levelKey = (scale: number) => String(scale);
export const tileKey = (i: number, j: number) => `${i},${j}`;

/** Page area of tile (i, j) at a level. */
export const tilePageRect = (i: number, j: number, scale: number): Rect => ({x: (i * TILE) / scale, y: (j * TILE) / scale, width: TILE / scale, height: TILE / scale});

/** Inclusive tile index ranges covering a page rectangle at a level. */
export function tileRange(page: Rect, scale: number): {i0: number; j0: number; i1: number; j1: number} {
  const i0 = Math.floor((page.x * scale) / TILE), j0 = Math.floor((page.y * scale) / TILE);
  const i1 = Math.floor(((page.x + page.width) * scale - 1e-6) / TILE), j1 = Math.floor(((page.y + page.height) * scale - 1e-6) / TILE);
  return {i0, j0, i1: Math.max(i0, i1), j1: Math.max(j0, j1)};
}

/** Tiles covering a page rectangle, nearest to its centre first (what the eye looks at fills in first). */
export function tilesByDistance(page: Rect, scale: number): {i: number; j: number}[] {
  const {i0, j0, i1, j1} = tileRange(page, scale);
  const cx = ((page.x + page.width / 2) * scale) / TILE - 0.5, cy = ((page.y + page.height / 2) * scale) / TILE - 0.5;
  const out: {i: number; j: number; d: number}[] = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push({i, j, d: (i - cx) ** 2 + (j - cy) ** 2});
  return out.sort((a, b) => a.d - b.d).map(({i, j}) => ({i, j}));
}

/** Tile memory budget in bytes from `navigator.deviceMemory` (GB, Chromium only): 96 MB on a 2 GB
 *  machine, 384 MB from 8 GB, 192 MB when the browser does not say. */
export function tileBudgetBytes(deviceMemory: number | undefined): number {
  const mb = deviceMemory && deviceMemory > 0 ? Math.min(384, Math.max(96, deviceMemory * 48)) : 192;
  return mb * 1024 * 1024;
}

export type TilePlace = {i: number; j: number};
export type FallbackTile = TilePlace & {dirty: boolean};
export type FallbackLevel<T extends FallbackTile> = {scale: number; tiles: ReadonlyMap<string, T>};
/** One other level's part in covering the holes: its tiles there, and the holes still open when it was
 *  reached (it is drawn only inside those; nearer levels already cover the rest). */
export type FallbackPick<T extends FallbackTile, L extends FallbackLevel<T>> = {level: L; tiles: T[]; open: TilePlace[]};

/** Which tiles of which other levels fill the holes (missing tiles) of a level at `scale`. `levels` come
 *  nearest first. A hole closes once one level has a clean tile on every place under it; a level is only
 *  asked about the holes still open, and the walk stops when none is. Drawn furthest first, each clipped
 *  to its `open` holes, this paints the same pixels as drawing every level's tiles under any hole (nearer
 *  ones on top) while each pixel of a hole is drawn by at most the levels that leave it open, instead of
 *  every level stretched across the view (zoomed in close and out again, dozens of levels each frame). */
export function planFallback<T extends FallbackTile, L extends FallbackLevel<T>>(holes: readonly TilePlace[], scale: number, levels: readonly L[]): {picks: FallbackPick<T, L>[]; covered: boolean} {
  const picks: FallbackPick<T, L>[] = [];
  let open: TilePlace[] = [...holes];
  for (const level of levels) {
    if (!open.length) break;
    const ranges = open.map(hole => tileRange(tilePageRect(hole.i, hole.j, scale), level.scale));
    const need = ranges.map(r => (r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1));
    const found = new Array<number>(open.length).fill(0);
    const tiles = new Set<T>();
    if (need.reduce((sum, n) => sum + n, 0) <= level.tiles.size) {
      ranges.forEach((r, k) => {
        for (let i = r.i0; i <= r.i1; i++) for (let j = r.j0; j <= r.j1; j++) {
          const tile = level.tiles.get(tileKey(i, j));
          if (tile && !tile.dirty) {
            found[k]++;
            tiles.add(tile);
          }
        }
      });
    } else {
      // More places than the level has tiles (a much finer level): walking every place would stall the
      // frame, walk its tiles instead.
      for (const tile of level.tiles.values()) {
        if (tile.dirty) continue;
        ranges.forEach((r, k) => {
          if (tile.i >= r.i0 && tile.i <= r.i1 && tile.j >= r.j0 && tile.j <= r.j1) {
            found[k]++;
            tiles.add(tile);
          }
        });
      }
    }
    if (tiles.size) picks.push({level, tiles: [...tiles], open});
    open = open.filter((_, k) => found[k] < need[k]);
  }
  return {picks, covered: !open.length};
}

/** Places of one level merged into rectangles (inclusive index ranges): runs along each row, then
 *  equal runs of neighbouring rows. */
export function placeRects(places: readonly TilePlace[]): {i0: number; j0: number; i1: number; j1: number}[] {
  const rows = new Map<number, number[]>();
  for (const {i, j} of places) {
    let row = rows.get(j);
    if (!row) rows.set(j, (row = []));
    row.push(i);
  }
  const runs: {i0: number; j0: number; i1: number; j1: number}[] = [];
  for (const j of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = [...new Set(rows.get(j))].sort((a, b) => a - b);
    for (let k = 0; k < xs.length; ) {
      let end = k;
      while (end + 1 < xs.length && xs[end + 1] === xs[end] + 1) end++;
      const above = runs.find(r => r.j1 === j - 1 && r.i0 === xs[k] && r.i1 === xs[end]);
      if (above) above.j1 = j;
      else runs.push({i0: xs[k], j0: j, i1: xs[end], j1: j});
      k = end + 1;
    }
  }
  return runs;
}

/** Where a level's tile lands on screen, in whole device px, for a viewport whose page point (vx, vy)
 *  is at the canvas corner and screen scale `screen`. Each edge is rounded on its own, so neighbours
 *  share their edge exactly: no pixel is left half covered between two tiles. A same-scale tile is
 *  TILE × TILE at the rounded viewport offset (the offset live nodes use too); another scale's
 *  tile stretches to its rounded box. */
export function tileScreenRect(i: number, j: number, scale: number, vx: number, vy: number, screen: number): Rect {
  const k = screen / scale;
  const ox = -vx * screen, oy = -vy * screen;
  if (k === 1) {
    const x = i * TILE + Math.round(ox), y = j * TILE + Math.round(oy);
    return {x, y, width: TILE, height: TILE};
  }
  const x0 = Math.round(i * TILE * k + ox), y0 = Math.round(j * TILE * k + oy);
  return {x: x0, y: y0, width: Math.round((i + 1) * TILE * k + ox) - x0, height: Math.round((j + 1) * TILE * k + oy) - y0};
}
