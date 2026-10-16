import {useEffect, useRef, type ReactNode} from 'react';

// The file browser's sidebar on a phone: a drawer from the left over a dimmed page,
// so the files keep the screen's width. It opens from the header's "Sections" button and closes on a choice, a tap on the
// dimmed page, a swipe to the left or Escape; focus goes in when it opens and back to the button when it closes.

/** How far left, in px, a finger must push the drawer for it to close. */
const SWIPE_CLOSE_DISTANCE = 64;

export function Drawer({open, onClose, children}: {open: boolean; onClose: () => void; children: ReactNode}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const swipe = useRef<{x: number; y: number} | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>('[aria-current="page"], button')?.focus({preventScroll: true});
    return () => {
      if (returnTo.current?.isConnected) returnTo.current.focus({preventScroll: true});
    };
  }, [open]);

  return (
    <>
      <div className={`dz-drawer-backdrop ${open ? 'is-open' : ''}`.trim()} aria-hidden="true" onClick={() => onCloseRef.current()} />
      {/* Escape inside the drawer only: a dialog opened from it (the plan, a team's) takes its own Escape. */}
      <div ref={panel} className={`dz-drawer ${open ? 'is-open' : ''}`.trim()} inert={!open}
        onKeyDown={event => {
          // React bubbles a portalled dialog's keys through here too, and the plan's dialog sits inside the drawer: a dialog's Escape is its own.
          const target = event.target as Element;
          if (event.key !== 'Escape' || event.defaultPrevented || !panel.current?.contains(target) || target.closest('dialog')) return;
          event.preventDefault();
          onCloseRef.current();
        }}
        onPointerDown={event => {swipe.current = event.pointerType === 'mouse' ? null : {x: event.clientX, y: event.clientY};}}
        onPointerUp={event => {
          const start = swipe.current;
          swipe.current = null;
          if (!start) return;
          const dx = event.clientX - start.x;
          if (dx < -SWIPE_CLOSE_DISTANCE && Math.abs(dx) > Math.abs(event.clientY - start.y)) onCloseRef.current();
        }}>
        {children}
      </div>
    </>
  );
}
