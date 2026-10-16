import {memo, useEffect, useRef, useState} from 'react';
import {STAMPS} from '../../../../shared/design/board/art';
import type {StampId} from '../../../../shared/design/board/types';
import {setBoardChoices} from '../state';
import {BdPlus} from './icons';
import {StampFace} from './Toolbar';
import {sliceAt, slicePath, WHEEL_HOLD_MS, WHEEL_OUTER, wheelSlots} from './wheel';

// "Stamp wheel" (E; FigJam's stamp wheel, help.figma.com "Stamps, emotes, and high-fives"): a disc of slices at the pointer, a
// stamp in each, "+" in the middle for more. A click on a slice picks its stamp for the stamp tool, which stays in hand; so does
// releasing a held E over one, or 1–9. Escape, or a press anywhere else, leaves the stamp tool.

const SLOTS = wheelSlots(STAMPS.length);
const PATHS = STAMPS.map((_, k) => slicePath(k, STAMPS.length));
const SIZE = WHEEL_OUTER * 2;

export type StampWheelProps = {
  centre: {x: number; y: number};
  current: StampId;
  /** A stamp was picked: the wheel goes, the stamp tool stays. */
  onClose: () => void;
  /** Escape or a press elsewhere: the wheel and the stamp tool go. */
  onExit: () => void;
  /** "+": more stamps and emoji (the "+" sheet). */
  onMore: () => void;
};

export const StampWheel = memo(function StampWheel({centre, current, onClose, onExit, onMore}: StampWheelProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredRef = useRef<number | null>(null);
  hoveredRef.current = hovered;
  const root = useRef<HTMLDivElement>(null);
  // E is still down when the wheel opens: a release after WHEEL_HOLD_MS over a slice picks it; a quick tap leaves the wheel open.
  const held = useRef(true);
  const opened = useRef(performance.now());

  useEffect(() => {
    const pick = (k: number) => {
      setBoardChoices({stamp: STAMPS[k].id});
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const k = Number(digit[1]) - 1;
        if (!STAMPS[k]) return;
        event.preventDefault();
        event.stopPropagation();
        pick(k);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onExit();
      }
    };
    const release = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || !held.current) return;
      held.current = false;
      if (performance.now() - opened.current < WHEEL_HOLD_MS) return;
      if (hoveredRef.current !== null) pick(hoveredRef.current);
    };
    const press = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      onExit();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', release, true);
    window.addEventListener('pointerdown', press, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', release, true);
      window.removeEventListener('pointerdown', press, true);
    };
  }, [onClose, onExit]);

  const local = (event: {clientX: number; clientY: number}) => {
    const box = root.current!.getBoundingClientRect();
    return {x: event.clientX - box.left - WHEEL_OUTER, y: event.clientY - box.top - WHEEL_OUTER};
  };
  const choose = (k: number) => {
    setBoardChoices({stamp: STAMPS[k].id});
    onClose();
  };

  return (
    <div ref={root} className="bd-wheel" role="menu" aria-label="Stamp wheel" style={{left: centre.x, top: centre.y}}
      onPointerMove={event => setHovered(sliceAt(local(event), STAMPS.length))} onPointerLeave={() => setHovered(null)}
      onClick={event => {
        const k = sliceAt(local(event), STAMPS.length);
        if (k !== null && !(event.target as Element).closest('.bd-wheel-item')) choose(k);
      }}>
      <svg className="bd-wheel-slices" viewBox={`${-WHEEL_OUTER} ${-WHEEL_OUTER} ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true">
        {PATHS.map((d, k) => <path key={STAMPS[k].id} d={d} className={`bd-wheel-slice ${hovered === k ? 'is-hovered' : ''} ${STAMPS[k].id === current ? 'is-current' : ''}`.trim()} />)}
      </svg>
      <div className="bd-wheel-middle">
        <button type="button" className="bd-wheel-more" aria-label="More stamps and emoji" onClick={onMore}><BdPlus size={20} /></button>
        <span className="bd-wheel-label" aria-hidden="true">{hovered !== null ? STAMPS[hovered].label : ''}</span>
      </div>
      {STAMPS.map((stamp, k) => (
        <button key={stamp.id} type="button" role="menuitemradio" aria-checked={stamp.id === current} aria-label={stamp.label} className="bd-wheel-item"
          style={{translate: `${SLOTS[k].x}px ${SLOTS[k].y}px`}} onClick={() => choose(k)}>
          <StampFace color={stamp.color} glyph={stamp.id === 'avatar' ? 'Me' : stamp.glyph} icon={stamp.icon} stroke={stamp.stroke} size={44} />
        </button>
      ))}
    </div>
  );
});
