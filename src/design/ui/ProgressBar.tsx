import type {CSSProperties, ReactNode} from 'react';

/**
 * A usage meter ("2 of 3 files"): a thin track with a fill that turns orange past 80 % and red
 * at the limit. `max` null means unlimited: the label shows, the bar does not.
 */
export function ProgressBar({value, max, label, valueText, className = ''}: {value: number; max: number | null; label: ReactNode; valueText?: string; className?: string}) {
  const ratio = max ? Math.min(1, Math.max(0, value / max)) : 0;
  const level = !max ? 'none' : value >= max ? 'full' : ratio >= 0.8 ? 'high' : 'normal';
  return (
    <div className={`dz-meter is-${level} ${className}`.trim()}>
      <div className="dz-meter-label">{label}</div>
      {max !== null && (
        <div className="dz-meter-track" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} aria-valuetext={valueText}
          style={{'--dz-ratio': ratio} as CSSProperties}>
          <span className="dz-meter-fill" />
        </div>
      )}
    </div>
  );
}

/** An empty, error or limit state: a quiet icon, a title, one line of explanation and the way forward. */
export function EmptyState({icon, title, children, actions, tone = 'neutral', className = ''}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: 'neutral' | 'error';
  className?: string;
}) {
  return (
    <div className={`dz-empty is-${tone} ${className}`.trim()} role={tone === 'error' ? 'alert' : undefined}>
      {icon && <div className="dz-empty-icon" aria-hidden="true">{icon}</div>}
      <h2 className="dz-empty-title">{title}</h2>
      {children && <p className="dz-empty-text">{children}</p>}
      {actions && <div className="dz-empty-actions">{actions}</div>}
    </div>
  );
}
