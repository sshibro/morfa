import {useState, type KeyboardEvent} from 'react';
import {num} from '../format';
import {SEQUENTIAL, sequentialStep} from '../palette';
import {LiveText, SrTable, Tooltip, useWidth} from './core';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LABEL = 26;
const HEAD = 18;
const GAP = 2;

const hourText = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** When people work: 7 weekdays × 24 Moscow hours, one indigo hue from "nothing" (the surface) to the busiest hour, with a scale and
 *  the peak named. Each cell is its own hover target; the grid takes arrow keys. */
export function Heatmap({label, grid, unit = (value: number) => num(value)}: {label: string; grid: number[][]; unit?: (value: number) => string}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<[number, number] | null>(null);
  const max = Math.max(0, ...grid.flat());
  const cell = Math.max(6, Math.min(30, (width - LABEL) / 24));
  const height = HEAD + 7 * cell;
  let peak: [number, number] = [0, 0];
  grid.forEach((row, day) => row.forEach((value, hour) => {
    if (value > grid[peak[0]][peak[1]]) peak = [day, hour];
  }));

  const onKey = (event: KeyboardEvent) => {
    const [day, hour] = active ?? peak;
    const moves: Record<string, [number, number]> = {ArrowLeft: [day, hour - 1], ArrowRight: [day, hour + 1], ArrowUp: [day - 1, hour], ArrowDown: [day + 1, hour], Home: [day, 0], End: [day, 23]};
    if (event.key === 'Escape') return setActive(null);
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    setActive([Math.max(0, Math.min(6, next[0])), Math.max(0, Math.min(23, next[1]))]);
  };

  const value = active ? grid[active[0]]?.[active[1]] ?? 0 : 0;
  const title = active ? `${WEEKDAYS_LONG[active[0]]}, ${hourText(active[1])}–${hourText((active[1] + 1) % 24)}` : '';

  return (
    <div className="mfa-chart">
      <div ref={ref} className="mfa-plot" style={{height}} tabIndex={0} role="group" aria-roledescription="heatmap" aria-label={label} onKeyDown={onKey} onBlur={() => setActive(null)}>
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true">
            {[0, 3, 6, 9, 12, 15, 18, 21].map(hour => (
              <text key={hour} className="mfa-tick" x={LABEL + hour * cell + 1} y={11}>{hour}</text>
            ))}
            {grid.map((row, day) => (
              <g key={day}>
                <text className="mfa-tick" x={0} y={HEAD + day * cell + cell / 2} dy="0.32em">{WEEKDAYS[day]}</text>
                {row.map((count, hour) => {
                  const step = max > 0 ? sequentialStep(count / max) : 0;
                  const on = active && active[0] === day && active[1] === hour;
                  return (
                    <rect
                      key={hour}
                      x={LABEL + hour * cell + GAP / 2}
                      y={HEAD + day * cell + GAP / 2}
                      width={cell - GAP}
                      height={cell - GAP}
                      rx={Math.min(4, cell / 5)}
                      fill={SEQUENTIAL[step]}
                      className={on ? 'mfa-cell is-active' : 'mfa-cell'}
                      onPointerEnter={() => setActive([day, hour])}
                      onPointerLeave={() => setActive(null)}
                    />
                  );
                })}
              </g>
            ))}
          </svg>
        )}
        {active && width > 0 && (
          <Tooltip x={LABEL + active[1] * cell + cell / 2} y={HEAD + active[0] * cell + cell / 2} width={width} title={title} rows={[{key: 'v', label: 'requests', value: unit(value)}]} />
        )}
        {active && <LiveText>{`${title}: ${unit(value)}`}</LiveText>}
      </div>
      <div className="mfa-scale">
        <span>less</span>
        {SEQUENTIAL.map((color, index) => <i key={index} style={{background: color}} />)}
        <span>more</span>
        {max > 0 && <em>peak: {WEEKDAYS[peak[0]]}, {hourText(peak[1])}</em>}
      </div>
      <SrTable caption={label} head={['Day', ...Array.from({length: 24}, (_, hour) => hourText(hour))]} rows={grid.map((row, day) => [WEEKDAYS_LONG[day], ...row.map(count => unit(count))])} />
    </div>
  );
}
