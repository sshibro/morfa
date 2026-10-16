import {useCallback, useRef, type PointerEvent as ReactPointerEvent} from 'react';

// A sheet on a phone: a finger drags it down by its grabber or header, and it closes when it
// went far enough or was flicked; otherwise it springs back. Only a touch or a pen drags: a mouse on a narrow window
// keeps clicking what it clicks.

/** How far down, in px, a released sheet must have gone to close. */
export const SHEET_CLOSE_DISTANCE = 96;
/** How fast, in px per ms, a flick down closes the sheet however short it was. */
export const SHEET_CLOSE_VELOCITY = 0.6;
/** Less than this, in px, is a tap, not a drag: buttons in the header keep working. */
export const SHEET_DRAG_SLOP = 6;

/** Whether a sheet let go `distance` px below where it started, moving at `velocity` px/ms, closes. */
export const sheetCloses = (distance: number, velocity: number): boolean =>
  distance >= SHEET_CLOSE_DISTANCE || (distance > SHEET_DRAG_SLOP && velocity >= SHEET_CLOSE_VELOCITY);

/** Upward drags resist (a quarter of the finger's travel), so the sheet never comes loose from the bottom edge. */
export const sheetOffset = (distance: number): number => (distance >= 0 ? distance : distance / 4);

type Drag = {id: number; startY: number; lastY: number; lastAt: number; velocity: number; moved: boolean};

/** Pointer handlers for the part of a sheet a finger drags (`handle`), moving `sheet` and calling `onClose` past the line. */
export function useSheetDrag(sheet: () => HTMLElement | null, onClose: () => void) {
  const drag = useRef<Drag | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = (offset: number, animate: boolean) => {
    const element = sheet();
    if (!element) return;
    element.style.transition = animate ? '' : 'none';
    element.style.translate = offset ? `0 ${offset}px` : '';
  };

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    drag.current = {id: event.pointerId, startY: event.clientY, lastY: event.clientY, lastAt: event.timeStamp, velocity: 0, moved: false};
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const distance = event.clientY - state.startY;
    if (!state.moved && Math.abs(distance) < SHEET_DRAG_SLOP) return;
    if (!state.moved) {
      state.moved = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const elapsed = Math.max(1, event.timeStamp - state.lastAt);
    state.velocity = (event.clientY - state.lastY) / elapsed;
    state.lastY = event.clientY;
    state.lastAt = event.timeStamp;
    place(sheetOffset(distance), false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const end = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    if (!state.moved) return;
    if (sheetCloses(event.clientY - state.startY, state.velocity)) onCloseRef.current();
    else place(0, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end};
}
