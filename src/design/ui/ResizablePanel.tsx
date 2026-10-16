import {useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode} from 'react';

export const PANEL_MIN = 200;
export const PANEL_MAX = 480;
export const PANEL_DEFAULT = 240;

function readWidth(key: string, fallback: number, min: number, max: number) {
  try {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : fallback;
  } catch {
    return fallback;
  }
}

function storeWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // Storage blocked: the width holds for this visit.
  }
}

export type ResizablePanelProps = {
  side: 'left' | 'right';
  /** localStorage key of the width (a per-browser convenience). */
  storageKey: string;
  defaultWidth?: number;
  min?: number;
  max?: number;
  'aria-label': string;
  className?: string;
  children: ReactNode;
};

/**
 * A side panel with a drag handle on its inner edge (200–480 px, remembered under its key). Dragging writes the
 * width straight to the element and commits once on release, so nothing re-renders per pointer
 * move; the canvas next to it follows through its own ResizeObserver. Arrows resize from the
 * keyboard (Shift ×4), Home/End jump, a double-click or Enter restores the default.
 */
export function ResizablePanel({side, storageKey, defaultWidth = PANEL_DEFAULT, min = PANEL_MIN, max = PANEL_MAX, className = '', children, ...aria}: ResizablePanelProps) {
  const [stored, setStored] = useState(() => ({key: storageKey, width: readWidth(storageKey, defaultWidth, min, max)}));
  let {width} = stored;
  // Another key (the right panel keeps its own width in "Code"): that key's width, read once.
  if (stored.key !== storageKey) {
    width = readWidth(storageKey, defaultWidth, min, max);
    setStored({key: storageKey, width});
  }
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{id: number; startX: number; startWidth: number; width: number; root: Element | null} | null>(null);
  const clampWidth = (value: number) => Math.round(Math.min(max, Math.max(min, value)));
  const commit = (value: number) => {
    const next = clampWidth(value);
    setStored({key: storageKey, width: next});
    storeWidth(storageKey, next);
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const root = event.currentTarget.closest('.dz');
    root?.classList.add('dz-dragging-col');
    drag.current = {id: event.pointerId, startX: event.clientX, startWidth: width, width, root};
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    state.width = clampWidth(state.startWidth + (side === 'left' ? dx : -dx));
    panel.current?.style.setProperty('--dz-panel-w', state.width + 'px');
  };
  const up = () => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    state.root?.classList.remove('dz-dragging-col');
    commit(state.width);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    let next: number | null = null;
    if (event.key === grow) next = width + step;
    else if (event.key === shrink) next = width - step;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else if (event.key === 'Enter') next = defaultWidth;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  };

  return (
    <aside ref={panel} aria-label={aria['aria-label']} className={`dz-side-panel is-${side} ${className}`.trim()} style={{'--dz-panel-w': width + 'px'} as CSSProperties}>
      {children}
      <div role="separator" aria-orientation="vertical" aria-label="Panel width" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
        className="dz-resize-handle" onPointerDown={down} onPointerMove={move} onPointerUp={up} onLostPointerCapture={up} onKeyDown={key}
        onDoubleClick={() => commit(defaultWidth)} />
    </aside>
  );
}
