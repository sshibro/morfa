import type {CSSProperties} from 'react';
import {pct} from '../format';

export type MeterTone = 'brand' | 'good' | 'warning' | 'critical';

const FILL: Record<MeterTone, string> = {
  brand: 'var(--mfa-viz-1)',
  good: 'var(--mfa-status-good)',
  warning: 'var(--mfa-status-warning)',
  critical: 'var(--mfa-status-critical)',
};

/** A ratio against a limit: the fill carries the severity, the track is a light step of the same hue. */
export function Meter({value, max, tone = 'brand', label, height = 8}: {value: number; max: number; tone?: MeterTone; label: string; height?: number}) {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div
      className={`mfa-meter is-${tone}`}
      style={{height, ['--mfa-meter-fill' as string]: FILL[tone]} as CSSProperties}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={pct(share)}
    >
      <i style={{width: `${share * 100}%`}} />
    </div>
  );
}

/** A half-ring gauge for one share 0..1 (stickiness): the value large in the middle. */
export function Gauge({share, label, caption}: {share: number; label: string; caption: string}) {
  const clamped = Math.max(0, Math.min(1, share));
  const size = 200;
  const stroke = 16;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const start = Math.PI;
  const end = Math.PI + Math.PI * clamped;
  const point = (angle: number) => `${(cx + r * Math.cos(angle)).toFixed(2)} ${(cy + r * Math.sin(angle)).toFixed(2)}`;
  return (
    <div className="mfa-gauge" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)} aria-valuetext={pct(clamped)}>
      <svg viewBox={`0 0 ${size} ${size / 2 + stroke / 2}`} aria-hidden="true">
        <path d={`M${point(start)}A${r} ${r} 0 0 1 ${point(2 * Math.PI)}`} className="mfa-gauge-track" strokeWidth={stroke} fill="none" strokeLinecap="round" />
        {clamped > 0 && <path d={`M${point(start)}A${r} ${r} 0 0 1 ${point(end)}`} stroke="var(--mfa-viz-1)" strokeWidth={stroke} fill="none" strokeLinecap="round" />}
      </svg>
      <div className="mfa-gauge-value">
        <b>{pct(clamped)}</b>
        <span>{caption}</span>
      </div>
    </div>
  );
}
