// A log-bucket latency histogram (about 1 % resolution from 1 µs to 1 000 s) that is cheap to record into and to send as JSON:
// the bench server keeps its server-side timings in these, collab-load.ts merges and reads percentiles from them.

const BASE = 1.01;
const LOG_BASE = Math.log(BASE);
/** Values are microseconds; bucket k holds [BASE^k, BASE^(k+1)). */
export class Histogram {
  counts = new Map<number, number>();
  count = 0;
  sum = 0;
  max = 0;
  min = Infinity;

  /** Records `ms` milliseconds. */
  record(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const us = Math.max(1, ms * 1000);
    const bucket = Math.floor(Math.log(us) / LOG_BASE);
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1);
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
    if (ms < this.min) this.min = ms;
  }

  /** The p-th percentile in milliseconds (the bucket's geometric middle), NaN when empty. */
  percentile(p: number): number {
    if (!this.count) return NaN;
    const rank = Math.max(1, Math.ceil((p / 100) * this.count));
    let seen = 0;
    for (const bucket of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(bucket)!;
      if (seen >= rank) return Math.min(this.max, Math.max(this.min, Math.pow(BASE, bucket + 0.5) / 1000));
    }
    return this.max;
  }

  merge(other: Histogram) {
    for (const [bucket, n] of other.counts) this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + n);
    this.count += other.count;
    this.sum += other.sum;
    this.max = Math.max(this.max, other.max);
    this.min = Math.min(this.min, other.min);
  }

  toJSON(): HistogramJson {
    return {count: this.count, sum: this.sum, max: this.max, min: Number.isFinite(this.min) ? this.min : 0, buckets: Object.fromEntries(this.counts)};
  }

  static from(json: HistogramJson | undefined): Histogram {
    const histogram = new Histogram();
    if (!json) return histogram;
    for (const [bucket, n] of Object.entries(json.buckets)) histogram.counts.set(Number(bucket), n);
    histogram.count = json.count;
    histogram.sum = json.sum;
    histogram.max = json.max;
    histogram.min = json.count ? json.min : Infinity;
    return histogram;
  }

  summary() {
    return {count: this.count, p50: this.percentile(50), p95: this.percentile(95), p99: this.percentile(99), max: this.count ? this.max : NaN, mean: this.count ? this.sum / this.count : NaN};
  }
}

export type HistogramJson = {count: number; sum: number; max: number; min: number; buckets: Record<string, number>};
