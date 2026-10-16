import {useRef, type KeyboardEvent, type ReactNode} from 'react';
import {useTooltip} from './Tooltip';

// Panel tabs ("Design / Prototype / Code", "File / Assets") and segmented controls. Both move with
// the arrow keys and select as they move (automatic activation), with one tab stop for the group.

export type TabItem<T extends string> = {id: T; label: string; disabled?: boolean; /** A count after the label (unread comments); none at 0. */ badge?: number};

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const tabPanelId = (base: string, id: string) => `${base}-panel-${id}`;

function rovingKey<T>(event: KeyboardEvent, values: readonly T[], current: T, enabled: (value: T) => boolean, vertical = false): T | null {
  const back = vertical ? 'ArrowUp' : 'ArrowLeft';
  const forward = vertical ? 'ArrowDown' : 'ArrowRight';
  const usable = values.filter(enabled);
  if (!usable.length) return null;
  const index = usable.indexOf(current);
  if (event.key === forward) return usable[(index + 1) % usable.length];
  if (event.key === back) return usable[(index - 1 + usable.length) % usable.length];
  if (event.key === 'Home') return usable[0];
  if (event.key === 'End') return usable[usable.length - 1];
  return null;
}

export function Tabs<T extends string>({tabs, value, onChange, idBase, className = '', ...aria}: {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Ties each tab to its panel (TabPanel with the same base). */
  idBase: string;
  'aria-label': string;
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div ref={list} role="tablist" aria-label={aria['aria-label']} className={`dz-tabs ${className}`.trim()}
      onKeyDown={event => {
        const next = rovingKey(event, tabs.map(tab => tab.id), value, id => !tabs.find(tab => tab.id === id)?.disabled);
        if (next === null) return;
        event.preventDefault();
        onChange(next);
        list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(idBase, next))}`)?.focus();
      }}>
      {tabs.map(tab => (
        <button key={tab.id} type="button" role="tab" id={tabId(idBase, tab.id)} aria-controls={tabPanelId(idBase, tab.id)} aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1} disabled={tab.disabled} className="dz-tab" onClick={() => onChange(tab.id)}>
          {tab.label}
          {tab.badge ? <span className="dz-tab-badge" aria-label={`, new: ${tab.badge}`}>{tab.badge > 99 ? '99+' : tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({idBase, id, className = '', children}: {idBase: string; id: string; className?: string; children: ReactNode}) {
  return (
    <div role="tabpanel" id={tabPanelId(idBase, id)} aria-labelledby={tabId(idBase, id)} className={className}>
      {children}
    </div>
  );
}

export type SegmentOption<T extends string> = {value: T; label: string; icon?: ReactNode; disabled?: boolean};

/** A segmented control. Icon-only segments name themselves through a tooltip. */
export function SegmentedControl<T extends string>({options, value, onChange, size = 24, className = '', fill = false, ...aria}: {
  options: readonly SegmentOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  'aria-label': string;
  size?: 24 | 32;
  /** Stretch the segments to the control's width. */
  fill?: boolean;
  className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const focusable = value ?? options.find(option => !option.disabled)?.value;
  return (
    <div ref={group} role="radiogroup" aria-label={aria['aria-label']} className={`dz-segmented is-${size} ${fill ? 'is-fill' : ''} ${className}`.trim()}
      onKeyDown={event => {
        if (!focusable) return;
        const next = rovingKey(event, options.map(option => option.value), focusable, option => !options.find(entry => entry.value === option)?.disabled);
        if (next === null) return;
        event.preventDefault();
        onChange(next);
        group.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next)}"]`)?.focus();
      }}>
      {options.map(option => <Segment key={option.value} option={option} checked={option.value === value} focusable={option.value === focusable} onSelect={onChange} />)}
    </div>
  );
}

function Segment<T extends string>({option, checked, focusable, onSelect}: {option: SegmentOption<T>; checked: boolean; focusable: boolean; onSelect: (value: T) => void}) {
  const tip = useTooltip(option.icon ? {label: option.label} : null);
  return (
    <button type="button" role="radio" aria-checked={checked} aria-label={option.icon ? option.label : undefined} data-value={option.value}
      tabIndex={focusable ? 0 : -1} disabled={option.disabled} className={`dz-segment ${option.icon ? 'is-icon' : ''}`.trim()} onClick={() => onSelect(option.value)} {...tip}>
      {option.icon ?? option.label}
    </button>
  );
}
