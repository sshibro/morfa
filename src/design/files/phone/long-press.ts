import {useRef, type PointerEvent as ReactPointerEvent} from 'react';

// A finger held still on a file card opens its menu, as a right click does with a mouse (a file's actions
// without hover or right click). Android also sends `contextmenu` for the same hold; `consumed` tells the card's handler that
// the menu is already open.

/** How long, in ms, a finger stays down before the hold counts (the platforms' own long press is about this). */
export const LONG_PRESS_MS = 500;
/** How far, in px, the finger may drift and still be holding, not scrolling. */
export const LONG_PRESS_SLOP = 8;

export const stillHolding = (dx: number, dy: number): boolean => Math.hypot(dx, dy) <= LONG_PRESS_SLOP;

export function useLongPress(onHold: (element: Element) => void) {
  const state = useRef<{timer: ReturnType<typeof setTimeout>; x: number; y: number} | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (state.current) clearTimeout(state.current.timer);
    state.current = null;
  };
  return {
    /** True after a hold opened the menu, until the next press: the click and the `contextmenu` that follow it do nothing. */
    consumed: () => fired.current,
    handlers: {
      onPointerDown: (event: ReactPointerEvent<Element>) => {
        cancel();
        fired.current = false;
        if (event.pointerType === 'mouse' || !event.isPrimary) return;
        const element = event.currentTarget;
        state.current = {x: event.clientX, y: event.clientY, timer: setTimeout(() => {
          state.current = null;
          fired.current = true;
          onHold(element);
        }, LONG_PRESS_MS)};
      },
      onPointerMove: (event: ReactPointerEvent<Element>) => {
        const start = state.current;
        if (start && !stillHolding(event.clientX - start.x, event.clientY - start.y)) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
  };
}
