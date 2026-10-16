import {useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref} from 'react';
import type {ControlSize} from './Button';
import {handToDocument, isUndoKey} from '../engine/keyboard';
import {evaluateNumberInput, formatNumber, scrubMultiplier, settleNumber, takeScrubSteps} from './number-expression';

export type NumberChangeSource = 'input' | 'step' | 'scrub';

export type NumberFieldProps = {
  /** 'mixed' when the selection holds different values: the field reads "Mixed". */
  value: number | 'mixed' | null;
  /** Called on Enter or blur with what was typed, on each arrow step and on each scrub move. */
  onChange: (value: number, source: NumberChangeSource) => void;
  /** A scrub is one gesture: start it here, update it from onChange, end it in onScrubEnd (one undo step). */
  onScrubStart?: () => void;
  /** `cancelled` after Escape: the value goes back to where the scrub began. */
  onScrubEnd?: (cancelled: boolean) => void;
  /** A short label before the number ('X', 'W', '°'); dragging it changes the value. */
  label?: string;
  /** Or an icon in its place (16 px). */
  icon?: ReactNode;
  'aria-label': string;
  min?: number;
  max?: number;
  /** Arrow step (Shift ×10); also the scrub step per pixel unless scrubStep says otherwise. */
  step?: number;
  scrubStep?: number;
  /** Decimals kept and shown. */
  precision?: number;
  /** Printed after the number ('%', '°'); typing it is optional. */
  suffix?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: ControlSize;
  className?: string;
  title?: string;
  inputRef?: Ref<HTMLInputElement>;
};

const SCRUB_THRESHOLD_PX = 3;

/**
 * A Figma-style number field: drag the label to scrub (Shift ×10, Alt ×0.1), ↑/↓ step by 1
 * (Shift by 10), type arithmetic or Russian decimals, Enter or blur commits, Escape reverts.
 */
export function NumberField({value, onChange, onScrubStart, onScrubEnd, label, icon, min, max, step = 1, scrubStep, precision = 2, suffix = '', placeholder, disabled, size = 24, className = '', title, inputRef, ...aria}: NumberFieldProps) {
  const mixed = value === 'mixed';
  const numeric = typeof value === 'number' ? value : null;
  const shown = numeric === null ? '' : formatNumber(numeric, precision) + suffix;
  // While focused the field holds its own text; `dirty` says the user typed since the last sync.
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = useRef(false);
  const escaping = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);
  const settle = (next: number, digits = precision) => settleNumber(next, {min, max, precision: digits});

  // Undo or another panel may change the value while the field is focused but untouched.
  useEffect(() => {
    if (draft !== null && !dirty.current) setDraft(shown);
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectAll = () => requestAnimationFrame(() => input.current?.select());

  const commit = (text: string) => {
    dirty.current = false;
    const next = evaluateNumberInput(text, numeric);
    if (next === null) {
      setDraft(shown);
      return false;
    }
    const settled = settle(next);
    if (mixed || settled !== numeric) onChange(settled, 'input');
    setDraft(formatNumber(settled, precision) + suffix);
    return true;
  };

  const stepBy = (direction: 1 | -1, event: KeyboardEvent<HTMLInputElement>) => {
    const base = (draft !== null && dirty.current ? evaluateNumberInput(draft, numeric) : null) ?? numeric ?? 0;
    const delta = step * (event.shiftKey ? 10 : 1) * direction;
    const next = settle(base + delta);
    dirty.current = false;
    onChange(next, 'step');
    setDraft(formatNumber(next, precision) + suffix);
    selectAll();
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    // ⌘Z on a value already committed undoes the document's last change, as in Figma (the field then shows it).
    if (!dirty.current && isUndoKey(event)) {
      handToDocument(event.nativeEvent);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(event.currentTarget.value);
      selectAll();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      escaping.current = true;
      dirty.current = false;
      setDraft(null);
      event.currentTarget.blur();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      stepBy(event.key === 'ArrowUp' ? 1 : -1, event);
    }
  };

  // ── Scrubbing the label ─────────────────────────────────────────────────────────────────────
  type Scrub = {id: number; startX: number; lastX: number; start: number; current: number; rest: number; moved: boolean; root: Element | null; onKey: (event: globalThis.KeyboardEvent) => void};
  const scrub = useRef<Scrub | null>(null);
  const endScrub = (cancelled: boolean) => {
    const state = scrub.current;
    if (!state) return;
    scrub.current = null;
    state.root?.classList.remove('dz-dragging-ew');
    window.removeEventListener('keydown', state.onKey, true);
    if (!state.moved) return;
    if (cancelled && !onScrubEnd) onChange(state.start, 'scrub');
    onScrubEnd?.(cancelled);
  };
  // Window listeners outlive a render: they reach the latest props through this ref.
  const endScrubRef = useRef(endScrub);
  endScrubRef.current = endScrub;
  const scrubDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    if (mixed || numeric === null) {
      input.current?.focus();
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const onKey = (key: globalThis.KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      endScrubRef.current(true);
    };
    scrub.current = {id: event.pointerId, startX: event.clientX, lastX: event.clientX, start: numeric, current: numeric, rest: 0, moved: false, root: event.currentTarget.closest('.dz'), onKey};
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
    const multiplier = scrubMultiplier(event);
    const dx = event.clientX - state.lastX;
    state.lastX = event.clientX;
    if (!dx) return;
    // Each move adds with the modifiers held now, so pressing Shift mid-drag speeds up from here; the travel lands on
    // whole steps (tenths with Alt) however finely the pointer reports it.
    const steps = takeScrubSteps(state, dx, event);
    if (!steps) return;
    const digits = multiplier < 1 ? Math.max(precision, 1) : precision;
    const next = settle(state.current + steps * (scrubStep ?? step), digits);
    if (next === state.current) return;
    state.current = next;
    onChange(next, 'scrub');
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

  useEffect(() => () => endScrubRef.current(false), []);

  const prefix = icon ?? label;
  return (
    <div className={`dz-number is-${size} ${mixed ? 'is-mixed' : ''} ${disabled ? 'is-disabled' : ''} ${prefix ? 'has-prefix' : ''} ${className}`.trim()} title={title}>
      {prefix !== undefined && (
        <span className={`dz-number-prefix ${icon ? 'is-icon' : 'is-label'}`} aria-hidden="true"
          onPointerDown={scrubDown} onPointerMove={scrubMove} onPointerUp={scrubUp} onPointerCancel={() => endScrub(false)} onLostPointerCapture={() => endScrub(false)}>
          {prefix}
        </span>
      )}
      <input
        ref={element => {
          input.current = element;
          if (typeof inputRef === 'function') inputRef(element);
          else if (inputRef) inputRef.current = element;
        }}
        type="text" inputMode="decimal" spellCheck={false} autoComplete="off" disabled={disabled}
        aria-label={aria['aria-label']} role="spinbutton" aria-valuenow={numeric ?? undefined} aria-valuemin={min} aria-valuemax={max}
        aria-valuetext={mixed ? 'Mixed' : numeric === null ? undefined : formatNumber(numeric, precision) + suffix}
        value={draft ?? shown} placeholder={mixed ? 'Mixed' : placeholder}
        onFocus={event => {
          dirty.current = false;
          setDraft(event.currentTarget.value);
          const target = event.currentTarget;
          // Not once the user has typed: on a slow frame the select would swallow what they typed ("20+4" → "4").
          requestAnimationFrame(() => {if (document.activeElement === target && !dirty.current) target.select();});
        }}
        onChange={event => {
          dirty.current = true;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={keyDown}
        onBlur={event => {
          if (!escaping.current && dirty.current) commit(event.currentTarget.value);
          escaping.current = false;
          dirty.current = false;
          setDraft(null);
        }} />
    </div>
  );
}
