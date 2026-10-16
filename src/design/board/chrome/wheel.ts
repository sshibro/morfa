// The stamp wheel's geometry (docs/board.md §Tools; FigJam's wheel as help.figma.com "Stamps, emotes, and high-fives" shows
// it): a disc of pie slices around the pointer, one stamp in each, and a round middle with "+" for more. Kept whole inside the
// canvas. Pure numbers, so the layout is tested without a browser.

/** The disc's radius in CSS px. */
export const WHEEL_OUTER = 145;
/** The middle's radius. */
export const WHEEL_INNER = 54;
/** From the centre to each stamp's centre (the middle of a slice's ring). */
export const WHEEL_RADIUS = Math.round((WHEEL_OUTER + WHEEL_INNER) / 2) + 4;
/** A stamp's side. */
export const WHEEL_ITEM = 48;
/** White gap between slices and around the middle. */
export const WHEEL_GAP = 4;
/** The ring's whole reach from its centre (its edge and shadow). */
export const WHEEL_REACH = WHEEL_OUTER + 8;
/** A press of E held this long and released over a stamp picks it. */
export const WHEEL_HOLD_MS = 250;

type Box = {width: number; height: number};
type Point = {x: number; y: number};

/** The wheel's centre: the pointer, moved in so the whole disc is inside `area` (or its middle when the area is too small). */
export function wheelCentre(pointer: Point, area: Box): Point {
  const clamp = (value: number, size: number) => (size < 2 * WHEEL_REACH ? size / 2 : Math.min(size - WHEEL_REACH, Math.max(WHEEL_REACH, value)));
  return {x: clamp(pointer.x, area.width), y: clamp(pointer.y, area.height)};
}

const angleOf = (k: number, count: number) => -Math.PI / 2 + (2 * Math.PI * k) / Math.max(1, count);

/** Offsets of `count` stamps from the centre, clockwise from the top. */
export function wheelSlots(count: number): Point[] {
  return Array.from({length: count}, (_, k) => {
    const angle = angleOf(k, count);
    return {x: Math.round(Math.cos(angle) * WHEEL_RADIUS), y: Math.round(Math.sin(angle) * WHEEL_RADIUS)};
  });
}

/** SVG path of slice `k` of `count` around (0, 0): a ring sector between the middle and the edge, a gap from its neighbours. */
export function slicePath(k: number, count: number): string {
  const half = Math.PI / Math.max(1, count);
  const centre = angleOf(k, count);
  const inner = WHEEL_INNER + WHEEL_GAP, outer = WHEEL_OUTER - WHEEL_GAP;
  // The gap is a constant width, so each edge's angle is moved in by its half-width over the radius.
  const at = (radius: number, side: -1 | 1) => {
    const angle = centre + side * (half - WHEEL_GAP / 2 / radius);
    return `${(Math.cos(angle) * radius).toFixed(2)} ${(Math.sin(angle) * radius).toFixed(2)}`;
  };
  return `M ${at(inner, -1)} L ${at(outer, -1)} A ${outer} ${outer} 0 0 1 ${at(outer, 1)} L ${at(inner, 1)} A ${inner} ${inner} 0 0 0 ${at(inner, -1)} Z`;
}

/** Which slice a point (relative to the centre) is over, or null in the middle and outside the disc. */
export function sliceAt(point: Point, count: number): number | null {
  const distance = Math.hypot(point.x, point.y);
  if (distance < WHEEL_INNER || distance > WHEEL_OUTER || count < 1) return null;
  const turn = (Math.atan2(point.y, point.x) + Math.PI / 2 + Math.PI / count + 2 * Math.PI) % (2 * Math.PI);
  return Math.floor(turn / ((2 * Math.PI) / count)) % count;
}
