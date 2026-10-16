import {useRef, type PointerEvent} from 'react';

// Dragging rows of a list (paints, effects) to change their order, as in Figma's panel: the row
// follows the pointer and the rows it passes slide out of its way; the drop is one edit. Rows move
// through their own transforms during the drag, so the panel never re-renders on pointer moves.

const THRESHOLD = 3;

type Drag = {pointer: number; from: number; startY: number; moved: boolean; rows: HTMLElement[]; tops: number[]; height: number; step: number; to: number};

/** Where a dragged row lands: the number of other rows whose middle is above its centre. */
export function dropIndex(tops: readonly number[], height: number, from: number, centre: number): number {
  let to = 0;
  for (let i = 0; i < tops.length; i++) if (i !== from && centre >= tops[i] + height / 2) to++;
  return to;
}

/** How far row `i` slides while row `from` is held over slot `to` (one step towards the gap). */
export function slideOf(i: number, from: number, to: number, step: number): number {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -step;
  if (from > to && i >= to && i < from) return step;
  return 0;
}

/** Handlers for a grip in each row; `list` holds the rows as `[data-reorder-row]` children. */
export function useRowReorder(onReorder: (from: number, to: number) => void) {
  const list = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const latest = useRef(onReorder);
  latest.current = onReorder;

  const clear = (state: Drag) => {
    for (const row of state.rows) {
      // The rows snap back with no slide: after the drop React puts the paints in their new places.
      row.style.transition = 'none';
      row.style.transform = '';
      row.classList.remove('is-dragging', 'is-sliding');
    }
    list.current?.classList.remove('is-reordering');
    requestAnimationFrame(() => {
      for (const row of state.rows) row.style.transition = '';
    });
  };

  const gripProps = (index: number) => ({
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0 || !list.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const rows = [...list.current.querySelectorAll<HTMLElement>(':scope > [data-reorder-row]')];
      const listTop = list.current.getBoundingClientRect().top;
      const tops = rows.map(row => row.getBoundingClientRect().top - listTop);
      const height = rows[index]?.getBoundingClientRect().height ?? 24;
      const step = tops.length > 1 ? tops[1] - tops[0] : height;
      drag.current = {pointer: event.pointerId, from: index, startY: event.clientY, moved: false, rows, tops, height, step, to: index};
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state || state.pointer !== event.pointerId || !list.current) return;
      const dy = event.clientY - state.startY;
      if (!state.moved) {
        if (Math.abs(dy) < THRESHOLD) return;
        state.moved = true;
        state.rows.forEach((row, i) => row.classList.add(i === state.from ? 'is-dragging' : 'is-sliding'));
        list.current.classList.add('is-reordering');
      }
      const first = state.tops[0] ?? 0, last = state.tops[state.tops.length - 1] ?? 0;
      const top = Math.min(last + state.height / 2, Math.max(first - state.height / 2, state.tops[state.from] + dy));
      state.rows[state.from].style.transform = `translateY(${top - state.tops[state.from]}px)`;
      const to = dropIndex(state.tops, state.height, state.from, top + state.height / 2);
      if (to === state.to) return;
      state.to = to;
      state.rows.forEach((row, i) => {
        if (i !== state.from) row.style.transform = `translateY(${slideOf(i, state.from, to, state.step)}px)`;
      });
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state || state.pointer !== event.pointerId) return;
      drag.current = null;
      clear(state);
      if (state.moved && state.to !== state.from) latest.current(state.from, state.to);
    },
    onLostPointerCapture() {
      const state = drag.current;
      if (!state) return;
      drag.current = null;
      clear(state);
    },
  });

  return {listRef: list, gripProps};
}
