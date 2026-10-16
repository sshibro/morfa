import {useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode} from 'react';
import type {LetterSpacing, LineHeight} from '../../../../../shared/design/types';
import {MIXED} from '../../../../../shared/design/text-edit';
import {handToDocument, isUndoKey} from '../../../engine/keyboard';
import {evaluateNumberInput, takeScrubSteps} from '../../../ui/number-expression';
import {formatUnitValue, parseUnitValue, type Mixed} from './text-values';

// Line height ("Auto", "120%", "24") and letter spacing ("0%", "1.5") in one field each: type a
// value with or without its unit, "auto" for automatic line height, or arithmetic; drag the icon
// to scrub in the current unit (Shift ×10, Alt ×0.1); ↑/↓ step by 1. Looks and behaves like the
// kit's NumberField, which only knows plain numbers.

type Value = LineHeight | LetterSpacing;

export type UnitFieldProps = {
  kind: 'lineHeight' | 'letterSpacing';
  value: Mixed<Value> | undefined;
  /** The automatic line height in px: where a scrub or a step from "Auto" starts. */
  autoPixels?: number | null;
  icon: ReactNode;
  'aria-label': string;
  title?: string;
  onChange: (value: Value, source: 'input' | 'step' | 'scrub') => void;
  onScrubStart?: () => void;
  onScrubEnd?: (cancelled: boolean) => void;
};

const THRESHOLD = 3;

export function UnitField({kind, value, autoPixels, icon, title, onChange, onScrubStart, onScrubEnd, ...aria}: UnitFieldProps) {
  const shown = formatUnitValue(value);
  const mixed = value === MIXED;
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft !== null && !dirty.current) setDraft(shown);
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The numeric value in its unit, AUTO read as pixels. */
  const numeric = (): {value: number; unit: 'PIXELS' | 'PERCENT'} | null => {
    if (value === undefined || value === MIXED) return null;
    if (value.unit === 'AUTO') return autoPixels ? {value: Math.round(autoPixels * 100) / 100, unit: 'PIXELS'} : null;
    return {value: value.value, unit: value.unit};
  };

  const commit = (text: string) => {
    dirty.current = false;
    const next = parseUnitValue(text, kind, value ?? MIXED, evaluateNumberInput);
    if (!next) {
      setDraft(shown);
      return;
    }
    onChange(next, 'input');
    setDraft(formatUnitValue(next));
  };

  const step = (direction: 1 | -1, shift: boolean) => {
    const current = numeric();
    if (!current) return;
    const next = {unit: current.unit, value: Math.round((current.value + direction * (shift ? 10 : 1)) * 100) / 100};
    if (kind === 'lineHeight' && next.value < 0) next.value = 0;
    dirty.current = false;
    onChange(next, 'step');
    setDraft(formatUnitValue(next));
    requestAnimationFrame(() => input.current?.select());
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    // ⌘Z on a committed value undoes the document's last change (NumberField does the same).
    if (!dirty.current && isUndoKey(event)) {
      handToDocument(event.nativeEvent);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(event.currentTarget.value);
      requestAnimationFrame(() => input.current?.select());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dirty.current = false;
      setDraft(null);
      event.currentTarget.blur();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      step(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey);
    }
  };

  // ── Scrubbing the icon ──
  const scrub = useRef<{id: number; startX: number; lastX: number; current: {value: number; unit: 'PIXELS' | 'PERCENT'}; rest: number; moved: boolean; root: Element | null; onKey: (event: globalThis.KeyboardEvent) => void} | null>(null);
  const end = (cancelled: boolean) => {
    const state = scrub.current;
    if (!state) return;
    scrub.current = null;
    state.root?.classList.remove('dz-dragging-ew');
    window.removeEventListener('keydown', state.onKey, true);
    if (state.moved) onScrubEnd?.(cancelled);
  };
  const endRef = useRef(end);
  endRef.current = end;
  useEffect(() => () => endRef.current(false), []);

  const down = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const current = numeric();
    if (!current) {
      input.current?.focus();
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const onKey = (key: globalThis.KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      endRef.current(true);
    };
    window.addEventListener('keydown', onKey, true);
    scrub.current = {id: event.pointerId, startX: event.clientX, lastX: event.clientX, current, rest: 0, moved: false, root: event.currentTarget.closest('.dz'), onKey};
  };
  const move = (event: PointerEvent<HTMLSpanElement>) => {
    const state = scrub.current;
    if (!state || state.id !== event.pointerId) return;
    if (!state.moved) {
      if (Math.abs(event.clientX - state.startX) < THRESHOLD) return;
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
    const steps = takeScrubSteps(state, dx, event);
    if (!steps) return;
    let next = Math.round((state.current.value + steps) * 100) / 100;
    if (kind === 'lineHeight') next = Math.max(0, next);
    if (next === state.current.value) return;
    state.current = {...state.current, value: next};
    onChange({unit: state.current.unit, value: next}, 'scrub');
  };
  const up = (event: PointerEvent<HTMLSpanElement>) => {
    const state = scrub.current;
    if (!state || state.id !== event.pointerId) return;
    const clicked = !state.moved;
    end(false);
    if (clicked) {
      input.current?.focus();
      input.current?.select();
    }
  };

  return (
    <div className={`dz-number is-24 has-prefix ${mixed ? 'is-mixed' : ''}`.trim()} title={title}>
      <span className="dz-number-prefix is-icon" aria-hidden="true" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => end(false)} onLostPointerCapture={() => end(false)}>
        {icon}
      </span>
      <input ref={input} type="text" spellCheck={false} autoComplete="off" aria-label={aria['aria-label']}
        value={draft ?? shown} placeholder={mixed ? 'Mixed' : undefined}
        onFocus={event => {
          dirty.current = false;
          setDraft(event.currentTarget.value);
          const target = event.currentTarget;
          requestAnimationFrame(() => {if (document.activeElement === target) target.select();});
        }}
        onChange={event => {
          dirty.current = true;
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={keyDown}
        onBlur={event => {
          if (dirty.current) commit(event.currentTarget.value);
          dirty.current = false;
          setDraft(null);
        }} />
    </div>
  );
}
