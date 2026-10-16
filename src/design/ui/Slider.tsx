import {useRef, type CSSProperties, type KeyboardEvent, type PointerEvent} from 'react';
import {settleNumber} from './number-expression';

export type SliderProps = {
  value: number;
  onChange: (value: number) => void;
  /** A drag is one gesture: begin it here and end it in onChangeEnd (one undo step). */
  onChangeStart?: () => void;
  onChangeEnd?: () => void;
  min?: number;
  max?: number;
  step?: number;
  'aria-label': string;
  /** What a screen reader hears ('40%'). */
  valueText?: string;
  /** A painted track (hue, alpha gradients) instead of the accent fill. */
  trackBackground?: string;
  /** A checkerboard under a painted track, for alpha. */
  checker?: boolean;
  disabled?: boolean;
  className?: string;
};

/** A horizontal slider: drag the thumb or the track; arrows step (Shift ×10), Home/End jump. */
export function Slider({value, onChange, onChangeStart, onChangeEnd, min = 0, max = 100, step = 1, trackBackground, checker = false, disabled, className = '', valueText, ...aria}: SliderProps) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const precision = Math.max(0, -Math.floor(Math.log10(step)));
  const ratio = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  const settle = (next: number) => settleNumber(Math.round(next / step) * step, {min, max, precision});

  const fromPointer = (event: PointerEvent) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || !box.width) return value;
    // The thumb's centre travels inside the track, 6 px from each end.
    const inner = Math.max(1, box.width - 12);
    return settle(min + Math.min(1, Math.max(0, (event.clientX - box.left - 6) / inner)) * (max - min));
  };

  const keyDown = (event: KeyboardEvent) => {
    const big = event.shiftKey ? 10 : 1;
    const steps: Record<string, number> = {ArrowRight: step * big, ArrowUp: step * big, ArrowLeft: -step * big, ArrowDown: -step * big, PageUp: step * 10, PageDown: -step * 10};
    let next: number | null = null;
    if (event.key in steps) next = settle(value + steps[event.key]);
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    if (next !== value) onChange(next);
  };

  return (
    <div className={`dz-slider ${disabled ? 'is-disabled' : ''} ${trackBackground ? 'is-painted' : ''} ${className}`.trim()}
      style={{'--dz-ratio': ratio, ...(trackBackground ? {'--dz-track': trackBackground} : {})} as CSSProperties}>
      <div ref={track} className={`dz-slider-track ${checker ? 'has-checker' : ''}`}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = event.pointerId;
          (event.currentTarget.querySelector('[role="slider"]') as HTMLElement | null)?.focus({preventScroll: true});
          onChangeStart?.();
          const next = fromPointer(event);
          if (next !== value) onChange(next);
        }}
        onPointerMove={event => {
          if (dragging.current !== event.pointerId) return;
          const next = fromPointer(event);
          if (next !== value) onChange(next);
        }}
        onPointerUp={event => {
          if (dragging.current !== event.pointerId) return;
          dragging.current = null;
          onChangeEnd?.();
        }}
        onLostPointerCapture={() => {
          if (dragging.current === null) return;
          dragging.current = null;
          onChangeEnd?.();
        }}>
        <span className="dz-slider-fill" />
        <span role="slider" tabIndex={disabled ? -1 : 0} aria-label={aria['aria-label']} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
          aria-valuetext={valueText} aria-disabled={disabled || undefined} className="dz-slider-thumb" onKeyDown={keyDown} />
      </div>
    </div>
  );
}
