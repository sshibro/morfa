import type {Rect} from '../../../../shared/design/geometry';
import type {Viewport} from '../../engine/contracts';
import {currentViewport, type DesignStore} from '../../engine/store';
import {nodesBounds, pageRectToScreen, panBy} from '../../engine/viewport';

// The on-screen keyboard on a phone: it must cover neither the text being typed on the canvas
// nor the field in a sheet. iOS shrinks only the visual viewport, so the keyboard's height is read from it and handed to
// the stylesheet (`--dz-phone-keyboard`: the sheets stand on it), and the canvas pans a text being edited into view.

/** CSS px kept between what is typed and the keyboard's top. */
const REVEAL_MARGIN = 24;

/** How much of the layout viewport's bottom the keyboard covers. */
export function keyboardInset(layoutHeight: number, visual: {height: number; offsetTop: number}): number {
  return Math.max(0, Math.round(layoutHeight - visual.height - visual.offsetTop));
}

/** The viewport that lifts `rect` (screen px of the canvas) above `visibleBottom`, or null when it is already above it.
 *  It never lifts the rect's top above `visibleTop`. */
export function revealAbove(viewport: Viewport, rect: Rect, visibleTop: number, visibleBottom: number): Viewport | null {
  const overflow = rect.y + rect.height + REVEAL_MARGIN - visibleBottom;
  if (overflow <= 0) return null;
  const lift = Math.min(overflow, Math.max(0, rect.y - visibleTop));
  return lift > 0 ? panBy(viewport, 0, -lift) : null;
}

/** Follows the keyboard while the phone layout is up; returns what stops it. */
export function followKeyboard(root: HTMLElement, store: DesignStore | null, canvasTop: () => number): () => void {
  const visual = globalThis.visualViewport;
  if (!visual) return () => undefined;
  const update = () => {
    const inset = keyboardInset(innerHeight, visual);
    root.style.setProperty('--dz-phone-keyboard', `${inset}px`);
    if (inset > 0) reveal(inset);
  };
  const reveal = (inset: number) => {
    const focused = document.activeElement as HTMLElement | null;
    if (focused && root.contains(focused) && focused.closest('.dz-phone-sheet')) focused.scrollIntoView({block: 'nearest'});
    const state = store?.getState();
    if (!store || !state?.editing || state.editing.kind !== 'text') return;
    const bounds = nodesBounds(state.doc, [state.editing.id]);
    if (!bounds) return;
    const viewport = currentViewport(state);
    const top = canvasTop();
    const bar = root.querySelector(':is(.dz-phone-top, .bd-top-left)')?.getBoundingClientRect().bottom ?? top;
    const next = revealAbove(viewport, pageRectToScreen(viewport, bounds), bar - top, innerHeight - inset - top);
    if (next) store.setViewport(next);
  };
  visual.addEventListener('resize', update);
  visual.addEventListener('scroll', update);
  update();
  return () => {
    visual.removeEventListener('resize', update);
    visual.removeEventListener('scroll', update);
    root.style.removeProperty('--dz-phone-keyboard');
  };
}
