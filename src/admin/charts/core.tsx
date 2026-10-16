import {useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode} from 'react';
import {dayLabel, monthLabel} from '../format';

// What every chart shares: its measured width, a clean value scale, day labels that never collide, week buckets for long windows,
// the one tooltip, keyboard stepping, and the table a screen reader reads instead of the picture. Charts never animate.

/** The element's content width, kept current with a ResizeObserver; 0 until measured. */
export function useWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    setWidth(Math.floor(node.getBoundingClientRect().width));
    observer.current = new ResizeObserver(entries => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth(previous => (previous === next ? previous : next));
    });
    observer.current.observe(node);
  }, []);
  useLayoutEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

/** 0, then round steps (1 · 2 · 2.5 · 5 × 10ⁿ) up to the first tick at or above `max`. Integer data never gets a fractional step. */
export function niceTicks(max: number, count = 4, integer = true): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, integer ? 1 : 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normal = raw / magnitude;
  let step = (normal <= 1 ? 1 : normal <= 2 ? 2 : normal <= 2.5 ? 2.5 : normal <= 5 ? 5 : 10) * magnitude;
  if (integer) step = Math.max(1, Math.round(step));
  // From 0 up to the first tick at or above the largest value, so nothing is drawn past the top line.
  const ticks: number[] = [0];
  while (ticks[ticks.length - 1] < max - step * 1e-9 && ticks.length < 14) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  return ticks;
}

/** Roughly how wide a tick label is at 11.5 px Inter (tabular). */
export const textWidth = (text: string, size = 11.5) => Math.ceil(text.length * size * 0.58);

export type Bucket = {
  /** The first and last day it covers. */
  from: string;
  to: string;
  /** Indexes into the day series. */
  indexes: number[];
  /** A week cut by the window's edge: drawn lighter, said in the tooltip. */
  partial: boolean;
};

const weekdayOf = (day: string) => (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7;

/** One bucket per day, or per Monday-to-Sunday week. */
export function buckets(days: readonly string[], unit: 'day' | 'week'): Bucket[] {
  if (unit === 'day') return days.map((day, index) => ({from: day, to: day, indexes: [index], partial: false}));
  const out: Bucket[] = [];
  days.forEach((day, index) => {
    const last = out[out.length - 1];
    if (last && weekdayOf(day) !== 0) {
      last.to = day;
      last.indexes.push(index);
    } else {
      out.push({from: day, to: day, indexes: [index], partial: false});
    }
  });
  for (const bucket of out) bucket.partial = bucket.indexes.length < 7;
  return out;
}

/** Days for windows up to two months; weeks beyond, so bars stay readable. */
export const unitFor = (dayCount: number): 'day' | 'week' => (dayCount > 62 ? 'week' : 'day');

export const bucketLabel = (bucket: Bucket) =>
  bucket.from === bucket.to ? dayLabel(bucket.from) : `${dayLabel(bucket.from)} – ${dayLabel(bucket.to)}`;

/** Which day positions get a label: about one per `spacing` px, months on long spans, the ends kept clear of each other. */
export function dayTicks(days: readonly string[], width: number, spacing = 84): number[] {
  const count = days.length;
  if (count === 0 || width <= 0) return [];
  if (count === 1) return [0];
  const room = Math.max(2, Math.floor(width / spacing));
  if (count > 75) {
    const starts = days.map((day, index) => (day.endsWith('-01') ? index : -1)).filter(index => index >= 0);
    const every = Math.max(1, Math.ceil(starts.length / room));
    return starts.filter((_, index) => index % every === 0);
  }
  const steps = [1, 2, 3, 7, 14, 21, 28];
  const step = steps.find(candidate => Math.ceil(count / candidate) <= room) ?? Math.ceil(count / room);
  const ticks: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) ticks.unshift(index);
  return ticks;
}

/** A tick label is centred on its position unless that would push it past the plot's edge. */
export function xAnchor(at: number, left: number, right: number, text: string): 'start' | 'middle' | 'end' {
  const half = textWidth(text) / 2;
  if (at - half < left - 2) return 'start';
  if (at + half > right + 2) return 'end';
  return 'middle';
}

/** The label at a tick: a month name at a month start on long spans, else the day. */
export const tickLabel = (days: readonly string[], index: number) => (days.length > 75 ? monthLabel(days[index]) : dayLabel(days[index]));

/** Arrow keys, Home and End step through `count` positions; Escape lets go. */
export function stepKeys(event: KeyboardEvent, active: number | null, count: number, set: (index: number | null) => void) {
  const at = active ?? count - 1;
  const moves: Record<string, number> = {ArrowLeft: at - 1, ArrowRight: at + 1, ArrowDown: at - 1, ArrowUp: at + 1, Home: 0, End: count - 1, PageUp: at - 7, PageDown: at + 7};
  if (event.key === 'Escape') {
    set(null);
    return;
  }
  if (!(event.key in moves)) return;
  event.preventDefault();
  set(Math.max(0, Math.min(count - 1, moves[event.key])));
}

export type TooltipRow = {key: string; color?: string; shape?: 'line' | 'square' | 'dot'; label: string; value: string; muted?: boolean};

/** The one tooltip: a title, then value-first rows keyed by a short mark of the series' colour. Placed beside `x`, flipped near the
 *  right edge, never past the chart. */
export function Tooltip({x, y, width, title, rows, note}: {x: number; y: number; width: number; title: string; rows: TooltipRow[]; note?: string}) {
  const flip = x > width * 0.58;
  const style: CSSProperties = {left: x, top: y, transform: `translate(${flip ? 'calc(-100% - 14px)' : '14px'}, -50%)`};
  return (
    <div className="mfa-tip" style={style} role="presentation">
      <div className="mfa-tip-title">{title}</div>
      {rows.map(row => (
        <div key={row.key} className={`mfa-tip-row${row.muted ? ' is-muted' : ''}`}>
          <i className={row.color ? `mfa-key is-${row.shape ?? 'line'}` : 'mfa-key'} style={row.color ? {background: row.color} : undefined} />
          <b>{row.value}</b>
          <span>{row.label}</span>
        </div>
      ))}
      {note && <div className="mfa-tip-note">{note}</div>}
    </div>
  );
}

/** What the picture shows, as a table only screen readers see. */
export function SrTable({caption, head, rows}: {caption: string; head: string[]; rows: Array<Array<string | number>>}) {
  return (
    <div className="mfa-sr">
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>{head.map(cell => <th key={cell} scope="col">{cell}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>{row.map((cell, column) => (column === 0 ? <th key={column} scope="row">{cell}</th> : <td key={column}>{cell}</td>))}</tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/** Spoken when keyboard focus moves along a chart. */
export function LiveText({children}: {children: ReactNode}) {
  return <span className="mfa-sr" aria-live="polite">{children}</span>;
}

export type LegendItem = {key: string; label: string; color: string; shape?: 'line' | 'square' | 'dot'; value?: string; off?: boolean};

/** The legend: always there for two or more series; a toggle when `onToggle` is given (at least one series stays on). */
export function Legend({items, onToggle}: {items: LegendItem[]; onToggle?: (key: string) => void}) {
  if (items.length < 2) return null;
  return (
    <ul className="mfa-legend">
      {items.map(item => {
        const content = (
          <>
            <i className={`mfa-key is-${item.shape ?? 'square'}`} style={{background: item.color}} />
            <span>{item.label}</span>
            {item.value && <b>{item.value}</b>}
          </>
        );
        return (
          <li key={item.key}>
            {onToggle ? (
              <button type="button" className={`mfa-legend-item${item.off ? ' is-off' : ''}`} aria-pressed={!item.off} onClick={() => onToggle(item.key)}>
                {content}
              </button>
            ) : (
              <span className="mfa-legend-item">{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A column with a 4 px rounded data end and a square foot at the baseline (or a fully square segment inside a stack). */
export function columnPath(x: number, y: number, width: number, height: number, round: boolean): string {
  if (height <= 0 || width <= 0) return '';
  const r = round ? Math.min(4, width / 2, height) : 0;
  const bottom = y + height;
  if (!r) return `M${x} ${bottom}V${y}H${x + width}V${bottom}Z`;
  return `M${x} ${bottom}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + width - r}Q${x + width} ${y} ${x + width} ${y + r}V${bottom}Z`;
}

/** A horizontal bar with its 4 px rounded end on the right. */
export function barPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0 || width <= 0) return '';
  const r = Math.min(4, height / 2, width);
  return `M${x} ${y}H${x + width - r}Q${x + width} ${y} ${x + width} ${y + r}V${y + height - r}Q${x + width} ${y + height} ${x + width - r} ${y + height}H${x}Z`;
}
