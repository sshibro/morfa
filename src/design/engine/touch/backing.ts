// The canvas's backing store on a phone: a 3× screen makes every scene pixel nine, and a pinch
// redraws the whole scene each frame. On a touch screen the backing store stops at MAX_TOUCH_RATIO;
// a mouse screen keeps its own ratio.

/** Device pixels per CSS px at most on a touch screen. */
export const MAX_TOUCH_RATIO = 2;
/** While fingers pinch, the scene is drawn at this ratio and sharpened again when they lift. */
export const PINCH_RATIO = 1;

export function backingRatio(devicePixelRatio: number, coarse: boolean, pinching = false): number {
  const ratio = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  if (!coarse) return ratio;
  return Math.min(ratio, pinching ? PINCH_RATIO : MAX_TOUCH_RATIO);
}
