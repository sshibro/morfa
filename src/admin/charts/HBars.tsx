import type {ReactNode} from 'react';
import {num} from '../format';

export type HBarRow = {
  key: string;
  label: ReactNode;
  /** The label as plain text (title, table). */
  text: string;
  value: number;
  /** What the value says (defaults to `format(value)`). */
  display?: string;
  /** A second, quieter figure after the value. */
  extra?: string;
  href?: string;
};

type HBarsProps = {
  label: string;
  rows: HBarRow[];
  format?: (value: number) => string;
  color?: string;
  /** Bars against this instead of the largest value (a share against 1). */
  max?: number;
  /** The label column's width. */
  labelWidth?: number | string;
  empty?: string;
};

/** Nominal categories ranked: one colour for every bar (the bar length is the value), the label left, the value right. The list is
 *  text already (label, value), so a screen reader reads it as it is; the bars are decoration. */
export function HBars({label, rows, format = num, color = 'var(--mfa-viz-1)', max, labelWidth = '38%', empty = 'No data'}: HBarsProps) {
  const top = max ?? Math.max(0, ...rows.map(row => row.value));
  if (rows.length === 0) return <p className="mfa-none">{empty}</p>;
  return (
    <div className={`mfa-hbars${max !== undefined ? ' has-track' : ''}`} style={{['--mfa-hbars-label' as string]: typeof labelWidth === 'number' ? `${labelWidth}px` : labelWidth}}>
      <ul aria-label={label}>
        {rows.map(row => {
          const width = top > 0 ? (row.value / top) * 100 : 0;
          const body = (
            <>
              <span className="mfa-hbars-label" title={row.text}>{row.label}</span>
              <span className="mfa-hbars-track" aria-hidden="true">
                <i style={{width: `${row.value > 0 ? Math.max(width, 0.8) : 0}%`, background: color}} />
              </span>
              <b className="mfa-hbars-value">{row.display ?? format(row.value)}</b>
              {row.extra !== undefined && <em className="mfa-hbars-extra">{row.extra}</em>}
            </>
          );
          return (
            <li key={row.key} className={row.extra !== undefined ? 'has-extra' : undefined}>
              {row.href ? <a href={row.href}>{body}</a> : <div>{body}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
