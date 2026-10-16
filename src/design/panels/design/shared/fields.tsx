import {useRef, type KeyboardEvent, type PointerEvent, type ReactNode} from 'react';
import {NumberField, type NumberChangeSource, type NumberFieldProps} from '../../../ui/NumberField';
import {evaluateNumberInput, scrubMultiplier, settleNumber, takeScrubSteps} from '../../../ui/number-expression';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {IconChevronDown} from '../../../ui/icons';
import {useTooltip} from '../../../ui/Tooltip';
import type {NumberEdit} from './mixed';
import type {PanelEdit} from './edit';
import {usePropertyLabels} from '../../../editor/preferences';

// Building blocks of the "Design" panel's rows, shared by every section (paint, text and component
// sections may import them). The grid follows the panel: two 1fr columns and a 24 px icon column,
// 8 px apart, 24 px controls; captions are 11 px secondary text 4 px above their row (UI3).

/** A row of the panel grid: `pair` is 1fr 1fr 24px, `wide` is 1fr 24px, `single` one column. */
export function Row({children, layout = 'pair', className = ''}: {children: ReactNode; layout?: 'pair' | 'wide' | 'single' | 'triple'; className?: string}) {
  return <div className={`dz-pl-row is-${layout} ${className}`.trim()}>{children}</div>;
}

/** A group of rows under an optional caption (UI3's "Position", "Dimensions"...), shown with "Property labels" on unless
 *  `always` (a caption the fields cannot do without). */
export function Group({caption, always = false, children, className = ''}: {caption?: ReactNode; always?: boolean; children: ReactNode; className?: string}) {
  const labels = usePropertyLabels();
  return (
    <div className={`dz-pl-group ${className}`.trim()}>
      {caption !== undefined && (labels || always) && <div className="dz-pl-caption">{caption}</div>}
      {children}
    </div>
  );
}

/** Captions over the two columns of the next row, shown with "Property labels" on unless `always`. */
export function Captions({left, right, layout = 'pair', always = false}: {left?: ReactNode; right?: ReactNode; layout?: 'pair' | 'triple'; always?: boolean}) {
  const labels = usePropertyLabels();
  if (!labels && !always) return null;
  return (
    <div className={`dz-pl-row is-${layout} dz-pl-captions`}>
      <span className="dz-pl-caption">{left}</span>
      <span className="dz-pl-caption">{right}</span>
    </div>
  );
}

export type PanelNumberProps = Omit<NumberFieldProps, 'onChange' | 'value'> & {
  value: number | 'mixed' | null;
  /** What to do with each selected node's own value: `() => v` for a typed or scrubbed value, a
   *  relative edit (`c => c + 4`) for a scrub, an arrow step or "+4" typed into a field showing "Mixed". */
  onChange: (edit: NumberEdit, source: NumberChangeSource) => void;
  /** Wires a scrub to this control's gesture: one undo step named after the field. */
  edit?: Pick<PanelEdit, 'start' | 'end'>;
  /** A small control inside the field's right edge, shown on hover and focus (the variable hexagon). */
  adornment?: ReactNode;
};

const SCRUB_THRESHOLD_PX = 3;

/**
 * The kit's NumberField with the multi-selection rules of the panel: a field showing "Mixed" still
 * scrubs (each node moves by the same amount from its own value), steps with the arrows, and takes
 * "+8", "*2", "/2" relative to each node; a plain number sets every node.
 */
export function PanelNumber({value, onChange, onScrubStart: scrubStart, onScrubEnd: scrubEnd, edit, adornment, min, max, step = 1, scrubStep, precision = 2, disabled, ...rest}: PanelNumberProps) {
  const onScrubStart = scrubStart ?? (edit ? () => edit.start(rest['aria-label']) : undefined);
  const onScrubEnd = scrubEnd ?? (edit ? (cancelled: boolean) => edit.end(cancelled) : undefined);
  const mixed = value === 'mixed';
  const input = useRef<HTMLInputElement | null>(null);
  const settle = (next: number, digits = precision) => settleNumber(next, {min, max, precision: digits});

  // ── Relative edits on a mixed field (the kit's field needs one value for them) ───────────────
  const keyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!mixed || event.target !== input.current || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLInputElement;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      const delta = step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
      onChange(current => settle(current + delta), 'step');
      return;
    }
    if (event.key !== 'Enter') return;
    const text = target.value.trim();
    if (!/^[+*/]/.test(text)) return;
    event.preventDefault();
    event.stopPropagation();
    const operand = evaluateNumberInput(text.slice(1));
    if (operand !== null) {
      const op = text[0];
      onChange(current => settle(op === '+' ? current + operand : op === '*' ? current * operand : current / operand), 'input');
    }
    // Blurring commits nothing more: the kit's field rejects a relative entry without a value.
    target.blur();
  };

  type Scrub = {id: number; startX: number; lastX: number; total: number; rest: number; moved: boolean; root: Element | null; onKey: (event: globalThis.KeyboardEvent) => void};
  const scrub = useRef<Scrub | null>(null);
  const endScrub = (cancelled: boolean) => {
    const state = scrub.current;
    if (!state) return;
    scrub.current = null;
    state.root?.classList.remove('dz-dragging-ew');
    window.removeEventListener('keydown', state.onKey, true);
    if (state.moved) onScrubEnd?.(cancelled);
  };
  const endRef = useRef(endScrub);
  endRef.current = endScrub;
  const scrubDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const onKey = (key: globalThis.KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      endRef.current(true);
    };
    scrub.current = {id: event.pointerId, startX: event.clientX, lastX: event.clientX, total: 0, rest: 0, moved: false, root: event.currentTarget.closest('.dz'), onKey};
    window.addEventListener('keydown', onKey, true);
  };
  const scrubMove = (event: PointerEvent<HTMLSpanElement>) => {
    const state = scrub.current;
    if (!state || state.id !== event.pointerId) return;
    if (!state.moved) {
      if (Math.abs(event.clientX - state.startX) < SCRUB_THRESHOLD_PX) return;
      state.moved = true;
      state.lastX = event.clientX;
      state.root?.classList.add('dz-dragging-ew');
      input.current?.blur();
      onScrubStart?.();
      return;
    }
    const dx = event.clientX - state.lastX;
    state.lastX = event.clientX;
    if (!dx) return;
    const multiplier = scrubMultiplier(event);
    const steps = takeScrubSteps(state, dx, event);
    if (!steps) return;
    state.total += steps * (scrubStep ?? step);
    const total = state.total;
    onChange(current => settle(current + total, multiplier < 1 ? Math.max(precision, 1) : precision), 'scrub');
  };
  const scrubUp = (event: PointerEvent<HTMLSpanElement>) => {
    const state = scrub.current;
    if (!state || state.id !== event.pointerId) return;
    const clicked = !state.moved;
    endScrub(false);
    if (clicked) {
      input.current?.focus();
      input.current?.select();
    }
  };

  return (
    <div className={`dz-pl-number ${adornment ? 'has-adornment' : ''}`.trim()} onKeyDownCapture={keyDownCapture}>
      <NumberField {...rest} value={value} min={min} max={max} step={step} scrubStep={scrubStep} precision={precision} disabled={disabled}
        inputRef={input} onScrubStart={onScrubStart} onScrubEnd={onScrubEnd}
        onChange={(next, source) => onChange(() => next, source)} />
      {mixed && (rest.label !== undefined || rest.icon !== undefined) && !disabled && (
        <span className="dz-pl-scrub" aria-hidden="true" onPointerDown={scrubDown} onPointerMove={scrubMove} onPointerUp={scrubUp}
          onPointerCancel={() => endScrub(false)} onLostPointerCapture={() => endScrub(false)} />
      )}
      {adornment && <span className="dz-pl-adornment">{adornment}</span>}
    </div>
  );
}

/** A compact dropdown whose trigger text differs from its menu labels (export "PDF" vs "PDF (raster)"). */
export function MenuSelect({display, items, label, className = '', disabled, icon, minWidth = 120, placement = 'bottom-start', alignItemId}: {
  display: ReactNode;
  items: () => MenuItem[];
  label: string;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
  minWidth?: number;
  placement?: 'bottom-start' | 'bottom-end';
  alignItemId?: string;
}) {
  const menu = useMenuTrigger({items, label, minWidth, placement, alignItemId, alignInset: icon ? 32 : 8});
  return (
    <>
      <button type="button" aria-label={label} disabled={disabled} {...menu.triggerProps} className={`dz-select is-24 is-field ${icon ? 'has-icon' : ''} ${className}`.trim()}>
        {icon && <span className="dz-select-icon">{icon}</span>}
        <span className="dz-select-value">{display}</span>
        <span className="dz-select-chevron"><IconChevronDown size={12} /></span>
      </button>
      {menu.element}
    </>
  );
}

/** A small chevron inside a field's right edge that opens a menu (gap "Auto", sizing, export scale). */
export function FieldMenuButton({items, label, minWidth = 160}: {items: () => MenuItem[]; label: string; minWidth?: number}) {
  const anchor = useRef<HTMLElement | null>(null);
  const menu = useMenuTrigger({items, label, minWidth, placement: 'bottom-end', anchor: () => anchor.current?.closest('.dz-pl-combo') ?? anchor.current});
  const tip = useTooltip({label});
  return (
    <>
      <button type="button" aria-label={label} {...menu.triggerProps} {...tip}
        ref={element => {
          anchor.current = element;
          menu.triggerProps.ref(element);
        }}
        className="dz-pl-field-menu">
        <IconChevronDown size={12} />
      </button>
      {menu.element}
    </>
  );
}

/** The `offset` that puts a `left-*` popover anchored to `element` just left of the side panel, as
 *  Figma opens property popovers beside the panel instead of over its fields. */
export function offsetToPanelEdge(element: Element | null, gap = 8): number {
  const panel = element?.closest('.dz-side-panel');
  if (!element || !panel) return gap;
  return Math.max(gap, element.getBoundingClientRect().left - panel.getBoundingClientRect().left + gap);
}
