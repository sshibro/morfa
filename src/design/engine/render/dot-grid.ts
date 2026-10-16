import type {Ctx2D} from './canvas';

// A board's dot grid (docs/board.md §Chrome, FigJam's canvas): dots on the page's canvas colour, under everything. Painted into each
// tile right after its background, so a tile holds its dots and a pan or a frame costs nothing more; only a tile's raster pays for
// its dots (one path, one fill). Never part of the document: export and thumbnails do not ask for it.

/** Page px between dots at 100 %: about 13 CSS px apart, FigJam's own about 10. */
export const DOT_SPACING = 12;
/** Dots never come closer than this many CSS px on screen: zoomed out, every other row and column drops, so they stay quiet and
 *  never moiré. */
export const DOT_MIN_SCREEN_GAP = 10;
/** A dot's side in CSS px (2 device px on a 2× screen), never under 2 device px: the owner's picture shows them plainly. */
const DOT_SIZE = 1.2;
const DOT_MIN_DEVICE_PX = 2;
/** About #D0D0D0 on the board's #F5F5F5 (the owner's picture: #D0D0D0–#D4D4D4). */
export const DOT_COLOR = 'rgba(0, 0, 0, 0.15)';

/** Page px between dots at `cssScale` (CSS px per page px): DOT_SPACING doubled until the dots are DOT_MIN_SCREEN_GAP apart. */
export function dotSpacing(cssScale: number): number {
  if (!(cssScale > 0) || !Number.isFinite(cssScale)) return DOT_SPACING;
  let spacing = DOT_SPACING;
  while (spacing * cssScale < DOT_MIN_SCREEN_GAP) spacing *= 2;
  return spacing;
}

/** Device-px centres of the dots inside a target `width` × `height` whose pixel (0, 0) shows page point `origin` at `scale` device
 *  px per page px; `spacing` page px apart, on multiples of `spacing` in page space (so neighbouring tiles line up). */
export function dotPositions(origin: {x: number; y: number}, scale: number, spacing: number, width: number, height: number): {xs: number[]; ys: number[]} {
  const along = (start: number, length: number) => {
    const values: number[] = [];
    const first = Math.ceil(start / spacing) * spacing;
    for (let page = first; (page - start) * scale <= length; page += spacing) values.push((page - start) * scale);
    return values;
  };
  return {xs: along(origin.x, width), ys: along(origin.y, height)};
}

/** The dots of a target as the tile paints them: `side` × `side` device-px squares at every (left, top) pair, whole device px. The
 *  GPU tile paints the same squares (crates/render `Dots`), so both paths put every dot on the same pixels. */
export function dotSquares(origin: {x: number; y: number}, scale: number, dpr: number, width: number, height: number): {lefts: number[]; tops: number[]; side: number} {
  const spacing = dotSpacing(scale / Math.max(dpr, 1e-6));
  const {xs, ys} = dotPositions(origin, scale, spacing, width, height);
  const side = Math.max(DOT_MIN_DEVICE_PX, Math.round(DOT_SIZE * dpr));
  const half = side / 2;
  return {lefts: xs.map(x => Math.round(x - half)), tops: ys.map(y => Math.round(y - half)), side};
}

/** DOT_COLOR as r, g, b, a in 0–1 (the GPU tile's colour). */
export const DOT_RGBA: readonly [number, number, number, number] = [0, 0, 0, 0.15];

/** Paints the dots onto `ctx` (identity transform, device px). */
export function paintDotGrid(ctx: Ctx2D, origin: {x: number; y: number}, scale: number, dpr: number, width: number, height: number): void {
  const {lefts, tops, side} = dotSquares(origin, scale, dpr, width, height);
  ctx.beginPath();
  for (const top of tops) for (const left of lefts) ctx.rect(left, top, side, side);
  ctx.fillStyle = DOT_COLOR;
  ctx.fill();
}
