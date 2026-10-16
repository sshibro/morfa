import type {Vec} from '../../../../../shared/design/types';

// A swipe on a phone in the player: a quick sideways flick of a finger that started
// on nothing draggable or scrollable steps through the flow, as a deck is swiped. Leftwards is the next screen.

/** CSS px a finger must travel sideways for a swipe. */
export const SWIPE_PX = 60;
/** The travel must be at least this many times more sideways than up or down. */
const SIDEWAYS = 2;

/** +1 (next), −1 (previous) or 0 for a press from `start` to `end` in screen units shown at `fit` CSS px per unit. */
export function swipeStep(start: Vec, end: Vec, fit: number): 1 | -1 | 0 {
  const dx = (end.x - start.x) * fit, dy = (end.y - start.y) * fit;
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * SIDEWAYS) return 0;
  return dx < 0 ? 1 : -1;
}
