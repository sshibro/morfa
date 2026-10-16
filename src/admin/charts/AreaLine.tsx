import {useMemo, useState, type PointerEvent} from 'react';
import {dayLabel, num} from '../format';
import {dayTicks, Legend, LiveText, niceTicks, SrTable, stepKeys, textWidth, tickLabel, Tooltip, useWidth, xAnchor} from './core';

export type LineSeries = {key: string; label: string; values: number[]; color: string; area?: boolean};

type AreaLineProps = {
  /** Accessible name. */
  label: string;
  days: string[];
  series: LineSeries[];
  height?: number;
  /** Values in the tooltip, the end labels and the table. */
  format?: (value: number) => string;
  /** Tick labels (compact). */
  axis?: (value: number) => string;
  integer?: boolean;
  /** The legend switches series on and off. */
  toggle?: boolean;
  /** The last value of each series beside its line end. */
  endLabels?: boolean;
};

const PAD = {top: 14, bottom: 28};

/** Lines over days (2 px, a 10 % wash under the series that ask for it), one y-axis, a crosshair that snaps to the nearest day and a
 *  tooltip listing every series there. Keyboard: focus the plot, then arrows, Home, End. */
export function AreaLine({label, days, series, height = 240, format = num, axis, integer = true, toggle = false, endLabels = false}: AreaLineProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<number | null>(null);
  const visible = series.filter(item => !hidden.has(item.key));
  const tickText = axis ?? format;

  const max = Math.max(0, ...visible.flatMap(item => item.values));
  const ticks = useMemo(() => niceTicks(max, height < 160 ? 3 : 4, integer), [max, height, integer]);
  const top = ticks[ticks.length - 1] || 1;
  const left = Math.max(...ticks.map(tick => textWidth(tickText(tick)))) + 12;
  const endWidth = endLabels ? Math.max(0, ...visible.map(item => textWidth(format(item.values[item.values.length - 1] ?? 0), 12))) + 14 : 0;
  const right = Math.max(10, endWidth);
  const plotWidth = Math.max(10, width - left - right);
  const plotHeight = height - PAD.top - PAD.bottom;
  const count = days.length;
  const x = (index: number) => left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) => PAD.top + plotHeight * (1 - value / top);
  const base = y(0);

  const paths = visible.map(item => {
    const points = item.values.map((value, index) => `${x(index).toFixed(1)} ${y(value).toFixed(1)}`);
    const line = 'M' + points.join('L');
    const area = item.area ? `${line}L${x(count - 1).toFixed(1)} ${base}L${x(0).toFixed(1)} ${base}Z` : '';
    return {item, line, area};
  });

  const ticksX = dayTicks(days, plotWidth);

  // End labels: the last value of each series; when two would overlap, only the first keeps its label (the legend still names both).
  const ends: Array<{key: string; y: number; text: string}> = [];
  if (endLabels && count > 0) {
    for (const item of visible) {
      const value = item.values[count - 1] ?? 0;
      const at = y(value);
      if (ends.some(end => Math.abs(end.y - at) < 15)) continue;
      ends.push({key: item.key, y: at, text: format(value)});
    }
  }

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / Math.max(1, box.width);
    setActive(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
  };

  const toggleSeries = (key: string) =>
    setHidden(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else if (series.length - next.size > 1) next.add(key);
      return next;
    });

  const activeRows = active === null ? [] : visible.map(item => ({key: item.key, color: item.color, label: item.label, value: format(item.values[active] ?? 0)}));

  return (
    <div className="mfa-chart">
      <Legend items={series.map(item => ({key: item.key, label: item.label, color: item.color, shape: 'line', off: hidden.has(item.key)}))} onToggle={toggle ? toggleSeries : undefined} />
      <div
        ref={ref}
        className="mfa-plot"
        style={{height}}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={label}
        onKeyDown={event => stepKeys(event, active, count, setActive)}
        onBlur={() => setActive(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true">
            {ticks.map(tick => (
              <g key={tick}>
                <line className={tick === 0 ? 'mfa-axis-base' : 'mfa-gridline'} x1={left} x2={left + plotWidth} y1={y(tick)} y2={y(tick)} />
                <text className="mfa-tick" x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{tickText(tick)}</text>
              </g>
            ))}
            {ticksX.map(index => {
              const at = x(index);
              const text = tickLabel(days, index);
              return <text key={index} className="mfa-tick" x={at} y={height - 8} textAnchor={xAnchor(at, left, left + plotWidth, text)}>{text}</text>;
            })}
            {paths.map(({item, area}) => area && <path key={item.key + '-area'} d={area} fill={item.color} opacity={0.1} />)}
            {paths.map(({item, line}) => (
              <path key={item.key} d={line} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {ends.map(end => {
              const item = visible.find(entry => entry.key === end.key)!;
              return (
                <g key={end.key}>
                  <circle cx={x(count - 1)} cy={end.y} r={4} fill={item.color} className="mfa-ring" />
                  <text className="mfa-end" x={x(count - 1) + 9} y={end.y} dy="0.32em">{end.text}</text>
                </g>
              );
            })}
            {active !== null && (
              <g>
                <line className="mfa-cross" x1={x(active)} x2={x(active)} y1={PAD.top - 4} y2={base} />
                {visible.map(item => (
                  <circle key={item.key} cx={x(active)} cy={y(item.values[active] ?? 0)} r={4} fill={item.color} className="mfa-ring" />
                ))}
              </g>
            )}
            <rect
              x={left}
              y={0}
              width={plotWidth}
              height={height}
              fill="transparent"
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={() => setActive(null)}
            />
          </svg>
        )}
        {active !== null && width > 0 && (
          <Tooltip x={x(active)} y={Math.min(...visible.map(item => y(item.values[active] ?? 0)), base - 20)} width={width} title={dayLabel(days[active])} rows={activeRows} />
        )}
        {active !== null && <LiveText>{`${dayLabel(days[active])}: ${activeRows.map(row => `${row.label} ${row.value}`).join(', ')}`}</LiveText>}
      </div>
      <SrTable caption={label} head={['Day', ...series.map(item => item.label)]} rows={days.map((day, index) => [dayLabel(day), ...series.map(item => format(item.values[index] ?? 0))])} />
    </div>
  );
}
