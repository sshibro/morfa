import {useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {Portal} from './layer';
import {placeFloating, rectOf, viewportSize, type Placed, type Placement, type Rect} from './position';
import {usePhone} from './viewport';
import {SheetBackdrop} from './Menu';

export type PopoverProps = {
  /** The trigger (focus returns to it) or a rectangle on screen. */
  anchor: Element | Rect;
  onClose: () => void;
  placement?: Placement;
  offset?: number;
  'aria-label': string;
  className?: string;
  /** Re-measure when this changes (content that grows after opening). */
  layoutKey?: unknown;
  /** On a phone, a sheet from the bottom over a dimmed page (the default) or, false, anchored as on a desktop. */
  sheet?: boolean;
  children: ReactNode;
};

/**
 * A floating panel next to its anchor (colour pickers, export settings): it flips when the
 * preferred side lacks room, shifts to stay on screen, scales in from the anchor, closes on
 * Escape or a pointer-down outside, and gives focus back to the trigger. On a phone it is a sheet (phone-shell-overlays.css).
 */
export function Popover({anchor, onClose, placement = 'bottom', offset = 8, className = '', layoutKey, sheet = true, children, ...aria}: PopoverProps) {
  const asSheet = usePhone() && sheet;
  const element = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const panel = element.current;
    if (!panel) return;
    const rect = anchor instanceof Element ? rectOf(anchor) : anchor;
    setPlaced(placeFloating(rect, {width: panel.offsetWidth, height: panel.offsetHeight}, viewportSize(), placement, offset));
  }, [anchor, placement, offset, layoutKey]);

  // Whether focus is inside when the popover closes: if so it goes back to the trigger.
  const focusInside = useRef(false);
  // Focus once placed: until then the panel is visibility-hidden, and hidden elements refuse focus.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!placed || focusedOnce.current) return;
    focusedOnce.current = true;
    const panel = element.current;
    const first = panel?.querySelector<HTMLElement>('input, button:not(:disabled), [tabindex]:not([tabindex="-1"])');
    (first ?? panel)?.focus({preventScroll: true});
  }, [placed]);
  // The focused control inside can go away while the popover stays open ("Start" of the timer becomes "Pause" once it runs):
  // focus would fall to the page, and Escape (handled on the panel) would no longer close it. It goes to the panel instead.
  const lastFocused = useRef<Element | null>(null);
  useEffect(() => {
    const panel = element.current;
    if (!panel) return;
    const observer = new MutationObserver(() => {
      const gone = lastFocused.current;
      if (!gone || gone.isConnected) return;
      lastFocused.current = null;
      const active = document.activeElement;
      if (!active || active === document.body) panel.focus({preventScroll: true});
    });
    observer.observe(panel, {childList: true, subtree: true});
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const panel = element.current;
    const trigger = anchor instanceof HTMLElement ? anchor : null;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (!target || panel?.contains(target) || trigger?.contains(target) || (target as Element).closest?.('[data-dz-menu], .dz-sheet-backdrop')) return;
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      if (trigger && focusInside.current) trigger.focus({preventScroll: true});
    };
  }, [anchor]);

  return (
    <Portal>
      {/* Its own click closes it and is taken: what lies under the dimmed page is not pressed too. */}
      {asSheet && <SheetBackdrop onClose={() => onCloseRef.current()} />}
      <div ref={element} role="dialog" aria-label={aria['aria-label']} tabIndex={-1} className={`dz-popover ${asSheet ? 'is-sheet' : ''} ${className}`.replace(/\s+/g, ' ').trim()}
        style={(placed ? {left: placed.x, top: placed.y, '--dz-origin': placed.origin} : {visibility: 'hidden'}) as CSSProperties}
        onFocus={event => {
          focusInside.current = true;
          lastFocused.current = event.target;
        }}
        onBlur={event => {focusInside.current = !!event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node);}}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCloseRef.current();
          }
        }}>
        <div className="dz-popover-body">{children}</div>
      </div>
    </Portal>
  );
}
