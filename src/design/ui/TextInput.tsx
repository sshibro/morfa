import {useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref} from 'react';
import type {ControlSize} from './Button';

export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange' | 'value' | 'prefix'> & {
  value: string;
  onChange: (value: string) => void;
  /** Enter, or leaving the field with a changed value. */
  onCommit?: (value: string) => void;
  /** Escape. The field blurs after it. */
  onCancel?: () => void;
  /** A 16 px icon at the start (search, a layer type). */
  icon?: ReactNode;
  /** Something at the end: a clear button, a unit. */
  end?: ReactNode;
  size?: ControlSize;
  /** `field` is the grey well of the panels; `quiet` stays bare until hovered (inline rename, titles). */
  appearance?: 'field' | 'quiet';
  selectOnFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
};

/** A single-line text field. The wrapper draws the field; the native input inside stays bare (styles/base.css). */
export function TextInput({value, onChange, onCommit, onCancel, icon, end, size = 24, appearance = 'field', selectOnFocus = false, inputRef, className = '', onKeyDown, onFocus, onBlur, ...rest}: TextInputProps) {
  const committed = useRef(value);
  const cancelled = useRef(false);
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    // Without onCommit, Enter keeps its native meaning: it submits the form around the field
    // ("Save version" and other small forms rely on that).
    if (event.key === 'Enter' && onCommit) {
      event.preventDefault();
      committed.current = event.currentTarget.value;
      onCommit?.(event.currentTarget.value);
    } else if (event.key === 'Escape' && (onCancel || onCommit)) {
      // In a dialog a field with nothing of its own to undo lets Escape through: one press closes the dialog, as everywhere else.
      // Nothing is committed on the way out.
      if (!onCancel && event.currentTarget.closest('dialog')) {
        cancelled.current = true;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancelled.current = true;
      onCancel?.();
      event.currentTarget.blur();
    }
  };
  return (
    <label className={`dz-input is-${size} is-${appearance} ${className}`.trim()}>
      {icon && <span className="dz-input-icon">{icon}</span>}
      <input ref={inputRef} value={value} spellCheck={false} autoComplete="off" {...rest} onKeyDown={keyDown}
        onChange={event => onChange(event.currentTarget.value)}
        onFocus={event => {
          committed.current = event.currentTarget.value;
          cancelled.current = false;
          if (selectOnFocus) event.currentTarget.select();
          onFocus?.(event);
        }}
        onBlur={event => {
          onBlur?.(event);
          if (!cancelled.current && onCommit && event.currentTarget.value !== committed.current) onCommit(event.currentTarget.value);
          cancelled.current = false;
        }} />
      {end && <span className="dz-input-end">{end}</span>}
    </label>
  );
}
