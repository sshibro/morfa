import {useMemo, useState, type PointerEvent} from 'react';
import {num} from '../format';
import {bucketLabel, buckets, columnPath, Legend, LiveText, niceTicks, SrTable, stepKeys, textWidth, Tooltip, unitFor, useWidth, xAnchor, type Bucket} from './core';
import {dayLabel, monthLabel} from '../format';

export type BarSeries = {key: string; label: string; values: number[]; color: string};

type BarsProps = {
  label: string;
  days: string[];
  /** One series: plain columns; several: stacked in this order from the baseline up. */
  series: BarSeries[];
  height?: number;
  format?: (value: number) => string;
  axis?: (value: number) => string;
  integer?: boolean;
  /** 'auto': days up to two months, weeks beyond. */
  unit?: 'auto' | 'day' | 'week';
  /** Show the total of the stack in the tooltip. */
  total?: boolean;
  toggle?: boolean;
  /** Draw the legend above the plot (false: the section's head carries it, so small multiples share one baseline). */
  legend?: boolean;
};

const PAD = {top: 12, bottom: 28};
const MAX_BAR = 24;
const GAP = 2;

/** Columns per day (or week) from one baseline: ≤ 24 px, a 4 px rounded top, 2 px of surface between stacked segments and between
 *  neighbours. A partial week at the window's edge is drawn lighter. The whole column is the hover target. */
export function Bars({label, days, series, height = 220, format = num, axis, integer = true, unit = 'auto', total = true, toggle = false, legend = true}: BarsProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const resolved = unit === 'auto' ? unitFor(days.length) : unit;
  const groups: Bucket[] = useMemo(() => buckets(days, resolved), [days, resolved]);
  const visible = series.filter(item => !hidden.has(item.key));
  const tickText = axis ?? format;

  // Sums per bucket and series.
  const sums = useMemo(
    () => groups.map(group => visible.map(item => group.indexes.reduce((sum, index) => sum + (item.values[index] ?? 0), 0))),
    [groups, visible],
  );
  const totals = sums.map(row => row.reduce((sum, value) => sum + value, 0));
  const max = Math.max(0, ...totals);
  const ticks = useMemo(() => niceTicks(max, height < 160 ? 3 : 4, integer), [max, height, integer]);
  const top = ticks[ticks.length - 1] || 1;
  const left = Math.max(...ticks.map(tick => textWidth(tickText(tick)))) + 12;
  const plotWidth = Math.max(10, width - left - 6);
  const plotHeight = height - PAD.top - PAD.bottom;
  const count = groups.length;
  const slot = plotWidth / Math.max(1, count);
  const barWidth = Math.max(2, Math.min(MAX_BAR, slot - GAP, slot * (count > 40 ? 0.8 : 0.66)));
  const xOf = (index: number) => left + index * slot + (slot - barWidth) / 2;
  const centre = (index: number) => left + index * slot + slot / 2;
  const y = (value: number) => PAD.top + plotHeight * (1 - value / top);
  const base = y(0);

  // Tick labels: about one per 84 px, from the newest backwards; weeks show their Monday, long spans the month.
  const labelEvery = Math.max(1, Math.ceil(84 / slot));
  const labelled = groups.map((_, index) => index).filter(index => (count - 1 - index) % labelEvery === 0);
  const labelOf = (group: Bucket) => (resolved === 'week' && count > 30 ? monthLabel(group.from) : dayLabel(group.from));

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / Math.max(1, box.width)) * count);
    setActive(Math.max(0, Math.min(count - 1, index)));
  };

  const toggleSeries = (key: string) =>
    setHidden(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else if (series.length - next.size > 1) next.add(key);
      return next;
    });

  const activeRows =
    active === null
      ? []
      : [
          // Top of the stack first; parts that are zero at this point are left out (the total still counts them).
          ...visible
            .map((item, position) => ({key: item.key, color: item.color, shape: 'square' as const, label: item.label, value: format(sums[active][position]), zero: sums[active][position] === 0}))
            .filter(row => !row.zero || visible.length === 1)
            .reverse(),
          ...(total && visible.length > 1 ? [{key: '__total', label: 'total', value: format(totals[active])}] : []),
        ];
  const activeGroup = active === null ? null : groups[active];

  return (
    <div className="mfa-chart">
      {legend && <Legend items={series.map(item => ({key: item.key, label: item.label, color: item.color, off: hidden.has(item.key)}))} onToggle={toggle ? toggleSeries : undefined} />}
      <div
        ref={ref}
        className="mfa-plot"
        style={{height}}
        tabIndex={0}
        role="group"
        aria-roledescription="bar chart"
        aria-label={label}
        onKeyDown={event => stepKeys(event, active, count, setActive)}
        onBlur={() => setActive(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true">
            {active !== null && <rect className="mfa-band" x={left + active * slot} y={PAD.top - 6} width={slot} height={base - PAD.top + 6} rx={6} />}
            {ticks.map(tick => (
              <g key={tick}>
                <line className={tick === 0 ? 'mfa-axis-base' : 'mfa-gridline'} x1={left} x2={left + plotWidth} y1={y(tick)} y2={y(tick)} />
                <text className="mfa-tick" x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{tickText(tick)}</text>
              </g>
            ))}
            {groups.map((group, index) => {
              let running = 0;
              const parts = visible.map((item, position) => {
                const value = sums[index][position];
                const y0 = y(running);
                running += value;
                const y1 = y(running);
                return {item, value, y0, y1};
              });
              const topmost = parts.reduce((found, part, position) => (part.value > 0 ? position : found), -1);
              return (
                <g key={group.from} opacity={group.partial && resolved === 'week' ? 0.45 : 1}>
                  {parts.map((part, position) => {
                    if (part.value <= 0) return null;
                    // 2 px of surface between stacked segments: each segment above the first gives up its bottom 2 px.
                    const gap = position > 0 && parts.slice(0, position).some(previous => previous.value > 0) ? GAP : 0;
                    const segmentHeight = part.y0 - part.y1 - gap;
                    if (segmentHeight < 0.5) return null;
                    return <path key={part.item.key} d={columnPath(xOf(index), part.y1, barWidth, segmentHeight, position === topmost)} fill={part.item.color} />;
                  })}
                </g>
              );
            })}
            {labelled.map(index => {
              const at = centre(index);
              const text = labelOf(groups[index]);
              return <text key={index} className="mfa-tick" x={at} y={height - 8} textAnchor={xAnchor(at, left, left + plotWidth, text)}>{text}</text>;
            })}
            <rect x={left} y={0} width={plotWidth} height={height} fill="transparent" onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setActive(null)} />
          </svg>
        )}
        {activeGroup && active !== null && width > 0 && (
          <Tooltip
            x={centre(active)}
            y={Math.max(PAD.top + 24, Math.min(y(totals[active]), base - 24))}
            width={width}
            title={bucketLabel(activeGroup)}
            rows={activeRows}
            note={activeGroup.partial && resolved === 'week' ? `partial week: ${activeGroup.indexes.length} of 7 days` : undefined}
          />
        )}
        {activeGroup && active !== null && <LiveText>{`${bucketLabel(activeGroup)}: ${activeRows.map(row => `${row.label} ${row.value}`).join(', ')}`}</LiveText>}
      </div>
      <SrTable
        caption={label}
        head={[resolved === 'week' ? 'Week' : 'Day', ...series.map(item => item.label)]}
        rows={groups.map(group => [bucketLabel(group), ...series.map(item => format(group.indexes.reduce((sum, index) => sum + (item.values[index] ?? 0), 0)))])}
      />
    </div>
  );
}
