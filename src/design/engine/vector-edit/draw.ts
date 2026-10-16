import type {Matrix, Vec} from '../../../../shared/design/types';
import {apply} from '../../../../shared/design/geometry';
import {OVERLAY_COLORS} from '../overlay';
import {anchorAt, keyOf, segmentCount, segmentCubic, type AnchorKey, type AnchorRef, type HandleSide, type Network, type SegmentRef} from './model';

// How the vector editor and the pen draw on the overlay, in screen px so every mark stays crisp at
// any zoom: the path as a hairline in the accent, anchors as small discs (white, the selected ones
// filled), handles as thin stalks ending in smaller discs, the segment under the pointer thicker.

export const ANCHOR_RADIUS = 3.5;
export const HANDLE_RADIUS = 2.75;
/** Screen px within which a press grabs an anchor or a handle. */
export const GRAB_RADIUS = 7;
/** Screen px within which a press grabs a segment. */
export const SEGMENT_TOLERANCE = 5;

const ACCENT = OVERLAY_COLORS.accent;
const WHITE = '#FFFFFF';

export type NetworkLook = {
  selected: ReadonlySet<AnchorKey>;
  handles: readonly {ref: AnchorRef; side: HandleSide}[];
  hoverAnchor?: AnchorRef | null;
  hoverHandle?: {ref: AnchorRef; side: HandleSide} | null;
  hoverSegment?: SegmentRef | null;
  /** Anchors drawn as hollow rings (the pen's open ends it can continue from). */
  ends?: ReadonlySet<AnchorKey>;
};

function traceSegment(ctx: CanvasRenderingContext2D, network: Network, ref: SegmentRef, m: Matrix, move: boolean) {
  const sub = network[ref.p].subs[ref.s];
  const a = sub.anchors[ref.a], b = sub.anchors[(ref.a + 1) % sub.anchors.length];
  const p0 = apply(m, a), p1 = apply(m, b);
  if (move) ctx.moveTo(p0.x, p0.y);
  if (!a.out && !b.in) {
    ctx.lineTo(p1.x, p1.y);
    return;
  }
  const [, c1, c2] = segmentCubic(a, b);
  const q1 = apply(m, c1), q2 = apply(m, c2);
  ctx.bezierCurveTo(q1.x, q1.y, q2.x, q2.y, p1.x, p1.y);
}

/** The whole network as one hairline path. */
export function strokeNetwork(ctx: CanvasRenderingContext2D, network: Network, m: Matrix, color: string = ACCENT, width = 1) {
  ctx.beginPath();
  network.forEach((path, p) => path.subs.forEach((sub, s) => {
    const count = segmentCount(sub);
    for (let a = 0; a < count; a++) traceSegment(ctx, network, {p, s, a}, m, a === 0);
    if (sub.closed && count) ctx.closePath();
  }));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash([]);
  ctx.stroke();
}

function disc(ctx: CanvasRenderingContext2D, at: Vec, radius: number, fill: string, stroke: string, width = 1) {
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

/** An anchor: white with an accent ring; selected filled with the accent inside a white ring (so
 *  it reads on any fill); a hovered one a little larger. */
export function drawAnchor(ctx: CanvasRenderingContext2D, at: Vec, state: {selected?: boolean; hover?: boolean; hollow?: boolean}) {
  const r = ANCHOR_RADIUS + (state.hover ? 1 : 0);
  if (state.selected) {
    disc(ctx, at, r + 1, ACCENT, ACCENT);
    disc(ctx, at, r - 0.5, ACCENT, WHITE, 1.5);
  } else if (state.hollow) {
    disc(ctx, at, r, WHITE, ACCENT, 1.5);
  } else {
    disc(ctx, at, r, WHITE, ACCENT, 1);
  }
}

export function drawHandle(ctx: CanvasRenderingContext2D, anchor: Vec, handle: Vec, state: {hover?: boolean; active?: boolean}) {
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(handle.x, handle.y);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
  const r = HANDLE_RADIUS + (state.hover ? 0.75 : 0);
  disc(ctx, handle, r, state.active ? ACCENT : WHITE, ACCENT, 1);
}

/** The editor's marks for a network under `m` (node space → screen px). */
export function drawNetwork(ctx: CanvasRenderingContext2D, network: Network, m: Matrix, look: NetworkLook) {
  ctx.save();
  strokeNetwork(ctx, network, m);
  if (look.hoverSegment && network[look.hoverSegment.p]?.subs[look.hoverSegment.s]) {
    ctx.beginPath();
    traceSegment(ctx, network, look.hoverSegment, m, true);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  for (const handle of look.handles) {
    const anchor = anchorAt(network, handle.ref);
    const point = anchor?.[handle.side];
    if (!anchor || !point) continue;
    const hover = !!look.hoverHandle && keyOf(look.hoverHandle.ref) === keyOf(handle.ref) && look.hoverHandle.side === handle.side;
    drawHandle(ctx, apply(m, anchor), apply(m, point), {hover});
  }
  const hoverKey = look.hoverAnchor ? keyOf(look.hoverAnchor) : null;
  network.forEach((path, p) => path.subs.forEach((sub, s) => sub.anchors.forEach((anchor, a) => {
    const key = keyOf({p, s, a});
    drawAnchor(ctx, apply(m, anchor), {selected: look.selected.has(key), hover: key === hoverKey, hollow: look.ends?.has(key)});
  })));
  ctx.restore();
}

// ── Cursors ──────────────────────────────────────────────────────────────────────────────────────

const svgCursor = (body: string, x: number, y: number, fallback: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`)}") ${x} ${y}, ${fallback}`;

// A pen nib with its tip at the hot spot (2, 2), drawn black on a white outline so it reads on
// every fill; a small mark beside it says what a click will do.
// The nib is drawn pointing down its own axis from the tip at the origin, then turned so the tip
// sits at the hot spot and the body runs to the lower right.
const NIB = '<g transform="translate(2.5 2.5) rotate(-45)" stroke-linejoin="round">'
  + '<path d="M0 0 4.3 7.6 3.1 11H-3.1L-4.3 7.6Z" fill="#000" stroke="#fff" stroke-width="1.25"/>'
  + '<path d="M0 1.6V5.6" stroke="#fff" stroke-width="1" stroke-linecap="round"/><circle cy="6.7" r="1.15" fill="#fff"/>'
  + '<rect x="-3.7" y="11.9" width="7.4" height="3.1" rx="0.8" fill="#000" stroke="#fff" stroke-width="1.25"/></g>';
const mark = (inner: string) => `<g transform="translate(14 14)"><rect x="0" y="0" width="9" height="9" rx="4.5" fill="#fff"/>${inner}</g>`;

export const CURSORS = {
  pen: svgCursor(NIB, 2, 2, 'crosshair'),
  /** Over the first anchor: closes the path. */
  penClose: svgCursor(NIB + mark('<circle cx="4.5" cy="4.5" r="2.4" fill="none" stroke="#000" stroke-width="1.2"/>'), 2, 2, 'crosshair'),
  /** Over a segment: adds an anchor. */
  penAdd: svgCursor(NIB + mark('<path d="M4.5 2v5M2 4.5h5" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>'), 2, 2, 'crosshair'),
  /** Over an anchor: removes it. */
  penRemove: svgCursor(NIB + mark('<path d="M2 4.5h5" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>'), 2, 2, 'crosshair'),
  /** Over an open end: continues the path from it. */
  penContinue: svgCursor(NIB + mark('<path d="m2.4 6.6 4.2-4.2" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>'), 2, 2, 'crosshair'),
  /** The bend tool (⌘ held in the editor). */
  bend: svgCursor('<path d="M3 3v12.5l3.4-3.3 2.3 5.3 2.2-1-2.3-5.1H13Z" fill="#000" stroke="#fff" stroke-width="1.25" stroke-linejoin="round"/><path d="M13.5 21c1.5-4.5 5-4.5 8-6.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M13.5 21c1.5-4.5 5-4.5 8-6.5" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>', 3, 3, 'default'),
  pencil: svgCursor('<g transform="translate(3 21) rotate(-135)" stroke-linejoin="round"><path d="M0 0 2.7 5.6H-2.7Z" fill="#fff" stroke="#000" stroke-width="1.1"/><path d="M0 0 1 2.1H-1Z" fill="#000"/><rect x="-2.7" y="5.6" width="5.4" height="12.5" fill="#000" stroke="#fff" stroke-width="1.1"/><rect x="-2.7" y="18.1" width="5.4" height="2.6" rx="0.8" fill="#000" stroke="#fff" stroke-width="1.1"/></g>', 3, 21, 'crosshair'),
} as const;
