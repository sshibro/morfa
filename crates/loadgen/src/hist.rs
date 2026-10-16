//! A log-bucket latency histogram, the same buckets as `scripts/bench/lib/histogram.ts` (base 1.01 over microseconds), so
//! `collab-load.ts` merges loadgen's numbers with the server's.

use serde::Serialize;
use std::collections::BTreeMap;

const BASE: f64 = 1.01;

#[derive(Debug, Default, Clone)]
pub struct Histogram {
    buckets: BTreeMap<i32, u64>,
    count: u64,
    sum_ms: f64,
    max_ms: f64,
    min_ms: f64,
}

#[derive(Debug, Serialize)]
pub struct HistogramJson {
    pub count: u64,
    pub sum: f64,
    pub max: f64,
    pub min: f64,
    pub buckets: BTreeMap<String, u64>,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
}

impl Histogram {
    pub fn record_ms(&mut self, ms: f64) {
        if !ms.is_finite() || ms < 0.0 {
            return;
        }
        let us = (ms * 1000.0).max(1.0);
        let bucket = (us.ln() / BASE.ln()).floor() as i32;
        *self.buckets.entry(bucket).or_insert(0) += 1;
        if self.count == 0 || ms < self.min_ms {
            self.min_ms = ms;
        }
        self.count += 1;
        self.sum_ms += ms;
        if ms > self.max_ms {
            self.max_ms = ms;
        }
    }

    pub fn merge(&mut self, other: &Histogram) {
        for (bucket, n) in &other.buckets {
            *self.buckets.entry(*bucket).or_insert(0) += n;
        }
        if other.count > 0 && (self.count == 0 || other.min_ms < self.min_ms) {
            self.min_ms = other.min_ms;
        }
        self.count += other.count;
        self.sum_ms += other.sum_ms;
        self.max_ms = self.max_ms.max(other.max_ms);
    }

    /// The p-th percentile in milliseconds (the bucket's geometric middle), NaN when empty.
    pub fn percentile(&self, p: f64) -> f64 {
        if self.count == 0 {
            return f64::NAN;
        }
        let rank = ((p / 100.0) * self.count as f64).ceil().max(1.0) as u64;
        let mut seen = 0;
        for (bucket, n) in &self.buckets {
            seen += n;
            if seen >= rank {
                let middle = BASE.powf(*bucket as f64 + 0.5) / 1000.0;
                return middle.clamp(self.min_ms, self.max_ms);
            }
        }
        self.max_ms
    }

    pub fn to_json(&self) -> HistogramJson {
        HistogramJson {
            count: self.count,
            sum: self.sum_ms,
            max: self.max_ms,
            min: self.min_ms,
            buckets: self
                .buckets
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect(),
            p50: self.percentile(50.0),
            p95: self.percentile(95.0),
            p99: self.percentile(99.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_are_within_one_percent() {
        let mut h = Histogram::default();
        for i in 1..=1000 {
            h.record_ms(i as f64);
        }
        let p50 = h.percentile(50.0);
        assert!((p50 - 500.0).abs() / 500.0 < 0.011, "{p50}");
        let p99 = h.percentile(99.0);
        assert!((p99 - 990.0).abs() / 990.0 < 0.011, "{p99}");
        assert_eq!(h.to_json().count, 1000);
    }

    #[test]
    fn merge_adds_counts() {
        let mut a = Histogram::default();
        let mut b = Histogram::default();
        a.record_ms(1.0);
        b.record_ms(3.0);
        a.merge(&b);
        assert_eq!(a.to_json().count, 2);
        assert_eq!(a.to_json().max, 3.0);
        assert_eq!(a.to_json().min, 1.0);
    }
}
