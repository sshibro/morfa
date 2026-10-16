import {useLayoutEffect, useRef, type KeyboardEvent, type TextareaHTMLAttributes} from 'react';

export type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value' | 'rows'> & {
  value: string;
  onChange: (value: string) => void;
  /** Leaving the field with a changed value, or ⌘/Ctrl+Enter. Enter alone starts a new line. */
  onCommit?: (value: string) => void;
  /** Escape. The field blurs after it. */
  onCancel?: () => void;
  /** `field` is the grey well of the panels; `quiet` stays bare until hovered. */
  appearance?: 'field' | 'quiet';
  /** Tallest it grows before it scrolls, px. */
  maxHeight?: number;
  className?: string;
};

/** A multi-line text field that grows with its text, one line at rest (a component's description, as
 *  in Figma). Commits like TextInput: on leaving the field, or with ⌘/Ctrl+Enter; Escape cancels. */
export function TextArea({value, onChange, onCommit, onCancel, appearance = 'field', maxHeight = 160, className = '', onKeyDown, onFocus, onBlur, ...rest}: TextAreaProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(value);
  const cancelled = useRef(false);
  // Height follows the content: measured from one row up, so it shrinks again when lines go.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = '0px';
    const height = Math.min(maxHeight, element.scrollHeight);
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onCommit) {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape' && (onCancel || onCommit)) {
      event.preventDefault();
      event.stopPropagation();
      cancelled.current = true;
      onCancel?.();
      event.currentTarget.blur();
    }
  };
  return (
    <label className={`dz-input dz-textarea-field is-${appearance} ${className}`.trim()}>
      <textarea ref={field} rows={1} value={value} spellCheck autoComplete="off" {...rest} onKeyDown={keyDown}
        onChange={event => onChange(event.currentTarget.value)}
        onFocus={event => {
          committed.current = event.currentTarget.value;
          cancelled.current = false;
          onFocus?.(event);
        }}
        onBlur={event => {
          onBlur?.(event);
          if (!cancelled.current && onCommit && event.currentTarget.value !== committed.current) onCommit(event.currentTarget.value);
          cancelled.current = false;
        }} />
    </label>
  );
}
