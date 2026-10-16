import {useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import {IconButton} from '../../ui/Button';
import {IconClose} from '../../ui/icons';
import {sheetHeight, sheetStopAfterDrag, type SheetStop} from './sheet-model';

export type PhoneSheetProps = {
  /** Its name for assistive technology ("Layers", "Properties"). */
  label: string;
  onClose: () => void;
  /** Under the handle: the sheet's tabs. */
  header?: ReactNode;
  children: ReactNode;
};

type Drag = {pointerId: number; startY: number; startHeight: number; lastY: number; lastAt: number; velocity: number; moved: boolean};

/** A drag shorter than this (px) is a tap on the handle: it toggles the stops. */
const TAP_SLOP = 6;

/**
 * A bottom sheet on a phone: it opens at half the screen so the canvas stays live
 * above it, its handle drags it to nearly full or down to close, a tap on the handle switches the stops. Not modal: the
 * canvas above keeps its touches.
 */
export function PhoneSheet({label, onClose, header, children}: PhoneSheetProps) {
  const root = useRef<HTMLElement>(null);
  const [stop, setStop] = useState<SheetStop>('half');
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [screen, setScreen] = useState(() => (typeof innerHeight === 'number' ? innerHeight : 0));
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const host = root.current?.parentElement;
    if (!host) return;
    const observer = new ResizeObserver(() => setScreen(host.clientHeight));
    observer.observe(host);
    setScreen(host.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const height = dragHeight ?? sheetHeight(stop, screen);

  const down = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {pointerId: event.pointerId, startY: event.clientY, startHeight: height, lastY: event.clientY, lastAt: event.timeStamp, velocity: 0, moved: false};
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const elapsed = Math.max(1, event.timeStamp - current.lastAt);
    current.velocity = (current.lastY - event.clientY) / elapsed;
    current.lastY = event.clientY;
    current.lastAt = event.timeStamp;
    current.moved ||= Math.abs(event.clientY - current.startY) > TAP_SLOP;
    if (current.moved) setDragHeight(Math.max(0, Math.min(sheetHeight('full', screen), current.startHeight + current.startY - event.clientY)));
  };
  const up = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragHeight(null);
    if (!current.moved) {
      setStop(stop === 'half' ? 'full' : 'half');
      return;
    }
    const next = sheetStopAfterDrag(dragHeight ?? current.startHeight, current.velocity, screen);
    if (next === 'closed') onClose();
    else setStop(next);
  };
  const cancel = () => {
    drag.current = null;
    setDragHeight(null);
  };

  return (
    <section ref={root} className={`dz-phone-sheet ${dragHeight === null ? '' : 'is-dragging'}`.trim()} role="dialog" aria-modal="false" aria-label={label}
      data-stop={stop} style={{height}}>
      <div className="dz-phone-sheet-grip">
        <button type="button" className="dz-phone-sheet-handle" aria-label={stop === 'half' ? 'Expand panel' : 'Shrink panel'}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}>
          <span aria-hidden="true" />
        </button>
        <IconButton label="Close" tooltip={false} className="dz-phone-sheet-close" onClick={onClose}><IconClose /></IconButton>
      </div>
      {header && <div className="dz-phone-sheet-header">{header}</div>}
      <div className="dz-phone-sheet-body">{children}</div>
    </section>
  );
}
