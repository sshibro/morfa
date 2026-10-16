// Small statistics for the benches (scripts/bench): nearest-rank percentiles, medians, rounding for tables.

/** The p-th percentile (0–100) by nearest rank of `values` (unsorted is fine); NaN for none. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export const median = (values: readonly number[]) => percentile(values, 50);
export const mean = (values: readonly number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN);

/** p50/p95/p99/max of a sample set in one sort. */
export function summary(values: readonly number[]): {count: number; p50: number; p95: number; p99: number; max: number; mean: number} {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : NaN);
  return {count: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted.length ? sorted[sorted.length - 1] : NaN, mean: mean(sorted)};
}

/** A number for a table: 3 significant digits below 100, whole numbers above. */
export function round(value: number): string {
  if (value === Infinity) return '∞';
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return Math.round(value).toLocaleString('en-US').replace(/,/g, ' ');
  if (magnitude >= 10) return value.toFixed(1).replace(/\.0$/, '');
  if (magnitude >= 1) return value.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
  if (magnitude === 0) return '0';
  return value.toPrecision(2);
}

/** The spread of repeated runs as a share of their median: (max − min) / median. */
export function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = median(values);
  return m ? (Math.max(...values) - Math.min(...values)) / Math.abs(m) : 0;
}
