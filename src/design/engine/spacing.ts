import type {DesignDocument, NodeId} from '../../../shared/design/types';
import {boundsOf, isAutoLayout} from '../../../shared/design/constraints';
import {transformRect, worldMatrix, type Rect} from '../../../shared/design/geometry';
import {MEASUREMENT_COLOR} from '../../../shared/design/measurements';
import type {Viewport} from './contracts';
import {drawLabel} from './overlay';
import {formatNumber} from './selection';

// Auto layout's spacing in "Code" (Figma's Dev Mode): an auto-layout frame's padding as a band along each side that has
// some, and the gaps between the children in its flow (and between its rows when it wraps) as bands between them, each
// with its value. A gap is how far apart the children stand, so SPACE_BETWEEN shows what it spread; absolute and hidden
// children are out of the flow and take none. A frame turned off the page's axes shows none. `autoLayoutSpacing` is pure
// (page-space rectangles from the document); `drawSpacing` paints them on the canvas aids (editor/Rulers.tsx), which load
// this module with the mode.

export type SpacingBand = {
  kind: 'padding' | 'gap';
  /** Page space. */
  rect: Rect;
  /** The padding, or how far apart the children (or rows) stand. */
  value: number;
  /** The axis the value runs along. */
  axis: 'x' | 'y';
};

type Axis = 0 | 1;
const lo = (r: Rect, axis: Axis) => (axis ? r.y : r.x);
const hi = (r: Rect, axis: Axis) => (axis ? r.y + r.height : r.x + r.width);
/** A rectangle from its extent along `along` and across it. */
const span = (along: Axis, from: number, to: number, acrossFrom: number, acrossTo: number): Rect =>
  along ? {x: acrossFrom, y: from, width: acrossTo - acrossFrom, height: to - from} : {x: from, y: acrossFrom, width: to - from, height: acrossTo - acrossFrom};
const EPSILON = 0.01;

/** Wrapped children in rows: a child starts the next row when it does not follow the one before along the main axis and
 *  lies past the row's far side across it. */
function rowsOf(boxes: readonly Rect[], main: Axis): Rect[][] {
  const cross: Axis = main ? 0 : 1;
  const rows: Rect[][] = [];
  let row: Rect[] = [], end = -Infinity;
  for (const box of boxes) {
    const previous = row[row.length - 1];
    if (previous && lo(box, main) < hi(previous, main) - EPSILON && lo(box, cross) >= end - EPSILON) {
      rows.push(row);
      row = [];
      end = -Infinity;
    }
    row.push(box);
    end = Math.max(end, hi(box, cross));
  }
  if (row.length) rows.push(row);
  return rows;
}

/** The padding and gap bands of an auto-layout frame, in page space; none for anything else. */
export function autoLayoutSpacing(doc: DesignDocument, id: NodeId): SpacingBand[] {
  const frame = doc.nodes[id];
  if (!isAutoLayout(frame)) return [];
  const world = worldMatrix(doc, id);
  if (Math.abs(world[0][1]) > 1e-9 || Math.abs(world[1][0]) > 1e-9) return [];
  const layout = frame.autoLayout!;
  const {width, height} = frame;
  const bands: SpacingBand[] = [];
  const add = (kind: SpacingBand['kind'], rect: Rect, value: number, axis: Axis) => {
    if (value > EPSILON && rect.width > EPSILON && rect.height > EPSILON) bands.push({kind, rect: transformRect(world, rect), value, axis: axis ? 'y' : 'x'});
  };

  // Top and bottom run the frame's width; left and right stand between them, so no corner is covered twice.
  const top = Math.min(Math.max(layout.paddingTop, 0), height), bottom = Math.min(Math.max(layout.paddingBottom, 0), height - top);
  const left = Math.min(Math.max(layout.paddingLeft, 0), width), right = Math.min(Math.max(layout.paddingRight, 0), width - left);
  add('padding', {x: 0, y: 0, width, height: top}, layout.paddingTop, 1);
  add('padding', {x: 0, y: height - bottom, width, height: bottom}, layout.paddingBottom, 1);
  add('padding', {x: 0, y: top, width: left, height: height - top - bottom}, layout.paddingLeft, 0);
  add('padding', {x: width - right, y: top, width: right, height: height - top - bottom}, layout.paddingRight, 0);

  const main: Axis = layout.layoutMode === 'VERTICAL' ? 1 : 0, cross: Axis = main ? 0 : 1;
  const start = (axis: Axis) => (axis ? top : left), end = (axis: Axis) => (axis ? height - bottom : width - right);
  const boxes = (frame.children ?? []).map(child => doc.nodes[child]).filter(child => child?.visible && child.layoutPositioning !== 'ABSOLUTE').map(child => boundsOf(child));
  const wrap = layout.layoutWrap === 'WRAP';
  const rows = wrap ? rowsOf(boxes, main) : [boxes];
  rows.forEach((row, index) => {
    // A gap runs across the content box, or across its own row when the frame wraps.
    const rowStart = Math.min(...row.map(box => lo(box, cross))), rowEnd = Math.max(...row.map(box => hi(box, cross)));
    const [from, to] = wrap ? [rowStart, rowEnd] : [start(cross), end(cross)];
    for (let i = 1; i < row.length; i++) {
      const a = hi(row[i - 1], main), b = lo(row[i], main);
      add('gap', span(main, a, b, from, to), b - a, main);
    }
    const next = rows[index + 1];
    if (!next) return;
    const nextStart = Math.min(...next.map(box => lo(box, cross)));
    add('gap', span(cross, rowEnd, nextStart, start(main), end(main)), nextStart - rowEnd, cross);
  });
  return bands;
}

/** A band thinner than this on screen (px) is left out: zoomed far out it would be a smear under its label. */
export const MIN_BAND_PX = 4;
/** Screen px between the hatching's diagonals, measured along an axis. */
const HATCH_STEP = 6;

/** Paints the bands in Dev Mode's pink (as "Measurement"'s), translucent and hatched, each with its value at its middle, in
 *  screen px over the canvas (the caller has set the device-pixel transform). Edges land on device pixels, so a band stays
 *  crisp at any zoom and pixel ratio, and the hatching is fixed to the page, so it travels with a pan. */
export function drawSpacing(ctx: CanvasRenderingContext2D, bands: readonly SpacingBand[], viewport: Viewport, dpr: number) {
  const {zoom} = viewport;
  const device = (value: number) => Math.round(value * dpr) / dpr;
  const shown: {band: SpacingBand; rect: Rect}[] = [];
  for (const band of bands) {
    if ((band.axis === 'x' ? band.rect.width : band.rect.height) * zoom < MIN_BAND_PX) continue;
    const x0 = device((band.rect.x - viewport.x) * zoom), x1 = device((band.rect.x + band.rect.width - viewport.x) * zoom);
    const y0 = device((band.rect.y - viewport.y) * zoom), y1 = device((band.rect.y + band.rect.height - viewport.y) * zoom);
    shown.push({band, rect: {x: x0, y: y0, width: x1 - x0, height: y1 - y0}});
  }
  if (!shown.length) return;
  ctx.save();
  ctx.beginPath();
  for (const {rect} of shown) ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = ctx.strokeStyle = MEASUREMENT_COLOR;
  ctx.globalAlpha = 0.14;
  ctx.fill();
  ctx.clip();
  // Diagonals x + y = c across the bands' bounds, c on the page's own steps.
  const x0 = Math.min(...shown.map(each => each.rect.x)), y0 = Math.min(...shown.map(each => each.rect.y));
  const x1 = Math.max(...shown.map(each => each.rect.x + each.rect.width)), y1 = Math.max(...shown.map(each => each.rect.y + each.rect.height));
  const phase = ((-(viewport.x + viewport.y) * zoom) % HATCH_STEP + HATCH_STEP) % HATCH_STEP;
  ctx.beginPath();
  for (let c = Math.floor((x0 + y0 - phase) / HATCH_STEP) * HATCH_STEP + phase; c <= x1 + y1; c += HATCH_STEP) {
    ctx.moveTo(c - y1, y1);
    ctx.lineTo(c - y0, y0);
  }
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  for (const {band, rect} of shown) drawLabel(ctx, {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}, formatNumber(band.value), {background: MEASUREMENT_COLOR, anchor: 'center'});
}
