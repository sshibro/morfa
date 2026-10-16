import {useEffect, useMemo, useRef, useState} from 'react';
import type {RGB, RGBA, SolidPaint} from '../../../shared/design/types';
import {besidePanel, ColorPicker} from '../ui/ColorPicker';
import {ColorSwatch} from '../ui/ColorSwatch';
import {NumberField, type NumberChangeSource} from '../ui/NumberField';
import {TextInput} from '../ui/TextInput';
import {parseHex, toHex} from './color';

// A colour row for the prototype's two colours (the player's backdrop, an overlay's scrim): the
// swatch opens the editor's colour picker beside the panel, the hex field takes typed values, and an
// optional opacity in %. A drag in the picker is one gesture (`source` 'scrub', then `onChangeEnd`).

type Props<C extends RGB | RGBA> = {
  label: string;
  color: C;
  alpha?: boolean;
  onChange: (color: C, source?: NumberChangeSource) => void;
  /** A picker drag ended (commit its one undo step, or put it back when cancelled). */
  onChangeEnd?: (cancelled: boolean) => void;
};

export function ColorField<C extends RGB | RGBA>({label, color, alpha = false, onChange, onChangeEnd}: Props<C>) {
  const swatch = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const dragging = useRef(false);
  const hex = toHex(color);
  const [text, setText] = useState(hex);
  useEffect(() => setText(hex), [hex]);
  const opacity = alpha && 'a' in color ? (color as RGBA).a : 1;
  const paint = useMemo<SolidPaint>(() => ({type: 'SOLID', color: {r: color.r, g: color.g, b: color.b}, opacity, visible: true, blendMode: 'NORMAL'}), [color.r, color.g, color.b, opacity]);
  const anchor = useMemo(() => (open && swatch.current ? besidePanel(swatch.current) : null), [open]);
  const withRgb = (rgb: RGB, a = opacity): C => ({...color, r: rgb.r, g: rgb.g, b: rgb.b, ...(alpha && 'a' in color ? {a} : {})});
  return (
    <div className="dz-proto-color">
      <ColorSwatch ref={swatch} interactive color={color} size={16} aria-label={`${label}: #${hex}`} aria-expanded={open} onClick={() => setOpen(!open)} />
      <TextInput aria-label={label} value={text} onChange={setText} selectOnFocus className="dz-proto-color__hex"
        onCommit={value => {
          const rgb = parseHex(value);
          if (rgb) onChange(withRgb(rgb));
          else setText(hex);
        }} />
      {alpha && 'a' in color && (
        <NumberField aria-label={`${label}: opacity`} value={Math.round((color as RGBA).a * 100)} min={0} max={100} suffix="%" precision={0} className="dz-proto-color__alpha"
          onChange={(value, source) => onChange({...color, a: value / 100}, source)} onScrubEnd={cancelled => onChangeEnd?.(cancelled)} />
      )}
      {open && anchor && (
        <ColorPicker anchor={anchor} trigger={swatch.current} onClose={() => setOpen(false)} aria-label={label} kinds="solid" alpha={alpha} paint={paint}
          onGestureStart={() => {
            dragging.current = true;
          }}
          onGestureEnd={() => {
            dragging.current = false;
            onChangeEnd?.(false);
          }}
          onChange={next => {
            if (next.type !== 'SOLID') return;
            onChange(withRgb(next.color, next.opacity), dragging.current ? 'scrub' : undefined);
          }} />
      )}
    </div>
  );
}
