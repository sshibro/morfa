import type {ButtonHTMLAttributes, ReactNode, Ref} from 'react';
import {Spinner} from './Spinner';
import {useTooltip, type TooltipContent} from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ControlSize = 24 | 32;

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  variant?: ButtonVariant;
  /** 24 px in panels, 32 px in dialogs, the file browser and the toolbar. */
  size?: ControlSize;
  /** A 16 px icon before the label. */
  icon?: ReactNode;
  /** Shows a spinner in place of the label, keeps the width and blocks clicks. */
  busy?: boolean;
  /** No press scale (dense rows where motion would distract). */
  static?: boolean;
  type?: 'button' | 'submit' | 'reset';
  ref?: Ref<HTMLButtonElement>;
};

/** A text button. Primary is the accent; secondary is outlined; ghost is bare; danger is red. */
export function Button({variant = 'secondary', size = 24, icon, busy = false, static: still = false, className = '', children, disabled, type = 'button', ref, ...rest}: ButtonProps) {
  return (
    <button ref={ref} type={type} className={`dz-btn is-${variant} is-${size} ${icon ? 'has-icon' : ''} ${still ? 'is-static' : ''} ${busy ? 'is-busy' : ''} ${className}`.trim()}
      disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      <span className="dz-btn-content">{icon}{children !== undefined && <span className="dz-btn-label">{children}</span>}</span>
      {busy && <Spinner size={size === 32 ? 16 : 12} className="dz-btn-spinner" />}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-label'> & {
  /** Accessible name and tooltip. */
  label: string;
  /** Printed in the tooltip (shortcuts.ts format). */
  shortcut?: string;
  tooltip?: boolean | Omit<TooltipContent, 'label' | 'shortcut'>;
  size?: ControlSize;
  /** A toggle's state (aria-pressed). */
  pressed?: boolean;
  /** `panel` toggles fill grey; `toolbar` toggles fill the accent, as the active tool does. */
  tone?: 'panel' | 'toolbar';
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
};

/** A square icon button (24 px in panels, 32 px in the toolbar) with a tooltip naming it. */
export function IconButton({label, shortcut, tooltip = true, size = 24, pressed, tone = 'panel', className = '', children, ref, onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur, ...rest}: IconButtonProps) {
  const tip = useTooltip(tooltip ? {label, shortcut, ...(typeof tooltip === 'object' ? tooltip : {})} : null);
  return (
    <button ref={ref} type="button" aria-label={label} aria-pressed={pressed} className={`dz-icon-btn is-${size} is-${tone} ${className}`.trim()} {...rest}
      onPointerEnter={event => {onPointerEnter?.(event); tip.onPointerEnter?.(event);}}
      onPointerLeave={event => {onPointerLeave?.(event); tip.onPointerLeave?.(event);}}
      onPointerDown={event => {onPointerDown?.(event); tip.onPointerDown?.(event);}}
      onFocus={event => {onFocus?.(event); tip.onFocus?.(event);}}
      onBlur={event => {onBlur?.(event); tip.onBlur?.(event);}}>
      {children}
    </button>
  );
}
