import type {Vec} from '../../../../shared/design/types';
import type {Viewport} from '../contracts';
import {clampZoom} from '../viewport';

// Two fingers on the canvas: the page point under the fingers' centre when they landed stays
// under their centre now, and the zoom follows the distance between them. Pan and zoom in one, whatever the tool.

export type FingerPair = readonly [Vec, Vec];

export const centreOf = ([a, b]: FingerPair): Vec => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
export const spanOf = ([a, b]: FingerPair): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Below this span (CSS px) the fingers are taken as one point: the zoom does not follow (it would jump). */
const MIN_SPAN = 8;

/** The viewport for fingers at `now` that landed at `start` while the viewport was `from` (screen points in CSS px). */
export function pinchViewport(from: Viewport, start: FingerPair, now: FingerPair): Viewport {
  const startSpan = spanOf(start), nowSpan = spanOf(now);
  const zoom = startSpan < MIN_SPAN || nowSpan < MIN_SPAN ? from.zoom : clampZoom(from.zoom * (nowSpan / startSpan));
  const c0 = centreOf(start), c1 = centreOf(now);
  const anchor = {x: c0.x / from.zoom + from.x, y: c0.y / from.zoom + from.y};
  return {x: anchor.x - c1.x / zoom, y: anchor.y - c1.y / zoom, zoom};
}
