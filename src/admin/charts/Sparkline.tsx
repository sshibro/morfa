import {useWidth} from './core';

type SparklineProps = {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  /** A 10 % wash under the line. */
  area?: boolean;
  /** The last point as a dot in the accent. */
  dot?: boolean;
  className?: string;
};

function SparkPath({values, width, height, color, area, dot}: Required<Omit<SparklineProps, 'className'>>) {
  const count = values.length;
  if (count === 0 || width <= 0) return null;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pad = dot ? 3.5 : 1.5;
  const x = (index: number) => pad + (count === 1 ? (width - pad * 2) / 2 : (index / (count - 1)) * (width - pad * 2));
  const y = (value: number) => pad + (height - pad * 2) * (1 - (value - min) / span);
  const line = 'M' + values.map((value, index) => `${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join('L');
  return (
    <svg width={width} height={height} aria-hidden="true" className="mfa-spark">
      {area && <path d={`${line}L${x(count - 1).toFixed(1)} ${height}L${x(0).toFixed(1)} ${height}Z`} fill={color} opacity={0.1} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      {dot && <circle cx={x(count - 1)} cy={y(values[count - 1])} r={3} fill={color} className="mfa-ring" />}
    </svg>
  );
}

/** A trend without axes: fixed size (table rows), or as wide as its box (`width` left out). Decoration beside a number that says it. */
export function Sparkline({values, width, height = 32, color = 'var(--mfa-viz-1)', area = false, dot = true, className}: SparklineProps) {
  if (width !== undefined) return <SparkPath values={values} width={width} height={height} color={color} area={area} dot={dot} />;
  return <FluidSpark values={values} height={height} color={color} area={area} dot={dot} className={className} />;
}

function FluidSpark({values, height, color, area, dot, className}: Omit<Required<SparklineProps>, 'width' | 'className'> & {className?: string}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className={className ?? 'mfa-spark-box'} style={{height}}>
      <SparkPath values={values} width={width} height={height} color={color} area={area} dot={dot} />
    </div>
  );
}
