import {useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';

// The marquee of the file browser (docs/figma-parity-shell.md "Several files selected"): a drag with the mouse from the empty space
// between files draws a box, and every card it touches is selected; with Shift or ⌘/Ctrl held, the box adds to the selection
// already made. A click without a drag stays a click (it clears the selection).

export type Box = {left: number; top: number; right: number; bottom: number};

/** Less than this, in px, is a click, not a marquee. */
export const MARQUEE_SLOP = 4;

export const boxBetween = (a: {x: number; y: number}, b: {x: number; y: number}): Box =>
  ({left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y)});

export const touches = (box: Box, card: Box): boolean => box.left < card.right && box.right > card.left && box.top < card.bottom && box.bottom > card.top;

/** The ids of the cards `box` touches, in their order. */
export const touchedIds = (box: Box, cards: readonly {id: string; box: Box}[]): string[] => cards.filter(card => touches(box, card.box)).map(card => card.id);

type Drag = {start: {x: number; y: number}; base: readonly string[]; moved: boolean};

/** Pointer handlers for the files' area and the box to draw (in client coordinates); `onSelect` gets the ids each move selects. */
export function useMarquee(cards: () => {id: string; box: Box}[], selected: () => readonly string[], onSelect: (ids: string[]) => void) {
  const drag = useRef<Drag | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const justDragged = useRef(false);
  const handlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      if ((event.target as Element).closest('.dz-file, button, a, input, [role="region"]')) return;
      drag.current = {start: {x: event.clientX, y: event.clientY}, base: event.shiftKey || event.metaKey || event.ctrlKey ? selected() : [], moved: false};
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const state = drag.current;
      if (!state) return;
      const now = {x: event.clientX, y: event.clientY};
      if (!state.moved && Math.hypot(now.x - state.start.x, now.y - state.start.y) < MARQUEE_SLOP) return;
      if (!state.moved) {
        state.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      const next = boxBetween(state.start, now);
      setBox(next);
      const touched = touchedIds(next, cards());
      onSelect([...state.base.filter(id => !touched.includes(id)), ...touched]);
    },
    onPointerUp: () => {
      justDragged.current = !!drag.current?.moved;
      drag.current = null;
      setBox(null);
    },
  };
  /** True once after a drag: the click that ends it does not clear the selection. */
  const consumeDrag = () => {
    const was = justDragged.current;
    justDragged.current = false;
    return was;
  };
  return {box, handlers, consumeDrag};
}
