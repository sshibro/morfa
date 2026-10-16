import type {ReactNode} from 'react';

// Buttons with roles rather than native inputs: the app's own checkbox styles (lime ticks on
// ink, src/styles/brand/components.css) target input[type=checkbox] and never reach these.

type ToggleProps = {
  checked: boolean | 'mixed';
  onChange: (checked: boolean) => void;
  /** Visible label; without it pass aria-label. */
  children?: ReactNode;
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
};

export function Checkbox({checked, onChange, children, disabled, className = '', ...aria}: ToggleProps) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={aria['aria-label']} disabled={disabled}
      className={`dz-check ${className}`.trim()} onClick={() => onChange(checked !== true)}>
      <span className="dz-check-box" aria-hidden="true">
        {checked === true && <svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.75 6.25 5 8.5l4.25-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        {checked === 'mixed' && <svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 6h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
      </span>
      {children && <span className="dz-check-label">{children}</span>}
    </button>
  );
}

export function Toggle({checked, onChange, children, disabled, className = '', ...aria}: ToggleProps) {
  return (
    <button type="button" role="switch" aria-checked={checked === true} aria-label={aria['aria-label']} disabled={disabled}
      className={`dz-switch ${className}`.trim()} onClick={() => onChange(checked !== true)}>
      {children && <span className="dz-switch-label">{children}</span>}
      <span className="dz-switch-track" aria-hidden="true"><span className="dz-switch-thumb" /></span>
    </button>
  );
}
