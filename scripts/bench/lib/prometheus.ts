// Prometheus text (the collab service's /metrics, docs/BACKEND.md §9): histograms read as cumulative buckets, a run's numbers
// are the difference of two scrapes, percentiles interpolated inside the bucket (as histogram_quantile does).

export type PromHistogram = {buckets: [number, number][]; count: number; sum: number};

export function parsePrometheus(text: string): {histograms: Map<string, PromHistogram>; values: Map<string, number>} {
  const histograms = new Map<string, PromHistogram>();
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const [, name, labels = '', raw] = match;
    const value = Number(raw);
    const bucket = /^(.*)_bucket$/.exec(name);
    if (bucket) {
      const le = /le="([^"]+)"/.exec(labels)?.[1];
      if (!le) continue;
      const histogram = histograms.get(bucket[1]) ?? {buckets: [], count: 0, sum: 0};
      histogram.buckets.push([le === '+Inf' ? Infinity : Number(le), value]);
      histograms.set(bucket[1], histogram);
    } else if (name.endsWith('_count') && histograms.has(name.slice(0, -6))) histograms.get(name.slice(0, -6))!.count = value;
    else if (name.endsWith('_sum') && histograms.has(name.slice(0, -4))) histograms.get(name.slice(0, -4))!.sum = value;
    else values.set(name + labels, value);
  }
  for (const histogram of histograms.values()) histogram.buckets.sort((a, b) => a[0] - b[0]);
  return {histograms, values};
}

export function difference(after: PromHistogram, before?: PromHistogram): PromHistogram {
  if (!before) return after;
  const earlier = new Map(before.buckets);
  return {buckets: after.buckets.map(([le, n]) => [le, n - (earlier.get(le) ?? 0)]), count: after.count - before.count, sum: after.sum - before.sum};
}

/** The p-th percentile (0–100) in the histogram's unit, linear inside the bucket; NaN when empty. */
export function quantile(histogram: PromHistogram, p: number): number {
  const total = histogram.buckets.at(-1)?.[1] ?? 0;
  if (!total) return NaN;
  const rank = (p / 100) * total;
  let lower = 0, below = 0;
  for (const [le, cumulative] of histogram.buckets) {
    if (cumulative >= rank) {
      if (!Number.isFinite(le)) return lower;
      const inside = cumulative - below;
      return inside ? lower + ((le - lower) * (rank - below)) / inside : le;
    }
    lower = le;
    below = cumulative;
  }
  return lower;
}
