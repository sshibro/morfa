import {useCallback, type ReactNode} from 'react';
import type {ControlSize} from './Button';
import {IconChevronDown} from './icons';
import {useMenuTrigger} from './Menu';
import type {MenuItem} from './menu-model';

export type SelectOption<T extends string> = {value: T; label: string; icon?: ReactNode; shortcut?: string; disabled?: boolean; description?: string};
export type SelectEntry<T extends string> = SelectOption<T> | {separator: true} | {heading: string};

export type SelectProps<T extends string> = {
  value: T | null;
  options: readonly SelectEntry<T>[];
  onChange: (value: T) => void;
  'aria-label': string;
  /** Shown when nothing is chosen; "Mixed" for a mixed selection. */
  placeholder?: string;
  mixed?: boolean;
  size?: ControlSize;
  /** `field` is the grey panel well; `quiet` is bare until hovered (inline in a row). */
  appearance?: 'field' | 'quiet';
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
};

const isOption = <T extends string>(entry: SelectEntry<T>): entry is SelectOption<T> => 'value' in entry;

/** A dropdown: the dark menu opens over the trigger with the chosen option where the trigger's text was. */
export function Select<T extends string>({value, options, onChange, placeholder = '', mixed = false, size = 24, appearance = 'field', icon, disabled, className = '', ...aria}: SelectProps<T>) {
  const chosen = options.find((entry): entry is SelectOption<T> => isOption(entry) && entry.value === value);
  const items = useCallback((): MenuItem[] => options.map((entry): MenuItem => {
    if ('separator' in entry) return {type: 'separator'};
    if ('heading' in entry) return {type: 'label', label: entry.heading};
    return {id: entry.value, label: entry.label, icon: entry.icon, shortcut: entry.shortcut, disabled: entry.disabled, description: entry.description,
      checked: !mixed && entry.value === value, radio: true, onSelect: () => onChange(entry.value)};
  }), [options, value, mixed, onChange]);
  const menu = useMenuTrigger({items, label: aria['aria-label'], alignItemId: !mixed && value !== null ? value : undefined, alignInset: icon ? 32 : 8, minWidth: 120});
  return (
    <>
      <button type="button" disabled={disabled} aria-label={aria['aria-label']} {...menu.triggerProps}
        className={`dz-select is-${size} is-${appearance} ${icon ? 'has-icon' : ''} ${className}`.trim()}>
        {icon && <span className="dz-select-icon">{icon}</span>}
        <span className={`dz-select-value ${!chosen ? 'is-placeholder' : ''}`}>{mixed ? 'Mixed' : chosen?.label ?? placeholder}</span>
        <span className="dz-select-chevron"><IconChevronDown size={12} /></span>
      </button>
      {menu.element}
    </>
  );
}
